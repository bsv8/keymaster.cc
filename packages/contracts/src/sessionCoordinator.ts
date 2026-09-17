// packages/contracts/src/sessionCoordinator.ts
// Session Coordinator 契约：SharedWorker 作为唯一会话协调器的 RPC 协议定义。
//
// 设计缘由（施工单 002）：
//   - 所有 Keymaster 主页面 tab 共享同一个 SharedWorker 中的 Vault 会话
//   - 私钥只在 Worker 内存中，永不离开
//   - 删除所有多 tab 竞争机制（leader 选举、BroadcastChannel 等）
//   - sessionEpoch 是每个异步操作的世代栅栏
//
// 施工单 001：signDigest 操作必须携带 format 字段

import type { AssetDataInvalidationEvent } from "./assets.js";
import type { EcdsaSignatureFormat } from "./activeKeyCrypto.js";
import type { JSONValue, ChannelPrivateMessageEvent, ChannelOperationCaller, ChannelSubscriptionStatus } from "./channel.js";
import type { ContactPresenceMap } from "./contacts.js";
import type { I18nText } from "./i18n.js";
import type { BackgroundTaskProgress } from "./background.js";
import type { VaultSealedSecret } from "./vault.js";
import { defineCapability } from "webloom-framework";
import type { CoordinatorVaultOperationResultFor } from "./sessionCoordinatorRuntime.js";
import type {
  OwnerAppStorageGrant,
  StorageListResult,
  StorageDirectoryResult,
  StoragePutResult,
  StorageGetResult,
  StorageDeleteResult,
  StorageUploadBeginResult,
  StorageUploadPartResult,
  StorageUploadAbortResult
} from "./connectStorage.js";
import type {
  BucketConditionalCapabilityProbeResult,
  StorageProbeResult,
  StorageProviderSummary,
  StorageProviderConnectionView,
  BucketConditionalCapabilitiesView,
  StorageRuntimeControllerStatus,
  StorageRuntimeStatus
} from "./storage/runtime.js";
import type { StorageProviderConfigDraft } from "./storage/profile.js";
import type { ExistingRemoteStorageConnectPlan, InitialSetupPlan, StorageBucketConnectionConfigV1 } from "./storage/catalog.js";
import type {
  P2pkhProviderSettings,
  P2pkhProviderRegistrySnapshot,
  P2pkhNetworkProviderSelection,
} from "./bsvP2pkhProviders.js";

/** Provider-specific settings cross the Coordinator wire as JSON only. */
export type P2pkhProviderConfig = { [key: string]: JSONValue };
import type {
  MsFileApprovalDecision,
  MsFileAppIdentityKey,
  MsFileAppPriceOverrideUpdate,
  MsFileConnectAppContext,
  MsFileGlobalPriceSettings,
  MsFileReadConcurrencySettings,
  MsFilePendingApprovalView,
  MsFileServiceStatus,
  MsFileSettingsSnapshot,
  MsFileSupplierConfig,
  MsFileSupplierProbeResult,
} from "./msfile.js";
import type { CoordinatorSatOperation, CoordinatorSatStateEvent } from "./satSubscription.js";
import type { SatErrorCode } from "./satSubscription.js";
import type { WindowP2pExecutorError } from "./windowP2pExecutor.js";
import type {
  PluginIntentCommand,
  PluginIntentSnapshot,
  PluginIntentSubmissionResult,
} from "webloom-framework";
import type { KeymasterScopeKind } from "./keymasterLifecycle.js";

// ============================================================
// 1. Session Epoch
// ============================================================

/** 会话世代标识符。每次 unlock、lock、Worker 重建均变更。 */
export type SessionEpoch = string;

/** Coordinator 全局状态。 */
export type CoordinatorVaultStatus =
  | "booting"
  | "uninitialized"
  | "locked"
  | "unlocked"
  | "fatal";

/** 页面侧可观察的 Coordinator transport/session 状态。 */
export type CoordinatorConnectionState = "starting" | "ready" | "recoverable" | "fatal";

/**
 * Coordinator 发现旧 Worker 仍持有最终 I/O 租约时的可恢复状态。
 *
 * 这里明确表示“不能安全接管”，不是允许新 Worker 强制抢占；旧 Worker
 * 释放租约后，用户可以通过重试完成冷切换。activeIoLeaseCount 只用于
 * 脱敏诊断，不向页面暴露 leaseId 或其它持久化细节。authorityBuildId
 * 及读写计数用于人工恢复对账，不能被调用方用来申请接管。
 */
export interface CoordinatorAuthorityRecovery {
  status: "recovery-required";
  reason: "active-final-io-leases";
  /** 仍持有租约的旧 Worker 构建标识；不包含业务载荷。 */
  authorityBuildId: string;
  activeIoLeaseCount: number;
  /** 活动最终 I/O 的脱敏读写计数，二者之和必须等于 activeIoLeaseCount。 */
  activeIoOperations: { read: number; write: number };
  handoverGeneration: number;
}

/** Coordinator Worker 当前已激活的运行单元快照。 */
export interface CoordinatorWorkerUnitSnapshot {
  /** 用户可启停的产品标识。 */
  productId: string;
  /** 稳定运行单元标识，不是一次装配生成的实例标识。 */
  unitId: string;
  /** 提供者所在执行环境。 */
  runtime: "shared-worker";
  /** 该单元绑定的作用域寿命。 */
  scopeKind: KeymasterScopeKind;
  /** 本次 Worker 装配生成的单元实例标识。 */
  instanceId: string;
  /** 单元是否仍在初始化、已经就绪或启动失败。 */
  state: "starting" | "ready" | "failed";
  /** Worker 单元快照的单调修订号；页面用它丢弃乱序或重复快照。 */
  snapshotRevision: number;
  /** 该单元拥有的后台服务稳定标识。 */
  serviceIds: string[];
  /** 该单元拥有的后台任务稳定标识。 */
  taskIds: string[];
  /** owner-session 单元的当前 owner；root/storage 单元不填写。 */
  ownerPublicKeyHex?: string;
  /** owner-session 单元绑定的当前会话世代。 */
  sessionEpoch?: SessionEpoch;
  /** 启动失败的脱敏诊断文本。 */
  error?: string;
}

// ============================================================
// 2. Client -> Coordinator RPC
// ============================================================

