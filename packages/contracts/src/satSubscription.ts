// SatSubscription / Channel / SPI 的平台内部契约。
//
// 重要边界：这些类型只给受信任的系统插件使用，不加入 Connect public
// contracts。Connect App 只看到 channel.* 的 JSON API。

/** SatSubscription 平台插件 id。 */
export const SAT_SUBSCRIPTION_PLUGIN_ID = "sat-subscription";
/** SSP trusted capability。 */
export const SAT_SUBSCRIPTION_SERVICE_CAPABILITY = "sat-subscription.service";
/** SPI 管理 trusted capability。 */
export const SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY = "sat-subscription.spi.service";
/** Channel 消息协议名。 */
export const BSV8_MESSAGE_PROTOCOL = "bsv8.message.v1";
/** 当前 owner 私密 inbox 的 SSP channel 前缀。 */
export const BSV8_INBOX_CHANNEL_PREFIX = "bsv8.inbox.";
/** SSP libp2p stream 协议名。 */
export const SSP_LIBP2P_PROTOCOL = "/ssp/1.0.0";
/** SPI libp2p stream 协议名。 */
export const SPI_LIBP2P_PROTOCOL = "/spi/1.0.0";

/** Sat Window/Worker 业务层资源上限；超过后必须 fail closed。 */
export const SAT_SUBSCRIPTION_RESOURCE_LIMITS = Object.freeze({
  /** 每供应商等待响应的 SSP 请求数。 */
  maxPendingSspPerSupplier: 64,
  /** 每供应商等待响应的 SPI 请求数。 */
  maxPendingSpiPerSupplier: 16,
  /** 单 writer 等待写入的 Frame 数。 */
  maxWriterQueuedFrames: 128,
  /** 单 writer 排队总字节（含 uvarint framing）。 */
  maxWriterQueuedBytes: 2 * 1024 * 1024,
  /** 每供应商并发入站 Publish handler 数。 */
  maxInboundHandlersPerSupplier: 32,
  /** Window lane 等待 Worker 响应的入站数。 */
  maxPendingIncomingPerLane: 64,
  /** SharedWorker 中尚未 settle 的 Sat 入站业务 handler 总数。 */
  maxActiveWorkerInboundHandlers: 64,
  /** Worker 中尚未完成 ACK 的 active claim 数；超过后新 Deliver fail closed。 */
  maxActiveDeliveryAcks: 64,
  /** ACK 终态 tombstone 数；用于拒绝 unknown claim 的自动重发。 */
  maxDeliveryAckTombstones: 128,
  /** Worker bridge 在途 Wire 总字节。 */
  // 必须容纳单个 MSFile Seed（16 MiB）和 SSP frame，同时仍限制小消息数量攻击。
  maxBridgeInFlightBytes: 32 * 1024 * 1024,
  /** Worker bridge 在途操作数。 */
  maxBridgePendingItems: 256
});

/** 本地供应商目录中的单个配置。 */
export interface SatSupplierConfigV1 {
  /** Keymaster 本地稳定编号；不是远端身份。 */
  supplierId: string;
  /** 设置页显示名称。 */
  name: string;
  /** Noise authenticated connection 必须匹配的压缩公钥 hex。 */
  supplierPublicKeyHex: string;
  /** 按保存顺序尝试的 libp2p 地址。 */
  multiaddrs: string[];
  /** 是否允许建立连接和执行操作。 */
  enabled: boolean;
}

/** 当前 owner 的供应商选择；必须按 owner 隔离。 */
export interface SatOwnerSupplierSettingsV1 {
  /** 当前 owner 压缩公钥 hex；由会话真值写入，App 不可传入。 */
  ownerPublicKeyHex: string;
  /** 唯一普通 Publish 供应商；null 表示未配置。 */
  defaultPublishSupplierId: string | null;
  /** 允许接收 owner inbox 的供应商编号集合。 */
  receiveSupplierIds: string[];
}

/** 供应商连接状态。 */
export type SatSupplierConnectionState =
  | "disabled"
  | "connecting"
  | "online"
  | "degraded"
  | "disconnected";

/** 本地订阅意图与远端观察值的状态。 */
export type SatSubscriptionState =
  | "unknown"
  | "subscribing"
  | "subscribed"
  | "unsubscribing"
  | "unsubscribed"
  | "unknown_result";

