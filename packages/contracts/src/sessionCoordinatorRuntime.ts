// Trusted Window/Worker DTOs. WebLoom requires parser hooks; here they project
// transport/public data only. Domain validation belongs to external ingress,
// persistence recovery and the operation's business implementation.
import { defineCapability } from "webloom-framework";
import type {
  CoordinatorClientRequest, CoordinatorCommandAck, CoordinatorCryptoOperation, CoordinatorCryptoResult,
  CoordinatorResponse, CoordinatorTopic, CoordinatorTopicEvent, CoordinatorSessionOpenResult,
  CoordinatorVaultOperation, CoordinatorStorageControl, CoordinatorStorageData,
  CoordinatorMsFileControl, CoordinatorMsFileData, CoordinatorChannelOperation,
  P2pkhProviderConfig, SessionEpoch, WindowP2pExecutorLease, WindowP2pExecutorTransferResult, WindowP2pIdentitySignResult,
} from "./sessionCoordinator.js";
import type { ChannelPublishResult, ChannelSubscriptionSetResult, OpenedPrivateEnvelope } from "./channel.js";
import type { KeyRef, VaultSealedSecret } from "./vault.js";
import type { StorageBindingGrant, StoragePlatformGrant, CoordinatorOwnerStorageData, CoordinatorPlatformStorageData } from "./storage/internal.js";
import type { StorageRuntimeControllerStatus, StorageRuntimeSummary } from "./storage/runtime.js";
import type { WalletColdStartSnapshot, WalletInitializeResult, WalletUnlockResult } from "./storage/wallet.js";
import type { StorageListResult, StorageDirectoryResult, StoragePutResult, StorageGetResult, StorageDeleteResult } from "./connectStorage.js";
import type { KeyValueEntry, KeyValueEntryMeta, KeyValueListResult, KeyValueCommitResult } from "./storage/kv.js";
import type {
  MsFileSettingsSnapshot, MsFileBitfsBuyerSettings, MsFileReadConcurrencySettings, MsFileBitfsDemandSnapshot,
  MsFileArbitrationTask, MsFileDemandMonitorSnapshot, MsFileBitfsTaskSnapshot, MsFileBitfsFundingPoolSnapshot,
  MsFileSupplierProbeResult, MsFileAppAuthorizationView, MsFileServiceStatus, MsFileStatResult, MsFileReadResult,
} from "./msfile.js";
import type { CoordinatorMsFileStateEvent } from "./sessionCoordinator.js";
import type { CoordinatorSatOperation, SatSubscriptionSettingsSnapshot, SatBillingPage, SatSpiInformation, SatTopUpPreview, SatTopUpResult, SatCollectResult } from "./satSubscription.js";
import type { P2pkhBroadcastResult, P2pkhUtxoSnapshotResult, P2pkhTransferPreviewPayload, P2pkhTransferResultPayload, P2pkhArtifactOccupyResult } from "./bsvP2pkhProviders.js";
import { projectP2pkhConclusionResult, projectP2pkhPaymentLookupResult, type P2pkhConclusionResult, type P2pkhPaymentLookupResult } from "./p2pkhConclusion.js";
import type { P2pkhProtocolCommandResult } from "./protocolSpendRpc.js";

export interface CoordinatorSessionOpenRequest { kind: "session.open"; leaseId: string; }
export interface CoordinatorSessionCloseRequest { kind: "session.close"; peerGeneration: number; sessionEpoch: string; leaseId: string; }
export interface CoordinatorSessionActivityRequest { kind: "session.activity"; }
export type CoordinatorClientCommandRequest = Exclude<CoordinatorClientRequest, { kind: "hello" | "subscribe" | "activity" | "disconnect" }>;
export type CoordinatorRpcRequestFromClient<R extends CoordinatorClientCommandRequest> = R extends CoordinatorClientCommandRequest ? Omit<R, "clientId" | "requestId"> : never;
export type CoordinatorRpcRequest = CoordinatorSessionOpenRequest | CoordinatorSessionCloseRequest | CoordinatorSessionActivityRequest | CoordinatorRpcRequestFromClient<CoordinatorClientCommandRequest>;
export type CoordinatorRpcCommandRequest = Exclude<CoordinatorRpcRequest, { kind: "session.open" | "session.close" | "session.activity" }>;
export type CoordinatorRpcRequestKind = CoordinatorRpcRequest["kind"];
export type CoordinatorRpcRequestFor<K extends CoordinatorRpcRequestKind> = Extract<CoordinatorRpcRequest, { kind: K }>;
export type CoordinatorRpcResponse = Omit<CoordinatorResponse, "requestId">;
export interface CoordinatorTopicSubscription { topics: CoordinatorTopic[]; }

/** Public key metadata, never private material or a persisted key document. */
export type CoordinatorVaultKeyView = Pick<KeyRef, "bsvNetwork" | "publicKeyHex" | "label" | "capabilities" | "createdAt"> & { address?: string; format: string; source?: string };
export type CoordinatorVaultOperationResultFor<O extends CoordinatorVaultOperation> =
  O extends { type: "getCurrentKey" } ? CoordinatorVaultKeyView | undefined :
  O extends { type: "verifyPassword" | "changePassword" | "renameKey" } ? true :
  O extends { type: "exportKeyHold" | "openLocalSecret" } ? Uint8Array :
  O extends { type: "sealLocalSecret" } ? VaultSealedSecret : never;
