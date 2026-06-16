// packages/plugin-poker/src/pokerService.ts
// PokerService 核心实现：管理 proxy 连接 / auth / topic 订阅 / 发布 /
// tx ingest + 稳定 poker identity 绑定 + ts-stack 真值协议引擎接入 +
// 断线重连后的 replay/resubscribe + key-scoped 持久化。
//
// 设计缘由：
//   - 所有 poker 网络会话状态收拢在 service 层；不允许 UI / 其它插件
//     直接 fetch proxy URL。
//   - vault 锁定 / poker identity 解绑 → 立即断连 + 清空内部缓存
//     （fail-closed）；硬切换 001 修订版要求 active key 切换不能隐式
//     改变 poker 身份。
//   - 重连策略：指数 backoff（1s / 2s / 5s / 10s，上限 30s）。
//   - 任何 publish 路径必须先确认 identity binding != null；否则抛错。
//   - 所有 raw tx 都被喂给 PokerProtocolEngine.handleRawTx，由其内部
//     的真值状态机消费；frame 同样转发给 engine。
//   - AuthOK 之后立即把 lastPresence / lastTable announce / 订阅集合
//     重新发送到 proxy，否则重连后 dashboard / 桌面状态会"看起来在线、
//     实际上 proxy 不再知道你存在"。
//   - settings（proxy endpoint / 双平面 announce endpoint / fallback 开关）
//     在每次 updateSettings 时持久化到当前 binding 的 key-scoped storage；
//     bindIdentity 时反向 hydrate（不同 identity 可有不同偏好）。

import type {
  KeyspaceService,
  MessageBus,
  PokerIdentityBinding,
  PokerIdentityBindingState,
  PokerIdentityCandidate,
  VaultService
} from "@keymaster/contracts";
import {
  POKER_BROWSER_PROTOCOL_VERSION,
  POKER_FRAME_TYPE,
  POKER_SERVICE_CAPABILITY,
  type PokerBrowserEnvelope,
  type PokerConnectionStatus,
  type PokerFrameDeliver,
  type PokerPresence,
  type PokerService,
  type PokerSettings,
  type PokerTable,
  type PokerTxEvent
} from "@keymaster/contracts";
import { POKER_EVENT } from "./pokerMessages.js";
import { signDigestWithVault, sha256 as pokerSha256 } from "./pokerCrypto.js";
import { createPokerIdentityBinding, type PokerIdentityBindingManager } from "./pokerIdentityBinding.js";
import { PokerProtocolEngine, POKER_DISCOVERY_TOPICS } from "./engine/pokerProtocolEngine.js";
import { BsvEncoding } from "./tsstack/adapter.js";
import { defaultSettings, readSettings, writeSettings } from "./pokerDb.js";

const DEFAULT_PRESENCE_TTL = 600;
const DEFAULT_TABLE_TTL = 600;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export interface PokerServiceDeps {
  vault: VaultService;
  keyspace: KeyspaceService;
  messageBus: MessageBus;
}

/**
 * createPokerService 构造 PokerService 实例。
 *
 * 设计缘由：plugin-poker 的 manifest.setup 阶段调用本函数；service 不
 * 与 React / 路由耦合，单独可单测。
 */
export function createPokerService(deps: PokerServiceDeps): PokerService {
  return new PokerServiceImpl(deps);
}

/**
 * 一条已签的"待重发"记录：proxy 重启 / 断线重连后必须按原样重发。
 *
 * 设计缘由：硬切换 001 修订版"情况 4 / 情况 5"明确——proxy 只重发已
 * 签 payload，不代签；client 重连后由本地保存的快照重发。该结构对
 * presence / table announce / table close 三种 publish 通用。
 */
interface PendingReplay {
  /** payload bytes（base64-able）。 */
  payload: Uint8Array;
  ttlSeconds: number;
  /** 仅 table.* 用；presence 留空。 */
  tableId?: string;
  /** kind：用于重连时按顺序回放。 */
  kind: "presence" | "tablePublish" | "tableClose";
}

