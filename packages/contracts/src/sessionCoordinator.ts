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
import type { JSONValue, ChannelPrivateMessageEvent, ChannelOperationCaller } from "./channel.js";
import type { ContactPresenceMap } from "./contacts.js";
import type { I18nText } from "./i18n.js";
import type { BackgroundTaskProgress } from "./background.js";
import type { VaultSealedSecret } from "./vault.js";
import type {
  StorageAppContext,
  StorageProviderConfigDraft,
  StorageListResult,
  StorageDirectoryResult,
  StoragePutResult,
  StorageGetResult,
  StorageDeleteResult,
  StorageUploadBeginResult,
  StorageUploadPartResult,
  StorageUploadAbortResult,
  StorageConditionalCapabilityProbeResult,
  StorageProbeResult,
  StorageProviderSummary,
  StorageProviderConnectionView,
  StorageConditionalCapabilitiesView,
  StorageServiceStatus,
} from "./storage.js";
import type {
  P2pkhProviderSettings,
  P2pkhProviderRegistrySnapshot,
  P2pkhNetworkProviderSelection,
} from "./bsvP2pkhProviders.js";
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

// ============================================================
// 2. Client -> Coordinator RPC
// ============================================================

export type CoordinatorStorageControl =
  | { type: "status" }
  | { type: "summary" }
  | { type: "connection" }
  | { type: "probe"; config: StorageProviderConfigDraft }
  | { type: "activate"; config: StorageProviderConfigDraft; expectedProviderGeneration: number | null }
  | { type: "clear"; expectedProviderGeneration: number | null }
  | { type: "reset"; expectedProviderGeneration: number | null }
  | { type: "cancel-probe" }
  | { type: "capabilities" }
  | { type: "probe-capabilities" };

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
  | CoordinatorClientRequestWithMsfile
  | CoordinatorClientRequestWithWindowP2pExecutor
  | { kind: "sat.operation"; clientId: string; requestId: string; operation: CoordinatorSatOperation; expectedSessionEpoch: SessionEpoch }
  | { kind: "channel.operation"; clientId: string; requestId: string; operation: CoordinatorChannelOperation; expectedSessionEpoch: SessionEpoch }
  | { kind: "contacts.presence.snapshot"; clientId: string; requestId: string; expectedSessionEpoch: SessionEpoch }
  | ({ kind: "hello"; clientId: string; requestId: string }
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
    | { kind: "p2pkh.provider-config.update"; clientId: string; requestId: string; providerId: string; config: Record<string, unknown>; expectedSessionEpoch: SessionEpoch }
    | { kind: "p2pkh.broadcast"; clientId: string; requestId: string; ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number; expectedSessionEpoch: SessionEpoch }
    | { kind: "p2pkh.rebroadcast-ancestors"; clientId: string; requestId: string; ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number; expectedSessionEpoch: SessionEpoch }
    | { kind: "activity"; clientId: string });

/** Coordinator 订阅主题。 */
export type CoordinatorTopic = "session.state" | "background.snapshot" | "asset.data-changed" | "storage.state" | "p2pkh.providers" | "msfile.state" | "sat.events" | "channel.events" | "contacts.presence";

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
  | { type: "deleteKeyMaterial"; publicKeyHex: string }
  | { type: "verifyPassword"; password: string }
  | { type: "changePassword"; oldPassword: string; newPassword: string }
  | { type: "finalizeEmptyVaultAfterLastKeyDeletion" }
  | { type: "recoverEmptyVaultToUninitialized" }
  | { type: "generateKey"; password: string; label: string; capabilities?: string[] }
  | { type: "importPrivateKey"; password: string; label: string; material: { hex: string; wif?: string }; format: string; capabilities: string[]; source?: string }
  | { type: "exportKeyBackup"; publicKeyHex: string }
  | { type: "importKeyBackup"; backup: string; sourcePassword: string; targetPassword: string }
  | { type: "exportCurrentKeyBackup" }
  | { type: "listCurrentKeyPasskeys" }
  | { type: "listPasskeysForKey"; publicKeyHex: string }
  | { type: "prepareAddPasskeyToCurrentKey"; label: string }
  | { type: "addPasskeyToCurrentKey"; intentId: string; credentialIdB64: string; prfSaltB64: string; prfOutputHex: string; rpId: string; transports?: string[] }
  | { type: "removePasskeyFromCurrentKey"; passkeyId: string }
  | { type: "getPasskeyChallenge"; passkeyId: string }
  | { type: "activateKeyWithPasskey"; passkeyId: string; prfOutputHex: string }
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
  | { status: "error"; message: string; code?: import("./storage.js").StorageErrorCode | import("./msfile.js").MsFileErrorCode | SatErrorCode | WindowP2pExecutorError["code"] };

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
  | CoordinatorContactsPresenceEvent;