export type CoordinatorStorageControl =
  | { type: "status" }
  | { type: "summary" }
  | { type: "connection" }
  /** 新版桶目录的临时桶密码；不复用旧 Storage Profile envelope。 */
  | { type: "unlock-bucket"; password: string }
  /** 最终确认后的首桶 + 首 Key 单一事务；密码和材料只在本次请求内存在。 */
  | { type: "initial-setup"; plan: InitialSetupPlan }
  /** 只读探测：连接并列出 keys/,判定“已有钱包”还是“空桶”。 */
  | { type: "probe-bucket"; plan: import("./storage/catalog.js").BucketProbePlan }
  /** 连接已有钱包（已有 KeyHold 文件）入口；不得隐式创建。 */
  | { type: "connect-existing-remote"; plan: ExistingRemoteStorageConnectPlan }
  /** 响应丢失后的同事务结果查询；只携带公开事务 ID。 */
  | { type: "initial-setup-result"; transactionId: string }
  /** 页面重载后列出公开的初始化恢复记录；不含密码、凭据或私钥。 */
  | { type: "initial-setup-recovery-list" }
  /** 重试清理同一事务的候选对象；不携带密码、凭据或私钥。 */
  | {
      type: "initial-setup-cleanup";
      transactionId: string;
      /** S3 候选在目录回滚后没有可解密条目时，由用户临时重新提供的桶密码。 */
      password?: string;
      /** 只用于本次清理重建 Provider；不会写入恢复记录。 */
      connection?: StorageBucketConnectionConfigV1;
    }
  /** 使用目标桶密码完成 Provider/Root/Keys 会话切换；目录由页面桥原子 CAS。 */
  | { type: "switch-bucket"; bucket: import("./storage/profile.js").StorageRuntimeBucketV1; password: string }
  /** 当前桶连接配置的原子重配置；密码只用于本次验证和重新封装。 */
  | { type: "change-bucket-config"; config: StorageBucketConnectionConfigV1; label?: string; password: string }
  /** 当前桶显示名称的目录 CAS；必须由当前 Coordinator 执行。 */
  | { type: "rename-bucket"; label: string }
  | { type: "retry" }
  | { type: "cancel-probe" }
  | { type: "capabilities" }
  | { type: "probe-capabilities" }
  /** 读取当前已提交的完整 Hold 快照；不输入密码、不解密。 */
  | { type: "cold-export" };

export type CoordinatorStorageData =
  | { type: "list"; grantId: string; input: { prefix?: string; cursor?: string; limit?: number } }
  | { type: "create-directory"; grantId: string; input: { path: string; overwrite?: boolean } }
  | { type: "delete-directory"; grantId: string; input: { path: string } }
  | { type: "put"; grantId: string; input: { path: string; content: { $type: "binary"; bytes: ArrayBuffer; mime?: string }; contentType?: string; overwrite?: boolean } }
  | { type: "get-range"; grantId: string; input: { path: string; offset?: number; length?: number; ifMatch?: string } }
  | { type: "delete"; grantId: string; input: { path: string } }
  | { type: "begin-upload"; grantId: string; input: { path: string; contentType?: string; size: number; overwrite?: boolean } }
  | { type: "upload-part"; grantId: string; input: { uploadId: string; partNumber: number; content: { $type: "binary"; bytes: ArrayBuffer; mime?: string } } }
  | { type: "complete-upload"; grantId: string; input: { uploadId: string } }
  | { type: "abort-upload"; grantId: string; input: { uploadId: string } };

export type CoordinatorClientRequestWithStorage =
  | { kind: "storage.grant"; clientId: string; requestId: string; connectSessionId: string; expectedSessionEpoch: SessionEpoch }
  | { kind: "storage.control"; clientId: string; requestId: string; control: CoordinatorStorageControl; expectedSessionEpoch: SessionEpoch }
  | { kind: "storage.data"; clientId: string; requestId: string; data: CoordinatorStorageData; expectedSessionEpoch: SessionEpoch }
  | { kind: "storage.cancel"; clientId: string; requestId: string; targetRequestId: string }
  | { kind: "disconnect"; clientId: string; requestId: string }
  | { kind: "storage.session.abort"; clientId: string; requestId: string; connectSessionId: string; expectedSessionEpoch: SessionEpoch };

/** Host/Coordinator 内部存储请求，不属于插件可见的 SessionCoordinatorClient。 */
export type CoordinatorClientRequestWithInternalStorage =
  | { kind: "storage.owner.bind"; clientId: string; requestId: string; pluginId: string; declaration: import("./storage/access.js").PluginStorageDeclaration; expectedSessionEpoch: SessionEpoch }
  | { kind: "storage.platform.bind"; clientId: string; requestId: string; pluginId: string; declaration: import("./storage/access.js").PluginStorageDeclaration; expectedSessionEpoch: SessionEpoch }
  | { kind: "storage.owner.data"; clientId: string; requestId: string; data: import("./storage/internal.js").CoordinatorOwnerStorageData; expectedSessionEpoch: SessionEpoch }
  | { kind: "storage.platform.data"; clientId: string; requestId: string; data: import("./storage/internal.js").CoordinatorPlatformStorageData; expectedSessionEpoch: SessionEpoch }
  | { kind: "storage.owner.delete"; clientId: string; requestId: string; ownerPublicKeyHex: string; expectedSessionEpoch: SessionEpoch };

/** MSFile 设置/App 策略真值在 Coordinator；页面只通过 control RPC 读写。 */
export type CoordinatorMsFileControl =
  | { type: "settings.get" }
  | { type: "settings.readConcurrency.get" }
  | { type: "settings.readConcurrency.update"; input: MsFileReadConcurrencySettings }
  | { type: "settings.readConcurrency.reset" }
  /** 旧页面兼容入口；新页面使用 settings.readConcurrency.*。 */
  | { type: "settings.mediaBlockReadConcurrency.get" }
  | { type: "settings.mediaBlockReadConcurrency.update"; mediaBlockReadConcurrency: number }
  | { type: "settings.global.update"; input: MsFileGlobalPriceSettings }
  | { type: "supplier.upsert"; supplier: MsFileSupplierConfig; expectedGeneration: number | null }
  | { type: "supplier.delete"; supplierPublicKeyHex: string; expectedGeneration: number | null }
  | { type: "supplier.probe"; supplierPublicKeyHex: string }
  | { type: "app-policy.update"; input: MsFileAppPriceOverrideUpdate }
  | { type: "app-policy.clear"; key: MsFileAppIdentityKey }
  | { type: "app-authorizations.list" }
  | { type: "approvals.pending" }
  | { type: "approval.resolve"; approvalId: string; decision: MsFileApprovalDecision };

