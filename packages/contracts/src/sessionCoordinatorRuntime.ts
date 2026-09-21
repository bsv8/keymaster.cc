// Coordinator 与 WebLoom Runtime 之间的 typed capability 契约。
//
// 这里是 Keymaster 领域 DTO 的唯一 Runtime 边界：manifest 只携带 capability
// descriptor，parser/transfer extractor 留在各自 realm。Coordinator client 和
// Worker handler 都从这些对象取得请求、结果及流 item 类型。

import {
  defineCapability,
  type ValueParser,
} from "webloom-framework";
import { BACKGROUND_SYNC_INTERVAL_OPTIONS_MS } from "./background.js";
import type {
  CoordinatorClientRequest,
  CoordinatorCommandAck,
  CoordinatorCryptoOperation,
  CoordinatorCryptoResult,
  CoordinatorResponse,
  CoordinatorTopic,
  CoordinatorTopicEvent,
  CoordinatorBootstrapSnapshot,
  CoordinatorSessionOpenResult,
  CoordinatorSessionBinding,
  SessionEpoch,
  CoordinatorAuthorityRecovery,
  CoordinatorWorkerUnitSnapshot,
  P2pkhProviderConfig,
  CoordinatorTaskSnapshot,
  SessionStateEvent,
  BackgroundSnapshotEvent,
  AssetDataChangedEvent,
  CoordinatorStorageStateEvent,
  CoordinatorMsFileStateEvent,
  CoordinatorWorkerUnitStateEvent,
  CoordinatorChannelStateEvent,
  CoordinatorContactsPresenceEvent,
  PluginIntentStateEvent,
  CoordinatorChannelOperation,
  CoordinatorStorageControl,
  CoordinatorStorageData,
  CoordinatorMsFileControl,
  CoordinatorMsFileData,
  CoordinatorVaultOperation,
  CoordinatorBackgroundSyncSettings,
  WindowP2pExecutorLease,
  WindowP2pExecutorTransferResult,
  WindowP2pIdentitySignResult,
} from "./sessionCoordinator.js";
import type { ChannelOperationCaller, ChannelPublishResult, ChannelSubscriptionSetResult, ChannelSubscriptionStatus, JSONValue } from "./channel.js";
import type { I18nText, I18nValues } from "./i18n.js";
import type { ContactPresenceMap } from "./contacts.js";
import type { P2pkhBroadcastResult, P2pkhBroadcastSubmission, P2pkhUtxoSnapshotResult } from "./bsvP2pkhProviders.js";
import type {
  CoordinatorSatEvent,
  CoordinatorSatStateEvent,
  SatIncomingPublish,
  CoordinatorSatOperation,
  SatOwnerSupplierSettingsV1,
  SatSupplierConfigV1,
} from "./satSubscription.js";
import type { AppIdentitySnapshot } from "./appIdentity.js";
import type { PluginStorageDeclaration } from "./storage/access.js";
import { validatePluginStorageDeclaration } from "./storage/access.js";
import type {
  MsFileAppIdentityKey,
  MsFileAppPriceOverrideUpdate,
  MsFileApprovalDecision,
  MsFileConnectAppContext,
  MsFileGlobalPriceSettings,
  MsFileSupplierConfig,
} from "./msfile.js";
import {
  MSFILE_MAX_BLOCK_BYTES,
  isValidMsFileHashHex,
  isValidMsFileSupplierPublicKeyHex,
  normalizeMsFileSatoshiAmount,
} from "./msfile.js";
import type {
  CoordinatorOwnerStorageData,
  CoordinatorPlatformStorageData,
  StorageOwnerGrant,
  StoragePlatformGrant,
} from "./storage/internal.js";
import type { StorageBootstrapState, StorageProviderConfigDraft, StorageConnection, StorageSecretUpdate, StorageProviderId } from "./storage/profile.js";
import type {
  StorageDeleteResult,
  StorageDirectoryResult,
  StorageGetResult,
  StorageListResult,
  StoragePutResult,
  StorageUploadAbortResult,
  StorageUploadBeginResult,
  StorageUploadPartResult,
} from "./connectStorage.js";
import type {
  StorageBucketConnectionConfigV1,
  ExistingRemoteStorageConnectPlan,
  ExistingRemoteStorageConnectResult,
  InitialSetupPlan,
  InitialSetupResult,
  InitialSetupRecoveryResult,
  StorageBucketSwitchResultV1,
} from "./storage/catalog.js";
import type { StorageRuntimeBucketV1 } from "./storage/profile.js";
import type { DeviceCapabilitiesV1, DeviceRecordV1 } from "./storage/device.js";
import { validateDeviceRecord } from "./storage/device.js";
import type { KeymasterSessionV1, KeymasterSessionKeyDerivationV1 } from "./storage/session.js";
import { validateKeymasterSession, validateKeymasterSessionKeyDerivation } from "./storage/session.js";
import type { StorageBucketWriteCondition } from "./storage/bucket.js";
import type { InitialSetupRecoveryRecordV1 } from "./storage/catalog.js";
import { STORAGE_MAX_PARTS, STORAGE_MAX_PAYLOAD_BYTES, STORAGE_PART_SIZE_BYTES } from "./storage/kv.js";
import type { KeyValueCommitResult, KeyValueEntry, KeyValueEntryMeta, KeyValueListResult, KeyValueValue } from "./storage/kv.js";
import type { PluginIntentCommand, PluginIntentSnapshot, PluginIntentSubmissionResult } from "webloom-framework";
import type { BucketConditionalCapabilityProbeResult, BucketConditionalCapabilitiesView, StorageActivationResult, StorageProviderConnectionView, StorageProbeResult, StorageProviderSummary, StorageRuntimeControllerStatus, StorageRuntimeStatus, StorageSelectedResult } from "./storage/runtime.js";
import type {
  KeyRef,
  VaultSealedSecret,
} from "./vault.js";
import type {
  MsFileAppAuthorizationView,
  MsFileReadConcurrencySettings,
  MsFileReadResult,
  MsFileServiceStatus,
  MsFileSettingsSnapshot,
  MsFileStatResult,
  MsFileSupplierProbeResult,
} from "./msfile.js";
import type {
  SatCollectResult,
  SatSpiInformation,
  SatSubscriptionSettingsSnapshot,
  SatTopUpPreview,
  SatTopUpResult,
} from "./satSubscription.js";
import type { BinaryField } from "./protocol.js";
import type { KeymasterScopeKind } from "./keymasterLifecycle.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.getOwnPropertyNames(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && descriptor.enumerable && "value" in descriptor);
  });
}

function text(value: unknown, field: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`Coordinator ${field} is invalid`);
  }
  return value;
}

function integer(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`Coordinator ${field} is invalid`);
  }
  return value as number;
}

const COORDINATOR_REQUEST_KINDS = new Set<string>([
  "session.open", "session.close", "session.activity",
  "unlock", "lock", "activate-key", "vault.operation", "crypto",
  "background.run-now", "background.trigger", "background.cancel", "background.cancel-by-key",
  "background.settings.update", "storage.grant", "storage.control", "storage.data",
  "storage.cancel", "storage.session.abort", "storage.owner.bind", "storage.platform.bind",
  "storage.owner.data", "storage.platform.data", "storage.owner.delete", "msfile.control",
  "msfile.grant", "msfile.data", "msfile.cancel", "msfile.session.abort",
  "window-p2p.executor.acquire", "window-p2p.executor.release", "window-p2p.executor.spike.transfer",
  "window-p2p.executor.identity.sign-noise", "window-p2p.executor.identity.sign-peer-record",
  "sat.operation", "channel.operation", "channel.cancel", "contacts.presence.snapshot",
  "plugin.intent.snapshot", "plugin.intent.submit", "p2pkh.settings.update", "p2pkh.provider-config.get", "p2pkh.provider-config.update",
  "p2pkh.utxos.get", "p2pkh.utxos.refresh",
  "p2pkh.broadcast",
]);

const STORAGE_CONTROL_TYPES = [
  "probe-bucket",
  "status", "summary", "connection", "unlock-bucket", "initial-setup", "connect-existing-remote",
  "initial-setup-result", "initial-setup-recovery-list", "initial-setup-cleanup",
  "switch-bucket",
  "change-bucket-config", "rename-bucket", "delete-local-bucket-key", "retry",
  "cancel-probe",
  "capabilities", "probe-capabilities", "cold-export",
] as const satisfies readonly CoordinatorStorageControl["type"][];

const STORAGE_DATA_TYPES = [
  "list", "create-directory", "delete-directory", "put", "get-range", "delete",
  "begin-upload", "upload-part", "complete-upload", "abort-upload",
] as const satisfies readonly CoordinatorStorageData["type"][];

const VAULT_OPERATION_TYPES = [
  "createVault", "createVaultWithInitialKey", "createVaultWithImportedKey", "listKeys", "getKey",
  "setActive", "deleteKey", "verifyPassword", "changePassword", "generateKey", "importPrivateKey",
  "exportKeyBackup", "exportCurrentKeyBackup", "importKeyBackup", "sealLocalSecret",
  "openLocalSecret", "finalizeEmptyVaultAfterLastKeyDeletion", "recoverEmptyVaultToUninitialized",
] as const satisfies readonly CoordinatorVaultOperation["type"][];

const CHANNEL_OPERATION_TYPES = [
  "publish", "hash-request-publish", "private-publish", "open-private-envelope", "subscription-set", "release",
] as const satisfies readonly CoordinatorChannelOperation["type"][];

type CoordinatorCommandRequest = Exclude<
  CoordinatorClientRequest,
  { kind: "hello" | "subscribe" | "activity" | "disconnect" }
>;

/** 绑定一个 WebLoom peer 的显式会话打开请求；不携带 peer/client 身份。 */
export interface CoordinatorSessionOpenRequest {
  kind: "session.open";
  /** 页面为本次 physical peer 分配的 LocalStorage bridge lease。 */
  leaseId: string;
  /** 当前 Storage 绑定（由页面从 session + 设备记录组装）。 */
  storageBootstrapState?: StorageBootstrapState;
}

/** 关闭由 Runtime peer 生命周期承载的 Coordinator 会话。 */
export interface CoordinatorSessionCloseRequest {
  kind: "session.close";
  /** 必须完整回传 session.open 发放的 binding；缺失时 fail-closed。 */
  peerGeneration: number;
  sessionEpoch: string;
  leaseId: string;
}

/** 页面活动心跳也走同一 typed RPC；不再发送裸 activity 消息。 */
export interface CoordinatorSessionActivityRequest {
  kind: "session.activity";
}

/** 去掉 transport 身份头；peerId/operationId 由 WebLoom 绑定，不能由请求伪造。 */
export type CoordinatorRpcRequest = CoordinatorSessionOpenRequest | CoordinatorSessionCloseRequest | CoordinatorSessionActivityRequest | (CoordinatorCommandRequest extends infer Request
  ? Request extends { clientId: string; requestId: string }
    ? Omit<Request, "clientId" | "requestId">
    : never
  : never);

/** RPC 结果不再复制框架 callId；领域只保留会话世代和业务结果。 */
export type CoordinatorRpcResponse = Omit<CoordinatorResponse, "requestId">;

export type CoordinatorRpcRequestKind = CoordinatorRpcRequest["kind"];
export type CoordinatorRpcRequestFor<K extends CoordinatorRpcRequestKind> = Extract<CoordinatorRpcRequest, { kind: K }>;
export type CoordinatorClientCommandRequest = Exclude<CoordinatorClientRequest, { kind: "hello" | "subscribe" | "activity" | "disconnect" }>;

/** 依据 Vault 内层操作 discriminant 收窄 operationResult。 */
export type CoordinatorVaultOperationResultFor<O extends CoordinatorVaultOperation> =
  O extends { type: "createVault" } ? true :
  O extends { type: "createVaultWithInitialKey" | "createVaultWithImportedKey" | "generateKey" | "importPrivateKey" | "importKeyBackup" } ? CoordinatorVaultKeyView :
  O extends { type: "listKeys" } ? CoordinatorVaultKeyView[] :
  O extends { type: "getKey" } ? CoordinatorVaultKeyView | undefined :
  O extends { type: "setActive" | "deleteKey" | "verifyPassword" | "changePassword" | "finalizeEmptyVaultAfterLastKeyDeletion" | "recoverEmptyVaultToUninitialized" } ? true :
  O extends { type: "exportKeyBackup" | "exportCurrentKeyBackup" } ? string :
  O extends { type: "sealLocalSecret" } ? VaultSealedSecret :
  O extends { type: "openLocalSecret" } ? Uint8Array :
  never;

/** 依据 storage.control 内层 control discriminant 收窄 operationResult。 */
export type CoordinatorStorageControlResultFor<C extends CoordinatorStorageControl> =
  C extends { type: "status" | "retry" } ? StorageRuntimeControllerStatus | StorageRuntimeStatus :
  C extends { type: "summary" } ? StorageProviderSummary | null :
  C extends { type: "connection" } ? StorageProviderConnectionView | null :
  C extends { type: "initial-setup" } ? InitialSetupResult :
  C extends { type: "connect-existing-remote" } ? ExistingRemoteStorageConnectResult :
  C extends { type: "initial-setup-result" } ? InitialSetupResult | undefined :
  C extends { type: "initial-setup-recovery-list" } ? InitialSetupRecoveryRecordV1[] :
  C extends { type: "initial-setup-cleanup" } ? InitialSetupRecoveryResult :
  C extends { type: "switch-bucket" } ? StorageBucketSwitchResultV1 :
  C extends { type: "change-bucket-config" | "rename-bucket" } ? import("./storage/profile.js").StorageRuntimeBucketV1 :
  C extends { type: "unlock-bucket" } ? CoordinatorStorageUnlockBucketResult :
  C extends { type: "delete-local-bucket-key" } ? undefined :
  C extends { type: "cold-export" } ? Uint8Array :
  C extends { type: "capabilities" } ? BucketConditionalCapabilitiesView | null :
  C extends { type: "probe-capabilities" } ? BucketConditionalCapabilityProbeResult :
  C extends { type: "cancel-probe" } ? undefined :
  never;

/** 依据 storage.data 内层 data discriminant 收窄 operationResult。 */
export type CoordinatorStorageDataResultFor<D extends CoordinatorStorageData> =
  D extends { type: "list" } ? StorageListResult :
  D extends { type: "create-directory" | "delete-directory" } ? StorageDirectoryResult :
  D extends { type: "put" } ? StoragePutResult :
  D extends { type: "get-range" } ? StorageGetResult :
  D extends { type: "delete" } ? StorageDeleteResult :
  D extends { type: "begin-upload" } ? StorageUploadBeginResult :
  D extends { type: "upload-part" } ? StorageUploadPartResult :
  D extends { type: "complete-upload" } ? StoragePutResult :
  D extends { type: "abort-upload" } ? StorageUploadAbortResult :
  never;

/** 依据 msfile.control 内层 control discriminant 收窄 operationResult。 */
export type CoordinatorMsFileControlResultFor<C extends CoordinatorMsFileControl> =
  C extends { type: "settings.get" } ? MsFileSettingsSnapshot :
  C extends { type: "settings.readConcurrency.get" } ? MsFileReadConcurrencySettings :
  C extends { type: "settings.readConcurrency.update" | "settings.readConcurrency.reset" | "settings.mediaBlockReadConcurrency.update" | "settings.global.update" | "supplier.upsert" | "supplier.delete" | "app-policy.update" | "app-policy.clear" | "approval.resolve" } ? null :
  C extends { type: "settings.mediaBlockReadConcurrency.get" } ? number :
  C extends { type: "supplier.probe" } ? MsFileSupplierProbeResult :
  C extends { type: "app-authorizations.list" } ? MsFileAppAuthorizationView[] :
  C extends { type: "approvals.pending" } ? CoordinatorMsFileStateEvent["pendingApprovals"] :
  C extends { type: "bucket.put-block" } ? null :
  C extends { type: "bucket.get-block" } ? ArrayBuffer :
  never;

/** 依据 msfile.data 内层 data discriminant 收窄 operationResult。 */
export type CoordinatorMsFileDataResultFor<D extends CoordinatorMsFileData> =
  D extends { type: "stat" } ? MsFileStatResult :
  D extends { type: "read-seed" | "read-block" } ? MsFileReadResult :
  never;

/** 依据 Sat operation discriminant 收窄 operationResult。 */
export type CoordinatorSatOperationResultFor<O extends CoordinatorSatOperation> =
  O extends { type: "ensure" | "admin.upsertSupplier" | "admin.deleteSupplier" | "admin.setOwnerSettings" } ? null :
  O extends { type: "admin.getSettings" } ? SatSubscriptionSettingsSnapshot :
  O extends { type: "admin.refreshSubscriptions" } ? CoordinatorSatRefreshSubscriptionsResult :
  O extends { type: "admin.getBilling" } ? import("./satSubscription.js").SatBillingPage :
  O extends { type: "service.publish" } ? CoordinatorSatPublishResult :
  O extends { type: "spi.getInformation" } ? SatSpiInformation :
  O extends { type: "spi.prepareTopUp" } ? SatTopUpPreview :
  O extends { type: "spi.submitTopUp" } ? SatTopUpResult :
  O extends { type: "spi.collectNew" | "spi.retryCollect" | "spi.collect" } ? SatCollectResult :
  never;

/** 依据 Channel operation discriminant 收窄 operationResult。 */
export type CoordinatorChannelOperationResultFor<O extends CoordinatorChannelOperation> =
  O extends { type: "publish" | "hash-request-publish" | "private-publish" } ? ChannelPublishResult :
  O extends { type: "open-private-envelope" } ? import("./channel.js").OpenedPrivateEnvelope :
  O extends { type: "subscription-set" } ? ChannelSubscriptionSetResult :
  O extends { type: "release" } ? null :
  never;

/** 依据内部 owner/platform 数据操作 discriminant 收窄 operationResult。 */
export type CoordinatorOwnerStorageResultFor<D extends CoordinatorOwnerStorageData | CoordinatorPlatformStorageData> =
  D extends { type: "owner.get" | "platform.get" } ? KeyValueEntry<unknown> | undefined :
  D extends { type: "owner.list" | "platform.list" } ? KeyValueListResult :
  D extends { type: "owner.put" | "platform.put" } ? KeyValueEntryMeta :
  D extends { type: "owner.delete" | "platform.delete" } ? undefined :
  D extends { type: "owner.commit" | "platform.commit" } ? KeyValueCommitResult :
  D extends { type: "owner.file-list" } ? import("./storage/files.js").OwnerFileListPage :
  D extends { type: "owner.file-get" } ? import("./storage/files.js").OwnerFileObject | undefined :
  D extends { type: "owner.file-put" } ? { etag?: string; lastModified?: string } :
  D extends { type: "owner.file-delete" } ? undefined :
  never;

/** 依据 Coordinator crypto operation discriminant 收窄 cryptoResult。 */
export type CoordinatorCryptoResultFor<O extends CoordinatorCryptoOperation> =
  O extends { type: "signDigest" } ? Extract<CoordinatorCryptoResult, { type: "signDigest" }> :
  O extends { type: "deriveP2pkhAddress" } ? Extract<CoordinatorCryptoResult, { type: "deriveP2pkhAddress" }> :
  never;

/**
 * 仅包含 Coordinator 对页面公开的 Vault key 元数据；私钥和 KeyHold 文档
 * 永远不会成为 RPC operationResult。这个形状与 Worker 的 `toPublicKey`
 * 投影一致，而不是把 Vault 内部记录直接暴露给 wire parser。
 */
export type CoordinatorVaultKeyView = Pick<KeyRef, "publicKeyHex" | "label" | "capabilities" | "createdAt"> & {
  address?: string;
  network?: "main" | "test";
  format: string;
  source?: string;
};

/** Vault operation 的可序列化结果联合；按操作内部 discriminant 解析。 */
export type CoordinatorVaultOperationResult =
  | boolean
  | string
  | Uint8Array
  | undefined
  | VaultSealedSecret
  | CoordinatorVaultKeyView
  | CoordinatorVaultKeyView[]
  | { intentId: string; publicKeyHex: string };

export type CoordinatorStorageUnlockBucketResult =
  | { ok: true; vaultUnlocked: boolean }
  | { ok: false; diagnostic: string };

/** storage.control 各 control type 的 operationResult 总联合。 */
export type CoordinatorStorageControlResult = CoordinatorStorageControlResultFor<CoordinatorStorageControl>;

export type CoordinatorStorageDataResult = CoordinatorStorageDataResultFor<CoordinatorStorageData> | undefined;

export type CoordinatorMsFileControlResult =
  | MsFileServiceStatus
  | CoordinatorMsFileControlResultFor<CoordinatorMsFileControl>
  | undefined;

export type CoordinatorMsFileDataResult = CoordinatorMsFileDataResultFor<CoordinatorMsFileData> | undefined;

export type CoordinatorSatPublishResult = { requestIdHex: string; chargedAmount: string };
export type CoordinatorSatRefreshSubscriptionsResult = { channels: string[]; chargedAmount: string };
export type CoordinatorSatOperationResult = CoordinatorSatOperationResultFor<CoordinatorSatOperation>;

export type CoordinatorChannelOperationResult = CoordinatorChannelOperationResultFor<CoordinatorChannelOperation>;

export type CoordinatorP2pkhBroadcastResult =
  | P2pkhBroadcastResult
  | { status: "not-dispatched"; reason: "stale-provider-generation" | "broadcast-provider-unavailable" | "coordinator-not-dispatched" | "stale-session-epoch" }
  | { status: "isolated"; txid: string; reason: string; providerId?: string }
  | { status: "local-confirmed" | "already-known"; txid: string; providerId?: string };

/**
 * Request/result association for the complete request, including nested
 * operation/control/data discriminants. The outer `kind` is not sufficient
 * for a single Coordinator capability because several kinds multiplex many
 * unrelated result DTOs.
 */
export type CoordinatorRpcResultForRequest<R extends CoordinatorRpcRequest> =
  R extends { kind: "session.open" } ? CoordinatorSessionOpenResult :
  R extends { kind: "vault.operation"; operation: infer O } ? O extends CoordinatorVaultOperation ? CoordinatorVaultOperationResultFor<O> : never :
  R extends { kind: "storage.control"; control: infer C } ? C extends CoordinatorStorageControl ? CoordinatorStorageControlResultFor<C> : never :
  R extends { kind: "storage.data"; data: infer D } ? D extends CoordinatorStorageData ? CoordinatorStorageDataResultFor<D> : never :
  R extends { kind: "storage.owner.data"; data: infer D } ? D extends CoordinatorOwnerStorageData ? CoordinatorOwnerStorageResultFor<D> : never :
  R extends { kind: "storage.platform.data"; data: infer D } ? D extends CoordinatorPlatformStorageData ? CoordinatorOwnerStorageResultFor<D> : never :
  R extends { kind: "storage.grant" } ? string :
  R extends { kind: "storage.owner.bind" } ? StorageOwnerGrant :
  R extends { kind: "storage.platform.bind" } ? StoragePlatformGrant :
  R extends { kind: "storage.owner.delete" } ? true :
  R extends { kind: "msfile.control"; control: infer C } ? C extends CoordinatorMsFileControl ? CoordinatorMsFileControlResultFor<C> : never :
  R extends { kind: "msfile.data"; data: infer D } ? D extends CoordinatorMsFileData ? CoordinatorMsFileDataResultFor<D> : never :
  R extends { kind: "msfile.grant" } ? string :
  R extends { kind: "window-p2p.executor.acquire" } ? WindowP2pExecutorLease :
  R extends { kind: "window-p2p.executor.spike.transfer" } ? WindowP2pExecutorTransferResult :
  R extends { kind: "window-p2p.executor.identity.sign-noise" | "window-p2p.executor.identity.sign-peer-record" } ? WindowP2pIdentitySignResult :
  R extends { kind: "sat.operation"; operation: infer O } ? O extends CoordinatorSatOperation ? CoordinatorSatOperationResultFor<O> : never :
  R extends { kind: "channel.operation"; operation: infer O } ? O extends CoordinatorChannelOperation ? CoordinatorChannelOperationResultFor<O> : never :
  R extends { kind: "contacts.presence.snapshot" } ? ContactPresenceMap :
  R extends { kind: "plugin.intent.snapshot" } ? PluginIntentSnapshot :
  R extends { kind: "plugin.intent.submit" } ? PluginIntentSubmissionResult :
  R extends { kind: "p2pkh.utxos.get" | "p2pkh.utxos.refresh" } ? P2pkhUtxoSnapshotResult :
  R extends { kind: "p2pkh.provider-config.get" } ? P2pkhProviderConfig :
  R extends { kind: "p2pkh.broadcast" } ? CoordinatorP2pkhBroadcastResult :
  undefined;

/** A client command after removing transport-owned clientId/requestId. */
export type CoordinatorRpcRequestFromClient<R extends CoordinatorClientCommandRequest> =
  R extends CoordinatorClientCommandRequest ? Omit<R, "clientId" | "requestId"> : never;

export type CoordinatorRpcResultFor<K extends CoordinatorRpcRequestKind> = CoordinatorRpcResultForRequest<CoordinatorRpcRequestFor<K>>;

type CoordinatorRpcResponseBase = Omit<CoordinatorRpcResponse, "operationResult" | "cryptoResult">;
type CoordinatorRpcNonOkResponse = CoordinatorRpcResponseBase & {
  ack: Exclude<CoordinatorCommandAck, { status: "ok" }>;
  operationResult?: never;
  cryptoResult?: never;
};
type CoordinatorRpcVoidSuccessResponse = CoordinatorRpcResponseBase & {
  ack: { status: "ok" };
  operationResult?: never;
  cryptoResult?: never;
};
type CoordinatorRpcValueSuccessResponse<R extends CoordinatorRpcRequest> = CoordinatorRpcResponseBase & {
  ack: { status: "ok" };
  operationResult: CoordinatorRpcResultForRequest<R>;
  cryptoResult?: never;
};
type CoordinatorRpcCryptoSuccessResponse<O extends CoordinatorCryptoOperation> = CoordinatorRpcResponseBase & {
  ack: { status: "ok" };
  operationResult?: never;
  cryptoResult: CoordinatorCryptoResultFor<O>;
};

type CoordinatorRpcVoidRequest =
  | Extract<CoordinatorRpcRequest, {
    kind:
      | "session.close"
      | "session.activity"
      | "unlock"
      | "lock"
      | "activate-key"
      | "background.run-now"
      | "background.trigger"
      | "background.cancel"
      | "background.cancel-by-key"
      | "background.settings.update"
      | "storage.cancel"
      | "storage.session.abort"
      | "msfile.cancel"
      | "msfile.session.abort"
      | "window-p2p.executor.release"
      | "channel.cancel"
      | "p2pkh.settings.update"
      | "p2pkh.provider-config.update"
  }>
  | (Extract<CoordinatorRpcRequest, { kind: "storage.control" }> & {
    control: Extract<CoordinatorStorageControl, { type: "cancel-probe" | "clear" | "reset" }>;
  })
  | (Extract<CoordinatorRpcRequest, { kind: "storage.owner.data" }> & {
    data: Extract<CoordinatorOwnerStorageData, { type: "owner.delete" }>;
  })
  | (Extract<CoordinatorRpcRequest, { kind: "storage.platform.data" }> & {
    data: Extract<CoordinatorPlatformStorageData, { type: "platform.delete" }>;
  });

/**
 * Response typing mirrors the wire validator:
 * - successful value requests must carry their request-specific result;
 * - successful void requests must not carry a result;
 * - non-ok responses never carry a result;
 * - crypto has its own result field and never uses operationResult.
 */
export type CoordinatorRpcResponseForRequest<R extends CoordinatorRpcRequest> =
  R extends { kind: "crypto"; operation: infer O }
    ? O extends CoordinatorCryptoOperation
      ? CoordinatorRpcCryptoSuccessResponse<O> | CoordinatorRpcNonOkResponse
      : never
    : R extends CoordinatorRpcVoidRequest
      ? CoordinatorRpcVoidSuccessResponse | CoordinatorRpcNonOkResponse
      : CoordinatorRpcValueSuccessResponse<R> | CoordinatorRpcNonOkResponse;

export type CoordinatorRpcResponseFor<K extends CoordinatorRpcRequestKind> = CoordinatorRpcResponseForRequest<CoordinatorRpcRequestFor<K>>;

function expectRecord(value: unknown, field: string): RecordValue {
  if (!record(value)) throw new TypeError(`Coordinator ${field} must be an object`);
  return value;
}

function optionalText(value: unknown, field: string, maximum = 4_096): string | undefined {
  if (value === undefined) return undefined;
  return text(value, field, maximum);
}

function optionalFilePathPrefix(value: unknown, field: string, maximum = 4_096): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) throw new TypeError(`Coordinator ${field} is invalid`);
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`Coordinator ${field} is invalid`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  return booleanValue(value, field);
}