/** Coordinator 已验签并完成固定 inbox 分派的 Channel 事件。 */
export interface CoordinatorChannelStateEvent {
  topic: "channel.events";
  type: "channel.message.received";
  /** 事件序号，用于跨 Tab 去重和乱序防护。 */
  channelRevision: number;
  sessionEpoch: SessionEpoch;
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
  status: StorageServiceStatus;
  summary: StorageProviderSummary | null;
  capabilities: StorageConditionalCapabilitiesView | null;
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
}

export interface BackgroundSnapshotEvent {
  topic: "background.snapshot";
  type: "background.snapshot.changed";
  sessionEpoch: SessionEpoch;
  backgroundSnapshotRevision: number;
  snapshots: CoordinatorTaskSnapshot[];
  scheduleSettings?: CoordinatorBackgroundSyncSettings;
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
  snapshot: SessionStateEvent | BackgroundSnapshotEvent | AssetDataChangedEvent | CoordinatorStorageStateEvent | P2pkhProvidersEvent | CoordinatorMsFileStateEvent | CoordinatorSatStateEvent | CoordinatorChannelStateEvent | CoordinatorContactsPresenceEvent;
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
  sessionEpoch: SessionEpoch;
  vaultStatus: CoordinatorVaultStatus;
  activePublicKeyHex?: string;
  selectedPublicKeyHex?: string;
  keyspaceGeneration: number;
  taskSnapshots: CoordinatorTaskSnapshot[];
  scheduleSettings: CoordinatorBackgroundSyncSettings;
  p2pkhProviders?: P2pkhProviderRegistrySnapshot;
}

/** 任务快照。 */
export interface CoordinatorTaskSnapshot {
  id: string;
  pluginId: string;
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
  getBootstrapSnapshot(): CoordinatorBootstrapSnapshot;
  /** 返回当前会话代际；异步插件操作完成后用它判断结果是否仍属于原会话。 */
  getSessionEpoch(): SessionEpoch;
  /** 返回当前 active owner；异步插件操作完成后用它判断 owner 是否仍一致。 */
  getActivePublicKeyHex(): string | undefined;
  subscribeTopic(topic: CoordinatorTopic, listener: (event: any) => void): () => void;
  unlock(password: string, publicKeyHex?: string): Promise<CoordinatorCommandResult>;
  lock(): Promise<CoordinatorCommandResult>;
  activateKey(password: string, publicKeyHex: string): Promise<CoordinatorCommandResult>;
  vaultOperation(operation: CoordinatorVaultOperation | string, input?: unknown): Promise<CoordinatorValueResult<unknown>>;
  crypto(operation: CoordinatorCryptoOperation): Promise<{ ack: CoordinatorCommandResult; result?: CoordinatorCryptoResult }>;
  backgroundCancelByKey(publicKeyHex: string): Promise<CoordinatorCommandResult>;
  storageControl(control: CoordinatorStorageControl): Promise<CoordinatorValueResult<unknown>>;
  storageGrant(context: StorageAppContext): Promise<CoordinatorValueResult<string>>;
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
  /** 调用 SharedWorker 唯一 SatSubscription runtime；页面不直接持有 Sat DB/连接。 */
  satOperation(operation: CoordinatorSatOperation, signal?: AbortSignal): Promise<CoordinatorValueResult<unknown>>;
  /** 调用 SharedWorker 唯一 Channel runtime；页面不直接持有 Sat DB/连接或私钥。 */
  channelOperation(operation: CoordinatorChannelOperation, signal?: AbortSignal): Promise<CoordinatorValueResult<unknown>>;
  /** 读取 Coordinator 内唯一联系人在线状态快照；不会触发新的网络探测。 */
  contactsPresenceSnapshot(): Promise<CoordinatorValueResult<ContactPresenceMap>>;
  p2pkhProvidersGet(): Promise<CoordinatorValueResult<P2pkhProviderRegistrySnapshot>>;
  p2pkhProvidersUpdate(network: "main" | "test", selection: P2pkhNetworkProviderSelection, expectedGeneration: number): Promise<CoordinatorCommandResult>;
  p2pkhSettingsUpdate(settings: { includeTestnet: boolean }): Promise<CoordinatorCommandResult>;
  p2pkhProviderConfigGet(providerId: string): Promise<CoordinatorValueResult<Record<string, unknown>>>;
  p2pkhProviderConfigUpdate(providerId: string, config: Record<string, unknown>): Promise<CoordinatorCommandResult>;
  p2pkhBroadcast(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number }): Promise<CoordinatorValueResult<unknown>>;
  p2pkhRebroadcastAncestors(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number }): Promise<CoordinatorValueResult<unknown>>;
}

// ============================================================
// 6. Capability Keys
// ============================================================

export const SESSION_COORDINATOR_CLIENT_CAPABILITY = "session-coordinator.client";
export const SESSION_COORDINATOR_SNAPSHOT_CAPABILITY = "session-coordinator.snapshot";
