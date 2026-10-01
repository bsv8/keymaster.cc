// Coordinator 与 WebLoom Runtime 之间的 typed capability 契约。
//
// 这里是 Keymaster 领域 DTO 的唯一 Runtime 边界：manifest 只携带 capability
// descriptor，parser/transfer extractor 留在各自 realm。Coordinator client 和
// Worker handler 都从这些对象取得请求、结果及流 item 类型。

import {
  defineCapability,
  type ValueParser,
} from "webloom-framework";
import { isValidBackgroundSyncIntervalMs } from "./background.js";
import {
  AUTO_LOCK_DEFAULT_TIMEOUT_MS,
  isValidAutoLockTimeoutMs,
} from "./autolock.js";
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
  CoordinatorWorkerUnitPublicSnapshot,
  CoordinatorUnitUnavailableCode,
  CoordinatorUnitUnavailableReason,
  P2pkhProviderConfig,
  CoordinatorTaskSnapshot,
  SessionStateEvent,
  BackgroundSnapshotEvent,
  CoordinatorChainHeightEvent,
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
  MsFileSellerSettings,
  MsFileSupplierConfig,
  MsFileBitfsDemandSnapshot,
  MsFileBitfsPurchaseSnapshot,
  MsFileBitfsTaskSnapshot,
  MsFileBitfsQuoteView,
  MsFileBitfsBuyerSettings,
} from "./msfile.js";
import {
  MSFILE_MAX_BLOCK_BYTES,
  MSFILE_LOCAL_SOURCE_ID,
  isValidMsFileHashHex,
  isValidMsFileSourceId,
  isValidMsFileSupplierPublicKeyHex,
  normalizeMsFileSatoshiAmount,
  normalizeMsFileSellerSettings,
  normalizeMsFileBitfsBuyerSettings,
} from "./msfile.js";
import type {
  CoordinatorOwnerStorageData,
  CoordinatorPlatformStorageData,
  StorageBindingGrant,
  StorageOwnerGrant,
  StoragePlatformGrant,
} from "./storage/internal.js";
import type {
  StorageDeleteResult,
  StorageDirectoryResult,
  StorageGetResult,
  StorageListResult,
  StoragePutResult,
} from "./connectStorage.js";
import type {
  WalletColdStartSnapshot,
  WalletInitializePhase,
  WalletInitializePlan,
  WalletInitializeResult,
  WalletUnlockResult,
  WalletUserFacingError,
} from "./storage/wallet.js";
import { validateWalletMeta } from "./storage/wallet.js";
import type { KeyValueCommitResult, KeyValueEntry, KeyValueEntryMeta, KeyValueListResult, KeyValueValue } from "./storage/kv.js";
import { STORAGE_MAX_PAYLOAD_BYTES } from "./storage/kv.js";
import type { PluginIntentCommand, PluginIntentSnapshot, PluginIntentSubmissionResult } from "webloom-framework";
import type { StorageRuntimeControllerStatus, StorageRuntimeSummary } from "./storage/runtime.js";
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
  "unlock", "lock", "vault.operation", "crypto",
  "background.run-now", "background.trigger", "background.cancel", "background.cancel-by-key",
  "background.settings.update", "autolock.settings.update", "storage.grant", "storage.control", "storage.data",
  "storage.cancel", "storage.session.abort", "storage.owner.bind", "storage.platform.bind",
  "storage.owner.data", "storage.platform.data", "storage.clear.root", "msfile.control",
  "msfile.grant", "msfile.data", "msfile.cancel", "msfile.session.abort",
  "window-p2p.executor.acquire", "window-p2p.executor.release", "window-p2p.executor.spike.transfer",
  "window-p2p.executor.identity.sign-noise", "window-p2p.executor.identity.sign-peer-record",
  "sat.operation", "channel.operation", "channel.cancel", "contacts.presence.snapshot",
  "plugin.intent.snapshot", "plugin.intent.submit", "p2pkh.settings.update", "p2pkh.provider-config.get", "p2pkh.provider-config.update",
  "p2pkh.utxos.get", "p2pkh.utxos.refresh",
  "p2pkh.broadcast",
]);

const STORAGE_CONTROL_TYPES = [
  "status", "summary", "cold-start", "initialize", "unlock", "lock",
  "change-key-password", "rename-key", "export-key-hold", "reset-wallet",
] as const satisfies readonly CoordinatorStorageControl["type"][];

const STORAGE_DATA_TYPES = [
  "list", "create-directory", "delete-directory", "put", "get-range", "delete", "batch",
] as const satisfies readonly CoordinatorStorageData["type"][];