function boundedNumber(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`Coordinator ${field} is invalid`);
  }
  return value as number;
}

function optionalBoundedNumber(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  return boundedNumber(value, field, minimum, maximum);
}

function nullableBoundedNumber(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (value === null) return null;
  return boundedNumber(value, field, minimum, maximum);
}

function stringList(value: unknown, field: string, maximumItems = 256, maximumLength = 4_096): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new TypeError(`Coordinator ${field} is invalid`);
  return value.map((item, index) => text(item, `${field}[${index}]`, maximumLength));
}

function optionalStringList(value: unknown, field: string, maximumItems = 256, maximumLength = 4_096): string[] | undefined {
  if (value === undefined) return undefined;
  return stringList(value, field, maximumItems, maximumLength);
}

function arrayBufferValue(value: unknown, field: string): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) throw new TypeError(`Coordinator ${field} must be an ArrayBuffer`);
  return value;
}

function uint8ArrayValue(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`Coordinator ${field} must be a Uint8Array`);
  return value.slice();
}

function isMessagePortLike(value: unknown): value is MessagePort {
  // `instanceof` is not reliable when a port crossed a Worker realm. The
  // structural check is followed by structured-clone transfer validation in
  // WebLoom, so an ordinary object cannot become an executable capability just
  // by having a single `postMessage` property.
  return Boolean(value) && typeof value === "object"
    && typeof (value as { postMessage?: unknown }).postMessage === "function"
    && typeof (value as { start?: unknown }).start === "function"
    && typeof (value as { close?: unknown }).close === "function"
    && typeof (value as { addEventListener?: unknown }).addEventListener === "function"
    && typeof (value as { removeEventListener?: unknown }).removeEventListener === "function";
}

function messagePortValue(value: unknown, field: string): MessagePort {
  if (!isMessagePortLike(value)) {
    throw new TypeError(`Coordinator ${field} must be a MessagePort`);
  }
  return value;
}