/** SSP/SPI/Channel 统一的稳定错误分类。 */
export type SatErrorCode =
  | "config"
  | "connect"
  | "identity"
  | "protocol"
  | "balance"
  | "unknown_result"
  | "validation"
  | "unavailable"
  | "conflict";

/** Subscribe / Unsubscribe 的受控结果。 */
export interface SatActionResult {
  /** 远端明确成功才为 true。 */
  ok: boolean;
  /** 本次动作针对的本地供应商编号。 */
  supplierId: string;
  /** SSP 精确频道名，区分大小写。 */
  channel: string;
  /** 本次 SSP request id 的小写 hex。 */
  requestIdHex: string;
  /** 供应商返回的精确十进制扣费字符串。 */
  chargedAmount: string;
  /** 稳定错误分类；成功时省略。 */
  errorCode?: SatErrorCode;
  /** 脱敏后的可展示错误说明；不得包含完整 wire 或私密材料。 */
  errorMessage?: string;
}

/** 入站 SSP Publish；ingressSupplierId 只供平台内部 ACK 路由使用。 */
export interface SatIncomingPublish {
  /** 本次实际入站投递的唯一编号；同一逻辑消息重投也会产生新的编号。 */
  deliveryId: string;
  /** 收到该 Publish 的本地供应商编号。 */
  ingressSupplierId: string;
  /** SSP 精确频道名。 */
  channel: string;
  /** SSP request id 的小写 hex。 */
  requestIdHex: string;
  /** 完整合法 JSON UTF-8 字节；仍是 Channel 密文 envelope。 */
  contentJson: Uint8Array;
  /** 供应商返回的精确十进制扣费字符串。 */
  chargedAmount: string;
  /** Keymaster 首次观察该 Publish 的时间。 */
  receivedAtMs: number;
}

/** Coordinator 处理入站 Publish 的异步回调；未知私密协议可通过拒绝错误回传 SSP。 */
export type SatIncomingPublishHandler = (event: SatIncomingPublish) => void | Promise<void>;

/** trusted SSP capability 的唯一调用入口。 */
export interface SatSubscriptionService {
  /**
   * 向当前 owner 的唯一默认供应商 Publish；调用方不能指定供应商。
   */
  publish(input: {
    /** SSP 精确频道名，不裁剪、不归一化。 */
    channel: string;
    /** 完整合法 JSON UTF-8 原始字节。 */
    contentJson: Uint8Array;
  }): Promise<{ requestIdHex: string; chargedAmount: string }>;
  /** 聚合所有 receive Supplier 的入站 Publish。 */
  subscribeEvents(handler: SatIncomingPublishHandler): () => void;
}

/** 设置页读取的 owner-scoped SatSubscription 快照。 */
export interface SatSubscriptionSettingsSnapshot {
  /** 当前 owner；未解锁时为 null。 */
  ownerPublicKeyHex: string | null;
  /** Supplier catalog 配置代际；设置变化后旧连接/请求不可复用。 */
  supplierGeneration: number;
  /** 当前供应商目录。 */
  suppliers: SatSupplierConfigV1[];
  /** 当前 owner 的默认/接收选择。 */
  ownerSettings: SatOwnerSupplierSettingsV1 | null;
  /** 供应商连接与订阅摘要。 */
  supplierViews: SatSupplierRuntimeView[];
  /** 最近有界扣费审计。金额仍是精确字符串。 */
  feeAudit: Array<{ supplierId: string; action: string; channel: string; chargedAmount: string; result: string; errorCode?: SatErrorCode; createdAtMs: number }>;
}

/** SatSubscription 设置页需要的额外受信任管理操作。 */
export interface SatSubscriptionAdminService {
  /** 读取当前 owner 的供应商/订阅/扣费摘要。 */
  getSettingsSnapshot(): Promise<SatSubscriptionSettingsSnapshot>;
  /** 新增或更新供应商配置。 */
  upsertSupplier(config: SatSupplierConfigV1): Promise<void>;
  /** 删除供应商；不自动回收余额。 */
  deleteSupplier(supplierId: string): Promise<void>;
  /** 修改当前 owner 的默认发布和接收选择。 */
  setOwnerSettings(settings: SatOwnerSupplierSettingsV1): Promise<void>;
  /** 只读查询指定 Supplier 的远端订阅集合；不接受单频道收费变更。 */
  refreshSubscriptions(input: { supplierId: string }): Promise<{ channels: string[]; chargedAmount: string }>;
}

