// packages/contracts/src/broadcast.ts
// 广播子系统契约（施工单 2026-07-06 001 硬切换）。
//
// 设计缘由：
//   - 广播**不是**消息：不做本地 DB、不做补同步、不做 endpoint 路由、
//     不做 scope ACL、不做 box、不做 sender projection；
//   - 广播只解决"当前在线连接向某个频道发布签名报文，服务器扇出
//     给当前订阅该频道的连接"——纯在线 fanout；
//   - 广播 core 是平台逻辑中心：owner 真值 / active provider / 多订阅
//     者 union 聚合 / 验签分发 / 固定延迟重连——浏览器端统一收口；
//   - plugin-hubcast 只是 HubCast 服务对应的 provider 实现，**不**兼做
//     core；core 与 provider 之间通过 `BroadcastProvider` /
//         `BroadcastProviderRegistry` 契约解耦；
//   - 业务插件只通过 `BroadcastCore` 公开 facade 访问：publish /
//     subscribe / listSubscribedChannels；**不**直接接触 wire 或
//     provider；
//   - 频道 `channelId` 是 exact string；不允许 wildcard / prefix 订阅；
//   - `protocolId` 是独立字段；广播系统**不**解释 body。
//
// 字段组织：
//   - capability key：`broadcast.core` / `broadcast.provider.registry`；
//   - 公开模型：`BroadcastMessage` / `BroadcastPublishInput` /
//     `BroadcastSubscribeInput` / `BroadcastCore`；
//   - provider 契约：`BroadcastProvider` / `BroadcastProviderOperations`
//     / `BroadcastProviderRegistry` / `BroadcastProviderHealth`；
//   - wire 常量：`HUBCAST_METHOD` / `HUBCAST_EVENT` / `HubCastEnvelopeV1`
//     / `SignedHubCastEnvelopeV1`。
//
// 与 appmsg 的硬边界：
//   - 本文件**不** import `./appmsg.js`；不共享 envelope / sealed record；
//   - 不复用 `MessageProvider` / `MessageProviderRegistry`；
//   - 不复用 `appmsg.endpoint.registry` / `appmsg.core` / `appmsg.bind`
//     等任何 appmsg 真值。

/* ============== capability key ============== */

/**
 * 广播 core capability key（由 plugin-broadcast 在 setup 阶段 provide）。
 * 业务插件通过 `ctx.get("broadcast.core")` 拿到 `BroadcastCore` 单例。
 */
export const BROADCAST_CORE_CAPABILITY = "broadcast.core";

/**
 * 广播 provider 注册表 capability key（由 plugin-broadcast 在 setup 阶段
 * provide）。provider 插件（plugin-hubcast）在自己 setup 阶段
 * `registry.register(...)`。
 *
 * 设计缘由：provider 注册表真值由系统中心持有，**不**归 provider 自己
 * 拥有——避免多 provider 抢注册表真值。
 */
export const BROADCAST_PROVIDER_REGISTRY_CAPABILITY = "broadcast.provider.registry";

/* ============== 公开模型 ============== */

/**
 * 广播发布入参（业务插件 → core）。
 *
 * 关键约束（施工单 §5.2）：
 *   - **不**允许业务方传 `publisherPublicKeyHex` / 签名——这些由 core
 *     按当前 owner 真值补齐并签名；
 *   - `channelId` 是 exact string；core 不做 wildcard / prefix 匹配；
 *   - `protocolId` 独立字段，广播系统**不**解释；body 由业务方自己
 *     序列化；
 *   - `bodyBytes` 是 opaque bytes；广播系统不做 JSON / schema 校验。
 */
export interface BroadcastPublishInput {
  /** exact channel id；订阅方按 exact string 匹配。 */
  channelId: string;
  /** 业务协议 id；用于业务层识别 body 解释规则。 */
  protocolId: string;
  /** 业务方幂等键；广播系统不持久化它，仅做 wire 透传。 */
  clientMessageId: string;
  /** 业务方声明的创建时间（unix milliseconds）。 */
  createdAtMs: number;
  /** 业务 body opaque bytes。 */
  bodyBytes: Uint8Array;
}

/**
 * 广播发布成功结果。
 *
 * 关键约束：
 *   - `publisherPublicKeyHex` 由 core 注入（来自当前 owner）；
 *   - `signatureBytes` 由 core 注入；
 *   - 业务插件**不**看到 `envelopeBytes` / 签名中间态。
 */