/**
 * MSFile 数据面。grantId 缺失表示受信任内部插件调用（只使用全局额度）；
 * 带 grantId 的调用由 Connect gateway 按 App 级策略解析。
 */
export type CoordinatorMsFileData =
  | { type: "stat"; grantId?: string; seedHashHex: string }
  | { type: "read-seed"; grantId?: string; supplierPublicKeyHex: string; seedHashHex: string }
  | { type: "read-block"; grantId?: string; supplierPublicKeyHex: string; blockHashHex: string };

export type CoordinatorClientRequestWithMsfile =
  | { kind: "msfile.grant"; clientId: string; requestId: string; context: MsFileConnectAppContext; expectedSessionEpoch: SessionEpoch }
  | { kind: "msfile.control"; clientId: string; requestId: string; control: CoordinatorMsFileControl; expectedSessionEpoch: SessionEpoch }
  | { kind: "msfile.data"; clientId: string; requestId: string; data: CoordinatorMsFileData; expectedSessionEpoch: SessionEpoch }
  | { kind: "msfile.cancel"; clientId: string; requestId: string; targetRequestId: string }
  | { kind: "disconnect"; clientId: string; requestId: string }
  | { kind: "msfile.session.abort"; clientId: string; requestId: string; connectSessionId: string; expectedSessionEpoch: SessionEpoch };

/* ============== Window P2P executor（公共网络基础能力） ============== */

/** Window executor lease 的权威快照；私钥永远不在此结果中。 */
export interface WindowP2pExecutorLease {
  leaseId: string;
  sessionEpoch: SessionEpoch;
  activePublicKeyHex: string;
}

/** Noise 静态密钥签名请求。static key 必须是 32 字节。 */
export interface WindowP2pNoiseSignRequest {
  leaseId: string;
  /** 发起请求时观察到的会话世代，用于 lock/key switch 栅栏。 */
  expectedSessionEpoch: SessionEpoch;
  noiseStaticPublicKey: ArrayBuffer;
}

/** Signed Peer Record 签名请求。地址在本 Spike 中必须为空。 */
export interface WindowP2pPeerRecordSignRequest {
  leaseId: string;
  /** 发起请求时观察到的会话世代，用于 lock/key switch 栅栏。 */
  expectedSessionEpoch: SessionEpoch;
  peerId: string;
  addresses: string[];
  /** 合法 uint64 的十进制字符串，避免 JSON number 精度损失。 */
  sequence: string;
}

/** 两类 typed signer RPC 的统一返回值；签名为标准 DER。 */
export interface WindowP2pIdentitySignResult {
  signatureDer: ArrayBuffer;
}

/** 仅供 001 Spike 验证 Coordinator ↔ Window 双向 transferable。 */
export interface WindowP2pExecutorTransferResult {
  bytes: ArrayBuffer;
  /** Worker 接受该项后的在途总字节数。 */
  acceptedPendingBytes: number;
  /** 本轮 burst 在 Worker 中观测到的在途字节峰值。 */
  peakPendingBytes: number;
}

/**
 * Window executor lease 与两个独立 typed signer RPC。
 * 请求绑定实际 MessagePort；lock/key switch/Worker 重启会清空 lease。
 */
export type CoordinatorClientRequestWithWindowP2pExecutor =
  | { kind: "window-p2p.executor.acquire"; clientId: string; requestId: string; ownerPublicKeyHex: string; expectedSessionEpoch: SessionEpoch; /** 生产 executor 的专用双工 RPC 端口。 */ executorPort?: MessagePort }
  | { kind: "window-p2p.executor.release"; clientId: string; requestId: string; leaseId: string }
  | { kind: "window-p2p.executor.spike.transfer"; clientId: string; requestId: string; leaseId: string; expectedSessionEpoch: SessionEpoch; bytes: ArrayBuffer }
  | ({ kind: "window-p2p.executor.identity.sign-noise"; clientId: string; requestId: string } & WindowP2pNoiseSignRequest)
  | ({ kind: "window-p2p.executor.identity.sign-peer-record"; clientId: string; requestId: string } & WindowP2pPeerRecordSignRequest);

