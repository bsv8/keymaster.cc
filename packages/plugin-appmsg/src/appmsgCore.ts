// packages/plugin-appmsg/src/appmsgCore.ts
// appmsg.core 平台单例（施工单 2026-07-04 001 + 2026-07-04 004 硬切换）。
//
// 设计缘由：
//   - 系统中心：plugin-appmsg 持有唯一的 `AppMsgCoreImpl` 单例，提供
//     `appmsg.core` capability；
//   - **provider 抽象**：plugin-appmsg **不**直接 import 任何具体 provider
//     的 wire 实现。所有 send / list / get / subscribe / checkOnline 走
//     typed `MessageProviderOperations` 接口，由 provider 内部完成 wire
//     → 标准化 `AppMsgMessage` 翻译；
//   - **唯一 seal/open + sign/verify 边界**：plugin-appmsg 是系统中
//     唯一允许调 ECDH / HKDF / AES-GCM / envelope 编解码 / 签名验签的
//     路径（施工单 2026-07-04 004 §5.3）；
//   - **provider 业务层 sealed record**：`sendMessage` / `listMessages`
//     / `getMessage` / `subscribeMessages` 全部走 sealed envelope record，
//     provider 不接触明文 body（§5.4 / §5.5）；
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
//   - **本地 DB 真值**：key-scoped IndexedDB，storageId = `messages_v3`（硬
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
  ProviderListInput,
  ProviderListResult,
  ProviderOnlineInput,
  ProviderOnlineResult,
  ProviderSealedMessageRecord,
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
import {
  AppMsgCryptoError,
  bytesToHex,
  hexToBytes,
  openAppMessage,
  readEnvelopeRoute,
  sealAppMessage
} from "./appmsgCrypto.js";

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
 *
 * 施工单 2026-07-04 004：同时暴露 owner 私钥 hex——`plugin-appmsg`
 * 入站 / 出站都需要 ECDH + envelope 签名，不能只走 `signChallenge`。
 * `privateKeyHex` 闭包在 `vault.withPrivateKey` 范围内持有；调用方
 * 用完即丢，**不**持久化 / **不**写日志 / **不**出现在任何长期真值。
 */
export interface AppMsgBindSigner {
  publicKeyHex: string;
  privateKeyHex: string;
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
  private readonly loggerRef: AppMsgCoreConfig["logger"] | undefined;