export interface BroadcastMessage {
  /** exact channel id。 */
  channelId: string;
  /** 业务协议 id。 */
  protocolId: string;
  /** 业务方幂等键。 */
  clientMessageId: string;
  /** 业务方声明的创建时间（unix milliseconds）。 */
  createdAtMs: number;
  /** 业务 body opaque bytes。 */
  bodyBytes: Uint8Array;
  /** core 按当前 owner 真值补齐的 publisher 公钥 hex。 */
  publisherPublicKeyHex: string;
}

/**
 * 广播订阅入参（业务插件 → core）。
 *
 * 关键约束（施工单 §5.3）：
 *   - 一个订阅句柄声明自己关注一组 exact channel；
 *   - core 维护所有订阅句柄的 union，下推给远端；
 *   - 远端**不**知道本地有几个业务订阅者——它只看到 union。
 */
export interface BroadcastSubscribeInput {
  /** 业务方要订阅的 exact channel id 列表；空数组视为取消该 handler 的所有订阅。 */
  channelIds: readonly string[];
  /**
   * 收到匹配的广播时回调。
   *
   * 注意：core 已经完成 verify；`channelId` 前缀与 publisher 一致性由
   * provider 服务端（例如 HubCast）在 publish 阶段强制——属于 provider
   * / 服务端契约，不属于 broadcast core provider-generic 抽象。handler
   * 拿到的是标准化 `BroadcastMessage`，**不**接触 envelope 字节。
   */
  handler: (msg: BroadcastMessage) => void;
}

/**
 * 订阅句柄返回值：调用即取消该订阅。
 */
export type BroadcastUnsubscribe = () => void;

/* ============== provider 句柄输入 / 输出形状 ============== */

/**
 * provider publish 入参（core → provider）。
 *
 * 设计缘由：
 *   - `envelopeBytes` 已经是 deterministic CBOR envelope 真值字节；
 *   - `signatureBytes` 是 core 已经完成 secp256k1 compact 64-byte 签名；
 *   - provider **不**重新解释 envelope 字段（不读 channelId / protocolId /
 *     body）；它只把两个字节数组上传给服务端。
 *   - 这样 provider 不接触业务字段，**不**做业务层校验。
 */
export interface ProviderPublishInput {
  envelopeBytes: Uint8Array;
  signatureBytes: Uint8Array;
}

/**
 * provider replaceSubscriptions 入参：全量替换当前连接的订阅集合。
 */
export interface ProviderReplaceSubscriptionsInput {
  /** exact channel id 列表。空数组 = 清空订阅。 */
  channelIds: readonly string[];
}

/** provider listSubscriptions 结果。 */
export interface ProviderListSubscriptionsResult {
  channelIds: readonly string[];
}

/**
 * provider 推送事件回调入参（provider → core）。
 *
 * 设计缘由：
 *   - provider 内部完成 wire → 标准化 record 翻译；
 *   - core 拿到 `envelopeBytes` + `signatureBytes` 后负责 verify；
 *   - 这里**不**暴露 wire 元数据（eventId / requestId / 方法名）；
 *   - v1 服务端在 fanout 时**不**附带时戳——本事件只携带 envelope 真值
 *     字节 + 签名。
 */
export interface ProviderBroadcastEvent {
  envelopeBytes: Uint8Array;
  signatureBytes: Uint8Array;
}

/* ============== provider 契约 ============== */

/**
 * Provider 连接健康快照。
 *
 * 与 MessageProviderHealth 同构：core 在每次状态切换时维护一份；
 * `broadcast.core` 不暴露 `health()`（施工单 §3 / §4.1 未要求）；
 * 保留类型是为以后管理页 / 诊断使用。
 */
export interface BroadcastProviderHealth {
  /** 当前是否可用（最近一次 connect 成功且 handle 未关闭）。 */
  isHealthy: boolean;
  /** 最近一次错误 message；无错误时为 null。 */
  lastError: string | null;
  /** 最近一次成功连接时间（unix ms；0 = 从未）。 */
  lastConnectedAtMs: number;
}