export type CoordinatorVaultOperationResult = boolean | string | Uint8Array | undefined | VaultSealedSecret | CoordinatorVaultKeyView | CoordinatorVaultKeyView[] | { intentId: string; publicKeyHex: string };
export type CoordinatorStorageControlResultFor<C extends CoordinatorStorageControl> =
  C extends { type: "status" } ? StorageRuntimeControllerStatus : C extends { type: "summary" } ? StorageRuntimeSummary | null :
  C extends { type: "cold-start" } ? WalletColdStartSnapshot : C extends { type: "initialize" } ? WalletInitializeResult :
  C extends { type: "unlock" } ? WalletUnlockResult : C extends { type: "lock" | "change-key-password" | "rename-key" | "export-key-hold" } ? true :
  C extends { type: "reset-wallet" } ? { walletGeneration: string; clearedAt: string } : never;
export type CoordinatorStorageControlResult = CoordinatorStorageControlResultFor<CoordinatorStorageControl> | null | undefined;
export type CoordinatorStorageDataResultFor<D extends CoordinatorStorageData> =
  D extends { type: "list" } ? StorageListResult : D extends { type: "create-directory" | "delete-directory" } ? StorageDirectoryResult :
  D extends { type: "put" } ? StoragePutResult : D extends { type: "get-range" } ? StorageGetResult : D extends { type: "delete" } ? StorageDeleteResult :
  D extends { type: "batch" } ? { paths: string[]; committedAt: string } : never;
export type CoordinatorStorageDataResult = CoordinatorStorageDataResultFor<CoordinatorStorageData> | undefined;
export type CoordinatorMsFileControlResultFor<C extends CoordinatorMsFileControl> =
  C extends { type: "settings.get" } ? MsFileSettingsSnapshot : C extends { type: "settings.bitfsBuyer.get" } ? MsFileBitfsBuyerSettings :
  C extends { type: "settings.readConcurrency.get" } ? MsFileReadConcurrencySettings :
  C extends { type: "bitfs.demand.publish" | "bitfs.demand.snapshot" | "bitfs.purchase.start" | "bitfs.purchase.cancel" | "bitfs.purchase.reconnect" } ? MsFileBitfsDemandSnapshot :
  C extends { type: "bitfs.arbitration.list" } ? MsFileArbitrationTask[] : C extends { type: "bitfs.demands.monitor" } ? MsFileDemandMonitorSnapshot :
  C extends { type: "bitfs.purchase.tasks.list" } ? MsFileBitfsTaskSnapshot[] : C extends { type: "bitfs.funding.pools.list" } ? MsFileBitfsFundingPoolSnapshot[] :
  C extends { type: "supplier.probe" } ? MsFileSupplierProbeResult : C extends { type: "app-authorizations.list" } ? MsFileAppAuthorizationView[] :
  C extends { type: "approvals.pending" } ? CoordinatorMsFileStateEvent["pendingApprovals"] : C extends { type: "bucket.get-block" } ? ArrayBuffer : null;
export type CoordinatorMsFileControlResult = MsFileServiceStatus | CoordinatorMsFileControlResultFor<CoordinatorMsFileControl> | undefined;
export type CoordinatorMsFileDataResultFor<D extends CoordinatorMsFileData> = D extends { type: "stat" } ? MsFileStatResult : D extends { type: "read-seed" | "read-block" } ? MsFileReadResult : never;
export type CoordinatorMsFileDataResult = CoordinatorMsFileDataResultFor<CoordinatorMsFileData> | undefined;
export type CoordinatorSatPublishResult = { requestIdHex: string; chargedAmount: string };
export type CoordinatorSatRefreshSubscriptionsResult = { channels: string[]; chargedAmount: string };
export type CoordinatorSatOperationResultFor<O extends CoordinatorSatOperation> =
  O extends { type: "admin.getSettings" } ? SatSubscriptionSettingsSnapshot : O extends { type: "admin.refreshSubscriptions" } ? CoordinatorSatRefreshSubscriptionsResult :
  O extends { type: "admin.getBilling" } ? SatBillingPage : O extends { type: "service.publish" } ? CoordinatorSatPublishResult :
  O extends { type: "spi.getInformation" } ? SatSpiInformation : O extends { type: "spi.prepareTopUp" } ? SatTopUpPreview :
  O extends { type: "spi.submitTopUp" } ? SatTopUpResult : O extends { type: "spi.collectNew" | "spi.retryCollect" } ? SatCollectResult : null;
export type CoordinatorSatOperationResult = CoordinatorSatOperationResultFor<CoordinatorSatOperation>;
export type CoordinatorChannelOperationResultFor<O extends CoordinatorChannelOperation> =
  O extends { type: "publish" | "hash-request-publish" | "private-publish" } ? ChannelPublishResult :
  O extends { type: "open-private-envelope" } ? OpenedPrivateEnvelope : O extends { type: "subscription-set" } ? ChannelSubscriptionSetResult : null;
export type CoordinatorChannelOperationResult = CoordinatorChannelOperationResultFor<CoordinatorChannelOperation>;
export type CoordinatorOwnerStorageResultFor<D extends CoordinatorOwnerStorageData | CoordinatorPlatformStorageData> =
  D extends { type: "owner.get" | "platform.get" } ? KeyValueEntry<unknown> | undefined :
  D extends { type: "owner.list" | "platform.list" } ? KeyValueListResult : D extends { type: "owner.put" | "platform.put" } ? KeyValueEntryMeta :
  D extends { type: "owner.delete" | "platform.delete" | "owner.file-delete" } ? undefined :
  D extends { type: "owner.commit" | "platform.commit" } ? KeyValueCommitResult :
  D extends { type: "owner.file-list" } ? import("./storage/files.js").ModuleFileListPage :
  D extends { type: "owner.file-get" | "owner.file-range" } ? import("./storage/files.js").ModuleFileObject | undefined :
  D extends { type: "owner.file-put" } ? { revision: string; lastModified: string } : D extends { type: "owner.file-batch" } ? { paths: string[]; committedAt: string } : never;