class PokerServiceImpl implements PokerService {
  private readonly deps: PokerServiceDeps;
  private currentStatus: PokerConnectionStatus = "idle";
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** settings 来自 IDB（绑定 hydrate 后填入）；默认值满足 fail-closed。 */
  private settings: PokerSettings = {
    proxyEndpoint: "",
    announceP2PNodeEndpoint: "",
    announceTxLinkEndpoint: "",
    allowFallbackBroadcast: true
  };
  private presences = new Map<string, PokerPresence>();
  private tables = new Map<string, PokerTable>();
  private txEvents: PokerTxEvent[] = [];
  private txEventCap = 200;
  private statusHandlers = new Set<(s: PokerConnectionStatus) => void>();
  private presenceHandlers = new Set<(p: PokerPresence) => void>();
  private tableHandlers = new Set<(t: PokerTable[]) => void>();
  private txHandlers = new Set<(e: PokerTxEvent) => void>();
  private bindingHandlers = new Set<(b: PokerIdentityBindingState) => void>();
  /**
   * settings 监听集合。
   *
   * 设计缘由：bindIdentity 后 settings 是异步从 IDB hydrate 回来的；
   * 没有这个 channel 的话设置页表单永远停留在 mount 时刻的快照。
   * `updateSettings` 与 `hydrateSettingsForCurrentIdentity` 都触发这条
   * 回调；订阅时不立即 push（与 contracts 注释一致，避免 UI 用 useEffect
   * 误把初值塞回去导致竞态）。
   */
  private settingsHandlers = new Set<(s: PokerSettings) => void>();
  private readonly identity: PokerIdentityBindingManager;
  private readonly engine: PokerProtocolEngine;
  /** 硬切换 001：vault.onStatusChange 句柄；dispose 时调用。 */
  private vaultUnsub: (() => void) | null = null;

  /**
   * 本次会话内已成功提交给 proxy 的 topic 订阅集合。
   *
   * 设计缘由：重连后必须按原样回放；本集合是"逻辑订阅意图"——它不区分
   * `subscribeTopics(["x","y"])` 是单次还是两次调用，proxy 重连后只需要
   * 知道"我打算订阅哪些 topic"，按一次性发送即可。
   */
  private intendedSubscriptions = new Set<string>();

  /** 本次会话已签 presence 重发快照；同一 identity 只保留一份最新。 */
  private lastPresence: PendingReplay | null = null;

  /**
   * 本次会话已签 table announce 快照；按 tableId 维度保留最新。
   * close 之后该 tableId 的 entry 改为 kind="tableClose"，回放时还原关桌信号。
   */
  private ownedTablePublishes = new Map<string, PendingReplay>();