export type CoordinatorClientRequest =
  | CoordinatorClientRequestWithStorage
  | CoordinatorClientRequestWithInternalStorage
  | CoordinatorClientRequestWithMsfile
  | CoordinatorClientRequestWithWindowP2pExecutor
  | { kind: "sat.operation"; clientId: string; requestId: string; operation: CoordinatorSatOperation; expectedSessionEpoch: SessionEpoch }
  | { kind: "channel.operation"; clientId: string; requestId: string; operation: CoordinatorChannelOperation; expectedSessionEpoch: SessionEpoch }
  /** 取消当前端口发起的 Channel 请求；服务端按真实端口身份定位目标。 */
  | { kind: "channel.cancel"; clientId: string; requestId: string; targetRequestId: string }
  | { kind: "contacts.presence.snapshot"; clientId: string; requestId: string; expectedSessionEpoch: SessionEpoch }
  | { kind: "plugin.intent.snapshot"; clientId: string; requestId: string }
  | { kind: "plugin.intent.submit"; clientId: string; requestId: string; command: PluginIntentCommand }
  | ({ kind: "hello"; clientId: string; requestId: string; storageBootstrapState?: import("./storage/profile.js").StorageBootstrapState; /** Coordinator 服务桥的专用双工端口。 */ servicePort?: MessagePort; /** Local localStorage 页面桥的专用双工端口。 */ localStorageBridgePort?: MessagePort; /** 页面为本次 Coordinator hello 创建的一次性本地 I/O 租约。 */ localStorageBridgeLeaseId?: string }
    | { kind: "subscribe"; clientId: string; requestId: string; topics: CoordinatorTopic[] }
    | { kind: "unlock"; clientId: string; requestId: string; password: string; publicKeyHex?: string; expectedSessionEpoch: SessionEpoch }
    | { kind: "lock"; clientId: string; requestId: string; expectedSessionEpoch: SessionEpoch }
    | { kind: "activate-key"; clientId: string; requestId: string; password: string; publicKeyHex: string; expectedSessionEpoch: SessionEpoch }
    | { kind: "vault.operation"; clientId: string; requestId: string; operation: CoordinatorVaultOperation; expectedSessionEpoch: SessionEpoch }
    | { kind: "crypto"; clientId: string; requestId: string; operation: CoordinatorCryptoOperation; expectedSessionEpoch: SessionEpoch }
    | { kind: "background.run-now"; clientId: string; requestId: string; taskId: string; expectedSessionEpoch: SessionEpoch }
    | { kind: "background.trigger"; clientId: string; requestId: string; taskId: string; reason: string; expectedSessionEpoch: SessionEpoch }
    | { kind: "background.cancel"; clientId: string; requestId: string; taskId: string; expectedSessionEpoch: SessionEpoch }
    | { kind: "background.cancel-by-key"; clientId: string; requestId: string; publicKeyHex: string; expectedSessionEpoch: SessionEpoch }
    | { kind: "background.settings.update"; clientId: string; requestId: string; settings: CoordinatorBackgroundSyncSettings; expectedSessionEpoch: SessionEpoch }
    | { kind: "p2pkh.providers.get"; clientId: string; requestId: string; expectedSessionEpoch: SessionEpoch }
    | { kind: "p2pkh.providers.update"; clientId: string; requestId: string; network: "main" | "test"; selection: P2pkhNetworkProviderSelection; expectedGeneration: number; expectedSessionEpoch: SessionEpoch }
    | { kind: "p2pkh.settings.update"; clientId: string; requestId: string; settings: { includeTestnet: boolean }; expectedSessionEpoch: SessionEpoch }
    | { kind: "p2pkh.provider-config.get"; clientId: string; requestId: string; providerId: string; expectedSessionEpoch: SessionEpoch }
    | { kind: "p2pkh.provider-config.update"; clientId: string; requestId: string; providerId: string; config: P2pkhProviderConfig; expectedSessionEpoch: SessionEpoch }
    | { kind: "p2pkh.broadcast"; clientId: string; requestId: string; ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number; expectedSessionEpoch: SessionEpoch }
    | { kind: "p2pkh.rebroadcast-ancestors"; clientId: string; requestId: string; ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number; expectedSessionEpoch: SessionEpoch }
    | { kind: "activity"; clientId: string });

/** Coordinator 订阅主题。 */
export type CoordinatorTopic = "session.state" | "background.snapshot" | "asset.data-changed" | "storage.state" | "p2pkh.providers" | "msfile.state" | "sat.events" | "channel.events" | "contacts.presence" | "plugin.intent" | "worker.units";

/** MSFile 状态事件：状态、设置摘要与未决超额确认（脱敏视图）。 */
export interface CoordinatorMsFileStateEvent {
  topic: "msfile.state";
  type: "msfile.state.changed";
  msfileRevision: number;
  sessionEpoch: SessionEpoch;
  status: MsFileServiceStatus;
  supplierGeneration: number;
  globalSettings: MsFileGlobalPriceSettings | null;
  /** 单个媒体 Session 的 Block 读取并发数。 */
  mediaBlockReadConcurrency: number;
  /** 整个 Keymaster 的 Seed 读取并发数。 */
  globalSeedReadConcurrency: number;
  /** 整个 Keymaster 的 Block 读取并发数。 */
  globalBlockReadConcurrency: number;
  /** 整个 Keymaster 的 Stat 并发数。 */
  globalStatConcurrency: number;
  pendingApprovals: MsFilePendingApprovalView[];
}

/** 受控 crypto 操作白名单。 */
export type CoordinatorCryptoOperation =
  | { type: "signDigest"; digestHex: string; format: EcdsaSignatureFormat }
  | { type: "deriveP2pkhAddress"; network: "main" | "test" };

/** Channel 运行时调用；owner 由 Coordinator 当前解锁状态决定。 */
export type CoordinatorChannelOperation =
  | { type: "publish"; ownerPublicKeyHex: string; caller: ChannelOperationCaller; channel: string; content: JSONValue }
  /** 受信任 WebRTC 插件发布真实 Hash 请求；不能由 Connect App 伪造。 */
  | { type: "hash-request-publish"; ownerPublicKeyHex: string; caller: ChannelOperationCaller; hash: string; locator: "webrtc-sdp" }
  | { type: "private-publish"; ownerPublicKeyHex: string; caller: ChannelOperationCaller; recipientPublicKeyHex: string; protocol: string; content: JSONValue }
  | { type: "subscription-set"; ownerPublicKeyHex: string; caller: ChannelOperationCaller; channels: string[] }
  | { type: "release"; ownerPublicKeyHex: string; caller: ChannelOperationCaller };

/** 后台同步设置。 */
export interface CoordinatorBackgroundSyncSettings {
  assetHoldingsIntervalMs: number;
}

export type CoordinatorVaultOperation =
  | { type: "createVault"; password: string }
  | { type: "createVaultWithInitialKey"; password: string; label?: string; capabilities?: string[] }
  | { type: "createVaultWithImportedKey"; vaultPassword: string; key: { label: string; material: { hex: string; wif?: string }; format: string; capabilities: string[]; source?: string } }
  | { type: "listKeys" }
  | { type: "getKey"; publicKeyHex: string }
  | { type: "setActive"; publicKeyHex: string }
  | { type: "deleteKey"; publicKeyHex: string; confirmationLabel: string; bucketPassword?: string }
  | { type: "verifyPassword"; password: string }
  | { type: "changePassword"; oldPassword: string; newPassword: string }
  | { type: "finalizeEmptyVaultAfterLastKeyDeletion" }
  | { type: "recoverEmptyVaultToUninitialized" }
  | { type: "generateKey"; password: string; label: string; capabilities?: string[] }
  | { type: "importPrivateKey"; password: string; label: string; material: { hex: string; wif?: string }; format: string; capabilities: string[]; source?: string }
  | { type: "exportKeyBackup"; publicKeyHex: string }
  | { type: "importKeyBackup"; backup: string; sourcePassword: string; targetPassword: string }
  | { type: "exportCurrentKeyBackup" }
  | { type: "sealLocalSecret"; scope: string; plaintext: Uint8Array }
  | { type: "openLocalSecret"; scope: string; sealed: VaultSealedSecret };

// ============================================================
// 3. Coordinator -> Client Response
// ============================================================