  constructor(opts: {
    persisted: string | null;
    localStorage: Storage | null;
    logger?: AppMsgCoreConfig["logger"];
  }) {
    this.activeProviderId = opts.persisted;
    this.persistedProviderId = opts.persisted;
    this.localStorageRef = opts.localStorage;
    this.loggerRef = opts.logger;
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
    emitLog(this.loggerRef, "info", "appmsg.provider_registry.registered", {
      providerId: provider.id,
      providerCount: this.providersById.size,
      activeProviderId: this.activeProviderId,
      persistedProviderId: this.persistedProviderId
    });

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
    emitLog(this.loggerRef, "info", "appmsg.provider_registry.unregistered", {
      providerId,
      providerCount: this.providersById.size,
      activeProviderId: this.activeProviderId
    });
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
    emitLog(this.loggerRef, "info", "appmsg.provider_registry.set_active.requested", {
      nextProviderId: providerId,
      currentProviderId: this.activeProviderId,
      providerCount: this.providersById.size
    });
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
    emitLog(this.loggerRef, "info", "appmsg.provider_registry.changed", {
      providerId: snap.providerId,
      displayName: snap.displayName,
      isHealthy: snap.isHealthy,
      lastError: snap.lastError,
      providerCount: this.providersById.size,
      listenerCount: this.listeners.size,
      bootstrapDefaultConsumed: this.bootstrapDefaultConsumed
    });
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
    const filteredHandler = (rec: ProviderSealedMessageRecord) => {
      const m = this.core.openSealedToMessage(rec);
      if (!m) return;
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
  /** 当前绑定的 owner privateKeyHex（plugin-appmsg 唯一持有位）。 */
  private currentBoundOwnerPrivateKeyHex: string | null = null;
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
      localStorage: cfg.localStorage ?? null,
      logger: cfg.logger
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
   */
  private connectEpoch: number = 0;
  /** 关闭已握手的 handle 时（远端断线 / 显式 close）同步解除；`null` 表示未挂订阅。 */
  private handleCloseOff: (() => void) | null = null;
  private onHandleGoneAfterBound: () => void = () => undefined;

  /**
   * connect 当前 owner。
   */
  async connectForOwner(
    ownerPublicKeyHex: string,
    callerEpoch?: number
  ): Promise<AppMsgConnectOutcome> {
    const connectStartedAt = Date.now();
    // 1. 短路径：当前已连到同一 owner 且 handle 真在 bound。
    if (
      this.currentBoundOwner === ownerPublicKeyHex &&
      this.boundHandle &&
      this.boundHandle.state() === "bound"
    ) {
      emitLog(this.cfg.logger, "info", "appmsg.connect.short_circuit_already_bound", {
        ownerPublicKeyHex,
        currentProviderId: this.currentProviderId
      });
      return { kind: "connected" };
    }

    // 2. 进入新一轮：自增内部 connectEpoch，记录 myEpoch。
    this.connectEpoch += 1;
    const myEpoch = this.connectEpoch;
    void callerEpoch;

    emitLog(this.cfg.logger, "info", "appmsg.connect.begin", {
      ownerPublicKeyHex,
      connectEpoch: myEpoch
    });
    // 先断开旧 handle，释放本地 DB 占位。
    emitLog(this.cfg.logger, "info", "appmsg.connect.disconnect.begin", {
      ownerPublicKeyHex,
      connectEpoch: myEpoch,
      hadHandle: this.boundHandle !== null,
      currentOwnerPublicKeyHex: this.currentBoundOwner
    });
    const disconnectStartedAt = Date.now();
    await this.disconnect();
    emitLog(this.cfg.logger, "info", "appmsg.connect.disconnect.done", {
      ownerPublicKeyHex,
      connectEpoch: myEpoch,
      elapsedMs: Date.now() - disconnectStartedAt
    });
    if (myEpoch !== this.connectEpoch) {
      return { kind: "stale" };
    }
    // 3. 打开本地 DB。
    emitLog(this.cfg.logger, "info", "appmsg.connect.local_db.open.begin", {
      ownerPublicKeyHex,
      connectEpoch: myEpoch
    });
    const openLocalDbStartedAt = Date.now();
    await this.openLocalDbForOwner(ownerPublicKeyHex);
    emitLog(this.cfg.logger, "info", "appmsg.connect.local_db.open.done", {
      ownerPublicKeyHex,
      connectEpoch: myEpoch,
      hasLocalDb: this.localHandle !== null && this.localOps !== null,
      elapsedMs: Date.now() - openLocalDbStartedAt
    });
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
    emitLog(this.cfg.logger, "info", "appmsg.connect.provider.selected", {
      ownerPublicKeyHex,
      connectEpoch: myEpoch,
      providerId: provider.id
    });

    emitLog(this.cfg.logger, "info", "appmsg.connect.signer.requested", {
      ownerPublicKeyHex,
      connectEpoch: myEpoch,
      providerId: provider.id
    });
    let signer: AppMsgBindSigner | null;
    const signerStartedAt = Date.now();
    try {
      signer = await this.cfg.signerProvider();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "error", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        providerId: provider.id,
        connectEpoch: myEpoch,
        reason: "signer_provider_error",
        elapsedMs: Date.now() - signerStartedAt,
        err: msg
      });
      this.fireStateChange();
      return { kind: "retryableFailure", reason: "signer_provider_error" };
    }
    if (myEpoch !== this.connectEpoch) {
      return { kind: "stale" };
    }
    if (!signer) {
      this.lastErrorMessageValue = "no signer available (vault locked or no active key)";
      emitLog(this.cfg.logger, "warn", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        providerId: provider.id,
        connectEpoch: myEpoch,
        reason: "no_signer",
        elapsedMs: Date.now() - signerStartedAt
      });
      this.fireStateChange();
      return { kind: "structurallyOffline", reason: "no_signer" };
    }
    emitLog(this.cfg.logger, "info", "appmsg.connect.signer.ready", {
      ownerPublicKeyHex,
      connectEpoch: myEpoch,
      providerId: provider.id,
      signerPublicKeyHex: signer.publicKeyHex,
      elapsedMs: Date.now() - signerStartedAt
    });
    if (myEpoch !== this.connectEpoch) {
      return { kind: "stale" };
    }

