// packages/plugin-appmsg/src/appmsgCore.ts
// appmsg.core 平台单例（施工单 2026-07-04 001 硬切换）。
//
// 设计缘由：
//   - 系统中心：plugin-appmsg 持有唯一的 `AppMsgCoreImpl` 单例，提供
//     `appmsg.core` capability；
//   - **provider 抽象**：plugin-appmsg **不**直接 import 任何具体 provider
//     的 wire 实现。所有 send / list / get / subscribe / checkOnline 走
//     typed `MessageProviderOperations` 接口，由 provider 内部完成 wire
//     → 标准化 `AppMsgMessage` 翻译；
//   - **provider registry 真值**：`MessageProviderRegistryImpl` 由 plugin-appmsg
//     在构造时创建并挂到 `message.provider.registry` capability；provider
//     插件（plugin-hubmsg）只负责 `register(...)`，**不**持有 registry。
//   - **active provider 持久化**：首次启动 / 无配置时默认 `hubmsg`；用户
//     切换后持久化到 `appmsg.activeProviderId`（localStorage）；下次启动
//     若该 provider 不存在 / 不可用 → 进入 not-ready，明确报错，**不**
//     自动 fallback 到其它 provider；
//   - **endpoint service**：plugin-appmsg 持有 `AppMsgEndpointServiceRegistryImpl`，
//     业务插件（plugin-message / plugin-protocol）通过
//     `appmsg.endpoint.registry` capability 拿到稳定长寿的
//     `AppMsgEndpointService` 实例；
//   - **本地 DB 真值**：key-scoped IndexedDB，storageId = `messages_v2`（硬
//     切换）；旧 `messages` 不迁移、不兼容读、不 fall through；
//   - **单真值在本地 DB**：provider 仅做远端持久化 / 实时推送 / 在线查询；
//   - **严格 sender 投影 + ACL**：endpoint service 内部把 owner 真值 +
//     endpoint 解析成 sender 投影；DB 层仍按 `AppMsgScope` 做严格 ACL。
//
// 边界：
//   - 推送事件 `subscribeMessages`：handler 收到标准化 `AppMsgMessage`；
//     provider 内部完成 wire → public 翻译。
//   - 全库读 / 全库订阅（`listUnfilteredMessages` /
//     `subscribeUnfilteredMessages`）仍保留为 **platform internal** 能力，
//     **仅**供 `plugin-appmsg` 自己的管理页 + `plugin-protocol` 协议层
//     消费；plugin-message 等业务页**不**走这条路径。

import type {
  ActiveMessageProviderSnapshot,
  AppMsgAddress,
  AppMsgConnectOutcome,
  AppMsgContentType,
  AppMsgCore,
  AppMsgEndpointId,
  AppMsgEndpointService,
  AppMsgEndpointServiceRegistry,
  AppMsgGetInput,
  AppMsgListInput,
  AppMsgListResult,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgOnlineInput,
  AppMsgOnlineResult,
  AppMsgOnlineStatus,
  AppMsgRecipient,
  AppMsgScope,
  AppMsgSendInput,
  AppMsgSendResult,
  AppMsgSenderProjection,
  AppMsgTargetSyncState,
  KeyScopedStorageHandle,
  KeyspaceService,
  MessageProvider,
  MessageProviderHandle,
  MessageProviderHealth,
  MessageProviderOperations,
  MessageProviderRegistry,
  ProviderListResult,
  ProviderOnlineInput,
  ProviderOnlineResult,
  ProviderSenderProjection
} from "@keymaster/contracts";
import { KEYMASTER_MESSAGE_APP_ID } from "@keymaster/contracts";
import {
  createAppMsgLocalDbOps,
  disposeAppMsgLocalDb,
  openAppMsgLocalDb,
  senderProjectionToScope,
  targetIdFromMessage,
  type AppMsgLocalDbOps
} from "./appmsgDb.js";
import { syncAllScopes } from "./appmsgSync.js";

/* ============== AppMsgCore 配置 ============== */

export interface AppMsgCoreConfig {
  /** 给 active provider 的 owner signer 工厂；null = 不可用。 */
  signerProvider: () => Promise<AppMsgBindSigner | null>;
  /** keyspace service（plugin-appmsg 直接用）。 */
  keyspace: KeyspaceService;
  pluginId: string;
  storageId: string;
  /** localStorage 接口（默认 = globalThis.localStorage）。测试可注入 fake。 */
  localStorage?: Storage | null;
  logger?: {
    info?: (input: unknown) => void;
    warn?: (input: unknown) => void;
    error?: (input: unknown) => void;
  };
}

/**
 * 给 provider 用的 owner signer 抽象（plugin-appmsg 内部类型）。
 *
 * 实现 `ProviderSigner` 契约的"通用签名原语"——
 * `signChallenge({challenge})` 接受任意 `challenge` 字节，返回 secp256k1
 * compact 64-byte hex 签名。provider 自己决定 challenge 内容（HubMsg 用
 * `canonicalBindText`，其它 provider 可任意）。
 *
 * 注意：此类型**不**再保留 HubMsg 特有的四元组签名接口；该拼接规则
 * 已下沉到 `plugin-hubmsg::HubMsgBindSignerAdapter`。
 */
export interface AppMsgBindSigner {
  publicKeyHex: string;
  signChallenge(args: { challenge: Uint8Array }): Promise<string>;
}

function emitLog(
  logger: AppMsgCoreConfig["logger"] | undefined,
  level: "info" | "warn" | "error",
  event: string,
  data?: Record<string, unknown>
): void {
  if (!logger) return;
  const fn = logger[level];
  if (!fn) return;
  const safe: Record<string, unknown> = { event };
  if (data) {
    for (const k of Object.keys(data)) {
      if (k === "body") continue;
      safe[k] = data[k];
    }
  }
  try {
    fn(safe);
  } catch {
    // ignore
  }
}

interface ScopedSubscription {
  match: (msg: AppMsgMessage) => boolean;
  handler: (msg: AppMsgMessage) => void;
}

/* ============== 内部 sender endpoint 派生 ============== */

function senderEndpointFor(sender: AppMsgSenderProjection): {
  kind: "origin" | "plugin";
  id: string;
} {
  if (sender.senderOrigin) return { kind: "origin", id: sender.senderOrigin };
  if (sender.senderAppId) return { kind: "plugin", id: sender.senderAppId };
  return { kind: "plugin", id: "" };
}

function recipientEndpointFor(input: AppMsgRecipient): {
  kind: "origin" | "plugin";
  id: string;
} {
  if (input.recipientOrigin) return { kind: "origin", id: input.recipientOrigin };
  if (input.recipientAppId) return { kind: "plugin", id: input.recipientAppId };
  return { kind: "plugin", id: "" };
}

function senderToProviderProjection(sender: AppMsgSenderProjection): ProviderSenderProjection {
  const out: ProviderSenderProjection = { senderPublicKeyHex: sender.senderPublicKeyHex };
  if (sender.senderOrigin) out.senderOrigin = sender.senderOrigin;
  if (sender.senderAppId) out.senderAppId = sender.senderAppId;
  return out;
}

