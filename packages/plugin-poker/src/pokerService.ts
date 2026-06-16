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
  readAllPresences,
  readAllTables,
  readAllTxIngest,
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

  /**
   * 用户连接意图。写入 / 清空时机：
   *   - connect() 显式发起连接 → 置 true
   *   - disconnect()（用户主动断开） → 置 false
   *   - vault.lock → 置 false（vault 锁定是显著用户动作，重新点 Connect）
   *   - key.deleting 命中当前 session key → **保留**（让 keyspace
   *     决定的下一把 active key 走自动恢复连接，符合施工单 004 情况 3）
   *
   * rebindToActiveKey 用它决定"切换 key 后是否自动 reconnect"。
   *
   * 设计缘由（硬切换 004）：施工单要求"切 active key 时旧会话必须
   * 收拢，新会话必须按新 key 重建"。但 init 阶段（构造 / 刷新）不应
   * 自动建连——用户必须显式点 Connect。让 userWantsConnection 标记
   * 用户意图可以同时满足"切换时自动重建"和"刷新时不自动建连"。
   */
  private userWantsConnection = false;

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
    //
    // 设计缘由：service 必须消费这条事件，主动停止旧会话、停重连、清内存态。
    // 不能只依赖"平台删 IndexedDB 名字后自然失败"——那时 namespace DB 已
    // 进入删除流程，迟到写入与重连会制造竞态。
    //
    // 关键不变量（硬切换 004 反馈修复）："当前 session key"的判定**不能**
    // 依赖 this.currentSessionKeyHash——该字段是异步 rebindToActiveKey("init")
    // 之后才填上的；如果 key.deleting 在 init 完成前到达（事件竞争），按
    // currentSessionKeyHash 判定会漏掉 teardown，session 仍然挂在被删 key
    // 上直到下次自然失败。必须改用 this.deps.keyspace.active() 同步读，
    // 这样无论 init 是否完成都能给出正确答案（keyspace 是同步数据源）。
    this.keyDeletingUnsub = deps.messageBus.subscribe("key.deleting", (p) => {
      const ev = p as { publicKeyHash?: string; keyId?: string } | undefined;
      const hash = ev?.publicKeyHash;
      if (!hash) return;
      // 用 keyspace.active() 同步判定：activePublicKeyHash === hash 才是
      // 当前 session key 被删。硬切换 005：active key 模型收窄为唯一一把，
      // 不再有 "all mode"。
      const active = this.deps.keyspace.active();
      const isCurrentSessionKey = active.activePublicKeyHash === hash;
      if (isCurrentSessionKey) {
        // 当前 session key 即将被删：立刻 teardown + 清内存态。
        // teardownForDeletingCurrentKey 内部用 disconnectForFailClosed
        // 保留 userWantsConnection，让 keyspace 决定的下一把 active key
        // 能自动按新 key 重建（施工单 004 情况 3）。
        this.teardownForDeletingCurrentKey();
      }
      // 即使不是当前 session key 也要走 pruneReferencesToKey（当前实现
      // 是 no-op，但保留入口以防未来需要）。
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
    // 设计缘由：vault 锁定是系统终止当前会话，不算用户主动取消；
    // 但解锁后通常需要重新走一遍"显式 connect"，所以这里清掉
    // userWantsConnection。如果用户解锁后还想连，应该重新点 Connect。
    this.vaultUnsub = deps.vault.onStatusChange((s) => {
      if (s !== "unlocked") {
        this.userWantsConnection = false;
        this.disconnect();
        this.clearSessionInMemory();
        // 重新评估 active key state（应是 vaultLocked）
        void this.rebindToActiveKey("vault.locked");
      }
    });

    // 构造时立刻评估一次 active key，让 UI 拿到正确初始状态。
    //
    // 设计缘由（硬切换 004 反馈修复）：真实 keyspaceService.onActiveChange
    // 在订阅时立刻推一次 handler（见 packages/plugin-vault/src/keyspaceService.ts
    // 的 onActiveChange 实现）。如果这里直接调 rebindToActiveKey，构造
    // 阶段会对同一把 key 跑两次 rebind + hydrate——第二次会重复 push
    // txEvents（详见 hydrateFromKeyScopedDb 内部去重逻辑）。改成走
    // scheduleRebindToActiveKey 让两次请求被 rebindScheduled flag 合并：
    //   - 如果 onActiveChange 已经 schedule 过，本调用被 swallow；
    //   - 如果 onActiveChange 是 lazy（测试桩），本调用 schedule 一次。
    //   - 任何一种情况只会有一次 rebind 真正运行。
    this.scheduleRebindToActiveKey("init");
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
      // 已经处于活动状态：保留 userWantsConnection 状态，无副作用。
      return;
    }
    // 用户显式发起连接：标记意图。后续切 key / 刷新后由 rebind 读取。
    this.userWantsConnection = true;
    this.setStatus("connecting");
    await this.openSocket();
  }

  disconnect(): void {
    // 用户显式断开：清掉意图。后续切 key 不会再自动重连。
    this.userWantsConnection = false;
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
   *   2. 若不是 ready（vaultLocked / missing / notReady / noActiveHash）
   *      → teardown + fail-closed；
   *   3. 若与当前 session key 相同 → 不重复重连，仅刷新内部缓存；
   *   4. 若不同 → teardown old → hydrate new key-scoped DB → 视用户
   *      意图（userWantsConnection）与 endpoint 配置决定是否自动重连。
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
      // 注意这里不复用 disconnect()，因为要保留 userWantsConnection 状态：
      // 如果用户在 vault 锁定前确实点过 Connect，重新解锁后应该按
      // userWantsConnection 自动重连。disconnect() 会清掉这个标记，
      // 而我们这里只是 fail-closed 暂时不连、不是用户主动取消意图。
      this.disconnectForFailClosed();
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
      // 同 key 也要 hydrate（首次启动 / 刷新场景）。
      await this.hydrateFromKeyScopedDb(nextHash);
      return;
    }

    // 不同 key：先断开旧会话，再按新 key hydrate。
    // 注意：这里用 disconnectForFailClosed 而不是 disconnect()，因为
    // disconnect() 会清掉 userWantsConnection；而切 key 的目标是"按
    // 新 key 自动重建连接"——必须保留用户原始意图。
    this.disconnectForFailClosed();
    this.clearSessionInMemory();
    this.currentSessionKey = state.key;
    this.currentSessionKeyHash = nextHash;
    this.engine.setContext(
      state.key.publicKeyHex ? { myPub33: BsvEncoding.fromHex(state.key.publicKeyHex) } : null
    );

    // 尝试把旧 v1/v2 key-scoped settings 一次性迁到全局（仅当当前
    // 全局配置仍是默认值，且旧 DB 还有 settings 行）。
    await this.migrateLegacySettingsIfNeeded(state.key.publicKeyHash);

    // 从当前 active key 的 key-scoped DB 重建 presences / tables /
    // txIngest 缓存。设计缘由（硬切换 004）：刷新后 / 切 key 后必须
    // 只恢复"明确属于该 key 的会话上下文"，不混淆。
    await this.hydrateFromKeyScopedDb(nextHash);

    // 自动重建连接（施工单硬切换 004 不变量 4 / 不变量 7）：
    //   - 切 active key 时旧会话收拢，新会话必须按新 key 重建；
    //   - 删除当前 active key 后在新的 active key 下恢复；
    // 但 init 阶段（构造 / 刷新）不允许静默建连——必须靠 userWantsConnection
    // 这个用户意图标记区分"用户确实想连"和"应用启动"。
    if (this.userWantsConnection && this.settings.proxyEndpoint) {
      try {
        await this.connect();
      } catch {
        // status 已经反映失败；不向上冒泡。
      }
    }
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
   * 类似 disconnect()，但不重置 userWantsConnection。
   *
   * 设计缘由：vault 锁定 / all 模式 / failed / uninitialized 等
   * fail-closed 场景下，会话是被系统暂时终止；用户原本的连接意图
   * （userWantsConnection === true）应该被保留，以便重新解锁 / 切回
   * 单一 key 后自动恢复。teardownForDeletingCurrentKey 同样使用本函数，
   * 让 keyspace 决定下一把 active key 时能自动按新 key 重建。
   *
   * 真正的"清掉意图"发生在两处：
   *   - 用户主动点击 Disconnect（disconnect() 会清）；
   *   - vault.lock（vault 锁定是显著用户动作，需要重新点 Connect）。
   */
  private disconnectForFailClosed(): void {
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
    // 总是把状态切到 closed——teardown 是显式动作，无论之前是 idle
    // （从未连接）/ ready / connecting / authenticating，都应该统一收敛
    // 到 closed。idle 只在 service 还没初始化过的初始态短暂出现，teardown
    // 一旦发生就不再是"从未连接"，而是"已收拢"。
    if (this.currentStatus !== "closed") {
      this.setStatus("closed");
    }
  }

  /**
   * key.deleting 命中"当前 session key"时立即 teardown。
   * 比 clearSessionInMemory 更激进：还要取消 reconnect timer + 关闭 ws +
   * 停止后续向该 key namespace 写入。
   *
   * 设计缘由（硬切换 004 情况 3）：删除当前 active key 时 service 应该
   * "先清旧会话，再等 keyspace 决定新 active，然后按新 key 自动恢复连接"。
   * 因此这里**保留** userWantsConnection——让后续 activeKey.changed 到
   * 新 key 时，rebindToActiveKey 按用户原有意图自动重连。
   *
   * 真正的"清掉意图"发生在 vault.lock（vault 锁定是显著用户动作）
   * 以及用户主动点击 Disconnect（disconnect() 会清）。
   */
  private teardownForDeletingCurrentKey(): void {
    // 用 disconnectForFailClosed 而不是 disconnect()：保留 userWantsConnection。
    this.disconnectForFailClosed();
    this.clearSessionInMemory();
    // 让 UI 立即看到"key 已删，等下一把 active"的失败状态。
    this.activeKeyState = { kind: "missing" };
    this.notifyActiveKeyChange();
  }

  /**
   * key.deleting / key.deleted 命中"非当前 session key"时的处理。
   *
   * 设计缘由（硬切换 004）：删除非当前 key 不能打断当前会话。当前
   * service 的 in-memory 缓存（presences / tables / txEvents /
   * intendedSubscriptions / lastPresence / ownedTablePublishes）全部
   * 都只属于"当前 session key 的视图"——它们不是被删 key 的影子。
   * 当前 session 的会话状态不应该被影响。唯一需要清理的"残余引用"
   * 是 txIngest / presences / tables 在 DB 里的持久化数据，但那些
   * 属于被删 key 的 namespace DB，keyspace.deleteKey 自己负责
   * deleteDatabase，不需要 plugin-poker 再做事。
   *
   * 结论：本函数在非当前 key 路径上是 no-op；保留作为防御性入口，
   * 并显式注释这条不变量，避免后续误改回"清空所有内存态"。
   */
  private pruneReferencesToKey(publicKeyHash: string): void {
    void publicKeyHash;
    // 不变量：删除非当前 session key 不能打扰当前会话。当前内存态全部
    // 是当前 session key 的视图；namespace DB 由 keyspace.deleteKey
    // 删；本函数保留为空实现。
  }

  /**
   * 从当前 active key 的 key-scoped IDB 恢复 presences / tables /
   * txIngest 缓存。
   *
   * 设计缘由（硬切换 004 验收清单"浏览器刷新恢复"）：
   *   - 启动时：service 构造后立即 scheduleRebindToActiveKey("init")；
   *     命中 same-key 分支后调本方法，从 IDB 把上次会话留下的
   *     presences / tables / txIngest 拉回内存。
   *   - 切 active key 后：rebindToActiveKey 命中 different-key 分支；
   *     清空旧 key 内存态 → 写入新 session key 引用 → 调本方法
   *     从新 key 的 IDB 恢复。
   *   - 任何失败（旧 DB 不存在 / vault 锁定 / namespace 已删）都
   *     swallow；service 始终能用空 cache 起步，不会被 DB 阻塞。
   *
   * **幂等性（硬切换 004 反馈修复）**：本函数可以被同一 service 实例
   * 多次调用而不应产生重复数据。具体：
   *   - presences / tables 用 Map 按 publicKeyHex / tableId 覆盖，
   *     天然幂等。
   *   - txEvents 是数组，必须显式按 txid 去重；详见下面实现。
   * 真实 keyspaceService.onActiveChange 在订阅时立刻推一次 handler，
   * 加上 service 构造里主动 scheduleRebindToActiveKey("init")，构造
   * 阶段可能对同一把 key 跑两次 hydrate。test 桩 FakeKeyspace 也应该
   * 模拟这个 eager 行为，否则测试覆盖不到。
   */
  private async hydrateFromKeyScopedDb(publicKeyHash: string | null): Promise<void> {
    if (!publicKeyHash) return;
    try {
      const handle = await this.deps.keyspace.openKeyStorage({
        publicKeyHash,
        pluginId: "plugin-poker",
        storageId: POKER_KEY_STORAGE_ID,
        version: POKER_KEY_STORAGE_VERSION,
        upgrade: upgradePokerDb
      });
      try {
        // 容错：缺 store 的旧 namespace（比如从未升级到 v3）→ 当作
        // 空 cache 处理，不阻塞 hydrate。生产路径下 upgradePokerDb 会
        // 保证三个 store 都存在；这条防御针对"DB 被外部写入半成品 schema"
        // 的边缘场景。
        const db = handle.db;
        const reads: Promise<unknown>[] = [
          Promise.resolve([] as unknown),
          Promise.resolve([] as unknown),
          Promise.resolve([] as unknown)
        ];
        if (db.objectStoreNames.contains("tables")) {
          reads[0] = readAllTables(db);
        }
        if (db.objectStoreNames.contains("presences")) {
          reads[1] = readAllPresences(db);
        }
        if (db.objectStoreNames.contains("txIngest")) {
          reads[2] = readAllTxIngest(db, this.txEventCap);
        }
        const [cachedTables, cachedPresences, cachedTxIngest] = await Promise.all(reads) as [
          ReturnType<typeof readAllTables> extends Promise<infer T> ? T : never,
          ReturnType<typeof readAllPresences> extends Promise<infer T> ? T : never,
          ReturnType<typeof readAllTxIngest> extends Promise<infer T> ? T : never
        ];

        // ----- presences -----
        for (const p of cachedPresences) {
          if (!p.publicKeyHex) continue;
          const presence: PokerPresence = {
            publicKeyHex: p.publicKeyHex,
            endpoint: p.endpoint,
            nick: p.nick,
            seenAt: p.seenAt
          };
          this.presences.set(presence.publicKeyHex, presence);
        }

        // ----- tables -----
        for (const t of cachedTables) {
          if (!t.tableId) continue;
          const tbl: PokerTable = {
            tableId: t.tableId,
            variant: t.variant,
            seats: t.seats,
            stakes: t.stakes,
            ownerPub: t.ownerPub,
            joined: false
          };
          this.tables.set(tbl.tableId, tbl);
        }

        // ----- txIngest -----
        // 去重（按 txid）必须**跨多次 hydrate 调用**生效：
        // keyspace.onActiveChange 订阅时会立刻推一次 handler（真实实现
        // 见 packages/plugin-vault/src/keyspaceService.ts），加上
        // 构造里我们主动 scheduleRebindToActiveKey("init")，构造阶段
        // 可能对同一把 key 做两次 hydrate。第二次如果只对本次新读到的
        // rows 去重，仍会把 DB 里的全部条目重复 push 进 this.txEvents
        // （因为本次 seenTxids 是空的）。所以必须先把当前内存里的
        // txid 也并入 seenTxids，才能保证"同一 service 实例的 hydrate
        // 是幂等的"。
        const seenTxids = new Set<string>();
        for (const e of this.txEvents) {
          if (e.txid) seenTxids.add(e.txid);
        }
        for (const t of cachedTxIngest) {
          if (!t.txid || seenTxids.has(t.txid)) continue;
          seenTxids.add(t.txid);
          this.txEvents.push({
            txid: t.txid,
            route: t.route,
            kind: t.kind,
            reason: t.reason,
            rawTx: t.rawTx,
            receivedAt: t.receivedAt
          });
        }
        this.txEvents.sort((a, b) => a.receivedAt - b.receivedAt);
        if (this.txEvents.length > this.txEventCap) {
          this.txEvents.splice(0, this.txEvents.length - this.txEventCap);
        }

        // ----- 通知订阅者 -----
        // presences：与现有 onPresenceFrame 行为一致——逐条 fire，handler
        //   一般只调 service.listPresences() 取快照，所以多次 fire 只是
        //   触发 React 一次 re-render，不会有副作用。
        if (cachedPresences.length > 0) {
          for (const h of this.presenceHandlers) {
            for (const p of this.presences.values()) {
              try {
                h(p);
              } catch {
                /* swallow */
              }
            }
          }
        }
        // tables：与现有 onTableFrame 行为一致——fire 一次完整快照。
        if (cachedTables.length > 0) {
          const snap = Array.from(this.tables.values());
          this.deps.messageBus.publish(POKER_EVENT.Tables, snap);
          for (const h of this.tableHandlers) {
            try {
              h(snap);
            } catch {
              /* swallow */
            }
          }
        }
        // txIngest：是历史数据，不主动 fire onTxEvent；调用方通过
        // service.recentTxEvents() 取快照（用于 inbox / 诊断）。
      } finally {
        try {
          handle.close();
        } catch {
          /* noop */
        }
      }
    } catch {
      // namespace 打不开（vault locked / 已删 / 旧版本无表）→ 静默
      // 兜底为空 cache。绝不允许 DB 故障阻塞 service 启动或切 key。
    }
  }

  private ensureReady(): void {
    if (this.currentStatus !== "ready") {
      throw new Error("Poker proxy not ready");
    }
    if (!this.currentSessionKey || !this.currentSessionKey.publicKeyHex) {
      throw new Error("Poker session key not resolved (vault locked or no active key)");
    }
    // 强校验：当前 session key 必须仍与 keyspace.active() 一致。
    // 硬切换 005：active key 模型收窄为唯一一把，不再有 `mode` 字段。
    const active = this.deps.keyspace.active();
    if (
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