/**
 * 一个 broadcast provider（plugin-hubcast / 未来第二个 provider）。
 *
 * 设计缘由：
 *   - 与 `MessageProvider` 同构，但**不**共享类型——provider 业务
 *     完全不同；
 *   - `bind(signer)` 是 connection-level 操作：每次 owner 真值变化 /
 *     active provider 切换都要重新 bind；
 *   - 本接口**不**持有 owner / vault / active key 真值——这些由
 *     plugin-broadcast core 持有；provider 通过 `BroadcastProviderSigner`
 *     闭包借 owner 私钥。
 */
export interface BroadcastProvider {
  /** Provider 唯一 id（plugin-hubcast 提供时是 `"hubcast"`）。 */
  readonly id: string;
  /** 人类可读名字（未来管理页展示用）。 */
  readonly displayName: string;
  /**
   * 借 owner signer 建立一条连接 + bind。
   *
   * 失败语义：
   *   - signer 不可用 / connect 失败 / bind 失败：reject；
   *   - 同一 provider 多次 bind：第二次应先 close 旧 handle，再返回新的
   *     handle（实现层保证）。
   */
  bind(input: { signer: BroadcastProviderSigner }): Promise<BroadcastProviderHandle>;
  /** 关闭 provider 当前持有的 handle；幂等。 */
  shutdown(): Promise<void>;
  /**
   * Provider 健康快照。
   *
   * 失败语义：**不**抛错；调用失败时返回
   * `{ isHealthy: false, lastError, lastConnectedAtMs: 0 }`。
   */
  health(): BroadcastProviderHealth;
}

/**
 * bind 后由 provider 返回的连接句柄。
 *
 * 设计缘由：
 *   - 与 `MessageProviderHandle` / `MessageProviderOperations` 同构风格：
 *     typed 业务方法在 handle 上，不在 provider 上；
 *   - provider 本身**不**持有连接真值，它只是工厂。
 */
export interface BroadcastProviderHandle {
  /** 当前连接状态。 */
  state(): BroadcastProviderState;
  /** 关闭这个 handle；幂等。 */
  close(): void;
}

/** Provider 连接状态。 */
export type BroadcastProviderState = "idle" | "connecting" | "bound" | "closed";

/**
 * 给 provider 用的 owner signer 抽象（由 plugin-broadcast core 提供）。
 *
 * 设计缘由（与 `ProviderSigner` 同构）：
 *   - provider **不**直接拿 owner 私钥；
 *   - signer 是通用原语：`signChallenge({challenge})` 接受任意字节
 *     数组并返回 hex 签名；
 *   - 当前平台 vault 持有 secp256k1 私钥，signer 内部走
 *     `SHA-256(challenge) + secp256k1 compact 64-byte`。
 */
export interface BroadcastProviderSigner {
  publicKeyHex: string;
  /**
   * 用 owner 私钥对 `challenge` 字节做 secp256k1 (SHA-256 + compact
   * 64-byte) 签名，返回小写 hex。
   */
  signChallenge(args: { challenge: Uint8Array }): Promise<string>;
}

/**
 * 给 `BroadcastProviderHandle` 加上的业务方法扩展。
 *
 * 设计缘由：
 *   - `BroadcastProviderHandle` 只描述"如何关闭 / 看状态"这种
 *     provider-neutral 行为；
 *   - 具体的"发布 / 订阅 / 远端断线"是 provider 业务层行为；
 *   - `BroadcastProvider.bind()` 在返回值上**直接**返回复合类型。
 */
export interface BroadcastProviderOperations extends BroadcastProviderHandle {
  /**
   * 发布一条广播。
   *
   * v1 服务端 success 路径返回空数组——resolve 即视为服务端已接受本次
   * 提交，**不**回包任何业务字段。
   */
  publish(input: ProviderPublishInput): Promise<void>;
  /**
   * 全量替换当前连接的订阅集合。
   *
   * 关键约束（施工单 §7.2）：
   *   - **不**做 `subscribeChannel(...)` / `unsubscribeChannel(...)`
   *     增量接口；本地 union 变更由 core 内部计算后下推；
   *   - 服务端拒收 channelId 时 reject，core 应回退本地 union。
   *
   * v1 服务端 success 路径**不**回包确认后的 channel 列表——resolve 即
   * 表示服务端已接受本次提交；core 按本地 union 继续推进。
   */
  replaceSubscriptions(
    input: ProviderReplaceSubscriptionsInput
  ): Promise<void>;
  /** 列出服务端确认的当前连接订阅集合。 */
  listSubscriptions(): Promise<ProviderListSubscriptionsResult>;
  /**
   * 订阅服务端推送广播。
   *
   * handler 收到 `ProviderBroadcastEvent`；core 在 verify → 本地 union
   * 匹配后才分发给业务订阅者。`channelId` 前缀与 publisher 一致性由
   * provider 服务端（例如 HubCast）在 publish 阶段强制——属于 provider
   * / 服务端契约，core 不重复。
   * 返回取消订阅函数。
   */
  subscribeBroadcasts(handler: (ev: ProviderBroadcastEvent) => void): BroadcastUnsubscribe;
  /** 订阅远端断线事件。 */
  onClose(handler: () => void): BroadcastUnsubscribe;
}