/** SPI Information 中单个 currency 的余额。 */
export interface SatSpiCurrencyBalance {
  /** 货币名称，例如 BSV。 */
  currency: string;
  /** 链网络，例如 main。 */
  network: string;
  /** 供应商充值地址。 */
  paymentAddress: string;
  /** SPI 最小单位整数；禁止用 JS number 表示。 */
  balance: bigint;
}

/** 某供应商某 owner 的 SPI Information 缓存。 */
export interface SatSpiInformation {
  /** 本地供应商编号。 */
  supplierId: string;
  /** 当前 authenticated owner 公钥 hex。 */
  ownerPublicKeyHex: string;
  /** 供应商返回的货币余额集合。 */
  currencies: readonly SatSpiCurrencyBalance[];
  /** SPI project type。 */
  projectType: string;
  /** 受控诊断用 project_info CBOR 原始字节。 */
  projectInfoCbor: Uint8Array;
  /** 本地缓存时间。 */
  observedAtMs: number;
}

/** P2PKH 充值的内部预览；P2PKH 具体 preview 不进入 Connect。 */
export interface SatTopUpPreview {
  /** 预览关联供应商。 */
  supplierId: string;
  /** 供应商充值地址。 */
  paymentAddress: string;
  /** BSV mainnet。 */
  network: "main";
  /** 精确 satoshis 金额。 */
  amountSatoshis: bigint;
  /** P2PKH service 生成的最终预览对象。 */
  p2pkhPreview: unknown;
}

/** 充值广播结果。 */
export interface SatTopUpResult {
  /** 预览中的 txid；未知时为空。 */
  txid?: string;
  /** P2PKH 广播最终状态。 */
  status: string;
}

/** SPI Collect 的请求状态。 */
export type SatCollectState = "pending" | "unknown_result" | "succeeded" | "failed";

/** Collect 请求的持久化终态摘要。 */
export interface SatCollectResult {
  /** 本次 Collect request id 的小写 hex。 */
  requestIdHex: string;
  /** 创建该请求时绑定的 owner；重试时不得切换 owner。 */
  ownerPublicKeyHex?: string;
  /** 创建该请求时的 owner 会话世代；重试时必须仍匹配。 */
  ownerGeneration?: number;
  /** 创建该请求时的 Supplier catalog 世代；重试时必须仍匹配。 */
  supplierGeneration?: number;
  /** 本地供应商编号。 */
  supplierId: string;
  /** 货币名称。 */
  currency: string;
  /** 链网络。 */
  network: string;
  /** 回收金额；SPI 最小单位整数。 */
  amount: bigint;
  /** 本次请求提交时使用的 owner payment address。 */
  paymentAddress: string;
  /** 为允许未知结果显式恢复而保存的原始 Collect wire。 */
  requestWire?: Uint8Array;
  /** 旧记录缺少安全恢复字段时置为 true；只能人工核对，禁止自动重试。 */
  recoveryBlocked?: boolean;
  /** 终态。 */
  state: SatCollectState;
  /** 明确失败时的稳定错误分类。 */
  errorCode?: SatErrorCode;
}

/** trusted SPI 管理 capability。 */
export interface SatSubscriptionSpiService {
  /** 查询并缓存某供应商的 SPI Information。 */
  getInformation(input: { supplierId: string }): Promise<SatSpiInformation>;
  /** 生成需要用户确认的 P2PKH mainnet 充值预览。 */
  prepareTopUp(input: { supplierId: string; amountSatoshis: bigint }): Promise<SatTopUpPreview>;
  /** 广播已确认且仍与当前配置匹配的充值预览。 */
  submitTopUp(preview: SatTopUpPreview): Promise<SatTopUpResult>;
  /** 每次用户主动回收都创建新的 request_id；不会复用历史终态。 */
  collectNew(input: { supplierId: string; currency: string; network: string; amount: bigint }): Promise<SatCollectResult>;
  /** 只重发持久化的完全相同 Collect Wire，不重新检查当前余额。 */
  retryCollect(input: { requestIdHex: string; requestWire?: Uint8Array }): Promise<SatCollectResult>;
  /** 旧调用方兼容入口：未决结果走 retry，其它调用走 collectNew。 */
  collect(input: { supplierId: string; currency: string; network: string; amount: bigint }): Promise<SatCollectResult>;
}