/** 命令确认结果。 */
export type CoordinatorCommandAck =
  /** accepted 表示已入队/开始执行，不表示网络同步已经完成。 */
  | { status: "accepted" }
  | { status: "already-unlocked" }
  | { status: "already-running" }
  | { status: "blocked"; reason: I18nText }
  | { status: "stale-epoch" }
  | { status: "locked" }
  | { status: "not-ready" }
  | { status: "validation-error"; message: string }
  | { status: "ok" }
  | { status: "error"; message: string; code?: import("./storage/runtime.js").StorageErrorCode | import("./msfile.js").MsFileErrorCode | SatErrorCode | WindowP2pExecutorError["code"] };

/** RPC 响应。 */
export interface CoordinatorResponse {
  requestId: string;
  sessionEpoch: SessionEpoch;
  ack: CoordinatorCommandAck;
  cryptoResult?: CoordinatorCryptoResult;
  operationResult?: unknown;
}

/** Transport failures are recoverable command results, never public rejections. */
export type CoordinatorTransportFailure = {
  status: "transport-error";
  message: string;
  retryable: boolean;
  /** Whether the request definitely crossed the Worker boundary. */
  dispatchStatus?: "not-dispatched" | "unknown";
};

export type CoordinatorCommandResult = CoordinatorCommandAck | CoordinatorTransportFailure;

export type CoordinatorValueResult<T> =
  | { status: "ok"; value: T; sessionEpoch: SessionEpoch }
  | Exclude<CoordinatorCommandResult, { status: "ok" }>;

/** Crypto 操作结果。 */
export type CoordinatorCryptoResult =
  | { type: "signDigest"; signatureHex: string; format: EcdsaSignatureFormat }
  | { type: "deriveP2pkhAddress"; address: string };

// ============================================================
// 4. Coordinator -> Client Events
// ============================================================

/** Coordinator 推送事件联合类型。 */
export type CoordinatorTopicEvent =
  | SessionStateEvent
  | BackgroundSnapshotEvent
  | AssetDataChangedEvent
  | CoordinatorStorageStateEvent
  | P2pkhProvidersEvent
  | CoordinatorMsFileStateEvent
  | CoordinatorSatStateEvent
  | CoordinatorChannelStateEvent
  | CoordinatorContactsPresenceEvent
  | PluginIntentStateEvent
  | CoordinatorWorkerUnitStateEvent;

/** SharedWorker 唯一插件启停意图快照。配置持久化成功与实例启动状态分离。 */
export interface PluginIntentStateEvent {
  topic: "plugin.intent";
  type: "plugin.intent.changed";
  /** 产生该快照的 SharedWorker 启动身份；旧 Worker 事件不得覆盖新 Worker。 */
  authorityInstanceId: string;
  /** 与 PluginIntentSnapshot.revision 相同的单调修订。 */
  pluginIntentRevision: number;
  sessionEpoch: SessionEpoch;
  snapshot: PluginIntentSnapshot;
}

/** Coordinator 已验签并完成固定 inbox 分派的 Channel 事件。 */
export interface CoordinatorChannelStateEvent {
  topic: "channel.events";
  type: "channel.message.received" | "channel.subscription.changed";
  /** 事件序号，用于跨 Tab 去重和乱序防护。 */
  channelRevision: number;
  sessionEpoch: SessionEpoch;
  subscriptionStatus?: ChannelSubscriptionStatus;
  /** 新订阅者的原子物理状态快照；live 事件通常只携带 subscriptionStatus。 */
  subscriptionStatuses?: ChannelSubscriptionStatus[];
  publicMessage?: {
    channel: string;
    publisherPublicKeyHex: string;
    messageId: string;
    content: JSONValue;
  };
  privateMessage?: ChannelPrivateMessageEvent;
}

/** Coordinator 唯一联系人在线状态快照；页面只消费该脱敏投影。 */
export interface CoordinatorContactsPresenceEvent {
  topic: "contacts.presence";
  type: "contacts.presence.changed";
  /** 事件序号，用于跨 Tab 去重和乱序防护。 */
  presenceRevision: number;
  sessionEpoch: SessionEpoch;
  /** 快照所属的当前 owner；锁定或无 active key 时为 null。 */
  activePublicKeyHex: string | null;
  presence: ContactPresenceMap;
}

export interface P2pkhProvidersEvent {
  topic: "p2pkh.providers";
  type: "p2pkh.providers.changed";
  sessionEpoch: SessionEpoch;
  providerRevision: number;
  snapshot: P2pkhProviderRegistrySnapshot;
}

export interface CoordinatorStorageStateEvent {
  topic: "storage.state";
  type: "storage.state.changed";
  storageRevision: number;
  sessionEpoch: SessionEpoch;
  providerGeneration: number | null;
  status: StorageRuntimeControllerStatus;
  /** 独立于 Vault 的 Provider/统一桶健康状态。 */
  healthStatus?: StorageRuntimeStatus;
  /** 当前是否由新版多桶目录绑定；用于 UI 选择正确的密码生命周期。 */
  catalogBucket?: boolean;
  /** 当前 Coordinator 真正绑定的抽象桶身份；页面桥用于租约校验。 */
  bucketId?: string;
  /** 当前 Coordinator 真正绑定的桶运行世代；页面桥用于租约校验。 */
  bucketGeneration?: number;
  /** 旧 Coordinator 尚未释放最终 I/O；只能等待后显式重试，禁止强制接管。 */
  authorityRecovery?: CoordinatorAuthorityRecovery;
  summary: StorageProviderSummary | null;
  capabilities: BucketConditionalCapabilitiesView | null;
}

/** The complete public session snapshot. This is the sole cross-tab session event. */
export interface SessionStateEvent {
  topic: "session.state";
  type: "session.state.changed";
  sessionRevision: number;
  sessionEpoch: SessionEpoch;
  cause:
    | "bootstrap"
    | "unlock"
    | "lock"
    | "activate-key"
    | "create-vault"
    | "create-initial-key"
    | "import-initial-key"
    | "delete-active-key"
    | "recover-empty-vault";
  vaultStatus: CoordinatorVaultStatus;
  activePublicKeyHex: string | null;
  selectedPublicKeyHex?: string | null;
  keyspaceGeneration: number;
  /** Coordinator 启动接管被旧最终 I/O 租约阻塞时的脱敏诊断。 */
  authorityRecovery?: CoordinatorAuthorityRecovery;
}