/* ============== 当前 active provider 快照 ============== */

/**
 * 当前 active broadcast provider 的状态快照。
 *
 * `providerId === null` 表示"系统未选择广播服务"——此时 core 应进入
 * not-ready 状态，业务 publish / subscribe 调用应 reject with
 * `not_ready` / resolve with empty。
 */
export interface ActiveBroadcastProviderSnapshot {
  providerId: string | null;
  displayName: string | null;
  isHealthy: boolean;
  lastError: string | null;
}

/* ============== provider 注册表 ============== */

/**
 * Broadcast provider 注册表（plugin-broadcast 持有唯一实例并 provide）。
 *
 * 设计缘由：
 *   - 注册表**不**归 provider 自己拥有——必须由系统中心持有；
 *   - 同一 provider id 重复注册：抛错；
 *   - `setActive(id)` 触发 core 内部重新 bind；本注册表**不**持有
 *     连接真值。
 *
 * 本注册表与 `MessageProviderRegistry` **不**通用——两个系统的 active
 * provider 是相互独立的真值；同一插件可以同时注册到两个注册表（例
 * 如未来 HubMsg 提供 broadcast 服务），但这里只描述广播语义。
 */
export interface BroadcastProviderRegistry {
  /**
   * 注册一个 provider。
   *
   * 失败语义：重复 id 抛错。
   */
  register(provider: BroadcastProvider): void;
  /** 取消注册；不存在时 no-op。 */
  unregister(providerId: string): void;
  /** 列出全部已注册的 provider。 */
  list(): readonly BroadcastProvider[];
  /**
   * 设置当前 active provider。
   *
   * 失败语义：
   *   - `providerId === null` → 进入 not-ready；
   *   - `providerId` 不在已注册集合里 → 抛错；
   *   - 切换成功 → 通知所有 `onActiveChange` 订阅者，由 core 内部
   *     触发 rebind。
   */
  setActive(providerId: string | null): Promise<void>;
  /** 当前 active provider；未选择时为 null。 */
  active(): BroadcastProvider | null;
  /** 当前 active 快照（不发起任何 IO）。 */
  activeSnapshot(): ActiveBroadcastProviderSnapshot;
  /**
   * 订阅 active provider 变化（setActive 成功 / provider unregister）。
   *
   * handler 在切换 / 卸载完成后被调，**不**在切换过程中被调。
   */
  onActiveChange(handler: (snapshot: ActiveBroadcastProviderSnapshot) => void): BroadcastUnsubscribe;
}

/* ============== BroadcastCore ============== */

/**
 * 广播 core 状态（仅诊断 / 未来管理页使用）。
 */
export type BroadcastCoreState =
  /** 初始态 / 无 active provider / vault locked / 无 active key。 */
  | "idle"
  /** 正在建立 / 重建远端连接。 */
  | "connecting"
  /** 已绑定，可以 publish / subscribe。 */
  | "bound"
  /** 远端断开；core 正在按固定延迟等待重试。 */
  | "closed";

export interface BroadcastConnectionIdentity {
  sessionEpoch: string;
  activePublicKeyHex: string;
  keyspaceGeneration: number;
}

/**
 * Broadcast core 快照（不发起任何 IO）。
 *
 * `nextReconnectAtMs` 语义与 AppMsgLocalDbSnapshot 同构：
 *   - 仅在 `state === "closed"` 且系统正在等待下一次自动重连时为
 *     未来时间戳（unix ms）；
 *   - 其它状态下必须为 `null`；
 *   - core 在 setup 阶段固定持有重试间隔，状态变更时统一写入。
 */