    // 5. bind 阶段：抛错统一收口为 retryableFailure。
    let handle: MessageProviderHandle;
    const bindStartedAt = Date.now();
    try {
      emitLog(this.cfg.logger, "info", "appmsg.connect.provider_bind.begin", {
        ownerPublicKeyHex,
        providerId: provider.id,
        connectEpoch: myEpoch,
        signerPublicKeyHex: signer.publicKeyHex
      });
      handle = await provider.bind({ signer });
      emitLog(this.cfg.logger, "info", "appmsg.connect.provider_bind.done", {
        ownerPublicKeyHex,
        providerId: provider.id,
        connectEpoch: myEpoch,
        elapsedMs: Date.now() - bindStartedAt
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "error", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        providerId: provider.id,
        connectEpoch: myEpoch,
        reason: "bind_error",
        elapsedMs: Date.now() - bindStartedAt,
        err: msg
      });
      this.fireStateChange();
      return { kind: "retryableFailure", reason: msg };
    }
    if (myEpoch !== this.connectEpoch) {
      try {
        (handle as MessageProviderOperations).close();
      } catch {
        // ignore
      }
      emitLog(this.cfg.logger, "warn", "appmsg.connect.stale_after_bind", {
        ownerPublicKeyHex,
        providerId: provider.id,
        connectEpoch: myEpoch,
        currentConnectEpoch: this.connectEpoch
      });
      return { kind: "stale" };
    }
    if (!(handle as MessageProviderOperations).sendMessage) {
      try {
        (handle as MessageProviderOperations).close();
      } catch {
        // ignore
      }
      this.lastErrorMessageValue = "provider.bind returned untyped handle";
      emitLog(this.cfg.logger, "error", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        providerId: provider.id,
        connectEpoch: myEpoch,
        reason: "untyped_handle"
      });
      this.fireStateChange();
      return { kind: "retryableFailure", reason: "untyped_handle" };
    }

    // 6. 提交前再校验 owner / provider 真值是否仍是本轮发起时记录的。
    const currentOwner = this.cfg.keyspace.active().activePublicKeyHex ?? null;
    if (currentOwner !== ownerPublicKeyHex) {
      try {
        (handle as MessageProviderOperations).close();
      } catch {
        // ignore
      }
      emitLog(this.cfg.logger, "warn", "appmsg.connect.stale_owner_changed", {
        expectedOwnerPublicKeyHex: ownerPublicKeyHex,
        currentOwnerPublicKeyHex: currentOwner,
        providerId: provider.id,
        connectEpoch: myEpoch
      });
      return { kind: "stale" };
    }
    if (this.providerRegistryInstance.active()?.id !== provider.id) {
      try {
        (handle as MessageProviderOperations).close();
      } catch {
        // ignore
      }
      emitLog(this.cfg.logger, "warn", "appmsg.connect.stale_provider_changed", {
        ownerPublicKeyHex,
        providerId: provider.id,
        currentProviderId: this.providerRegistryInstance.active()?.id ?? null,
        connectEpoch: myEpoch
      });
      return { kind: "stale" };
    }
    if (myEpoch !== this.connectEpoch) {
      try {
        (handle as MessageProviderOperations).close();
      } catch {
        // ignore
      }
      emitLog(this.cfg.logger, "warn", "appmsg.connect.stale_after_commit_check", {
        ownerPublicKeyHex,
        providerId: provider.id,
        connectEpoch: myEpoch,
        currentConnectEpoch: this.connectEpoch
      });
      return { kind: "stale" };
    }

    // 6. 正式提交。
    this.boundHandle = handle as MessageProviderOperations;
    this.currentBoundOwner = ownerPublicKeyHex;
    this.currentBoundOwnerPrivateKeyHex = signer.privateKeyHex;
    this.currentProviderId = provider.id;
    this.lastErrorMessageValue = null;
    this.nextReconnectAtMsValue = null;
    emitLog(this.cfg.logger, "info", "appmsg.connect.bound", {
      ownerPublicKeyHex,
      providerId: provider.id,
      connectEpoch: myEpoch,
      elapsedMs: Date.now() - connectStartedAt
    });

    this.attachHandleCloseHook(this.boundHandle);
    this.reattachUnfilteredSubscriptions();

    void this.triggerSync("background").catch(() => undefined);
    this.fireStateChange();
    return { kind: "connected" };
  }

  markStructurallyOffline(): void {
    const previousOwnerPublicKeyHex = this.currentBoundOwner;
    const previousProviderId = this.currentProviderId;
    const hadHandle = this.boundHandle !== null;
    const hadLocalDb = this.localHandle !== null || this.localOps !== null;
    emitLog(this.cfg.logger, "info", "appmsg.connect.structurally_offline.begin", {
      previousOwnerPublicKeyHex,
      previousProviderId,
      hadHandle,
      hadLocalDb,
      previousConnectEpoch: this.connectEpoch
    });
    this.connectEpoch += 1;
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
    this.currentBoundOwner = null;
    this.currentBoundOwnerPrivateKeyHex = null;
    this.currentProviderId = null;
    this.lastErrorMessageValue = null;
    this.nextReconnectAtMsValue = null;
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
    emitLog(this.cfg.logger, "info", "appmsg.connect.structurally_offline.done", {
      currentConnectEpoch: this.connectEpoch
    });
    this.fireStateChange();
  }

  private attachHandleCloseHook(handle: MessageProviderOperations): void {
    if (this.handleCloseOff) {
      try {
        this.handleCloseOff();
      } catch {
        // ignore
      }
      this.handleCloseOff = null;
    }
    const closeAwareHandle = handle as MessageProviderOperations & {
      onClose?: (h: () => void) => () => void;
    };
    if (typeof closeAwareHandle.onClose === "function") {
      emitLog(this.cfg.logger, "info", "appmsg.connect.handle_close_hook.attached", {
        mode: "native_onClose",
        ownerPublicKeyHex: this.currentBoundOwner,
        providerId: this.currentProviderId
      });
      const off = closeAwareHandle.onClose(() => this.handleGoneAfterBound());
      this.handleCloseOff = () => {
        try {
          off();
        } catch {
          // ignore
        }
      };
      return;
    }
    emitLog(this.cfg.logger, "info", "appmsg.connect.handle_close_hook.attached", {
      mode: "polling",
      ownerPublicKeyHex: this.currentBoundOwner,
      providerId: this.currentProviderId,
      pollIntervalMs: 1000
    });
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

  private handleGoneAfterBound(): void {
    const currentState = this.boundHandle?.state() ?? null;
    emitLog(this.cfg.logger, "warn", "appmsg.connect.handle_gone_detected", {
      ownerPublicKeyHex: this.currentBoundOwner,
      providerId: this.currentProviderId,
      handleState: currentState
    });
    if (this.boundHandle && currentState !== "bound") {
      this.boundHandle = null;
      this.lastErrorMessageValue = "connection closed by remote";
      emitLog(this.cfg.logger, "warn", "appmsg.connect.handle_gone_committed", {
        ownerPublicKeyHex: this.currentBoundOwner,
        providerId: this.currentProviderId,
        handleState: currentState
      });
      this.fireStateChange();
    }
  }

  async disconnect(): Promise<void> {
    emitLog(this.cfg.logger, "info", "appmsg.connect.disconnect.requested", {
      ownerPublicKeyHex: this.currentBoundOwner,
      providerId: this.currentProviderId,
      hadHandle: this.boundHandle !== null,
      hadLocalDb: this.localHandle !== null || this.localOps !== null
    });
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
    this.currentBoundOwnerPrivateKeyHex = null;
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
      emitLog(this.cfg.logger, "warn", "appmsg.local_db.open.rejected_owner_mismatch", {
        requestedOwnerPublicKeyHex: input.publicKeyHex,
        currentOwnerPublicKeyHex: this.currentBoundOwner
      });
      return null;
    }
    const startedAt = Date.now();
    emitLog(this.cfg.logger, "info", "appmsg.local_db.open.begin", {
      publicKeyHex: input.publicKeyHex
    });
    const opened = await openAppMsgLocalDb({
      keyspace: this.cfg.keyspace,
      publicKeyHex: input.publicKeyHex
    });
    if (!opened) {
      emitLog(this.cfg.logger, "warn", "appmsg.local_db.open.unavailable", {
        publicKeyHex: input.publicKeyHex,
        elapsedMs: Date.now() - startedAt
      });
      return null;
    }
    this.localHandle = opened.handle;
    this.localOps = createAppMsgLocalDbOps(opened.handle);
    emitLog(this.cfg.logger, "info", "appmsg.local_db.open.done", {
      publicKeyHex: input.publicKeyHex,
      elapsedMs: Date.now() - startedAt
    });
    return opened.handle;
  }

  private async openLocalDbForOwner(publicKeyHex: string): Promise<void> {
    const startedAt = Date.now();
    emitLog(this.cfg.logger, "info", "appmsg.local_db.owner_open.begin", {
      publicKeyHex
    });
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
      emitLog(this.cfg.logger, "warn", "appmsg.local_db.owner_open.unavailable", {
        publicKeyHex,
        elapsedMs: Date.now() - startedAt
      });
      return;
    }
    this.localHandle = opened.handle;
    this.localOps = createAppMsgLocalDbOps(opened.handle);
    emitLog(this.cfg.logger, "info", "appmsg.local_db.owner_open.done", {
      publicKeyHex,
      elapsedMs: Date.now() - startedAt
    });
  }

  inspectLocalDb(): AppMsgLocalDbSnapshot {
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

  setNextReconnectAtMs(value: number | null): void {
    const normalized =
      typeof value === "number" && Number.isFinite(value) ? value : null;
    if (this.nextReconnectAtMsValue === normalized) return;
    emitLog(this.cfg.logger, "info", "appmsg.connect.next_reconnect.updated", {
      previousNextReconnectAtMs: this.nextReconnectAtMsValue,
      nextReconnectAtMs: normalized,
      ownerPublicKeyHex: this.currentBoundOwner,
      providerId: this.currentProviderId
    });
    this.nextReconnectAtMsValue = normalized;
    this.fireStateChange();
  }

  getNextReconnectAtMs(): number | null {
    return this.nextReconnectAtMsValue;
  }

  /* ====== seal / open helpers（platform internal） ============== */

  /**
   * 把入站 sealed record 解密 + 验签后翻译为公开 `AppMsgMessage`。
   *
   * 关键约束：
   *   - 必须**先 verify 后 decrypt**——任何一步失败都 fail-closed；
   *   - 用当前 bound owner 的私钥做 recipient 端解密（`static-static ECDH`）
   *     ——如果 envelope 真值里的 recipientPublicKeyBytes 与当前 bound
   *     owner 的公钥不匹配，open 会直接失败（验签 / 解密任一步都不会
   *     通过）；
   *   - 失败一律 swallow 到调用方——调用方（inbound handler / list / get）
   *     记录英文日志并继续处理其它记录。
   *
   * 公开原因：endpoint service impl 需要在 provider.subscribe handler
   * 里解 sealed record → public message；同文件内访问即可。
   */
  openSealedToMessage(rec: ProviderSealedMessageRecord): AppMsgMessage | null {
    const ownerPriv = this.currentBoundOwnerPrivateKeyHex;
    if (!ownerPriv) {
      return null;
    }
    let opened;
    try {
      opened = openAppMessage({
        signed: rec.envelope,
        recipientPrivateKeyHex: ownerPriv
      });
    } catch (err) {
      const reason =
        err instanceof AppMsgCryptoError
          ? err.reason
          : err instanceof Error
            ? "decrypt_failed"
            : "decrypt_failed";
      emitLog(this.cfg.logger, "warn", "appmsg.inbound.crypto.failed", {
        reason,
        messageId: rec.messageId,
        err: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
    const bodyStr = new TextDecoder("utf-8", { fatal: true }).decode(opened.bodyUtf8);
    const out: AppMsgMessage = {
      messageId: rec.messageId,
      clientMessageId: opened.clientMessageId,
      senderPublicKeyHex: opened.senderPublicKeyHex,
      recipientPublicKeyHex: opened.recipientPublicKeyHex,
      contentType: opened.contentType,
      body: bodyStr,
      createdAtMs: opened.createdAtMs,
      insertedAtMs: rec.insertedAtMs
    };
    if (opened.senderEndpointKind === "origin") out.senderOrigin = opened.senderEndpointId;
    else if (opened.senderEndpointKind === "plugin") out.senderAppId = opened.senderEndpointId;
    if (opened.recipientEndpointKind === "origin") out.recipientOrigin = opened.recipientEndpointId;
    else if (opened.recipientEndpointKind === "plugin")
      out.recipientAppId = opened.recipientEndpointId;
    return out;
  }

  /** 把公开 send input + sender projection 翻译为 sealed record。 */
  private sealSendInput(input: {
    sender: AppMsgSenderProjection;
    recipient: { recipientPublicKeyHex: string; recipientOrigin?: string; recipientAppId?: string };
    contentType: AppMsgContentType;
    body: string;
    clientMessageId: string;
    createdAtMs: number;
  }): { record: ProviderSealedMessageRecord } | { error: string } {
    const ownerPub = this.currentBoundOwner;
    const ownerPriv = this.currentBoundOwnerPrivateKeyHex;
    if (!ownerPub || !ownerPriv) {
      return { error: "appmsg.core: not_ready (no current owner / private key)" };
    }
    const senderEp = senderEndpointFor(input.sender);
    const recipientEp = recipientEndpointFor(input.recipient);
    if (senderEp.kind !== "origin" && senderEp.kind !== "plugin") {
      return { error: "appmsg.core: senderEndpointKind invalid" };
    }
    if (recipientEp.kind !== "origin" && recipientEp.kind !== "plugin") {
      return { error: "appmsg.core: recipientEndpointKind invalid" };
    }
    if (!input.recipient.recipientPublicKeyHex) {
      return { error: "appmsg.core: recipientPublicKeyHex required" };
    }
    if (input.contentType !== "text/plain" && input.contentType !== "text/markdown") {
      return { error: "appmsg.core: invalid contentType" };
    }
    if (typeof input.body !== "string" || input.body.length === 0) {
      return { error: "appmsg.core: body must be non-empty" };
    }
    if (!input.clientMessageId) {
      return { error: "appmsg.core: clientMessageId required" };
    }
    try {
      const sealed = sealAppMessage({
        senderPrivateKeyHex: ownerPriv,
        senderPublicKeyHex: ownerPub,
        recipientPublicKeyHex: input.recipient.recipientPublicKeyHex,
        senderEndpoint: senderEp,
        recipientEndpoint: recipientEp,
        contentType: input.contentType,
        body: input.body,
        clientMessageId: input.clientMessageId,
        createdAtMs: input.createdAtMs
      });
      return {
        record: {
          messageId: "", // 由 HubMsg 服务端在 send 成功后分配
          senderPublicKeyHex: ownerPub,
          senderEndpointId: senderEp.id,
          senderEndpointKind: senderEp.kind,
          recipientPublicKeyHex: input.recipient.recipientPublicKeyHex,
          recipientEndpointId: recipientEp.id,
          recipientEndpointKind: recipientEp.kind,
          clientMessageId: input.clientMessageId,
          createdAtMs: input.createdAtMs,
          insertedAtMs: input.createdAtMs,
          envelope: sealed.envelope
        }
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /* ====== Endpoint service 内部调用 ============== */

  async sendMessageImpl(
    handle: MessageProviderOperations,
    sender: AppMsgSenderProjection,
    input: AppMsgSendInput
  ): Promise<AppMsgSendResult> {
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

    const sealed = this.sealSendInput({
      sender,
      recipient: {
        recipientPublicKeyHex: input.recipientPublicKeyHex,
        recipientOrigin: input.recipientOrigin,
        recipientAppId: input.recipientAppId
      },
      contentType: input.contentType,
      body: input.body,
      clientMessageId: input.clientMessageId,
      createdAtMs: input.createdAtMs
    });
    if ("error" in sealed) {
      throw new Error(sealed.error);
    }
    let res: { messageId: string; insertedAtMs: number };
    try {
      res = await handle.sendMessage({ record: sealed.record });
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

    // self-send：sender == recipient at endpoint；本地 DB 写一份明文投影。
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
          insertedAtMs: res.insertedAtMs
        });
        this.lastInsertedAtMsValue = Date.now();
      } catch (err) {
        this.lastErrorMessageValue = err instanceof Error ? err.message : String(err);
      }
    }
    return { messageId: res.messageId, createdAtMs: input.createdAtMs };
  }

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
      const out: AppMsgMessage[] = [];
      for (const rec of res.items) {
        const m = this.openSealedToMessage(rec);
        if (!m) continue;
        out.push(m);
        // 同步路径把解密后的明文投影写本地库（best-effort）。
        if (this.localOps && this.currentProviderId) {
          try {
            await this.localOps.putMessage(this.currentProviderId, m);
            this.lastInsertedAtMsValue = Date.now();
          } catch (err) {
            emitLog(this.cfg.logger, "warn", "appmsg.local.put.failed", {
              err: err instanceof Error ? err.message : String(err),
              messageId: m.messageId
            });
          }
        }
      }
      return { items: out, hasMore: res.hasMore };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      return { items: [], hasMore: false };
    }
  }

  async getMessageImpl(
    handle: MessageProviderOperations,
    ownerPublicKeyHex: string,
    endpoint: AppMsgEndpointId,
    input: AppMsgGetInput
  ): Promise<AppMsgMessage | null> {
    try {
      const rec = await handle.getMessage({
        ownerPublicKeyHex,
        scopeEndpoint: endpoint,
        messageId: input.messageId
      });
      if (!rec) return null;
      const m = this.openSealedToMessage(rec);
      if (!m) return null;
      if (this.localOps && this.currentProviderId) {
        try {
          await this.localOps.putMessage(this.currentProviderId, m);
          this.lastInsertedAtMsValue = Date.now();
        } catch (err) {
          emitLog(this.cfg.logger, "warn", "appmsg.local.put.failed", {
            err: err instanceof Error ? err.message : String(err),
            messageId: m.messageId
          });
        }
      }
      return m;
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
    this.currentUnfilteredOff = this.boundHandle.subscribeMessages((rec) => {
      const m = this.openSealedToMessage(rec);
      if (!m) return;
      if (this.localOps && this.currentProviderId) {
        try {
          awaitPromise(
            this.localOps.putMessage(this.currentProviderId, m).then(() => {
              this.lastInsertedAtMsValue = Date.now();
              this.recordTargetLastReceived(m);
            })
          ).catch((err) => {
            this.lastErrorMessageValue =
              err instanceof Error ? err.message : String(err);
            emitLog(this.cfg.logger, "warn", "appmsg.local.put.failed", {
              err: this.lastErrorMessageValue,
              messageId: m.messageId
            });
          });
        } catch (err) {
          this.lastErrorMessageValue = err instanceof Error ? err.message : String(err);
        }
      }
      for (const h of this.unfilteredSubs) {
        try {
          h(m);
        } catch {
          // ignore
        }
      }
      void this.triggerSync("background").catch(() => undefined);
      emitLog(this.cfg.logger, "info", "appmsg.receive.pushed", {
        messageId: m.messageId,
        clientMessageId: m.clientMessageId,
        contentType: m.contentType,
        bodyBytes: m.body.length
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

  async triggerSync(mode: "manual" | "background" = "manual"): Promise<void> {
    const manual = mode === "manual";
    if (manual) {
      emitLog(this.cfg.logger, "info", "appmsg.sync.manual.requested", {
        state: this.inspectLocalDb().state,
        ownerPublicKeyHex: this.currentBoundOwner,
        providerId: this.currentProviderId
      });
    }
    if (this.syncInFlight) {
      if (manual) {
        emitLog(this.cfg.logger, "info", "appmsg.sync.manual.join_existing", {
          ownerPublicKeyHex: this.currentBoundOwner,
          providerId: this.currentProviderId
        });
      }
      await this.syncInFlight.catch(() => {
        // ignore
      });
    }
    if (
      !this.currentBoundOwner ||
      !this.currentProviderId ||
      !this.boundHandle ||
      !this.localOps
    ) {
      if (!manual) return;
      const msg = "appmsg.sync: not_connected";
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "warn", "appmsg.sync.manual.skipped_not_connected", {
        state: this.inspectLocalDb().state,
        ownerPublicKeyHex: this.currentBoundOwner,
        providerId: this.currentProviderId,
        hasHandle: this.boundHandle !== null,
        hasLocalDb: this.localOps !== null
      });
      this.fireStateChange();
      throw new Error(msg);
    }
    this.syncInFlight = this.doSync();
    try {
      await this.syncInFlight;
      if (manual) {
        emitLog(this.cfg.logger, "info", "appmsg.sync.manual.completed", {
          ownerPublicKeyHex: this.currentBoundOwner,
          providerId: this.currentProviderId
        });
      }
    } catch (err) {
      if (manual) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastErrorMessageValue = msg;
        emitLog(this.cfg.logger, "error", "appmsg.sync.manual.failed", {
          ownerPublicKeyHex: this.currentBoundOwner,
          providerId: this.currentProviderId,
          err: msg
        });
        this.fireStateChange();
      }
      throw err;
    } finally {
      this.syncInFlight = null;
    }
  }

  private async doSync(): Promise<void> {
    if (
      !this.currentBoundOwner ||
      !this.currentProviderId ||
      !this.boundHandle ||
      !this.localOps
    ) {
      emitLog(this.cfg.logger, "warn", "appmsg.sync.skipped_missing_runtime", {
        ownerPublicKeyHex: this.currentBoundOwner,
        providerId: this.currentProviderId,
        hasHandle: this.boundHandle !== null,
        hasLocalDb: this.localOps !== null
      });
      return;
    }
    const startedAt = Date.now();
    try {
      const scopes = await this.collectKnownScopes();
      emitLog(this.cfg.logger, "info", "appmsg.sync.begin", {
        ownerPublicKeyHex: this.currentBoundOwner,
        providerId: this.currentProviderId,
        scopeCount: scopes.length
      });
      if (scopes.length === 0) {
        emitLog(this.cfg.logger, "info", "appmsg.sync.skipped_no_scopes", {
          ownerPublicKeyHex: this.currentBoundOwner,
          providerId: this.currentProviderId,
          elapsedMs: Date.now() - startedAt
        });
        return;
      }
      const outcomes = await syncAllScopes({
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
        },
        openSealed: (rec) => this.openSealedToMessage(rec),
        logger: this.cfg.logger
      });
      const okCount = outcomes.filter((item) => item.ok).length;
      const failCount = outcomes.length - okCount;
      const written = outcomes.reduce((sum, item) => sum + item.written, 0);
      emitLog(this.cfg.logger, "info", "appmsg.sync.completed", {
        ownerPublicKeyHex: this.currentBoundOwner,
        providerId: this.currentProviderId,
        scopeCount: outcomes.length,
        okCount,
        failCount,
        written,
        elapsedMs: Date.now() - startedAt
      });
    } catch (err) {
      emitLog(this.cfg.logger, "error", "appmsg.sync.failed", {
        ownerPublicKeyHex: this.currentBoundOwner,
        providerId: this.currentProviderId,
        elapsedMs: Date.now() - startedAt,
        err: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  }

  private async collectKnownScopes(): Promise<Array<{ kind: "origin" | "plugin"; id: string }>> {
    const startedAt = Date.now();
    const out: Array<{ kind: "origin" | "plugin"; id: string }> = [];
    out.push({ kind: "plugin", id: KEYMASTER_MESSAGE_APP_ID });
    let loadedTargetCount = 0;
    if (this.localOps && this.currentProviderId) {
      try {
        const tids = await this.localOps.listTargetIds(this.currentProviderId);
        loadedTargetCount = tids.length;
        for (const t of tids) {
          if (t.startsWith("origin:")) {
            out.push({ kind: "origin", id: t.slice("origin:".length) });
          } else if (t.startsWith("appId:")) {
            out.push({ kind: "plugin", id: t.slice("appId:".length) });
          }
        }
      } catch (err) {
        emitLog(this.cfg.logger, "warn", "appmsg.sync.collect_scopes.list_target_ids_failed", {
          providerId: this.currentProviderId,
          ownerPublicKeyHex: this.currentBoundOwner,
          elapsedMs: Date.now() - startedAt,
          err: err instanceof Error ? err.message : String(err)
        });
      }
    }
    const uniqueKeys = new Set(out.map((item) => `${item.kind}:${item.id}`));
    let originCount = 0;
    let pluginCount = 0;
    for (const key of uniqueKeys) {
      if (key.startsWith("origin:")) originCount += 1;
      else pluginCount += 1;
    }
    emitLog(this.cfg.logger, "info", "appmsg.sync.collect_scopes.done", {
      providerId: this.currentProviderId,
      ownerPublicKeyHex: this.currentBoundOwner,
      loadedTargetCount,
      scopeCount: out.length,
      uniqueScopeCount: uniqueKeys.size,
      originCount,
      pluginCount,
      elapsedMs: Date.now() - startedAt
    });
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

  private fireStateChange(): void {
    const snap = this.inspectLocalDb();
    emitLog(this.cfg.logger, "info", "appmsg.state.changed", {
      state: snap.state,
      ownerPublicKeyHex: snap.ownerPublicKeyHex,
      lastError: snap.lastError,
      nextReconnectAtMs: snap.nextReconnectAtMs,
      listenerCount: this.stateChangeListeners.size,
      providerId: this.currentProviderId,
      hasHandle: this.boundHandle !== null,
      hasLocalDb: this.localOps !== null
    });
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

/**
 * fire-and-forget promise helper（避免在 sync 推送 handler 内 async）。
 */
function awaitPromise(p: Promise<unknown>): Promise<void> {
  return p.then(
    () => undefined,
    () => undefined
  );
}

// 防止 IDE 报 unused
void ({} as AppMsgAddress);
void ({} as ProviderOnlineResult);
void ({} as ProviderSenderProjection);
void bytesToHex;
void hexToBytes;
void readEnvelopeRoute;