export interface BackgroundSnapshotEvent {
  topic: "background.snapshot";
  type: "background.snapshot.changed";
  sessionEpoch: SessionEpoch;
  backgroundSnapshotRevision: number;
  snapshots: CoordinatorTaskSnapshot[];
  scheduleSettings?: CoordinatorBackgroundSyncSettings;
}

/** Coordinator Worker 实际运行单元快照；这是 Window 汇总后台状态的唯一入口。 */
export interface CoordinatorWorkerUnitStateEvent {
  topic: "worker.units";
  type: "coordinator.worker-units.changed";
  /** 产生快照的 Worker 启动身份；旧 Worker 事件不得覆盖当前缓存。 */
  authorityInstanceId: string;
  /** Worker 单元快照的单调修订号；旧 revision 不能覆盖新实例。 */
  workerUnitRevision: number;
  sessionEpoch: SessionEpoch;
  units: CoordinatorWorkerUnitSnapshot[];
}

export interface AssetDataChangedEvent {
  topic: "asset.data-changed";
  type: "asset.data-changed";
  sessionEpoch: SessionEpoch;
  providerId: string;
  publicKeyHex: string;
  assetDataRevision: number;
  kinds: AssetDataInvalidationEvent["kinds"];
}

/** subscribe 的原子 baseline。session.state 的 revision 全局严格递增。 */
export interface CoordinatorTopicBaseline {
  topic: CoordinatorTopic;
  baselineRevision: number;
  sessionEpoch: SessionEpoch;
  snapshot: SessionStateEvent | BackgroundSnapshotEvent | AssetDataChangedEvent | CoordinatorStorageStateEvent | P2pkhProvidersEvent | CoordinatorMsFileStateEvent | CoordinatorSatStateEvent | CoordinatorChannelStateEvent | CoordinatorContactsPresenceEvent | PluginIntentStateEvent | CoordinatorWorkerUnitStateEvent;
}

export interface CoordinatorSubscribeTopicsResult {
  topics: CoordinatorTopic[];
  baselines: CoordinatorTopicBaseline[];
}

// ============================================================
// 5. Snapshot Types
// ============================================================

/** Coordinator 公开状态快照。 */
export interface CoordinatorBootstrapSnapshot {
  /** SharedWorker 启动身份；意图命令必须绑定此值。 */
  authorityInstanceId: string;
  /** 构建产物不可变身份；生产证据、部署交接和 Worker 升级必须绑定同一值。 */
  buildId?: string;
  sessionEpoch: SessionEpoch;
  vaultStatus: CoordinatorVaultStatus;
  activePublicKeyHex?: string;
  selectedPublicKeyHex?: string;
  keyspaceGeneration: number;
  /** 旧 Worker 租约未释放时的可恢复状态；不代表可以安全强制接管。 */
  authorityRecovery?: CoordinatorAuthorityRecovery;
  /** 当前 Worker 实际激活的服务/任务单元；未激活的静态单元不会出现在这里。 */
  coordinatorWorkerUnits?: CoordinatorWorkerUnitSnapshot[];
  /** 当前 Worker 单元快照修订；缺失单元不是 blocked，而是 unknown。 */
  coordinatorWorkerUnitSnapshotRevision?: number;
  taskSnapshots: CoordinatorTaskSnapshot[];
  scheduleSettings: CoordinatorBackgroundSyncSettings;
  /** P2PKH 网络范围配置，保存在 Coordinator 平台 K-V。 */
  p2pkhSettings?: { includeTestnet: boolean };
  /** 当前抽象存储桶世代；只用于绑定生命周期身份，不代替 owner/key 世代。 */
  storageBucketGeneration?: number;
  /** 当前抽象存储桶身份；与页面 Local I/O 租约绑定。 */
  storageBucketId?: string;
  p2pkhProviders?: P2pkhProviderRegistrySnapshot;
  /** 插件产品启用意图；不代表运行单元已经启动。 */
  pluginIntent?: PluginIntentSnapshot;
  /**
   * 当前 Coordinator 选择的 storage-I/O peer 脱敏投影；只含框架
   * endpoint binding 和 handoff 修订，不含 lease、owner 或存储配置。
   * 该字段主要供隔离生命周期验收确认真实 owner，不提供接管权限。
   */
  storageIoOwnerPeer?: {
    peerId: string;
    binding: {
      runtimeInstanceId: string;
      connectionId: string;
    };
    handoffRevision: number;
  };
}

/**
 * 当前页面 Runtime 与 Coordinator peer 的绑定令牌。
 *
 * peerId 仍然只存在于 WebLoom transport 上；页面只需要回传这组不可伪造
 * 的（由 Worker 发放、由本页面租约承载的）fencing 字段，Worker 再用
 * HandlerCallContext.peer.peerId 完成最终身份绑定。
 */
export interface CoordinatorSessionBinding {
  peerGeneration: number;
  sessionEpoch: SessionEpoch;
  leaseId: string;
}

/** session.open 的逐 peer 结果；普通广播快照不携带页面私有绑定。 */
export interface CoordinatorSessionOpenResult extends CoordinatorBootstrapSnapshot {
  sessionBinding: CoordinatorSessionBinding;
}

/** 任务快照。 */
export interface CoordinatorTaskSnapshot {
  id: string;
  pluginId: string;
  /** 稳定运行单元标识；产品启停不等于该单元实例已经运行。 */
  unitId?: string;
  /** 本次 Worker 装配生成的实例标识；重建后必须变化。 */
  instanceId?: string;
  label: string;
  state: "idle" | "queued" | "running" | "blocked";
  progress?: BackgroundTaskProgress;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastAttemptAt?: string;
  nextRunAt?: string;
  error?: string;
  blockedReason?: I18nText;
  keyScope?: { publicKeyHex: string; label?: string };
}

/**
 * 页面侧 Coordinator client 的跨包契约。
 *
 * 插件必须依赖本接口，不得各自手写 client 的结构类型；这样 client 删除或改名
 * 方法时，会在装配层和真实 client 的编译检查中立即失败。
 */
