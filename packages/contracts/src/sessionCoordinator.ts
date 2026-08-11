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
import type { I18nText } from "./i18n.js";
import type { BackgroundTaskProgress } from "./background.js";
import type { VaultSealedSecret } from "./vault.js";
import type { ProviderSealedMessageRecord } from "./messageProvider.js";
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

export type CoordinatorClientRequest =
  | CoordinatorClientRequestWithStorage
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
    | { kind: "activity"; clientId: string });

/** Coordinator 订阅主题。 */
export type CoordinatorTopic = "session.state" | "background.snapshot" | "asset.data-changed" | "storage.state";

/** 受控 crypto 操作白名单。 */
export type CoordinatorCryptoOperation =
  | { type: "signDigest"; digestHex: string; format: EcdsaSignatureFormat }
  | { type: "deriveP2pkhAddress"; network: "main" | "test" }
  | { type: "sealSendInput"; input: { sender: { senderPublicKeyHex: string; senderOrigin?: string; senderAppId?: string }; recipient: { recipientPublicKeyHex: string; recipientOrigin?: string; recipientAppId?: string }; contentType: "text/plain" | "text/markdown"; body: string; clientMessageId: string; createdAtMs: number } }
  | { type: "openSealed"; record: ProviderSealedMessageRecord };

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
  | { status: "error"; message: string; code?: import("./storage.js").StorageErrorCode };

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
};

export type CoordinatorCommandResult = CoordinatorCommandAck | CoordinatorTransportFailure;

export type CoordinatorValueResult<T> =
  | { status: "ok"; value: T; sessionEpoch: SessionEpoch }
  | Exclude<CoordinatorCommandResult, { status: "ok" }>;

/** Crypto 操作结果。 */
export type CoordinatorCryptoResult =
  | { type: "signDigest"; signatureHex: string; format: EcdsaSignatureFormat }
  | { type: "deriveP2pkhAddress"; address: string }
  | { type: "sealSendInput"; envelope: Uint8Array; signature: Uint8Array }
  | { type: "openSealed"; plaintext: Uint8Array };

// ============================================================
// 4. Coordinator -> Client Events
// ============================================================

/** Coordinator 推送事件联合类型。 */
export type CoordinatorTopicEvent =
  | SessionStateEvent
  | BackgroundSnapshotEvent
  | AssetDataChangedEvent
  | CoordinatorStorageStateEvent;

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
  snapshot: SessionStateEvent | BackgroundSnapshotEvent | AssetDataChangedEvent | CoordinatorStorageStateEvent;
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
}

// ============================================================
// 6. Capability Keys
// ============================================================

export const SESSION_COORDINATOR_CLIENT_CAPABILITY = "session-coordinator.client";
export const SESSION_COORDINATOR_SNAPSHOT_CAPABILITY = "session-coordinator.snapshot";