export interface BroadcastCoreSnapshot {
  state: BroadcastCoreState;
  providerId: string | null;
  /** 当前 owner 公钥 hex；非 unlocked 状态为 null。 */
  desiredConnectionOwnerPublicKeyHex: string | null;
  /** 最近一次错误 message；无错误时为 null。 */
  lastError: string | null;
  /** 当前有效订阅 exact channel 列表。 */
  subscribedChannels: readonly string[];
  nextReconnectAtMs: number | null;
}

/**
 * `reconcileOwnerConnection` 的结果分类（与 AppMsgConnectOutcome 同构风格）。
 *
 * 设计缘由：core 在重连循环里需要"成功 / 结构性不可连接 / 可重试
 * 失败 / 过期"四种状态的真值，**不**只写 `lastError` 不抛错。
 */
export type BroadcastConnectOutcome =
  /** bind 成功且提交未被新代次覆盖。 */
  | { kind: "connected" }
  /** 结构性条件不满足（无 provider / 无 signer），不应继续循环。 */
  | {
      kind: "structurallyOffline";
      reason: "no_active_provider" | "no_signer";
    }
  /** bind 抛错或远端拒绝，可重试。协调器会安排固定延迟后再次尝试。 */
  | { kind: "retryableFailure"; reason: string }
  /** core 内部 connectEpoch 自增；结果不应被采用。 */
  | { kind: "stale" };

/**
 * 广播 core（plugin-broadcast 单例）。
 *
 * 设计缘由：
 *   - 与 `AppMsgCore` 同构风格，但**不**共享 endpoint / scope / DB
 *     / 同步 / 在线查询等任何 appmsg 概念；
 *   - 业务插件**唯一**允许消费的入口；
 *   - `publish / subscribe / listSubscribedChannels` 由 core 内部完成
 *     owner 真值切换、active provider 切换、本地 union 重算；
 *   - 本地订阅 union 收口在 core：业务插件**不**能直接拿到 union；
 *   - 不持久化、不补同步、不做频道目录。
 */
export interface BroadcastCore {
  /* ====== provider registry ====== */

  /** 拿当前 provider 注册表。plugin-broadcast 内部持有的同一实例。 */
  providers(): BroadcastProviderRegistry;

  /* ====== 连接管理 ====== */

  /**
   * bind 当前 owner（rebind 当前 active provider）。
   *
   * 失败语义与 Broadcast connection lifecycle 对齐：
   *   - 直接返回 `BroadcastConnectOutcome`；
   *   - `structurallyOffline.reason` 包含 `no_active_provider` /
   *     `no_signer` 两种真值；
   *   - `stale` 来自 core 内部 `connectEpoch` 自增（被同实例另一次
   *     `reconcileOwnerConnection` 抢占）。
   */
  reconcileOwnerConnection(
    identity: BroadcastConnectionIdentity,
    callerEpoch?: number
  ): Promise<BroadcastConnectOutcome>;
  /** 关闭连接；幂等。 */
  disconnect(): Promise<void>;
  /**
   * 把 core 拉到"结构性不可连接"态。
   *
   * 与 `disconnect()` 区别：
   *   - `disconnect()`：纯 IO 关闭，**不**清 `lastError`；
   *   - `markStructurallyOffline()`：清 `lastError` + 清
   *     `nextReconnectAtMs` + 清 `currentBoundOwner` + 抬内部
   *     `connectEpoch`。
   */
  markStructurallyOffline(): void;
  /** 由重连协调器写入下一次自动重连截止时间戳。null = 清空。 */
  setNextReconnectAtMs(value: number | null): void;
  /** 读取当前等待重连截止时间戳（仅诊断）。 */
  getNextReconnectAtMs(): number | null;

  /* ====== 业务 facade ====== */