function parseJsonValue(value: unknown, field: string, depth = 0, seen = new Set<object>()): JSONValue {
  if (depth > 32) throw new TypeError(`Coordinator ${field} exceeds the JSON depth limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Coordinator ${field} contains a non-finite number`);
    return value;
  }
  if (!value || typeof value !== "object") throw new TypeError(`Coordinator ${field} contains an invalid value`);
  if (seen.has(value)) throw new TypeError(`Coordinator ${field} contains a cycle`);
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const symbolKeys = Object.getOwnPropertySymbols(value);
    if (symbolKeys.length > 0) throw new TypeError(`Coordinator ${field} contains a symbol key`);
    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor && "value" in lengthDescriptor && typeof lengthDescriptor.value === "number"
        ? lengthDescriptor.value
        : Number.NaN;
      if (!Number.isSafeInteger(length) || length > 4_096) throw new TypeError(`Coordinator ${field} array is too large`);
      for (const key of Object.getOwnPropertyNames(value)) {
        if (key === "length") continue;
        if (!/^\d+$/u.test(key) || String(Number(key)) !== key || Number(key) >= length) {
          throw new TypeError(`Coordinator ${field} contains a non-index array property`);
        }
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError(`Coordinator ${field}[${key}] is not a data property`);
        }
      }
      const result: JSONValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError(`Coordinator ${field}[${index}] is not a data property`);
        }
        result.push(parseJsonValue(descriptor.value, `${field}[${index}]`, depth + 1, seen));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Coordinator ${field} must be a plain JSON object`);
    }
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length > 4_096) throw new TypeError(`Coordinator ${field} has too many keys`);
    const result: { [key: string]: JSONValue } = {};
    for (const key of keys) {
      if (key.length > 1_024) throw new TypeError(`Coordinator ${field} has an oversized key`);
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`Coordinator ${field}.${key} is not a data property`);
      }
      const parsed = parseJsonValue(descriptor.value, `${field}.${key}`, depth + 1, seen);
      Object.defineProperty(result, key, { value: parsed, enumerable: true, configurable: true, writable: true });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function parseJsonRecord(value: unknown, field: string): P2pkhProviderConfig {
  const parsed = parseJsonValue(value, field);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`Coordinator ${field} must be a JSON object`);
  }
  return parsed;
}

function parseBucketConnection(value: unknown): StorageBucketConnectionConfigV1 {
  const connection = expectRecord(value, "storage connection");
  if (connection.kind === "local") return { kind: "local" };
  if (connection.kind !== "s3") throw new TypeError("Coordinator storage connection kind is invalid");
  const forcePathStyle = optionalBoolean(connection.forcePathStyle, "storage connection.forcePathStyle");
  return {
    kind: "s3",
    endpoint: text(connection.endpoint, "storage connection.endpoint", 2_048),
    region: text(connection.region, "storage connection.region", 256),
    bucket: text(connection.bucket, "storage connection.bucket", 512),
    accessKeyId: text(connection.accessKeyId, "storage connection.accessKeyId", 512),
    secretAccessKey: text(connection.secretAccessKey, "storage connection.secretAccessKey", 2_048),
    ...(optionalText(connection.sessionToken, "storage connection.sessionToken", 8_192) === undefined ? {} : { sessionToken: connection.sessionToken as string }),
    ...(optionalText(connection.prefix, "storage connection.prefix", 2_048) === undefined ? {} : { prefix: connection.prefix as string }),
    ...(forcePathStyle === undefined ? {} : { forcePathStyle }),
  };
}

function parseRuntimeBucket(value: unknown, field: string): StorageRuntimeBucketV1 {
  const record = expectRecord(value, field);
  const bucketId = text(record.bucketId, field + ".bucketId", 128);
  const backend = enumValue(record.backend, ["local", "s3"] as const, field + ".backend");
  const label = optionalText(record.label, field + ".label", 128);
  let deviceRecord: DeviceRecordV1;
  try { deviceRecord = validateDeviceRecord(record.deviceRecord); } catch { throw new TypeError(`Coordinator ${field}.deviceRecord is invalid`); }
  if (deviceRecord.location.providerId !== backend) throw new TypeError(`Coordinator ${field}.backend does not match its device record`);
  let keyDerivation: KeymasterSessionKeyDerivationV1 | undefined;
  if (record.keyDerivation !== undefined) {
    try { keyDerivation = validateKeymasterSessionKeyDerivation(record.keyDerivation); } catch { throw new TypeError(`Coordinator ${field}.keyDerivation is invalid`); }
  }
  return { bucketId, backend, ...(label === undefined ? {} : { label }), deviceRecord, ...(keyDerivation === undefined ? {} : { keyDerivation }) };
}

function parseStorageBootstrapState(value: unknown): StorageBootstrapState {
  const state = expectRecord(value, "storageBootstrapState");
  if (state.selectedBackend !== "local" && state.selectedBackend !== "s3") {
    throw new TypeError("Coordinator storageBootstrapState.selectedBackend is invalid");
  }
  const selectedProfileId = text(state.selectedProfileId, "storageBootstrapState.selectedProfileId", 256);
  const language = optionalText(state.language, "storageBootstrapState.language", 64);
  const theme = optionalText(state.theme, "storageBootstrapState.theme", 64);
  const selectedBucket = parseRuntimeBucket(state.selectedBucket, "storageBootstrapState.selectedBucket");
  if (selectedBucket.bucketId !== selectedProfileId || selectedBucket.backend !== state.selectedBackend) {
    throw new TypeError("Coordinator storageBootstrapState selection is inconsistent");
  }
  return {
    selectedBackend: state.selectedBackend,
    selectedProfileId,
    selectedBucket,
    ...(language === undefined ? {} : { language }),
    ...(theme === undefined ? {} : { theme }),
  };
}

function parseStorageConnection(value: unknown, providerId: StorageProviderConfigDraft["providerId"]): StorageConnection {
  const connection = expectRecord(value, "storage provider connection");
  if (providerId === "cloudflare-r2") {
    const endpointVariant = connection.endpointVariant;
    if (endpointVariant !== "default" && endpointVariant !== "eu" && endpointVariant !== "fedramp") {
      throw new TypeError("Coordinator storage R2 endpointVariant is invalid");
    }
    return {
      accountId: text(connection.accountId, "storage R2 accountId", 128),
      endpointVariant,
      bucket: text(connection.bucket, "storage R2 bucket", 512),
    };
  }
  if (providerId === "aws-s3") {
    return {
      region: text(connection.region, "storage AWS region", 256),
      bucket: text(connection.bucket, "storage AWS bucket", 512),
    };
  }
  const forcePathStyle = booleanValue(connection.forcePathStyle, "storage compatible forcePathStyle");
  const sessionToken = optionalText(connection.sessionToken, "storage compatible sessionToken", 8_192);
  const prefix = optionalText(connection.prefix, "storage compatible prefix", 2_048);
  return {
    endpoint: text(connection.endpoint, "storage compatible endpoint", 2_048),
    region: text(connection.region, "storage compatible region", 256),
    bucket: text(connection.bucket, "storage compatible bucket", 512),
    forcePathStyle,
    ...(sessionToken === undefined ? {} : { sessionToken }),
    ...(prefix === undefined ? {} : { prefix }),
  };
}

function parseStorageSecretUpdate(value: unknown): StorageSecretUpdate {
  const credentials = expectRecord(value, "storage credentials");
  if (credentials.mode === "retain") return { mode: "retain" };
  if (credentials.mode !== "replace") throw new TypeError("Coordinator storage credentials mode is invalid");
  return {
    mode: "replace",
    accessKeyId: text(credentials.accessKeyId, "storage credentials.accessKeyId", 512),
    secretAccessKey: text(credentials.secretAccessKey, "storage credentials.secretAccessKey", 2_048),
  };
}

function parseProviderConfigDraft(value: unknown): StorageProviderConfigDraft {
  const draft = expectRecord(value, "storage provider config");
  const providerId = text(draft.providerId, "storage providerId", 64);
  if (providerId !== "cloudflare-r2" && providerId !== "aws-s3" && providerId !== "s3-compatible") {
    throw new TypeError("Coordinator storage providerId is invalid");
  }
  const connection = parseStorageConnection(draft.connection, providerId);
  const credentials = parseStorageSecretUpdate(draft.credentials);
  const profilePassword = optionalText(draft.profilePassword, "storage profilePassword", 4_096);
  return {
    providerId,
    connection,
    credentials,
    ...(profilePassword === undefined ? {} : { profilePassword }),
  };
}

function parseInitialSetupPlan(value: unknown): InitialSetupPlan {
  const plan = expectRecord(value, "storage initial-setup plan");
  const backend = plan.backend;
  if (backend !== "local" && backend !== "s3") throw new TypeError("Coordinator initial-setup backend is invalid");
  const connection = parseBucketConnection(plan.connection);
  if (connection.kind !== backend) throw new TypeError("Coordinator initial-setup backend and connection disagree");
  const firstKey = expectRecord(plan.firstKey, "storage initial-setup firstKey");
  const keyKind = text(firstKey.kind, "storage initial-setup firstKey.kind", 32);
  const label = text(firstKey.label, "storage initial-setup firstKey.label", 256);
  const capabilities = stringList(firstKey.capabilities, "storage initial-setup firstKey.capabilities", 64, 128);
  const keyPassword = text(firstKey.password, "storage initial-setup firstKey.password", 4_096);
  const parsedFirstKey = keyKind === "generate"
    ? { kind: "generate" as const, label, capabilities, password: keyPassword }
    : keyKind === "import"
      ? {
        kind: "import" as const,
        label,
        material: (() => {
          const material = expectRecord(firstKey.material, "storage initial-setup firstKey.material");
          return {
            hex: text(material.hex, "storage initial-setup material.hex", 256),
            ...(optionalText(material.wif, "storage initial-setup material.wif", 256) === undefined ? {} : { wif: material.wif as string }),
          };
        })(),
        format: text(firstKey.format, "storage initial-setup firstKey.format", 128),
        ...(optionalText(firstKey.source, "storage initial-setup firstKey.source", 512) === undefined ? {} : { source: firstKey.source as string }),
        capabilities,
        password: keyPassword,
      }
      : (() => { throw new TypeError("Coordinator initial-setup firstKey.kind is invalid"); })();
  return {
    transactionId: text(plan.transactionId, "storage initial-setup transactionId", 128),
    bucketLabel: text(plan.bucketLabel, "storage initial-setup bucketLabel", 256),
    ...(plan.remoteStorageId === undefined ? {} : { remoteStorageId: text(plan.remoteStorageId, "storage initial-setup remoteStorageId", 128) }),
    backend,
    connection,
    ...(plan.startupPassword === undefined ? {} : { startupPassword: text(plan.startupPassword, "storage initial-setup startupPassword", 4_096) }),
    ...(plan.capabilities === undefined ? {} : { capabilities: parseDeviceCapabilities(plan.capabilities, "storage initial-setup capabilities") }),
    firstKey: parsedFirstKey,
  };
}

function parseExistingRemoteStorageConnectPlan(value: unknown): ExistingRemoteStorageConnectPlan {
  const plan = expectRecord(value, "storage connect-existing-remote plan");
  const backend = plan.backend;
  if (backend !== "local" && backend !== "s3") throw new TypeError("Coordinator connect-existing-remote backend is invalid");
  const connection = parseBucketConnection(plan.connection);
  if (connection.kind !== backend) throw new TypeError("Coordinator connect-existing-remote backend and connection disagree");
  return {
    operationId: text(plan.operationId, "storage connect-existing-remote operationId", 128),
    ...(plan.remoteStorageId === undefined ? {} : { remoteStorageId: text(plan.remoteStorageId, "storage connect-existing-remote remoteStorageId", 128) }),
    displayName: text(plan.displayName, "storage connect-existing-remote displayName", 256),
    backend,
    connection,
    ...(plan.publicKeyHex === undefined ? {} : { publicKeyHex: text(plan.publicKeyHex, "storage connect-existing-remote publicKeyHex", 128) }),
    keyPassword: text(plan.keyPassword, "storage connect-existing-remote keyPassword", 4_096),
    ...(plan.startupPassword === undefined ? {} : { startupPassword: text(plan.startupPassword, "storage connect-existing-remote startupPassword", 4_096) }),
    ...(plan.capabilities === undefined ? {} : { capabilities: parseDeviceCapabilities(plan.capabilities, "storage connect-existing-remote capabilities") }),
  };
}

function parseBucketProbePlan(value: unknown): import("./storage/catalog.js").BucketProbePlan {
  const plan = expectRecord(value, "storage probe-bucket plan");
  const backend = plan.backend;
  if (backend !== "local" && backend !== "s3") throw new TypeError("Coordinator probe-bucket backend is invalid");
  const operationId = text(plan.operationId, "storage probe-bucket operationId", 128);
  // 已登记桶：用设备记录绑定 + 启动密码探测；页面不再传明文连接。
  if (plan.binding !== undefined) {
    const binding = parseRuntimeBucket(plan.binding, "storage probe-bucket binding");
    if (binding.backend !== backend) throw new TypeError("Coordinator probe-bucket backend and binding disagree");
    const password = optionalText(plan.password, "storage probe-bucket password", 4_096);
    const forceReprobe = optionalBoolean(plan.forceReprobe, "storage probe-bucket forceReprobe");
    return { operationId, backend, binding, ...(password === undefined ? {} : { password }), ...(forceReprobe === undefined ? {} : { forceReprobe }) };
  }
  const connection = parseBucketConnection(plan.connection);
  if (connection.kind !== backend) throw new TypeError("Coordinator probe-bucket backend and connection disagree");
  return {
    operationId,
    backend,
    connection,
    ...(plan.remoteStorageId === undefined ? {} : { remoteStorageId: text(plan.remoteStorageId, "storage probe-bucket remoteStorageId", 128) }),
  };
}

function parseStorageControl(value: unknown): CoordinatorStorageControl {
  const control = expectRecord(value, "storage control");
  const type = enumValue(control.type, STORAGE_CONTROL_TYPES, "storage control.type");
  switch (type) {
    case "status": case "summary": case "connection": case "retry":
    case "initial-setup-recovery-list": case "cancel-probe": case "capabilities": case "probe-capabilities": case "cold-export":
      return { type };
    case "unlock-bucket":
      return { type, password: text(control.password, "storage control." + type + ".password", 4_096) };
    case "initial-setup":
      return { type, plan: parseInitialSetupPlan(control.plan) };
    case "connect-existing-remote":
      return { type, plan: parseExistingRemoteStorageConnectPlan(control.plan) };
    case "probe-bucket":
      return { type, plan: parseBucketProbePlan(control.plan) };
    case "initial-setup-result":
      return { type, transactionId: text(control.transactionId, "storage control." + type + ".transactionId", 128) };
    case "initial-setup-cleanup": {
      const password = optionalText(control.password, "storage control.initial-setup-cleanup.password", 4_096);
      return {
        type,
        transactionId: text(control.transactionId, "storage control.initial-setup-cleanup.transactionId", 128),
        ...(password === undefined ? {} : { password }),
        ...(control.connection === undefined ? {} : { connection: parseBucketConnection(control.connection) }),
      };
    }
    case "switch-bucket": {
      const keyPassword = optionalText(control.keyPassword, "storage control.switch-bucket.keyPassword", 4_096);
      const publicKeyHex = optionalText(control.publicKeyHex, "storage control.switch-bucket.publicKeyHex", 130);
      // Local 桶没有启动密码：password 允许空字符串；S3 桶的密码正确性由
      // Worker 在解密设备记录时验证，RPC 层只做类型/长度边界。
      const password = control.password === "" ? "" : text(control.password, "storage control.switch-bucket.password", 4_096);
      return {
        type,
        bucket: parseRuntimeBucket(control.bucket, "storage control.switch-bucket.bucket"),
        password,
        ...(keyPassword === undefined ? {} : { keyPassword }),
        ...(publicKeyHex === undefined ? {} : { publicKeyHex }),
      };
    }
    case "change-bucket-config": {
      const label = optionalText(control.label, "storage control.change-bucket-config.label", 256);
      return { type, config: parseBucketConnection(control.config), ...(label === undefined ? {} : { label }), password: text(control.password, "storage control.change-bucket-config.password", 4_096) };
    }
    case "rename-bucket":
      return { type, label: text(control.label, "storage control.rename-bucket.label", 256) };
    case "delete-local-bucket-key":
      return {
        type,
        bucket: parseRuntimeBucket(control.bucket, "storage control.delete-local-bucket-key.bucket"),
        publicKeyHex: text(control.publicKeyHex, "storage control.delete-local-bucket-key.publicKeyHex", 130),
      };
    default:
      throw new TypeError("Coordinator storage control type " + type + " is unsupported");
  }
}

function parseBinaryField(value: unknown, field: string): { $type: "binary"; bytes: ArrayBuffer; mime?: string } {
  const binary = expectRecord(value, field);
  if (binary.$type !== "binary") throw new TypeError("Coordinator " + field + ".$type is invalid");
  const mime = optionalText(binary.mime, field + ".mime", 256);
  return { $type: "binary", bytes: arrayBufferValue(binary.bytes, field + ".bytes"), ...(mime === undefined ? {} : { mime }) };
}

function parseStorageData(value: unknown): CoordinatorStorageData {
  const data = expectRecord(value, "storage data");
  const type = enumValue(data.type, STORAGE_DATA_TYPES, "storage data.type");
  const grantId = text(data.grantId, "storage data." + type + ".grantId", 256);
  const input = expectRecord(data.input, "storage data." + type + ".input");
  switch (type) {
    case "list": {
      const prefix = optionalText(input.prefix, "storage data.list.prefix", 4_096);
      const cursor = optionalText(input.cursor, "storage data.list.cursor", 8_192);
      const limit = optionalBoundedNumber(input.limit, "storage data.list.limit", 1, 1_000);
      return { type, grantId, input: { ...(prefix === undefined ? {} : { prefix }), ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) } };
    }
    case "create-directory": case "delete-directory": {
      const path = text(input.path, "storage data." + type + ".path", 4_096);
      const overwrite = optionalBoolean(input.overwrite, "storage data." + type + ".overwrite");
      return { type, grantId, input: { path, ...(overwrite === undefined ? {} : { overwrite }) } };
    }
    case "put": {
      const contentType = optionalText(input.contentType, "storage data.put.contentType", 256);
      const overwrite = optionalBoolean(input.overwrite, "storage data.put.overwrite");
      return { type, grantId, input: { path: text(input.path, "storage data.put.path", 4_096), content: parseBinaryField(input.content, "storage data.put.content"), ...(contentType === undefined ? {} : { contentType }), ...(overwrite === undefined ? {} : { overwrite }) } };
    }
    case "get-range": {
      const offset = optionalBoundedNumber(input.offset, "storage data.get-range.offset");
      const length = optionalBoundedNumber(input.length, "storage data.get-range.length", 1);
      const ifMatch = optionalText(input.ifMatch, "storage data.get-range.ifMatch", 512);
      return { type, grantId, input: { path: text(input.path, "storage data.get-range.path", 4_096), ...(offset === undefined ? {} : { offset }), ...(length === undefined ? {} : { length }), ...(ifMatch === undefined ? {} : { ifMatch }) } };
    }
    case "delete":
      return { type, grantId, input: { path: text(input.path, "storage data.delete.path", 4_096) } };
    case "begin-upload": {
      const contentType = optionalText(input.contentType, "storage data.begin-upload.contentType", 256);
      const overwrite = optionalBoolean(input.overwrite, "storage data.begin-upload.overwrite");
      return { type, grantId, input: { path: text(input.path, "storage data.begin-upload.path", 4_096), ...(contentType === undefined ? {} : { contentType }), size: boundedNumber(input.size, "storage data.begin-upload.size"), ...(overwrite === undefined ? {} : { overwrite }) } };
    }
    case "upload-part":
      return { type, grantId, input: { uploadId: text(input.uploadId, "storage data.upload-part.uploadId", 256), partNumber: boundedNumber(input.partNumber, "storage data.upload-part.partNumber", 1, 10_000), content: parseBinaryField(input.content, "storage data.upload-part.content") } };
    case "complete-upload": case "abort-upload":
      return { type, grantId, input: { uploadId: text(input.uploadId, "storage data." + type + ".uploadId", 256) } };
    default:
      throw new TypeError("Coordinator storage data type " + type + " is unsupported");
  }
}

type ParsedInternalStorageData =
  | { operation: "get"; grantId: string; key: string; partition?: string }
  | { operation: "list"; grantId: string; input?: { prefix?: string; cursor?: string; limit?: number; partition?: string } }
  | { operation: "put"; grantId: string; key: string; value: JSONValue; condition?: { ifRevision?: number; partition?: string } }
  | { operation: "delete"; grantId: string; key: string; condition?: { ifRevision?: number; partition?: string } }
  | { operation: "commit"; grantId: string; partition: string; ifRevision?: number; operations: Array<{ type: "put"; key: string; value: JSONValue } | { type: "delete"; key: string }> }
  | { operation: "file-list"; grantId: string; input?: { prefix?: string; cursor?: string; limit?: number } }
  | { operation: "file-get"; grantId: string; path: string }
  | { operation: "file-put"; grantId: string; path: string; bytes: Uint8Array; ifNoneMatch?: boolean; ifMatch?: string }
  | { operation: "file-delete"; grantId: string; path: string; ifMatch?: string };

function parseInternalStorageData(value: unknown, prefix: "owner" | "platform"): ParsedInternalStorageData {
  const data = expectRecord(value, prefix + " storage data");
  const type = text(data.type, prefix + " storage.type", 64);
  if (!type.startsWith(prefix + ".")) throw new TypeError("Coordinator " + prefix + " storage operation is invalid");
  const grantField = prefix === "owner" ? "storageGrantId" : "platformGrantId";
  const grantId = text(data[grantField], prefix + " storage." + grantField, 256);
  if (type === prefix + ".get") {
    const partition = optionalText(data.partition, prefix + " storage.get.partition", 256);
    return { operation: "get", grantId, key: text(data.key, prefix + " storage.get.key", 1_024), ...(partition === undefined ? {} : { partition }) };
  }
  if (type === prefix + ".list") {
    if (data.input === undefined) return { operation: "list", grantId };
    const input = expectRecord(data.input, prefix + " storage.list.input");
    const prefixValue = optionalText(input.prefix, prefix + " storage.list.prefix", 4_096);
    const cursor = optionalText(input.cursor, prefix + " storage.list.cursor", 8_192);
    const limit = optionalBoundedNumber(input.limit, prefix + " storage.list.limit", 1, 1_000);
    const partition = optionalText(input.partition, prefix + " storage.list.partition", 256);
    return {
      operation: "list",
      grantId,
      input: {
        ...(prefixValue === undefined ? {} : { prefix: prefixValue }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(partition === undefined ? {} : { partition }),
      },
    };
  }
  if (type === prefix + ".put" || type === prefix + ".delete") {
    const key = text(data.key, prefix + " storage." + (type.endsWith("put") ? "put" : "delete") + ".key", 1_024);
    const condition = data.condition === undefined ? undefined : expectRecord(data.condition, prefix + " storage.condition");
    let parsedCondition: { ifRevision?: number; partition?: string } | undefined;
    if (condition) {
      const ifRevision = optionalBoundedNumber(condition.ifRevision, prefix + " storage.condition.ifRevision");
      const partition = optionalText(condition.partition, prefix + " storage.condition.partition", 256);
      parsedCondition = { ...(ifRevision === undefined ? {} : { ifRevision }), ...(partition === undefined ? {} : { partition }) };
    }
    if (type === prefix + ".put") {
      return { operation: "put", grantId, key, value: parseJsonValue(data.value, prefix + " storage.value"), ...(parsedCondition === undefined ? {} : { condition: parsedCondition }) };
    }
    return { operation: "delete", grantId, key, ...(parsedCondition === undefined ? {} : { condition: parsedCondition }) };
  }
  if (type === prefix + ".commit") {
    const partition = text(data.partition, prefix + " storage.partition", 256);
    const ifRevision = optionalBoundedNumber(data.ifRevision, prefix + " storage.ifRevision");
    if (!Array.isArray(data.operations) || data.operations.length > 256) throw new TypeError("Coordinator " + prefix + " storage.operations is invalid");
    const operations = data.operations.map((item, index) => {
      const operation = expectRecord(item, prefix + " storage.operations[" + index + "]");
      if (operation.type === "put") {
        return {
          type: "put" as const,
          key: text(operation.key, prefix + " storage.operations[" + index + "].key", 1_024),
          value: parseJsonValue(operation.value, prefix + " storage.operations[" + index + "].value"),
        };
      } else if (operation.type === "delete") {
        return { type: "delete" as const, key: text(operation.key, prefix + " storage.operations[" + index + "].key", 1_024) };
      } else {
        throw new TypeError("Coordinator " + prefix + " storage commit operation is invalid");
      }
    });
    return { operation: "commit", grantId, partition, ...(ifRevision === undefined ? {} : { ifRevision }), operations };
  }
  if (type === prefix + ".file-list") {
    if (prefix !== "owner") throw new TypeError("Coordinator platform storage operation is unsupported");
    if (data.input === undefined) return { operation: "file-list", grantId };
    const input = expectRecord(data.input, prefix + " storage.file-list.input");
    const filePrefix = optionalFilePathPrefix(input.prefix, prefix + " storage.file-list.prefix", 4_096);
    const cursor = optionalText(input.cursor, prefix + " storage.file-list.cursor", 8_192);
    const limit = optionalBoundedNumber(input.limit, prefix + " storage.file-list.limit", 1, 1_000);
    return {
      operation: "file-list",
      grantId,
      input: {
        ...(filePrefix === undefined ? {} : { prefix: filePrefix }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      },
    };
  }
  if (type === prefix + ".file-get" || type === prefix + ".file-put" || type === prefix + ".file-delete") {
    if (prefix !== "owner") throw new TypeError("Coordinator platform storage operation is unsupported");
    const path = text(data.path, prefix + " storage." + type.slice(prefix.length + 1) + ".path", 4_096);
    if (type === prefix + ".file-get") return { operation: "file-get", grantId, path };
    const ifMatch = optionalText(data.ifMatch, prefix + " storage.file.ifMatch", 1_024);
    if (type === prefix + ".file-delete") return { operation: "file-delete", grantId, path, ...(ifMatch === undefined ? {} : { ifMatch }) };
    const bytes = data.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > STORAGE_MAX_PAYLOAD_BYTES) {
      throw new TypeError("Coordinator " + prefix + " storage.file-put.bytes is invalid");
    }
    const ifNoneMatch = data.ifNoneMatch;
    if (ifNoneMatch !== undefined && ifNoneMatch !== true) throw new TypeError("Coordinator " + prefix + " storage.file-put.ifNoneMatch is invalid");
    return { operation: "file-put", grantId, path, bytes, ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }), ...(ifMatch === undefined ? {} : { ifMatch }) };
  }
  throw new TypeError("Coordinator " + prefix + " storage operation is unsupported");
}

function parseOwnerStorageData(value: unknown, prefix: "owner"): CoordinatorOwnerStorageData;
function parseOwnerStorageData(value: unknown, prefix: "platform"): CoordinatorPlatformStorageData;
function parseOwnerStorageData(value: unknown, prefix: "owner" | "platform"): CoordinatorOwnerStorageData | CoordinatorPlatformStorageData {
  const parsed = parseInternalStorageData(value, prefix);
  if (prefix === "owner") return ownerStorageDataFromParsed(parsed);
  return platformStorageDataFromParsed(parsed);
}

function ownerStorageDataFromParsed(parsed: ParsedInternalStorageData): CoordinatorOwnerStorageData {
  switch (parsed.operation) {
    case "get": return { type: "owner.get", storageGrantId: parsed.grantId, key: parsed.key, ...(parsed.partition === undefined ? {} : { partition: parsed.partition }) };
    case "list": return { type: "owner.list", storageGrantId: parsed.grantId, ...(parsed.input === undefined ? {} : { input: parsed.input }) };
    case "put": return { type: "owner.put", storageGrantId: parsed.grantId, key: parsed.key, value: parsed.value, ...(parsed.condition === undefined ? {} : { condition: parsed.condition }) };
    case "delete": return { type: "owner.delete", storageGrantId: parsed.grantId, key: parsed.key, ...(parsed.condition === undefined ? {} : { condition: parsed.condition }) };
    case "commit": return { type: "owner.commit", storageGrantId: parsed.grantId, partition: parsed.partition, ...(parsed.ifRevision === undefined ? {} : { ifRevision: parsed.ifRevision }), operations: parsed.operations };
    case "file-list": return { type: "owner.file-list", storageGrantId: parsed.grantId, ...(parsed.input === undefined ? {} : { input: parsed.input }) };
    case "file-get": return { type: "owner.file-get", storageGrantId: parsed.grantId, path: parsed.path };
    case "file-put": return { type: "owner.file-put", storageGrantId: parsed.grantId, path: parsed.path, bytes: parsed.bytes, ...(parsed.ifNoneMatch === undefined ? {} : { ifNoneMatch: parsed.ifNoneMatch }), ...(parsed.ifMatch === undefined ? {} : { ifMatch: parsed.ifMatch }) };
    case "file-delete": return { type: "owner.file-delete", storageGrantId: parsed.grantId, path: parsed.path, ...(parsed.ifMatch === undefined ? {} : { ifMatch: parsed.ifMatch }) };
  }
}

function platformStorageDataFromParsed(parsed: ParsedInternalStorageData): CoordinatorPlatformStorageData {
  switch (parsed.operation) {
    case "get": return { type: "platform.get", platformGrantId: parsed.grantId, key: parsed.key, ...(parsed.partition === undefined ? {} : { partition: parsed.partition }) };
    case "list": return { type: "platform.list", platformGrantId: parsed.grantId, ...(parsed.input === undefined ? {} : { input: parsed.input }) };
    case "put": return { type: "platform.put", platformGrantId: parsed.grantId, key: parsed.key, value: parsed.value, ...(parsed.condition === undefined ? {} : { condition: parsed.condition }) };
    case "delete": return { type: "platform.delete", platformGrantId: parsed.grantId, key: parsed.key, ...(parsed.condition === undefined ? {} : { condition: parsed.condition }) };
    case "commit": return { type: "platform.commit", platformGrantId: parsed.grantId, partition: parsed.partition, ...(parsed.ifRevision === undefined ? {} : { ifRevision: parsed.ifRevision }), operations: parsed.operations };
    case "file-list":
    case "file-get":
    case "file-put":
    case "file-delete": throw new TypeError("Coordinator platform storage operation is unsupported");
  }
}

function parseStorageDeclaration(value: unknown, field: string): PluginStorageDeclaration {
  const declaration = expectRecord(value, field);
  const scope = declaration.scope;
  if (scope !== "bucket" && scope !== "owner") throw new TypeError(`Coordinator ${field}.scope is invalid`);
  const authority = declaration.authority;
  if (authority !== "platform-only" && authority !== "built-in-module" && authority !== "third-party-app") {
    throw new TypeError(`Coordinator ${field}.authority is invalid`);
  }
  const model = declaration.model;
  if (model !== "snapshot" && model !== "kv" && model !== "files") throw new TypeError(`Coordinator ${field}.model is invalid`);
  const moduleId = text(declaration.moduleId, `${field}.moduleId`, 63);
  // files 模型允许空 purposeId（模块根）；其它模型仍必须是合法 purpose。
  const purposeId = model === "files" && declaration.purposeId === ""
    ? ""
    : text(declaration.purposeId, `${field}.purposeId`, 63);
  const schemaVersion = boundedNumber(declaration.schemaVersion, `${field}.schemaVersion`, 1);
  try {
    return validatePluginStorageDeclaration({ moduleId, purposeId, scope, authority, model, schemaVersion });
  } catch (error) {
    throw new TypeError(`Coordinator ${field} is invalid`, { cause: error });
  }
}

function parseMsFileSatoshiAmount(value: unknown, field: string): string {
  const amount = normalizeMsFileSatoshiAmount(value);
  if (amount === undefined) throw new TypeError(`Coordinator ${field} is invalid`);
  return amount;
}

function parseMsFileReadConcurrency(value: unknown): MsFileReadConcurrencySettings {
  const settings = expectRecord(value, "MSFile read concurrency settings");
  const mediaBlockReadConcurrency = boundedNumber(settings.mediaBlockReadConcurrency, "MSFile mediaBlockReadConcurrency", 1, 16);
  const globalSeedReadConcurrency = boundedNumber(settings.globalSeedReadConcurrency, "MSFile globalSeedReadConcurrency", 1, 8);
  const globalBlockReadConcurrency = boundedNumber(settings.globalBlockReadConcurrency, "MSFile globalBlockReadConcurrency", 1, 32);
  const globalStatConcurrency = boundedNumber(settings.globalStatConcurrency, "MSFile globalStatConcurrency", 1, 16);
  if (mediaBlockReadConcurrency > globalBlockReadConcurrency) throw new TypeError("Coordinator MSFile read concurrency relationship is invalid");
  return { mediaBlockReadConcurrency, globalSeedReadConcurrency, globalBlockReadConcurrency, globalStatConcurrency };
}

function parseMsFileGlobalPriceSettings(value: unknown): MsFileGlobalPriceSettings {
  const settings = expectRecord(value, "MSFile global price settings");
  return {
    seedMaxPriceSatoshis: parseMsFileSatoshiAmount(settings.seedMaxPriceSatoshis, "MSFile seedMaxPriceSatoshis"),
    blockMaxPriceSatoshis: parseMsFileSatoshiAmount(settings.blockMaxPriceSatoshis, "MSFile blockMaxPriceSatoshis"),
  };
}

function parseMsFileSupplier(value: unknown): MsFileSupplierConfig {
  const supplier = expectRecord(value, "MSFile supplier");
  const supplierPublicKeyHex = text(supplier.supplierPublicKeyHex, "MSFile supplier.supplierPublicKeyHex", 66);
  if (!isValidMsFileSupplierPublicKeyHex(supplierPublicKeyHex)) throw new TypeError("Coordinator MSFile supplier public key is invalid");
  const builtin = supplier.builtin === undefined
    ? undefined
    : booleanValue(supplier.builtin, "MSFile supplier.builtin");
  return {
    name: text(supplier.name, "MSFile supplier.name", 256),
    supplierPublicKeyHex,
    addresses: stringList(supplier.addresses, "MSFile supplier.addresses", 64, 2_048),
    enabled: booleanValue(supplier.enabled, "MSFile supplier.enabled"),
    ...(builtin === undefined ? {} : { builtin }),
  };
}

function parseMsFileAppIdentityKey(value: unknown): MsFileAppIdentityKey {
  const key = expectRecord(value, "MSFile app policy key");
  const ownerPublicKeyHex = text(key.ownerPublicKeyHex, "MSFile app policy ownerPublicKeyHex", 66);
  const publisherPublicKeyHex = text(key.publisherPublicKeyHex, "MSFile app policy publisherPublicKeyHex", 66);
  if (!isValidMsFileSupplierPublicKeyHex(ownerPublicKeyHex) || !isValidMsFileSupplierPublicKeyHex(publisherPublicKeyHex)) {
    throw new TypeError("Coordinator MSFile app policy public key is invalid");
  }
  const appId = text(key.appId, "MSFile app policy appId", 63);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u.test(appId)) throw new TypeError("Coordinator MSFile app policy appId is invalid");
  return { ownerPublicKeyHex, publisherPublicKeyHex, appId };
}

function parseMsFileOverride(value: unknown): { seedMaxPriceSatoshis?: string; blockMaxPriceSatoshis?: string } {
  const override = expectRecord(value, "MSFile app price override");
  const seedMaxPriceSatoshis = override.seedMaxPriceSatoshis === undefined ? undefined : parseMsFileSatoshiAmount(override.seedMaxPriceSatoshis, "MSFile override.seedMaxPriceSatoshis");
  const blockMaxPriceSatoshis = override.blockMaxPriceSatoshis === undefined ? undefined : parseMsFileSatoshiAmount(override.blockMaxPriceSatoshis, "MSFile override.blockMaxPriceSatoshis");
  return {
    ...(seedMaxPriceSatoshis === undefined ? {} : { seedMaxPriceSatoshis }),
    ...(blockMaxPriceSatoshis === undefined ? {} : { blockMaxPriceSatoshis }),
  };
}

function parseMsFileApprovalDecision(value: unknown): MsFileApprovalDecision {
  const decision = expectRecord(value, "MSFile approval decision");
  if (decision.action === "reject") return { action: "reject" };
  if (decision.action !== "allow" || (decision.scope !== "once" && decision.scope !== "always")) {
    throw new TypeError("Coordinator MSFile approval decision is invalid");
  }
  return {
    action: "allow",
    scope: decision.scope,
    newMaxPriceSatoshis: parseMsFileSatoshiAmount(decision.newMaxPriceSatoshis, "MSFile approval newMaxPriceSatoshis"),
  };
}

function parseAppIdentitySnapshot(value: unknown): AppIdentitySnapshot {
  const identity = expectRecord(value, "MSFile app identity");
  if (identity.version !== 1) throw new TypeError("Coordinator MSFile app identity version is invalid");
  const publisherPublicKeyHex = text(identity.publisherPublicKeyHex, "MSFile app identity publisherPublicKeyHex", 66);
  if (!isValidMsFileSupplierPublicKeyHex(publisherPublicKeyHex)) throw new TypeError("Coordinator MSFile app identity public key is invalid");
  const appId = text(identity.appId, "MSFile app identity appId", 63);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u.test(appId)) throw new TypeError("Coordinator MSFile app identity appId is invalid");
  const identityDigestHex = text(identity.identityDigestHex, "MSFile app identity identityDigestHex", 64);
  if (!/^[0-9a-f]{64}$/u.test(identityDigestHex)) throw new TypeError("Coordinator MSFile app identity digest is invalid");
  return {
    version: 1,
    publisherPublicKeyHex,
    appId,
    appName: text(identity.appName, "MSFile app identity appName", 256),
    identityDigestHex,
  };
}

function parseMsFileConnectContext(value: unknown): MsFileConnectAppContext {
  const context = expectRecord(value, "MSFile connect context");
  const ownerPublicKeyHex = text(context.ownerPublicKeyHex, "MSFile connect ownerPublicKeyHex", 66);
  if (!isValidMsFileSupplierPublicKeyHex(ownerPublicKeyHex)) throw new TypeError("Coordinator MSFile connect owner public key is invalid");
  return {
    connectSessionId: text(context.connectSessionId, "MSFile connect connectSessionId", 256),
    transportOrigin: text(context.transportOrigin, "MSFile connect transportOrigin", 2_048),
    ownerPublicKeyHex,
    appIdentity: parseAppIdentitySnapshot(context.appIdentity),
  };
}

function parseMsFileControl(value: unknown): CoordinatorMsFileControl {
  const control = expectRecord(value, "MSFile control");
  const type = text(control.type, "MSFile control.type", 96);
  if (type === "settings.get" || type === "settings.readConcurrency.get" || type === "settings.readConcurrency.reset"
    || type === "settings.mediaBlockReadConcurrency.get" || type === "app-authorizations.list" || type === "approvals.pending") {
    return { type };
  }
  if (type === "settings.readConcurrency.update") return { type, input: parseMsFileReadConcurrency(control.input) };
  if (type === "settings.global.update") return { type, input: parseMsFileGlobalPriceSettings(control.input) };
  if (type === "settings.mediaBlockReadConcurrency.update") {
    return { type, mediaBlockReadConcurrency: boundedNumber(control.mediaBlockReadConcurrency, "MSFile control.mediaBlockReadConcurrency", 1, 16) };
  }
  if (type === "supplier.upsert") {
    return { type, supplier: parseMsFileSupplier(control.supplier), expectedGeneration: nullableBoundedNumber(control.expectedGeneration, "MSFile control.expectedGeneration") };
  }
  if (type === "supplier.delete") {
    const supplierPublicKeyHex = text(control.supplierPublicKeyHex, "MSFile control.supplier.delete.supplierPublicKeyHex", 66);
    if (!isValidMsFileSupplierPublicKeyHex(supplierPublicKeyHex)) throw new TypeError("Coordinator MSFile supplier public key is invalid");
    return { type, supplierPublicKeyHex, expectedGeneration: nullableBoundedNumber(control.expectedGeneration, "MSFile control.expectedGeneration") };
  }
  if (type === "supplier.probe") {
    const supplierPublicKeyHex = text(control.supplierPublicKeyHex, "MSFile control.supplier.probe.supplierPublicKeyHex", 66);
    if (!isValidMsFileSupplierPublicKeyHex(supplierPublicKeyHex)) throw new TypeError("Coordinator MSFile supplier public key is invalid");
    return { type, supplierPublicKeyHex };
  }
  if (type === "app-policy.update") {
    const input = expectRecord(control.input, "MSFile control.app-policy.update.input");
    return { type, input: { key: parseMsFileAppIdentityKey(input.key), override: parseMsFileOverride(input.override) } };
  }
  if (type === "app-policy.clear") return { type, key: parseMsFileAppIdentityKey(control.key) };
  if (type === "approval.resolve") return {
    type,
    approvalId: text(control.approvalId, "MSFile control.approval.resolve.approvalId", 256),
    decision: parseMsFileApprovalDecision(control.decision),
  };
  if (type === "bucket.put-block") {
    const seedHashHex = text(control.seedHashHex, "MSFile control.bucket.put-block.seedHashHex", 64);
    const blockHashHex = text(control.blockHashHex, "MSFile control.bucket.put-block.blockHashHex", 64);
    if (!isValidMsFileHashHex(seedHashHex) || !isValidMsFileHashHex(blockHashHex)) {
      throw new TypeError("Coordinator MSFile control.bucket.put-block hash is invalid");
    }
    const bytes = arrayBufferValue(control.bytes, "MSFile control.bucket.put-block.bytes");
    if (bytes.byteLength < 1 || bytes.byteLength > MSFILE_MAX_BLOCK_BYTES) {
      throw new TypeError("Coordinator MSFile control.bucket.put-block bytes is invalid");
    }
    return { type, seedHashHex, blockHashHex, bytes };
  }
  if (type === "bucket.get-block") {
    const seedHashHex = text(control.seedHashHex, "MSFile control.bucket.get-block.seedHashHex", 64);
    const blockHashHex = text(control.blockHashHex, "MSFile control.bucket.get-block.blockHashHex", 64);
    if (!isValidMsFileHashHex(seedHashHex) || !isValidMsFileHashHex(blockHashHex)) {
      throw new TypeError("Coordinator MSFile control.bucket.get-block hash is invalid");
    }
    return { type, seedHashHex, blockHashHex };
  }
  throw new TypeError("Coordinator MSFile control " + type + " is unsupported");
}

function parseMsFileData(value: unknown): CoordinatorMsFileData {
  const data = expectRecord(value, "MSFile data");
  const type = text(data.type, "MSFile data.type", 64);
  const grantId = optionalText(data.grantId, "MSFile data." + type + ".grantId", 256);
  const hash = (value: unknown, field: string): string => {
    const hashHex = text(value, field, 64);
    if (!isValidMsFileHashHex(hashHex)) throw new TypeError("Coordinator " + field + " is invalid");
    return hashHex;
  };
  if (type === "stat") return { type, seedHashHex: hash(data.seedHashHex, "MSFile data.stat.seedHashHex"), ...(grantId === undefined ? {} : { grantId }) };
  if (type === "read-seed") {
    const supplierPublicKeyHex = text(data.supplierPublicKeyHex, "MSFile data.read-seed.supplierPublicKeyHex", 66);
    if (!isValidMsFileSupplierPublicKeyHex(supplierPublicKeyHex)) throw new TypeError("Coordinator MSFile supplier public key is invalid");
    return { type, supplierPublicKeyHex, seedHashHex: hash(data.seedHashHex, "MSFile data.read-seed.seedHashHex"), ...(grantId === undefined ? {} : { grantId }) };
  }
  if (type === "read-block") {
    const supplierPublicKeyHex = text(data.supplierPublicKeyHex, "MSFile data.read-block.supplierPublicKeyHex", 66);
    if (!isValidMsFileSupplierPublicKeyHex(supplierPublicKeyHex)) throw new TypeError("Coordinator MSFile supplier public key is invalid");
    return { type, supplierPublicKeyHex, blockHashHex: hash(data.blockHashHex, "MSFile data.read-block.blockHashHex"), ...(grantId === undefined ? {} : { grantId }) };
  }
  throw new TypeError("Coordinator MSFile data " + type + " is unsupported");
}

function parseVaultOperation(value: unknown): CoordinatorVaultOperation {
  const operation = expectRecord(value, "Vault operation");
  const type = enumValue(operation.type, VAULT_OPERATION_TYPES, "Vault operation.type");
  const password = (field: string): string => text(operation[field], "Vault operation." + field, 4_096);
  const publicKey = (field = "publicKeyHex"): string => text(operation[field], "Vault operation." + field, 256);
  const label = (): string => text(operation.label, "Vault operation.label", 256);
  const capabilities = (): string[] => stringList(operation.capabilities, "Vault operation.capabilities", 64, 128);
  switch (type) {
    case "createVault": return { type, password: password("password") };
    case "createVaultWithInitialKey": {
      const valueLabel = optionalText(operation.label, "Vault operation.label", 256);
      const valueCapabilities = optionalStringList(operation.capabilities, "Vault operation.capabilities", 64, 128);
      return { type, password: password("password"), ...(valueLabel === undefined ? {} : { label: valueLabel }), ...(valueCapabilities === undefined ? {} : { capabilities: valueCapabilities }) };
    }
    case "createVaultWithImportedKey": {
      const key = expectRecord(operation.key, "Vault operation.key");
      const material = expectRecord(key.material, "Vault operation.key.material");
      const keySource = optionalText(key.source, "Vault operation.key.source", 512);
      const wif = optionalText(material.wif, "Vault operation.key.material.wif", 256);
      return {
        type,
        vaultPassword: password("vaultPassword"),
        key: {
          label: text(key.label, "Vault operation.key.label", 256),
          material: { hex: text(material.hex, "Vault operation.key.material.hex", 256), ...(wif === undefined ? {} : { wif }) },
          format: text(key.format, "Vault operation.key.format", 128),
          capabilities: stringList(key.capabilities, "Vault operation.key.capabilities", 64, 128),
          ...(keySource === undefined ? {} : { source: keySource }),
        },
      };
    }
    case "listKeys": case "exportCurrentKeyBackup": case "finalizeEmptyVaultAfterLastKeyDeletion": case "recoverEmptyVaultToUninitialized":
      return { type };
    case "getKey": case "setActive": case "exportKeyBackup":
      return { type, publicKeyHex: publicKey() };
    case "deleteKey": {
      const bucketPassword = optionalText(operation.bucketPassword, "Vault operation.bucketPassword", 4_096);
      return { type, publicKeyHex: publicKey(), confirmationLabel: text(operation.confirmationLabel, "Vault operation.confirmationLabel", 256), ...(bucketPassword === undefined ? {} : { bucketPassword }) };
    }
    case "verifyPassword": return { type, password: password("password") };
    case "changePassword": return { type, oldPassword: password("oldPassword"), newPassword: password("newPassword") };
    case "generateKey": {
      const valueCapabilities = optionalStringList(operation.capabilities, "Vault operation.capabilities", 64, 128);
      return { type, password: password("password"), label: label(), ...(valueCapabilities === undefined ? {} : { capabilities: valueCapabilities }) };
    }
    case "importPrivateKey": {
      const material = expectRecord(operation.material, "Vault operation.material");
      const wif = optionalText(material.wif, "Vault operation.material.wif", 256);
      const source = optionalText(operation.source, "Vault operation.source", 512);
      return { type, password: password("password"), label: label(), material: { hex: text(material.hex, "Vault operation.material.hex", 256), ...(wif === undefined ? {} : { wif }) }, format: text(operation.format, "Vault operation.format", 128), capabilities: capabilities(), ...(source === undefined ? {} : { source }) };
    }
    case "importKeyBackup": return { type, backup: text(operation.backup, "Vault operation.backup", 2_000_000), sourcePassword: password("sourcePassword"), targetPassword: password("targetPassword") };
    case "sealLocalSecret": return { type, scope: text(operation.scope, "Vault operation.scope", 256), plaintext: uint8ArrayValue(operation.plaintext, "Vault operation.plaintext") };
    case "openLocalSecret": {
      const sealed = expectRecord(operation.sealed, "Vault operation.sealed");
      if (sealed.version !== 3 || sealed.keySource !== "active-key-hkdf-v1") throw new TypeError("Vault operation.sealed version is invalid");
      return { type, scope: text(operation.scope, "Vault operation.scope", 256), sealed: { version: 3, keySource: "active-key-hkdf-v1", saltHex: text(sealed.saltHex, "Vault operation.sealed.saltHex", 512), nonceHex: text(sealed.nonceHex, "Vault operation.sealed.nonceHex", 512), ciphertextHex: text(sealed.ciphertextHex, "Vault operation.sealed.ciphertextHex", 2_000_000) } };
    }
    default:
      throw new TypeError("Coordinator Vault operation " + type + " is unsupported");
  }
}

function parseChannelCaller(value: unknown): ChannelOperationCaller {
  const caller = expectRecord(value, "Channel operation.caller");
  const kind = text(caller.kind, "Channel operation.caller.kind", 32);
  if (kind === "plugin") return { kind: "plugin", pluginId: text(caller.pluginId, "Channel operation.caller.pluginId", 256) };
  if (kind === "system") return { kind: "system", systemId: text(caller.systemId, "Channel operation.caller.systemId", 256) };
  if (kind === "connect") return { kind: "connect", connectSessionId: text(caller.connectSessionId, "Channel operation.caller.connectSessionId", 256), origin: text(caller.origin, "Channel operation.caller.origin", 2_048) };
  throw new TypeError("Coordinator Channel caller kind is unsupported");
}

function parseChannelOperation(value: unknown): CoordinatorChannelOperation {
  const operation = expectRecord(value, "Channel operation");
  const type = enumValue(operation.type, CHANNEL_OPERATION_TYPES, "Channel operation.type");
  const ownerPublicKeyHex = text(operation.ownerPublicKeyHex, "Channel operation.ownerPublicKeyHex", 256);
  const caller = parseChannelCaller(operation.caller);
  if (type === "publish") return { type, ownerPublicKeyHex, caller, channel: text(operation.channel, "Channel operation.channel", 2_048), content: parseJsonValue(operation.content, "Channel operation.content") };
  if (type === "hash-request-publish") return { type, ownerPublicKeyHex, caller, hash: text(operation.hash, "Channel operation.hash", 128), locator: operation.locator === "webrtc-sdp" ? "webrtc-sdp" : (() => { throw new TypeError("Channel operation.locator is invalid"); })() };
  if (type === "private-publish") return { type, ownerPublicKeyHex, caller, recipientPublicKeyHex: text(operation.recipientPublicKeyHex, "Channel operation.recipientPublicKeyHex", 256), protocol: text(operation.protocol, "Channel operation.protocol", 256), content: parseJsonValue(operation.content, "Channel operation.content") };
  if (type === "open-private-envelope") return { type, ownerPublicKeyHex, caller, envelope: uint8ArrayValue(operation.envelope, "Channel operation.envelope") };
  if (type === "subscription-set") return { type, ownerPublicKeyHex, caller, channels: stringList(operation.channels, "Channel operation.channels", 256, 2_048) };
  if (type === "release") return { type, ownerPublicKeyHex, caller };
  throw new TypeError("Coordinator Channel operation " + type + " is unsupported");
}

function parseSatOperation(value: unknown): CoordinatorSatOperation {
  const operation = expectRecord(value, "Sat operation");
  const type = text(operation.type, "Sat operation.type", 96);
  if (type === "ensure" || type === "admin.getSettings") return { type };
  if (type === "admin.upsertSupplier") {
    const config = expectRecord(operation.config, "Sat operation.config");
    const supplierId = text(config.supplierId, "Sat operation.config.supplierId", 256);
    const name = text(config.name, "Sat operation.config.name", 256);
    const supplierPublicKeyHex = text(config.supplierPublicKeyHex, "Sat operation.config.supplierPublicKeyHex", 66);
    if (!/^(02|03)[0-9a-f]{64}$/u.test(supplierPublicKeyHex)) throw new TypeError("Coordinator Sat supplier public key is invalid");
    return { type, config: { supplierId, name, supplierPublicKeyHex, multiaddrs: stringList(config.multiaddrs, "Sat operation.config.multiaddrs", 64, 2_048), enabled: booleanValue(config.enabled, "Sat operation.config.enabled") } };
  }
  if (type === "admin.deleteSupplier") return { type, supplierId: text(operation.supplierId, "Sat operation.supplierId", 256) };
  if (type === "admin.setOwnerSettings") {
    const settings = expectRecord(operation.settings, "Sat operation.settings");
    const ownerPublicKeyHex = text(settings.ownerPublicKeyHex, "Sat operation.settings.ownerPublicKeyHex", 66);
    if (!/^(02|03)[0-9a-f]{64}$/u.test(ownerPublicKeyHex)) throw new TypeError("Coordinator Sat owner public key is invalid");
    const defaultPublishSupplierId = settings.defaultPublishSupplierId === null ? null : text(settings.defaultPublishSupplierId, "Sat operation.settings.defaultPublishSupplierId", 256);
    return { type, settings: { ownerPublicKeyHex, defaultPublishSupplierId, receiveSupplierIds: stringList(settings.receiveSupplierIds, "Sat operation.settings.receiveSupplierIds", 64, 256) } };
  }
  if (type === "spi.submitTopUp") {
    const preview = expectRecord(operation.preview, "Sat operation.preview");
    if (preview.network !== "mainnet" && preview.network !== "testnet") throw new TypeError("Coordinator Sat preview network is invalid");
    const amountSatoshis = satBigInt(preview.amountSatoshis, "Sat operation.preview.amountSatoshis");
    validateWireValue(preview.p2pkhPreview, "Sat operation.preview.p2pkhPreview");
    return { type, preview: { supplierId: text(preview.supplierId, "Sat operation.preview.supplierId", 256), paymentAddress: text(preview.paymentAddress, "Sat operation.preview.paymentAddress", 512), network: preview.network, amountSatoshis, p2pkhPreview: preview.p2pkhPreview } };
  }
  if (type === "service.publish") {
    const input = expectRecord(operation.input, "Sat operation.service.publish.input");
    return { type, input: { channel: text(input.channel, "Sat operation.service.publish.channel", 2_048), contentJson: uint8ArrayValue(input.contentJson, "Sat operation.service.publish.contentJson") } };
  }
  if (type === "admin.refreshSubscriptions") {
    const input = expectRecord(operation.input, "Sat operation.admin.refreshSubscriptions.input");
    return { type, input: { supplierId: text(input.supplierId, "Sat operation.admin.refreshSubscriptions.supplierId", 256) } };
  }
  if (type === "admin.getBilling") {
    const input = expectRecord(operation.input, "Sat operation.admin.getBilling.input");
    const fromMs = satBigInt(input.fromMs, "Sat operation.admin.getBilling.fromMs");
    const toMs = satBigInt(input.toMs, "Sat operation.admin.getBilling.toMs");
    if (toMs < fromMs) throw new TypeError("Coordinator Sat billing toMs must be >= fromMs");
    const limit = boundedNumber(input.limit, "Sat operation.admin.getBilling.limit", 1);
    if (!Number.isInteger(limit) || limit > 100) throw new TypeError("Coordinator Sat billing limit is invalid");
    return {
      type,
      input: {
        supplierId: text(input.supplierId, "Sat operation.admin.getBilling.supplierId", 256),
        fromMs,
        toMs,
        limit,
        cursor: allowEmptyText(input.cursor, "Sat operation.admin.getBilling.cursor", 2_048),
      },
    };
  }
  if (type === "spi.getInformation") {
    const input = expectRecord(operation.input, "Sat operation.spi.getInformation.input");
    return { type, input: { supplierId: text(input.supplierId, "Sat operation.spi.getInformation.supplierId", 256) } };
  }
  if (type === "spi.prepareTopUp") {
    const input = expectRecord(operation.input, "Sat operation.spi.prepareTopUp.input");
    const currency = optionalText(input.currency, "Sat operation.spi.prepareTopUp.currency", 128);
    const network = optionalText(input.network, "Sat operation.spi.prepareTopUp.network", 128);
    if ((currency === undefined) !== (network === undefined)) throw new TypeError("Coordinator Sat prepareTopUp currency/network must be paired");
    return { type, input: { supplierId: text(input.supplierId, "Sat operation.spi.prepareTopUp.supplierId", 256), amountSatoshis: satBigInt(input.amountSatoshis, "Sat operation.spi.prepareTopUp.amountSatoshis"), ...(currency === undefined ? {} : { currency, network: network! }) } };
  }
  if (type === "spi.collectNew" || type === "spi.collect") {
    const input = expectRecord(operation.input, "Sat operation." + type + ".input");
    return { type, input: { supplierId: text(input.supplierId, "Sat operation." + type + ".supplierId", 256), currency: text(input.currency, "Sat operation." + type + ".currency", 128), network: text(input.network, "Sat operation." + type + ".network", 128), amount: satBigInt(input.amount, "Sat operation." + type + ".amount") } };
  }
  if (type === "spi.retryCollect") {
    const input = expectRecord(operation.input, "Sat operation.spi.retryCollect.input");
    const requestWire = input.requestWire === undefined ? undefined : uint8ArrayValue(input.requestWire, "Sat operation.spi.retryCollect.requestWire");
    return { type, input: { requestIdHex: text(input.requestIdHex, "Sat operation.spi.retryCollect.requestIdHex", 256), ...(requestWire === undefined ? {} : { requestWire }) } };
  }
  throw new TypeError("Coordinator Sat operation " + type + " is unsupported");
}

function satBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn) throw new TypeError(`Coordinator ${field} is invalid`);
  return value;
}

function parsePluginIntentCommand(value: unknown): PluginIntentCommand {
  const command = expectRecord(value, "Plugin intent command");
  return {
    commandId: text(command.commandId, "Plugin intent commandId", 256),
    authorityInstanceId: text(command.authorityInstanceId, "Plugin intent authorityInstanceId", 256),
    expectedRevision: boundedNumber(command.expectedRevision, "Plugin intent expectedRevision"),
    pluginId: text(command.pluginId, "Plugin intent pluginId", 256),
    desiredEnabled: booleanValue(command.desiredEnabled, "Plugin intent desiredEnabled"),
  };
}

/** 同步管理允许的间隔取值；解析时 fail closed，避免任意周期写入快照。 */
const BACKGROUND_SYNC_INTERVAL_OPTION_SET: ReadonlySet<number> = new Set(BACKGROUND_SYNC_INTERVAL_OPTIONS_MS);

function parseBackgroundSettings(value: unknown): CoordinatorBackgroundSyncSettings {
  const settings = expectRecord(value, "background settings");
  const intervals = expectRecord(settings.taskIntervals, "background settings.taskIntervals");
  const taskIntervals: Record<string, number> = {};
  for (const [taskId, interval] of Object.entries(intervals)) {
    if (taskId.length === 0 || taskId.length > 128) throw new TypeError("Coordinator background settings task id is invalid");
    if (typeof interval !== "number" || !BACKGROUND_SYNC_INTERVAL_OPTION_SET.has(interval)) {
      throw new TypeError(`Coordinator background settings interval for ${taskId} is invalid`);
    }
    taskIntervals[taskId] = interval;
  }
  return { taskIntervals };
}

function parseCoordinatorRequest(value: unknown): CoordinatorRpcRequest {
  const request = expectRecord(value, "RPC request");
  const rawKind = text(request.kind, "request.kind", 128);
  if (!COORDINATOR_REQUEST_KINDS.has(rawKind)) throw new TypeError("Coordinator RPC request kind " + rawKind + " is unsupported");
  const kind = rawKind as CoordinatorRpcRequestKind;
  // peerId 通常属于 transport 身份，不得由调用方伪造；但签名 Peer Record
  // 时它是待签名文档的业务字段，连接身份仍只来自 HandlerCallContext.peer。
  const hasForgedPeerIdentity = hasOwn(request, "peerId")
    && kind !== "window-p2p.executor.identity.sign-peer-record";
  if (hasOwn(request, "clientId") || hasOwn(request, "requestId") || hasOwn(request, "operationId") || hasForgedPeerIdentity) {
    throw new TypeError("Coordinator RPC request contains transport identity");
  }
  const epoch = (field: string): string => text(request[field], "request." + field, 256);
  const target = (): string => text(request.targetRequestId, "request.targetRequestId", 256);
  switch (kind) {
    case "session.open": {
      const leaseId = text(request.leaseId, "request.leaseId", 256);
      const bootstrap = request.storageBootstrapState === undefined ? undefined : parseStorageBootstrapState(request.storageBootstrapState);
      return { kind, leaseId, ...(bootstrap === undefined ? {} : { storageBootstrapState: bootstrap }) };
    }
    case "session.close": {
      const peerGeneration = boundedNumber(request.peerGeneration, "request.peerGeneration", 1);
      const sessionEpoch = text(request.sessionEpoch, "request.sessionEpoch", 256);
      const leaseId = text(request.leaseId, "request.leaseId", 256);
      return { kind, peerGeneration, sessionEpoch, leaseId };
    }
    case "session.activity":
      return { kind };
    case "storage.grant": return { kind, connectSessionId: text(request.connectSessionId, "storage.grant.connectSessionId", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "storage.control": return { kind, control: parseStorageControl(request.control), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "storage.data": return { kind, data: parseStorageData(request.data), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "storage.cancel": return { kind, targetRequestId: target() };
    case "storage.session.abort": return { kind, connectSessionId: text(request.connectSessionId, "storage.session.abort.connectSessionId", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "storage.owner.bind":
      return { kind, pluginId: text(request.pluginId, kind + ".pluginId", 256), declaration: parseStorageDeclaration(request.declaration, kind + ".declaration"), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "storage.platform.bind":
      return { kind, pluginId: text(request.pluginId, kind + ".pluginId", 256), declaration: parseStorageDeclaration(request.declaration, kind + ".declaration"), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "storage.owner.data": return { kind, data: parseOwnerStorageData(request.data, "owner"), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "storage.platform.data": return { kind, data: parseOwnerStorageData(request.data, "platform"), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "storage.owner.delete": return { kind, ownerPublicKeyHex: text(request.ownerPublicKeyHex, "storage.owner.delete.ownerPublicKeyHex", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "msfile.grant": return { kind, context: parseMsFileConnectContext(request.context), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "msfile.control": return { kind, control: parseMsFileControl(request.control), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "msfile.data": return { kind, data: parseMsFileData(request.data), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "msfile.cancel": return { kind, targetRequestId: target() };
    case "msfile.session.abort": return { kind, connectSessionId: text(request.connectSessionId, "msfile.session.abort.connectSessionId", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "window-p2p.executor.acquire": {
      const executorPort = request.executorPort === undefined ? undefined : messagePortValue(request.executorPort, "window-p2p.executor.acquire.executorPort");
      return { kind, ownerPublicKeyHex: text(request.ownerPublicKeyHex, kind + ".ownerPublicKeyHex", 256), expectedSessionEpoch: epoch("expectedSessionEpoch"), ...(executorPort === undefined ? {} : { executorPort }) };
    }
    case "window-p2p.executor.release": return { kind, leaseId: text(request.leaseId, kind + ".leaseId", 256) };
    case "window-p2p.executor.spike.transfer": return { kind, leaseId: text(request.leaseId, kind + ".leaseId", 256), expectedSessionEpoch: epoch("expectedSessionEpoch"), bytes: arrayBufferValue(request.bytes, kind + ".bytes") };
    case "window-p2p.executor.identity.sign-noise": return { kind, leaseId: text(request.leaseId, kind + ".leaseId", 256), expectedSessionEpoch: epoch("expectedSessionEpoch"), noiseStaticPublicKey: arrayBufferValue(request.noiseStaticPublicKey, kind + ".noiseStaticPublicKey") };
    case "window-p2p.executor.identity.sign-peer-record":
      return { kind, leaseId: text(request.leaseId, kind + ".leaseId", 256), expectedSessionEpoch: epoch("expectedSessionEpoch"), peerId: text(request.peerId, kind + ".peerId", 256), addresses: stringList(request.addresses, kind + ".addresses", 64, 2_048), sequence: text(request.sequence, kind + ".sequence", 32) };
    case "sat.operation": return { kind, operation: parseSatOperation(request.operation), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "channel.operation": return { kind, operation: parseChannelOperation(request.operation), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "channel.cancel": return { kind, targetRequestId: target() };
    case "contacts.presence.snapshot": return { kind, expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "plugin.intent.snapshot": return { kind };
    case "plugin.intent.submit": return { kind, command: parsePluginIntentCommand(request.command) };
    case "unlock": return { kind, password: text(request.password, "unlock.password", 4_096), ...(optionalText(request.publicKeyHex, "unlock.publicKeyHex", 256) === undefined ? {} : { publicKeyHex: request.publicKeyHex as string }), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "lock": return { kind, expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "activate-key": return { kind, password: text(request.password, "activate-key.password", 4_096), publicKeyHex: text(request.publicKeyHex, "activate-key.publicKeyHex", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "vault.operation": return { kind, operation: parseVaultOperation(request.operation), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "crypto": return { kind, operation: parseCryptoOperation(request.operation), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "background.run-now": case "background.cancel":
      return { kind, taskId: text(request.taskId, kind + ".taskId", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") } as CoordinatorRpcRequest;
    case "background.trigger":
      return { kind, taskId: text(request.taskId, kind + ".taskId", 256), reason: text(request.reason, kind + ".reason", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "background.cancel-by-key": return { kind, publicKeyHex: text(request.publicKeyHex, kind + ".publicKeyHex", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "background.settings.update": return { kind, settings: parseBackgroundSettings(request.settings), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "p2pkh.settings.update": {
      const settings = expectRecord(request.settings, kind + ".settings");
      return { kind, settings: { includeTestnet: booleanValue(settings.includeTestnet, kind + ".settings.includeTestnet") }, expectedSessionEpoch: epoch("expectedSessionEpoch") };
    }
    case "p2pkh.provider-config.get": return { kind, providerId: text(request.providerId, kind + ".providerId", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "p2pkh.provider-config.update": return { kind, providerId: text(request.providerId, kind + ".providerId", 256), config: parseJsonRecord(request.config, kind + ".config"), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "p2pkh.utxos.get":
    case "p2pkh.utxos.refresh":
      return { kind, ownerPublicKeyHex: text(request.ownerPublicKeyHex, kind + ".ownerPublicKeyHex", 256), network: request.network === "main" || request.network === "test" ? request.network : (() => { throw new TypeError("P2PKH network is invalid"); })(), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "p2pkh.broadcast": {
      const submission = parseP2pkhBroadcastSubmission(request.submission, kind + ".submission");
      return {
        kind,
        ownerPublicKeyHex: text(request.ownerPublicKeyHex, kind + ".ownerPublicKeyHex", 256),
        network: request.network === "main" || request.network === "test" ? request.network : (() => { throw new TypeError("P2PKH network is invalid"); })(),
        submissionId: text(request.submissionId, kind + ".submissionId", 256),
        ...(submission === undefined ? {} : { submission }),
        expectedSessionEpoch: epoch("expectedSessionEpoch"),
      };
    }
    default:
      throw new TypeError("Coordinator RPC request kind " + kind + " is unsupported");
  }
}

/** Strip transport identity after re-running the same production parser. */
export function toCoordinatorRpcRequest<R extends CoordinatorClientCommandRequest>(
  request: R,
): CoordinatorRpcRequestFromClient<R> {
  const wire = { ...request } as unknown as RecordValue;
  delete wire.clientId;
  delete wire.requestId;
  return parseCoordinatorRequest(wire) as CoordinatorRpcRequestFromClient<R>;
}

export type CoordinatorRpcCommandRequest = Exclude<CoordinatorRpcRequest, { kind: "session.open" | "session.close" | "session.activity" }>;

/** Add identity only at the Worker-side adapter; callers cannot supply it. */
export function coordinatorClientRequestFromRpc<K extends CoordinatorRpcCommandRequest["kind"]>(
  request: Extract<CoordinatorRpcCommandRequest, { kind: K }>,
  clientId: string,
  requestId: string,
): Extract<CoordinatorClientCommandRequest, { kind: K }> {
  return { ...request, clientId, requestId } as Extract<CoordinatorClientCommandRequest, { kind: K }>;
}

/**
 * Window 反向 LocalStorage I/O 契约。
 *
 * 这是唯一允许 Coordinator 触碰页面 localStorage 的 capability。请求不
 * 携带 AbortSignal 或 authority；AbortSignal 由 WebLoom call context 绑定。
 * peerGeneration/sessionEpoch/leaseId 是 Worker 发放的 fencing metadata，
 * 由两端 parser 保留并在执行点校验。
 */
export interface CoordinatorLocalStorageObject {
  path: string;
  /**
   * 字节必须用 `ArrayBuffer`：RPC DTO 校验对 TypedArray 是 O(bytes)，
   * 逐元素检查会让 256 KiB 块和普通文件 I/O 都付出数百毫秒级开销。
   */
  bytes: ArrayBuffer;
  size?: number;
  etag?: string;
  lastModified?: string;
}

export type CoordinatorLocalStorageRequest =
  // 对象 I/O：页面桥只按当前 lease 的桶与世代读写 Local 命名空间。
  | (CoordinatorSessionBinding & { type: "get"; bucketId: string; bucketGeneration: number; path: string; ifMatch?: string; objectPrefix?: string })
  | (CoordinatorSessionBinding & { type: "list"; bucketId: string; bucketGeneration: number; prefix?: string; cursor?: string; limit?: number; objectPrefix?: string })
  | (CoordinatorSessionBinding & { type: "put"; bucketId: string; bucketGeneration: number; path: string; bytes: ArrayBuffer; condition?: StorageBucketWriteCondition; objectPrefix?: string })
  | (CoordinatorSessionBinding & { type: "delete"; bucketId: string; bucketGeneration: number; path: string; ifMatch?: string; objectPrefix?: string })
  /** 设备桶记录（keymaster.device.<ID>）的读/写/删/枚举。 */
  | (CoordinatorSessionBinding & { type: "device-record-list" })
  | (CoordinatorSessionBinding & { type: "device-record-get"; remoteStorageId: string })
  | (CoordinatorSessionBinding & { type: "device-record-put"; remoteStorageId: string; record: DeviceRecordV1; replace?: boolean })
  | (CoordinatorSessionBinding & { type: "device-record-delete"; remoteStorageId: string })
  /** 浏览器 session（keymaster.session）的读/写。 */
  | (CoordinatorSessionBinding & { type: "session-read" })
  | (CoordinatorSessionBinding & { type: "session-write"; session: KeymasterSessionV1 });

export type CoordinatorLocalStorageResponse =
  | { type: "object"; object?: CoordinatorLocalStorageObject }
  | { type: "list"; objects: CoordinatorLocalStorageObject[]; nextCursor?: string }
  | { type: "write"; etag?: string; lastModified?: string }
  | { type: "void" }
  | { type: "device-records"; entries: Array<{ remoteStorageId: string; record: DeviceRecordV1 }>; invalidKeys: string[] }
  | { type: "device-record"; record?: DeviceRecordV1 }
  | { type: "session"; session?: KeymasterSessionV1 };

/** 事件 stream 的订阅请求。一次订阅可以覆盖多个 Coordinator topic。 */
export interface CoordinatorTopicSubscription {
  topics: CoordinatorTopic[];
}

/** owner-storage RPC 的按操作结果联合；调用方仍可按操作收窄。 */
export type CoordinatorOwnerStorageResult =
  | KeyValueEntry<unknown>
  | KeyValueEntry<unknown>[]
  | KeyValueListResult
  | KeyValueEntryMeta
  | KeyValueCommitResult
  | undefined
  | null;

/** platform-storage 与 owner-storage 共用 parser 形状，但 capability 身份分离。 */
export type CoordinatorPlatformStorageResult = CoordinatorOwnerStorageResult;

function parseAck(value: unknown): CoordinatorCommandAck {
  if (!record(value)) throw new TypeError("Coordinator response ack is invalid");
  const status = text(value.status, "response.ack.status", 64);
  if (status === "accepted" || status === "already-unlocked" || status === "already-running"
    || status === "stale-epoch" || status === "locked" || status === "not-ready" || status === "ok") return { status };
  if (status === "blocked") {
    return { status, reason: parseI18nText(value.reason, "response.ack.reason") };
  }
  if (status === "validation-error") return { status, message: text(value.message, "response.ack.message", 2_048) };
  if (status === "error") {
    const message = text(value.message, "response.ack.message", 2_048);
    const code = optionalText(value.code, "response.ack.code", 128);
    return { status, message, ...(code === undefined ? {} : { code }) };
  }
  throw new TypeError("Coordinator response ack status is invalid");
}

function parseI18nValues(value: unknown, field: string): I18nValues {
  const values = expectRecord(value, field);
  const result: I18nValues = {};
  for (const [key, item] of Object.entries(values)) {
    if (item === undefined || item === null || typeof item === "string" || typeof item === "boolean") {
      result[key] = item;
    } else if (typeof item === "number" && Number.isFinite(item)) {
      result[key] = item;
    } else {
      throw new TypeError(`Coordinator ${field}.${key} is invalid`);
    }
  }
  return result;
}

function parseI18nText(value: unknown, field: string): I18nText {
  if (typeof value === "string") return text(value, field, 2_048);
  const input = expectRecord(value, field);
  const key = text(input.key, field + ".key", 256);
  const fallback = text(input.fallback, field + ".fallback", 2_048);
  const values = input.values === undefined ? undefined : parseI18nValues(input.values, field + ".values");
  return { key, fallback, ...(values === undefined ? {} : { values }) };
}

function validateWireValue(value: unknown, field: string, depth = 0, seen = new Set<object>()): void {
  if (depth > 48) throw new TypeError("Coordinator " + field + " exceeds the DTO depth limit");
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Coordinator " + field + " contains a non-finite number");
    return;
  }
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) return;
  if (isMessagePortLike(value)) return;
  if (!value || typeof value !== "object" || seen.has(value)) {
    if (seen.has(value as object)) throw new TypeError("Coordinator " + field + " contains a cycle");
    throw new TypeError("Coordinator " + field + " contains an invalid value");
  }
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("Coordinator " + field + " contains a symbol key");
    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor && "value" in lengthDescriptor && typeof lengthDescriptor.value === "number"
        ? lengthDescriptor.value
        : Number.NaN;
      if (!Number.isSafeInteger(length) || length > 4_096) throw new TypeError("Coordinator " + field + " array is invalid");
      for (const key of Object.getOwnPropertyNames(value)) {
        if (key === "length") continue;
        if (!/^\d+$/u.test(key) || String(Number(key)) !== key || Number(key) >= length) {
          throw new TypeError("Coordinator " + field + " contains a non-index array property");
        }
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("Coordinator " + field + " contains an accessor or sparse array item");
        }
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("Coordinator " + field + " contains an accessor or sparse array item");
        }
        validateWireValue(descriptor.value, field + "[" + index + "]", depth + 1, seen);
      }
    } else {
      if (!record(value)) throw new TypeError("Coordinator " + field + " must be a plain object");
      const keys = Object.getOwnPropertyNames(value);
      if (keys.length > 4_096) throw new TypeError("Coordinator " + field + " has too many keys");
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("Coordinator " + field + " contains an accessor or hidden property");
        }
        validateWireValue(descriptor.value, field + "." + key, depth + 1, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseCoordinatorResponseBase(value: unknown): CoordinatorRpcResponse {
  const response = expectRecord(value, "RPC response");
  if (hasOwn(response, "requestId") || hasOwn(response, "clientId") || hasOwn(response, "operationId") || hasOwn(response, "peerId") || hasOwn(response, "callId")) {
    throw new TypeError("Coordinator RPC response contains transport identity");
  }
  const sessionEpoch = text(response.sessionEpoch, "response.sessionEpoch", 256);
  const ack = parseAck(response.ack);
  const hasOperationResult = hasOwn(response, "operationResult");
  const hasCryptoResult = hasOwn(response, "cryptoResult");
  if (hasOperationResult) validateWireValue(response.operationResult, "response.operationResult");
  const cryptoResult = hasCryptoResult ? parseCryptoResult(response.cryptoResult) : undefined;
  return {
    sessionEpoch,
    ack,
    ...(hasOperationResult ? { operationResult: response.operationResult } : {}),
    ...(hasCryptoResult ? { cryptoResult: cryptoResult! } : {}),
  };
}

function parseCoordinatorVaultKeyView(value: unknown, field: string): CoordinatorVaultKeyView {
  const key = expectRecord(value, field);
  const publicKeyHex = text(key.publicKeyHex, field + ".publicKeyHex", 66);
  if (!/^(02|03)[0-9a-f]{64}$/iu.test(publicKeyHex)) throw new TypeError(`Coordinator ${field}.publicKeyHex is invalid`);
  const address = optionalText(key.address, field + ".address", 512);
  const network = key.network === undefined ? undefined : enumValue(key.network, ["main", "test"] as const, field + ".network");
  const source = optionalText(key.source, field + ".source", 512);
  return {
    publicKeyHex,
    label: text(key.label, field + ".label", 256),
    capabilities: stringList(key.capabilities, field + ".capabilities", 64, 128),
    createdAt: text(key.createdAt, field + ".createdAt", 128),
    format: text(key.format, field + ".format", 128),
    ...(address === undefined ? {} : { address }),
    ...(network === undefined ? {} : { network }),
    ...(source === undefined ? {} : { source }),
  };
}

function parseVaultSealedSecret(value: unknown, field: string): VaultSealedSecret {
  const sealed = expectRecord(value, field);
  if (sealed.version !== 3 || sealed.keySource !== "active-key-hkdf-v1") throw new TypeError(`Coordinator ${field} version is invalid`);
  return {
    version: 3,
    keySource: "active-key-hkdf-v1",
    saltHex: text(sealed.saltHex, field + ".saltHex", 512),
    nonceHex: text(sealed.nonceHex, field + ".nonceHex", 512),
    ciphertextHex: text(sealed.ciphertextHex, field + ".ciphertextHex", 2_000_000),
  };
}

function parseCoordinatorVaultOperationResult(value: unknown, field: string): CoordinatorVaultOperationResult {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return text(value, field, 2_000_000);
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) {
    return value.map((item, index) => parseCoordinatorVaultKeyView(item, `${field}[${index}]`));
  }
  const object = expectRecord(value, field);
  if (object.version === 3 || object.keySource === "active-key-hkdf-v1") return parseVaultSealedSecret(object, field);
  if ("intentId" in object) {
    return { intentId: text(object.intentId, field + ".intentId", 256), publicKeyHex: text(object.publicKeyHex, field + ".publicKeyHex", 66) };
  }
  if ("publicKeyHex" in object) return parseCoordinatorVaultKeyView(object, field);
  throw new TypeError(`Coordinator ${field} is unsupported`);
}

function parseCoordinatorBootstrapSnapshot(value: unknown, field: string): CoordinatorBootstrapSnapshot {
  const snapshot = expectRecord(value, field);
  const buildId = optionalText(snapshot.buildId, field + ".buildId", 256);
  const activePublicKeyHex = optionalText(snapshot.activePublicKeyHex, field + ".activePublicKeyHex", 256);
  const selectedPublicKeyHex = optionalText(snapshot.selectedPublicKeyHex, field + ".selectedPublicKeyHex", 256);
  const authorityRecovery = snapshot.authorityRecovery === undefined
    ? undefined
    : parseAuthorityRecovery(snapshot.authorityRecovery, field + ".authorityRecovery");
  const units = snapshot.coordinatorWorkerUnits === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(snapshot.coordinatorWorkerUnits) || snapshot.coordinatorWorkerUnits.length > 256) {
        throw new TypeError(`Coordinator ${field}.coordinatorWorkerUnits is invalid`);
      }
      return snapshot.coordinatorWorkerUnits.map((unit, index) => parseWorkerUnitSnapshot(unit, `${field}.coordinatorWorkerUnits[${index}]`));
    })();
  const workerRevision = optionalBoundedNumber(snapshot.coordinatorWorkerUnitSnapshotRevision, field + ".coordinatorWorkerUnitSnapshotRevision");
  const p2pkhSettings = snapshot.p2pkhSettings === undefined
    ? undefined
    : (() => {
      const settings = expectRecord(snapshot.p2pkhSettings, field + ".p2pkhSettings");
      return { includeTestnet: booleanValue(settings.includeTestnet, field + ".p2pkhSettings.includeTestnet") };
    })();
  const storageBucketGeneration = optionalBoundedNumber(snapshot.storageBucketGeneration, field + ".storageBucketGeneration");
  const storageBucketId = optionalText(snapshot.storageBucketId, field + ".storageBucketId", 256);
  const pluginIntent = snapshot.pluginIntent === undefined
    ? undefined
    : parsePluginIntentSnapshot(snapshot.pluginIntent, field + ".pluginIntent");
  const storageIoOwnerPeer = snapshot.storageIoOwnerPeer === undefined
    ? undefined
    : (() => {
      const owner = expectRecord(snapshot.storageIoOwnerPeer, field + ".storageIoOwnerPeer");
      const binding = expectRecord(owner.binding, field + ".storageIoOwnerPeer.binding");
      return {
        peerId: text(owner.peerId, field + ".storageIoOwnerPeer.peerId", 256),
        binding: {
          runtimeInstanceId: text(binding.runtimeInstanceId, field + ".storageIoOwnerPeer.binding.runtimeInstanceId", 256),
          connectionId: text(binding.connectionId, field + ".storageIoOwnerPeer.binding.connectionId", 256),
        },
        handoffRevision: boundedNumber(owner.handoffRevision, field + ".storageIoOwnerPeer.handoffRevision"),
      };
    })();
  return {
    authorityInstanceId: text(snapshot.authorityInstanceId, field + ".authorityInstanceId", 256),
    ...(buildId === undefined ? {} : { buildId }),
    sessionEpoch: text(snapshot.sessionEpoch, field + ".sessionEpoch", 256),
    vaultStatus: enumValue(snapshot.vaultStatus, ["booting", "uninitialized", "locked", "unlocked", "fatal"] as const, field + ".vaultStatus"),
    ...(activePublicKeyHex === undefined ? {} : { activePublicKeyHex }),
    ...(selectedPublicKeyHex === undefined ? {} : { selectedPublicKeyHex }),
    keyspaceGeneration: boundedNumber(snapshot.keyspaceGeneration, field + ".keyspaceGeneration"),
    ...(authorityRecovery === undefined ? {} : { authorityRecovery }),
    ...(units === undefined ? {} : { coordinatorWorkerUnits: units }),
    ...(workerRevision === undefined ? {} : { coordinatorWorkerUnitSnapshotRevision: workerRevision }),
    taskSnapshots: (() => {
      if (!Array.isArray(snapshot.taskSnapshots) || snapshot.taskSnapshots.length > 4_096) throw new TypeError(`Coordinator ${field}.taskSnapshots is invalid`);
      return snapshot.taskSnapshots.map((task, index) => parseTaskSnapshot(task, `${field}.taskSnapshots[${index}]`));
    })(),
    scheduleSettings: parseBackgroundSettings(snapshot.scheduleSettings),
    ...(p2pkhSettings === undefined ? {} : { p2pkhSettings }),
    ...(storageBucketGeneration === undefined ? {} : { storageBucketGeneration }),
    ...(storageBucketId === undefined ? {} : { storageBucketId }),
    ...(pluginIntent === undefined ? {} : { pluginIntent }),
    ...(storageIoOwnerPeer === undefined ? {} : { storageIoOwnerPeer }),
  };
}

function parseCoordinatorSessionBinding(value: unknown, field: string): CoordinatorSessionOpenResult["sessionBinding"] {
  const binding = expectRecord(value, field);
  return {
    peerGeneration: boundedNumber(binding.peerGeneration, field + ".peerGeneration", 1),
    sessionEpoch: text(binding.sessionEpoch, field + ".sessionEpoch", 256),
    leaseId: text(binding.leaseId, field + ".leaseId", 256),
  };
}

function parseCoordinatorSessionOpenResult(value: unknown, field: string): CoordinatorSessionOpenResult {
  const result = expectRecord(value, field);
  const snapshot = parseCoordinatorBootstrapSnapshot(result, field);
  // session.open is the sole authority that creates the page/peer lease. A
  // response without a binding cannot safely be used by the client, even if
  // its bootstrap snapshot happens to be otherwise valid.
  const sessionBinding = parseCoordinatorSessionBinding(result.sessionBinding, field + ".sessionBinding");
  return { ...snapshot, sessionBinding };
}

function parseStorageProviderConnection(value: unknown, field: string): StorageProviderConnectionView {
  const connection = expectRecord(value, field);
  const providerId = enumValue(connection.providerId, ["cloudflare-r2", "aws-s3", "s3-compatible"] as const, field + ".providerId") as StorageProviderId;
  return { providerId, connection: parseStorageConnection(connection.connection, providerId) };
}

const STORAGE_PROBE_DIAGNOSTICS = ["configuration", "authentication", "forbidden", "not-found", "cors", "network", "provider"] as const;

function parseStorageProbeDiagnostic(value: unknown, field: string): StorageProbeResult["diagnostic"] {
  return value === undefined ? undefined : enumValue(value, STORAGE_PROBE_DIAGNOSTICS, field);
}

function parseStorageProbeResult(value: unknown, field: string): StorageProbeResult {
  const probe = expectRecord(value, field);
  const providerId = enumValue(probe.providerId, ["cloudflare-r2", "aws-s3", "s3-compatible"] as const, field + ".providerId") as StorageProviderId;
  const diagnostic = parseStorageProbeDiagnostic(probe.diagnostic, field + ".diagnostic");
  return {
    ok: booleanValue(probe.ok, field + ".ok"),
    providerId,
    latencyMs: boundedNumber(probe.latencyMs, field + ".latencyMs"),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function parseStorageSelectedResult(value: unknown, field: string): StorageSelectedResult {
  const result = expectRecord(value, field);
  if (result.status !== "selected" || result.backend !== "s3" || result.requiresRuntimeBootstrap !== true) {
    throw new TypeError(`Coordinator ${field} is not a valid selected result`);
  }
  return { status: "selected", backend: "s3", requiresRuntimeBootstrap: true };
}

/** 探测结果：has-keys 只暴露公开身份与标签,不含密码或密文。 */
function parseDeviceCapabilities(value: unknown, field: string): DeviceCapabilitiesV1 {
  const record = expectRecord(value, field);
  const mode = record.conditionalWrites;
  if (mode !== "native" && mode !== "best-effort") throw new TypeError(`Coordinator ${field}.conditionalWrites is invalid`);
  return { conditionalWrites: mode };
}

function parseBucketProbeResultFor(value: unknown, field: string): import("./storage/catalog.js").BucketProbeResult {
  const result = expectRecord(value, field);
  const conditionalWrites = result.conditionalWrites === undefined
    ? undefined
    : parseDeviceCapabilities({ conditionalWrites: result.conditionalWrites }, `${field}.conditionalWrites`).conditionalWrites;
  if (result.ok === true) {
    if (result.state === "empty") return { ok: true, state: "empty", ...(conditionalWrites === undefined ? {} : { conditionalWrites }) };
    if (result.state !== "has-keys" || !Array.isArray(result.keys)) throw new TypeError(`Coordinator ${field} is invalid`);
    const keys = result.keys.map((item, index) => {
      const key = expectRecord(item, `${field}.keys[${index}]`);
      return {
        publicKeyHex: text(key.publicKeyHex, `${field}.keys[${index}].publicKeyHex`, 128),
        label: text(key.label, `${field}.keys[${index}].label`, 256),
      };
    });
    return { ok: true, state: "has-keys", keys, ...(conditionalWrites === undefined ? {} : { conditionalWrites }) };
  }
  if (result.ok === false) return { ok: false, error: parseStorageUserFacingError(result.error, `${field}.error`) };
  throw new TypeError(`Coordinator ${field} is invalid`);
}

function parseStorageUserFacingError(value: unknown, field: string): NonNullable<InitialSetupRecoveryRecordV1["error"]> {
  const error = expectRecord(value, field);
  const action = optionalText(error.action, field + ".action", 512);
  const transactionId = optionalText(error.transactionId, field + ".transactionId", 128);
  return {
    title: text(error.title, field + ".title", 256),
    summary: text(error.summary, field + ".summary", 2_048),
    ...(action === undefined ? {} : { action }),
    code: text(error.code, field + ".code", 128),
    incidentId: text(error.incidentId, field + ".incidentId", 128),
    ...(transactionId === undefined ? {} : { transactionId }),
    diagnostic: text(error.diagnostic, field + ".diagnostic", 12_000),
    phase: enumValue(error.phase, ["validate", "stage", "hold", "catalog-commit", "runtime", "rollback", "complete"] as const, field + ".phase"),
    rollback: enumValue(error.rollback, ["not-started", "confirmed", "unconfirmed"] as const, field + ".rollback"),
  };
}

function parseInitialSetupKeyResult(value: unknown, field: string): Extract<InitialSetupResult, { ok: true }>["firstKey"] {
  const key = expectRecord(value, field);
  const source = optionalText(key.source, field + ".source", 512);
  return {
    publicKeyHex: text(key.publicKeyHex, field + ".publicKeyHex", 66),
    label: text(key.label, field + ".label", 256),
    address: text(key.address, field + ".address", 512),
    format: text(key.format, field + ".format", 128),
    capabilities: stringList(key.capabilities, field + ".capabilities", 64, 128),
    createdAt: text(key.createdAt, field + ".createdAt", 128),
    ...(source === undefined ? {} : { source }),
  };
}

function parseInitialSetupResult(value: unknown, field: string): InitialSetupResult {
  const result = expectRecord(value, field);
  if (result.ok === true) return {
    ok: true,
    bucket: parseRuntimeBucket(result.bucket, field + ".bucket"),
    firstKey: parseInitialSetupKeyResult(result.firstKey, field + ".firstKey"),
  };
  if (result.ok === false) return { ok: false, error: parseStorageUserFacingError(result.error, field + ".error") };
  throw new TypeError(`Coordinator ${field}.ok is invalid`);
}

function parseExistingRemoteStorageConnectResult(value: unknown, field: string): ExistingRemoteStorageConnectResult {
  const result = expectRecord(value, field);
  if (result.ok === true) {
    return {
      ok: true,
      bucket: parseRuntimeBucket(result.bucket, field + ".bucket"),
      ...(result.activeKey === undefined ? {} : { activeKey: parseInitialSetupKeyResult(result.activeKey, field + ".activeKey") }),
    };
  }
  if (result.ok === false) return { ok: false, error: parseStorageUserFacingError(result.error, field + ".error") };
  throw new TypeError(`Coordinator ${field}.ok is invalid`);
}

function parseStorageRecoveryResult(value: unknown, field: string): InitialSetupRecoveryResult {
  const result = expectRecord(value, field);
  const status = text(result.status, field + ".status", 64);
  if (status === "setup-succeeded") return {
    status,
    result: parseInitialSetupResult(result.result, field + ".result") as Extract<InitialSetupResult, { ok: true }>,
  };
  if (status === "cleanup-confirmed" || status === "not-found") return { status };
  if (status === "cleanup-required") return { status, error: parseStorageUserFacingError(result.error, field + ".error") };
  throw new TypeError(`Coordinator ${field}.status is invalid`);
}

function parseStorageBucketSwitchResult(value: unknown, field: string): StorageBucketSwitchResultV1 {
  const result = expectRecord(value, field);
  if (result.ok !== true) throw new TypeError(`Coordinator ${field}.ok is invalid`);
  return { ok: true, bucket: parseRuntimeBucket(result.bucket, field + ".bucket"), vaultUnlocked: booleanValue(result.vaultUnlocked, field + ".vaultUnlocked") };
}

function parseStorageUnlockBucketResult(value: unknown, field: string): CoordinatorStorageUnlockBucketResult {
  const result = expectRecord(value, field);
  if (result.ok === true) return { ok: true, vaultUnlocked: booleanValue(result.vaultUnlocked, field + ".vaultUnlocked") };
  if (result.ok === false) return { ok: false, diagnostic: text(result.diagnostic, field + ".diagnostic", 4_096) };
  throw new TypeError(`Coordinator ${field}.ok is invalid`);
}

function parseStorageControlResult(value: unknown, field: string): CoordinatorStorageControlResult {
  if (value === undefined || value === null) return value;
  if (value instanceof Uint8Array) return value.slice();
  if (typeof value === "string") {
    return enumValue(value, ["unselected", "authentication", "checking", "ready", "degraded", "incompatible", "unconfigured", "locked", "reconfiguring"] as const, field);
  }
  if (Array.isArray(value)) return value.map((item, index) => parseLocalStorageRecoveryRecord(item, `${field}[${index}]`));
  const result = expectRecord(value, field);
  if (result.status === "setup-succeeded" || result.status === "cleanup-confirmed" || result.status === "cleanup-required" || result.status === "not-found") return parseStorageRecoveryResult(result, field);
  if ("firstKey" in result || (result.ok === false && "error" in result)) return parseInitialSetupResult(result, field);
  if (result.ok === true && "vaultUnlocked" in result) return parseStorageBucketSwitchResult(result, field);
  if (result.ok === false && "diagnostic" in result && !("providerId" in result)) return parseStorageUnlockBucketResult(result, field);
  if ("providerId" in result && "connection" in result) return parseStorageProviderConnection(result, field);
  if ("bucketHint" in result) return parseStorageProviderSummary(result, field);
  if ("put" in result && "complete" in result) return parseStorageCapabilities(result, field);
  if ("put" in result && typeof result.put === "string" && "cleanupWarning" in result) {
    const put = enumValue(result.put, ["native", "best-effort", "inconclusive"] as const, field + ".put");
    const complete = enumValue(result.complete, ["native", "best-effort", "inconclusive"] as const, field + ".complete");
    return { generation: boundedNumber(result.generation, field + ".generation"), put, complete, cleanupWarning: booleanValue(result.cleanupWarning, field + ".cleanupWarning") };
  }
  if ("bucketId" in result && "deviceRecord" in result) return parseRuntimeBucket(result, field);
  throw new TypeError(`Coordinator ${field} is unsupported`);
}

function parseStorageListEntry(value: unknown, field: string): StorageListResult["files"][number] {
  const entry = expectRecord(value, field);
  const etag = optionalText(entry.etag, field + ".etag", 512);
  const lastModified = optionalText(entry.lastModified, field + ".lastModified", 128);
  return {
    path: text(entry.path, field + ".path", 4_096),
    name: text(entry.name, field + ".name", 512),
    size: boundedNumber(entry.size, field + ".size"),
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
}

function parseStorageListResult(value: unknown, field: string): StorageListResult {
  const result = expectRecord(value, field);
  if (!Array.isArray(result.directories) || !Array.isArray(result.files)) throw new TypeError(`Coordinator ${field} list arrays are invalid`);
  const directories = result.directories.map((item, index) => {
    const directory = expectRecord(item, `${field}.directories[${index}]`);
    return { path: text(directory.path, `${field}.directories[${index}].path`, 4_096), name: text(directory.name, `${field}.directories[${index}].name`, 512) };
  });
  const markerPath = optionalText(result.markerPath, field + ".markerPath", 4_096);
  const nextCursor = optionalText(result.nextCursor, field + ".nextCursor", 8_192);
  return {
    prefix: text(result.prefix, field + ".prefix", 4_096),
    parentPrefix: text(result.parentPrefix, field + ".parentPrefix", 4_096),
    directories,
    files: result.files.map((item, index) => parseStorageListEntry(item, `${field}.files[${index}]`)),
    ...(markerPath === undefined ? {} : { markerPath }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function parseStorageDirectoryResult(value: unknown, field: string): StorageDirectoryResult {
  const result = expectRecord(value, field);
  const created = optionalBoolean(result.created, field + ".created");
  const deleted = optionalBoolean(result.deleted, field + ".deleted");
  return { path: text(result.path, field + ".path", 4_096), ...(created === undefined ? {} : { created }), ...(deleted === undefined ? {} : { deleted }) };
}

function parseStoragePutResult(value: unknown, field: string): StoragePutResult {
  const result = expectRecord(value, field);
  const etag = optionalText(result.etag, field + ".etag", 512);
  return { path: text(result.path, field + ".path", 4_096), size: boundedNumber(result.size, field + ".size"), updatedAt: boundedNumber(result.updatedAt, field + ".updatedAt"), ...(etag === undefined ? {} : { etag }) };
}

function parseStorageGetResult(value: unknown, field: string): StorageGetResult {
  const result = expectRecord(value, field);
  const contentType = optionalText(result.contentType, field + ".contentType", 256);
  const etag = optionalText(result.etag, field + ".etag", 512);
  const lastModified = optionalText(result.lastModified, field + ".lastModified", 128);
  return {
    path: text(result.path, field + ".path", 4_096),
    content: parseBinaryField(result.content, field + ".content"),
    ...(contentType === undefined ? {} : { contentType }),
    offset: boundedNumber(result.offset, field + ".offset"),
    totalSize: boundedNumber(result.totalSize, field + ".totalSize"),
    eof: booleanValue(result.eof, field + ".eof"),
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
}

function parseStorageDeleteResult(value: unknown, field: string): StorageDeleteResult {
  const result = expectRecord(value, field);
  if (result.deleted !== true) throw new TypeError(`Coordinator ${field}.deleted is invalid`);
  return { path: text(result.path, field + ".path", 4_096), deleted: true, updatedAt: boundedNumber(result.updatedAt, field + ".updatedAt") };
}

function parseStorageUploadResult(value: unknown, field: string): StorageUploadBeginResult | StorageUploadPartResult | StorageUploadAbortResult {
  const result = expectRecord(value, field);
  const uploadId = text(result.uploadId, field + ".uploadId", 256);
  if (result.aborted === true) return { uploadId, aborted: true };
  if (result.partSize !== undefined) {
    if (result.partSize !== STORAGE_PART_SIZE_BYTES || result.maxParts !== STORAGE_MAX_PARTS) throw new TypeError(`Coordinator ${field} multipart limits are invalid`);
    return { uploadId, partSize: STORAGE_PART_SIZE_BYTES, maxParts: STORAGE_MAX_PARTS };
  }
  if (result.partNumber !== undefined) return { uploadId, partNumber: boundedNumber(result.partNumber, field + ".partNumber", 1, STORAGE_MAX_PARTS), size: boundedNumber(result.size, field + ".size") };
  throw new TypeError(`Coordinator ${field} upload result is unsupported`);
}

function parseStorageUploadBeginResult(value: unknown, field: string): StorageUploadBeginResult {
  const result = parseStorageUploadResult(value, field);
  if (!("partSize" in result)) throw new TypeError(`Coordinator ${field} is not a begin-upload result`);
  return result;
}

function parseStorageUploadPartResult(value: unknown, field: string): StorageUploadPartResult {
  const result = parseStorageUploadResult(value, field);
  if (!("partNumber" in result)) throw new TypeError(`Coordinator ${field} is not an upload-part result`);
  return result;
}

function parseStorageUploadAbortResult(value: unknown, field: string): StorageUploadAbortResult {
  const result = parseStorageUploadResult(value, field);
  if (!("aborted" in result)) throw new TypeError(`Coordinator ${field} is not an abort-upload result`);
  return result;
}

function parseStorageDataResult(value: unknown, field: string): CoordinatorStorageDataResult {
  if (value === undefined) return undefined;
  const result = expectRecord(value, field);
  if ("directories" in result && "files" in result) return parseStorageListResult(result, field);
  if ("content" in result && "offset" in result) return parseStorageGetResult(result, field);
  if (result.deleted === true) return parseStorageDeleteResult(result, field);
  if ("uploadId" in result) return parseStorageUploadResult(result, field);
  if ("path" in result && "size" in result && "updatedAt" in result) return parseStoragePutResult(result, field);
  if ("path" in result && ("created" in result || "deleted" in result)) return parseStorageDirectoryResult(result, field);
  throw new TypeError(`Coordinator ${field} is unsupported`);
}

function parseStorageOwnerGrant(value: unknown, field: string): StorageOwnerGrant {
  const grant = expectRecord(value, field);
  // owner 数据模型:K-V 或文件根;不能硬编码成 kv,否则 files 声明绑定会被判不匹配。
  const model = enumValue(grant.model, ["kv", "files"] as const, field + ".model");
  // 与 parseStorageDeclaration 一致:files 模型允许空 purposeId(模块根,
  // 例如 p2p/setting.json 或 p2pkh 整个模块共享目录),K-V 仍必须有 purpose。
  const purposeId = model === "files" && grant.purposeId === ""
    ? ""
    : text(grant.purposeId, field + ".purposeId", 63);
  return {
    storageGrantId: text(grant.storageGrantId, field + ".storageGrantId", 256),
    bucketId: text(grant.bucketId, field + ".bucketId", 256),
    bucketGeneration: boundedNumber(grant.bucketGeneration, field + ".bucketGeneration"),
    ownerPublicKeyHex: text(grant.ownerPublicKeyHex, field + ".ownerPublicKeyHex", 66),
    moduleId: text(grant.moduleId, field + ".moduleId", 63),
    purposeId,
    authority: enumValue(grant.authority, ["built-in-module", "third-party-app"] as const, field + ".authority"),
    model,
    schemaVersion: boundedNumber(grant.schemaVersion, field + ".schemaVersion", 1),
    sessionEpoch: text(grant.sessionEpoch, field + ".sessionEpoch", 256),
  };
}

function parseStoragePlatformGrant(value: unknown, field: string): StoragePlatformGrant {
  const grant = expectRecord(value, field);
  return {
    platformGrantId: text(grant.platformGrantId, field + ".platformGrantId", 256),
    bucketId: text(grant.bucketId, field + ".bucketId", 256),
    bucketGeneration: boundedNumber(grant.bucketGeneration, field + ".bucketGeneration"),
    moduleId: text(grant.moduleId, field + ".moduleId", 63),
    purposeId: text(grant.purposeId, field + ".purposeId", 63),
    authority: enumValue(grant.authority, ["platform-only", "built-in-module"] as const, field + ".authority"),
    model: "kv",
    // 与存储声明一致：schemaVersion（数据结构版本）是从 1 开始的安全整数。
    schemaVersion: boundedNumber(grant.schemaVersion, field + ".schemaVersion", 1),
    sessionEpoch: text(grant.sessionEpoch, field + ".sessionEpoch", 256),
  };
}

function parseMsFileStatEntry(value: unknown, field: string): MsFileStatResult["suppliers"][number] {
  const supplier = expectRecord(value, field);
  const supplierPublicKeyHex = text(supplier.supplierPublicKeyHex, field + ".supplierPublicKeyHex", 66);
  if (!isValidMsFileSupplierPublicKeyHex(supplierPublicKeyHex)) throw new TypeError(`Coordinator ${field}.supplierPublicKeyHex is invalid`);
  const status = enumValue(supplier.status, ["available", "absent", "discovering", "quoted", "network-error"] as const, field + ".status");
  if (status === "absent" || status === "network-error") return { supplierPublicKeyHex, status };
  if (status === "discovering") return { supplierPublicKeyHex, status, retryAfterMs: boundedNumber(supplier.retryAfterMs, field + ".retryAfterMs") };
  const recommendedFilename = text(supplier.recommendedFilename, field + ".recommendedFilename", 512);
  const fileSizeBytes = parseMsFileSatoshiAmount(supplier.fileSizeBytes, field + ".fileSizeBytes");
  const mediaType = text(supplier.mediaType, field + ".mediaType", 256);
  if (status === "available") return { supplierPublicKeyHex, status, recommendedFilename, fileSizeBytes, mediaType };
  return {
    supplierPublicKeyHex,
    status,
    recommendedFilename,
    fileSizeBytes,
    mediaType,
    minSeedPriceSatoshis: parseMsFileSatoshiAmount(supplier.minSeedPriceSatoshis, field + ".minSeedPriceSatoshis"),
    maxSeedPriceSatoshis: parseMsFileSatoshiAmount(supplier.maxSeedPriceSatoshis, field + ".maxSeedPriceSatoshis"),
    minFullBlockPriceSatoshis: parseMsFileSatoshiAmount(supplier.minFullBlockPriceSatoshis, field + ".minFullBlockPriceSatoshis"),
    maxFullBlockPriceSatoshis: parseMsFileSatoshiAmount(supplier.maxFullBlockPriceSatoshis, field + ".maxFullBlockPriceSatoshis"),
  };
}

function parseMsFileStatResult(value: unknown, field: string): MsFileStatResult {
  const result = expectRecord(value, field);
  if (!Array.isArray(result.suppliers) || result.suppliers.length > 256) throw new TypeError(`Coordinator ${field}.suppliers is invalid`);
  return {
    seedHashHex: text(result.seedHashHex, field + ".seedHashHex", 64),
    suppliers: result.suppliers.map((item, index) => parseMsFileStatEntry(item, `${field}.suppliers[${index}]`)),
  };
}

function parseMsFileReadResult(value: unknown, field: string): MsFileReadResult {
  const result = expectRecord(value, field);
  return { contentHashHex: text(result.contentHashHex, field + ".contentHashHex", 64), content: parseBinaryField(result.content, field + ".content") };
}

function parseMsFileSupplierProbeResult(value: unknown, field: string): MsFileSupplierProbeResult {
  const result = expectRecord(value, field);
  const supplierPublicKeyHex = text(result.supplierPublicKeyHex, field + ".supplierPublicKeyHex", 66);
  if (!isValidMsFileSupplierPublicKeyHex(supplierPublicKeyHex)) throw new TypeError(`Coordinator ${field}.supplierPublicKeyHex is invalid`);
  if (!Array.isArray(result.addresses) || result.addresses.length > 64) throw new TypeError(`Coordinator ${field}.addresses is invalid`);
  return {
    supplierPublicKeyHex,
    peerId: text(result.peerId, field + ".peerId", 512),
    connected: booleanValue(result.connected, field + ".connected"),
    startedAt: boundedNumber(result.startedAt, field + ".startedAt"),
    durationMs: boundedNumber(result.durationMs, field + ".durationMs"),
    addresses: result.addresses.map((item, index) => {
      const address = expectRecord(item, `${field}.addresses[${index}]`);
      const errorCode = optionalText(address.errorCode, `${field}.addresses[${index}].errorCode`, 256);
      return { address: text(address.address, `${field}.addresses[${index}].address`, 2_048), ok: booleanValue(address.ok, `${field}.addresses[${index}].ok`), ...(errorCode === undefined ? {} : { errorCode }) };
    }),
  };
}

function parseMsFileSettingsSnapshot(value: unknown, field: string): MsFileSettingsSnapshot {
  const result = expectRecord(value, field);
  if (!Array.isArray(result.suppliers) || result.suppliers.length > 256) throw new TypeError(`Coordinator ${field}.suppliers is invalid`);
  const globalSettings = result.globalSettings === null ? null : parseMsFileGlobalPriceSettings(result.globalSettings);
  return {
    globalSettings,
    ...parseMsFileReadConcurrency(result),
    suppliers: result.suppliers.map((item, index) => parseMsFileSupplier(item)),
    supplierGeneration: boundedNumber(result.supplierGeneration, field + ".supplierGeneration"),
  };
}

function parseMsFileAppAuthorization(value: unknown, field: string): MsFileAppAuthorizationView {
  const result = expectRecord(value, field);
  const policy = result.policy === null ? null : (() => {
    const input = expectRecord(result.policy, field + ".policy");
    return {
      key: parseMsFileAppIdentityKey(input.key),
      override: parseMsFileOverride(input.override),
      updatedAt: boundedNumber(input.updatedAt, field + ".policy.updatedAt"),
    };
  })();
  return {
    key: parseMsFileAppIdentityKey(result.key),
    appName: text(result.appName, field + ".appName", 256),
    firstSeenAt: boundedNumber(result.firstSeenAt, field + ".firstSeenAt"),
    lastSeenAt: boundedNumber(result.lastSeenAt, field + ".lastSeenAt"),
    policy,
  };
}

function parseMsFileControlResult(value: unknown, field: string): CoordinatorMsFileControlResult {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return enumValue(value, ["unconfigured", "ready", "unavailable"] as const, field);
  if (typeof value === "number") return boundedNumber(value, field, 1, 16);
  if (Array.isArray(value)) {
    if (value.length === 0 || value.every((item) => record(item) && "approvalId" in item)) {
      return value.map((item, index) => parseMsFilePendingApproval(item, `${field}[${index}]`));
    }
    return value.map((item, index) => parseMsFileAppAuthorization(item, `${field}[${index}]`));
  }
  const result = expectRecord(value, field);
  if ("suppliers" in result && "globalSettings" in result) return parseMsFileSettingsSnapshot(result, field);
  if ("mediaBlockReadConcurrency" in result && "globalSeedReadConcurrency" in result && "globalBlockReadConcurrency" in result && "globalStatConcurrency" in result) return parseMsFileReadConcurrency(result);
  if ("peerId" in result) return parseMsFileSupplierProbeResult(result, field);
  throw new TypeError(`Coordinator ${field} is unsupported`);
}

function parseMsFileDataResult(value: unknown, field: string): CoordinatorMsFileDataResult {
  if (value === undefined) return undefined;
  const result = expectRecord(value, field);
  if ("suppliers" in result) return parseMsFileStatResult(result, field);
  if ("contentHashHex" in result) return parseMsFileReadResult(result, field);
  throw new TypeError(`Coordinator ${field} is unsupported`);
}

function parseSatSupplierConfig(value: unknown, field: string): SatSupplierConfigV1 {
  const supplier = expectRecord(value, field);
  const supplierPublicKeyHex = text(supplier.supplierPublicKeyHex, field + ".supplierPublicKeyHex", 66);
  if (!/^(02|03)[0-9a-f]{64}$/iu.test(supplierPublicKeyHex)) throw new TypeError(`Coordinator ${field}.supplierPublicKeyHex is invalid`);
  return {
    supplierId: text(supplier.supplierId, field + ".supplierId", 256),
    name: text(supplier.name, field + ".name", 256),
    supplierPublicKeyHex,
    multiaddrs: stringList(supplier.multiaddrs, field + ".multiaddrs", 64, 2_048),
    enabled: booleanValue(supplier.enabled, field + ".enabled"),
  };
}

function parseSatOwnerSettings(value: unknown, field: string): SatOwnerSupplierSettingsV1 {
  const settings = expectRecord(value, field);
  const ownerPublicKeyHex = text(settings.ownerPublicKeyHex, field + ".ownerPublicKeyHex", 66);
  if (!/^(02|03)[0-9a-f]{64}$/iu.test(ownerPublicKeyHex)) throw new TypeError(`Coordinator ${field}.ownerPublicKeyHex is invalid`);
  const defaultPublishSupplierId = settings.defaultPublishSupplierId === null ? null : text(settings.defaultPublishSupplierId, field + ".defaultPublishSupplierId", 256);
  return { ownerPublicKeyHex, defaultPublishSupplierId, receiveSupplierIds: stringList(settings.receiveSupplierIds, field + ".receiveSupplierIds", 64, 256) };
}

/**
 * 受控可空文本：允许空串。
 *
 * 设计缘由：SatSubscription 审计里空串是合法业务值——失败的订阅/发布
 * 记录 `chargedAmount: ""` 表示"本次没有可展示的扣费"，`subscriptions`
 * 动作的 `channel` 也是空串。校验器必须按领域语义放行。
 */
function allowEmptyText(value: unknown, field: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length > maximum) throw new TypeError(`Coordinator ${field} is invalid`);
  return value;
}

function parseSatSupplierView(value: unknown, field: string): SatSubscriptionSettingsSnapshot["supplierViews"][number] {
  const view = expectRecord(value, field);
  const supplierPublicKeyHex = text(view.supplierPublicKeyHex, field + ".supplierPublicKeyHex", 66);
  if (!/^(02|03)[0-9a-f]{64}$/iu.test(supplierPublicKeyHex)) throw new TypeError(`Coordinator ${field}.supplierPublicKeyHex is invalid`);
  const inboxChannel = view.inboxChannel === null ? null : text(view.inboxChannel, field + ".inboxChannel", 2_048);
  const lastChargedAmount = view.lastChargedAmount === null ? null : allowEmptyText(view.lastChargedAmount, field + ".lastChargedAmount", 64);
  const lastErrorCode = view.lastErrorCode === null ? null : enumValue(view.lastErrorCode, ["config", "connect", "identity", "protocol", "balance", "unknown_result", "validation", "unavailable", "conflict"] as const, field + ".lastErrorCode");
  return {
    supplierId: text(view.supplierId, field + ".supplierId", 256),
    name: text(view.name, field + ".name", 256),
    supplierPublicKeyHex,
    connectionState: enumValue(view.connectionState, ["disabled", "connecting", "online", "degraded", "disconnected"] as const, field + ".connectionState"),
    inboxChannel,
    desiredChannels: stringList(view.desiredChannels, field + ".desiredChannels", 256, 2_048),
    observedChannels: stringList(view.observedChannels, field + ".observedChannels", 256, 2_048),
    lastChargedAmount,
    lastErrorCode,
  };
}

function parseSatSettingsSnapshot(value: unknown, field: string): SatSubscriptionSettingsSnapshot {
  const snapshot = expectRecord(value, field);
  if (!Array.isArray(snapshot.suppliers) || !Array.isArray(snapshot.supplierViews)) throw new TypeError(`Coordinator ${field} arrays are invalid`);
  const ownerSettings = snapshot.ownerSettings === null ? null : parseSatOwnerSettings(snapshot.ownerSettings, field + ".ownerSettings");
  return {
    ownerPublicKeyHex: snapshot.ownerPublicKeyHex === null ? null : text(snapshot.ownerPublicKeyHex, field + ".ownerPublicKeyHex", 66),
    supplierGeneration: boundedNumber(snapshot.supplierGeneration, field + ".supplierGeneration"),
    suppliers: snapshot.suppliers.map((item, index) => parseSatSupplierConfig(item, `${field}.suppliers[${index}]`)),
    ownerSettings,
    supplierViews: snapshot.supplierViews.map((item, index) => parseSatSupplierView(item, `${field}.supplierViews[${index}]`)),
  };
}

function parseSatBillingPage(value: unknown, field: string): import("./satSubscription.js").SatBillingPage {
  const page = expectRecord(value, field);
  if (!Array.isArray(page.records)) throw new TypeError(`Coordinator ${field}.records is invalid`);
  return {
    supplierId: text(page.supplierId, field + ".supplierId", 256),
    currency: text(page.currency, field + ".currency", 128),
    network: text(page.network, field + ".network", 128),
    records: page.records.map((item, index) => {
      const record = expectRecord(item, `${field}.records[${index}]`);
      return {
        supplierId: text(record.supplierId, `${field}.records[${index}].supplierId`, 256),
        chargeId: text(record.chargeId, `${field}.records[${index}].chargeId`, 256),
        occurredAtMs: satBigInt(record.occurredAtMs, `${field}.records[${index}].occurredAtMs`),
        action: text(record.action, `${field}.records[${index}].action`, 128),
        channel: text(record.channel, `${field}.records[${index}].channel`, 2_048),
        sourceRequestIdHex: (() => {
          const sourceRequestIdHex = text(record.sourceRequestIdHex, `${field}.records[${index}].sourceRequestIdHex`, 64);
          if (!/^[0-9a-f]{64}$/u.test(sourceRequestIdHex)) throw new TypeError(`${field}.records[${index}].sourceRequestIdHex is invalid`);
          return sourceRequestIdHex;
        })(),
        chargedAmount: text(record.chargedAmount, `${field}.records[${index}].chargedAmount`, 64),
      };
    }),
    nextCursor: allowEmptyText(page.nextCursor, field + ".nextCursor", 2_048),
  };
}

function parseSatSpiInformation(value: unknown, field: string): SatSpiInformation {
  const info = expectRecord(value, field);
  if (!Array.isArray(info.currencies) || info.currencies.length > 64) throw new TypeError(`Coordinator ${field}.currencies is invalid`);
  return {
    supplierId: text(info.supplierId, field + ".supplierId", 256),
    ownerPublicKeyHex: text(info.ownerPublicKeyHex, field + ".ownerPublicKeyHex", 66),
    currencies: info.currencies.map((item, index) => {
      const currency = expectRecord(item, `${field}.currencies[${index}]`);
      return { currency: text(currency.currency, `${field}.currencies[${index}].currency`, 128), network: text(currency.network, `${field}.currencies[${index}].network`, 128), paymentAddress: text(currency.paymentAddress, `${field}.currencies[${index}].paymentAddress`, 512), balance: satBigInt(currency.balance, `${field}.currencies[${index}].balance`) };
    }),
    projectType: text(info.projectType, field + ".projectType", 256),
    projectInfoCbor: uint8ArrayValue(info.projectInfoCbor, field + ".projectInfoCbor"),
    observedAtMs: boundedNumber(info.observedAtMs, field + ".observedAtMs"),
  };
}

function parseSatTopUpPreview(value: unknown, field: string): SatTopUpPreview {
  const preview = expectRecord(value, field);
  if (preview.network !== "mainnet" && preview.network !== "testnet") throw new TypeError(`Coordinator ${field}.network is invalid`);
  validateWireValue(preview.p2pkhPreview, field + ".p2pkhPreview");
  return {
    supplierId: text(preview.supplierId, field + ".supplierId", 256),
    paymentAddress: text(preview.paymentAddress, field + ".paymentAddress", 512),
    network: preview.network,
    amountSatoshis: satBigInt(preview.amountSatoshis, field + ".amountSatoshis"),
    p2pkhPreview: preview.p2pkhPreview,
  };
}

function parseSatCollectResult(value: unknown, field: string): SatCollectResult {
  const result = expectRecord(value, field);
  const ownerPublicKeyHex = optionalText(result.ownerPublicKeyHex, field + ".ownerPublicKeyHex", 66);
  const ownerGeneration = optionalBoundedNumber(result.ownerGeneration, field + ".ownerGeneration");
  const supplierGeneration = optionalBoundedNumber(result.supplierGeneration, field + ".supplierGeneration");
  const requestWire = result.requestWire === undefined ? undefined : uint8ArrayValue(result.requestWire, field + ".requestWire");
  const recoveryBlocked = result.recoveryBlocked === undefined ? undefined : booleanValue(result.recoveryBlocked, field + ".recoveryBlocked");
  const errorCode = result.errorCode === undefined ? undefined : enumValue(result.errorCode, ["config", "connect", "identity", "protocol", "balance", "unknown_result", "validation", "unavailable", "conflict"] as const, field + ".errorCode");
  return {
    requestIdHex: text(result.requestIdHex, field + ".requestIdHex", 256),
    ...(ownerPublicKeyHex === undefined ? {} : { ownerPublicKeyHex }),
    ...(ownerGeneration === undefined ? {} : { ownerGeneration }),
    ...(supplierGeneration === undefined ? {} : { supplierGeneration }),
    supplierId: text(result.supplierId, field + ".supplierId", 256),
    currency: text(result.currency, field + ".currency", 128),
    network: text(result.network, field + ".network", 128),
    amount: satBigInt(result.amount, field + ".amount"),
    paymentAddress: text(result.paymentAddress, field + ".paymentAddress", 512),
    ...(requestWire === undefined ? {} : { requestWire }),
    ...(recoveryBlocked === undefined ? {} : { recoveryBlocked }),
    state: enumValue(result.state, ["pending", "unknown_result", "succeeded", "failed"] as const, field + ".state"),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function parseSatOperationResult(value: unknown, field: string): CoordinatorSatOperationResult {
  if (value === null) return null;
  const result = expectRecord(value, field);
  if ("supplierViews" in result) return parseSatSettingsSnapshot(result, field);
  if ("records" in result && "nextCursor" in result && "currency" in result && "network" in result) return parseSatBillingPage(result, field);
  if ("currencies" in result && "projectInfoCbor" in result) return parseSatSpiInformation(result, field);
  if ("p2pkhPreview" in result) return parseSatTopUpPreview(result, field);
  if ("requestWire" in result || ("state" in result && "amount" in result)) return parseSatCollectResult(result, field);
  if ("channels" in result && "chargedAmount" in result) return { channels: stringList(result.channels, field + ".channels", 256, 2_048), chargedAmount: text(result.chargedAmount, field + ".chargedAmount", 64) };
  if ("requestIdHex" in result && "chargedAmount" in result) return { requestIdHex: text(result.requestIdHex, field + ".requestIdHex", 256), chargedAmount: text(result.chargedAmount, field + ".chargedAmount", 64) };
  if ("status" in result && !("state" in result)) return { txid: optionalText(result.txid, field + ".txid", 128), status: text(result.status, field + ".status", 256) };
  throw new TypeError(`Coordinator ${field} is unsupported`);
}

function parseChannelOperationResult(value: unknown, field: string): CoordinatorChannelOperationResult {
  if (value === null) return null;
  const result = expectRecord(value, field);
  if ("messageId" in result) return { messageId: text(result.messageId, field + ".messageId", 256) };
  if ("channels" in result) return { channels: stringList(result.channels, field + ".channels", 256, 2_048) };
  throw new TypeError(`Coordinator ${field} is unsupported`);
}

function parsePluginIntentSubmissionResult(value: unknown, field: string): PluginIntentSubmissionResult {
  const result = expectRecord(value, field);
  const status = text(result.status, field + ".status", 64);
  const commandId = result.commandId === undefined ? undefined : text(result.commandId, field + ".commandId", 256);
  if (status === "transport-error") return { status, message: text(result.message, field + ".message", 4_096), retryable: booleanValue(result.retryable, field + ".retryable") };
  if (status === "stale-authority") return { status, commandId: text(commandId, field + ".commandId", 256), expectedAuthorityInstanceId: text(result.expectedAuthorityInstanceId, field + ".expectedAuthorityInstanceId", 256) };
  if (status === "command-conflict") return { status, commandId: text(commandId, field + ".commandId", 256), message: text(result.message, field + ".message", 4_096) };
  if (status === "accepted" || status === "duplicate") return { status, commandId: text(commandId, field + ".commandId", 256), snapshot: parsePluginIntentSnapshot(result.snapshot, field + ".snapshot"), persisted: true };
  if (status === "revision-conflict") return { status, commandId: text(commandId, field + ".commandId", 256), snapshot: parsePluginIntentSnapshot(result.snapshot, field + ".snapshot") };
  if (status === "persistence-failed") return { status, commandId: text(commandId, field + ".commandId", 256), message: text(result.message, field + ".message", 4_096), snapshot: parsePluginIntentSnapshot(result.snapshot, field + ".snapshot") };
  throw new TypeError(`Coordinator ${field}.status is invalid`);
}

function parseP2pkhProviderConfigResult(value: unknown, field: string): P2pkhProviderConfig {
  return parseJsonRecord(value, field);
}

/**
 * 解析页面提交的待广播交易快照。
 *
 * rawTxHex 允许到 256 KiB（P2PKH 转账通常 < 1 KiB，这里只做上界防御）；
 * canonical txid 与原始交易的一致性由 Worker 用生产解析器复核，解析层
 * 只校验形状，不把“字段合法”当成交易合法。
 */
function parseP2pkhBroadcastSubmission(value: unknown, field: string): P2pkhBroadcastSubmission | undefined {
  if (value === undefined) return undefined;
  const submission = expectRecord(value, field);
  const txid = text(submission.txid, field + ".txid", 64);
  if (!/^[0-9a-f]{64}$/u.test(txid.toLowerCase())) throw new TypeError(`Coordinator ${field}.txid is invalid`);
  const rawTxHex = text(submission.rawTxHex, field + ".rawTxHex", 262_144);
  if (rawTxHex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(rawTxHex)) throw new TypeError(`Coordinator ${field}.rawTxHex is invalid`);
  return {
    resourceId: text(submission.resourceId, field + ".resourceId", 256),
    txid: txid.toLowerCase(),
    rawTxHex: rawTxHex.toLowerCase(),
  };
}

function parseP2pkhBroadcastResult(value: unknown, field: string): CoordinatorP2pkhBroadcastResult {
  const result = expectRecord(value, field);
  const status = text(result.status, field + ".status", 64);
  const providerId = optionalText(result.providerId, field + ".providerId", 256);
  if (status === "not-dispatched") {
    return { status, reason: enumValue(result.reason, ["stale-provider-generation", "broadcast-provider-unavailable", "coordinator-not-dispatched", "stale-session-epoch"] as const, field + ".reason") };
  }
  if (status === "accepted" || status === "already-known") {
    return {
      status,
      canonicalTxid: text(result.canonicalTxid, field + ".canonicalTxid", 128),
      ...(providerId === undefined ? {} : { providerId }),
      ...(result.providerReference === undefined ? {} : { providerReference: text(result.providerReference, field + ".providerReference", 512) }),
      ...(result.providerCode === undefined ? {} : { providerCode: text(result.providerCode, field + ".providerCode", 256) }),
      ...(result.providerMessage === undefined ? {} : { providerMessage: text(result.providerMessage, field + ".providerMessage", 4_096) }),
    };
  }
  const txid = text(result.txid, field + ".txid", 128);
  // reason 只属于 isolated；local-confirmed 成功响应没有 reason，不能先解析它，
  // 否则合法成功会被误判成“reason is invalid”。
  if (status === "isolated") return { status, txid, reason: text(result.reason, field + ".reason", 4_096), ...(providerId === undefined ? {} : { providerId }) };
  if (status === "local-confirmed") return { status, txid, ...(providerId === undefined ? {} : { providerId }) };
  throw new TypeError(`Coordinator ${field}.status is invalid`);
}

function parseWindowExecutorLease(value: unknown, field: string): WindowP2pExecutorLease {
  const lease = expectRecord(value, field);
  return {
    leaseId: text(lease.leaseId, field + ".leaseId", 256),
    sessionEpoch: text(lease.sessionEpoch, field + ".sessionEpoch", 256),
    activePublicKeyHex: text(lease.activePublicKeyHex, field + ".activePublicKeyHex", 256),
  };
}

function parseWindowExecutorTransferResult(value: unknown, field: string): WindowP2pExecutorTransferResult {
  const result = expectRecord(value, field);
  return {
    bytes: arrayBufferValue(result.bytes, field + ".bytes"),
    acceptedPendingBytes: boundedNumber(result.acceptedPendingBytes, field + ".acceptedPendingBytes"),
    peakPendingBytes: boundedNumber(result.peakPendingBytes, field + ".peakPendingBytes"),
  };
}

function parseWindowIdentitySignResult(value: unknown, field: string): WindowP2pIdentitySignResult {
  const result = expectRecord(value, field);
  return { signatureDer: arrayBufferValue(result.signatureDer, field + ".signatureDer") };
}

function parseUndefinedResult(value: unknown, field: string): undefined {
  if (value !== undefined) throw new TypeError(`Coordinator ${field} must be absent`);
  return undefined;
}

function parseTrueResult(value: unknown, field: string): true {
  if (value !== true) throw new TypeError(`Coordinator ${field} must be true`);
  return true;
}

function parseCoordinatorResponse(value: unknown): CoordinatorRpcResponse {
  return parseCoordinatorResponseBase(value);
}

function parseKeyViewArray(value: unknown, field: string): CoordinatorVaultKeyView[] {
  if (!Array.isArray(value)) throw new TypeError(`Coordinator ${field} must be an array`);
  return value.map((item, index) => parseCoordinatorVaultKeyView(item, `${field}[${index}]`));
}

function parseCoordinatorVaultOperationResultFor(
  operation: CoordinatorVaultOperation,
  value: unknown,
  field: string,
): unknown {
  switch (operation.type) {
    case "createVault":
    case "setActive":
    case "deleteKey":
    case "verifyPassword":
    case "changePassword":
    case "finalizeEmptyVaultAfterLastKeyDeletion":
    case "recoverEmptyVaultToUninitialized":
      return parseTrueResult(value, field);
    case "createVaultWithInitialKey":
    case "createVaultWithImportedKey":
    case "generateKey":
    case "importPrivateKey":
    case "importKeyBackup":
      return parseCoordinatorVaultKeyView(value, field);
    case "listKeys":
      return parseKeyViewArray(value, field);
    case "getKey":
      return value === undefined ? undefined : parseCoordinatorVaultKeyView(value, field);
    case "exportKeyBackup":
    case "exportCurrentKeyBackup":
      return text(value, field, 2_000_000);
    case "sealLocalSecret":
      return parseVaultSealedSecret(value, field);
    case "openLocalSecret":
      return uint8ArrayValue(value, field);
  }
}

function parseStorageRuntimeStatus(value: unknown, field: string): StorageRuntimeControllerStatus | StorageRuntimeStatus {
  return enumValue(value, [
    "unselected", "authentication", "checking", "ready", "degraded", "incompatible",
    "unconfigured", "locked", "reconfiguring",
  ] as const, field);
}

function parseStorageControlResultFor(control: CoordinatorStorageControl, value: unknown, field: string): unknown {
  switch (control.type) {
    case "status":
    case "retry":
      return parseStorageRuntimeStatus(value, field);
    case "summary":
      return value === null ? null : parseStorageProviderSummary(value, field);
    case "connection":
      return value === null ? null : parseStorageProviderConnection(value, field);
    case "initial-setup":
      return parseInitialSetupResult(value, field);
    case "connect-existing-remote":
      return parseExistingRemoteStorageConnectResult(value, field);
    case "probe-bucket":
      return parseBucketProbeResultFor(value, field);
    case "initial-setup-result":
      return value === undefined ? undefined : parseInitialSetupResult(value, field);
    case "initial-setup-recovery-list":
      if (!Array.isArray(value)) throw new TypeError(`Coordinator ${field} must be an array`);
      return value.map((item, index) => parseLocalStorageRecoveryRecord(item, `${field}[${index}]`));
    case "initial-setup-cleanup":
      return parseStorageRecoveryResult(value, field);
    case "switch-bucket":
      return parseStorageBucketSwitchResult(value, field);
    case "change-bucket-config":
    case "rename-bucket":
      return parseRuntimeBucket(value, field);
    case "unlock-bucket":
      return parseStorageUnlockBucketResult(value, field);
    case "delete-local-bucket-key":
      return parseUndefinedResult(value, field);
    case "cold-export":
      return uint8ArrayValue(value, field);
    case "capabilities":
      return value === null ? null : parseStorageCapabilities(value, field);
    case "probe-capabilities":
      return parseStorageCapabilitiesProbeResult(value, field);
    case "cancel-probe":
      return parseUndefinedResult(value, field);
  }
}

function parseStorageDataResultFor(data: CoordinatorStorageData, value: unknown, field: string): unknown {
  switch (data.type) {
    case "list": return parseStorageListResult(value, field);
    case "create-directory":
    case "delete-directory": return parseStorageDirectoryResult(value, field);
    case "put": return parseStoragePutResult(value, field);
    case "get-range": return parseStorageGetResult(value, field);
    case "delete": return parseStorageDeleteResult(value, field);
    case "begin-upload": return parseStorageUploadBeginResult(value, field);
    case "upload-part": return parseStorageUploadPartResult(value, field);
    case "complete-upload": return parseStoragePutResult(value, field);
    case "abort-upload": return parseStorageUploadAbortResult(value, field);
  }
}

function parseMsFileControlResultFor(control: CoordinatorMsFileControl, value: unknown, field: string): unknown {
  switch (control.type) {
    case "settings.get": return parseMsFileSettingsSnapshot(value, field);
    case "settings.readConcurrency.get": return parseMsFileReadConcurrency(value);
    case "settings.mediaBlockReadConcurrency.get": return boundedNumber(value, field, 1, 16);
    case "bucket.get-block": {
      const bytes = arrayBufferValue(value, field);
      if (bytes.byteLength < 1 || bytes.byteLength > MSFILE_MAX_BLOCK_BYTES) throw new TypeError(`Coordinator ${field} is invalid`);
      return bytes;
    }
    case "supplier.probe": return parseMsFileSupplierProbeResult(value, field);
    case "app-authorizations.list": {
      if (!Array.isArray(value)) throw new TypeError(`Coordinator ${field} must be an array`);
      return value.map((item, index) => parseMsFileAppAuthorization(item, `${field}[${index}]`));
    }
    case "approvals.pending": {
      if (!Array.isArray(value)) throw new TypeError(`Coordinator ${field} must be an array`);
      return value.map((item, index) => parseMsFilePendingApproval(item, `${field}[${index}]`));
    }
    case "settings.readConcurrency.update":
    case "settings.readConcurrency.reset":
    case "settings.mediaBlockReadConcurrency.update":
    case "settings.global.update":
    case "supplier.upsert":
    case "supplier.delete":
    case "app-policy.update":
    case "app-policy.clear":
    case "approval.resolve":
    case "bucket.put-block":
      if (value !== null) throw new TypeError(`Coordinator ${field} must be null`);
      return null;
  }
}

function parseSatPublishResult(value: unknown, field: string): CoordinatorSatPublishResult {
  const result = expectRecord(value, field);
  return { requestIdHex: text(result.requestIdHex, field + ".requestIdHex", 256), chargedAmount: text(result.chargedAmount, field + ".chargedAmount", 64) };
}

function parseSatRefreshSubscriptionsResult(value: unknown, field: string): CoordinatorSatRefreshSubscriptionsResult {
  const result = expectRecord(value, field);
  return { channels: stringList(result.channels, field + ".channels", 256, 2_048), chargedAmount: text(result.chargedAmount, field + ".chargedAmount", 64) };
}

function parseSatTopUpResult(value: unknown, field: string): SatTopUpResult {
  const result = expectRecord(value, field);
  const txid = optionalText(result.txid, field + ".txid", 128);
  return { status: text(result.status, field + ".status", 256), ...(txid === undefined ? {} : { txid }) };
}

function parseSatOperationResultFor(operation: CoordinatorSatOperation, value: unknown, field: string): unknown {
  switch (operation.type) {
    case "ensure":
    case "admin.upsertSupplier":
    case "admin.deleteSupplier":
    case "admin.setOwnerSettings":
      if (value !== null) throw new TypeError(`Coordinator ${field} must be null`);
      return null;
    case "admin.getSettings": return parseSatSettingsSnapshot(value, field);
    case "admin.refreshSubscriptions": return parseSatRefreshSubscriptionsResult(value, field);
    case "admin.getBilling": return parseSatBillingPage(value, field);
    case "service.publish": return parseSatPublishResult(value, field);
    case "spi.getInformation": return parseSatSpiInformation(value, field);
    case "spi.prepareTopUp": return parseSatTopUpPreview(value, field);
    case "spi.submitTopUp": return parseSatTopUpResult(value, field);
    case "spi.collectNew":
    case "spi.retryCollect":
    case "spi.collect": return parseSatCollectResult(value, field);
  }
}

function parseChannelPublishResult(value: unknown, field: string): ChannelPublishResult {
  const result = expectRecord(value, field);
  return {
    messageId: text(result.messageId, field + ".messageId", 256),
    ...(result.signedMessage === undefined ? {} : { signedMessage: uint8ArrayValue(result.signedMessage, field + ".signedMessage") }),
  };
}

function parseOpenedPrivateEnvelopeResult(value: unknown, field: string): import("./channel.js").OpenedPrivateEnvelope {
  const result = expectRecord(value, field);
  const protocol = text(result.protocol, field + ".protocol", 256);
  const body = result.content;
  return {
    channel: text(result.channel, field + ".channel", 512),
    protocol,
    messageId: text(result.messageId, field + ".messageId", 256),
    publisherPublicKeyHex: text(result.publisherPublicKeyHex, field + ".publisherPublicKeyHex", 66),
    issuedAtMs: boundedNumber(result.issuedAtMs, field + ".issuedAtMs"),
    expiresAtMs: boundedNumber(result.expiresAtMs, field + ".expiresAtMs"),
    content: parseJsonValue(body, field + ".content"),
  };
}

function parseChannelSubscriptionSetResult(value: unknown, field: string): ChannelSubscriptionSetResult {
  const result = expectRecord(value, field);
  const channels = stringList(result.channels, field + ".channels", 256, 2_048);
  if (result.statuses === undefined) return { channels };
  if (!Array.isArray(result.statuses) || result.statuses.length > 2_048) {
    throw new TypeError(`Coordinator ${field}.statuses is invalid`);
  }
  return {
    channels,
    statuses: result.statuses.map((status, index) =>
      parseChannelSubscriptionStatus(status, `${field}.statuses[${index}]`)
    ),
  };
}

function parseChannelOperationResultFor(operation: CoordinatorChannelOperation, value: unknown, field: string): unknown {
  switch (operation.type) {
    case "publish":
    case "hash-request-publish":
    case "private-publish": return parseChannelPublishResult(value, field);
    case "open-private-envelope": return parseOpenedPrivateEnvelopeResult(value, field);
    case "subscription-set": return parseChannelSubscriptionSetResult(value, field);
    case "release":
      if (value !== null) throw new TypeError(`Coordinator ${field} must be null`);
      return null;
  }
}

function parseOwnerFileEntry(value: unknown, field: string): { path: string; size?: number; etag?: string; lastModified?: string } {
  const entry = expectRecord(value, field);
  return {
    path: text(entry.path, field + ".path", 4_096),
    ...(entry.size === undefined ? {} : { size: boundedNumber(entry.size, field + ".size") }),
    ...(entry.etag === undefined ? {} : { etag: text(entry.etag, field + ".etag", 1_024) }),
    ...(entry.lastModified === undefined ? {} : { lastModified: text(entry.lastModified, field + ".lastModified", 1_024) }),
  };
}

function parseOwnerFileListPage(value: unknown, field: string): import("./storage/files.js").OwnerFileListPage {
  const page = expectRecord(value, field);
  if (!Array.isArray(page.files)) throw new TypeError(`Coordinator ${field}.files is invalid`);
  return {
    files: page.files.map((entry, index) => parseOwnerFileEntry(entry, `${field}.files[${index}]`)),
    ...(page.nextCursor === undefined ? {} : { nextCursor: text(page.nextCursor, field + ".nextCursor", 8_192) }),
  };
}

function parseOwnerFileObject(value: unknown, field: string): import("./storage/files.js").OwnerFileObject {
  const object = expectRecord(value, field);
  if (!(object.bytes instanceof Uint8Array)) throw new TypeError(`Coordinator ${field}.bytes is invalid`);
  return {
    path: text(object.path, field + ".path", 4_096),
    bytes: object.bytes.slice(),
    ...(object.etag === undefined ? {} : { etag: text(object.etag, field + ".etag", 1_024) }),
    ...(object.lastModified === undefined ? {} : { lastModified: text(object.lastModified, field + ".lastModified", 1_024) }),
  };
}

function parseOwnerFileWriteResult(value: unknown, field: string): { etag?: string; lastModified?: string } {
  const result = value === undefined ? {} : expectRecord(value, field);
  return {
    ...(result.etag === undefined ? {} : { etag: text(result.etag, field + ".etag", 1_024) }),
    ...(result.lastModified === undefined ? {} : { lastModified: text(result.lastModified, field + ".lastModified", 1_024) }),
  };
}

function parseOwnerStorageResultFor(data: CoordinatorOwnerStorageData | CoordinatorPlatformStorageData, value: unknown, field: string): unknown {
  switch (data.type) {
    case "owner.get":
    case "platform.get": return value === undefined ? undefined : parseKeyValueEntry(value, field);
    case "owner.list":
    case "platform.list": return parseKeyValueList(value, field);
    case "owner.put":
    case "platform.put": return parseKeyValueMeta(value, field);
    case "owner.delete":
    case "platform.delete": return parseUndefinedResult(value, field);
    case "owner.commit":
    case "platform.commit": return parseKeyValueCommit(value, field);
    case "owner.file-list": return parseOwnerFileListPage(value, field);
    case "owner.file-get": return value === undefined ? undefined : parseOwnerFileObject(value, field);
    case "owner.file-put": return parseOwnerFileWriteResult(value, field);
    case "owner.file-delete": return parseUndefinedResult(value, field);
  }
}

function parseCryptoResultFor(operation: CoordinatorCryptoOperation, value: unknown, field: string): CoordinatorCryptoResult {
  const result = parseCryptoResult(value);
  if (operation.type === "signDigest") {
    if (result.type !== "signDigest" || result.format !== operation.format) throw new TypeError(`Coordinator ${field} does not match signDigest operation`);
  } else if (result.type !== "deriveP2pkhAddress") {
    throw new TypeError(`Coordinator ${field} does not match deriveP2pkhAddress operation`);
  }
  return result;
}

function parseCoordinatorResultForRequest(request: CoordinatorRpcRequest, value: unknown, field: string): unknown {
  switch (request.kind) {
    case "session.open": return parseCoordinatorSessionOpenResult(value, field);
    case "vault.operation": return parseCoordinatorVaultOperationResultFor(request.operation, value, field);
    case "storage.control": return parseStorageControlResultFor(request.control, value, field);
    case "storage.data": return parseStorageDataResultFor(request.data, value, field);
    case "storage.owner.data": return parseOwnerStorageResultFor(request.data, value, field);
    case "storage.platform.data": return parseOwnerStorageResultFor(request.data, value, field);
    case "storage.grant":
    case "msfile.grant": return text(value, field, 256);
    case "storage.owner.bind": return parseStorageOwnerGrant(value, field);
    case "storage.platform.bind": return parseStoragePlatformGrant(value, field);
    case "storage.owner.delete": return parseTrueResult(value, field);
    case "msfile.control": return parseMsFileControlResultFor(request.control, value, field);
    case "msfile.data": return request.data.type === "stat" ? parseMsFileStatResult(value, field) : parseMsFileReadResult(value, field);
    case "window-p2p.executor.acquire": return parseWindowExecutorLease(value, field);
    case "window-p2p.executor.spike.transfer": return parseWindowExecutorTransferResult(value, field);
    case "window-p2p.executor.identity.sign-noise":
    case "window-p2p.executor.identity.sign-peer-record": return parseWindowIdentitySignResult(value, field);
    case "sat.operation": return parseSatOperationResultFor(request.operation, value, field);
    case "channel.operation": return parseChannelOperationResultFor(request.operation, value, field);
    case "contacts.presence.snapshot": return parsePresenceMap(value, field);
    case "plugin.intent.snapshot": return parsePluginIntentSnapshot(value, field);
    case "plugin.intent.submit": return parsePluginIntentSubmissionResult(value, field);
    case "p2pkh.utxos.get":
    case "p2pkh.utxos.refresh": return parseP2pkhUtxoSnapshotResult(value, field);
    case "p2pkh.provider-config.get": return parseP2pkhProviderConfigResult(value, field);
    case "p2pkh.broadcast": return parseP2pkhBroadcastResult(value, field);
    default: return parseUndefinedResult(value, field);
  }
}

type CoordinatorRpcResponseResultParser = (request: CoordinatorRpcRequest, value: unknown, field: string) => unknown;

/** Request-aware parser map; nested discriminants are selected from request. */
export type CoordinatorRpcResponseResultParserMap = {
  [K in CoordinatorRpcRequestKind]: CoordinatorRpcResponseResultParser;
};

export const COORDINATOR_RESPONSE_RESULT_PARSERS: CoordinatorRpcResponseResultParserMap = Object.freeze(
  Object.fromEntries([...COORDINATOR_REQUEST_KINDS].map((kind) => [kind, parseCoordinatorResultForRequest])) as CoordinatorRpcResponseResultParserMap,
);

function isVoidCoordinatorRequest(request: CoordinatorRpcRequest): boolean {
  switch (request.kind) {
    case "session.close":
    case "session.activity":
    case "unlock":
    case "lock":
    case "activate-key":
    case "crypto":
    case "background.run-now":
    case "background.trigger":
    case "background.cancel":
    case "background.cancel-by-key":
    case "background.settings.update":
    case "storage.cancel":
    case "storage.session.abort":
    case "msfile.cancel":
    case "msfile.session.abort":
    case "window-p2p.executor.release":
    case "channel.cancel":
    case "p2pkh.settings.update":
    case "p2pkh.provider-config.update":
      return true;
    case "storage.owner.data":
    case "storage.platform.data":
      return request.data.type === "owner.delete" || request.data.type === "platform.delete";
    case "storage.control":
      // cancel-probe 与 delete-local-bucket-key 的业务结果就是 undefined；
      // 响应里不携带 operationResult，必须按 void 请求解析。
      return request.control.type === "cancel-probe" || request.control.type === "delete-local-bucket-key";
    default: return false;
  }
}

/** Parse and validate a response against the complete request that caused it. */
export function parseCoordinatorResponseFor<R extends CoordinatorRpcRequest>(
  request: R,
  value: unknown,
): CoordinatorRpcResponseForRequest<R> {
  const response = parseCoordinatorResponseBase(value);
  const responseRecord = response as unknown as RecordValue;
  const hasOperationResult = hasOwn(responseRecord, "operationResult");
  const hasCryptoResult = hasOwn(responseRecord, "cryptoResult");

  if (request.kind === "crypto") {
    if (hasOperationResult) throw new TypeError("Coordinator crypto response contains operationResult");
    if (response.ack.status === "ok") {
      if (!hasCryptoResult) throw new TypeError("Coordinator crypto response is missing cryptoResult");
      const cryptoResult = parseCryptoResultFor(request.operation, response.cryptoResult, "response.cryptoResult");
      return { ...response, cryptoResult } as CoordinatorRpcResponseForRequest<R>;
    }
    if (hasCryptoResult) throw new TypeError("Coordinator crypto failure contains cryptoResult");
    return response as CoordinatorRpcResponseForRequest<R>;
  }
  if (hasCryptoResult) throw new TypeError(`Coordinator ${request.kind} response contains cryptoResult`);

  if (response.ack.status === "ok") {
    if (isVoidCoordinatorRequest(request)) {
      if (hasOperationResult) throw new TypeError(`Coordinator ${request.kind} void response contains operationResult`);
    } else if (!hasOperationResult) {
      throw new TypeError(`Coordinator ${request.kind} response is missing operationResult`);
    }
  } else if (hasOperationResult) {
    throw new TypeError(`Coordinator ${request.kind} failure contains operationResult`);
  }

  if (!hasOperationResult) return response as CoordinatorRpcResponseForRequest<R>;
  const operationResult = COORDINATOR_RESPONSE_RESULT_PARSERS[request.kind](request, response.operationResult, "response.operationResult");
  return { ...response, operationResult } as CoordinatorRpcResponseForRequest<R>;
}

function enumValue<const Values extends readonly string[]>(value: unknown, values: Values, field: string): Values[number] {
  const parsed = text(value, field, 128);
  if (!(values as readonly string[]).includes(parsed)) throw new TypeError(`Coordinator ${field} is invalid`);
  return parsed as Values[number];
}

function nullableText(value: unknown, field: string, maximum = 4_096): string | null {
  return value === null ? null : text(value, field, maximum);
}

function finiteNumber(value: unknown, field: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`Coordinator ${field} is invalid`);
  }
  return value;
}

function topicEnvelope(value: unknown, topic: CoordinatorTopic, type: string): RecordValue {
  const event = expectRecord(value, "Coordinator topic event");
  if (event.topic !== topic || event.type !== type) {
    throw new TypeError(`Coordinator ${topic} event discriminator is invalid`);
  }
  return event;
}

function parseCoordinatorTopic(value: unknown, field: string): CoordinatorTopic {
  const topic = text(value, field, 128);
  switch (topic) {
    case "session.state": case "background.snapshot": case "asset.data-changed":
    case "storage.state": case "msfile.state":
    case "sat.events": case "channel.events": case "contacts.presence":
    case "plugin.intent": case "worker.units":
      return topic;
    default:
      throw new TypeError(`Coordinator ${field} is not supported`);
  }
}

function parseAuthorityRecovery(value: unknown, field: string): CoordinatorAuthorityRecovery {
  const recovery = expectRecord(value, field);
  if (recovery.status !== "recovery-required" || recovery.reason !== "active-final-io-leases") {
    throw new TypeError(`Coordinator ${field} is invalid`);
  }
  const activeIoOperations = expectRecord(recovery.activeIoOperations, field + ".activeIoOperations");
  const activeIoLeaseCount = boundedNumber(recovery.activeIoLeaseCount, field + ".activeIoLeaseCount");
  const read = boundedNumber(activeIoOperations.read, field + ".activeIoOperations.read");
  const write = boundedNumber(activeIoOperations.write, field + ".activeIoOperations.write");
  if (read > activeIoLeaseCount || write > activeIoLeaseCount || read !== activeIoLeaseCount - write) {
    throw new TypeError(`Coordinator ${field}.activeIoOperations is inconsistent`);
  }
  return {
    status: "recovery-required",
    reason: "active-final-io-leases",
    authorityBuildId: text(recovery.authorityBuildId, field + ".authorityBuildId", 256),
    activeIoLeaseCount,
    activeIoOperations: { read, write },
    handoverGeneration: boundedNumber(recovery.handoverGeneration, field + ".handoverGeneration"),
  };
}

function parseSessionStateEvent(value: unknown): SessionStateEvent {
  const event = topicEnvelope(value, "session.state", "session.state.changed");
  const authorityRecovery = event.authorityRecovery === undefined ? undefined : parseAuthorityRecovery(event.authorityRecovery, "event.authorityRecovery");
  const selectedPublicKeyHex = event.selectedPublicKeyHex === undefined ? undefined : nullableText(event.selectedPublicKeyHex, "event.selectedPublicKeyHex", 256);
  return {
    topic: "session.state",
    type: "session.state.changed",
    sessionRevision: boundedNumber(event.sessionRevision, "event.sessionRevision"),
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    cause: enumValue(event.cause, ["bootstrap", "unlock", "lock", "activate-key", "create-vault", "create-initial-key", "import-initial-key", "delete-active-key", "recover-empty-vault"] as const, "event.cause"),
    vaultStatus: enumValue(event.vaultStatus, ["booting", "uninitialized", "locked", "unlocked", "fatal"] as const, "event.vaultStatus"),
    activePublicKeyHex: nullableText(event.activePublicKeyHex, "event.activePublicKeyHex", 256),
    ...(selectedPublicKeyHex === undefined ? {} : { selectedPublicKeyHex }),
    keyspaceGeneration: boundedNumber(event.keyspaceGeneration, "event.keyspaceGeneration"),
    ...(authorityRecovery === undefined ? {} : { authorityRecovery }),
  };
}

function parseBackgroundProgress(value: unknown, field: string): NonNullable<CoordinatorTaskSnapshot["progress"]> {
  const progress = expectRecord(value, field);
  const ratio = progress.ratio === undefined ? undefined : finiteNumber(progress.ratio, field + ".ratio", 0, 1);
  const count = progress.count === undefined ? undefined : boundedNumber(progress.count, field + ".count");
  const label = progress.label === undefined ? undefined : parseI18nText(progress.label, field + ".label");
  return {
    ...(ratio === undefined ? {} : { ratio }),
    ...(count === undefined ? {} : { count }),
    ...(label === undefined ? {} : { label }),
  };
}

function parseTaskSnapshot(value: unknown, field: string): CoordinatorTaskSnapshot {
  const snapshot = expectRecord(value, field);
  const unitId = optionalText(snapshot.unitId, field + ".unitId", 256);
  const instanceId = optionalText(snapshot.instanceId, field + ".instanceId", 256);
  const progress = snapshot.progress === undefined ? undefined : parseBackgroundProgress(snapshot.progress, field + ".progress");
  const lastStartedAt = optionalText(snapshot.lastStartedAt, field + ".lastStartedAt", 128);
  const lastCompletedAt = optionalText(snapshot.lastCompletedAt, field + ".lastCompletedAt", 128);
  const lastAttemptAt = optionalText(snapshot.lastAttemptAt, field + ".lastAttemptAt", 128);
  const nextRunAt = optionalText(snapshot.nextRunAt, field + ".nextRunAt", 128);
  const error = optionalText(snapshot.error, field + ".error", 4_096);
  const blockedReason = snapshot.blockedReason === undefined ? undefined : parseI18nText(snapshot.blockedReason, field + ".blockedReason");
  let keyScope: CoordinatorTaskSnapshot["keyScope"];
  if (snapshot.keyScope !== undefined) {
    const scope = expectRecord(snapshot.keyScope, field + ".keyScope");
    const label = optionalText(scope.label, field + ".keyScope.label", 256);
    keyScope = { publicKeyHex: text(scope.publicKeyHex, field + ".keyScope.publicKeyHex", 256), ...(label === undefined ? {} : { label }) };
  }
  return {
    id: text(snapshot.id, field + ".id", 256),
    pluginId: text(snapshot.pluginId, field + ".pluginId", 256),
    ...(unitId === undefined ? {} : { unitId }),
    ...(instanceId === undefined ? {} : { instanceId }),
    label: text(snapshot.label, field + ".label", 4_096),
    state: enumValue(snapshot.state, ["idle", "queued", "running", "blocked"] as const, field + ".state"),
    ...(progress === undefined ? {} : { progress }),
    ...(lastStartedAt === undefined ? {} : { lastStartedAt }),
    ...(lastCompletedAt === undefined ? {} : { lastCompletedAt }),
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    ...(error === undefined ? {} : { error }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(keyScope === undefined ? {} : { keyScope }),
  };
}

function parseBackgroundSnapshotEvent(value: unknown): BackgroundSnapshotEvent {
  const event = topicEnvelope(value, "background.snapshot", "background.snapshot.changed");
  if (!Array.isArray(event.snapshots) || event.snapshots.length > 4_096) throw new TypeError("Coordinator background snapshots are invalid");
  const scheduleSettings = event.scheduleSettings === undefined ? undefined : parseBackgroundSettings(event.scheduleSettings);
  return {
    topic: "background.snapshot",
    type: "background.snapshot.changed",
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    backgroundSnapshotRevision: boundedNumber(event.backgroundSnapshotRevision, "event.backgroundSnapshotRevision"),
    snapshots: event.snapshots.map((snapshot, index) => parseTaskSnapshot(snapshot, `event.snapshots[${index}]`)),
    ...(scheduleSettings === undefined ? {} : { scheduleSettings }),
  };
}

function parseAssetKinds(value: unknown, field: string): AssetDataChangedEvent["kinds"] {
  if (!Array.isArray(value) || value.length > 16) throw new TypeError(`Coordinator ${field} is invalid`);
  return value.map((kind, index) => enumValue(kind, ["resource", "utxo", "history", "holding", "claim", "submission", "settings", "protocol-snapshot"] as const, `${field}[${index}]`));
}

function parseAssetDataChangedEvent(value: unknown): AssetDataChangedEvent {
  const event = topicEnvelope(value, "asset.data-changed", "asset.data-changed");
  return {
    topic: "asset.data-changed",
    type: "asset.data-changed",
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    providerId: text(event.providerId, "event.providerId", 256),
    publicKeyHex: text(event.publicKeyHex, "event.publicKeyHex", 256),
    assetDataRevision: boundedNumber(event.assetDataRevision, "event.assetDataRevision"),
    kinds: parseAssetKinds(event.kinds, "event.kinds"),
  };
}

function parseStorageProviderSummary(value: unknown, field: string): StorageProviderSummary {
  const summary = expectRecord(value, field);
  const providerId = enumValue(summary.providerId, ["cloudflare-r2", "aws-s3", "s3-compatible"] as const, field + ".providerId");
  if (summary.secretConfigured !== true) throw new TypeError(`Coordinator ${field}.secretConfigured is invalid`);
  return {
    providerId: providerId as StorageProviderId,
    bucketHint: text(summary.bucketHint, field + ".bucketHint", 512),
    ...(summary.endpointHint === undefined ? {} : { endpointHint: text(summary.endpointHint, field + ".endpointHint", 2_048) }),
    accessKeyHint: text(summary.accessKeyHint, field + ".accessKeyHint", 512),
    secretConfigured: true,
    generation: boundedNumber(summary.generation, field + ".generation"),
    updatedAt: boundedNumber(summary.updatedAt, field + ".updatedAt"),
  };
}

function parseStorageConditionalCapability(value: unknown, field: string): NonNullable<BucketConditionalCapabilitiesView["put"]> {
  const capability = expectRecord(value, field);
  const source = capability.source === undefined ? undefined : enumValue(capability.source, ["automatic", "manual"] as const, field + ".source");
  const updatedAt = capability.updatedAt === undefined ? undefined : boundedNumber(capability.updatedAt, field + ".updatedAt");
  return {
    mode: enumValue(capability.mode, ["unknown", "native", "best-effort"] as const, field + ".mode"),
    ...(source === undefined ? {} : { source }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

function parseStorageCapabilities(value: unknown, field: string): BucketConditionalCapabilitiesView {
  const capabilities = expectRecord(value, field);
  return {
    generation: boundedNumber(capabilities.generation, field + ".generation"),
    put: parseStorageConditionalCapability(capabilities.put, field + ".put"),
    complete: parseStorageConditionalCapability(capabilities.complete, field + ".complete"),
  };
}

function parseStorageCapabilitiesProbeResult(value: unknown, field: string): BucketConditionalCapabilityProbeResult {
  const result = expectRecord(value, field);
  return {
    generation: boundedNumber(result.generation, field + ".generation"),
    put: enumValue(result.put, ["native", "best-effort", "inconclusive"] as const, field + ".put"),
    complete: enumValue(result.complete, ["native", "best-effort", "inconclusive"] as const, field + ".complete"),
    cleanupWarning: booleanValue(result.cleanupWarning, field + ".cleanupWarning"),
  };
}

function parseStorageStateEvent(value: unknown): CoordinatorStorageStateEvent {
  const event = topicEnvelope(value, "storage.state", "storage.state.changed");
  const healthStatus = event.healthStatus === undefined ? undefined : enumValue(event.healthStatus, ["unselected", "authentication", "checking", "ready", "degraded", "incompatible"] as const, "event.healthStatus");
  const catalogBucket = event.catalogBucket === undefined ? undefined : booleanValue(event.catalogBucket, "event.catalogBucket");
  const bucketId = event.bucketId === undefined ? undefined : text(event.bucketId, "event.bucketId", 256);
  const bucketGeneration = event.bucketGeneration === undefined ? undefined : boundedNumber(event.bucketGeneration, "event.bucketGeneration");
  const authorityRecovery = event.authorityRecovery === undefined ? undefined : parseAuthorityRecovery(event.authorityRecovery, "event.authorityRecovery");
  const summary = event.summary === null ? null : parseStorageProviderSummary(event.summary, "event.summary");
  const capabilities = event.capabilities === null ? null : parseStorageCapabilities(event.capabilities, "event.capabilities");
  return {
    topic: "storage.state",
    type: "storage.state.changed",
    storageRevision: boundedNumber(event.storageRevision, "event.storageRevision"),
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    providerGeneration: nullableBoundedNumber(event.providerGeneration, "event.providerGeneration"),
    status: enumValue(event.status, ["unconfigured", "locked", "checking", "ready", "reconfiguring", "degraded"] as const, "event.status"),
    ...(healthStatus === undefined ? {} : { healthStatus: healthStatus as StorageRuntimeStatus }),
    ...(catalogBucket === undefined ? {} : { catalogBucket }),
    ...(bucketId === undefined ? {} : { bucketId }),
    ...(bucketGeneration === undefined ? {} : { bucketGeneration }),
    ...(authorityRecovery === undefined ? {} : { authorityRecovery }),
    summary,
    capabilities,
  };
}

function parseP2pkhUtxoSnapshotResult(value: unknown, field: string): P2pkhUtxoSnapshotResult {
  const snapshot = expectRecord(value, field);
  if (typeof snapshot.available !== "boolean") throw new TypeError(`Coordinator ${field}.available is invalid`);
  if (snapshot.items !== undefined && (!Array.isArray(snapshot.items) || snapshot.items.length > 100_000)) throw new TypeError(`Coordinator ${field}.items is invalid`);
  if (snapshot.syncedAt !== undefined && typeof snapshot.syncedAt !== "string") throw new TypeError(`Coordinator ${field}.syncedAt is invalid`);
  const items = (snapshot.items ?? []).map((item, index) => {
    const recordValue = expectRecord(item, `${field}.items[${index}]`);
    const txid = text(recordValue.txid, `${field}.items[${index}].txid`, 64);
    if (!/^[0-9a-f]{64}$/u.test(txid)) throw new TypeError(`Coordinator ${field}.items[${index}].txid is invalid`);
    const vout = boundedNumber(recordValue.vout, `${field}.items[${index}].vout`);
    const valueSatoshis = boundedNumber(recordValue.value, `${field}.items[${index}].value`);
    const height = boundedNumber(recordValue.height, `${field}.items[${index}].height`);
    if (typeof recordValue.isSpentInMempoolTx !== "boolean") throw new TypeError(`Coordinator ${field}.items[${index}].isSpentInMempoolTx is invalid`);
    return {
      txid,
      vout,
      value: valueSatoshis,
      height,
      status: enumValue(recordValue.status, ["confirmed", "unconfirmed"] as const, `${field}.items[${index}].status`),
      isSpentInMempoolTx: recordValue.isSpentInMempoolTx,
      ...(recordValue.script === undefined ? {} : { script: text(recordValue.script, `${field}.items[${index}].script`, 100_000) }),
    };
  });
  return {
    available: snapshot.available,
    ...(snapshot.syncedAt === undefined ? {} : { syncedAt: snapshot.syncedAt as string }),
    items,
  };
}

function parseMsFilePendingApproval(value: unknown, field: string): CoordinatorMsFileStateEvent["pendingApprovals"][number] {
  const approval = expectRecord(value, field);
  return {
    approvalId: text(approval.approvalId, field + ".approvalId", 256),
    createdAt: boundedNumber(approval.createdAt, field + ".createdAt"),
    appName: text(approval.appName, field + ".appName", 256),
    appId: text(approval.appId, field + ".appId", 256),
    publisherHint: text(approval.publisherHint, field + ".publisherHint", 256),
    supplierHint: text(approval.supplierHint, field + ".supplierHint", 256),
    contentHashHint: text(approval.contentHashHint, field + ".contentHashHint", 256),
    kind: enumValue(approval.kind, ["seed", "block"] as const, field + ".kind"),
    effectiveMaxPriceSatoshis: parseMsFileSatoshiAmount(approval.effectiveMaxPriceSatoshis, field + ".effectiveMaxPriceSatoshis"),
  };
}

function parseMsFileStateEvent(value: unknown): CoordinatorMsFileStateEvent {
  const event = topicEnvelope(value, "msfile.state", "msfile.state.changed");
  if (!Array.isArray(event.pendingApprovals) || event.pendingApprovals.length > 256) throw new TypeError("Coordinator MSFile pending approvals are invalid");
  const globalSettings = event.globalSettings === null ? null : parseMsFileGlobalPriceSettings(event.globalSettings);
  const concurrency = parseMsFileReadConcurrency(event);
  return {
    topic: "msfile.state",
    type: "msfile.state.changed",
    msfileRevision: boundedNumber(event.msfileRevision, "event.msfileRevision"),
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    status: enumValue(event.status, ["unconfigured", "ready", "unavailable"] as const, "event.status"),
    supplierGeneration: boundedNumber(event.supplierGeneration, "event.supplierGeneration"),
    globalSettings,
    ...concurrency,
    pendingApprovals: event.pendingApprovals.map((approval, index) => parseMsFilePendingApproval(approval, `event.pendingApprovals[${index}]`)),
  };
}

function parseSatIncomingPublish(value: unknown, field: string): SatIncomingPublish {
  const event = expectRecord(value, field);
  return {
    deliveryId: text(event.deliveryId, field + ".deliveryId", 256),
    ingressSupplierId: text(event.ingressSupplierId, field + ".ingressSupplierId", 256),
    channel: text(event.channel, field + ".channel", 2_048),
    requestIdHex: text(event.requestIdHex, field + ".requestIdHex", 256),
    contentJson: uint8ArrayValue(event.contentJson, field + ".contentJson"),
    chargedAmount: text(event.chargedAmount, field + ".chargedAmount", 64),
    receivedAtMs: boundedNumber(event.receivedAtMs, field + ".receivedAtMs"),
  };
}

function parseSatEvent(value: unknown, field: string): CoordinatorSatEvent {
  const event = expectRecord(value, field);
  if (event.type === "noop") return { type: "noop" };
  if (event.type === "incoming") return { type: "incoming", event: parseSatIncomingPublish(event.event, field + ".event") };
  throw new TypeError(`Coordinator ${field}.type is invalid`);
}

function parseSatStateEvent(value: unknown): CoordinatorSatStateEvent {
  const event = topicEnvelope(value, "sat.events", "sat.events.changed");
  return {
    topic: "sat.events",
    type: "sat.events.changed",
    satRevision: boundedNumber(event.satRevision, "event.satRevision"),
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    event: parseSatEvent(event.event, "event.event"),
  };
}

function parseChannelMessage(value: unknown, field: string): { channel: string; publisherPublicKeyHex: string; messageId: string; content: JSONValue } {
  const message = expectRecord(value, field);
  return {
    channel: text(message.channel, field + ".channel", 2_048),
    publisherPublicKeyHex: text(message.publisherPublicKeyHex, field + ".publisherPublicKeyHex", 256),
    messageId: text(message.messageId, field + ".messageId", 256),
    content: parseJsonValue(message.content, field + ".content"),
  };
}

function parsePrivateChannelMessage(value: unknown, field: string): { channel: string; publisherPublicKeyHex: string; messageId: string; protocol: string; content: JSONValue; rawEnvelope?: Uint8Array } {
  const message = expectRecord(value, field);
  return {
    ...parseChannelMessage(message, field),
    protocol: text(message.protocol, field + ".protocol", 256),
    ...(message.rawEnvelope === undefined ? {} : { rawEnvelope: uint8ArrayValue(message.rawEnvelope, field + ".rawEnvelope") }),
  };
}

function parseChannelSubscriptionStatus(value: unknown, field: string): ChannelSubscriptionStatus {
  const status = expectRecord(value, field);
  const errorCode = status.errorCode === null
    ? null
    : enumValue(status.errorCode, ["config", "connect", "identity", "protocol", "balance", "unknown_result", "validation", "unavailable", "conflict"] as const, `${field}.errorCode`);
  return {
    channel: text(status.channel, `${field}.channel`, 256),
    phase: enumValue(status.phase, ["idle", "subscribing", "subscribed", "retrying", "blocked"] as const, `${field}.phase`),
    errorCode,
    errorMessage: status.errorMessage === null ? null : text(status.errorMessage, `${field}.errorMessage`, 512),
    updatedAtMs: boundedNumber(status.updatedAtMs, `${field}.updatedAtMs`),
  };
}

function parseChannelSubscriptionStatuses(value: unknown, field: string): ChannelSubscriptionStatus[] {
  if (!Array.isArray(value) || value.length > 2_048) {
    throw new TypeError(`Coordinator ${field} is invalid`);
  }
  return value.map((status, index) => parseChannelSubscriptionStatus(status, `${field}[${index}]`));
}

function parseChannelStateEvent(value: unknown): CoordinatorChannelStateEvent {
  const recordValue = expectRecord(value, "Coordinator channel event");
  if (recordValue.topic !== "channel.events") throw new TypeError("Coordinator channel event topic is invalid");
  if (recordValue.type === "channel.subscription.changed") {
    const subscriptionStatus = recordValue.subscriptionStatus === undefined
      ? undefined
      : parseChannelSubscriptionStatus(recordValue.subscriptionStatus, "event.subscriptionStatus");
    const subscriptionStatuses = recordValue.subscriptionStatuses === undefined
      ? undefined
      : parseChannelSubscriptionStatuses(recordValue.subscriptionStatuses, "event.subscriptionStatuses");
    if (subscriptionStatus === undefined && subscriptionStatuses === undefined) {
      throw new TypeError("Coordinator channel event has no subscription status");
    }
    return {
      topic: "channel.events",
      type: "channel.subscription.changed",
      channelRevision: boundedNumber(recordValue.channelRevision, "event.channelRevision"),
      sessionEpoch: text(recordValue.sessionEpoch, "event.sessionEpoch", 256),
      ...(subscriptionStatus === undefined ? {} : { subscriptionStatus }),
      ...(subscriptionStatuses === undefined ? {} : { subscriptionStatuses }),
    };
  }
  const event = topicEnvelope(value, "channel.events", "channel.message.received");
  const publicMessage = event.publicMessage === undefined ? undefined : parseChannelMessage(event.publicMessage, "event.publicMessage");
  const privateMessage = event.privateMessage === undefined ? undefined : parsePrivateChannelMessage(event.privateMessage, "event.privateMessage");
  return {
    topic: "channel.events",
    type: "channel.message.received",
    channelRevision: boundedNumber(event.channelRevision, "event.channelRevision"),
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    ...(publicMessage === undefined ? {} : { publicMessage }),
    ...(privateMessage === undefined ? {} : { privateMessage }),
  };
}

function parsePresenceMap(value: unknown, field: string): ContactPresenceMap {
  const presence = expectRecord(value, field);
  const result: Record<string, { publicKeyHex: string; state: "online" | "offline"; lastPongAtMs?: number }> = {};
  const entries = Object.entries(presence);
  if (entries.length > 4_096) throw new TypeError(`Coordinator ${field} is too large`);
  for (const [key, value] of entries) {
    const item = expectRecord(value, `${field}.${key}`);
    const lastPongAtMs = item.lastPongAtMs === undefined ? undefined : boundedNumber(item.lastPongAtMs, `${field}.${key}.lastPongAtMs`);
    const publicKeyHex = text(item.publicKeyHex, `${field}.${key}.publicKeyHex`, 256);
    result[key] = {
      publicKeyHex,
      state: enumValue(item.state, ["online", "offline"] as const, `${field}.${key}.state`),
      ...(lastPongAtMs === undefined ? {} : { lastPongAtMs }),
    };
  }
  return result;
}

function parseContactsPresenceEvent(value: unknown): CoordinatorContactsPresenceEvent {
  const event = topicEnvelope(value, "contacts.presence", "contacts.presence.changed");
  return {
    topic: "contacts.presence",
    type: "contacts.presence.changed",
    presenceRevision: boundedNumber(event.presenceRevision, "event.presenceRevision"),
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    activePublicKeyHex: nullableText(event.activePublicKeyHex, "event.activePublicKeyHex", 256),
    presence: parsePresenceMap(event.presence, "event.presence"),
  };
}

function parseBooleanRecord(value: unknown, field: string): Readonly<Record<string, boolean>> {
  const input = expectRecord(value, field);
  const output: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(input)) output[text(key, field + ".key", 256)] = booleanValue(item, field + "." + key);
  return output;
}

function parseNumberRecord(value: unknown, field: string): Readonly<Record<string, number>> {
  const input = expectRecord(value, field);
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(input)) output[text(key, field + ".key", 256)] = boundedNumber(item, field + "." + key);
  return output;
}

function parsePluginIntentSnapshot(value: unknown, field: string): PluginIntentSnapshot {
  const snapshot = expectRecord(value, field);
  return {
    revision: boundedNumber(snapshot.revision, field + ".revision"),
    desiredEnabled: parseBooleanRecord(snapshot.desiredEnabled, field + ".desiredEnabled"),
    desiredRevision: parseNumberRecord(snapshot.desiredRevision, field + ".desiredRevision"),
  };
}

function parsePluginIntentStateEvent(value: unknown): PluginIntentStateEvent {
  const event = topicEnvelope(value, "plugin.intent", "plugin.intent.changed");
  return {
    topic: "plugin.intent",
    type: "plugin.intent.changed",
    authorityInstanceId: text(event.authorityInstanceId, "event.authorityInstanceId", 256),
    pluginIntentRevision: boundedNumber(event.pluginIntentRevision, "event.pluginIntentRevision"),
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    snapshot: parsePluginIntentSnapshot(event.snapshot, "event.snapshot"),
  };
}

function parseWorkerUnitSnapshot(value: unknown, field: string): CoordinatorWorkerUnitSnapshot {
  const unit = expectRecord(value, field);
  const ownerPublicKeyHex = optionalText(unit.ownerPublicKeyHex, field + ".ownerPublicKeyHex", 256);
  const sessionEpoch = optionalText(unit.sessionEpoch, field + ".sessionEpoch", 256);
  const error = optionalText(unit.error, field + ".error", 4_096);
  if (unit.runtime !== "shared-worker") throw new TypeError(`Coordinator ${field}.runtime is invalid`);
  return {
    productId: text(unit.productId, field + ".productId", 256),
    unitId: text(unit.unitId, field + ".unitId", 256),
    runtime: "shared-worker",
    scopeKind: enumValue(unit.scopeKind, ["root", "storage", "owner-session", "connect-session"] as const, field + ".scopeKind") as KeymasterScopeKind,
    instanceId: text(unit.instanceId, field + ".instanceId", 256),
    state: enumValue(unit.state, ["starting", "ready", "failed"] as const, field + ".state"),
    snapshotRevision: boundedNumber(unit.snapshotRevision, field + ".snapshotRevision"),
    serviceIds: stringList(unit.serviceIds, field + ".serviceIds", 256, 256),
    taskIds: stringList(unit.taskIds, field + ".taskIds", 1_024, 256),
    ...(ownerPublicKeyHex === undefined ? {} : { ownerPublicKeyHex }),
    ...(sessionEpoch === undefined ? {} : { sessionEpoch }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseWorkerUnitStateEvent(value: unknown): CoordinatorWorkerUnitStateEvent {
  const event = topicEnvelope(value, "worker.units", "coordinator.worker-units.changed");
  if (!Array.isArray(event.units) || event.units.length > 256) throw new TypeError("Coordinator worker units are invalid");
  return {
    topic: "worker.units",
    type: "coordinator.worker-units.changed",
    authorityInstanceId: text(event.authorityInstanceId, "event.authorityInstanceId", 256),
    workerUnitRevision: boundedNumber(event.workerUnitRevision, "event.workerUnitRevision"),
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    units: event.units.map((unit, index) => parseWorkerUnitSnapshot(unit, `event.units[${index}]`)),
  };
}

function parseTopicSubscription(value: unknown): CoordinatorTopicSubscription {
  if (!record(value) || !Array.isArray(value.topics) || value.topics.length > 64) {
    throw new TypeError("Coordinator topic subscription is invalid");
  }
  const topics = value.topics.map((topic, index) => parseCoordinatorTopic(topic, `topics[${index}]`));
  return { topics: [...new Set(topics)] };
}

function parseTopicEvent(value: unknown): CoordinatorTopicEvent {
  const topic = parseCoordinatorTopic(record(value) ? value.topic : undefined, "event.topic");
  switch (topic) {
    case "session.state": return parseSessionStateEvent(value);
    case "background.snapshot": return parseBackgroundSnapshotEvent(value);
    case "asset.data-changed": return parseAssetDataChangedEvent(value);
    case "storage.state": return parseStorageStateEvent(value);
    case "msfile.state": return parseMsFileStateEvent(value);
    case "sat.events": return parseSatStateEvent(value);
    case "channel.events": return parseChannelStateEvent(value);
    case "contacts.presence": return parseContactsPresenceEvent(value);
    case "plugin.intent": return parsePluginIntentStateEvent(value);
    case "worker.units": return parseWorkerUnitStateEvent(value);
  }
}

function parseCryptoOperation(value: unknown): CoordinatorCryptoOperation {
  if (!record(value)) throw new TypeError("Coordinator crypto operation is invalid");
  if (value.type === "signDigest") {
    const digestHex = text(value.digestHex, "crypto.digestHex", 256);
    if (value.format !== "der" && value.format !== "compact") throw new TypeError("Coordinator crypto format is invalid");
    return { type: "signDigest", digestHex, format: value.format };
  }
  if (value.type === "deriveP2pkhAddress") {
    if (value.network !== "main" && value.network !== "test") throw new TypeError("Coordinator crypto network is invalid");
    return { type: "deriveP2pkhAddress", network: value.network };
  }
  throw new TypeError("Coordinator crypto operation is not supported");
}

function parseCryptoResult(value: unknown): CoordinatorCryptoResult {
  if (!record(value)) throw new TypeError("Coordinator crypto result is invalid");
  if (value.type === "signDigest") {
    const signatureHex = text(value.signatureHex, "crypto.signatureHex", 512);
    if (value.format !== "der" && value.format !== "compact") throw new TypeError("Coordinator crypto result format is invalid");
    return { type: "signDigest", signatureHex, format: value.format };
  }
  if (value.type === "deriveP2pkhAddress") {
    return { type: "deriveP2pkhAddress", address: text(value.address, "crypto.address", 256) };
  }
  throw new TypeError("Coordinator crypto result is not supported");
}

function parseOwnerStorageRequest(value: unknown): CoordinatorOwnerStorageData {
  return parseOwnerStorageData(value, "owner");
}

function parsePlatformStorageRequest(value: unknown): CoordinatorPlatformStorageData {
  return parseOwnerStorageData(value, "platform");
}

function localStorageText(value: unknown, field: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`Coordinator local-storage ${field} is invalid`);
  }
  return value;
}

function localStorageInteger(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`Coordinator local-storage ${field} is invalid`);
  }
  return value as number;
}

function optionalLocalStorageBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`Coordinator local-storage ${field} is invalid`);
  return value;
}

function localStorageBytes(value: unknown, field: string): ArrayBuffer {
  return arrayBufferValue(value, `local-storage ${field}`);
}

const LOCAL_SETUP_PHASES = ["validate", "stage", "hold", "catalog-commit", "runtime", "rollback", "complete"] as const;
const LOCAL_SETUP_CATALOG_STATES = ["not-started", "committed", "rolled-back", "competing", "empty", "unknown"] as const;
const LOCAL_SETUP_ROLLBACK_STATES = ["not-started", "confirmed", "unconfirmed"] as const;
const LOCAL_SETUP_STATUSES = ["pending", "succeeded", "failed"] as const;

function localStorageEnum<const Values extends readonly string[]>(value: unknown, values: Values, field: string): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`Coordinator local-storage ${field} is invalid`);
  return value as Values[number];
}

function parseLocalStorageRecoverySuccess(value: unknown, field: string): InitialSetupRecoveryRecordV1["success"] {
  if (!record(value)) throw new TypeError(`Coordinator local-storage ${field} is invalid`);
  const bucketLabel = localStorageText(value.bucketLabel, `${field}.bucketLabel`, 256);
  const publicKeyHex = localStorageText(value.publicKeyHex, `${field}.publicKeyHex`, 66);
  const label = localStorageText(value.label, `${field}.label`, 256);
  const address = localStorageText(value.address, `${field}.address`, 512);
  const format = localStorageText(value.format, `${field}.format`, 128);
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.length > 64) throw new TypeError(`Coordinator local-storage ${field}.capabilities is invalid`);
  const capabilities = value.capabilities.map((item, index) => localStorageText(item, `${field}.capabilities[${index}]`, 128));
  const createdAt = localStorageText(value.createdAt, `${field}.createdAt`, 128);
  const source = value.source === undefined ? undefined : localStorageText(value.source, `${field}.source`, 512);
  return { bucketLabel, publicKeyHex, label, address, format, capabilities, createdAt, ...(source === undefined ? {} : { source }) };
}

function parseLocalStorageUserFacingError(value: unknown, field: string): NonNullable<InitialSetupRecoveryRecordV1["error"]> {
  if (!record(value)) throw new TypeError(`Coordinator local-storage ${field} is invalid`);
  const title = localStorageText(value.title, `${field}.title`, 256);
  const summary = localStorageText(value.summary, `${field}.summary`, 2_048);
  const action = value.action === undefined ? undefined : localStorageText(value.action, `${field}.action`, 512);
  const code = localStorageText(value.code, `${field}.code`, 128);
  const incidentId = localStorageText(value.incidentId, `${field}.incidentId`, 128);
  const transactionId = value.transactionId === undefined ? undefined : localStorageText(value.transactionId, `${field}.transactionId`, 128);
  const diagnostic = localStorageText(value.diagnostic, `${field}.diagnostic`, 12_000);
  const phase = localStorageEnum(value.phase, LOCAL_SETUP_PHASES, `${field}.phase`);
  const rollback = localStorageEnum(value.rollback, LOCAL_SETUP_ROLLBACK_STATES, `${field}.rollback`);
  return { title, summary, ...(action === undefined ? {} : { action }), code, incidentId, ...(transactionId === undefined ? {} : { transactionId }), diagnostic, phase, rollback };
}

function parseLocalStorageRecoveryRecord(value: unknown, field: string): InitialSetupRecoveryRecordV1 {
  if (!record(value)) throw new TypeError(`Coordinator local-storage ${field} is invalid`);
  if (value.format !== "keymaster.storage.initial-setup-recovery" || value.version !== 1) throw new TypeError(`Coordinator local-storage ${field}.format is invalid`);
  if (value.backend !== "local" && value.backend !== "s3") throw new TypeError(`Coordinator local-storage ${field}.backend is invalid`);
  const transactionId = localStorageText(value.transactionId, `${field}.transactionId`, 128);
  const bucketId = localStorageText(value.bucketId, `${field}.bucketId`, 128);
  const catalogEntryFingerprint = localStorageText(value.catalogEntryFingerprint, `${field}.catalogEntryFingerprint`, 64);
  if (!/^[0-9a-f]{64}$/u.test(catalogEntryFingerprint)) throw new TypeError(`Coordinator local-storage ${field}.catalogEntryFingerprint is invalid`);
  const configRevision = localStorageInteger(value.configRevision, `${field}.configRevision`);
  const snapshotRevision = localStorageInteger(value.snapshotRevision, `${field}.snapshotRevision`);
  const connectionFingerprint = localStorageText(value.connectionFingerprint, `${field}.connectionFingerprint`, 64);
  if (!/^[0-9a-f]{64}$/u.test(connectionFingerprint)) throw new TypeError(`Coordinator local-storage ${field}.connectionFingerprint is invalid`);
  const phase = localStorageEnum(value.phase, LOCAL_SETUP_PHASES, `${field}.phase`);
  const catalog = localStorageEnum(value.catalog, LOCAL_SETUP_CATALOG_STATES, `${field}.catalog`);
  if (typeof value.runtimeInstalled !== "boolean") throw new TypeError(`Coordinator local-storage ${field}.runtimeInstalled is invalid`);
  const cleanup = localStorageEnum(value.cleanup, LOCAL_SETUP_ROLLBACK_STATES, `${field}.cleanup`);
  const status = localStorageEnum(value.status, LOCAL_SETUP_STATUSES, `${field}.status`);
  const allowedKeys = new Set([
    "format", "version", "transactionId", "bucketId", "catalogEntryFingerprint",
    "configRevision", "snapshotRevision", "backend", "connectionFingerprint", "phase",
    "catalog", "runtimeInstalled", "cleanup", "status", "updatedAt",
    ...(status === "succeeded" ? ["success"] : status === "failed" ? ["error"] : []),
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new TypeError(`Coordinator local-storage ${field} fields are invalid`);
  const success = value.success === undefined ? undefined : parseLocalStorageRecoverySuccess(value.success, `${field}.success`);
  const error = value.error === undefined ? undefined : parseLocalStorageUserFacingError(value.error, `${field}.error`);
  const updatedAt = localStorageInteger(value.updatedAt, `${field}.updatedAt`);
  return {
    format: "keymaster.storage.initial-setup-recovery",
    version: 1,
    transactionId,
    bucketId,
    catalogEntryFingerprint,
    configRevision,
    snapshotRevision,
    backend: value.backend,
    connectionFingerprint,
    phase,
    catalog,
    runtimeInstalled: value.runtimeInstalled,
    cleanup,
    status,
    ...(success === undefined ? {} : { success }),
    ...(error === undefined ? {} : { error }),
    updatedAt,
  };
}

function parseLocalStorageCondition(value: unknown): StorageBucketWriteCondition | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new TypeError("Coordinator local-storage condition is invalid");
  if (value.ifMatch !== undefined) localStorageText(value.ifMatch, "condition.ifMatch", 512);
  if (value.ifNoneMatch !== undefined && value.ifNoneMatch !== "*") throw new TypeError("Coordinator local-storage condition.ifNoneMatch is invalid");
  const ifMatch = value.ifMatch;
  return {
    ...(ifMatch === undefined ? {} : { ifMatch: ifMatch as string }),
    ...(value.ifNoneMatch === undefined ? {} : { ifNoneMatch: "*" as const }),
  };
}

function parseLocalStorageBinding(value: RecordValue): CoordinatorSessionBinding {
  return {
    peerGeneration: localStorageInteger(value.peerGeneration, "peerGeneration", 1),
    sessionEpoch: localStorageText(value.sessionEpoch, "sessionEpoch", 256),
    leaseId: localStorageText(value.leaseId, "leaseId", 256),
  };
}

function assertNoLocalStorageTransportFields(value: RecordValue): void {
  for (const field of ["authorityInstanceId", "signal", "requestId", "clientId"]) {
    if (field in value) throw new TypeError(`Coordinator local-storage request contains transport field ${field}`);
  }
}

function parseLocalStorageRequest(value: unknown): CoordinatorLocalStorageRequest {
  if (!record(value)) throw new TypeError("Coordinator local-storage request must be an object");
  assertNoLocalStorageTransportFields(value);
  const binding = parseLocalStorageBinding(value);
  const type = localStorageText(value.type, "request.type", 64);
  if (type === "device-record-list" || type === "session-read") return { ...binding, type };
  if (type === "device-record-get" || type === "device-record-delete") {
    return { ...binding, type, remoteStorageId: localStorageText(value.remoteStorageId, "remoteStorageId", 128) };
  }
  if (type === "device-record-put") {
    let record: DeviceRecordV1;
    try {
      record = validateDeviceRecord(value.record);
    } catch {
      throw new TypeError("Coordinator local-storage device record is invalid");
    }
    return {
      ...binding,
      type,
      remoteStorageId: localStorageText(value.remoteStorageId, "remoteStorageId", 128),
      record,
      ...(value.replace === undefined ? {} : { replace: optionalLocalStorageBoolean(value.replace, "replace") }),
    };
  }
  if (type === "session-write") {
    let session: KeymasterSessionV1;
    try {
      session = validateKeymasterSession(value.session);
    } catch {
      throw new TypeError("Coordinator local-storage session is invalid");
    }
    return { ...binding, type, session };
  }
  if (type !== "get" && type !== "list" && type !== "put" && type !== "delete") throw new TypeError("Coordinator local-storage request type is unsupported");
  const bucketId = localStorageText(value.bucketId, "bucketId", 128);
  const bucketGeneration = localStorageInteger(value.bucketGeneration, "bucketGeneration", 1);
  const objectPrefix = value.objectPrefix === undefined
    ? undefined
    : localStorageText(value.objectPrefix, "objectPrefix", 1_024);
  const v1Fields = objectPrefix === undefined ? {} : { objectPrefix };
  const path = type === "get" || type === "put" || type === "delete" ? localStorageText(value.path, "path", 4_096) : undefined;
  if (type === "put") {
    const bytes = localStorageBytes(value.bytes, "bytes");
    const condition = parseLocalStorageCondition(value.condition);
    return { ...binding, type, bucketId, bucketGeneration, path: path!, ...v1Fields, bytes, ...(condition === undefined ? {} : { condition }) };
  }
  if (type === "list") return {
    ...binding, type, bucketId, bucketGeneration,
    ...v1Fields,
    ...(value.prefix === undefined ? {} : { prefix: localStorageText(value.prefix, "prefix", 4_096) }),
    ...(value.cursor === undefined ? {} : { cursor: localStorageText(value.cursor, "cursor", 8_192) }),
    ...(value.limit === undefined ? {} : { limit: localStorageInteger(value.limit, "limit", 1, 256) }),
  };
  if (path === undefined) throw new TypeError("Coordinator local-storage path is invalid");
  return {
    ...binding, type, bucketId, bucketGeneration, path,
    ...v1Fields,
    ...(value.ifMatch === undefined ? {} : { ifMatch: localStorageText(value.ifMatch, "ifMatch", 512) }),
  };
}

function parseLocalStorageObject(value: unknown, field: string): CoordinatorLocalStorageObject {
  if (!record(value)) throw new TypeError(`Coordinator local-storage ${field} is invalid`);
  const path = localStorageText(value.path, `${field}.path`, 4_096);
  const bytes = localStorageBytes(value.bytes, `${field}.bytes`);
  const size = value.size === undefined ? undefined : localStorageInteger(value.size, `${field}.size`);
  const etag = value.etag === undefined ? undefined : localStorageText(value.etag, `${field}.etag`, 512);
  const lastModified = value.lastModified === undefined ? undefined : localStorageText(value.lastModified, `${field}.lastModified`, 128);
  return { path, bytes, ...(size === undefined ? {} : { size }), ...(etag === undefined ? {} : { etag }), ...(lastModified === undefined ? {} : { lastModified }) };
}

function parseLocalStorageResponse(value: unknown): CoordinatorLocalStorageResponse {
  if (!record(value)) throw new TypeError("Coordinator local-storage response must be an object");
  const type = localStorageText(value.type, "response.type", 64);
  if (type === "void" || type === "write") {
    if (type === "write") {
      const etag = value.etag === undefined ? undefined : localStorageText(value.etag, "response.etag", 512);
      const lastModified = value.lastModified === undefined ? undefined : localStorageText(value.lastModified, "response.lastModified", 128);
      return { type, ...(etag === undefined ? {} : { etag }), ...(lastModified === undefined ? {} : { lastModified }) };
    }
    return { type };
  }
  if (type === "object") return { type, ...(value.object === undefined ? {} : { object: parseLocalStorageObject(value.object, "response.object") }) };
  if (type === "list") {
    if (!Array.isArray(value.objects)) throw new TypeError("Coordinator local-storage response.objects is invalid");
    return { type, objects: value.objects.map((item, index) => parseLocalStorageObject(item, `response.objects[${index}]`)), ...(value.nextCursor === undefined ? {} : { nextCursor: localStorageText(value.nextCursor, "response.nextCursor", 8_192) }) };
  }
  if (type === "device-records") {
    if (!Array.isArray(value.entries)) throw new TypeError("Coordinator local-storage response.entries is invalid");
    const entries = value.entries.map((item, index) => {
      if (!record(item)) throw new TypeError(`Coordinator local-storage response.entries[${index}] is invalid`);
      const remoteStorageId = localStorageText(item.remoteStorageId, `response.entries[${index}].remoteStorageId`, 128);
      let deviceRecord: DeviceRecordV1;
      try {
        deviceRecord = validateDeviceRecord(item.record);
      } catch {
        throw new TypeError(`Coordinator local-storage response.entries[${index}].record is invalid`);
      }
      return { remoteStorageId, record: deviceRecord };
    });
    if (!Array.isArray(value.invalidKeys)) throw new TypeError("Coordinator local-storage response.invalidKeys is invalid");
    return { type, entries, invalidKeys: value.invalidKeys.map((item, index) => localStorageText(item, `response.invalidKeys[${index}]`, 256)) };
  }
  if (type === "device-record") {
    if (value.record === undefined) return { type };
    let deviceRecord: DeviceRecordV1;
    try {
      deviceRecord = validateDeviceRecord(value.record);
    } catch {
      throw new TypeError("Coordinator local-storage response.record is invalid");
    }
    return { type, record: deviceRecord };
  }
  if (type === "session") {
    if (value.session === undefined) return { type };
    try {
      return { type, session: validateKeymasterSession(value.session) };
    } catch {
      throw new TypeError("Coordinator local-storage response.session is invalid");
    }
  }
  throw new TypeError("Coordinator local-storage response type is unsupported");
}

function parseKeyValueValue(value: unknown, field: string): KeyValueValue {
  if (value instanceof Uint8Array) return value.slice();
  return parseJsonValue(value, field);
}

function parseKeyValueEntry(value: unknown, field: string): KeyValueEntry {
  const entry = expectRecord(value, field);
  return {
    key: text(entry.key, field + ".key", 1_024),
    value: parseKeyValueValue(entry.value, field + ".value"),
    revision: boundedNumber(entry.revision, field + ".revision"),
    updatedAt: boundedNumber(entry.updatedAt, field + ".updatedAt"),
  };
}

function parseKeyValueMeta(value: unknown, field: string): KeyValueEntryMeta {
  const entry = expectRecord(value, field);
  return {
    key: text(entry.key, field + ".key", 1_024),
    revision: boundedNumber(entry.revision, field + ".revision"),
    updatedAt: boundedNumber(entry.updatedAt, field + ".updatedAt"),
  };
}

function parseKeyValueList(value: unknown, field: string): KeyValueListResult {
  const result = expectRecord(value, field);
  if (!Array.isArray(result.entries) || result.entries.length > 1_000) throw new TypeError("Coordinator " + field + ".entries is invalid");
  const nextCursor = optionalText(result.nextCursor, field + ".nextCursor", 8_192);
  return {
    revision: boundedNumber(result.revision, field + ".revision"),
    entries: result.entries.map((entry, index) => parseKeyValueEntry(entry, field + ".entries[" + index + "]")),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function parseKeyValueCommit(value: unknown, field: string): KeyValueCommitResult {
  const result = expectRecord(value, field);
  return {
    revision: boundedNumber(result.revision, field + ".revision"),
    commitId: text(result.commitId, field + ".commitId", 256),
    committedAt: boundedNumber(result.committedAt, field + ".committedAt"),
  };
}

function parseOwnerStorageResult(value: unknown, field: string): CoordinatorOwnerStorageResult {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map((entry, index) => parseKeyValueEntry(entry, field + "[" + index + "]"));
  const result = expectRecord(value, field);
  if ("entries" in result) return parseKeyValueList(result, field);
  if ("commitId" in result) return parseKeyValueCommit(result, field);
  if ("value" in result) return parseKeyValueEntry(result, field);
  return parseKeyValueMeta(result, field);
}

function collectTransferables(value: unknown, output: Transferable[], seen: Set<object>): void {
  if (value === null || typeof value !== "object") return;
  if (value instanceof ArrayBuffer) {
    if (!output.includes(value)) output.push(value);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer && !output.includes(value.buffer)) output.push(value.buffer);
    return;
  }
  if (typeof MessagePort !== "undefined" && value instanceof MessagePort) {
    if (!output.includes(value)) output.push(value);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectTransferables(item, output, seen);
    return;
  }
  for (const item of Object.values(value)) collectTransferables(item, output, seen);
}

function transfers(value: unknown): readonly Transferable[] {
  const output: Transferable[] = [];
  collectTransferables(value, output, new Set<object>());
  return output;
}

const requestParser: ValueParser<CoordinatorRpcRequest> = { parse: parseCoordinatorRequest };
const responseParser: ValueParser<CoordinatorRpcResponse> = { parse: parseCoordinatorResponse };

/** Coordinator 所有页面命令的唯一 typed RPC。 */
export const COORDINATOR_RPC_CAPABILITY = defineCapability<CoordinatorRpcRequest, CoordinatorRpcResponse>({
  kind: "rpc",
  id: "keymaster.coordinator.rpc",
  version: "1",
  request: requestParser,
  response: responseParser,
  transfer: { request: (value) => transfers(value), response: (value) => transfers(value) },
});

/** Coordinator topic 的唯一 typed stream；baseline 也作为普通 item 交付。 */
export const COORDINATOR_TOPIC_STREAM_CAPABILITY = defineCapability<CoordinatorTopicSubscription, CoordinatorTopicEvent>({
  kind: "stream",
  id: "keymaster.coordinator.events",
  version: "1",
  request: { parse: parseTopicSubscription },
  item: { parse: parseTopicEvent },
  transfer: { request: (value) => transfers(value), item: (value) => transfers(value) },
});

/** Window-side LocalStorage implementation used by the Coordinator. */
export const COORDINATOR_LOCAL_STORAGE_RPC_CAPABILITY = defineCapability<CoordinatorLocalStorageRequest, CoordinatorLocalStorageResponse>({
  kind: "rpc",
  id: "keymaster.coordinator.local-storage",
  version: "1.0.0",
  request: { parse: parseLocalStorageRequest },
  response: { parse: parseLocalStorageResponse },
  transfer: {
    request: (value) => transfers(value),
    response: (value) => transfers(value),
  },
});

/** Worker 暴露给已授权页面的 owner-storage 数据面。 */
export const COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY = defineCapability<CoordinatorOwnerStorageData, CoordinatorOwnerStorageResult>({
  kind: "rpc",
  id: "coordinator.owner-storage",
  version: "1.0.0",
  request: { parse: parseOwnerStorageRequest },
  response: { parse: (value) => parseOwnerStorageResult(value, "owner-storage.response") },
  transfer: { request: (value) => transfers(value), response: (value) => transfers(value) },
});

/** Worker 暴露给已授权页面的平台 K-V 数据面。 */
export const COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY = defineCapability<CoordinatorPlatformStorageData, CoordinatorPlatformStorageResult>({
  kind: "rpc",
  id: "coordinator.platform-storage",
  version: "1.0.0",
  request: { parse: parsePlatformStorageRequest },
  response: { parse: (value) => parseOwnerStorageResult(value, "platform-storage.response") },
  transfer: { request: (value) => transfers(value), response: (value) => transfers(value) },
});

/** Worker 暴露给 Vault 页面/插件的 crypto 数据面。 */
export const COORDINATOR_CRYPTO_RPC_CAPABILITY = defineCapability<CoordinatorCryptoOperation, CoordinatorCryptoResult>({
  kind: "rpc",
  id: "coordinator.crypto",
  version: "1.0.0",
  request: { parse: parseCryptoOperation },
  response: { parse: parseCryptoResult },
});

export const COORDINATOR_RUNTIME_CAPABILITIES = Object.freeze([
  COORDINATOR_RPC_CAPABILITY,
  COORDINATOR_TOPIC_STREAM_CAPABILITY,
  COORDINATOR_LOCAL_STORAGE_RPC_CAPABILITY,
  COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
  COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY,
  COORDINATOR_CRYPTO_RPC_CAPABILITY,
] as const);

// 保留给测试/领域适配器使用的 parser；不把它们作为第二套 wire 入口导出。
export const __coordinatorRuntimeParsers = Object.freeze({
  parseCoordinatorRequest,
  parseCoordinatorResponse,
  parseTopicSubscription,
  parseTopicEvent,
});

void integer;