function matchesScope(m: AppMsgMessage, scope: AppMsgScope): boolean {
  if (
    m.senderPublicKeyHex !== scope.ownerPublicKeyHex &&
    m.recipientPublicKeyHex !== scope.ownerPublicKeyHex
  ) {
    return false;
  }
  if (scope.kind === "all") return true;
  if (!scope.id) return false;
  if (scope.kind === "origin") {
    return (
      (m.senderPublicKeyHex === scope.ownerPublicKeyHex &&
        m.senderOrigin === scope.id) ||
      (m.recipientPublicKeyHex === scope.ownerPublicKeyHex &&
        m.recipientOrigin === scope.id)
    );
  }
  if (scope.kind === "plugin") {
    return (
      (m.senderPublicKeyHex === scope.ownerPublicKeyHex && m.senderAppId === scope.id) ||
      (m.recipientPublicKeyHex === scope.ownerPublicKeyHex && m.recipientAppId === scope.id)
    );
  }
  return false;
}

/* ============== MessageProviderRegistry 实现 ============== */

/**
 * plugin-appmsg 内部持有的 provider 注册表。
 *
 * 设计缘由：
 *   - **持久化**：构造时从 localStorage 读 `appmsg.activeProviderId`；写时
 *     同步回写；
 *   - **首次启动默认值**：当 `localStorage` 无值且 `hubmsg` 已注册时默认
 *     选 `hubmsg`；否则 `null`（进入 not-ready）；
 *   - **不自动 fallback**：用户切到某 provider 后持久化；下次启动如果该
 *     provider 不在已注册集合中 → `active = null` → not-ready，**不**自动
 *     跳回 `hubmsg`；
 *   - **单选 active**：切换时旧 provider 的 handle 被关闭，新 provider 的
 *     `bind(...)` 在调用方（plugin-appmsg core）里完成；registry 只负责
 *     通知订阅者变化，**不**自己持有连接真值。
 */
class MessageProviderRegistryImpl implements MessageProviderRegistry {
  private readonly providersById = new Map<string, MessageProvider>();
  private activeProviderId: string | null;
  /** 持久化的 active providerId；与 `activeProviderId` 区分：
   *   - 启动期 `activeProviderId = persisted`（可能 null）；
   *   - 用户**显式** setActive(null) 后 `bootstrapDefaultConsumed = true`，
   *     阻止后续 register 时再偷偷回退到 `hubmsg` 默认值。
   */
  private readonly persistedProviderId: string | null;
  private bootstrapDefaultConsumed = false;
  private readonly listeners = new Set<(s: ActiveMessageProviderSnapshot) => void>();
  private readonly localStorageRef: Storage | null;

  constructor(opts: { persisted: string | null; localStorage: Storage | null }) {
    this.activeProviderId = opts.persisted;
    this.persistedProviderId = opts.persisted;
    this.localStorageRef = opts.localStorage;
    // 如果持久值存在（无论是不是 null），意味着用户已做过选择
    // （即使是 null 也算"显式清除"），bootstrap 默认值不再适用。
    this.bootstrapDefaultConsumed = opts.persisted !== null;
  }

  register(provider: MessageProvider): void {
    if (this.providersById.has(provider.id)) {
      throw new Error(
        `messageProvider.registry: provider "${provider.id}" already registered`
      );
    }
    this.providersById.set(provider.id, provider);

    // 触发 1：持久化的 id 命中 provider 注册进来 → 激活。
    if (
      this.persistedProviderId === provider.id &&
      this.activeProviderId === null
    ) {
      this.activeProviderId = provider.id;
      this.bootstrapDefaultConsumed = true;
      this.fireChange();
      return;
    }

    // 触发 2：首次启动 + 持久值为 null + 还没消费过默认 → 默认 `hubmsg`。
    // 一旦消费过默认（setActive(null) / setActive("hubmsg") / 用户切走
    // 又切回 hubmsg 之外的 provider 等），**不再**自动回退。
    if (
      this.persistedProviderId === null &&
      this.activeProviderId === null &&
      !this.bootstrapDefaultConsumed
    ) {
      if (this.providersById.has("hubmsg")) {
        this.activeProviderId = "hubmsg";
        this.persistActive("hubmsg");
        this.bootstrapDefaultConsumed = true;
        this.fireChange();
      }
    }
  }

  unregister(providerId: string): void {
    if (!this.providersById.has(providerId)) return;
    this.providersById.delete(providerId);
    if (this.activeProviderId === providerId) {
      this.activeProviderId = null;
      this.persistActive(null);
      this.fireChange();
    }
  }

  list(): readonly MessageProvider[] {
    return Array.from(this.providersById.values());
  }

  async setActive(providerId: string | null): Promise<void> {
    if (providerId === null) {
      this.activeProviderId = null;
      this.persistActive(null);
      // 显式清空：标记"已被消费"，后续 register 不得自动回退到 hubmsg。
      this.bootstrapDefaultConsumed = true;
      this.fireChange();
      return;
    }
    if (!this.providersById.has(providerId)) {
      throw new Error(
        `messageProvider.registry: provider "${providerId}" is not registered`
      );
    }
    this.activeProviderId = providerId;
    this.persistActive(providerId);
    this.bootstrapDefaultConsumed = true;
    this.fireChange();
  }

  active(): MessageProvider | null {
    if (this.activeProviderId === null) return null;
    return this.providersById.get(this.activeProviderId) ?? null;
  }

  activeSnapshot(): ActiveMessageProviderSnapshot {
    const p = this.active();
    if (!p) {
      return {
        providerId: null,
        displayName: null,
        isHealthy: false,
        lastError: null
      };
    }
    let h: MessageProviderHealth;
    try {
      h = p.health();
    } catch {
      h = { isHealthy: false, lastError: "health probe failed", lastConnectedAtMs: 0 };
    }
    return {
      providerId: p.id,
      displayName: p.displayName,
      isHealthy: h.isHealthy,
      lastError: h.lastError
    };
  }