  /** 当前 core 是否可用（active provider + owner 真实可用 + bound）。 */
  isReady(): boolean;
  /**
   * 发布广播。
   *
   * 失败语义：
   *   - 未就绪：reject with `not_ready`；
   *   - 远端拒绝：reject with 上游错误 message。
   *
   * v1 服务端 publish 成功**不**回包 fanout 时戳——返回的
   * `BroadcastMessage` 不含 `receivedAtMs`。
   */
  publish(input: BroadcastPublishInput): Promise<BroadcastMessage>;
  /**
   * 订阅一组频道。
   *
   * 语义（施工单 §5.3）：
   *   - 一个订阅句柄声明自己关注的一组 exact channel；
   *   - core 维护所有订阅句柄的 union，下推远端 `replaceSubscriptions`；
   *   - 取消订阅后重新计算 union，再下推。
   *
   * 失败语义：
   *   - core 未就绪：handler **不**被调用；返回取消函数；
   *   - 同 channel 被多个订阅句柄订阅：每个 handler 各自收一份。
   */
  subscribe(input: BroadcastSubscribeInput): BroadcastUnsubscribe;
  /**
   * 列出当前有效订阅频道列表。
   *
   * 返回值 = 所有本地订阅句柄 channelIds 的合集（本地期望 union）副本。
   *
   * 不发起任何 IO，不依赖 provider；已连接 / 未连接走同一条路径。
   * core 不单独持有"服务端确认集合"这份真值——`subscription.set`
   * 服务端 success 仅回包 void，本方法不调用 `listSubscriptions`。
   *
   * **不**表示：
   *   - 服务器全局频道目录
   *   - 进程启动以来见过的频道列表
   *   - 某个 publisher 曾经发布过的全部频道
   */
  listSubscribedChannels(): readonly string[];

  /* ====== 状态 ====== */

  /** 当前 core 快照（不发起任何 IO）。 */
  inspect(): BroadcastCoreSnapshot;
  /**
   * 订阅 core 状态变化（owner / provider / 连接状态）。
   *
   * 返回取消订阅函数。
   */
  onConnectionStateChanged(handler: () => void): BroadcastUnsubscribe;

  /* ====== platform internal：当前 handle（仅 core 内部用） ====== */

  /**
   * 当前 bound provider handle（platform internal）。
   *
   * 当前未就绪时返回 null。本字段**不**作为 plugin 公开能力——它
   * 只用于 core 内部把远端推送 → 本地分发。
   */
  currentHandle(): BroadcastProviderOperations | null;
}

/* ============== envelope 真值（platform internal；core 与 provider 共享） ============== */

/**
 * `HubCastEnvelopeV1` 版本号；hard-switch 锁死 v1。
 */
export const HUBCAST_ENVELOPE_VERSION_V1 = 1 as const;

/**
 * HubCast envelope 字段（platform internal）。
 *
 * 关键约束（施工单 §5.1 + §6.4）：
 *   - `envelopeVersion === 1`；
 *   - `channelId` 是 exact string；
 *   - `protocolId` 是独立字段；
 *   - `bodyBytes` 是 opaque bytes；
 *   - `publisherPublicKeyBytes.length === 33`（compressed secp256k1）；
 *   - `clientMessageId` / `createdAtMs` 是 envelope 真值的一部分；
 *   - 签名对象 = `SHA-256(envelopeBytes)` + secp256k1 compact 64-byte。
 *
 * 本结构**仅**由 plugin-broadcast core 解释；plugin-hubcast 与
 * HubCast 服务端只看到 deterministic CBOR 字节。
 *
 * wire 顺序固定（**不**允许重排）——与 HubCast 服务端
 * `HubCastEnvelopeV1` 一一对应：
 *
 *   [envelopeVersion, publisherPublicKey33, channelId, protocolId,
 *    clientMessageId, createdAtMs, bodyBytes]
 */
export interface HubCastEnvelopeV1 {
  envelopeVersion: typeof HUBCAST_ENVELOPE_VERSION_V1;
  /** publisher compressed secp256k1 公钥（33 字节）。wire index 1。 */
  publisherPublicKeyBytes: Uint8Array;
  /** exact channel id。wire index 2。 */
  channelId: string;
  /** 业务协议 id。wire index 3。 */
  protocolId: string;
  /** 业务方幂等键。wire index 4。 */
  clientMessageId: string;
  /** 业务方声明的创建时间（unix milliseconds）。wire index 5。 */
  createdAtMs: number;
  /** 业务 body opaque bytes。wire index 6。 */
  bodyBytes: Uint8Array;
}

/**
 * 永久广播壳（platform internal）：envelope 真值字节 + publisher 签名。
 *
 * 关键约束：
 *   - `signatureBytes.length === 64`（compact secp256k1 r||s）；
 *   - 签名对象是 `envelopeBytes`（deterministic CBOR 真值字节），**不**
 *     是 envelope 重新解析后再编码的字节；
 *   - 收方必须直接对 envelopeBytes 验签。
 */
