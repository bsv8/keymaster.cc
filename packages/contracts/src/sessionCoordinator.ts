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

/** 客户端请求联合类型。 */
export type CoordinatorClientRequest =
  | { kind: "hello"; clientId: string; requestId: string }
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
  | { kind: "activity"; clientId: string };

/** Coordinator 订阅主题。 */
export type CoordinatorTopic = "vault.lifecycle" | "keyspace.active-key" | "background.snapshot" | "asset.data-changed";

/** 受控 crypto 操作白名单。 */
export type CoordinatorCryptoOperation =
  | { type: "signDigest"; digestHex: string; format: EcdsaSignatureFormat }
  | { type: "deriveP2pkhAddress"; network: "main" | "test" }
  | { type: "sealSendInput"; input: { sender: { senderPublicKeyHex: string; senderOrigin?: string; senderAppId?: string }; recipient: { recipientPublicKeyHex: string; recipientOrigin?: string; recipientAppId?: string }; contentType: "text/plain" | "text/markdown"; body: string; clientMessageId: string; createdAtMs: number } }
  | { type: "openSealed"; record: unknown }
  | { type: "encryptVaultKeyMaterial"; plaintext: Uint8Array }
  | { type: "decryptVaultKeyMaterial"; ciphertext: Uint8Array };

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
  | { type: "deleteKey"; publicKeyHex: string; password: string }
  | { type: "deleteKeyMaterial"; publicKeyHex: string }
  | { type: "verifyPassword"; password: string }
  | { type: "changePassword"; oldPassword: string; newPassword: string }
  | { type: "finalizeEmptyVaultAfterLastKeyDeletion" }
  | { type: "recoverEmptyVaultToUninitialized" }
  | { type: "generateKey"; password: string; label: string; capabilities?: string[] }
  | { type: "importPrivateKey"; password: string; label: string; material: { hex: string; wif?: string }; format: string; capabilities: string[]; source?: string }
  | { type: "exportKeyBackup"; publicKeyHex: string }
  | { type: "importKeyBackup"; backup: string; sourcePassword: string; targetPassword: string };

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
  | { status: "error"; message: string };

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
  | { type: "openSealed"; plaintext: Uint8Array }
  | { type: "encryptVaultKeyMaterial"; ciphertext: Uint8Array }
  | { type: "decryptVaultKeyMaterial"; plaintext: Uint8Array };

// ============================================================
// 4. Coordinator -> Client Events
// ============================================================

/** Coordinator 推送事件联合类型。 */
export type CoordinatorTopicEvent =
  | VaultLifecycleEvent
  | KeyspaceActiveKeyEvent
  | BackgroundSnapshotEvent
  | AssetDataChangedEvent;

export interface VaultLifecycleEvent {
  topic: "vault.lifecycle";
  type: "vault.lifecycle.changed";
  sessionEpoch: SessionEpoch;
  vaultLifecycleRevision: number;
  status: CoordinatorVaultStatus;
  activePublicKeyHex?: string;
}

export interface KeyspaceActiveKeyEvent {
  topic: "keyspace.active-key";
  type: "keyspace.active-key.changed";
  sessionEpoch: SessionEpoch;
  activeKeyRevision: number;
  publicKeyHex: string | null;
  generation: number;
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

/** subscribe 的原子 baseline。每个 topic 的 revision 独立递增。 */
export interface CoordinatorTopicBaseline {
  topic: CoordinatorTopic;
  baselineRevision: number;
  sessionEpoch: SessionEpoch;
  snapshot: VaultLifecycleEvent | KeyspaceActiveKeyEvent | BackgroundSnapshotEvent | AssetDataChangedEvent;
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

// ============================================================
// 6. Capability Keys
// ============================================================

export const SESSION_COORDINATOR_CLIENT_CAPABILITY = "session-coordinator.client";
export const SESSION_COORDINATOR_SNAPSHOT_CAPABILITY = "session-coordinator.snapshot";