const VAULT_OPERATION_TYPES = [
  "getCurrentKey", "verifyPassword", "changePassword", "renameKey", "exportKeyHold",
  "sealLocalSecret", "openLocalSecret",
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
  /** 页面为本次 physical peer 分配的运行互斥租约。 */
  leaseId: string;
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
  O extends { type: "getCurrentKey" } ? CoordinatorVaultKeyView | undefined :
  O extends { type: "verifyPassword" | "changePassword" | "renameKey" } ? true :
  O extends { type: "exportKeyHold" } ? Uint8Array :
  O extends { type: "sealLocalSecret" } ? VaultSealedSecret :
  O extends { type: "openLocalSecret" } ? Uint8Array :
  never;

/** 依据 storage.control 内层 control discriminant 收窄 operationResult。 */
export type CoordinatorStorageControlResultFor<C extends CoordinatorStorageControl> =
  C extends { type: "status" } ? StorageRuntimeControllerStatus :
  C extends { type: "summary" } ? StorageRuntimeSummary | null :
  C extends { type: "cold-start" } ? WalletColdStartSnapshot :
  C extends { type: "initialize" } ? WalletInitializeResult :
  C extends { type: "unlock" } ? WalletUnlockResult :
  C extends { type: "lock" | "change-key-password" | "rename-key" | "export-key-hold" } ? true :
  C extends { type: "reset-wallet" } ? { walletGeneration: string; clearedAt: string } :
  never;

/** 依据 storage.data 内层 data discriminant 收窄 operationResult。 */
export type CoordinatorStorageDataResultFor<D extends CoordinatorStorageData> =
  D extends { type: "list" } ? StorageListResult :
  D extends { type: "create-directory" | "delete-directory" } ? StorageDirectoryResult :
  D extends { type: "put" } ? StoragePutResult :
  D extends { type: "get-range" } ? StorageGetResult :
  D extends { type: "delete" } ? StorageDeleteResult :
  D extends { type: "batch" } ? { paths: string[]; committedAt: string } :
  never;

/** 依据 msfile.control 内层 control discriminant 收窄 operationResult。 */
export type CoordinatorMsFileControlResultFor<C extends CoordinatorMsFileControl> =
  C extends { type: "settings.get" } ? MsFileSettingsSnapshot :
  C extends { type: "settings.bitfsBuyer.get" } ? MsFileBitfsBuyerSettings :
  C extends { type: "settings.readConcurrency.get" } ? MsFileReadConcurrencySettings :
  C extends { type: "settings.readConcurrency.update" | "settings.readConcurrency.reset" | "settings.mediaBlockReadConcurrency.update" | "settings.global.update" | "settings.seller.update" | "settings.bitfsBuyer.update" | "bitfs.buyerPriceLimit.update" | "supplier.upsert" | "supplier.delete" | "app-policy.update" | "app-policy.clear" | "approval.resolve" } ? null :
  C extends { type: "settings.mediaBlockReadConcurrency.get" } ? number :
  C extends { type: "bitfs.demand.publish" | "bitfs.demand.snapshot" | "bitfs.purchase.start" | "bitfs.purchase.cancel" } ? MsFileBitfsDemandSnapshot :
  C extends { type: "bitfs.purchase.tasks.list" } ? MsFileBitfsTaskSnapshot[] :
  C extends { type: "bitfs.demand.cancel" } ? null :
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
  D extends { type: "owner.file-range" } ? import("./storage/files.js").OwnerFileObject | undefined :
  D extends { type: "owner.file-put" } ? { revision: string; lastModified: string } :
  D extends { type: "owner.file-delete" } ? undefined :
  D extends { type: "owner.file-batch" } ? { paths: string[]; committedAt: string } :
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

/** storage.control 各 control type 的 operationResult 总联合。 */
export type CoordinatorStorageControlResult = CoordinatorStorageControlResultFor<CoordinatorStorageControl> | null | undefined;

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
  | {
      status: "not-dispatched";
      reason:
        | "stale-provider-generation"
        | "broadcast-provider-unavailable"
        | "coordinator-not-dispatched"
        | "stale-session-epoch"
        | "snapshot-stale"
        | "snapshot-consumed"
        | "snapshot-binding-required"
        | "snapshot-input-invalid";
      /** 当前快照序号；仅快照门禁拒绝时携带。 */
      currentSeq?: number;
    }
  | {
      status: "isolated";
      txid: string;
      reason: string;
      canonicalTxid?: string;
      providerReturnedTxidRaw?: string;
      providerReturnedTxidNormalized?: string;
      txidIntegrity?: "exact" | "reversed" | "mismatch" | "missing";
      providerId?: string;
    }
  | {
      status: "local-confirmed" | "already-known";
      txid: string;
      canonicalTxid?: string;
      providerReturnedTxidRaw?: string;
      providerReturnedTxidNormalized?: string;
      txidIntegrity?: "exact" | "reversed" | "mismatch" | "missing";
      providerId?: string;
      providerReference?: string;
      providerCode?: string;
      providerMessage?: string;
    };

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
  R extends { kind: "storage.owner.bind" } ? StorageBindingGrant :
  R extends { kind: "storage.platform.bind" } ? StoragePlatformGrant :
  R extends { kind: "storage.clear.root" } ? true :
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
      | "background.run-now"
      | "background.trigger"
      | "background.cancel"
      | "background.cancel-by-key"
      | "background.settings.update"
      | "autolock.settings.update"
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

/**
 * 解析创建/导入计划。
 *
 * 这是唯一的初始化入口：没有存储类型选择、没有桶标签、没有远程连接，
 * 只有一把 Key 与它自己的密码。Coordinator 在一个 IndexedDB 事务里同时
 * 提交 `key.json`、`.keymaster/meta` 和必要初始系统数据。
 */
function parseWalletInitializePlan(value: unknown): WalletInitializePlan {
  const plan = expectRecord(value, "wallet initialize plan");
  const firstKey = expectRecord(plan.firstKey, "wallet initialize plan.firstKey");
  const kind = enumValue(firstKey.kind, ["generate", "import"] as const, "wallet initialize plan.firstKey.kind");
  const label = text(firstKey.label, "wallet initialize plan.firstKey.label", 256);
  const capabilities = stringList(firstKey.capabilities, "wallet initialize plan.firstKey.capabilities", 64, 128);
  const password = text(firstKey.password, "wallet initialize plan.firstKey.password", 4_096);
  if (kind === "generate") {
    return { transactionId: text(plan.transactionId, "wallet initialize plan.transactionId", 128), firstKey: { kind, label, capabilities, password } };
  }
  const material = expectRecord(firstKey.material, "wallet initialize plan.firstKey.material");
  const wif = optionalText(material.wif, "wallet initialize plan.firstKey.material.wif", 256);
  const source = optionalText(firstKey.source, "wallet initialize plan.firstKey.source", 512);
  return {
    transactionId: text(plan.transactionId, "wallet initialize plan.transactionId", 128),
    firstKey: {
      kind,
      label,
      material: { hex: text(material.hex, "wallet initialize plan.firstKey.material.hex", 256), ...(wif === undefined ? {} : { wif }) },
      format: text(firstKey.format, "wallet initialize plan.firstKey.format", 128),
      ...(source === undefined ? {} : { source }),
      capabilities,
      password,
    },
  };
}

function parseStorageControl(value: unknown): CoordinatorStorageControl {
  const control = expectRecord(value, "storage control");
  const type = enumValue(control.type, STORAGE_CONTROL_TYPES, "storage control.type");
  switch (type) {
    case "status": case "summary": case "cold-start": case "lock": case "export-key-hold":
      return { type };
    case "unlock":
      return { type, password: text(control.password, "storage control." + type + ".password", 4_096) };
    case "initialize":
      return { type, plan: parseWalletInitializePlan(control.plan) };
    case "change-key-password":
      return {
        type,
        oldPassword: text(control.oldPassword, "storage control.change-key-password.oldPassword", 4_096),
        newPassword: text(control.newPassword, "storage control.change-key-password.newPassword", 4_096),
      };
    case "rename-key":
      return { type, label: text(control.label, "storage control.rename-key.label", 256) };
    case "reset-wallet":
      return { type, confirmationLabel: text(control.confirmationLabel, "storage control.reset-wallet.confirmationLabel", 256) };
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
    case "batch": {
      const operations = input.operations;
      if (!Array.isArray(operations) || operations.length === 0 || operations.length > 1_000) {
        throw new TypeError("Coordinator storage data.batch.operations is invalid");
      }
      const parsedOperations = operations.map((entry, index) => {
        const field = "storage data.batch.operations[" + index + "]";
        const operation = expectRecord(entry, field);
        const operationType = enumValue(operation.type, ["put", "delete"] as const, field + ".type");
        const path = text(operation.path, field + ".path", 4_096);
        if (operationType === "delete") return { type: "delete" as const, path };
        const contentType = optionalText(operation.contentType, field + ".contentType", 256);
        return {
          type: "put" as const,
          path,
          content: parseBinaryField(operation.content, field + ".content"),
          ...(contentType === undefined ? {} : { contentType }),
        };
      });
      const rawConditions = input.conditions;
      let parsedConditions: Array<{ path: string; ifMatch?: string }> | undefined;
      if (rawConditions !== undefined) {
        if (!Array.isArray(rawConditions) || rawConditions.length > 1_000) {
          throw new TypeError("Coordinator storage data.batch.conditions is invalid");
        }
        parsedConditions = rawConditions.map((entry, index) => {
          const field = "storage data.batch.conditions[" + index + "]";
          const condition = expectRecord(entry, field);
          const ifMatch = optionalText(condition.ifMatch, field + ".ifMatch", 512);
          return { path: text(condition.path, field + ".path", 4_096), ...(ifMatch === undefined ? {} : { ifMatch }) };
        });
      }
      return {
        type,
        grantId,
        input: { operations: parsedOperations, ...(parsedConditions === undefined ? {} : { conditions: parsedConditions }) },
      };
    }
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
  | { operation: "file-range"; grantId: string; path: string; range: { offset: number; length: number }; ifRevision?: string }
  | { operation: "file-put"; grantId: string; path: string; bytes: Uint8Array; ifNoneMatch?: boolean; ifMatch?: string }
  | { operation: "file-delete"; grantId: string; path: string; ifMatch?: string }
  | {
    operation: "file-batch";
    grantId: string;
    operations: Array<{ type: "put"; path: string; bytes: Uint8Array; contentType?: string } | { type: "delete"; path: string }>;
    conditions?: Array<{ path: string; ifRevision?: string; ifNoneMatch?: boolean }>;
  };

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
  if (type === prefix + ".file-get" || type === prefix + ".file-range" || type === prefix + ".file-put" || type === prefix + ".file-delete") {
    if (prefix !== "owner") throw new TypeError("Coordinator platform storage operation is unsupported");
    const path = text(data.path, prefix + " storage." + type.slice(prefix.length + 1) + ".path", 4_096);
    if (type === prefix + ".file-get") return { operation: "file-get", grantId, path };
    if (type === prefix + ".file-range") {
      const range = expectRecord(data.range, prefix + " storage.file-range.range");
      return {
        operation: "file-range",
        grantId,
        path,
        range: {
          offset: boundedNumber(range.offset, prefix + " storage.file-range.range.offset", 0),
          length: boundedNumber(range.length, prefix + " storage.file-range.range.length", 1, STORAGE_MAX_PAYLOAD_BYTES),
        },
        ...(data.ifRevision === undefined
          ? {}
          : { ifRevision: text(data.ifRevision, prefix + " storage.file-range.ifRevision", 1_024) }),
      };
    }
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
  if (type === prefix + ".file-batch") {
    if (prefix !== "owner") throw new TypeError("Coordinator platform storage operation is unsupported");
    if (!Array.isArray(data.operations) || data.operations.length === 0 || data.operations.length > 1_000) {
      throw new TypeError("Coordinator " + prefix + " storage.file-batch.operations is invalid");
    }
    const operations = data.operations.map((item: unknown, index: number) => {
      const field = prefix + " storage.file-batch.operations[" + index + "]";
      const operation = expectRecord(item, field);
      const path = text(operation.path, field + ".path", 4_096);
      if (operation.type === "delete") return { type: "delete" as const, path };
      if (operation.type !== "put") throw new TypeError(`Coordinator ${field}.type is invalid`);
      const bytes = operation.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > STORAGE_MAX_PAYLOAD_BYTES) {
        throw new TypeError(`Coordinator ${field}.bytes is invalid`);
      }
      const contentType = optionalText(operation.contentType, field + ".contentType", 256);
      return {
        type: "put" as const,
        path,
        bytes,
        ...(contentType === undefined ? {} : { contentType }),
      };
    });
    if (data.conditions === undefined) return { operation: "file-batch", grantId, operations };
    if (!Array.isArray(data.conditions) || data.conditions.length > 1_000) {
      throw new TypeError("Coordinator " + prefix + " storage.file-batch.conditions is invalid");
    }
    const conditions = data.conditions.map((item: unknown, index: number) => {
      const field = prefix + " storage.file-batch.conditions[" + index + "]";
      const condition = expectRecord(item, field);
      const ifRevision = optionalText(condition.ifRevision, field + ".ifRevision", 1_024);
      const ifNoneMatch = condition.ifNoneMatch;
      if (ifNoneMatch !== undefined && ifNoneMatch !== true) throw new TypeError(`Coordinator ${field}.ifNoneMatch is invalid`);
      return {
        path: text(condition.path, field + ".path", 4_096),
        ...(ifRevision === undefined ? {} : { ifRevision }),
        ...(ifNoneMatch === undefined ? {} : { ifNoneMatch: true as const }),
      };
    });
    return { operation: "file-batch", grantId, operations, conditions };
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
    case "file-range": return { type: "owner.file-range", storageGrantId: parsed.grantId, path: parsed.path, range: parsed.range, ...(parsed.ifRevision === undefined ? {} : { ifRevision: parsed.ifRevision }) };
    case "file-put": return { type: "owner.file-put", storageGrantId: parsed.grantId, path: parsed.path, bytes: parsed.bytes, ...(parsed.ifNoneMatch === undefined ? {} : { ifNoneMatch: parsed.ifNoneMatch }), ...(parsed.ifMatch === undefined ? {} : { ifMatch: parsed.ifMatch }) };
    case "file-delete": return { type: "owner.file-delete", storageGrantId: parsed.grantId, path: parsed.path, ...(parsed.ifMatch === undefined ? {} : { ifMatch: parsed.ifMatch }) };
    case "file-batch": return { type: "owner.file-batch", storageGrantId: parsed.grantId, operations: parsed.operations, ...(parsed.conditions === undefined ? {} : { conditions: parsed.conditions }) };
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
    case "file-range":
    case "file-put":
    case "file-delete":
    case "file-batch": throw new TypeError("Coordinator platform storage operation is unsupported");
  }
}

function parseStorageDeclaration(value: unknown, field: string): PluginStorageDeclaration {
  const declaration = expectRecord(value, field);
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
    return validatePluginStorageDeclaration({ moduleId, purposeId, authority, model, schemaVersion });
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

function parseMsFileSellerSettings(value: unknown, field = "MSFile seller settings"): MsFileSellerSettings {
  const normalized = normalizeMsFileSellerSettings(expectRecord(value, field));
  if (!normalized) throw new TypeError(`Coordinator ${field} is invalid`);
  return normalized;
}

/** Worker RPC 边界统一校验 BitFS 买方自动购买策略。 */
function parseMsFileBitfsBuyerSettings(value: unknown, field = "MSFile BitFS buyer settings"): MsFileBitfsBuyerSettings {
  const normalized = normalizeMsFileBitfsBuyerSettings(expectRecord(value, field));
  if (!normalized) throw new TypeError(`${field} is invalid`);
  return normalized;
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
    || type === "settings.bitfsBuyer.get"
    || type === "settings.mediaBlockReadConcurrency.get" || type === "app-authorizations.list" || type === "approvals.pending"
    || type === "bitfs.purchase.tasks.list") {
    return { type };
  }
  if (type === "bitfs.demand.publish" || type === "bitfs.demand.snapshot" || type === "bitfs.demand.cancel") {
    const seedHashHex = text(control.seedHashHex, `MSFile control.${type}.seedHashHex`, 64);
    if (!isValidMsFileHashHex(seedHashHex)) throw new TypeError(`Coordinator MSFile control ${type} Seed Hash is invalid`);
    return { type, seedHashHex };
  }
  if (type === "bitfs.purchase.start") {
    const seedHashHex = text(control.seedHashHex, `MSFile control.${type}.seedHashHex`, 64);
    if (!isValidMsFileHashHex(seedHashHex)) throw new TypeError("Coordinator MSFile purchase Seed Hash is invalid");
    const maxFullBlockPriceSatoshis = optionalText(control.maxFullBlockPriceSatoshis, `MSFile control.${type}.maxFullBlockPriceSatoshis`, 20);
    return {
      type,
      seedHashHex,
      sessionId: text(control.sessionId, `MSFile control.${type}.sessionId`, 128),
      ...(maxFullBlockPriceSatoshis === undefined ? {} : { maxFullBlockPriceSatoshis: parseMsFileSatoshiAmount(maxFullBlockPriceSatoshis, `MSFile control.${type}.maxFullBlockPriceSatoshis`) }),
    };
  }
  if (type === "bitfs.purchase.cancel") {
    const seedHashHex = text(control.seedHashHex, `MSFile control.${type}.seedHashHex`, 64);
    if (!isValidMsFileHashHex(seedHashHex)) throw new TypeError("Coordinator MSFile purchase Seed Hash is invalid");
    return { type, seedHashHex, sessionId: text(control.sessionId, `MSFile control.${type}.sessionId`, 128) };
  }
  if (type === "bitfs.buyerPriceLimit.update") {
    const seedHashHex = text(control.seedHashHex, `MSFile control.${type}.seedHashHex`, 64);
    if (!isValidMsFileHashHex(seedHashHex)) throw new TypeError(`Coordinator MSFile control ${type} Seed Hash is invalid`);
    return {
      type,
      seedHashHex,
      maxFullBlockPriceSatoshis: parseMsFileSatoshiAmount(control.maxFullBlockPriceSatoshis, `MSFile control.${type}.maxFullBlockPriceSatoshis`),
    };
  }
  if (type === "settings.readConcurrency.update") return { type, input: parseMsFileReadConcurrency(control.input) };
  if (type === "settings.global.update") return { type, input: parseMsFileGlobalPriceSettings(control.input) };
  if (type === "settings.seller.update") return { type, input: parseMsFileSellerSettings(control.input) };
  if (type === "settings.bitfsBuyer.update") return { type, input: parseMsFileBitfsBuyerSettings(control.input) };
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
    const sourceId = text(data.sourceId, "MSFile data.read-seed.sourceId", 96);
    if (!isValidMsFileSourceId(sourceId)) throw new TypeError("Coordinator MSFile source ID is invalid");
    return { type, sourceId, seedHashHex: hash(data.seedHashHex, "MSFile data.read-seed.seedHashHex"), ...(grantId === undefined ? {} : { grantId }) };
  }
  if (type === "read-block") {
    const sourceId = text(data.sourceId, "MSFile data.read-block.sourceId", 96);
    if (!isValidMsFileSourceId(sourceId)) throw new TypeError("Coordinator MSFile source ID is invalid");
    return { type, sourceId, seedHashHex: hash(data.seedHashHex, "MSFile data.read-block.seedHashHex"), blockHashHex: hash(data.blockHashHex, "MSFile data.read-block.blockHashHex"), ...(grantId === undefined ? {} : { grantId }) };
  }
  throw new TypeError("Coordinator MSFile data " + type + " is unsupported");
}

function parseVaultOperation(value: unknown): CoordinatorVaultOperation {
  const operation = expectRecord(value, "Vault operation");
  const type = enumValue(operation.type, VAULT_OPERATION_TYPES, "Vault operation.type");
  const password = (field: string): string => text(operation[field], "Vault operation." + field, 4_096);
  switch (type) {
    // 唯一 Key：读取公开摘要，不存在列表、选择、切换或第二把 Key 的入口。
    case "getCurrentKey": case "exportKeyHold":
      return { type };
    case "verifyPassword": return { type, password: password("password") };
    case "changePassword": return { type, oldPassword: password("oldPassword"), newPassword: password("newPassword") };
    case "renameKey": return { type, label: text(operation.label, "Vault operation.label", 256) };
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

function parseAutoLockSettings(value: unknown): import("./autolock.js").AutoLockSettings {
  const settings = expectRecord(value, "autolock settings");
  const timeoutMs = settings.timeoutMs;
  if (!isValidAutoLockTimeoutMs(timeoutMs)) {
    throw new TypeError("Coordinator autolock settings timeout is invalid");
  }
  return { timeoutMs };
}

function parseAutoLockTimeoutMsField(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!isValidAutoLockTimeoutMs(value)) {
    throw new TypeError(`Coordinator ${field} is invalid`);
  }
  return value as number;
}

/** 同步管理允许的间隔取值；解析时 fail closed，避免任意周期写入快照。 */
function parseBackgroundSettings(value: unknown): CoordinatorBackgroundSyncSettings {
  const settings = expectRecord(value, "background settings");
  const intervals = expectRecord(settings.taskIntervals, "background settings.taskIntervals");
  const taskIntervals: Record<string, number> = {};
  for (const [taskId, interval] of Object.entries(intervals)) {
    if (taskId.length === 0 || taskId.length > 128) throw new TypeError("Coordinator background settings task id is invalid");
    if (!isValidBackgroundSyncIntervalMs(interval)) {
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
      return { kind, leaseId };
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
    case "storage.clear.root": {
      const input = expectRecord(request.input, "storage.clear.root.input");
      const appStorageName = optionalText(input.appStorageName, "storage.clear.root.input.appStorageName", 128);
      return {
        kind,
        input: {
          declaration: parseStorageDeclaration(input.declaration, "storage.clear.root.input.declaration"),
          ...(appStorageName === undefined ? {} : { appStorageName }),
        },
        expectedSessionEpoch: epoch("expectedSessionEpoch"),
      };
    }
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
    case "unlock": return { kind, password: text(request.password, "unlock.password", 4_096), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "lock": return { kind, expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "vault.operation": return { kind, operation: parseVaultOperation(request.operation), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "crypto": return { kind, operation: parseCryptoOperation(request.operation), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "background.run-now": case "background.cancel":
      return { kind, taskId: text(request.taskId, kind + ".taskId", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") } as CoordinatorRpcRequest;
    case "background.trigger":
      return { kind, taskId: text(request.taskId, kind + ".taskId", 256), reason: text(request.reason, kind + ".reason", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "background.cancel-by-key": return { kind, publicKeyHex: text(request.publicKeyHex, kind + ".publicKeyHex", 256), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "background.settings.update": return { kind, settings: parseBackgroundSettings(request.settings), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "autolock.settings.update": return { kind, settings: parseAutoLockSettings(request.settings), expectedSessionEpoch: epoch("expectedSessionEpoch") };
    case "p2pkh.settings.update": {
      const settings = expectRecord(request.settings, kind + ".settings");
      const feeRates = settings.feeRateSatoshisPerKb;
      let parsedFeeRates: Partial<Record<"low" | "medium" | "high", number>> | undefined;
      if (feeRates !== undefined) {
        const values = expectRecord(feeRates, kind + ".settings.feeRateSatoshisPerKb");
        parsedFeeRates = {};
        for (const tier of ["low", "medium", "high"] as const) {
          if (values[tier] === undefined) continue;
          const value = integer(values[tier], kind + `.settings.feeRateSatoshisPerKb.${tier}`);
          if (value < 1) throw new TypeError(`Coordinator ${kind}.settings.feeRateSatoshisPerKb.${tier} is invalid`);
          parsedFeeRates[tier] = value;
        }
      }
      return {
        kind,
        settings: {
          includeTestnet: booleanValue(settings.includeTestnet, kind + ".settings.includeTestnet"),
          ...(parsedFeeRates === undefined ? {} : { feeRateSatoshisPerKb: parsedFeeRates })
        },
        expectedSessionEpoch: epoch("expectedSessionEpoch")
      };
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
  const walletGeneration = optionalText(snapshot.walletGeneration, field + ".walletGeneration", 256);
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
    runGeneration: text(snapshot.runGeneration, field + ".runGeneration", 256),
    ...(buildId === undefined ? {} : { buildId }),
    sessionEpoch: text(snapshot.sessionEpoch, field + ".sessionEpoch", 256),
    vaultStatus: enumValue(snapshot.vaultStatus, ["booting", "uninitialized", "locked", "unlocked", "fatal"] as const, field + ".vaultStatus"),
    ...(activePublicKeyHex === undefined ? {} : { activePublicKeyHex }),
    ...(authorityRecovery === undefined ? {} : { authorityRecovery }),
    ...(units === undefined ? {} : { coordinatorWorkerUnits: units }),
    ...(workerRevision === undefined ? {} : { coordinatorWorkerUnitSnapshotRevision: workerRevision }),
    taskSnapshots: (() => {
      if (!Array.isArray(snapshot.taskSnapshots) || snapshot.taskSnapshots.length > 4_096) throw new TypeError(`Coordinator ${field}.taskSnapshots is invalid`);
      return snapshot.taskSnapshots.map((task, index) => parseTaskSnapshot(task, `${field}.taskSnapshots[${index}]`));
    })(),
    scheduleSettings: parseBackgroundSettings(snapshot.scheduleSettings),
    ...(() => {
      const autoLockTimeoutMs = parseAutoLockTimeoutMsField(snapshot.autoLockTimeoutMs, field + ".autoLockTimeoutMs");
      return autoLockTimeoutMs === undefined ? {} : { autoLockTimeoutMs };
    })(),
    ...(p2pkhSettings === undefined ? {} : { p2pkhSettings }),
    ...(walletGeneration === undefined ? {} : { walletGeneration }),
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

/**
 * 初始化/重置失败时回给页面的可行动错误。
 *
 * 这里只承载阶段、错误码、脱敏诊断和关联 ID；回滚状态由 Coordinator 内部
 * 掌握，不让页面猜测数据是否可用。
 */
function parseWalletUserFacingError(value: unknown, field: string): WalletUserFacingError {
  const error = expectRecord(value, field);
  const action = optionalText(error.action, field + ".action", 512);
  return {
    title: text(error.title, field + ".title", 256),
    summary: text(error.summary, field + ".summary", 2_048),
    ...(action === undefined ? {} : { action }),
    code: text(error.code, field + ".code", 128),
    incidentId: text(error.incidentId, field + ".incidentId", 128),
    diagnostic: text(error.diagnostic, field + ".diagnostic", 12_000),
    phase: enumValue(error.phase, ["validate", "derive-key", "commit", "rollback", "complete"] as const, field + ".phase") as WalletInitializePhase,
  };
}

function parseWalletKeySummary(value: unknown, field: string): Extract<WalletInitializeResult, { ok: true }>["key"] {
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

function parseWalletInitializeResult(value: unknown, field: string): WalletInitializeResult {
  const result = expectRecord(value, field);
  if (result.ok === true) return {
    ok: true,
    key: parseWalletKeySummary(result.key, field + ".key"),
    walletGeneration: text(result.walletGeneration, field + ".walletGeneration", 256),
  };
  if (result.ok === false) return { ok: false, error: parseWalletUserFacingError(result.error, field + ".error") };
  throw new TypeError(`Coordinator ${field}.ok is invalid`);
}

/**
 * 冷启动快照。
 *
 * 只有四个本地状态；`corrupt` 与 `unsupported` 携带脱敏原因供界面进入恢复
 * 提示，绝不返回“空钱包”让页面静默重新创建。
 */
function parseWalletColdStartSnapshot(value: unknown, field: string): WalletColdStartSnapshot {
  const result = expectRecord(value, field);
  const state = enumValue(result.state, ["uninitialized", "ready", "corrupt", "unsupported"] as const, field + ".state");
  const reason = optionalText(result.reason, field + ".reason", 512);
  let meta: WalletColdStartSnapshot["meta"];
  if (result.meta !== undefined) {
    try { meta = validateWalletMeta(result.meta); } catch { throw new TypeError(`Coordinator ${field}.meta is invalid`); }
  }
  let key: WalletColdStartSnapshot["key"];
  if (result.key !== undefined) {
    const record = expectRecord(result.key, field + ".key");
    key = { publicKeyHex: text(record.publicKeyHex, field + ".key.publicKeyHex", 66), label: text(record.label, field + ".key.label", 256) };
  }
  return { state, ...(meta === undefined ? {} : { meta }), ...(key === undefined ? {} : { key }), ...(reason === undefined ? {} : { reason }) };
}

function parseWalletUnlockResult(value: unknown, field: string): WalletUnlockResult {
  const result = expectRecord(value, field);
  return {
    sessionEpoch: text(result.sessionEpoch, field + ".sessionEpoch", 256),
    walletGeneration: text(result.walletGeneration, field + ".walletGeneration", 256),
    publicKeyHex: text(result.publicKeyHex, field + ".publicKeyHex", 66),
  };
}

function parseStoragePersistenceView(value: unknown, field: string): StorageRuntimeSummary["persistence"] {
  const persistence = expectRecord(value, field);
  const usageBytes = optionalBoundedNumber(persistence.usageBytes, field + ".usageBytes");
  const quotaBytes = optionalBoundedNumber(persistence.quotaBytes, field + ".quotaBytes");
  return {
    persisted: booleanValue(persistence.persisted, field + ".persisted"),
    ...(usageBytes === undefined ? {} : { usageBytes }),
    ...(quotaBytes === undefined ? {} : { quotaBytes }),
  };
}

function parseStorageRuntimeSummary(value: unknown, field: string): StorageRuntimeSummary {
  const summary = expectRecord(value, field);
  const publicKeyHex = optionalText(summary.publicKeyHex, field + ".publicKeyHex", 66);
  const label = optionalText(summary.label, field + ".label", 256);
  const walletGeneration = optionalText(summary.walletGeneration, field + ".walletGeneration", 256);
  return {
    status: enumValue(summary.status, ["uninitialized", "locked", "ready", "degraded", "corrupt", "unsupported"] as const, field + ".status"),
    // 正式介质固定为本地 IndexedDB；不再有 Provider 可供选择。
    medium: "indexeddb",
    ...(publicKeyHex === undefined ? {} : { publicKeyHex }),
    ...(label === undefined ? {} : { label }),
    ...(walletGeneration === undefined ? {} : { walletGeneration }),
    persistence: parseStoragePersistenceView(summary.persistence, field + ".persistence"),
  };
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

function parseStorageDataResult(value: unknown, field: string): CoordinatorStorageDataResult {
  if (value === undefined) return undefined;
  const result = expectRecord(value, field);
  if ("directories" in result && "files" in result) return parseStorageListResult(result, field);
  if ("content" in result && "offset" in result) return parseStorageGetResult(result, field);
  if (result.deleted === true) return parseStorageDeleteResult(result, field);
  if ("path" in result && "size" in result && "updatedAt" in result) return parseStoragePutResult(result, field);
  if ("path" in result && ("created" in result || "deleted" in result)) return parseStorageDirectoryResult(result, field);
  if (Array.isArray(result.paths) && typeof result.committedAt === "string") {
    return {
      paths: result.paths.map((item, index) => text(item, `${field}.paths[${index}]`, 4_096)),
      committedAt: text(result.committedAt, field + ".committedAt", 128),
    };
  }
  throw new TypeError(`Coordinator ${field} is unsupported`);
}

function parseStorageOwnerGrant(value: unknown, field: string): StorageBindingGrant {
  const grant = expectRecord(value, field);
  // owner 数据模型:K-V 或文件根;不能硬编码成 kv,否则 files 声明绑定会被判不匹配。
  const model = enumValue(grant.model, ["kv", "files"] as const, field + ".model");
  // 与 parseStorageDeclaration 一致:files 模型允许空 purposeId(模块根,
  // 例如 p2p/setting.json 或 p2pkh 整个模块共享目录),K-V 仍必须有 purpose。
  const purposeId = model === "files" && grant.purposeId === ""
    ? ""
    : text(grant.purposeId, field + ".purposeId", 63);
  const authority = enumValue(grant.authority, ["built-in-module", "third-party-app"] as const, field + ".authority");
  const common = {
    storageGrantId: text(grant.storageGrantId, field + ".storageGrantId", 256),
    walletGeneration: text(grant.walletGeneration, field + ".walletGeneration", 256),
    runGeneration: text(grant.runGeneration, field + ".runGeneration", 256),
    sessionEpoch: text(grant.sessionEpoch, field + ".sessionEpoch", 256),
  };
  if (authority === "third-party-app") {
    // 第三方 App 授权按「登记 name + 验证身份」定位目录，因此不需要
    // moduleId/purpose 坐标，也不允许携带 model。
    const identity = expectRecord(grant.verifiedAppIdentity, field + ".verifiedAppIdentity");
    return {
      ...common,
      authority,
      appStorageName: text(grant.appStorageName, field + ".appStorageName", 63),
      verifiedAppIdentity: {
        publisherPublicKeyHex: text(identity.publisherPublicKeyHex, field + ".verifiedAppIdentity.publisherPublicKeyHex", 66),
        appId: text(identity.appId, field + ".verifiedAppIdentity.appId", 63),
      },
      model: "files",
      schemaVersion: boundedNumber(grant.schemaVersion, field + ".schemaVersion", 1),
    };
  }
  if (purposeId === "") {
    // 只有 files 模型可以用空 purposeId 表示模块根。
    if (model !== "files") throw new TypeError(`Coordinator ${field}.purposeId is invalid`);
  }
  return {
    ...common,
    moduleId: text(grant.moduleId, field + ".moduleId", 63),
    purposeId,
    authority,
    model,
    schemaVersion: boundedNumber(grant.schemaVersion, field + ".schemaVersion", 1),
  };
}

function parseStoragePlatformGrant(value: unknown, field: string): StoragePlatformGrant {
  const grant = expectRecord(value, field);
  return {
    platformGrantId: text(grant.platformGrantId, field + ".platformGrantId", 256),
    walletGeneration: text(grant.walletGeneration, field + ".walletGeneration", 256),
    runGeneration: text(grant.runGeneration, field + ".runGeneration", 256),
    moduleId: text(grant.moduleId, field + ".moduleId", 63),
    purposeId: text(grant.purposeId, field + ".purposeId", 63),
    authority: enumValue(grant.authority, ["platform-only", "built-in-module"] as const, field + ".authority"),
    model: "kv",
    // 与存储声明一致：schemaVersion（数据结构版本）是从 1 开始的安全整数。
    schemaVersion: boundedNumber(grant.schemaVersion, field + ".schemaVersion", 1),
    sessionEpoch: text(grant.sessionEpoch, field + ".sessionEpoch", 256),
  };
}

function parseMsFileStatEntry(value: unknown, field: string): MsFileStatResult["sources"][number] {
  const source = expectRecord(value, field);
  const sourceId = text(source.sourceId, field + ".sourceId", 96);
  if (!isValidMsFileSourceId(sourceId)) throw new TypeError(`Coordinator ${field}.sourceId is invalid`);
  const sourceKind = enumValue(source.sourceKind, ["local-bitfs", "remote-proxy"] as const, field + ".sourceKind");
  if ((sourceKind === "local-bitfs") !== (sourceId === MSFILE_LOCAL_SOURCE_ID)) throw new TypeError(`Coordinator ${field} source identity is inconsistent`);
  const supplierPublicKeyHex = sourceKind === "remote-proxy"
    ? text(source.supplierPublicKeyHex, field + ".supplierPublicKeyHex", 66)
    : undefined;
  if (supplierPublicKeyHex !== undefined && !isValidMsFileSupplierPublicKeyHex(supplierPublicKeyHex)) throw new TypeError(`Coordinator ${field}.supplierPublicKeyHex is invalid`);
  if (sourceKind === "local-bitfs" && source.supplierPublicKeyHex !== undefined) throw new TypeError(`Coordinator ${field} local source cannot contain supplierPublicKeyHex`);
  const base = sourceKind === "remote-proxy"
    ? { sourceId, sourceKind, supplierPublicKeyHex: supplierPublicKeyHex! }
    : { sourceId: MSFILE_LOCAL_SOURCE_ID, sourceKind };
  const status = enumValue(source.status, ["available", "absent", "discovering", "quoted", "network-error"] as const, field + ".status");
  if (status === "absent" || status === "network-error") return { ...base, status } as MsFileStatResult["sources"][number];
  if (status === "discovering") return { ...base, status, retryAfterMs: boundedNumber(source.retryAfterMs, field + ".retryAfterMs") } as MsFileStatResult["sources"][number];
  const recommendedFilename = text(source.recommendedFilename, field + ".recommendedFilename", 512);
  const fileSizeBytes = parseMsFileSatoshiAmount(source.fileSizeBytes, field + ".fileSizeBytes");
  const mediaType = text(source.mediaType, field + ".mediaType", 256);
  if (status === "available") return { ...base, status, recommendedFilename, fileSizeBytes, mediaType } as MsFileStatResult["sources"][number];
  return {
    ...base,
    status,
    recommendedFilename,
    fileSizeBytes,
    mediaType,
    minSeedPriceSatoshis: parseMsFileSatoshiAmount(source.minSeedPriceSatoshis, field + ".minSeedPriceSatoshis"),
    maxSeedPriceSatoshis: parseMsFileSatoshiAmount(source.maxSeedPriceSatoshis, field + ".maxSeedPriceSatoshis"),
    minFullBlockPriceSatoshis: parseMsFileSatoshiAmount(source.minFullBlockPriceSatoshis, field + ".minFullBlockPriceSatoshis"),
    maxFullBlockPriceSatoshis: parseMsFileSatoshiAmount(source.maxFullBlockPriceSatoshis, field + ".maxFullBlockPriceSatoshis"),
  } as MsFileStatResult["sources"][number];
}

function parseMsFileStatResult(value: unknown, field: string): MsFileStatResult {
  const result = expectRecord(value, field);
  if (!Array.isArray(result.sources) || result.sources.length > 256) throw new TypeError(`Coordinator ${field}.sources is invalid`);
  return {
    seedHashHex: text(result.seedHashHex, field + ".seedHashHex", 64),
    sources: result.sources.map((item, index) => parseMsFileStatEntry(item, `${field}.sources[${index}]`)),
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
    sellerSettings: parseMsFileSellerSettings(result.sellerSettings, field + ".sellerSettings"),
    sellerRuntimeStatus: enumValue(result.sellerRuntimeStatus, ["disabled", "waiting-unlock", "waiting-dependency", "indexing", "configuration-error", "ready", "selling", "degraded"] as const, field + ".sellerRuntimeStatus"),
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
  if ("sources" in result) return parseMsFileStatResult(result, field);
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
  const binding = submission.utxoBinding === undefined ? undefined : expectRecord(submission.utxoBinding, field + ".utxoBinding");
  const utxoBinding = binding === undefined ? undefined : {
    resourceId: text(binding.resourceId, field + ".utxoBinding.resourceId", 256),
    seq: boundedNumber(binding.seq, field + ".utxoBinding.seq", 1),
  };
  return {
    resourceId: text(submission.resourceId, field + ".resourceId", 256),
    txid: txid.toLowerCase(),
    rawTxHex: rawTxHex.toLowerCase(),
    ...(utxoBinding === undefined ? {} : { utxoBinding }),
  };
}

function parseP2pkhBroadcastResult(value: unknown, field: string): CoordinatorP2pkhBroadcastResult {
  const result = expectRecord(value, field);
  const status = text(result.status, field + ".status", 64);
  const providerId = optionalText(result.providerId, field + ".providerId", 256);
  if (status === "not-dispatched") {
    const currentSeq = optionalBoundedNumber(result.currentSeq, field + ".currentSeq", 1);
    return {
      status,
      reason: enumValue(result.reason, ["stale-provider-generation", "broadcast-provider-unavailable", "coordinator-not-dispatched", "stale-session-epoch", "snapshot-stale", "snapshot-consumed", "snapshot-binding-required", "snapshot-input-invalid"] as const, field + ".reason"),
      ...(currentSeq === undefined ? {} : { currentSeq }),
    };
  }
  if (status === "accepted" || status === "already-known") {
    return {
      status,
      canonicalTxid: text(result.canonicalTxid, field + ".canonicalTxid", 128),
      ...(result.providerReturnedTxidRaw === undefined ? {} : { providerReturnedTxidRaw: text(result.providerReturnedTxidRaw, field + ".providerReturnedTxidRaw", 128) }),
      ...(result.providerReturnedTxidNormalized === undefined ? {} : { providerReturnedTxidNormalized: text(result.providerReturnedTxidNormalized, field + ".providerReturnedTxidNormalized", 128) }),
      ...(result.txidIntegrity === undefined ? {} : { txidIntegrity: enumValue(result.txidIntegrity, ["exact", "reversed", "mismatch", "missing"] as const, field + ".txidIntegrity") }),
      ...(providerId === undefined ? {} : { providerId }),
      ...(result.providerReference === undefined ? {} : { providerReference: text(result.providerReference, field + ".providerReference", 512) }),
      ...(result.providerCode === undefined ? {} : { providerCode: text(result.providerCode, field + ".providerCode", 256) }),
      ...(result.providerMessage === undefined ? {} : { providerMessage: text(result.providerMessage, field + ".providerMessage", 4_096) }),
    };
  }
  const txid = text(result.txid, field + ".txid", 128);
  // reason 只属于 isolated；local-confirmed 成功响应没有 reason，不能先解析它，
  // 否则合法成功会被误判成“reason is invalid”。
  if (status === "isolated") return {
    status,
    txid,
    reason: text(result.reason, field + ".reason", 4_096),
    ...(result.canonicalTxid === undefined ? {} : { canonicalTxid: text(result.canonicalTxid, field + ".canonicalTxid", 128) }),
    ...(result.providerReturnedTxidRaw === undefined ? {} : { providerReturnedTxidRaw: text(result.providerReturnedTxidRaw, field + ".providerReturnedTxidRaw", 128) }),
    ...(result.providerReturnedTxidNormalized === undefined ? {} : { providerReturnedTxidNormalized: text(result.providerReturnedTxidNormalized, field + ".providerReturnedTxidNormalized", 128) }),
    ...(result.txidIntegrity === undefined ? {} : { txidIntegrity: enumValue(result.txidIntegrity, ["exact", "reversed", "mismatch", "missing"] as const, field + ".txidIntegrity") }),
    ...(providerId === undefined ? {} : { providerId }),
  };
  if (status === "local-confirmed") return {
    status,
    txid,
    ...(result.canonicalTxid === undefined ? {} : { canonicalTxid: text(result.canonicalTxid, field + ".canonicalTxid", 128) }),
    ...(result.providerReturnedTxidRaw === undefined ? {} : { providerReturnedTxidRaw: text(result.providerReturnedTxidRaw, field + ".providerReturnedTxidRaw", 128) }),
    ...(result.providerReturnedTxidNormalized === undefined ? {} : { providerReturnedTxidNormalized: text(result.providerReturnedTxidNormalized, field + ".providerReturnedTxidNormalized", 128) }),
    ...(result.txidIntegrity === undefined ? {} : { txidIntegrity: enumValue(result.txidIntegrity, ["exact", "reversed", "mismatch", "missing"] as const, field + ".txidIntegrity") }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(result.providerReference === undefined ? {} : { providerReference: text(result.providerReference, field + ".providerReference", 512) }),
    ...(result.providerCode === undefined ? {} : { providerCode: text(result.providerCode, field + ".providerCode", 256) }),
    ...(result.providerMessage === undefined ? {} : { providerMessage: text(result.providerMessage, field + ".providerMessage", 4_096) }),
  };
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
    case "getCurrentKey":
      return value === undefined ? undefined : parseCoordinatorVaultKeyView(value, field);
    case "verifyPassword":
    case "changePassword":
    case "renameKey":
      return parseTrueResult(value, field);
    case "exportKeyHold":
      return uint8ArrayValue(value, field);
    case "sealLocalSecret":
      return parseVaultSealedSecret(value, field);
    case "openLocalSecret":
      return uint8ArrayValue(value, field);
  }
}

function parseStorageRuntimeStatus(value: unknown, field: string): StorageRuntimeControllerStatus {
  return enumValue(value, ["uninitialized", "locked", "ready", "degraded", "corrupt", "unsupported"] as const, field);
}

function parseStorageControlResultFor(control: CoordinatorStorageControl, value: unknown, field: string): unknown {
  switch (control.type) {
    case "status":
      return parseStorageRuntimeStatus(value, field);
    case "summary":
      return value === null ? null : parseStorageRuntimeSummary(value, field);
    case "cold-start":
      return parseWalletColdStartSnapshot(value, field);
    case "initialize":
      return parseWalletInitializeResult(value, field);
    case "unlock":
      return parseWalletUnlockResult(value, field);
    case "lock":
    case "change-key-password":
    case "rename-key":
      return parseTrueResult(value, field);
    case "export-key-hold":
      return uint8ArrayValue(value, field);
    case "reset-wallet": {
      const result = expectRecord(value, field);
      return {
        walletGeneration: text(result.walletGeneration, field + ".walletGeneration", 256),
        clearedAt: text(result.clearedAt, field + ".clearedAt", 128),
      };
    }
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
    case "batch": {
      const result = expectRecord(value, field);
      if (!Array.isArray(result.paths) || result.paths.length > 1_000) throw new TypeError(`Coordinator ${field}.paths is invalid`);
      return {
        paths: result.paths.map((item, index) => text(item, `${field}.paths[${index}]`, 4_096)),
        committedAt: text(result.committedAt, field + ".committedAt", 128),
      };
    }
  }
}

function parseMsFileControlResultFor(control: CoordinatorMsFileControl, value: unknown, field: string): unknown {
  switch (control.type) {
    case "settings.get": return parseMsFileSettingsSnapshot(value, field);
    case "settings.bitfsBuyer.get": return parseMsFileBitfsBuyerSettings(value, field);
    case "settings.readConcurrency.get": return parseMsFileReadConcurrency(value);
    case "settings.mediaBlockReadConcurrency.get": return boundedNumber(value, field, 1, 16);
    case "bitfs.demand.publish":
    case "bitfs.demand.snapshot":
    case "bitfs.purchase.start":
    case "bitfs.purchase.cancel": return parseMsFileBitfsDemandSnapshot(value, field);
    case "bitfs.purchase.tasks.list": {
      if (!Array.isArray(value) || value.length > 1_000) throw new TypeError(`Coordinator ${field} must be a bounded array`);
      return value.map((item, index) => parseMsFileBitfsTaskSnapshot(item, `${field}[${index}]`));
    }
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
    case "settings.seller.update":
    case "settings.bitfsBuyer.update":
    case "bitfs.buyerPriceLimit.update":
    case "bitfs.demand.cancel":
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

function parseMsFileBitfsQuoteView(value: unknown, field: string): MsFileBitfsQuoteView {
  const quote = expectRecord(value, field);
  const sessionId = text(quote.sessionId, `${field}.sessionId`, 128);
  if (!/^[0-9a-z][0-9a-z._-]{0,127}$/u.test(sessionId)) throw new TypeError(`Coordinator ${field}.sessionId is invalid`);
  const seedHashHex = text(quote.seedHashHex, `${field}.seedHashHex`, 64);
  if (!isValidMsFileHashHex(seedHashHex)) throw new TypeError(`Coordinator ${field}.seedHashHex is invalid`);
  const sellerPublicKeyHex = text(quote.sellerPublicKeyHex, `${field}.sellerPublicKeyHex`, 66);
  if (!isValidMsFileSupplierPublicKeyHex(sellerPublicKeyHex)) throw new TypeError(`Coordinator ${field}.sellerPublicKeyHex is invalid`);
  if (!Array.isArray(quote.supportedArbiterPublicKeys) || quote.supportedArbiterPublicKeys.length > 64) {
    throw new TypeError(`Coordinator ${field}.supportedArbiterPublicKeys is invalid`);
  }
  const supportedArbiterPublicKeys = quote.supportedArbiterPublicKeys.map((item, index) => {
    const publicKeyHex = text(item, `${field}.supportedArbiterPublicKeys[${index}]`, 66);
    if (!isValidMsFileSupplierPublicKeyHex(publicKeyHex)) throw new TypeError(`Coordinator ${field}.supportedArbiterPublicKeys[${index}] is invalid`);
    return publicKeyHex;
  });
  const quoteExpiresAtUnixSeconds = text(quote.quoteExpiresAtUnixSeconds, `${field}.quoteExpiresAtUnixSeconds`, 20);
  if (!/^[1-9][0-9]*$/u.test(quoteExpiresAtUnixSeconds)) throw new TypeError(`Coordinator ${field}.quoteExpiresAtUnixSeconds is invalid`);
  const recentBytesPerSecond = quote.recentBytesPerSecond === undefined
    ? undefined
    : quote.recentBytesPerSecond === null
      ? null
      : parseMsFileSatoshiAmount(quote.recentBytesPerSecond, `${field}.recentBytesPerSecond`);
  return {
    sessionId,
    seedHashHex,
    fileSizeBytes: parseMsFileSatoshiAmount(quote.fileSizeBytes, `${field}.fileSizeBytes`),
    sellerPublicKeyHex,
    seedPriceSatoshis: parseMsFileSatoshiAmount(quote.seedPriceSatoshis, `${field}.seedPriceSatoshis`),
    fullBlockPriceSatoshis: parseMsFileSatoshiAmount(quote.fullBlockPriceSatoshis, `${field}.fullBlockPriceSatoshis`),
    quoteExpiresAtUnixSeconds,
    recommendedFilename: text(quote.recommendedFilename, `${field}.recommendedFilename`, 512),
    supportedArbiterPublicKeys,
    ...(recentBytesPerSecond === undefined ? {} : { recentBytesPerSecond }),
  };
}

function parseMsFileBitfsPurchaseSnapshot(value: unknown, field: string): MsFileBitfsPurchaseSnapshot {
  const purchase = expectRecord(value, field);
  const sessionId = text(purchase.sessionId, `${field}.sessionId`, 128);
  if (!/^[0-9a-z][0-9a-z._-]{0,127}$/u.test(sessionId)) throw new TypeError(`Coordinator ${field}.sessionId is invalid`);
  const openingAmountSatoshis = purchase.openingAmountSatoshis === null
    ? null
    : parseMsFileSatoshiAmount(purchase.openingAmountSatoshis, `${field}.openingAmountSatoshis`);
  const currentMaxFullBlockPriceSatoshis = purchase.currentMaxFullBlockPriceSatoshis === undefined
    ? undefined
    : purchase.currentMaxFullBlockPriceSatoshis === null
      ? null
      : parseMsFileSatoshiAmount(purchase.currentMaxFullBlockPriceSatoshis, `${field}.currentMaxFullBlockPriceSatoshis`);
  const totalBlockCount = purchase.totalBlockCount === null
    ? null
    : boundedNumber(purchase.totalBlockCount, `${field}.totalBlockCount`, 0);
  const verifiedBytes = purchase.verifiedBytes === undefined
    ? undefined
    : purchase.verifiedBytes === null
      ? null
      : parseMsFileSatoshiAmount(purchase.verifiedBytes, `${field}.verifiedBytes`);
  const message = purchase.message === null ? null : text(purchase.message, `${field}.message`, 512);
  return {
    sessionId,
    phase: enumValue(purchase.phase, [
      "discovering", "opening", "cancelling-opening", "funding", "funding-unknown", "requesting-seed", "requesting-blocks",
      "payment-unknown", "content-committing", "closing-pool", "close-unknown", "cancelling-pool", "cancel-unknown", "cancelled",
      "refund-ready", "refund-unknown", "refunded",
      "completed", "failed", "connection-closed",
    ] as const, `${field}.phase`),
    openingAmountSatoshis,
    ...(currentMaxFullBlockPriceSatoshis === undefined ? {} : { currentMaxFullBlockPriceSatoshis }),
    verifiedBlockCount: boundedNumber(purchase.verifiedBlockCount, `${field}.verifiedBlockCount`, 0),
    ...(verifiedBytes === undefined ? {} : { verifiedBytes }),
    totalBlockCount,
    message,
  };
}

function parseMsFileBitfsTaskSnapshot(value: unknown, field: string): MsFileBitfsTaskSnapshot {
  const row = expectRecord(value, field);
  const progress = parseMsFileBitfsPurchaseSnapshot(row, field);
  const seedHashHex = text(row.seedHashHex, `${field}.seedHashHex`, 64);
  const discoveryOnly = row.discoveryOnly === undefined ? false : booleanValue(row.discoveryOnly, `${field}.discoveryOnly`);
  const sellerPublicKeyHex = row.sellerPublicKeyHex === null
    ? null
    : text(row.sellerPublicKeyHex, `${field}.sellerPublicKeyHex`, 66);
  if (!isValidMsFileHashHex(seedHashHex)
    || (sellerPublicKeyHex !== null && !isValidMsFileSupplierPublicKeyHex(sellerPublicKeyHex))
    || (!discoveryOnly && sellerPublicKeyHex === null)) {
    throw new TypeError(`Coordinator ${field} identity is invalid`);
  }
  const recommendedFilename = row.recommendedFilename === null
    ? null
    : text(row.recommendedFilename, `${field}.recommendedFilename`, 512);
  const fileSizeBytes = row.fileSizeBytes === null ? null : parseMsFileSatoshiAmount(row.fileSizeBytes, `${field}.fileSizeBytes`);
  const verifiedBytes = row.verifiedBytes === null || row.verifiedBytes === undefined
    ? null
    : parseMsFileSatoshiAmount(row.verifiedBytes, `${field}.verifiedBytes`);
  const fullBlockPriceSatoshis = row.fullBlockPriceSatoshis === null
    ? null
    : parseMsFileSatoshiAmount(row.fullBlockPriceSatoshis, `${field}.fullBlockPriceSatoshis`);
  const availableQuotes = row.availableQuotes === undefined
    ? []
    : (() => {
      if (!Array.isArray(row.availableQuotes) || row.availableQuotes.length > 256) throw new TypeError(`Coordinator ${field}.availableQuotes is invalid`);
      return row.availableQuotes.map((item, index) => parseMsFileBitfsQuoteView(item, `${field}.availableQuotes[${index}]`));
    })();
  const canCancel = row.canCancel === undefined ? undefined : booleanValue(row.canCancel, `${field}.canCancel`);
  const canReconnect = row.canReconnect === undefined ? undefined : booleanValue(row.canReconnect, `${field}.canReconnect`);
  return {
    ...progress,
    seedHashHex,
    sellerPublicKeyHex,
    recommendedFilename,
    fileSizeBytes,
    verifiedBytes,
    fullBlockPriceSatoshis,
    paidSatoshis: parseMsFileSatoshiAmount(row.paidSatoshis, `${field}.paidSatoshis`),
    minerFeeSatoshis: parseMsFileSatoshiAmount(row.minerFeeSatoshis, `${field}.minerFeeSatoshis`),
    lockedSatoshis: parseMsFileSatoshiAmount(row.lockedSatoshis, `${field}.lockedSatoshis`),
    pendingReturnSatoshis: parseMsFileSatoshiAmount(row.pendingReturnSatoshis, `${field}.pendingReturnSatoshis`),
    ...(row.discoveryOnly === undefined ? {} : { discoveryOnly }),
    availableQuotes,
    ...(canCancel === undefined ? {} : { canCancel }),
    ...(canReconnect === undefined ? {} : { canReconnect }),
  };
}

function parseMsFileBitfsDemandSnapshot(value: unknown, field: string): MsFileBitfsDemandSnapshot {
  const snapshot = expectRecord(value, field);
  if (!Array.isArray(snapshot.quotes) || snapshot.quotes.length > 256) throw new TypeError(`Coordinator ${field}.quotes is invalid`);
  const requestMessageId = snapshot.requestMessageId === null ? null : text(snapshot.requestMessageId, `${field}.requestMessageId`, 256);
  const expiresAtMs = snapshot.expiresAtMs === null ? null : boundedNumber(snapshot.expiresAtMs, `${field}.expiresAtMs`, 0);
  const purchase: MsFileBitfsPurchaseSnapshot | null | undefined = snapshot.purchase === undefined
    ? undefined
    : snapshot.purchase === null
      ? null
      : parseMsFileBitfsPurchaseSnapshot(snapshot.purchase, `${field}.purchase`);
  const currentMaxFullBlockPriceSatoshis = snapshot.currentMaxFullBlockPriceSatoshis === undefined
    ? undefined
    : snapshot.currentMaxFullBlockPriceSatoshis === null
      ? null
      : parseMsFileSatoshiAmount(snapshot.currentMaxFullBlockPriceSatoshis, `${field}.currentMaxFullBlockPriceSatoshis`);
  const seedHashHex = text(snapshot.seedHashHex, `${field}.seedHashHex`, 64);
  if (!isValidMsFileHashHex(seedHashHex)) throw new TypeError(`Coordinator ${field}.seedHashHex is invalid`);
  return {
    seedHashHex,
    requestMessageId,
    expiresAtMs,
    quotes: snapshot.quotes.map((item, index) => parseMsFileBitfsQuoteView(item, `${field}.quotes[${index}]`)),
    ...(purchase === undefined ? {} : { purchase }),
    ...(currentMaxFullBlockPriceSatoshis === undefined ? {} : { currentMaxFullBlockPriceSatoshis }),
  };
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

function parseOwnerFileEntry(value: unknown, field: string): import("./storage/files.js").ModuleFileListEntry {
  const entry = expectRecord(value, field);
  return {
    path: text(entry.path, field + ".path", 4_096),
    size: boundedNumber(entry.size, field + ".size"),
    revision: text(entry.revision, field + ".revision", 1_024),
    lastModified: text(entry.lastModified, field + ".lastModified", 128),
  };
}

function parseOwnerFileListPage(value: unknown, field: string): import("./storage/files.js").ModuleFileListPage {
  const page = expectRecord(value, field);
  if (!Array.isArray(page.files)) throw new TypeError(`Coordinator ${field}.files is invalid`);
  return {
    files: page.files.map((entry, index) => parseOwnerFileEntry(entry, `${field}.files[${index}]`)),
    ...(page.nextCursor === undefined ? {} : { nextCursor: text(page.nextCursor, field + ".nextCursor", 8_192) }),
  };
}

function parseOwnerFileObject(value: unknown, field: string): import("./storage/files.js").ModuleFileObject {
  const object = expectRecord(value, field);
  if (!(object.bytes instanceof Uint8Array)) throw new TypeError(`Coordinator ${field}.bytes is invalid`);
  return {
    path: text(object.path, field + ".path", 4_096),
    bytes: object.bytes.slice(),
    revision: text(object.revision, field + ".revision", 1_024),
    lastModified: text(object.lastModified, field + ".lastModified", 128),
  };
}

function parseOwnerFileWriteResult(value: unknown, field: string): { revision: string; lastModified: string } {
  const result = value === undefined ? {} : expectRecord(value, field);
  return {
    revision: text(result.revision, field + ".revision", 1_024),
    lastModified: text(result.lastModified, field + ".lastModified", 128),
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
    case "owner.file-range": return value === undefined ? undefined : parseOwnerFileObject(value, field);
    case "owner.file-put": return parseOwnerFileWriteResult(value, field);
    case "owner.file-delete": return parseUndefinedResult(value, field);
    case "owner.file-batch": {
      const result = expectRecord(value, field);
      if (!Array.isArray(result.paths) || typeof result.committedAt !== "string") {
        throw new TypeError(`Coordinator ${field} is invalid`);
      }
      return {
        paths: result.paths.map((path, index) => text(path, `${field}.paths[${index}]`, 4_096)),
        committedAt: text(result.committedAt, field + ".committedAt", 128),
      };
    }
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
    case "crypto":
    case "background.run-now":
    case "background.trigger":
    case "background.cancel":
    case "background.cancel-by-key":
    case "background.settings.update":
    case "autolock.settings.update":
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
    case "plugin.intent": case "worker.units": case "chain.height":
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
  const autoLockTimeoutMs = parseAutoLockTimeoutMsField(event.autoLockTimeoutMs, "event.autoLockTimeoutMs");
  const walletGeneration = optionalText(event.walletGeneration, "event.walletGeneration", 256);
  return {
    topic: "session.state",
    type: "session.state.changed",
    sessionRevision: boundedNumber(event.sessionRevision, "event.sessionRevision"),
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    runGeneration: text(event.runGeneration, "event.runGeneration", 256),
    ...(walletGeneration === undefined ? {} : { walletGeneration }),
    cause: enumValue(event.cause, ["bootstrap", "initialize", "unlock", "lock", "change-password", "rename-key", "reset-wallet", "autolock-settings"] as const, "event.cause"),
    vaultStatus: enumValue(event.vaultStatus, ["booting", "uninitialized", "locked", "unlocked", "fatal"] as const, "event.vaultStatus"),
    activePublicKeyHex: nullableText(event.activePublicKeyHex, "event.activePublicKeyHex", 256),
    ...(autoLockTimeoutMs === undefined ? {} : { autoLockTimeoutMs }),
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
  const p2pkhSettings = event.p2pkhSettings === undefined
    ? undefined
    : (() => {
      const settings = expectRecord(event.p2pkhSettings, "event.p2pkhSettings");
      return { includeTestnet: booleanValue(settings.includeTestnet, "event.p2pkhSettings.includeTestnet") };
    })();
  return {
    topic: "background.snapshot",
    type: "background.snapshot.changed",
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    backgroundSnapshotRevision: boundedNumber(event.backgroundSnapshotRevision, "event.backgroundSnapshotRevision"),
    snapshots: event.snapshots.map((snapshot, index) => parseTaskSnapshot(snapshot, `event.snapshots[${index}]`)),
    ...(scheduleSettings === undefined ? {} : { scheduleSettings }),
    ...(p2pkhSettings === undefined ? {} : { p2pkhSettings }),
  };
}

function parseAssetKinds(value: unknown, field: string): AssetDataChangedEvent["kinds"] {
  if (!Array.isArray(value) || value.length > 16) throw new TypeError(`Coordinator ${field} is invalid`);
  return value.map((kind, index) => enumValue(kind, ["resource", "utxo", "history", "holding", "claim", "submission", "settings", "protocol-snapshot", "balance"] as const, `${field}[${index}]`));
}

function parseAssetDataChangedEvent(value: unknown): AssetDataChangedEvent {
  const event = topicEnvelope(value, "asset.data-changed", "asset.data-changed");
  const rawSeqs = event.utxoSeqs === undefined ? undefined : expectRecord(event.utxoSeqs, "event.utxoSeqs");
  const utxoSeqs = rawSeqs === undefined ? undefined : {
    ...(rawSeqs.main === undefined ? {} : { main: boundedNumber(rawSeqs.main, "event.utxoSeqs.main", 1) }),
    ...(rawSeqs.test === undefined ? {} : { test: boundedNumber(rawSeqs.test, "event.utxoSeqs.test", 1) }),
  };
  return {
    topic: "asset.data-changed",
    type: "asset.data-changed",
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    providerId: text(event.providerId, "event.providerId", 256),
    publicKeyHex: text(event.publicKeyHex, "event.publicKeyHex", 256),
    assetDataRevision: boundedNumber(event.assetDataRevision, "event.assetDataRevision"),
    kinds: parseAssetKinds(event.kinds, "event.kinds"),
    ...(utxoSeqs === undefined ? {} : { utxoSeqs }),
  };
}

function parseStorageStateEvent(value: unknown): CoordinatorStorageStateEvent {
  const event = topicEnvelope(value, "storage.state", "storage.state.changed");
  const authorityRecovery = event.authorityRecovery === undefined ? undefined : parseAuthorityRecovery(event.authorityRecovery, "event.authorityRecovery");
  const summary = event.summary === null ? null : parseStorageRuntimeSummary(event.summary, "event.summary");
  const walletGeneration = optionalText(event.walletGeneration, "event.walletGeneration", 256);
  return {
    topic: "storage.state",
    type: "storage.state.changed",
    storageRevision: boundedNumber(event.storageRevision, "event.storageRevision"),
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    status: enumValue(event.status, ["uninitialized", "locked", "ready", "degraded", "corrupt", "unsupported"] as const, "event.status"),
    ...(walletGeneration === undefined ? {} : { walletGeneration }),
    ...(authorityRecovery === undefined ? {} : { authorityRecovery }),
    summary,
  };
}

function parseP2pkhUtxoSnapshotResult(value: unknown, field: string): P2pkhUtxoSnapshotResult {
  const snapshot = expectRecord(value, field);
  if (typeof snapshot.available !== "boolean") throw new TypeError(`Coordinator ${field}.available is invalid`);
  if (snapshot.items !== undefined && (!Array.isArray(snapshot.items) || snapshot.items.length > 100_000)) throw new TypeError(`Coordinator ${field}.items is invalid`);
  if (snapshot.syncedAt !== undefined && typeof snapshot.syncedAt !== "string") throw new TypeError(`Coordinator ${field}.syncedAt is invalid`);
  const seq = optionalBoundedNumber(snapshot.seq, field + ".seq", 1);
  const state = snapshot.state === undefined
    ? (snapshot.available ? "fresh" : "unavailable")
    : enumValue(snapshot.state, ["fresh", "consumed", "unavailable"] as const, field + ".state");
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
    ...(seq === undefined ? {} : { seq }),
    state,
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
    sellerSettings: parseMsFileSellerSettings(event.sellerSettings, "event.sellerSettings"),
    sellerRuntimeStatus: enumValue(event.sellerRuntimeStatus, ["disabled", "waiting-unlock", "waiting-dependency", "indexing", "configuration-error", "ready", "selling", "degraded"] as const, "event.sellerRuntimeStatus"),
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

function parseChainHeightEvent(value: unknown): CoordinatorChainHeightEvent {
  const event = topicEnvelope(value, "chain.height", "chain.height.changed");
  const chainHeight = expectRecord(event.chainHeight, "event.chainHeight");
  const network = enumValue(chainHeight.network, ["main", "test"] as const, "event.chainHeight.network");
  const available = booleanValue(chainHeight.available, "event.chainHeight.available");
  // 链高度是不透明的非负整数；boundedNumber 已保证 >= 0 且落在安全整数范围内。
  const height = boundedNumber(chainHeight.height, "event.chainHeight.height");
  const updatedAtMs = chainHeight.updatedAtMs === undefined
    ? undefined
    : boundedNumber(chainHeight.updatedAtMs, "event.chainHeight.updatedAtMs");
  if (available && updatedAtMs === undefined) {
    throw new TypeError("Coordinator event.chainHeight.updatedAtMs is required when available");
  }
  return {
    topic: "chain.height",
    type: "chain.height.changed",
    chainHeightRevision: boundedNumber(event.chainHeightRevision, "event.chainHeightRevision"),
    sessionEpoch: text(event.sessionEpoch, "event.sessionEpoch", 256),
    chainHeight: {
      height,
      network,
      available,
      ...(updatedAtMs === undefined ? {} : { updatedAtMs }),
      revision: boundedNumber(chainHeight.revision, "event.chainHeight.revision"),
    },
  };
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

const COORDINATOR_UNIT_UNAVAILABLE_CODES = [
  "plugin-disabled",
  "dependency-disabled",
  "dependency-not-ready",
  "storage-root-unavailable",
  "owner-session-unavailable",
  "unit-not-ready",
  "unit-unknown",
] as const satisfies readonly CoordinatorUnitUnavailableCode[];

function parseUnitUnavailableReason(value: unknown, field: string): CoordinatorUnitUnavailableReason {
  const input = expectRecord(value, field);
  const dependencyId = optionalText(input.dependencyId, field + ".dependencyId", 256);
  return {
    code: enumValue(input.code, COORDINATOR_UNIT_UNAVAILABLE_CODES, field + ".code"),
    text: parseI18nText(input.text, field + ".text"),
    ...(dependencyId === undefined ? {} : { dependencyId }),
  };
}

function parseWorkerUnitSnapshot(value: unknown, field: string): CoordinatorWorkerUnitPublicSnapshot {
  const unit = expectRecord(value, field);
  const ownerPublicKeyHex = optionalText(unit.ownerPublicKeyHex, field + ".ownerPublicKeyHex", 256);
  const sessionEpoch = optionalText(unit.sessionEpoch, field + ".sessionEpoch", 256);
  const error = optionalText(unit.error, field + ".error", 4_096);
  const instanceId = optionalText(unit.instanceId, field + ".instanceId", 256);
  if (unit.runtime !== "shared-worker") throw new TypeError(`Coordinator ${field}.runtime is invalid`);
  if (!Array.isArray(unit.reasons) || unit.reasons.length > 64) throw new TypeError(`Coordinator ${field}.reasons are invalid`);
  return {
    productId: text(unit.productId, field + ".productId", 256),
    unitId: text(unit.unitId, field + ".unitId", 256),
    runtime: "shared-worker",
    scopeKind: enumValue(unit.scopeKind, ["root", "storage", "owner-session", "connect-session"] as const, field + ".scopeKind") as KeymasterScopeKind,
    // 从未启动过的单元没有实例标识（见 CoordinatorWorkerUnitPublicSnapshot 说明），
    // 因此这里允许缺省，而不是要求必填。
    ...(instanceId === undefined ? {} : { instanceId }),
    state: enumValue(unit.state, ["ready", "failed"] as const, field + ".state"),
    dependsOn: stringList(unit.dependsOn, field + ".dependsOn", 64, 64),
    reasons: unit.reasons.map((reason, index) => parseUnitUnavailableReason(reason, `${field}.reasons[${index}]`)),
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
    case "chain.height": return parseChainHeightEvent(value);
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