  onActiveChange(handler: (s: ActiveMessageProviderSnapshot) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  private persistActive(id: string | null): void {
    if (!this.localStorageRef) return;
    try {
      if (id === null) {
        this.localStorageRef.removeItem("appmsg.activeProviderId");
      } else {
        this.localStorageRef.setItem("appmsg.activeProviderId", id);
      }
    } catch {
      // 写失败不阻断主流程。
    }
  }

  private fireChange(): void {
    const snap = this.activeSnapshot();
    for (const h of this.listeners) {
      try {
        h(snap);
      } catch {
        // ignore
      }
    }
  }
}

function readPersistedActiveProvider(ls: Storage | null): string | null {
  if (!ls) return null;
  try {
    return ls.getItem("appmsg.activeProviderId");
  } catch {
    return null;
  }
}

/* ============== AppMsgEndpointService 实现 ============== */

/**
 * 单个 endpoint 的稳定长寿 service。
 *
 * 设计缘由（施工单 §5.3）：
 *   - 同一 endpoint 多次 `forEndpoint(...)` 返回**同一实例**；
 *   - service 内部按当前 owner + active provider 真值解析；
 *   - owner / provider 切换时**内部**自动迁移订阅——上层 React effect
 *     **不需要**重新订阅；
 *   - 当前未就绪（无 active provider / vault locked / 无 active key /
 *     handle 未建立）走降级：send → reject with not_ready；list → empty；
 *     get → null；subscribe → 不触发 handler；checkOnline → unknown。
 */
class AppMsgEndpointServiceImpl implements AppMsgEndpointService {
  readonly endpoint: AppMsgEndpointId;
  private readonly core: AppMsgCoreImpl;
  /** 当前 handle 的 subscribe 句柄（owner / provider 变化时迁移）。 */
  private readonly handlers = new Set<(msg: AppMsgMessage) => void>();
  /** 当前已绑定的 provider subscribe 句柄列表，按 handler 索引。 */
  private currentSubsByHandler = new Map<
    (msg: AppMsgMessage) => void,
    () => void
  >();

  constructor(core: AppMsgCoreImpl, endpoint: AppMsgEndpointId) {
    this.core = core;
    this.endpoint = endpoint;
    // 监听 core 状态变化；状态变化时**内部**迁移所有 handler 的订阅。
    this.core.onStateChange(() => this.rebindAllSubscriptions());
  }

  isReady(): boolean {
    const owner = this.core.resolveCurrentOwner();
    const handle = this.core.currentHandle();
    return Boolean(owner && handle);
  }

  async sendMessage(input: AppMsgSendInput): Promise<AppMsgSendResult> {
    const handle = this.core.currentHandle();
    if (!handle) {
      throw new Error("appmsg.endpoint: not_ready (no active provider handle)");
    }
    const owner = this.core.resolveCurrentOwner();
    if (!owner) {
      throw new Error("appmsg.endpoint: not_ready (no current owner)");
    }
    const sender: AppMsgSenderProjection = (() => {
      if (this.endpoint.kind === "plugin") {
        return { senderPublicKeyHex: owner, senderAppId: this.endpoint.id };
      }
      return { senderPublicKeyHex: owner, senderOrigin: this.endpoint.id };
    })();
    return this.core.sendMessageImpl(handle, sender, input);
  }

  async listMessages(input?: AppMsgListInput): Promise<AppMsgListResult> {
    const handle = this.core.currentHandle();
    const owner = this.core.resolveCurrentOwner();
    if (!handle || !owner) {
      return { items: [], hasMore: false };
    }
    return this.core.listMessagesImpl(handle, owner, this.endpoint, input);
  }

  async getMessage(input: AppMsgGetInput): Promise<AppMsgMessage | null> {
    const handle = this.core.currentHandle();
    const owner = this.core.resolveCurrentOwner();
    if (!handle || !owner) {
      return null;
    }
    return this.core.getMessageImpl(handle, owner, this.endpoint, input);
  }

  subscribeMessages(handler: (msg: AppMsgMessage) => void): () => void {
    this.handlers.add(handler);
    // 立刻尝试绑一次（如果当前已有 handle）；否则等待 onStateChange 触发。
    this.bindOne(handler);
    return () => {
      this.handlers.delete(handler);
      const off = this.currentSubsByHandler.get(handler);
      if (off) {
        try {
          off();
        } catch {
          // ignore
        }
        this.currentSubsByHandler.delete(handler);
      }
    };
  }

  async checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult> {
    const handle = this.core.currentHandle();
    if (!handle) {
      const out: AppMsgOnlineResult = {};
      for (const h of input) out[h] = "unknown";
      return out;
    }
    const providerIn: ProviderOnlineInput = { publicKeyHexes: input };
    const providerOut = await handle.checkOnline(providerIn);
    return providerOut as AppMsgOnlineResult;
  }

  /** 当前 scope match 函数（按 endpoint 解析）。 */
  private scopeMatch(): (m: AppMsgMessage) => boolean {
    const owner = this.core.resolveCurrentOwner();
    if (!owner) return () => false;
    // AppMsgEndpointId.kind 是 "origin" | "plugin"，**不**包含 "all"；
    // endpoint service 不提供"全库订阅"路径，全库订阅仅供 plugin-appmsg
    // 管理页 + plugin-protocol 协议层通过 subscribeUnfilteredMessages 走。
    const scope: AppMsgScope = {
      ownerPublicKeyHex: owner,
      kind: this.endpoint.kind,
      id: this.endpoint.id
    };
    return (m) => matchesScope(m, scope);
  }

  private bindOne(handler: (msg: AppMsgMessage) => void): void {
    const handle = this.core.currentHandle();
    if (!handle) {
      // handle 不可用时 handler 暂不绑；等下次 onStateChange。
      return;
    }
    const scopeMatch = this.scopeMatch();
    const filteredHandler = (m: AppMsgMessage) => {
      if (!scopeMatch(m)) return;
      try {
        handler(m);
      } catch {
        // ignore
      }
    };
    const off = handle.subscribeMessages(filteredHandler);
    this.currentSubsByHandler.set(handler, off);
  }

  private rebindAllSubscriptions(): void {
    // 1. 解除所有当前订阅。
    for (const off of this.currentSubsByHandler.values()) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    this.currentSubsByHandler.clear();
    // 2. 重新绑定（如果当前有 handle）。
    for (const h of this.handlers) {
      this.bindOne(h);
    }
  }
}

/* ============== AppMsgEndpointServiceRegistry 实现 ============== */

class AppMsgEndpointServiceRegistryImpl implements AppMsgEndpointServiceRegistry {
  private readonly core: AppMsgCoreImpl;
  private readonly services = new Map<string, AppMsgEndpointService>();

  constructor(core: AppMsgCoreImpl) {
    this.core = core;
  }

  forEndpoint(endpoint: AppMsgEndpointId): AppMsgEndpointService {
    const key = `${endpoint.kind}:${endpoint.id}`;
    let svc = this.services.get(key);
    if (!svc) {
      svc = new AppMsgEndpointServiceImpl(this.core, endpoint);
      this.services.set(key, svc);
    }
    return svc;
  }

  releaseEndpoint(endpoint: AppMsgEndpointId): void {
    const key = `${endpoint.kind}:${endpoint.id}`;
    this.services.delete(key);
  }