export interface SignedHubCastEnvelopeV1 {
  envelopeBytes: Uint8Array;
  signatureBytes: Uint8Array;
}

/* ============== v1 RPC method / event 整数 id ============== */

/**
 * v1 RPC method 整数 id（**仅** wire 层使用，**不**暴露给上层）。
 */
export const HUBCAST_METHOD = {
  SubscriptionSet: 1,
  SubscriptionList: 2,
  BroadcastPublish: 3
} as const;

/**
 * v1 server-pushed event 整数 id（**仅** wire 层使用）。
 */
export const HUBCAST_EVENT = {
  BroadcastReceived: 1
} as const;

/* ============== frame body 数组形态（HubCast 专用，与 HubMsg 不通用） ============== */

// HubCast 与 HubMsg 共享 frameKind 整数空间，但 body 形状完全不同——
// 各自走各自的 wire codec。本组类型**只**用于 plugin-hubcast，**不**
// 复用 contracts/appmsg.ts 里的 HubFrame*Body。

/**
 * `server_open` body：[serverVersion, sessionId, issuedAtMs, serverNonce]
 *
 * v1 心跳间隔沿用本地配置——服务端不在 server_open 内协商心跳。
 */
export type HubCastFrameServerOpenBody = readonly [
  serverVersion: string,
  sessionId: string,
  issuedAtMs: number,
  serverNonce: string
];

/**
 * `client_bind` body：[nonce, publicKey (33B raw), issuedAtMs, signature64]
 *
 * publicKey / signature 在 wire 上都是 **raw bytes**——hex 仅用于
 * canonicalBindText 拼接，编码边界统一转 Uint8Array。
 */
export type HubCastFrameClientBindBody = readonly [
  nonce: string,
  publicKey: Uint8Array,
  issuedAtMs: number,
  signature64: Uint8Array
];

/**
 * `bind_ready` body：[ownerPublicKey (33B raw), boundAtMs]
 */
export type HubCastFrameBindReadyBody = readonly [
  ownerPublicKey: Uint8Array,
  boundAtMs: number
];

/**
 * `request` body：[requestId (uint), methodId (uint), paramsBytes]
 *
 * requestId 是 uint64；客户端用 monotonic + random 自行生成。
 */
export type HubCastFrameRequestBody = readonly [
  requestId: number,
  methodId: number,
  paramsBytes: Uint8Array
];

/**
 * `result` body：[requestId (uint), isError (bool), payloadBytes]
 *
 * payloadBytes 在 success 时是方法特定的 result 真值（CBOR 字节），
 * error 时是 `[errorCode, errorMessage]` CBOR 字节。
 */
export type HubCastFrameResultBody = readonly [
  requestId: number,
  isError: boolean,
  payloadBytes: Uint8Array
];

/**
 * `event` body：[eventId (uint), payloadBytes]
 */
export type HubCastFrameEventBody = readonly [eventId: number, payloadBytes: Uint8Array];

/**
 * `close` body：[code (uint), reason (text)]
 */
export type HubCastFrameCloseBody = readonly [code: number, reason: string];

/**
 * `ping` / `pong` body：[nonce (uint)]
 */
export type HubCastFramePingBody = readonly [nonce: number];

/* ============== wire method params / results（platform internal；固定顺序数组） ============== */

/**
 * `broadcast.publish` 入参 wire 形态（platform internal）。
 *
 * 设计缘由：core 在 publish 边界已经完成 sign；HubCast 只持久化 /
 * 转发 `SignedHubCastEnvelopeV1`，不重新解释 envelope 内字段。
 *
 * v1 服务端真值：`[envelopeBytes, signature64]` 二元组。
 */
export type HubCastWirePublishParams = readonly [
  envelopeBytes: Uint8Array,
  signatureBytes: Uint8Array
];

/**
 * `broadcast.publish` 出参 wire 形态。
 *
 * v1 服务端 success 路径返回空数组 `[]`——本字段在客户端只用于校验
 * shape，**不**携带业务数据。
 */
export type HubCastWirePublishResult = readonly [];

