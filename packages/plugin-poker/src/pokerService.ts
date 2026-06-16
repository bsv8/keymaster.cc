// packages/plugin-poker/src/pokerService.ts
// PokerService 核心实现：管理 proxy 连接 / auth / topic 订阅 / 发布 /
// tx ingest + 跟随 active key 的会话状态机 + key-scoped 持久化 +
// ts-stack 真值协议引擎接入。
//
// 设计缘由（硬切换 004）：
//   - Poker 身份永远跟随平台 `keyspace.active()` 的 single-mode ready
//     key；不再维护独立的"稳定 poker identity 绑定"。
//   - 全局网络配置（proxy endpoint / 双平面 announce / fallback 开关）
//     走 pokerGlobalConfig（localStorage）；切 active key 不丢。
//   - key-scoped storage 只承载"明确属于当前 active key 的扑克状态"：
//     presences / tables / txIngest。切换 active key 时清空旧 key 内存态，
//     并在 key.deleting 时主动 teardown（不依赖平台删 DB 自然失败）。
//   - vault 锁定 / all 模式 / active key failed / uninitialized → 一律
//     fail-closed（断开、停止重连、不允许 publish、UI 提示原因）。
//   - 重连策略：指数 backoff（1s / 2s / 5s / 10s / 30s 上限）。
//   - AuthOK 之后立即把 lastPresence / lastTable announce / 订阅集合
//     重新发送到 proxy，保证重连后 dashboard / 桌面状态不会"看起来
//     在线、实际上 proxy 不再知道你存在"。
//   - service 不暴露私钥、不留明文材料；签名走 vault.withPrivateKey 闭包。
//   - 平台事件：
//       keyspace.onActiveChange → active key 切换（最终重建入口）
//       messageBus.key.deleting → 删除前主清理钩子
//       messageBus.key.deleted  → 删除后收尾
//       vault.onStatusChange    → 锁定时立即 fail-closed
//       messageBus.key.created  → 不主动处理；activeKey.changed 才是真正入口
//     由本 service 一次性消费。