  listEndpoints(): readonly AppMsgEndpointId[] {
    return Array.from(this.services.keys()).map((k) => {
      const [kind, id] = k.split(":", 2) as [AppMsgEndpointId["kind"], string];
      return { kind, id };
    });
  }
}

/* ============== 主实现 ============== */

export class AppMsgCoreImpl implements AppMsgCore {
  private readonly cfg: AppMsgCoreConfig;
  private readonly providerRegistryInstance: MessageProviderRegistryImpl;
  private readonly endpointRegistryInstance: AppMsgEndpointServiceRegistryImpl;
  /** 当前 bound provider handle。 */
  private boundHandle: MessageProviderOperations | null = null;
  /** 当前绑定的 owner publicKeyHex。 */
  private currentBoundOwner: string | null = null;
  /** 当前 active provider id（DB 写路径必须带这个维度）。 */
  private currentProviderId: string | null = null;
  /** 本地 DB handle。 */
  private localHandle: KeyScopedStorageHandle | null = null;
  /** 当前 owner 的本地 DB ops 句柄。 */
  private localOps: AppMsgLocalDbOps | null = null;
  /** unfiltered 订阅者（管理页 / 协议层专用）。 */
  private readonly unfilteredSubs = new Set<(msg: AppMsgMessage) => void>();
  /** 当前 unfiltered 订阅的 provider off 句柄。 */
  private currentUnfilteredOff: (() => void) | null = null;
  /** state change 订阅者（endpoint service 内部使用）。 */
  private readonly stateChangeListeners = new Set<() => void>();
  /** 最近一次本地库写入时间戳。 */
  private lastInsertedAtMsValue: number = 0;
  /** 最近一次错误 message。 */
  private lastErrorMessageValue: string | null = null;
  /**
   * 等待下一次自动重连的截止时间戳（unix ms）。
   *
   * 真值由 `plugin-appmsg` setup 内的重连协调器写入，core 本身**不**
   * 负责起 timer；core 仅持有"是否在等待重连"这一最小真值，以便
   * 管理页 `inspectLocalDb()` 拿到一致快照。
   *
   * 约束（施工单 2026-07-04 003 §5.5 / §5.6 / §5.7）：
   *   - 仅在 `boundHandle` 不存在 / 已不再 `bound`，且结构条件仍满足
   *     时，由协调器写入未来时间戳；
   *   - 连接成功、显式 `disconnect()`、结构性不可连接、provider 切换
   *     离开本次 owner → 必须被清空（`null`）。
   */
  private nextReconnectAtMsValue: number | null = null;
  /** 防止同时多次 triggerSync 并发。 */
  private syncInFlight: Promise<void> | null = null;
  /** keyspace 引用（platform internal）。 */
  readonly keyspace: KeyspaceService;

  constructor(cfg: AppMsgCoreConfig) {
    this.cfg = cfg;
    this.keyspace = cfg.keyspace;
    this.providerRegistryInstance = new MessageProviderRegistryImpl({
      persisted: readPersistedActiveProvider(cfg.localStorage ?? null),
      localStorage: cfg.localStorage ?? null
    });
    this.endpointRegistryInstance = new AppMsgEndpointServiceRegistryImpl(this);
  }

  /* ====== Provider registry ====== */

  providers(): MessageProviderRegistry {
    return this.providerRegistryInstance;
  }

  endpointRegistry(): AppMsgEndpointServiceRegistry {
    return this.endpointRegistryInstance;
  }

  activeProviderSnapshot(): ActiveMessageProviderSnapshot {
    return this.providerRegistryInstance.activeSnapshot();
  }

  /* ====== owner / provider 变化订阅 ====== */

  onStateChange(handler: () => void): () => void {
    this.stateChangeListeners.add(handler);
    return () => {
      this.stateChangeListeners.delete(handler);
    };
  }

  currentHandle(): MessageProviderOperations | null {
    return this.boundHandle;
  }

  /** 当前 owner publicKeyHex；vault locked / 无 active key / 无 owner 时返回 null。 */
  resolveCurrentOwner(): string | null {
    try {
      if (!this.cfg.keyspace) return null;
      return this.cfg.keyspace.active().activePublicKeyHex ?? null;
    } catch {
      return null;
    }
  }

  /* ====== 连接管理 ====== */

  /**
   * 内部连接代次计数器（硬切换 003 反馈"必改"第二轮）。
   *
   * 每次 `connectForOwner` 入口 `++`。**仅**用于 core 内部"是否被更
   * 新的一次 `connectForOwner` 抢占"的校验——与"调用方结构代次"无关。
   *
   * 旧实现"async 完成时同时校验调用方 epoch 和内部 connectEpoch 等
   * 值"会让同一结构代次下的 5 秒重试（callerEpoch 不变，但每次都进
   * connectForOwner 都会 ++connectEpoch）直接返回 stale。本字段
   * 仅防"被同实例另一次 connectForOwner 抢占"，caller 端的过期由
   * 协调器自检。
   */
  private connectEpoch: number = 0;
  /** 关闭已握手的 handle 时（远端断线 / 显式 close）同步解除；`null` 表示未挂订阅。 */
  private handleCloseOff: (() => void) | null = null;
  /**
   * 远端断线时由 provider 主动触发；fireStateChange 后 manifest 协调
   * 器订阅 `onStateChange` 即可识别"上次 open → 突然不在 bound"，重
   * 新进入 5 秒循环。
   */
  private onHandleGoneAfterBound: () => void = () => undefined;

  /**
   * connect 当前 owner。
   *
   * 参数 `callerEpoch`（反馈"必改"第二轮修订）：
   *   - **仅**是 caller 端用来做"await 后自检"的标识——**不是**要求
   *     与 core 内部 `connectEpoch` 相等的"必须匹配 token"；
   *   - core 内部**不**读 / 不校验 callerEpoch；caller 在 await 之前
   *     记下自己当时的 epoch，await 后若 epoch 变了就视为 stale 丢弃
   *     结果——这与"提交前校验"语义等价（反馈"必改"第二轮指明 caller
   *     端自检的可行性）；
   *   - 旧实现"`epoch !== myEpoch` 直接 stale"的语义会让同一结构代
   *     次下的 5 秒重试全部变 stale，本次拆解后 callerEpoch 与
   *     connectEpoch 互不干扰。
   */
  async connectForOwner(
    ownerPublicKeyHex: string,
    callerEpoch?: number
  ): Promise<AppMsgConnectOutcome> {
    // 1. 短路径：当前已连到同一 owner 且 handle 真在 bound。
    if (
      this.currentBoundOwner === ownerPublicKeyHex &&
      this.boundHandle &&
      this.boundHandle.state() === "bound"
    ) {
      return { kind: "connected" };
    }

    // 2. 进入新一轮：自增内部 connectEpoch，记录 myEpoch。
    //    `callerEpoch` 仅由调用方在 await 后自检（用于决定是否采用本
    //    结果），core 内部**不**做等值比较。
    this.connectEpoch += 1;
    const myEpoch = this.connectEpoch;
    void callerEpoch;

    emitLog(this.cfg.logger, "info", "appmsg.connect.begin", {
      ownerPublicKeyHex,
      connectEpoch: myEpoch
    });
    // 先断开旧 handle，释放本地 DB 占位。disconnect 不会重置 connectEpoch。
    await this.disconnect();
    if (myEpoch !== this.connectEpoch) {
      return { kind: "stale" };
    }
    // 3. 打开本地 DB：失败视为结构性离线（硬切换 003 反馈"必改"第二轮
    //    补的 `local_db_unavailable` 分支）。打不开 DB 后续 bind 不可
    //    继续——必须结构性离线，不排 5 秒重试。
    await this.openLocalDbForOwner(ownerPublicKeyHex);
    if (myEpoch !== this.connectEpoch) {
      return { kind: "stale" };
    }
    if (!this.localHandle || !this.localOps) {
      this.lastErrorMessageValue = "local db not available";
      emitLog(this.cfg.logger, "error", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        reason: "local_db_unavailable"
      });
      this.fireStateChange();
      return { kind: "structurallyOffline", reason: "local_db_unavailable" };
    }