export interface SessionCoordinatorClient {
  connect(): Promise<void>;
  getIsConnected(): boolean;
  getConnectionState(): CoordinatorConnectionState;
  getBootstrapSnapshot(): CoordinatorBootstrapSnapshot;
  /** 返回当前会话代际；异步插件操作完成后用它判断结果是否仍属于原会话。 */
  getSessionEpoch(): SessionEpoch;
  /** 返回当前 active owner；异步插件操作完成后用它判断 owner 是否仍一致。 */
  getActivePublicKeyHex(): string | undefined;
  subscribeTopic(topic: CoordinatorTopic, listener: (event: any) => void): () => void;
  unlock(password: string, publicKeyHex?: string): Promise<CoordinatorCommandResult>;
  lock(): Promise<CoordinatorCommandResult>;
  activateKey(password: string, publicKeyHex: string): Promise<CoordinatorCommandResult>;
  vaultOperation<O extends CoordinatorVaultOperation>(operation: O): Promise<CoordinatorValueResult<CoordinatorVaultOperationResultFor<O>>>;
  crypto(operation: CoordinatorCryptoOperation): Promise<{ ack: CoordinatorCommandResult; result?: CoordinatorCryptoResult }>;
  backgroundRunNow(taskId: string): Promise<CoordinatorCommandResult>;
  backgroundTrigger(taskId: string, reason: string): Promise<CoordinatorCommandResult>;
  backgroundCancel(taskId: string): Promise<CoordinatorCommandResult>;
  backgroundCancelByKey(publicKeyHex: string): Promise<CoordinatorCommandResult>;
  backgroundSettingsUpdate(settings: CoordinatorBackgroundSyncSettings): Promise<CoordinatorCommandResult>;
  storageControl(control: CoordinatorStorageControl): Promise<CoordinatorValueResult<unknown>>;
  /** 页面新增首桶后，刷新只含公开桶身份的 Local Storage bridge 启动快照。 */
  refreshStorageBootstrap?(): Promise<void>;
  storageGrant(context: OwnerAppStorageGrant): Promise<CoordinatorValueResult<string>>;
  storageData(data: CoordinatorStorageData, transfer?: ArrayBuffer[], signal?: AbortSignal): Promise<CoordinatorValueResult<unknown>>;
  storageCancel(targetRequestId: string): Promise<CoordinatorCommandResult>;
  storageSessionAbort(connectSessionId: string): Promise<CoordinatorCommandResult>;
  msfileControl(control: CoordinatorMsFileControl): Promise<CoordinatorValueResult<unknown>>;
  msfileGrant(context: MsFileConnectAppContext): Promise<CoordinatorValueResult<string>>;
  msfileData(data: CoordinatorMsFileData, transfer?: ArrayBuffer[], signal?: AbortSignal): Promise<CoordinatorValueResult<unknown>>;
  msfileCancel(targetRequestId: string): Promise<CoordinatorCommandResult>;
  msfileSessionAbort(connectSessionId: string): Promise<CoordinatorCommandResult>;
  windowP2pExecutorAcquire(ownerPublicKeyHex: string, executorPort?: MessagePort): Promise<CoordinatorValueResult<WindowP2pExecutorLease>>;
  windowP2pExecutorRelease(leaseId: string): Promise<CoordinatorCommandResult>;
  windowP2pExecutorSpikeTransfer(leaseId: string, expectedSessionEpoch: SessionEpoch, bytes: ArrayBuffer): Promise<CoordinatorValueResult<WindowP2pExecutorTransferResult>>;
  windowP2pExecutorSignNoiseStaticKey(request: Omit<WindowP2pNoiseSignRequest, "expectedSessionEpoch"> & { expectedSessionEpoch?: SessionEpoch }, signal?: AbortSignal): Promise<CoordinatorValueResult<WindowP2pIdentitySignResult>>;
  windowP2pExecutorSignPeerRecord(request: Omit<WindowP2pPeerRecordSignRequest, "expectedSessionEpoch"> & { expectedSessionEpoch?: SessionEpoch }, signal?: AbortSignal): Promise<CoordinatorValueResult<WindowP2pIdentitySignResult>>;
  /** 调用 SharedWorker 唯一 SatSubscription runtime；页面不直接持有 Sat K-V/连接。 */
  satOperation(operation: CoordinatorSatOperation, signal?: AbortSignal): Promise<CoordinatorValueResult<unknown>>;
  /** 调用 SharedWorker 唯一 Channel runtime；页面不直接持有 Sat K-V/连接或私钥。 */
  channelOperation(operation: CoordinatorChannelOperation, signal?: AbortSignal): Promise<CoordinatorValueResult<unknown>>;
  /** 读取 Coordinator 内唯一联系人在线状态快照；不会触发新的网络探测。 */
  contactsPresenceSnapshot(): Promise<CoordinatorValueResult<ContactPresenceMap>>;
  /** 读取 SharedWorker 唯一插件意图快照。 */
  pluginIntentSnapshot(): Promise<CoordinatorValueResult<PluginIntentSnapshot>>;
  /** 提交绝对启停意图；accepted 只表示 Worker 已持久化。 */
  pluginIntentSubmit(command: PluginIntentCommand): Promise<PluginIntentSubmissionResult>;
  p2pkhProvidersGet(): Promise<CoordinatorValueResult<P2pkhProviderRegistrySnapshot>>;
  p2pkhProvidersUpdate(network: "main" | "test", selection: P2pkhNetworkProviderSelection, expectedGeneration: number): Promise<CoordinatorCommandResult>;
  p2pkhSettingsUpdate(settings: { includeTestnet: boolean }): Promise<CoordinatorCommandResult>;
  p2pkhProviderConfigGet(providerId: string): Promise<CoordinatorValueResult<P2pkhProviderConfig>>;
  p2pkhProviderConfigUpdate(providerId: string, config: P2pkhProviderConfig): Promise<CoordinatorCommandResult>;
  p2pkhBroadcast(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number }): Promise<CoordinatorValueResult<unknown>>;
  p2pkhRebroadcastAncestors(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number }): Promise<CoordinatorValueResult<unknown>>;
  /** 页面活动心跳；不包含任何业务 RPC 权限。 */
  sendActivity(): void;
  /** 记录可恢复的 transport/业务失败，不抛到全局 UI。 */
  reportRecoverableCoordinatorFailure(kind: string, cause: unknown): void;
}

/** Coordinator 的共同只读/生命周期面。插件只能拿到自己的扩展接口。 */
export type CoordinatorSessionControl = Pick<SessionCoordinatorClient,
  "connect" | "getIsConnected" | "getConnectionState" | "getBootstrapSnapshot" | "getSessionEpoch" |
  "getActivePublicKeyHex" | "subscribeTopic" | "sendActivity"