/** 设置/诊断页使用的供应商运行摘要。 */
export interface SatSupplierRuntimeView {
  /** 本地供应商编号。 */
  supplierId: string;
  /** 显示名称。 */
  name: string;
  /** pinned 公钥。 */
  supplierPublicKeyHex: string;
  /** 当前连接状态。 */
  connectionState: SatSupplierConnectionState;
  /** 当前 owner inbox channel；未配置时为空。 */
  inboxChannel: string | null;
  /** 本地 desired 订阅频道。 */
  desiredChannels: string[];
  /** 最近一次远端 observed 订阅频道。 */
  observedChannels: string[];
  /** 最近一次 SSP 扣费字符串。 */
  lastChargedAmount: string | null;
  /** 最近一次稳定错误。 */
  lastErrorCode: SatErrorCode | null;
}

/**
 * SharedWorker 内部 Sat RPC 操作。
 *
 * 页面只传语义化操作；SSP/SPI wire、owner 私钥和网络连接均留在
 * Coordinator/Window executor 内。字段说明保持中文，避免调用方猜测
 * `type` 对应的真实业务含义。
 */
export type CoordinatorSatOperation =
  | { type: "ensure" }
  | { type: "admin.getSettings" }
  | { type: "admin.upsertSupplier"; config: SatSupplierConfigV1 }
  | { type: "admin.deleteSupplier"; supplierId: string }
  | { type: "admin.setOwnerSettings"; settings: SatOwnerSupplierSettingsV1 }
  | { type: "service.publish"; input: Parameters<SatSubscriptionService["publish"]>[0] }
  | { type: "admin.refreshSubscriptions"; input: Parameters<SatSubscriptionAdminService["refreshSubscriptions"]>[0] }
  | { type: "spi.getInformation"; input: Parameters<SatSubscriptionSpiService["getInformation"]>[0] }
  | { type: "spi.prepareTopUp"; input: Parameters<SatSubscriptionSpiService["prepareTopUp"]>[0] }
  | { type: "spi.submitTopUp"; preview: SatTopUpPreview }
  | { type: "spi.collectNew"; input: Parameters<SatSubscriptionSpiService["collectNew"]>[0] }
  | { type: "spi.retryCollect"; input: Parameters<SatSubscriptionSpiService["retryCollect"]>[0] }
  | { type: "spi.collect"; input: Parameters<SatSubscriptionSpiService["collect"]>[0] };

/** Coordinator 推送给各页面的 Sat 事件。`noop` 只用于 baseline。 */
export type CoordinatorSatEvent =
  | { type: "incoming"; event: SatIncomingPublish }
  | { type: "noop" };

/** Sat 事件主题快照；revision 用于跨 Tab 去重和乱序防护。 */
export interface CoordinatorSatStateEvent {
  topic: "sat.events";
  type: "sat.events.changed";
  satRevision: number;
  sessionEpoch: string;
  event: CoordinatorSatEvent;
}

/** Window P2P lane 的连接实例 fence；四个字段必须完全匹配。 */
export interface SatWindowConnectionFence {
  /** 本地供应商编号。 */
  supplierId: string;
  /** 每次真实 connect 生成的连接实例编号。 */
  connectionId: string;
  /** 当前 owner/Vault 会话代际。 */
  ownerSessionEpoch: string;
  /** 当前供应商配置代际。 */
  supplierGeneration: number;
}

/** Window P2P lane 使用的操作；不包含 owner 私钥。 */
export type SatWindowLaneOperation =
  | ({ type: "connect"; supplierPublicKeyHex: string; multiaddrs: string[]; requestTimeoutMs?: number } & SatWindowConnectionFence)
  | ({ type: "requestSsp"; wire: Uint8Array } & SatWindowConnectionFence)
  | ({ type: "requestSpi"; wire: Uint8Array } & SatWindowConnectionFence)
  | ({ type: "respondSsp"; eventId: string; wire: Uint8Array } & SatWindowConnectionFence)
  | ({ type: "close" } & SatWindowConnectionFence);

/** Window lane 报告给 Coordinator 的入站 SSP 请求。 */
export interface SatWindowLaneSspRequestEvent {
  type: "ssp.request";
  eventId: string;
  wire: Uint8Array;
  /** 入站事件对应的连接实例 fence。 */
  supplierId: string;
  connectionId: string;
  ownerSessionEpoch: string;
  supplierGeneration: number;
}