/**
 * `subscription.set` 入参 wire 形态。
 *
 * v1 服务端真值：一元数组 `[channelIds]`（**不**是裸 string[]）。
 * 本地 union 变更由 core 内部算好后下推；本接口按"全量替换"语义。
 */
export type HubCastWireSubscriptionSetParams = readonly [
  channelIds: readonly string[]
];

/**
 * `subscription.set` 出参 wire 形态。
 *
 * v1 服务端 success 路径返回空数组 `[]`——resolve 即视为服务端已接
 * 受本次提交；**不**回包确认后的 channel 列表。
 */
export type HubCastWireSubscriptionSetResult = readonly [];

/**
 * `subscription.list` 入参：空数组（无参数）。
 */
export type HubCastWireSubscriptionListParams = readonly [];

/** `subscription.list` 出参：[channelIds...] */
export type HubCastWireSubscriptionListResult = readonly string[];

/**
 * `broadcast.received` event payload wire 形态。
 *
 * v1 服务端 fanout 直接推送原始 `SignedHubCastEnvelopeV1` 二元组——
 * 与 `SignedHubCastEnvelopeV1` 完全同形：
 *
 *   [envelopeBytes, signature64]
 *
 * v1 服务端**不**附带 fanout 时戳；core 拿到这两个字段后负责 verify。
 */
export type HubCastWireBroadcastReceivedEvent = readonly [
  envelopeBytes: Uint8Array,
  signatureBytes: Uint8Array
];

/* ============== 默认值 ============== */

/**
 * 默认重连延迟（施工单 §6.3）。
 *
 * 设计缘由：固定 5 秒；不做指数退避；不做多阶段 backoff；不做 replay
 * journal。断线后回来即可。
 */
export const BROADCAST_DEFAULT_RECONNECT_DELAY_MS = 5_000;

/* ============== active provider 持久化（施工单 2026-07-08 001） ============== */

/**
 * active provider id 持久化的 localStorage key。
 *
 * 设计缘由：
 *   - 走 `localStorage` 而**不**走 IndexedDB，原因：active provider
 *     选择是高频、低体量、单 key 单 value 的系统级配置；localStorage
 *     同步 API 足以承载，避免引入异步路径；
 *   - key 名固定在 contracts；装配层只**读**不**改**该 key 名；
 *   - 该 key 缺失 / 值为 null / 值不是已注册 provider id 时，core 走
 *     "默认值语义"（参见 `BroadcastProviderRegistry.setActive` 文档）。
 */
export const BROADCAST_ACTIVE_PROVIDER_ID_STORAGE_KEY = "keymaster.broadcast.activeProviderId";

/**
 * 持久化的 active provider id 真值类型。
 *
 * 设计缘由：v1 只持久化 id；显示名 / 健康状态每次从 `inspect()` 派生。
 * 持久化"把当前选中的 provider 记下来"，**不**持久化"某 provider 是否
 * 健康"。
 */
export type PersistedBroadcastProviderId = string | null;

/* ============== core 公开扩展（施工单 2026-07-08 001） ============== */

/**
 * BroadcastCore 暴露给管理页 / 业务的扩展能力。
 *
 * 设计缘由：
 *   - v1 把 activeProviderId 的持久化 / 默认值语义统一收到 core；
 *   - 装配层只需 `core.providers()` 注册 provider；core 自己根据
 *     localStorage 持久值 + 默认值 + 显式 `setActive(null)` 决策；
 *   - 管理页直接 `await core.setActiveProviderId("hubcast")` 切换，
 *     core 内部负责落盘 + 触发 rebind。
 */
export interface BroadcastCoreOps {
  /**
   * 切换 active provider。
   *
   * @param providerId 要切换到的 provider id；`null` 显式清空。
   * @returns 设置成功；providerId 不在已注册集合里时 reject。
   *
   * 失败语义：
   *   - `providerId === null` → 当前 active 立即清空；
   *   - `providerId` 不在已注册集合里 → reject。
   *
   * 设置成功 = 持久化已写入 localStorage + core 内 setActive 已完成 +
   * rebind 已被调度（fire-and-forget）。
   */
  setActiveProviderId(providerId: string | null): Promise<void>;
  /**
   * 当前 active provider id；未选择或正等待默认激活时返回 null。
   *
   * 语义与 `inspect().providerId` 一致；本方法是供管理页快速读用。
   */
  getActiveProviderId(): string | null;
}