  constructor(deps: PokerServiceDeps) {
    this.deps = deps;
    this.identity = createPokerIdentityBinding({ vault: deps.vault, keyspace: deps.keyspace });
    this.engine = new PokerProtocolEngine({
      hooks: {
        onAnnounce: ({ playerPubHex, endpoint }) => {
          const existing = this.presences.get(playerPubHex);
          const next: PokerPresence = {
            publicKeyHex: playerPubHex,
            endpoint: endpoint || existing?.endpoint,
            nick: existing?.nick,
            seenAt: Date.now()
          };
          this.presences.set(playerPubHex, next);
          this.deps.messageBus.publish(POKER_EVENT.Presence, next);
          for (const h of this.presenceHandlers) h(next);
        },
        onNodeSeed: ({ pubHex, endpoint }) => {
          this.deps.messageBus.publish("poker.nodeSeed", { pubHex, endpoint });
        },
        // P2PNode bsvp/presence 平面到达的 frame → 写入 presence 索引。
        onPresenceFrame: ({ playerId, addr, handle }) => {
          if (!playerId) return;
          const next: PokerPresence = {
            publicKeyHex: playerId,
            endpoint: addr,
            nick: handle || undefined,
            seenAt: Date.now()
          };
          this.presences.set(playerId, next);
          this.deps.messageBus.publish(POKER_EVENT.Presence, next);
          for (const h of this.presenceHandlers) h(next);
        },
        // P2PNode bsvp/dir 平面到达的 frame → 写入 / 删除 table 索引。
        onTableFrame: (payload) => {
          if (payload.isClose) {
            this.tables.delete(payload.id);
          } else {
            const tbl: PokerTable = {
              tableId: payload.id,
              variant: parseVariantFromTableId(payload.id),
              seats: payload.members,
              stakes: 0,
              ownerPub: payload.pub
            };
            this.tables.set(payload.id, tbl);
          }
          const snapshot = Array.from(this.tables.values());
          this.deps.messageBus.publish(POKER_EVENT.Tables, snapshot);
          for (const h of this.tableHandlers) h(snapshot);
        }
      }
    });

    // 绑定变化：若已连接 proxy，需要主动 disconnect（identity 漂移不允许）。
    this.identity.onChange((b) => {
      for (const h of this.bindingHandlers) {
        try { h(b); } catch { /* swallow */ }
      }
      this.engine.setContext(b ? { myPub33: BsvEncoding.fromHex(b.publicKeyHex) } : null);

      if (this.currentStatus === "ready" || this.currentStatus === "authenticating") {
        this.disconnect();
      }

      if (b) {
        // 同一 identity 重新绑定 → 把它的 settings 从 IDB 取回内存。
        void this.hydrateSettingsForCurrentIdentity().catch(() => undefined);
      } else {
        // 解绑：清空所有"和身份相关"的会话内存（fail-closed）。
        this.intendedSubscriptions.clear();
        this.lastPresence = null;
        this.ownedTablePublishes.clear();
        this.presences.clear();
        this.tables.clear();
      }
    });

    // 硬切换 001：vault.onStatusChange 句柄保存到字段，dispose 时调用，
    // 否则 plugin disable 后旧 service 实例仍被 vault 持续引用，破坏热卸载语义。
    this.vaultUnsub = deps.vault.onStatusChange((s) => {
      if (s !== "unlocked") {
        this.disconnect();
        this.presences.clear();
        this.tables.clear();
        this.intendedSubscriptions.clear();
        this.lastPresence = null;
        this.ownedTablePublishes.clear();
      }
    });
  }

  status(): PokerConnectionStatus { return this.currentStatus; }

  onStatusChange(handler: (status: PokerConnectionStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.currentStatus);
    return () => { this.statusHandlers.delete(handler); };
  }

  listPresences(): PokerPresence[] {
    return Array.from(this.presences.values());
  }
  onPresenceChange(handler: (p: PokerPresence) => void): () => void {
    this.presenceHandlers.add(handler);
    return () => { this.presenceHandlers.delete(handler); };
  }

  listTables(): PokerTable[] {
    return Array.from(this.tables.values());
  }
  onTablesChange(handler: (tables: PokerTable[]) => void): () => void {
    this.tableHandlers.add(handler);
    return () => { this.tableHandlers.delete(handler); };
  }

  recentTxEvents(limit = 50): PokerTxEvent[] {
    return this.txEvents.slice(-limit);
  }
  onTxEvent(handler: (e: PokerTxEvent) => void): () => void {
    this.txHandlers.add(handler);
    return () => { this.txHandlers.delete(handler); };
  }

  get messageBus(): MessageBus { return this.deps.messageBus; }