export type CoordinatorOwnerStorageResult = KeyValueEntry<unknown> | KeyValueEntry<unknown>[] | KeyValueListResult | KeyValueEntryMeta | KeyValueCommitResult | undefined | null;
export type CoordinatorPlatformStorageResult = CoordinatorOwnerStorageResult;
export type CoordinatorCryptoResultFor<O extends CoordinatorCryptoOperation> = Extract<CoordinatorCryptoResult, { type: O["type"] }>;
export type CoordinatorP2pkhBroadcastResult = P2pkhBroadcastResult |
  { status: "not-dispatched"; reason: "cancelled" | "stale-provider-generation" | "broadcast-provider-unavailable" | "coordinator-not-dispatched" | "stale-session-epoch" | "snapshot-stale" | "snapshot-consumed" | "snapshot-binding-required" | "snapshot-input-invalid"; currentSeq?: number } |
  { status: "isolated"; txid: string; reason: string; canonicalTxid?: string; providerReturnedTxidRaw?: string; providerReturnedTxidNormalized?: string; txidIntegrity?: "exact" | "reversed" | "mismatch" | "missing"; providerId?: string } |
  { status: "local-confirmed" | "already-known"; txid: string; canonicalTxid?: string; providerReturnedTxidRaw?: string; providerReturnedTxidNormalized?: string; txidIntegrity?: "exact" | "reversed" | "mismatch" | "missing"; providerId?: string; providerReference?: string; providerCode?: string; providerMessage?: string };
export type CoordinatorRpcResultForRequest<R extends CoordinatorRpcRequest> =
  R extends { kind: "session.open" } ? CoordinatorSessionOpenResult :
  R extends { kind: "vault.operation"; operation: infer O extends CoordinatorVaultOperation } ? CoordinatorVaultOperationResultFor<O> :
  R extends { kind: "storage.control"; control: infer C extends CoordinatorStorageControl } ? CoordinatorStorageControlResultFor<C> :
  R extends { kind: "storage.data"; data: infer D extends CoordinatorStorageData } ? CoordinatorStorageDataResultFor<D> :
  R extends { kind: "storage.owner.data" | "storage.platform.data"; data: infer D extends CoordinatorOwnerStorageData | CoordinatorPlatformStorageData } ? CoordinatorOwnerStorageResultFor<D> :
  R extends { kind: "storage.grant" | "msfile.grant" } ? string : R extends { kind: "storage.owner.bind" } ? StorageBindingGrant :
  R extends { kind: "storage.platform.bind" } ? StoragePlatformGrant : R extends { kind: "storage.clear.root" } ? true :
  R extends { kind: "msfile.control"; control: infer C extends CoordinatorMsFileControl } ? CoordinatorMsFileControlResultFor<C> :
  R extends { kind: "msfile.data"; data: infer D extends CoordinatorMsFileData } ? CoordinatorMsFileDataResultFor<D> :
  R extends { kind: "window-p2p.executor.acquire" } ? WindowP2pExecutorLease : R extends { kind: "window-p2p.executor.spike.transfer" } ? WindowP2pExecutorTransferResult :
  R extends { kind: "window-p2p.executor.identity.sign-noise" | "window-p2p.executor.identity.sign-peer-record" } ? WindowP2pIdentitySignResult :
  R extends { kind: "sat.operation"; operation: infer O extends CoordinatorSatOperation } ? CoordinatorSatOperationResultFor<O> :
  R extends { kind: "channel.operation"; operation: infer O extends CoordinatorChannelOperation } ? CoordinatorChannelOperationResultFor<O> :
  R extends { kind: "p2pkh.utxos.get" | "p2pkh.utxos.refresh" } ? P2pkhUtxoSnapshotResult : R extends { kind: "p2pkh.provider-config.get" } ? P2pkhProviderConfig :
  R extends { kind: "p2pkh.broadcast" } ? CoordinatorP2pkhBroadcastResult : R extends { kind: "p2pkh.payment.status" } ? P2pkhPaymentLookupResult :
  R extends { kind: "p2pkh.conclusion" } ? P2pkhConclusionResult : R extends { kind: "p2pkh.transfer.prepare" } ? P2pkhTransferPreviewPayload :
  R extends { kind: "p2pkh.transfer.submit" } ? P2pkhTransferResultPayload : R extends { kind: "p2pkh.artifact.occupy" } ? P2pkhArtifactOccupyResult :
  R extends { kind: "p2pkh.protocol.command" } ? P2pkhProtocolCommandResult : undefined;
export type CoordinatorRpcResultFor<K extends CoordinatorRpcRequestKind> = CoordinatorRpcResultForRequest<CoordinatorRpcRequestFor<K>>;
type ResponseBase = Omit<CoordinatorRpcResponse, "operationResult" | "cryptoResult">;
type NonOkResponse = ResponseBase & { ack: Exclude<CoordinatorCommandAck, { status: "ok" }>; operationResult?: never; cryptoResult?: never };
type VoidRequest = Extract<CoordinatorRpcRequest, { kind: "session.close" | "session.activity" | "unlock" | "lock" | "background.run-now" | "background.trigger" | "background.cancel" | "background.cancel-by-key" | "background.settings.update" | "autolock.settings.update" | "storage.cancel" | "storage.session.abort" | "msfile.cancel" | "msfile.session.abort" | "window-p2p.executor.release" | "channel.cancel" | "chain.fee-policy.update" | "p2pkh.provider-config.update" }> |
  (Extract<CoordinatorRpcRequest, { kind: "storage.owner.data" | "storage.platform.data" }> & { data: Extract<CoordinatorOwnerStorageData | CoordinatorPlatformStorageData, { type: "owner.delete" | "platform.delete" }> });