    // 4. 结构性条件检查（在签名 + bind 之前）。
    const provider = this.providerRegistryInstance.active();
    if (!provider) {
      this.lastErrorMessageValue = "no active provider registered";
      emitLog(this.cfg.logger, "warn", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        reason: "no_active_provider"
      });
      this.fireStateChange();
      return { kind: "structurallyOffline", reason: "no_active_provider" };
    }

    const signer = await this.cfg.signerProvider();
    if (myEpoch !== this.connectEpoch) {
      return { kind: "stale" };
    }
    if (!signer) {
      this.lastErrorMessageValue = "no signer available (vault locked or no active key)";
      emitLog(this.cfg.logger, "warn", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        reason: "no_signer"
      });
      this.fireStateChange();
      return { kind: "structurallyOffline", reason: "no_signer" };
    }
    if (myEpoch !== this.connectEpoch) {
      return { kind: "stale" };
    }

    // 5. bind 阶段：抛错统一收口为 retryableFailure。
    let handle: MessageProviderHandle;
    try {
      handle = await provider.bind({ signer });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "error", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        reason: "bind_error",
        err: msg
      });
      this.fireStateChange();
      return { kind: "retryableFailure", reason: msg };
    }
    if (myEpoch !== this.connectEpoch) {
      // bind 期间被新调用抢占：自己持有的 handle 必须立即关掉，避免泄漏。
      try {
        (handle as MessageProviderOperations).close();
      } catch {
        // ignore
      }
      return { kind: "stale" };
    }
    if (!(handle as MessageProviderOperations).sendMessage) {
      // 类型守卫：bind 必须返回 typed operations。
      try {
        (handle as MessageProviderOperations).close();
      } catch {
        // ignore
      }
      this.lastErrorMessageValue = "provider.bind returned untyped handle";
      emitLog(this.cfg.logger, "error", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        reason: "untyped_handle"
      });
      this.fireStateChange();
      return { kind: "retryableFailure", reason: "untyped_handle" };
    }

    // 6. 提交前再校验 owner / provider 真值是否仍是本轮发起时记录的。
    //    这是 §7.2 / §7.3 / §7.4"旧连接污染新状态"的最后一道关卡。
    const currentOwner = this.cfg.keyspace.active().activePublicKeyHex ?? null;
    if (currentOwner !== ownerPublicKeyHex) {
      try {
        (handle as MessageProviderOperations).close();
      } catch {
        // ignore
      }
      return { kind: "stale" };
    }
    if (this.providerRegistryInstance.active()?.id !== provider.id) {
      try {
        (handle as MessageProviderOperations).close();
      } catch {
        // ignore
      }
      return { kind: "stale" };
    }
    if (myEpoch !== this.connectEpoch) {
      try {
        (handle as MessageProviderOperations).close();
      } catch {
        // ignore
      }
      return { kind: "stale" };
    }

    // 6. 正式提交：写入 boundHandle / currentBoundOwner / currentProviderId。
    this.boundHandle = handle as MessageProviderOperations;
    this.currentBoundOwner = ownerPublicKeyHex;
    this.currentProviderId = provider.id;
    this.lastErrorMessageValue = null;
    // 连接成功 → 重连协调器已写入的等待倒计时作废。
    this.nextReconnectAtMsValue = null;
    emitLog(this.cfg.logger, "info", "appmsg.connect.bound", {
      ownerPublicKeyHex,
      providerId: provider.id,
      connectEpoch: myEpoch
    });

    // 6.1 远端断线观测（硬切换 003 反馈"必改"）：bind 成功后立刻挂
    //     onClose 订阅。handle 真的断开时 fire state change，manifest
    //     协调器会通过 onStateChange 识别"刚 bound → 现在不在 bound"
    //     并重新进入 5 秒循环。
    this.attachHandleCloseHook(this.boundHandle);

    // 重挂 unfiltered 订阅（如果有）。
    this.reattachUnfilteredSubscriptions();

    // 触发同步。
    void this.triggerSync();
    this.fireStateChange();
    return { kind: "connected" };
  }

  /**
   * 把 core 拉到结构性离线态（硬切换 003 反馈"必改"）。
   *
   * 与 `disconnect()` 区别：
   *   - `disconnect()`：纯 IO 关闭，**不**清 `lastError`（用户手动断开
   *     时也希望保留最近错误文案）；
   *   - `markStructurallyOffline()`：把"曾经尝试过连接失败"的痕迹一
   *     并擦掉——`lastError` + `nextReconnectAtMs` + `currentBoundOwner`
   *     全部清回 null，让 `inspectLocalDb().state` 干净地回到 `idle`。
   *
   * 唯一调用者是 manifest 协调器内的 `goStructurallyOffline()`。
   */
  markStructurallyOffline(): void {
    // 1. 抬 connectEpoch：任何在飞的 connectForOwner 在 commit 前会
    //    发现 epoch 已变并自动返回 stale，不会污染本方法清理后的状态。
    this.connectEpoch += 1;
    // 2. 关 handle + 解 onClose 订阅。
    if (this.boundHandle) {
      try {
        this.boundHandle.close();
      } catch {
        // ignore
      }
      this.boundHandle = null;
    }
    if (this.handleCloseOff) {
      try {
        this.handleCloseOff();
      } catch {
        // ignore
      }
      this.handleCloseOff = null;
    }
    // 3. 清所有结构性离线痕迹。
    this.currentBoundOwner = null;
    this.currentProviderId = null;
    this.lastErrorMessageValue = null;
    this.nextReconnectAtMsValue = null;
    // 4. 关本地 DB（disconnect 也会做，但本入口独立可用）。
    if (this.localHandle) {
      try {
        this.localHandle.close();
      } catch {
        // ignore
      }
      this.localHandle = null;
      this.localOps = null;
    }
    if (this.currentUnfilteredOff) {
      try {
        this.currentUnfilteredOff();
      } catch {
        // ignore
      }
      this.currentUnfilteredOff = null;
    }
    this.fireStateChange();
  }

  /**
   * 给当前 bound handle 挂远端断线观测。
   *
   * 实现原则：
   *   - 不依赖具体 provider 的 wire 接口；任何实现 `MessageProviderOperations`
   *     的 handle 若自带 onClose 钩子，立即挂上；没有则降级为定时
   *     `state()` 轮询（≥1s 间隔）——这只是 fallback，**不**作为
   *     5 秒重连逻辑的驱动者，5 秒循环由 manifest 协调器持有。
   *   - 触发条件：handle `state()` 转入 `closed` / `idle` 且
   *     `currentBoundOwner` 仍记着同一个 owner；
   *     此时清掉本地的 `boundHandle` 引用并 fire state change，让
   *     manifest 协调器通过 `onStateChange` 检测"刚 bound → 突然不
   *     在 bound"并重新 attemptConnect。
   */
  private attachHandleCloseHook(handle: MessageProviderOperations): void {
    if (this.handleCloseOff) {
      try {
        this.handleCloseOff();
      } catch {
        // ignore
      }
      this.handleCloseOff = null;
    }
    // 1) 优先尝试 typed onClose（HubMsg 等 provider 可选实现）。
    const maybeOnClose = (handle as unknown as {
      onClose?: (h: () => void) => () => void;
    }).onClose;
    if (typeof maybeOnClose === "function") {
      const off = maybeOnClose(() => this.handleGoneAfterBound());
      this.handleCloseOff = () => {
        try {
          off();
        } catch {
          // ignore
        }
      };
      return;
    }
    // 2) Fallback：低频 state() 轮询。**不**作为健康检查 / 计时依据，
    //    仅用于把"远端静默断开"翻译成一次 fireStateChange。
    const poller = setInterval(() => {
      const h = this.boundHandle;
      if (!h) {
        clearInterval(poller);
        return;
      }
      const st = h.state();
      if (st !== "bound") {
        clearInterval(poller);
        this.handleGoneAfterBound();
      }
    }, 1000);
    this.handleCloseOff = () => {
      clearInterval(poller);
    };
  }

  /**
   * 远端断线处理（硬切换 003 反馈"必改"）。
   *
   * 触发后：
   *   - 清掉 `boundHandle` 引用（保持 `currentBoundOwner` 不变——仍
   *     记着"曾试图连上这个 owner"，管理页可正确显示 `closed`）；
   *   - 不自动排 5 秒 timer——manifest 协调器通过订阅
   *     `onStateChange()` 识别此事件后才会触发 `attemptConnect()`，
   *     保证"重连驱动逻辑只在 manifest 一处"。
   */
  private handleGoneAfterBound(): void {
    if (this.boundHandle && this.boundHandle.state() !== "bound") {
      this.boundHandle = null;
      this.lastErrorMessageValue = "connection closed by remote";
      this.fireStateChange();
    }
  }

  async disconnect(): Promise<void> {
    const wasBound = this.boundHandle !== null;
    if (this.boundHandle) {
      try {
        this.boundHandle.close();
      } catch {
        // ignore
      }
      this.boundHandle = null;
    }
    if (this.handleCloseOff) {
      try {
        this.handleCloseOff();
      } catch {
        // ignore
      }
      this.handleCloseOff = null;
    }
    if (wasBound) {
      emitLog(this.cfg.logger, "info", "appmsg.connect.closed", {
        ownerPublicKeyHex: this.currentBoundOwner
      });
    }
    this.currentBoundOwner = null;
    // 显式 / 结构性断开：等待中的下一次自动重连截止时间一律作废。
    // 注意：这里的清空**不**触发 `fireStateChange()`——`disconnect` 本
    // 身在末尾会触发一次 state change；避免重复通知。
    this.nextReconnectAtMsValue = null;
    if (this.currentUnfilteredOff) {
      try {
        this.currentUnfilteredOff();
      } catch {
        // ignore
      }
      this.currentUnfilteredOff = null;
    }
    if (this.localHandle) {
      try {
        this.localHandle.close();
      } catch {
        // ignore
      }
      this.localHandle = null;
      this.localOps = null;
    }
    this.fireStateChange();
  }

  /* ====== 本地 DB ====== */

  async openLocalDb(input: { publicKeyHex: string }): Promise<KeyScopedStorageHandle | null> {
    if (this.currentBoundOwner && this.currentBoundOwner !== input.publicKeyHex) {
      return null;
    }
    const opened = await openAppMsgLocalDb({
      keyspace: this.cfg.keyspace,
      publicKeyHex: input.publicKeyHex
    });
    if (!opened) return null;
    this.localHandle = opened.handle;
    this.localOps = createAppMsgLocalDbOps(opened.handle);
    return opened.handle;
  }

  private async openLocalDbForOwner(publicKeyHex: string): Promise<void> {
    if (this.localHandle) {
      try {
        this.localHandle.close();
      } catch {
        // ignore
      }
      this.localHandle = null;
      this.localOps = null;
    }
    const opened = await openAppMsgLocalDb({
      keyspace: this.cfg.keyspace,
      publicKeyHex
    });
    if (!opened) {
      this.lastErrorMessageValue = "local db not available";
      return;
    }
    this.localHandle = opened.handle;
    this.localOps = createAppMsgLocalDbOps(opened.handle);
  }

  inspectLocalDb(): AppMsgLocalDbSnapshot {
    // state 真值（硬切换 003 §5.7 修正 + 反馈"必改"）：
    //   - boundHandle 存在 **且** `boundHandle.state() === "bound"` → open；
    //   - 否则按"是否应当重连"决定 closed / idle：
    //       * `currentBoundOwner !== null`：曾连上 owner，但 handle 不
    //         在 bound（远端断线 / 显式断开）→ 当前应当重连 → `closed`；
    //       * `nextReconnectAtMs !== null`：协调器已写入等待重连截止时
    //         间 → `closed`；
    //       * 其余情形：从未连过 / 结构性不可连接 → `idle`。
    //
    // **不**再用 `lastErrorMessageValue !== null` 兜底——曾经的失败
    // 不代表"当前应当重连"；结构性不可连接场景必须能稳定回到 `idle`。
    const isOpen = Boolean(
      this.boundHandle && this.boundHandle.state() === "bound"
    );
    const state: AppMsgLocalDbSnapshot["state"] = isOpen
      ? "open"
      : this.nextReconnectAtMsValue !== null || this.currentBoundOwner !== null
        ? "closed"
        : "idle";
    return {
      state,
      ownerPublicKeyHex: this.currentBoundOwner,
      lastInsertedAtMs: this.lastInsertedAtMsValue,
      lastError: this.lastErrorMessageValue,
      nextReconnectAtMs: isOpen ? null : this.nextReconnectAtMsValue
    };
  }

  /**
   * 由 setup 内的重连协调器写入下一次自动重连截止时间戳。
   *
   * - `value` 必须为未来时间戳；`null` 表示清空；
   * - 写入后立即触发 `fireStateChange()`，让订阅 `onStateChange` 的
   *   管理页立即刷新倒计时展示；
   * - 该入口是 plugin-appmsg **唯一**允许写入 `nextReconnectAtMs`
   *   的通道；core 内部不再自己起 5 秒定时器。
   */
  setNextReconnectAtMs(value: number | null): void {
    const normalized =
      typeof value === "number" && Number.isFinite(value) ? value : null;
    if (this.nextReconnectAtMsValue === normalized) return;
    this.nextReconnectAtMsValue = normalized;
    this.fireStateChange();
  }

  /** 读取当前等待重连截止时间戳（仅 setup 协调器内部诊断用）。 */
  getNextReconnectAtMs(): number | null {
    return this.nextReconnectAtMsValue;
  }

  /* ====== Endpoint service 内部调用 ============== */
  /* 由 AppMsgEndpointServiceImpl 直接调用本类内部的 `sendMessageImpl` / */
  /* `listMessagesImpl` / `getMessageImpl`，不暴露为 public API。 */

  /* platform-internal: 由 AppMsgEndpointServiceImpl 调用 */
  async sendMessageImpl(
    handle: MessageProviderOperations,
    sender: AppMsgSenderProjection,
    input: AppMsgSendInput
  ): Promise<AppMsgSendResult> {
    // 校验输入（owner / endpoint 等已在 endpoint service 层做完）。
    const hasSenderOrigin =
      typeof sender.senderOrigin === "string" && sender.senderOrigin.length > 0;
    const hasSenderAppId = typeof sender.senderAppId === "string" && sender.senderAppId.length > 0;
    if (hasSenderOrigin === hasSenderAppId) {
      throw new Error("appmsg.core: exactly one of senderOrigin / senderAppId required");
    }
    const hasRecipientOrigin =
      typeof input.recipientOrigin === "string" && input.recipientOrigin.length > 0;
    const hasRecipientAppId =
      typeof input.recipientAppId === "string" && input.recipientAppId.length > 0;
    if (hasRecipientOrigin === hasRecipientAppId) {
      throw new Error(
        "appmsg.core: exactly one of recipientOrigin / recipientAppId required"
      );
    }
    if (!input.recipientPublicKeyHex) {
      throw new Error("appmsg.core: recipientPublicKeyHex required");
    }
    if (input.contentType !== "text/plain" && input.contentType !== "text/markdown") {
      throw new Error("appmsg.core: invalid contentType");
    }
    if (typeof input.body !== "string" || input.body.length === 0) {
      throw new Error("appmsg.core: body must be non-empty");
    }
    if (!input.clientMessageId) {
      throw new Error("appmsg.core: clientMessageId required");
    }
    emitLog(this.cfg.logger, "info", "appmsg.send.begin", {
      clientMessageId: input.clientMessageId,
      contentType: input.contentType,
      bodyBytes: input.body.length,
      senderKind: hasSenderOrigin ? "origin" : hasSenderAppId ? "plugin" : "none"
    });
    const senderEp = senderEndpointFor(sender);
    let res: { messageId: string; createdAtMs: number };
    try {
      const providerSender = senderToProviderProjection(sender);
      res = await handle.sendMessage({
        sender: providerSender,
        recipientPublicKeyHex: input.recipientPublicKeyHex,
        recipientOrigin: input.recipientOrigin,
        recipientAppId: input.recipientAppId,
        contentType: input.contentType,
        body: input.body,
        clientMessageId: input.clientMessageId,
        createdAtMs: input.createdAtMs
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "error", "appmsg.send.failed", {
        clientMessageId: input.clientMessageId,
        err: msg
      });
      throw err;
    }
    emitLog(this.cfg.logger, "info", "appmsg.send.ok", {
      messageId: res.messageId,
      clientMessageId: input.clientMessageId
    });

    // self-send：sender == recipient at endpoint；本地 DB 写一份（HubMsg 服务端
    // 不再 push）。
    const isSelfSend =
      sender.senderPublicKeyHex === input.recipientPublicKeyHex &&
      ((hasSenderOrigin && sender.senderOrigin === input.recipientOrigin) ||
        (hasSenderAppId && sender.senderAppId === input.recipientAppId));
    if (isSelfSend && this.localOps && this.currentProviderId) {
      try {
        await this.localOps.putMessage(this.currentProviderId, {
          messageId: res.messageId,
          clientMessageId: input.clientMessageId,
          senderPublicKeyHex: sender.senderPublicKeyHex,
          senderOrigin: hasSenderOrigin ? sender.senderOrigin : undefined,
          senderAppId: hasSenderAppId ? sender.senderAppId : undefined,
          recipientPublicKeyHex: input.recipientPublicKeyHex,
          recipientOrigin: hasRecipientOrigin ? input.recipientOrigin : undefined,
          recipientAppId: hasRecipientAppId ? input.recipientAppId : undefined,
          contentType: input.contentType,
          body: input.body,
          createdAtMs: input.createdAtMs,
          insertedAtMs: res.createdAtMs
        });
        this.lastInsertedAtMsValue = Date.now();
      } catch (err) {
        this.lastErrorMessageValue = err instanceof Error ? err.message : String(err);
      }
    }
    return { messageId: res.messageId, createdAtMs: res.createdAtMs };
  }

  /* platform-internal: 由 AppMsgEndpointServiceImpl 调用 */
  async listMessagesImpl(
    handle: MessageProviderOperations,
    ownerPublicKeyHex: string,
    endpoint: AppMsgEndpointId,
    input?: AppMsgListInput
  ): Promise<AppMsgListResult> {
    const limit = input?.limit ?? 50;
    try {
      const res: ProviderListResult = await handle.listMessages({
        ownerPublicKeyHex,
        scopeEndpoint: endpoint,
        afterMessageId: input?.afterMessageId,
        limit
      });
      const items = res.items;
      return { items, hasMore: res.hasMore };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      return { items: [], hasMore: false };
    }
  }

  /* platform-internal: 由 AppMsgEndpointServiceImpl 调用 */
  async getMessageImpl(
    handle: MessageProviderOperations,
    ownerPublicKeyHex: string,
    endpoint: AppMsgEndpointId,
    input: AppMsgGetInput
  ): Promise<AppMsgMessage | null> {
    try {
      return await handle.getMessage({
        ownerPublicKeyHex,
        scopeEndpoint: endpoint,
        messageId: input.messageId
      });
    } catch (err) {
      this.lastErrorMessageValue = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /* ====== 全库订阅 / 全库读（platform internal） ====== */

  subscribeUnfilteredMessages(handler: (msg: AppMsgMessage) => void): () => void {
    this.unfilteredSubs.add(handler);
    if (this.boundHandle) {
      this.reattachUnfilteredSubscriptions();
    }
    return () => {
      this.unfilteredSubs.delete(handler);
      if (this.unfilteredSubs.size === 0 && this.currentUnfilteredOff) {
        try {
          this.currentUnfilteredOff();
        } catch {
          // ignore
        }
        this.currentUnfilteredOff = null;
      }
    };
  }

  private reattachUnfilteredSubscriptions(): void {
    if (this.currentUnfilteredOff) {
      try {
        this.currentUnfilteredOff();
      } catch {
        // ignore
      }
      this.currentUnfilteredOff = null;
    }
    if (this.unfilteredSubs.size === 0 || !this.boundHandle) return;
    this.currentUnfilteredOff = this.boundHandle.subscribeMessages((msg) => {
      // 写本地库（best-effort）—— 带当前 providerId 维度。
      this.localOps && this.currentProviderId
        ? this.localOps.putMessage(this.currentProviderId, msg)
        : Promise.resolve()
        .then(() => {
          this.lastInsertedAtMsValue = Date.now();
          this.recordTargetLastReceived(msg);
        })
        .catch((err) => {
          this.lastErrorMessageValue = err instanceof Error ? err.message : String(err);
          emitLog(this.cfg.logger, "warn", "appmsg.local.put.failed", {
            err: this.lastErrorMessageValue,
            messageId: msg.messageId
          });
        });
      // 派发给 unfiltered 订阅者。
      for (const h of this.unfilteredSubs) {
        try {
          h(msg);
        } catch {
          // ignore
        }
      }
      // 触发一次增量同步。
      void this.triggerSync();
      emitLog(this.cfg.logger, "info", "appmsg.receive.pushed", {
        messageId: msg.messageId,
        clientMessageId: msg.clientMessageId,
        contentType: msg.contentType,
        bodyBytes: msg.body.length
      });
    });
  }

  async listUnfilteredMessages(input?: AppMsgListInput): Promise<AppMsgListResult> {
    if (!this.localOps || !this.currentProviderId) {
      return { items: [], hasMore: false };
    }
    try {
      const limit = input?.limit ?? 200;
      const items = await this.localOps.listAllMessages({
        providerId: this.currentProviderId,
        afterMessageId: input?.afterMessageId,
        limit
      });
      return { items, hasMore: items.length >= limit };
    } catch (err) {
      this.lastErrorMessageValue = err instanceof Error ? err.message : String(err);
      return { items: [], hasMore: false };
    }
  }

  /* ====== 同步 ====== */

  async triggerSync(): Promise<void> {
    if (this.syncInFlight) {
      await this.syncInFlight.catch(() => {
        // ignore
      });
    }
    this.syncInFlight = this.doSync();
    try {
      await this.syncInFlight;
    } finally {
      this.syncInFlight = null;
    }
  }

  private async doSync(): Promise<void> {
    if (!this.currentBoundOwner || !this.currentProviderId) return;
    const scopes = await this.collectKnownScopes();
    if (scopes.length === 0) return;
    await syncAllScopes({
      handle: this.boundHandle,
      ops: this.localOps,
      providerId: this.currentProviderId,
      ownerPublicKeyHex: this.currentBoundOwner,
      scopeEndpoints: scopes,
      pageLimit: 100,
      resolveTargetKey: (ep) =>
        ep.kind === "origin" ? `origin:${ep.id}` : `appId:${ep.id}`,
      loadCursor: async (targetKey) => {
        if (!this.localOps || !this.currentProviderId) return "";
        const st = await this.localOps.getTargetState(this.currentProviderId, targetKey);
        return st?.lastSyncedMessageId ?? "";
      }
    });
  }

  private async collectKnownScopes(): Promise<Array<{ kind: "origin" | "plugin"; id: string }>> {
    const out: Array<{ kind: "origin" | "plugin"; id: string }> = [];
    out.push({ kind: "plugin", id: KEYMASTER_MESSAGE_APP_ID });
    if (this.localOps && this.currentProviderId) {
      try {
        const tids = await this.localOps.listTargetIds(this.currentProviderId);
        for (const t of tids) {
          if (t.startsWith("origin:")) {
            out.push({ kind: "origin", id: t.slice("origin:".length) });
          } else if (t.startsWith("appId:")) {
            out.push({ kind: "plugin", id: t.slice("appId:".length) });
          }
        }
      } catch {
        // ignore
      }
    }
    return out;
  }

  async listTargetSyncStates(): Promise<AppMsgTargetSyncState[]> {
    if (!this.localOps || !this.currentProviderId) return [];
    try {
      return await this.localOps.listTargetStates(this.currentProviderId);
    } catch {
      return [];
    }
  }

  /* ====== 在线 ====== */

  async checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult> {
    const out: AppMsgOnlineResult = {};
    if (!input || input.length === 0) return out;
    if (!this.boundHandle) {
      for (const h of input) out[h] = "unknown";
      return out;
    }
    try {
      const res: ProviderOnlineResult = await this.boundHandle.checkOnline({
        publicKeyHexes: input
      });
      const out2: AppMsgOnlineResult = {};
      for (const [k, v] of Object.entries(res)) {
        out2[k] = (v as AppMsgOnlineStatus) satisfies AppMsgOnlineStatus;
      }
      return out2;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "warn", "appmsg.online.failed", { err: msg });
      for (const h of input) out[h] = "unknown";
      return out;
    }
  }

  /* ====== 协议层专用：origin-based 系统内部入口 ====== */

  async sendAsOrigin(input: {
    origin: string;
    sendInput: AppMsgSendInput;
  }): Promise<AppMsgSendResult> {
    const handle = this.boundHandle;
    const owner = this.currentBoundOwner;
    if (!handle || !owner) {
      throw new Error("appmsg.core: not_ready (no active provider handle / owner)");
    }
    const sender: AppMsgSenderProjection = {
      senderPublicKeyHex: owner,
      senderOrigin: input.origin
    };
    return this.sendMessageImpl(handle, sender, input.sendInput);
  }

  async listAsOrigin(input: {
    origin: string;
    listInput?: AppMsgListInput;
  }): Promise<AppMsgListResult> {
    const handle = this.boundHandle;
    const owner = this.currentBoundOwner;
    if (!handle || !owner) {
      return { items: [], hasMore: false };
    }
    return this.listMessagesImpl(handle, owner, { kind: "origin", id: input.origin }, input.listInput);
  }

  async getAsOrigin(input: {
    origin: string;
    getInput: AppMsgGetInput;
  }): Promise<AppMsgMessage | null> {
    const handle = this.boundHandle;
    const owner = this.currentBoundOwner;
    if (!handle || !owner) {
      return null;
    }
    return this.getMessageImpl(
      handle,
      owner,
      { kind: "origin", id: input.origin },
      input.getInput
    );
  }

  /* ====== keyspace / provider 切换适配 ====== */

  /** 触发 state change 通知（endpoint service 内部迁移订阅用）。 */
  private fireStateChange(): void {
    for (const l of this.stateChangeListeners) {
      try {
        l();
      } catch {
        // ignore
      }
    }
  }

  private recordTargetLastReceived(msg: AppMsgMessage): void {
    if (!this.localOps || !this.currentProviderId) return;
    const targetId = targetIdFromMessage(msg);
    if (!targetId) return;
    const providerId = this.currentProviderId;
    void (async () => {
      try {
        const prev =
          (await this.localOps!.getTargetState(providerId, targetId)) ?? {
            targetKey: targetId,
            lastSyncedMessageId: "",
            lastReceivedAtMs: 0,
            lastSyncStartedAtMs: 0,
            lastSyncCompletedAtMs: 0,
            lastSyncError: null
          };
        await this.localOps!.putTargetState(providerId, {
          ...prev,
          lastReceivedAtMs: Math.max(
            prev.lastReceivedAtMs,
            msg.insertedAtMs || Date.now()
          )
        });
      } catch {
        // swallow
      }
    })();
  }
}

// 防止 IDE 报 unused
void ({} as AppMsgAddress);
void ({} as ProviderOnlineResult);