  async connect(): Promise<void> {
    const binding = this.identity.get();
    if (!binding) {
      throw new Error("Cannot connect: no poker identity bound");
    }
    if (!this.settings.proxyEndpoint) {
      throw new Error("Cannot connect: proxyEndpoint not configured");
    }
    if (this.currentStatus === "ready" || this.currentStatus === "connecting" || this.currentStatus === "authenticating") {
      return;
    }
    this.setStatus("connecting");
    await this.openSocket();
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* swallow */ }
      this.ws = null;
    }
    if (this.currentStatus !== "idle" && this.currentStatus !== "closed") {
      this.setStatus("closed");
    }
  }

  getSettings(): PokerSettings {
    return { ...this.settings };
  }

  /**
   * 订阅 settings 变化（updateSettings + hydrate 触发）。
   *
   * 设计缘由：契约里写明"订阅时不立即推一次当前值"——UI 仍应在 mount
   * 时通过 `getSettings()` 取初值，避免与 useState 初始化器重复 setState。
   */
  onSettingsChange(handler: (s: PokerSettings) => void): () => void {
    this.settingsHandlers.add(handler);
    return () => { this.settingsHandlers.delete(handler); };
  }

  /**
   * 更新设置；同时持久化到当前 binding 的 key-scoped storage。
   *
   * 设计缘由（修复"settings 不持久化"问题）：updateSettings 之前只改
   * 内存，刷新页面后 proxy endpoint / 双平面 announce / fallback 开关
   * 全部丢失。修复后：
   *   1. 先更新内存（保持原行为，UI 立即生效）；
   *   2. 异步把整份 settings 写到 IDB（withStorage 自带 fail-closed）；
   *   3. 写失败不抛错（UI 已经反映新值；下次 hydrate 会兜底）；
   *   4. 通知 settingsHandlers，让设置页表单与 IDB 状态保持一致。
   * 绑定缺失时仍允许 update（用户可能在 settings 页未绑定 identity 时
   * 先填好 endpoint），但持久化会落空——这是预期行为。
   */
  async updateSettings(patch: Partial<PokerSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    this.deps.messageBus.publish(POKER_EVENT.SettingsChanged, this.settings);
    this.notifySettings();
    await this.identity.withStorage(async (db) => writeSettings(db, { ...this.settings })).catch(() => undefined);
    if (patch.proxyEndpoint !== undefined && this.currentStatus === "ready") {
      this.disconnect();
      await this.connect();
    }
  }

  // ----------------------- identity binding (PokerService) -----------------------

  getIdentityBinding(): PokerIdentityBindingState {
    return this.identity.get();
  }

  onIdentityBindingChange(handler: (b: PokerIdentityBindingState) => void): () => void {
    this.bindingHandlers.add(handler);
    try { handler(this.identity.get()); } catch { /* swallow */ }
    return () => { this.bindingHandlers.delete(handler); };
  }

  async listIdentityCandidates(): Promise<PokerIdentityCandidate[]> {
    return this.identity.listCandidates();
  }

  async bindIdentity(input: { publicKeyHash: string; label?: string }): Promise<PokerIdentityBinding> {
    if (this.currentStatus === "ready" || this.currentStatus === "authenticating") {
      this.disconnect();
    }
    return this.identity.bind(input);
  }

  async unbindIdentity(): Promise<void> {
    this.disconnect();
    await this.identity.unbind();
  }

  // ----------------------- publish 路径 -----------------------

  async publishFrame(topic: string, payload: Uint8Array): Promise<void> {
    this.ensureReady();
    this.send({
      v: POKER_BROWSER_PROTOCOL_VERSION,
      type: POKER_FRAME_TYPE.FramePublish,
      payload: { topic, payload: bytesToBase64(payload) }
    });
  }

  async publishPresence(signedPayload: Uint8Array, ttlSeconds?: number): Promise<void> {
    this.ensureReady();
    const ttl = ttlSeconds ?? DEFAULT_PRESENCE_TTL;
    this.lastPresence = { payload: signedPayload, ttlSeconds: ttl, kind: "presence" };
    this.send({
      v: POKER_BROWSER_PROTOCOL_VERSION,
      type: POKER_FRAME_TYPE.PresencePublish,
      payload: { payload: bytesToBase64(signedPayload), ttlSeconds: ttl }
    });
  }

  async publishTable(tableId: string, signedPayload: Uint8Array, ttlSeconds?: number): Promise<void> {
    this.ensureReady();
    const ttl = ttlSeconds ?? DEFAULT_TABLE_TTL;
    this.ownedTablePublishes.set(tableId, { payload: signedPayload, ttlSeconds: ttl, tableId, kind: "tablePublish" });
    this.send({
      v: POKER_BROWSER_PROTOCOL_VERSION,
      type: POKER_FRAME_TYPE.TablePublish,
      payload: { tableId, payload: bytesToBase64(signedPayload), ttlSeconds: ttl }
    });
  }

  async closeTable(tableId: string, signedPayload: Uint8Array): Promise<void> {
    this.ensureReady();
    // 关桌也要重发（断线重连时如果服务端尚未把"关桌"广播出去，
    // 必须以原 close payload 再喂一遍 proxy）。
    this.ownedTablePublishes.set(tableId, { payload: signedPayload, ttlSeconds: 0, tableId, kind: "tableClose" });
    this.send({
      v: POKER_BROWSER_PROTOCOL_VERSION,
      type: POKER_FRAME_TYPE.TableClose,
      payload: { tableId, payload: bytesToBase64(signedPayload) }
    });
  }

  async publishRawTx(rawTx: Uint8Array): Promise<void> {
    this.ensureReady();
    this.send({
      v: POKER_BROWSER_PROTOCOL_VERSION,
      type: POKER_FRAME_TYPE.TxPublish,
      payload: { rawTx: bytesToBase64(rawTx) }
    });
  }

  async subscribeTopics(topics: string[]): Promise<void> {
    this.ensureReady();
    for (const t of topics) this.intendedSubscriptions.add(t);
    this.send({
      v: POKER_BROWSER_PROTOCOL_VERSION,
      type: POKER_FRAME_TYPE.TopicSubscribe,
      payload: { topics }
    });
  }

  async unsubscribeTopics(topics: string[]): Promise<void> {
    this.ensureReady();
    for (const t of topics) this.intendedSubscriptions.delete(t);
    this.send({
      v: POKER_BROWSER_PROTOCOL_VERSION,
      type: POKER_FRAME_TYPE.TopicUnsubscribe,
      payload: { topics }
    });
  }

  // ------------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------------

  private ensureReady(): void {
    if (this.currentStatus !== "ready") {
      throw new Error("Poker proxy not ready");
    }
    const binding = this.identity.get();
    if (!binding) {
      throw new Error("Poker identity not bound (vault locked or unbound)");
    }
  }

  private setStatus(s: PokerConnectionStatus): void {
    this.currentStatus = s;
    for (const h of this.statusHandlers) h(s);
    this.deps.messageBus.publish(POKER_EVENT.StatusChange, { status: s });
  }

  /** 从当前 binding 的 IDB 取回 settings；未绑定 / 读失败保持默认。 */
  private async hydrateSettingsForCurrentIdentity(): Promise<void> {
    const loaded = await this.identity.withStorage(async (db) => readSettings(db));
    if (!loaded) return;
    this.settings = { ...this.settings, ...loaded };
    this.deps.messageBus.publish(POKER_EVENT.SettingsChanged, this.settings);
    this.notifySettings();
  }

  /** 触发所有 settings 订阅；handler 抛错被 swallow，不影响其它订阅者。 */
  private notifySettings(): void {
    const snap = { ...this.settings };
    for (const h of this.settingsHandlers) {
      try { h(snap); } catch { /* swallow */ }
    }
  }

  private async openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.settings.proxyEndpoint;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this.setStatus("failed");
        reject(e);
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        // 等待 proxy 推 challenge。
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onerror = () => {
        if (this.currentStatus !== "failed") {
          this.setStatus("failed");
        }
        this.scheduleReconnect();
      };
      ws.onclose = () => {
        this.ws = null;
        if (this.currentStatus === "ready") {
          this.setStatus("reconnecting");
          this.scheduleReconnect();
        } else if (this.currentStatus !== "closed" && this.currentStatus !== "idle") {
          this.setStatus("closed");
        }
      };
      queueMicrotask(resolve);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.currentStatus === "closed" || this.currentStatus === "idle") return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, Math.min(5, this.reconnectAttempt))
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {/* swallow; onerror already handled */});
    }, delay);
  }

  private onMessage(raw: unknown): void {
    let env: PokerBrowserEnvelope;
    try {
      env = typeof raw === "string" ? JSON.parse(raw) : (raw as PokerBrowserEnvelope);
    } catch {
      return;
    }
    if (!env || env.v !== POKER_BROWSER_PROTOCOL_VERSION) return;
    switch (env.type) {
      case POKER_FRAME_TYPE.AuthChallenge: {
        void this.handleChallenge(env);
        break;
      }
      case POKER_FRAME_TYPE.AuthOK: {
        this.setStatus("ready");
        this.reconnectAttempt = 0;
        this.deps.messageBus.publish(POKER_EVENT.StatusChange, { status: "ready" });
        // 进入 ready 后立即"补订阅 + 重放"，保证重连不丢状态。
        this.replayAfterAuthOK();
        break;
      }
      case POKER_FRAME_TYPE.AuthFail: {
        this.setStatus("failed");
        break;
      }
      case POKER_FRAME_TYPE.FrameDeliver: {
        this.handleFrameDeliver(env.payload as PokerFrameDeliver);
        break;
      }
      case POKER_FRAME_TYPE.TxDeliver: {
        this.handleTxDeliver(env.payload as {
          txid: string;
          route: string;
          kind?: string;
          rawTx: string;
          reason?: string;
        });
        break;
      }
      case POKER_FRAME_TYPE.Error: {
        const e = env.payload as { code: string; message: string };
        if (e.code === "protocol.mismatch") {
          this.disconnect();
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleChallenge(env: PokerBrowserEnvelope): Promise<void> {
    const payload = env.payload as { nonce: string; protocolVersion: number };
    if (payload.protocolVersion !== POKER_BROWSER_PROTOCOL_VERSION) {
      this.disconnect();
      return;
    }
    if (!payload.nonce || typeof payload.nonce !== "string") {
      this.disconnect();
      return;
    }
    this.setStatus("authenticating");
    const binding = await this.identity.resolveIdentity();
    if (!binding || !binding.publicKeyHex) {
      this.disconnect();
      return;
    }
    // proxy 把 nonce 以 hex 形式签发（model.AuthChallengePayload.Nonce 文档约定）；
    // 修复前误用 base64 解码，导致 signed digest 与 proxy 完全对不上。
    let nonceBytes: Uint8Array;
    try {
      nonceBytes = BsvEncoding.fromHex(payload.nonce);
    } catch {
      this.disconnect();
      return;
    }
    const digest = pokerSha256(nonceBytes);
    const signature = await signDigestWithVault(this.deps.vault, binding.keyId, digest);
    this.send({
      v: POKER_BROWSER_PROTOCOL_VERSION,
      type: POKER_FRAME_TYPE.AuthResponse,
      payload: {
        // 必须回显 nonce：proxy 的 challenger.Verify 从 pending map 里取
        // 这条 challenge 才能放行 auth；缺失就是 ErrChallengeUnknown。
        nonce: payload.nonce,
        publicKeyHex: binding.publicKeyHex,
        signature,
        endpoint: this.settings.announceP2PNodeEndpoint || undefined,
        nick: binding.label
      }
    });
  }

  /**
   * AuthOK 之后的会话恢复（修复"断线重连后丢订阅/丢公告"问题）。
   *
   * 顺序：
   *   1. 自动订阅 bsvp/dir + bsvp/presence（大厅依赖；UI 不需要显式调用）。
   *   2. 把 intendedSubscriptions 一次性 resubscribe 给 proxy。
   *   3. 回放 lastPresence（如果有）。
   *   4. 按 tableId 回放 ownedTablePublishes（区分 publish 与 close）。
   *
   * 任何 send 异常都被 swallow——下一次重连还会再补一次。
   */
  private replayAfterAuthOK(): void {
    try {
      // 1) 大厅发现 topic：proxy 内部协议用无前导空格形式（与
      //    SessionRegistry 精确匹配规则一致）。早期错误使用 C# 的
      //    带空格 wire 形式 → 代理侧根本不路由，发现链路静默失效。
      const discoveryTopics: string[] = [
        POKER_DISCOVERY_TOPICS.Dir,
        POKER_DISCOVERY_TOPICS.Presence
      ];
      const extra = Array.from(this.intendedSubscriptions);
      const allTopics = Array.from(new Set([...discoveryTopics, ...extra]));
      for (const t of discoveryTopics) this.intendedSubscriptions.add(t);
      if (allTopics.length > 0) {
        this.send({
          v: POKER_BROWSER_PROTOCOL_VERSION,
          type: POKER_FRAME_TYPE.TopicSubscribe,
          payload: { topics: allTopics }
        });
      }
    } catch { /* swallow */ }

    if (this.lastPresence) {
      try {
        this.send({
          v: POKER_BROWSER_PROTOCOL_VERSION,
          type: POKER_FRAME_TYPE.PresencePublish,
          payload: {
            payload: bytesToBase64(this.lastPresence.payload),
            ttlSeconds: this.lastPresence.ttlSeconds
          }
        });
      } catch { /* swallow */ }
    }

    for (const [tableId, replay] of this.ownedTablePublishes) {
      try {
        if (replay.kind === "tableClose") {
          this.send({
            v: POKER_BROWSER_PROTOCOL_VERSION,
            type: POKER_FRAME_TYPE.TableClose,
            payload: { tableId, payload: bytesToBase64(replay.payload) }
          });
        } else {
          this.send({
            v: POKER_BROWSER_PROTOCOL_VERSION,
            type: POKER_FRAME_TYPE.TablePublish,
            payload: { tableId, payload: bytesToBase64(replay.payload), ttlSeconds: replay.ttlSeconds }
          });
        }
      } catch { /* swallow */ }
    }
  }

  private handleFrameDeliver(payload: PokerFrameDeliver): void {
    this.deps.messageBus.publish(POKER_EVENT.Frame, payload);
    try {
      const bytes = base64ToBytes(payload.payload);
      this.engine.handleFrame(payload.topic, bytes);
    } catch { /* swallow */ }
  }

  private handleTxDeliver(payload: { txid: string; route: string; kind?: string; rawTx: string; reason?: string }): void {
    if (payload.route === "fallback-broadcast" && !this.settings.allowFallbackBroadcast) {
      return;
    }
    const rawTx = base64ToBytes(payload.rawTx);
    const e: PokerTxEvent = {
      txid: payload.txid,
      route: payload.route,
      kind: payload.kind,
      rawTx,
      reason: payload.reason,
      receivedAt: Date.now()
    };
    this.txEvents.push(e);
    if (this.txEvents.length > this.txEventCap) {
      this.txEvents.splice(0, this.txEvents.length - this.txEventCap);
    }
    for (const h of this.txHandlers) h(e);
    this.deps.messageBus.publish(POKER_EVENT.Tx, e);
    try {
      this.engine.handleRawTx(rawTx);
    } catch { /* swallow */ }
  }

  private send(env: PokerBrowserEnvelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not open");
    }
    this.ws.send(JSON.stringify(env));
  }

  /**
   * 硬切换 001：宿主 teardown 时调用。幂等：可重复调用、可容忍部分资源已清。
   * 停止：reconnect timer / ws / vault / keyspace / status / settings 监听器。
   */
  dispose(): void {
    // 0) 取消 vault.onStatusChange 句柄（硬切换 001 补）。
    if (this.vaultUnsub) {
      try {
        this.vaultUnsub();
      } catch {
        // swallow
      }
      this.vaultUnsub = null;
    }
    // 1) 断 ws + 取消 reconnect
    this.disconnect();
    // 2) 取消 identity binding 监听（vault / keyspace / status 变化）
    try {
      this.identity.dispose();
    } catch {
      // swallow
    }
    // 3) 清空各类 listener
    this.statusHandlers.clear();
    this.presenceHandlers.clear();
    this.tableHandlers.clear();
    this.txHandlers.clear();
    this.bindingHandlers.clear();
    this.settingsHandlers.clear();
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] as number);
  }
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 从 tableId 推断 variant 名称：tableId 形如 `t-<hex>~<Variant>~p<N>...`。
 *
 * 设计缘由：bsvp/dir frame 自带 `name` 但**不**带 variant；UI 列表里
 * 又希望按 variant 高亮，所以从 id 解析；缺省回退 "TexasHoldem"。
 */
function parseVariantFromTableId(tableId: string): string {
  const parts = tableId.split("~");
  return parts[1] ?? "TexasHoldem";
}

// 让 PendingReplay 类型不被 TS 警告"unused"（仅本文件内使用，但显式
// 防御一下：未来若拆分到独立模块再去掉）。
void ({} as PendingReplay);

export { POKER_SERVICE_CAPABILITY };