export type CoordinatorRpcResponseForRequest<R extends CoordinatorRpcRequest> =
  R extends { kind: "crypto"; operation: infer O extends CoordinatorCryptoOperation } ? (ResponseBase & { ack: { status: "ok" }; cryptoResult: CoordinatorCryptoResultFor<O>; operationResult?: never }) | NonOkResponse :
  R extends VoidRequest ? (ResponseBase & { ack: { status: "ok" }; operationResult?: never; cryptoResult?: never }) | NonOkResponse :
  (ResponseBase & { ack: { status: "ok" }; operationResult: CoordinatorRpcResultForRequest<R>; cryptoResult?: never }) | NonOkResponse;
export type CoordinatorRpcResponseFor<K extends CoordinatorRpcRequestKind> = CoordinatorRpcResponseForRequest<CoordinatorRpcRequestFor<K>>;

/** Transport owns headers; nested business facts are already trusted. */
export function toCoordinatorRpcRequest<R extends CoordinatorClientCommandRequest>(request: R): CoordinatorRpcRequestFromClient<R> {
  const { clientId: _clientId, requestId: _requestId, ...body } = request;
  return body as CoordinatorRpcRequestFromClient<R>;
}
export function coordinatorClientRequestFromRpc<K extends CoordinatorRpcCommandRequest["kind"]>(request: Extract<CoordinatorRpcCommandRequest, { kind: K }>, clientId: string, requestId: string): Extract<CoordinatorClientCommandRequest, { kind: K }> {
  return { ...request, clientId, requestId } as Extract<CoordinatorClientCommandRequest, { kind: K }>;
}