>;

/** Storage 插件 Coordinator 面。 */
export type StorageCoordinatorControl = CoordinatorSessionControl & Pick<SessionCoordinatorClient,
  "storageControl" | "storageGrant" | "storageData" | "storageCancel" | "storageSessionAbort" | "refreshStorageBootstrap"
>;

/** Vault 插件 Coordinator 面。 */
export type VaultCoordinatorControl = CoordinatorSessionControl & Pick<SessionCoordinatorClient,
  "unlock" | "lock" | "activateKey" | "vaultOperation" | "crypto" | "backgroundCancelByKey"
>;

/** Background 插件 Coordinator 面；诊断回报在旧测试夹具中可缺省。 */
export type BackgroundCoordinatorControl = Pick<SessionCoordinatorClient,
  "getIsConnected" | "getConnectionState" | "subscribeTopic" |
  "backgroundRunNow" | "backgroundTrigger" | "backgroundCancel" |
  "backgroundCancelByKey" | "backgroundSettingsUpdate"
> & {
  reportRecoverableCoordinatorFailure?: SessionCoordinatorClient["reportRecoverableCoordinatorFailure"];
};

/** P2PKH/WOC/JungleBus 插件共享的 P2PKH 配置与广播面。 */
export type P2pkhCoordinatorControl = CoordinatorSessionControl & Pick<SessionCoordinatorClient,
  "p2pkhProvidersGet" | "p2pkhProvidersUpdate" | "p2pkhSettingsUpdate" |
  "p2pkhProviderConfigGet" | "p2pkhProviderConfigUpdate" |
  "p2pkhBroadcast" | "p2pkhRebroadcastAncestors"
>;

/** MSFile 插件 Coordinator 面。 */
export type MsFileCoordinatorControl = CoordinatorSessionControl & Pick<SessionCoordinatorClient,
  "msfileControl" | "msfileGrant" | "msfileData" | "msfileCancel" | "msfileSessionAbort"
>;

/** SatSubscription 插件 Coordinator 面。 */
export type SatCoordinatorControl = CoordinatorSessionControl & Pick<SessionCoordinatorClient,
  "satOperation" | "channelOperation"
>;

/** Window P2P 插件 Coordinator 面。 */
export type WindowP2pCoordinatorControl = CoordinatorSessionControl & Pick<SessionCoordinatorClient,
  "windowP2pExecutorAcquire" | "windowP2pExecutorRelease" |
  "windowP2pExecutorSpikeTransfer" | "windowP2pExecutorSignNoiseStaticKey" |
  "windowP2pExecutorSignPeerRecord"
>;

/** Protocol 插件只需要 Connect Channel 面。 */
export type ProtocolCoordinatorControl = CoordinatorSessionControl & Pick<SessionCoordinatorClient, "channelOperation">;

/** Contacts 插件只读取 Coordinator 维护的 presence 快照。 */
export type ContactsCoordinatorControl = Pick<SessionCoordinatorClient,
  "getIsConnected" | "getConnectionState" | "getBootstrapSnapshot" | "subscribeTopic" | "contactsPresenceSnapshot"
>;

// ============================================================
// 6. Capability Keys
// ============================================================

/**
 * @deprecated 仅保留给旧测试夹具；生产 Host 不再注入全局 Coordinator client。
 * 业务插件必须使用按 manifest 身份绑定的窄 capability。
 */
export const SESSION_COORDINATOR_CLIENT_CAPABILITY = defineCapability<SessionCoordinatorClient>({ kind: "local", id: "session-coordinator.client", version: "1" });
/** Shell 只读活动心跳面；不包含任何业务或存储控制 RPC。 */
export const COORDINATOR_ACTIVITY_CAPABILITY = defineCapability<Pick<SessionCoordinatorClient, "getIsConnected" | "sendActivity">>({ kind: "local", id: "session-coordinator.activity", version: "1" });
export const SESSION_COORDINATOR_SNAPSHOT_CAPABILITY = defineCapability<{ snapshot(): CoordinatorBootstrapSnapshot }>({ kind: "local", id: "session-coordinator.snapshot", version: "1" });
export const STORAGE_COORDINATOR_CONTROL_CAPABILITY = defineCapability<StorageCoordinatorControl>({ kind: "local", id: "storage.coordinator-control", version: "1" });
export const VAULT_COORDINATOR_CONTROL_CAPABILITY = defineCapability<VaultCoordinatorControl>({ kind: "local", id: "vault.coordinator-control", version: "1" });
export const BACKGROUND_COORDINATOR_CONTROL_CAPABILITY = defineCapability<BackgroundCoordinatorControl>({ kind: "local", id: "background.coordinator-control", version: "1" });
export const P2PKH_COORDINATOR_CONTROL_CAPABILITY = defineCapability<P2pkhCoordinatorControl>({ kind: "local", id: "p2pkh.coordinator-control", version: "1" });
export const WOC_COORDINATOR_CONTROL_CAPABILITY = defineCapability<P2pkhCoordinatorControl>({ kind: "local", id: "woc.coordinator-control", version: "1" });
export const JUNGLEBUS_COORDINATOR_CONTROL_CAPABILITY = defineCapability<P2pkhCoordinatorControl>({ kind: "local", id: "junglebus.coordinator-control", version: "1" });
export const MSFILE_COORDINATOR_CONTROL_CAPABILITY = defineCapability<MsFileCoordinatorControl>({ kind: "local", id: "msfile.coordinator-control", version: "1" });
export const SAT_COORDINATOR_CONTROL_CAPABILITY = defineCapability<SatCoordinatorControl>({ kind: "local", id: "sat.coordinator-control", version: "1" });
export const WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY = defineCapability<WindowP2pCoordinatorControl>({ kind: "local", id: "window-p2p.coordinator-control", version: "1" });
export const PROTOCOL_COORDINATOR_CONTROL_CAPABILITY = defineCapability<ProtocolCoordinatorControl>({ kind: "local", id: "protocol.coordinator-control", version: "1" });
export const CONTACTS_COORDINATOR_CONTROL_CAPABILITY = defineCapability<ContactsCoordinatorControl>({ kind: "local", id: "contacts.coordinator-control", version: "1" });