import type {
  KeyIdentity,
  KeyspaceService,
  MessageBus,
  PokerService,
  PokerSessionKeyState,
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
  type PokerSettings,
  type PokerTable,
  type PokerTxEvent
} from "@keymaster/contracts";
import { POKER_EVENT } from "./pokerMessages.js";
import { signDigestWithVault, sha256 as pokerSha256 } from "./pokerCrypto.js";
import { PokerProtocolEngine, POKER_DISCOVERY_TOPICS } from "./engine/pokerProtocolEngine.js";
import { BsvEncoding } from "./tsstack/adapter.js";
import {
  POKER_KEY_STORAGE_ID,
  POKER_KEY_STORAGE_VERSION,
  readLegacyKeyScopedSettings,
  upgradePokerDb,
  writeTxIngest
} from "./pokerDb.js";
import {
  defaultGlobalPokerConfig,
  normalizePokerConfig,
  readPokerGlobalConfig,
  writePokerGlobalConfig
} from "./pokerGlobalConfig.js";
import { resolvePokerSessionKey } from "./pokerSessionKey.js";

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
  /** settings 来自 pokerGlobalConfig（localStorage）；默认值满足 fail-closed。 */
  private settings: PokerSettings = defaultGlobalPokerConfig();
  private presences = new Map<string, PokerPresence>();
  private tables = new Map<string, PokerTable>();
  private txEvents: PokerTxEvent[] = [];
  private txEventCap = 200;
  private statusHandlers = new Set<(s: PokerConnectionStatus) => void>();
  private presenceHandlers = new Set<(p: PokerPresence) => void>();
  private tableHandlers = new Set<(t: PokerTable[]) => void>();
  private txHandlers = new Set<(e: PokerTxEvent) => void>();
  /**
   * settings 监听集合。
   *
   * 设计缘由：硬切换 004 后 settings 是全局配置，不依赖 binding hydrate。
   * `updateSettings` 与 hydrate 都触发该回调；订阅时不立即 push（与
   * contracts 注释一致，避免 UI 用 useEffect 误把初值塞回去导致竞态）。
   */
  private settingsHandlers = new Set<(s: PokerSettings) => void>();
  /**
   * active poker key 监听集合。
   * 订阅时不立即 push，UI 在 mount 时自行调 `getActivePokerKey()` 取初值。
   */
  private activeKeyHandlers = new Set<(s: PokerSessionKeyState) => void>();
  /**
   * 当前解析后的 active poker key 状态。
   * service 内部统一改此字段，外部通过 `getActivePokerKey()` 读取。
   */
  private activeKeyState: PokerSessionKeyState = { kind: "vaultLocked" };
  private readonly engine: PokerProtocolEngine;

  // -----------------------------------------------------------------------
  // 平台订阅句柄（dispose 时统一释放）
  // -----------------------------------------------------------------------
  private vaultUnsub: (() => void) | null = null;
  private keyspaceActiveUnsub: (() => void) | null = null;
  private keyDeletingUnsub: (() => void) | null = null;
  private keyDeletedUnsub: (() => void) | null = null;

  /**
   * 当前 active key 的 publicKeyHash，用于"事件归属判断"。
   *   - key.deleting 收到的 publicKeyHash 等于它 → 是当前 session key，
   *     必须 teardown 一切并清内存态；
   *   - 不等于它 → 是非当前 session key，只清残余引用。
   */
  private currentSessionKeyHash: string | null = null;
  /**
   * 当前 active key 的 KeyIdentity（解析后），用于 sign / 公告。
   */
  private currentSessionKey: KeyIdentity | null = null;

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

  /** 抑制 hydrate 期间多余的 handler 触发（单次 rehydrate 收敛为一次通知）。 */
  private rebindScheduled = false;

  constructor(deps: PokerServiceDeps) {
    this.deps = deps;
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

    // 一次性 hydrate 全局配置（settings 不再依赖 binding）。
    try {
      this.settings = readPokerGlobalConfig();
    } catch {
      this.settings = defaultGlobalPokerConfig();
    }

    // ---------------------------------------------------------------------
    // 平台事件订阅
    // ---------------------------------------------------------------------

    // active key 切换：硬切换 004 的最终会话重建入口。
    this.keyspaceActiveUnsub = deps.keyspace.onActiveChange(() => {
      this.scheduleRebindToActiveKey("activeKey.changed");
    });

    // key.deleting：删除前主清理钩子。
    // 设计缘由：service 必须消费这条事件，主动停止旧会话、停重连、清内存态。
    // 不能只依赖"平台删 IndexedDB 名字后自然失败"——那时 namespace DB 已
    // 进入删除流程，迟到写入与重连会制造竞态。
    this.keyDeletingUnsub = deps.messageBus.subscribe("key.deleting", (p) => {
      const ev = p as { publicKeyHash?: string; keyId?: string } | undefined;
      const hash = ev?.publicKeyHash;
      if (!hash) return;
      if (hash === this.currentSessionKeyHash) {
        // 当前 session key 即将被删：立刻 teardown + 清内存态。
        this.teardownForDeletingCurrentKey();
      }
      // 即使不是当前 session key 也要清空残余引用（presence / table /
      // txIngest 缓存都可能误带被删 key 的影子）。
      this.pruneReferencesToKey(hash);
    });

    // key.deleted：删除后收尾。
    //   - 清掉任何仍指向该 hash 的残余 session 引用；
    //   - 若当前 UI 正展示该 key 旧状态，由 service 内的状态自然为空
    //     （active key state 由 keyspace 决定下一把）；
    //   - 真正触发重建的是后续 `activeKey.changed`。
    this.keyDeletedUnsub = deps.messageBus.subscribe("key.deleted", (p) => {
      const ev = p as { publicKeyHash?: string; keyId?: string } | undefined;
      const hash = ev?.publicKeyHash;
      if (!hash) return;
      this.pruneReferencesToKey(hash);
      // 不主动 connect：等 keyspace 决定下一把 active key 后由 onActiveChange 触发。
    });

    // vault 锁定时立即 fail-closed（硬切换 001 收尾 + 硬切换 004 复用）。
    this.vaultUnsub = deps.vault.onStatusChange((s) => {
      if (s !== "unlocked") {
        this.disconnect();
        this.clearSessionInMemory();
        // 重新评估 active key state（应是 vaultLocked）
        void this.rebindToActiveKey("vault.locked");
      }
    });

    // 构造时立刻评估一次 active key，让 UI 拿到正确初始状态。
    void this.rebindToActiveKey("init");
  }

  // ------------------------------------------------------------------------
  // 公共 API
  // ------------------------------------------------------------------------

  status(): PokerConnectionStatus {
    return this.currentStatus;
  }

  onStatusChange(handler: (status: PokerConnectionStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.currentStatus);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  getActivePokerKey(): PokerSessionKeyState {
    return this.activeKeyState;
  }

  onActivePokerKeyChange(handler: (s: PokerSessionKeyState) => void): () => void {
    this.activeKeyHandlers.add(handler);
    return () => {
      this.activeKeyHandlers.delete(handler);
    };
  }

  listPresences(): PokerPresence[] {
    return Array.from(this.presences.values());
  }
  onPresenceChange(handler: (p: PokerPresence) => void): () => void {
    this.presenceHandlers.add(handler);
    return () => {
      this.presenceHandlers.delete(handler);
    };
  }

  listTables(): PokerTable[] {
    return Array.from(this.tables.values());
  }
  onTablesChange(handler: (tables: PokerTable[]) => void): () => void {
    this.tableHandlers.add(handler);
    return () => {
      this.tableHandlers.delete(handler);
    };
  }

  recentTxEvents(limit = 50): PokerTxEvent[] {
    return this.txEvents.slice(-limit);
  }
  onTxEvent(handler: (e: PokerTxEvent) => void): () => void {
    this.txHandlers.add(handler);
    return () => {
      this.txHandlers.delete(handler);
    };
  }

  get messageBus(): MessageBus {
    return this.deps.messageBus;
  }

  async connect(): Promise<void> {
    const state = await resolvePokerSessionKey(this.deps.vault, this.deps.keyspace);
    if (state.kind !== "ready") {
      throw new Error(
        `Cannot connect: poker session key not ready (${describeSessionState(state)})`
      );
    }
    if (!this.settings.proxyEndpoint) {
      throw new Error("Cannot connect: proxyEndpoint not configured");
    }
    if (
      this.currentStatus === "ready" ||
      this.currentStatus === "connecting" ||
      this.currentStatus === "authenticating"
    ) {
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
      try {
        this.ws.close();
      } catch {
        /* swallow */
      }
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
    return () => {
      this.settingsHandlers.delete(handler);
    };
  }

  /**
   * 更新全局网络配置；同时持久化到 pokerGlobalConfig（localStorage）。
   *
   * 设计缘由（硬切换 004）：
   *   - 全局配置不随切 key 丢失，所以写盘目标是 global config；
   *   - 写失败不抛错（UI 已经反映新值；下次 hydrate 会兜底）；
   *   - patch.proxyEndpoint 变化且当前已 ready：service 主动
   *     disconnect → reconnect，让新 endpoint 立即生效。
   */
  async updateSettings(patch: Partial<PokerSettings>): Promise<void> {
    const next: PokerSettings = { ...this.settings, ...patch };
    this.settings = normalizePokerConfig(next);
    writePokerGlobalConfig(this.settings);
    this.deps.messageBus.publish(POKER_EVENT.SettingsChanged, this.settings);
    this.notifySettings();
    if (patch.proxyEndpoint !== undefined && this.currentStatus === "ready") {
      this.disconnect();
      await this.connect();
    }
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
    this.ownedTablePublishes.set(tableId, {
      payload: signedPayload,
      ttlSeconds: ttl,
      tableId,
      kind: "tablePublish"
    });
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
    this.ownedTablePublishes.set(tableId, {
      payload: signedPayload,
      ttlSeconds: 0,
      tableId,
      kind: "tableClose"
    });
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

  /**
   * scheduleRebindToActiveKey: 把多次连发的 activeKey 事件合并成一次
   * rebind（microtask 之后执行）。设计缘由：activeKey.changed / key.deleted
   * 在同一轮里可能连续到达；不允许中间出现"半 rebind"的可见中间态。
   */
  private scheduleRebindToActiveKey(_reason: string): void {
    if (this.rebindScheduled) return;
    this.rebindScheduled = true;
    queueMicrotask(() => {
      this.rebindScheduled = false;
      void this.rebindToActiveKey("scheduled");
    });
  }

  /**
   * rebindToActiveKey: 单一原子流程入口。
   *   1. 解析 keyspace.active() → PokerSessionKeyState；
   *   2. 若不是 ready（vaultLocked / allMode / missing / notReady / noActiveHash）
   *      → teardown + fail-closed；
   *   3. 若与当前 session key 相同 → 不重复重连，仅刷新内部缓存；
   *   4. 若不同 → teardown old → hydrate new → 视配置 reconnect。
   *
   * "reason" 仅用于日志 / 调试，不参与语义判断。
   */
  private async rebindToActiveKey(reason: string): Promise<void> {
    void reason;
    const state = await resolvePokerSessionKey(this.deps.vault, this.deps.keyspace);
    const previous = this.activeKeyState;
    this.activeKeyState = state;
    this.notifyActiveKeyChange();

    if (state.kind !== "ready") {
      // Fail-closed：断开、停止重连、清掉内存态（但保留全局 settings）。
      this.disconnect();
      this.clearSessionInMemory();
      return;
    }

    const nextHash = state.key.publicKeyHash ?? null;
    if (previous.kind === "ready" && previous.key.publicKeyHash === nextHash) {
      // 同一把 key 的事件（activeKey.changed 可能因其它键切换又切回来）：
      // 不重连，仅 hydrate 内部引用。
      this.currentSessionKey = state.key;
      this.currentSessionKeyHash = nextHash;
      this.engine.setContext(
        state.key.publicKeyHex ? { myPub33: BsvEncoding.fromHex(state.key.publicKeyHex) } : null
      );
      return;
    }

    // 不同 key：先断开旧会话，再按新 key hydrate。
    this.disconnect();
    this.clearSessionInMemory();
    this.currentSessionKey = state.key;
    this.currentSessionKeyHash = nextHash;
    this.engine.setContext(
      state.key.publicKeyHex ? { myPub33: BsvEncoding.fromHex(state.key.publicKeyHex) } : null
    );

    // 尝试把旧 v1/v2 key-scoped settings 一次性迁到全局（仅当当前
    // 全局配置仍是默认值，且旧 DB 还有 settings 行）。
    await this.migrateLegacySettingsIfNeeded(state.key.publicKeyHash);

    // 自动连接？契约并未要求自动连接；保持显式 `service.connect()`。
    // 但如果之前已 ready（重连场景），则保持用户的连接意图。
    // 这里保持"调用 connect 才连接"的语义，避免静默建立网络。
  }

  /**
   * 把"v1 / v2 旧 key-scoped settings"一次性迁到全局 pokerGlobalConfig。
   *
   * 设计缘由：硬切换 004 要求"只从当前 active key 的旧 DB 尝试迁一次
   * 到全局配置"。如果全局已经有用户显式保存的设置（不是默认），则
   * 不覆盖（用户偏好优先）。如果当前 active key 没有旧 DB 或 settings
   * 已被清，跳过。
   */
  private async migrateLegacySettingsIfNeeded(publicKeyHash: string | undefined): Promise<void> {
    if (!publicKeyHash) return;
    const global = readPokerGlobalConfig();
    // 已经有非空 endpoint：用户已在新位置显式保存过，不再迁移覆盖。
    if (global.proxyEndpoint) return;
    try {
      const handle = await this.deps.keyspace.openKeyStorage({
        publicKeyHash,
        pluginId: "plugin-poker",
        storageId: POKER_KEY_STORAGE_ID,
        version: POKER_KEY_STORAGE_VERSION,
        upgrade: upgradePokerDb
      });
      try {
        const legacy = await readLegacyKeyScopedSettings(handle.db);
        if (legacy) {
          const merged: PokerSettings = {
            proxyEndpoint: legacy.proxyEndpoint ?? global.proxyEndpoint,
            announceP2PNodeEndpoint:
              legacy.announceP2PNodeEndpoint ?? global.announceP2PNodeEndpoint,
            announceTxLinkEndpoint:
              legacy.announceTxLinkEndpoint ?? global.announceTxLinkEndpoint,
            allowFallbackBroadcast:
              legacy.allowFallbackBroadcast ?? global.allowFallbackBroadcast
          };
          // 仅迁到有意义的字段（proxyEndpoint 非空）——空配置不值得覆盖默认。
          if (merged.proxyEndpoint) {
            writePokerGlobalConfig(merged);
            this.settings = merged;
            this.deps.messageBus.publish(POKER_EVENT.SettingsChanged, merged);
            this.notifySettings();
          }
        }
      } finally {
        try {
          handle.close();
        } catch {
          /* noop */
        }
      }
    } catch {
      // 旧 DB 打不开（vault locked / namespace 不可用）→ 跳过迁移
    }
  }

  /**
   * 清空所有"和当前 session key 相关"的内存态（intended subscriptions /
   * presence / table / ownedTablePublishes / lastPresence）。
   *
   * 设计缘由：切 active key 时 / vault 锁定时 / 删除当前 key 时——必须
   * 把"旧身份的内存态"全部清掉，不允许在内存里"隐式保留旧身份"等待
   * 下次错误回放。
   */
  private clearSessionInMemory(): void {
    this.intendedSubscriptions.clear();
    this.lastPresence = null;
    this.ownedTablePublishes.clear();
    this.presences.clear();
    this.tables.clear();
    this.currentSessionKey = null;
    this.currentSessionKeyHash = null;
  }

  /**
   * key.deleting 命中"当前 session key"时立即 teardown。
   * 比 clearSessionInMemory 更激进：还要取消 reconnect timer + 关闭 ws +
   * 停止后续向该 key namespace 写入。
   */
  private teardownForDeletingCurrentKey(): void {
    this.disconnect();
    this.clearSessionInMemory();
    // 让 UI 立即看到"key 已删，等下一把 active"的失败状态。
    this.activeKeyState = { kind: "missing" };
    this.notifyActiveKeyChange();
  }

  /**
   * 清理任何仍指向指定 hash 的残余引用（presence / table / tx 缓存里
   * 误带的旧 key 影子）。即使不是当前 session key 也要做，避免脏回放。
   */
  private pruneReferencesToKey(publicKeyHash: string): void {
    // presence / table 都按 publicKeyHex 持有 key 影子；不能光按 hash
    // 精确清除（cache 内不存 hash），但旧的 presences / tables 在切
    // active key 时已经被 clearSessionInMemory 清空。这里真正能清的是
    // 内存里 txEvents / txHandlers 引用——txEvents 持有 rawTx bytes
    // 不带 key 身份，因此可以保留。但 presence / tables 必须清空以免
    // 旧 key 的影子在 UI 闪现。这里通过 clearSessionInMemory 的等价
    // 行为避免脏状态：清空内存 presences / tables（如果当前 session key
    // 已经是新 key，重新连接后会被新一轮 announce 覆盖）。
    if (publicKeyHash !== this.currentSessionKeyHash) {
      // 非当前 session key：只清残余 cache；不断开当前会话。
      this.presences.clear();
      this.tables.clear();
    }
  }

  private ensureReady(): void {
    if (this.currentStatus !== "ready") {
      throw new Error("Poker proxy not ready");
    }
    if (!this.currentSessionKey || !this.currentSessionKey.publicKeyHex) {
      throw new Error("Poker session key not resolved (vault locked or all-mode)");
    }
    // 强校验：当前 session key 必须仍与 keyspace.active() 一致。
    const active = this.deps.keyspace.active();
    if (
      active.mode !== "single" ||
      !active.activePublicKeyHash ||
      active.activePublicKeyHash !== this.currentSessionKey.publicKeyHash
    ) {
      throw new Error("Poker session key drifted from active key");
    }
  }

  private setStatus(s: PokerConnectionStatus): void {
    this.currentStatus = s;
    for (const h of this.statusHandlers) h(s);
    this.deps.messageBus.publish(POKER_EVENT.StatusChange, { status: s });
  }

  private notifySettings(): void {
    const snap = { ...this.settings };
    for (const h of this.settingsHandlers) {
      try {
        h(snap);
      } catch {
        /* swallow */
      }
    }
  }

  private notifyActiveKeyChange(): void {
    const snap = this.activeKeyState;
    for (const h of this.activeKeyHandlers) {
      try {
        h(snap);
      } catch {
        /* swallow */
      }
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
      void this.connect().catch(() => {
        /* swallow; onerror already handled */
      });
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
    // 关键修复（硬切换 004）：签名前必须先确认当前 session key 与
    // keyspace.active() 一致，且 vault 已解锁。否则代理侧会把签名
    // 误绑到错误身份上。
    const sessionKey = this.currentSessionKey;
    if (!sessionKey || !sessionKey.publicKeyHex) {
      this.disconnect();
      return;
    }
    const active = this.deps.keyspace.active();
    if (
      active.mode !== "single" ||
      !active.activePublicKeyHash ||
      active.activePublicKeyHash !== sessionKey.publicKeyHash
    ) {
      this.disconnect();
      return;
    }
    let nonceBytes: Uint8Array;
    try {
      nonceBytes = BsvEncoding.fromHex(payload.nonce);
    } catch {
      this.disconnect();
      return;
    }
    const digest = pokerSha256(nonceBytes);
    let signature: string;
    try {
      signature = await signDigestWithVault(this.deps.vault, sessionKey.keyId, digest);
    } catch {
      this.disconnect();
      return;
    }
    this.send({
      v: POKER_BROWSER_PROTOCOL_VERSION,
      type: POKER_FRAME_TYPE.AuthResponse,
      payload: {
        // 必须回显 nonce：proxy 的 challenger.Verify 从 pending map 里取
        // 这条 challenge 才能放行 auth；缺失就是 ErrChallengeUnknown。
        nonce: payload.nonce,
        publicKeyHex: sessionKey.publicKeyHex,
        signature,
        endpoint: this.settings.announceP2PNodeEndpoint || undefined,
        nick: sessionKey.label
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
    } catch {
      /* swallow */
    }

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
      } catch {
        /* swallow */
      }
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
      } catch {
        /* swallow */
      }
    }
  }

  private handleFrameDeliver(payload: PokerFrameDeliver): void {
    this.deps.messageBus.publish(POKER_EVENT.Frame, payload);
    try {
      const bytes = base64ToBytes(payload.payload);
      this.engine.handleFrame(payload.topic, bytes);
    } catch {
      /* swallow */
    }
  }

  private handleTxDeliver(payload: {
    txid: string;
    route: string;
    kind?: string;
    rawTx: string;
    reason?: string;
  }): void {
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
    // 持久化到当前 session key 的 IDB（仅在有 session key 时）。
    void this.persistTxIngestForCurrentKey(e);
    try {
      this.engine.handleRawTx(rawTx);
    } catch {
      /* swallow */
    }
  }

  /**
   * 把 tx ingest 事件持久化到当前 session key 的 key-scoped DB。
   * 设计缘由：硬切换 004 后 key-scoped DB 只承载"明确属于该 key 的扑
   * 克状态"。txIngest 来自当前会话，归当前 session key 拥有，因此
   * 写当前 session key 的 namespace。
   */
  private async persistTxIngestForCurrentKey(e: PokerTxEvent): Promise<void> {
    const hash = this.currentSessionKeyHash;
    if (!hash) return;
    try {
      const handle = await this.deps.keyspace.openKeyStorage({
        publicKeyHash: hash,
        pluginId: "plugin-poker",
        storageId: POKER_KEY_STORAGE_ID,
        version: POKER_KEY_STORAGE_VERSION,
        upgrade: upgradePokerDb
      });
      try {
        await writeTxIngest(handle.db, {
          txid: e.txid,
          route: e.route,
          kind: e.kind,
          reason: e.reason,
          rawTx: e.rawTx,
          receivedAt: e.receivedAt,
          consumed: false
        });
      } finally {
        try {
          handle.close();
        } catch {
          /* noop */
        }
      }
    } catch {
      // 旧 key namespace 不可用 / 已删：吞掉；不允许脏写入。
    }
  }

  private send(env: PokerBrowserEnvelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not open");
    }
    this.ws.send(JSON.stringify(env));
  }

  /**
   * 硬切换 001：宿主 teardown 时调用。幂等：可重复调用、可容忍部分资源已清。
   * 停止：reconnect timer / ws / vault / keyspace / messageBus 全部监听器。
   */
  dispose(): void {
    if (this.vaultUnsub) {
      try {
        this.vaultUnsub();
      } catch {
        // swallow
      }
      this.vaultUnsub = null;
    }
    if (this.keyspaceActiveUnsub) {
      try {
        this.keyspaceActiveUnsub();
      } catch {
        // swallow
      }
      this.keyspaceActiveUnsub = null;
    }
    if (this.keyDeletingUnsub) {
      try {
        this.keyDeletingUnsub();
      } catch {
        // swallow
      }
      this.keyDeletingUnsub = null;
    }
    if (this.keyDeletedUnsub) {
      try {
        this.keyDeletedUnsub();
      } catch {
        // swallow
      }
      this.keyDeletedUnsub = null;
    }
    // 1) 断 ws + 取消 reconnect
    this.disconnect();
    // 2) 清空各类 listener
    this.statusHandlers.clear();
    this.presenceHandlers.clear();
    this.tableHandlers.clear();
    this.txHandlers.clear();
    this.settingsHandlers.clear();
    this.activeKeyHandlers.clear();
    // 3) 清内存态
    this.clearSessionInMemory();
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

/**
 * 把 PokerSessionKeyState 描述为可读字符串，用于 connect() 失败错误信息。
 */
function describeSessionState(state: PokerSessionKeyState): string {
  switch (state.kind) {
    case "ready":
      return "ready";
    case "allMode":
      return "all-keys mode requires single active key";
    case "vaultLocked":
      return "vault locked";
    case "missing":
      return "no ready key";
    case "notReady":
      return `active key ${state.reason}`;
    case "noActiveHash":
      return "no active hash";
  }
}

// 让 PendingReplay 类型不被 TS 警告"unused"（仅本文件内使用，但显式
// 防御一下：未来若拆分到独立模块再去掉）。
void ({} as PendingReplay);

export { POKER_SERVICE_CAPABILITY };