// Explicit field selection is about visibility, not distrust. Only arbitrary
// business payloads (JSON content/config/K-V values) pass through as payloads.
type Row = Record<string, unknown>;
type Projection = (value: unknown) => unknown;
function fields(value: unknown, names: string, nested: Record<string, Projection> = {}): Row {
  const source = value as Row;
  const result: Row = {};
  for (const name of names.split(" ")) if (name && source[name] !== undefined) result[name] = source[name];
  for (const [name, project] of Object.entries(nested)) if (source[name] !== undefined) result[name] = source[name] === null ? null : project(source[name]);
  return result;
}
const each = (project: Projection): Projection => value => (value as unknown[]).map(project);
const copy = (value: unknown) => structuredClone(value);
const keyIdentity = (value: unknown) => fields(value, "bsvNetwork publicKeyHex label capabilities createdAt backend", { capabilities: copy });
const publicKey = (value: unknown) => fields(value, "bsvNetwork publicKeyHex label createdAt address format source", { capabilities: copy });
const sealedSecret = (value: unknown) => fields(value, "version keySource saltHex nonceHex ciphertextHex");
const i18n = (value: unknown): unknown => typeof value === "string" ? value : fields(value, "key fallback", { values: copy });
function ack(value: unknown): CoordinatorCommandAck {
  const status = (value as CoordinatorCommandAck).status;
  return (status === "blocked" ? fields(value, "status", { reason: i18n }) :
    status === "error" ? fields(value, "status message code") :
    status === "validation-error" ? fields(value, "status message") : fields(value, "status")) as unknown as CoordinatorCommandAck;
}
const lockCleanup = (value: unknown) => fields(value, "phase attempt error diagnostics");
const recovery = (value: unknown) => fields(value, "status reason authorityBuildId activeIoLeaseCount handoverGeneration", { activeIoOperations: value => fields(value, "read write") });
const storageOwner = (value: unknown) => fields(value, "peerId handoffRevision", { binding: value => fields(value, "runtimeInstanceId connectionId") });
const task = (value: unknown) => fields(value, "id pluginId unitId instanceId label state lastStartedAt lastCompletedAt lastAttemptAt nextRunAt error", {
  progress: value => fields(value, "ratio count", { label: i18n }), blockedReason: i18n,
  keyScope: value => fields(value, "bsvNetwork publicKeyHex label"),
});
const workerUnit = (value: unknown) => fields(value, "productId unitId runtime scopeKind instanceId state snapshotRevision ownerPublicKeyHex sessionEpoch error", {
  dependsOn: copy, serviceIds: copy, taskIds: copy,
  reasons: each(value => fields(value, "code dependencyId", { text: i18n })),
});
const schedule = (value: unknown) => fields(value, "", { taskIntervals: copy });
const bootstrap = (value: unknown) => fields(value, "authorityInstanceId runGeneration buildId sessionEpoch vaultStatus activePublicKeyHex coordinatorWorkerUnitSnapshotRevision autoLockTimeoutMs walletGeneration", {
  lockCleanup, activeKeyIdentity: keyIdentity, authorityRecovery: recovery, coordinatorWorkerUnits: each(workerUnit), taskSnapshots: each(task), scheduleSettings: schedule, storageIoOwnerPeer: storageOwner,
  sessionBinding: value => fields(value, "peerGeneration sessionEpoch leaseId"),
});
const persistence = (value: unknown) => fields(value, "persisted usageBytes quotaBytes");
const storageSummary = (value: unknown) => fields(value, "status medium publicKeyHex label walletGeneration", { persistence });
const binary = (value: unknown) => fields(value, "$type bytes mime");
const kvEntry = (value: unknown) => fields(value, "key revision updatedAt", { value: copy });
const kvMeta = (value: unknown) => fields(value, "key revision updatedAt");
const kvList = (value: unknown) => fields(value, "revision nextCursor", { entries: each(kvEntry) });
const kvCommit = (value: unknown) => fields(value, "revision commitId committedAt");
const fileEntry = (value: unknown) => fields(value, "path size revision lastModified");
const fileObject = (value: unknown) => fields(value, "path revision lastModified", { bytes: copy });
const batchResult = (value: unknown) => fields(value, "committedAt", { paths: copy });
const storageList = (value: unknown) => fields(value, "prefix parentPrefix markerPath nextCursor", {
  directories: each(value => fields(value, "path name")), files: each(value => fields(value, "path name size etag lastModified")),
});
const storageGet = (value: unknown) => fields(value, "path contentType offset totalSize eof etag lastModified", { content: binary });
function storageGrant(value: unknown): Row {
  const common = "bsvNetwork publicKeyHex storageGrantId walletGeneration runGeneration sessionEpoch authority model schemaVersion";
  return (value as StorageBindingGrant).authority === "third-party-app"
    ? fields(value, `${common} appStorageName`, { verifiedAppIdentity: value => fields(value, "publisherPublicKeyHex appId") })
    : fields(value, `${common} moduleId purposeId`);
}
const platformGrant = (value: unknown) => fields(value, "bsvNetwork publicKeyHex platformGrantId walletGeneration runGeneration sessionEpoch moduleId purposeId authority model schemaVersion");
const walletError = (value: unknown) => fields(value, "title summary action code incidentId diagnostic phase");
function storageControlResult(control: CoordinatorStorageControl, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  switch (control.type) {
    case "status": return value;
    case "summary": return storageSummary(value);
    case "cold-start": return fields(value, "state walletGeneration reason", { key: value => fields(value, "bsvNetwork publicKeyHex label backend") });
    case "initialize": return fields(value, "ok walletGeneration", { key: publicKey, error: walletError });
    case "unlock": return fields(value, "bsvNetwork sessionEpoch walletGeneration publicKeyHex");
    case "reset-wallet": return fields(value, "walletGeneration clearedAt");
    case "export-key-hold": return copy(value);
    default: return value;
  }
}
function storageDataResult(data: CoordinatorStorageData, value: unknown): unknown {
  switch (data.type) {
    case "list": return storageList(value);
    case "get-range": return storageGet(value);
    case "batch": return batchResult(value);
    case "put": return fields(value, "path size updatedAt etag");
    case "delete": return fields(value, "path deleted updatedAt");
    default: return fields(value, "path created deleted");
  }
}
function ownerResult(data: CoordinatorOwnerStorageData | CoordinatorPlatformStorageData, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  switch (data.type) {
    case "owner.get": case "platform.get": return kvEntry(value);
    case "owner.list": case "platform.list": return kvList(value);
    case "owner.put": case "platform.put": return kvMeta(value);
    case "owner.commit": case "platform.commit": return kvCommit(value);
    case "owner.file-list": return fields(value, "nextCursor", { files: each(fileEntry) });
    case "owner.file-get": case "owner.file-range": return fileObject(value);
    case "owner.file-put": return fields(value, "revision lastModified");
    case "owner.file-batch": return batchResult(value);
    default: return undefined;
  }
}
function ownerDataResponse(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(kvEntry);
  const row = value as Row;
  if ("entries" in row) return kvList(row);
  if ("commitId" in row) return kvCommit(row);
  return "value" in row ? kvEntry(row) : kvMeta(row);
}
const concurrencyFields = "mediaBlockReadConcurrency globalSeedReadConcurrency globalBlockReadConcurrency globalStatConcurrency";
const price = (value: unknown) => fields(value, "seedMaxPriceSatoshis blockMaxPriceSatoshis");
const sellerSettings = (value: unknown) => fields(value, "sellerEnabled seedPriceSatoshis fullBlockPriceSatoshis maxBlocksPerBatch quoteLifetimeSeconds paymentTimeoutSeconds maxConcurrentSales minRefundDelayBlocks", { supportedArbiterPublicKeys: copy });
const buyerSettings = (value: unknown) => fields(value, "buyerAutoPurchaseEnabled maxFullBlockPriceSatoshis maxConcurrentDownloads refundDelayBlocks poolBlocks schedulerTotalSeats schedulerFloatingSeats schedulerMode");
const supplier = (value: unknown) => fields(value, "name supplierPublicKeyHex enabled builtin", { addresses: copy });
const appKey = (value: unknown) => fields(value, "ownerPublicKeyHex publisherPublicKeyHex appId");
const appPolicy = (value: unknown) => fields(value, "updatedAt", { key: appKey, override: price });
const appAuthorization = (value: unknown) => fields(value, "appName firstSeenAt lastSeenAt", { key: appKey, policy: appPolicy });
const pendingApproval = (value: unknown) => fields(value, "approvalId createdAt appName appId publisherHint supplierHint contentHashHint kind effectiveMaxPriceSatoshis");
const msSettings = (value: unknown) => fields(value, `${concurrencyFields} supplierGeneration sellerRuntimeStatus`, {
  globalSettings: price, suppliers: each(supplier), sellerSettings,
  arbitrationServices: each(value => fields(value, "name publicKeyHex address")),
});
const probe = (value: unknown) => fields(value, "supplierPublicKeyHex peerId connected startedAt durationMs", { addresses: each(value => fields(value, "address ok errorCode")) });
const quote = (value: unknown) => fields(value, "sessionId seedHashHex fileSizeBytes sellerPublicKeyHex seedPriceSatoshis fullBlockPriceSatoshis maxBlocksPerBatch quoteExpiresAtUnixSeconds recommendedFilename mediaType recentBytesPerSecond", { supportedArbiterPublicKeys: copy });
const purchaseFields = "sessionId phase openingAmountSatoshis currentMaxFullBlockPriceSatoshis verifiedBlockCount verifiedBytes totalBlockCount message";
const purchase = (value: unknown) => fields(value, purchaseFields);
const purchaseTask = (value: unknown) => ({ ...fields(value, `${purchaseFields} historyDeleted taskId taskState taskEndReason createdAt updatedAt fundingState fundingTxid poolOutpoint refundLockTime seedHashHex sellerPublicKeyHex recommendedFilename fileSizeBytes fullBlockPriceSatoshis paidSatoshis minerFeeSatoshis lockedSatoshis pendingReturnSatoshis discoveryOnly canCancel canReconnect`),
  verifiedBytes: (value as Row).verifiedBytes ?? null, availableQuotes: ((value as Row).availableQuotes as unknown[] | undefined)?.map(quote) ?? [],
});
const demand = (value: unknown) => fields(value, "seedHashHex requestMessageId expiresAtMs existingPurchaseSessionId currentMaxFullBlockPriceSatoshis", { quotes: each(quote), purchase });
const fundingPool = (value: unknown) => fields(value, "poolId seedHashHex network state fundingTxid openingOutpoint recoveryTxid sellerPublicKeyHex recommendedFilename poolAmountSatoshis lockedSatoshis pendingReturnSatoshis needsRecovery historyDeleted canManage");
const arbitrationTask = (value: unknown) => fields(value, "sessionId seedHashHex role state message txid action");
const demandMonitor = (value: unknown) => fields(value, "lastReceivedAtMs sellerEnabled", {
  demands: each(value => fields(value, "requestMessageId requesterPublicKeyHex seedHashHex receivedAtMs expiresAtMs availability quoteStatus quotedAtMs quoteMessage")),
  network: value => fields(value, "channel subscriptionPhase error", { suppliers: each(value => fields(value, "supplierId name connectionState receiving subscribed error")) }),
});
function msControlResult(control: CoordinatorMsFileControl, value: unknown): unknown {
  switch (control.type) {
    case "settings.get": return msSettings(value);
    case "settings.bitfsBuyer.get": return buyerSettings(value);
    case "settings.readConcurrency.get": return fields(value, concurrencyFields);
    case "bitfs.demand.publish": case "bitfs.demand.snapshot": case "bitfs.purchase.start": case "bitfs.purchase.cancel": case "bitfs.purchase.reconnect": return demand(value);
    case "bitfs.arbitration.list": return (value as unknown[]).map(arbitrationTask);
    case "bitfs.demands.monitor": return demandMonitor(value);
    case "bitfs.funding.pools.list": return (value as unknown[]).map(fundingPool);
    case "bitfs.purchase.tasks.list": return (value as unknown[]).map(purchaseTask);
    case "bucket.get-block": return value;
    case "supplier.probe": return probe(value);
    case "app-authorizations.list": return (value as unknown[]).map(appAuthorization);
    case "approvals.pending": return (value as unknown[]).map(pendingApproval);
    default: return null;
  }
}
function msStatSource(value: unknown): unknown {
  const source = value as Row;
  const base = fields(source, "sourceId sourceKind supplierPublicKeyHex status");
  if (source.status === "absent" || source.status === "network-error") return base;
  if (source.status === "discovering") return { ...base, retryAfterMs: source.retryAfterMs };
  return { ...base, ...fields(source, "recommendedFilename fileSizeBytes mediaType minSeedPriceSatoshis maxSeedPriceSatoshis minFullBlockPriceSatoshis maxFullBlockPriceSatoshis") };
}
const satSupplier = (value: unknown) => fields(value, "supplierId name supplierPublicKeyHex enabled", { multiaddrs: copy });
const satOwner = (value: unknown) => fields(value, "ownerPublicKeyHex defaultPublishSupplierId", { receiveSupplierIds: copy });
const satSupplierView = (value: unknown) => fields(value, "supplierId name supplierPublicKeyHex connectionState inboxChannel lastChargedAmount lastErrorCode", { desiredChannels: copy, observedChannels: copy });
const satSettings = (value: unknown) => fields(value, "ownerPublicKeyHex supplierGeneration", { suppliers: each(satSupplier), ownerSettings: satOwner, supplierViews: each(satSupplierView) });
const satBilling = (value: unknown) => fields(value, "supplierId currency network nextCursor", { records: each(value => fields(value, "supplierId chargeId occurredAtMs action channel sourceRequestIdHex chargedAmount")) });
const satInformation = (value: unknown) => fields(value, "supplierId ownerPublicKeyHex projectType observedAtMs", { projectInfoCbor: copy, currencies: each(value => fields(value, "currency network paymentAddress balance")) });
const satCollect = (value: unknown) => fields(value, "requestIdHex ownerPublicKeyHex ownerGeneration supplierGeneration supplierId currency network amount paymentAddress recoveryBlocked state errorCode", { requestWire: copy });
function satResult(operation: CoordinatorSatOperation, value: unknown): unknown {
  switch (operation.type) {
    case "admin.getSettings": return satSettings(value);
    case "admin.refreshSubscriptions": return fields(value, "chargedAmount", { channels: copy });
    case "admin.getBilling": return satBilling(value);
    case "service.publish": return fields(value, "requestIdHex chargedAmount");
    case "spi.getInformation": return satInformation(value);
    case "spi.prepareTopUp": return fields(value, "supplierId paymentAddress network amountSatoshis", { p2pkhPreview: copy });
    case "spi.submitTopUp": return fields(value, "status txid");
    case "spi.collectNew": case "spi.retryCollect": return satCollect(value);
    default: return null;
  }
}
const subscriptionStatus = (value: unknown) => fields(value, "channel phase errorCode errorMessage updatedAtMs");
const channelMessage = (value: unknown) => fields(value, "channel publisherPublicKeyHex messageId", { content: copy });
const privateChannelMessage = (value: unknown) => fields(value, "channel publisherPublicKeyHex messageId protocol", { content: copy, rawEnvelope: copy });
function channelResult(operation: CoordinatorChannelOperation, value: unknown): unknown {
  switch (operation.type) {
    case "publish": case "hash-request-publish": case "private-publish": return fields(value, "messageId", { signedMessage: copy });
    case "open-private-envelope": return fields(value, "channel protocol messageId publisherPublicKeyHex issuedAtMs expiresAtMs", { content: copy });
    case "subscription-set": return fields(value, "", { channels: copy, statuses: each(subscriptionStatus) });
    case "release": return null;
  }
}
const paymentPreview = (value: unknown) => fields(value, "paymentId clientRequestId planDigest paymentType businessKind appId appName origin publisherPublicKeyHex recipientOwnership recipientLabel businessScriptHex businessAmountSats changeAmountSats feeSats changeScriptHex", {
  outputs: each(value => fields(value, "vout scriptHex valueSats role")),
});
const transferPreview = (value: unknown) => fields(value, "previewId assetId network ownerPublicKeyHex recipientAddress amountSatoshis sendAll feeRateSatoshisPerKb estimatedFeeSatoshis serializedSizeBytes changeAddress rawTxHex txid managerAllocationId", {
  outputs: each(value => fields(value, "address scriptHex value role")), payment: paymentPreview,
  utxoBinding: value => fields(value, "resourceId seq"), paymentContext: value => fields(value, "channelId sessionId"),
  allocation: value => fields(value, "requestedSatoshis feeReserveSatoshis totalInputSatoshis changeSatoshis", { selected: each(value => fields(value, "txid vout value")) }),
});
const transferResult = (value: unknown) => fields(value, "status txid rawTxHex error submissionId attempts reason", { localInputClaimIds: copy });
const utxos = (value: unknown) => fields(value, "hasResult seq syncedAt", { items: each(value => fields(value, "txid vout value height status isSpentInMempoolTx script")) });
const broadcast = (value: unknown) => fields(value, "status reason currentSeq txid canonicalTxid providerReturnedTxidRaw providerReturnedTxidNormalized txidIntegrity providerId providerReference providerCode providerMessage");
function cryptoResult(value: unknown): CoordinatorCryptoResult {
  const source = value as CoordinatorCryptoResult;
  return (source.type === "deriveP2pkhAddress" ? fields(source, "type address") : fields(source, "type signatureHex format")) as unknown as CoordinatorCryptoResult;
}
function resultFor(request: CoordinatorRpcRequest, value: unknown): unknown {
  switch (request.kind) {
    case "session.open": return bootstrap(value);
    case "vault.operation":
      switch (request.operation.type) {
        case "getCurrentKey": return value === undefined ? undefined : publicKey(value);
        case "sealLocalSecret": return sealedSecret(value);
        case "exportKeyHold": case "openLocalSecret": return copy(value);
        default: return value;
      }
    case "storage.control": return storageControlResult(request.control, value);
    case "storage.data": return storageDataResult(request.data, value);
    case "storage.owner.data": case "storage.platform.data": return ownerResult(request.data, value);
    case "storage.owner.bind": return storageGrant(value);
    case "storage.platform.bind": return platformGrant(value);
    case "storage.grant": case "msfile.grant": case "storage.clear.root": return value;
    case "msfile.control": return msControlResult(request.control, value);
    case "msfile.data": return request.data.type === "stat" ? fields(value, "seedHashHex", { sources: each(msStatSource) }) : fields(value, "contentHashHex", { content: binary });
    case "window-p2p.executor.acquire": return fields(value, "leaseId sessionEpoch activePublicKeyHex");
    case "window-p2p.executor.spike.transfer": return fields(value, "bytes acceptedPendingBytes peakPendingBytes");
    case "window-p2p.executor.identity.sign-noise": case "window-p2p.executor.identity.sign-peer-record": return fields(value, "signatureDer");
    case "sat.operation": return satResult(request.operation, value);
    case "channel.operation": return channelResult(request.operation, value);
    case "p2pkh.utxos.get": case "p2pkh.utxos.refresh": return utxos(value);
    case "p2pkh.provider-config.get": return copy(value);
    case "p2pkh.broadcast": return broadcast(value);
    case "p2pkh.payment.status": return projectP2pkhPaymentLookupResult(value as P2pkhPaymentLookupResult);
    case "p2pkh.conclusion": return projectP2pkhConclusionResult(value as P2pkhConclusionResult);
    case "p2pkh.transfer.prepare": return transferPreview(value);
    case "p2pkh.transfer.submit": return transferResult(value);
    case "p2pkh.artifact.occupy": return fields(value, "allocationId txid");
    case "p2pkh.protocol.command": return copy(value);
    default: return undefined;
  }
}
/** Publish the request's public view once, not a schema check of trusted results. */
export function projectCoordinatorResponse<R extends CoordinatorRpcRequest>(request: R, value: CoordinatorRpcResponse): CoordinatorRpcResponseForRequest<R> {
  const result: CoordinatorRpcResponse = { sessionEpoch: value.sessionEpoch, ack: ack(value.ack) };
  if (value.ack.status === "ok") {
    if (request.kind === "crypto") result.cryptoResult = cryptoResult(value.cryptoResult);
    else {
      const operationResult = resultFor(request, value.operationResult);
      if (Object.prototype.hasOwnProperty.call(value, "operationResult") || operationResult !== undefined) result.operationResult = operationResult;
    }
  }
  return result as CoordinatorRpcResponseForRequest<R>;
}
function responseEnvelope(value: unknown): CoordinatorRpcResponse {
  const source = value as CoordinatorRpcResponse;
  return { sessionEpoch: source.sessionEpoch, ack: ack(source.ack),
    ...(Object.prototype.hasOwnProperty.call(source, "operationResult") ? { operationResult: source.operationResult } : {}),
    ...(source.cryptoResult === undefined ? {} : { cryptoResult: cryptoResult(source.cryptoResult) }),
  };
}
function rpcRequest(value: unknown): CoordinatorRpcRequest {
  const source = value as CoordinatorRpcRequest & { clientId?: string; requestId?: string; operationId?: string; callId?: string; peerId?: string };
  const { clientId: _client, requestId: _request, operationId: _operation, callId: _call, peerId, ...body } = source;
  // The signed peer record's peerId is business content, not transport authority.
  return (source.kind === "window-p2p.executor.identity.sign-peer-record" ? { ...body, peerId } : body) as CoordinatorRpcRequest;
}
const feePolicy = (value: unknown) => fields(value, "mode satoshisPerKb");
const feeRecommendation = (value: unknown) => fields(value, "fee_unit fee mempool_min_fee");
const feeSnapshot = (value: unknown) => fields(value, "network source effectiveSatoshisPerKb updatedAtMs lastAttemptAtMs error", { policy: feePolicy, recommendation: feeRecommendation });
function topicEvent(value: unknown): CoordinatorTopicEvent {
  const source = value as CoordinatorTopicEvent;
  const common = fields(source, "topic type sessionEpoch", { networkIdentity: value => fields(value, "bsvNetwork publicKeyHex") });
  let payload: Row;
  switch (source.topic) {
    case "session.state": payload = fields(source, "sessionRevision runGeneration walletGeneration cause vaultStatus activePublicKeyHex autoLockTimeoutMs", {
      lockCleanup, activeKeyIdentity: keyIdentity, authorityRecovery: recovery, storageIoOwnerPeer: storageOwner,
    }); break;
    case "background.snapshot": payload = fields(source, "backgroundSnapshotRevision", { snapshots: each(task), scheduleSettings: schedule }); break;
    case "worker.units": payload = fields(source, "authorityInstanceId workerUnitRevision", { units: each(workerUnit) }); break;
    case "asset.data-changed": payload = fields(source, "providerId publicKeyHex assetDataRevision", { kinds: copy, utxoSeqs: value => fields(value, "main test") }); break;
    case "storage.state": payload = fields(source, "storageRevision status walletGeneration", { authorityRecovery: recovery, summary: storageSummary, activity: value => fields(value, "reads writes") }); break;
    case "msfile.state": payload = fields(source, `msfileRevision status supplierGeneration sellerRuntimeStatus ${concurrencyFields}`, { globalSettings: price, sellerSettings, pendingApprovals: each(pendingApproval) }); break;
    case "sat.events": payload = fields(source, "satRevision", { event: value => fields(value, "type", { event: value => fields(value, "deliveryId ingressSupplierId channel requestIdHex chargedAmount receivedAtMs", { contentJson: copy }) }) }); break;
    case "channel.events": payload = fields(source, "channelRevision", { publicMessage: channelMessage, privateMessage: privateChannelMessage, subscriptionStatus, subscriptionStatuses: each(subscriptionStatus) }); break;
    case "chain.height": payload = fields(source, "chainHeightRevision", { chainHeight: value => fields(value, "height network available updatedAtMs revision") }); break;
    case "chain.fees": payload = fields(source, "chainFeeRevision", { chainFees: value => fields(value, "", { main: feeSnapshot, test: feeSnapshot }) }); break;
  }
  return { ...common, ...payload } as unknown as CoordinatorTopicEvent;
}
function transfers(value: unknown): readonly Transferable[] {
  const output: Transferable[] = [];
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (item instanceof ArrayBuffer) { output.push(item); return; }
    if (ArrayBuffer.isView(item)) { if (item.buffer instanceof ArrayBuffer) visit(item.buffer); return; }
    if (typeof MessagePort !== "undefined" && item instanceof MessagePort) { output.push(item); return; }
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return output;
}
export const COORDINATOR_RPC_CAPABILITY = defineCapability<CoordinatorRpcRequest, CoordinatorRpcResponse>({
  kind: "rpc", id: "keymaster.coordinator.rpc", version: "1",
  request: { parse: rpcRequest }, response: { parse: responseEnvelope }, transfer: { request: transfers, response: transfers },
});
export const COORDINATOR_TOPIC_STREAM_CAPABILITY = defineCapability<CoordinatorTopicSubscription, CoordinatorTopicEvent>({
  kind: "stream", id: "keymaster.coordinator.events", version: "1",
  request: { parse(value: unknown) { return { topics: [...new Set((value as CoordinatorTopicSubscription).topics)] }; } },
  item: { parse: topicEvent }, transfer: { request: transfers, item: transfers },
});
export const COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY = defineCapability<CoordinatorOwnerStorageData, CoordinatorOwnerStorageResult>({
  kind: "rpc", id: "coordinator.owner-storage", version: "1.0.0",
  request: { parse: value => copy(value) as CoordinatorOwnerStorageData }, response: { parse: value => ownerDataResponse(value) as CoordinatorOwnerStorageResult },
  transfer: { request: transfers, response: transfers },
});
export const COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY = defineCapability<CoordinatorPlatformStorageData, CoordinatorPlatformStorageResult>({
  kind: "rpc", id: "coordinator.platform-storage", version: "1.0.0",
  request: { parse: value => copy(value) as CoordinatorPlatformStorageData }, response: { parse: value => ownerDataResponse(value) as CoordinatorPlatformStorageResult },
  transfer: { request: transfers, response: transfers },
});
export const COORDINATOR_CRYPTO_RPC_CAPABILITY = defineCapability<CoordinatorCryptoOperation, CoordinatorCryptoResult>({
  kind: "rpc", id: "coordinator.crypto", version: "1.0.0",
  request: { parse: value => copy(value) as CoordinatorCryptoOperation }, response: { parse: cryptoResult },
});
export const COORDINATOR_RUNTIME_CAPABILITIES = Object.freeze([
  COORDINATOR_RPC_CAPABILITY, COORDINATOR_TOPIC_STREAM_CAPABILITY, COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
  COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY, COORDINATOR_CRYPTO_RPC_CAPABILITY,
] as const);
