// 新建远端空间与接入已有远端空间的显式状态机。
//
// 两条入口刻意不共享“发现失败就创建”的隐式分支。创建只接受 root
// manifest 的权威 absent；接入只读 root、Hold 和最小索引，永远不会写远端。

import type {
  DeviceRemoteConnectionV1,
  DeviceRemoteRecoveryErrorClass,
  RemoteStorageRootManifestV1,
  StorageBucketReadOnlyProvider,
  StorageBucketProvider,
} from "@keymaster/contracts";
import {
  REMOTE_STORAGE_ROOT_MANIFEST_PATH,
} from "@keymaster/contracts";
import { StorageRuntimeError, storageErrorCode } from "../runtime/storageError.js";
import type { DeviceBootstrapRepository } from "./deviceBootstrapRepository.js";
import {
  discoverRemoteStorageRoot,
  encodeRemoteRootManifest,
  physicalLocationFingerprint,
  remoteInitializationStagingPath,
  remoteInitializationTransactionPath,
  remoteRootManifestFingerprint,
  sealRemoteRootManifest,
  type RemoteRootAuthenticator,
  type RemoteRootDiscoveryResult,
  type RemoteStorageRootManifestInput,
} from "./remoteRootProtocol.js";

export type RemoteStorageCreatePhase =
  | "validate-input"
  | "probe-provider"
  | "discover-root"
  | "reserve-transaction"
  | "stage-initial-data"
  | "publish-root-manifest"
  | "verify-remote-result"
  | "commit-device-bootstrap"
  | "install-worker-runtime";

export type RemoteStorageConnectPhase =
  | "validate-input"
  | "read-root-manifest"
  | "validate-schema-and-identity"
  | "authenticate-hold"
  | "load-minimum-remote-index"
  | "deduplicate-device-connection"
  | "commit-device-bootstrap"
  | "install-worker-runtime";

interface RemoteInitializationTransactionRecordV1 {
  format: "keymaster.remote-initialization";
  version: 1;
  transactionId: string;
  remoteStorageId: string;
  mode: "create";
  status: "reserved" | "staged" | "published";
  createdAt: number;
  updatedAt: number;
  manifestFingerprint?: string;
  integrity: { algorithm: "hmac-sha-256"; tagB64Url: string };
}

interface RemoteInitializationTransactionInput {
  transactionId: string;
  remoteStorageId: string;
  mode: "create";
  status: "reserved" | "staged" | "published";
  createdAt: number;
  updatedAt: number;
  manifestFingerprint?: string;
}

export interface RemoteStorageLifecycleSuccess {
  ok: true;
  remoteStorageId: string;
  transactionId: string;
  manifest: RemoteStorageRootManifestV1;
  manifestFingerprint: string;
  /** 远端成功但设备存储不可用时为 false；可稍后重新接入补写。 */
  deviceBootstrapCommitted: boolean;
}

export interface RemoteStorageCreatePlan {
  provider: StorageBucketProvider;
  remoteStorageId: string;
  transactionId: string;
  authenticator: RemoteRootAuthenticator;
  /** 待签名的 root manifest；其 ID 和事务 ID 必须与本计划一致。 */
  manifest: RemoteStorageRootManifestInput;
  /** 新建成功后写入设备引导的连接元数据。 */
  deviceConnection?: DeviceRemoteConnectionV1;
  deviceBootstrap?: DeviceBootstrapRepository;
  /** 写入初始数据并完成从 staging 到 manifest 引用入口的幂等准备。 */
  stageInitialData: (input: { provider: StorageBucketProvider; transactionId: string; transactionPath: string; stagingPrefix: string }) => Promise<void>;
  /** 发布后只读验证 Hold 和最小系统数据。 */
  verifyRemoteResult: (input: { provider: StorageBucketReadOnlyProvider; manifest: RemoteStorageRootManifestV1 }) => Promise<void>;
  /** 所有远端验证完成后再安装当前 Worker 运行态。 */
  installWorkerRuntime?: (input: { manifest: RemoteStorageRootManifestV1 }) => Promise<void>;
  now?: () => number;
}

export interface RemoteStorageConnectPlan {
  provider: StorageBucketProvider;
  remoteStorageId?: string;
  /** 新设备通常只有密码；root 中的公开 KDF 参数用于派生认证器。 */
  password?: string;
  /** 测试或宿主已安全派生认证器时可直接注入。 */
  authenticator?: RemoteRootAuthenticator;
  deviceConnection?: DeviceRemoteConnectionV1;
  deviceBootstrap?: DeviceBootstrapRepository;
  /** 只读认证已有 Hold；该回调不得调用 Provider 写入/删除。 */
  authenticateHold: (input: { provider: StorageBucketReadOnlyProvider; manifest: RemoteStorageRootManifestV1 }) => Promise<void>;
  /** 只读加载系统最小索引；该回调不得执行迁移或补默认值。 */
  loadMinimumRemoteIndex: (input: { provider: StorageBucketReadOnlyProvider; manifest: RemoteStorageRootManifestV1 }) => Promise<unknown>;
  installWorkerRuntime?: (input: { manifest: RemoteStorageRootManifestV1; minimumRemoteIndex?: unknown }) => Promise<void>;
}

function error(code: ConstructorParameters<typeof StorageRuntimeError>[0], message: string, diagnostic?: "configuration" | "authentication" | "forbidden" | "not-found" | "cors" | "network" | "provider"): StorageRuntimeError {
  return new StorageRuntimeError(code, message, diagnostic);
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) throw error("storage_provider_error", `${field} is invalid`);
}

function discoveryError(result: Exclude<RemoteRootDiscoveryResult, { status: "absent" }>, connect: boolean): StorageRuntimeError {
  if (result.status === "present") return error("storage_remote_already_initialized", "The remote storage namespace is already initialized");
  if (result.status === "forbidden") return error("storage_forbidden", "The remote storage provider denied root discovery", result.diagnostic);
  if (result.status === "unavailable") return error("storage_unavailable", "The remote storage root could not be reached", result.diagnostic === "timeout" ? "network" : result.diagnostic === "unknown" ? undefined : result.diagnostic);
  if (result.status === "corrupt") return error("storage_remote_corrupt", "The remote storage root manifest is corrupt", "provider");
  return error(connect ? "storage_remote_incompatible" : "storage_remote_incompatible", "The remote storage root manifest is incompatible", "provider");
}

function recoveryErrorClass(errorValue: unknown): DeviceRemoteRecoveryErrorClass {
  const diagnostic = errorValue && typeof errorValue === "object" ? (errorValue as { diagnostic?: unknown }).diagnostic : undefined;
  if (diagnostic === "authentication") return "authentication";
  if (diagnostic === "forbidden") return "forbidden";
  if (diagnostic === "cors") return "cors";
  if (diagnostic === "network") return "network";
  const code = storageErrorCode(errorValue);
  if (code === "storage_remote_corrupt") return "corrupt";
  if (code === "storage_remote_incompatible") return "incompatible";
  return "unknown";
}

function isKnownConflict(errorValue: unknown): boolean {
  return storageErrorCode(errorValue) === "storage_conflict";
}

function isNotFound(errorValue: unknown): boolean {
  return storageErrorCode(errorValue) === "storage_not_found";
}

function canonicalTransactionInput(input: RemoteInitializationTransactionInput): Uint8Array {
  const value = {
    createdAt: input.createdAt,
    format: "keymaster.remote-initialization",
    ...(input.manifestFingerprint === undefined ? {} : { manifestFingerprint: input.manifestFingerprint }),
    mode: input.mode,
    remoteStorageId: input.remoteStorageId,
    status: input.status,
    transactionId: input.transactionId,
    updatedAt: input.updatedAt,
    version: 1,
  };
  return new TextEncoder().encode(JSON.stringify(value));
}

async function sealTransaction(input: RemoteInitializationTransactionInput, authenticator: RemoteRootAuthenticator): Promise<RemoteInitializationTransactionRecordV1> {
  const tag = await authenticator.sign(canonicalTransactionInput(input));
  let binary = "";
  for (const byte of tag) binary += String.fromCharCode(byte);
  const base64 = (typeof btoa === "function" ? btoa(binary) : Buffer.from(tag).toString("base64"))
    .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  return {
    format: "keymaster.remote-initialization",
    version: 1,
    transactionId: input.transactionId,
    remoteStorageId: input.remoteStorageId,
    mode: "create",
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(input.manifestFingerprint === undefined ? {} : { manifestFingerprint: input.manifestFingerprint }),
    integrity: { algorithm: "hmac-sha-256", tagB64Url: base64 },
  };
}

function transactionBytes(record: RemoteInitializationTransactionRecordV1): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  if (bytes.byteLength > 32 * 1024) throw error("storage_limit_exceeded", "Initialization transaction record is too large");
  return bytes;
}

function transactionUnsigned(record: RemoteInitializationTransactionRecordV1): RemoteInitializationTransactionInput {
  return {
    transactionId: record.transactionId,
    remoteStorageId: record.remoteStorageId,
    mode: "create",
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.manifestFingerprint === undefined ? {} : { manifestFingerprint: record.manifestFingerprint }),
  };
}

async function readTransaction(provider: StorageBucketProvider, transactionId: string, authenticator: RemoteRootAuthenticator): Promise<{ record: RemoteInitializationTransactionRecordV1; etag?: string } | undefined> {
  let object;
  try {
    object = await provider.get(remoteInitializationTransactionPath(transactionId));
  } catch (caught) {
    if (isNotFound(caught)) return undefined;
    throw caught;
  }
  if (!object) return undefined;
  if (object.bytes.byteLength > 32 * 1024) throw error("storage_remote_corrupt", "Initialization transaction record is too large");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(object.bytes)) as unknown; } catch { throw error("storage_remote_corrupt", "Initialization transaction record is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw error("storage_remote_corrupt", "Initialization transaction record is invalid");
  const value = parsed as Partial<RemoteInitializationTransactionRecordV1>;
  const allowed = new Set(["createdAt", "format", "integrity", "manifestFingerprint", "mode", "remoteStorageId", "status", "transactionId", "updatedAt", "version"]);
  if (Object.keys(parsed).some((key) => !allowed.has(key)) || value.format !== "keymaster.remote-initialization" || value.version !== 1 || value.mode !== "create" || value.transactionId !== transactionId || (value.status !== "reserved" && value.status !== "staged" && value.status !== "published") || typeof value.remoteStorageId !== "string" || typeof value.createdAt !== "number" || typeof value.updatedAt !== "number" || !value.integrity || value.integrity.algorithm !== "hmac-sha-256" || typeof value.integrity.tagB64Url !== "string") {
    throw error("storage_remote_corrupt", "Initialization transaction record is invalid");
  }
  const record = value as RemoteInitializationTransactionRecordV1;
  try { await authenticator.verify(canonicalTransactionInput(transactionUnsigned(record)), record.integrity.tagB64Url); } catch { throw error("storage_remote_corrupt", "Initialization transaction authentication failed"); }
  return { record, etag: object.etag };
}

async function putTransaction(provider: StorageBucketProvider, record: RemoteInitializationTransactionRecordV1, etag: string): Promise<{ etag: string }> {
  const result = await provider.put(remoteInitializationTransactionPath(record.transactionId), transactionBytes(record), { ifMatch: etag });
  if (!result.etag) throw transactionCasRequiredError();
  return { etag: result.etag };
}

function transactionCasRequiredError(): StorageRuntimeError {
  return error("storage_provider_error", "The remote provider did not return a transaction version required for CAS", "provider");
}

function readOnlyProvider(provider: StorageBucketProvider): StorageBucketReadOnlyProvider {
  return Object.freeze({
    provider: provider.provider,
    bucketId: provider.bucketId,
    probe: (signal?: AbortSignal) => provider.probe(signal),
    get: (path: string, options?: { signal?: AbortSignal; ifMatch?: string }) => provider.get(path, options),
    list: (input?: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }) => provider.list(input),
  });
}

function transactionFingerprint(record: RemoteInitializationTransactionRecordV1): string {
  return remoteRootManifestFingerprint(transactionBytes(record));
}

async function writeRecovery(deviceBootstrap: DeviceBootstrapRepository | undefined, input: { plan: RemoteStorageCreatePlan; status: "unknown" | "attention-required"; errorClass: DeviceRemoteRecoveryErrorClass; manifestFingerprint?: string; transactionFingerprint?: string }): Promise<void> {
  if (!deviceBootstrap) return;
  await deviceBootstrap.upsertRecovery({
    operationId: input.plan.transactionId,
    mode: "create",
    physicalLocationFingerprint: input.plan.deviceConnection?.physicalLocationFingerprint ?? "0".repeat(64),
    ...(input.plan.remoteStorageId ? { remoteStorageId: input.plan.remoteStorageId } : {}),
    ...(input.manifestFingerprint === undefined ? {} : { manifestFingerprint: input.manifestFingerprint }),
    ...(input.transactionFingerprint === undefined ? {} : { transactionFingerprint: input.transactionFingerprint }),
    status: input.status,
    errorClass: input.errorClass,
    updatedAt: (input.plan.now ?? (() => Date.now()))(),
  });
}

async function verifyPublishedRoot(plan: RemoteStorageCreatePlan, expectedManifest: RemoteStorageRootManifestV1): Promise<{ manifest: RemoteStorageRootManifestV1; fingerprint: string }> {
  const discovered = await discoverRemoteStorageRoot(plan.provider, { authenticator: plan.authenticator, expectedRemoteStorageId: plan.remoteStorageId });
  if (discovered.status !== "present") {
    if (discovered.status === "absent" || discovered.status === "unavailable") throw error("storage_remote_unknown_result", "Remote root publication result is unknown");
    throw discoveryError(discovered, false);
  }
  if (discovered.object.manifest.initializationTransactionId !== plan.transactionId) throw error("storage_conflict", "Another initialization transaction published the remote root");
  if (discovered.object.manifest.remoteStorageId !== expectedManifest.remoteStorageId) throw error("storage_remote_location_mismatch", "Remote root identity does not match the requested storage");
  await verifyManifestEntrypoints(readOnlyProvider(plan.provider), discovered.object.manifest);
  await plan.verifyRemoteResult({ provider: readOnlyProvider(plan.provider), manifest: discovered.object.manifest });
  return { manifest: discovered.object.manifest, fingerprint: discovered.object.fingerprint };
}

/** root 发布后必须能读取 manifest 宣告的最小系统入口。 */
async function verifyManifestEntrypoints(provider: StorageBucketReadOnlyProvider, manifest: RemoteStorageRootManifestV1): Promise<void> {
  const paths = new Set([manifest.rootHead.path, manifest.system.schemaPath, manifest.system.holdHeadPath]);
  for (const path of paths) {
    const object = await provider.get(path);
    if (!object) throw error("storage_remote_corrupt", `Remote root entrypoint is missing: ${path}`, "provider");
  }
}

/** 新建一个干净的 Keymaster namespace；失败方不会覆盖并发赢家。 */
export async function createRemoteStorage(plan: RemoteStorageCreatePlan): Promise<RemoteStorageLifecycleSuccess> {
  if (!plan || typeof plan.stageInitialData !== "function" || typeof plan.verifyRemoteResult !== "function") {
    throw error("storage_provider_error", "Create lifecycle requires initial-data staging and remote-result verification callbacks");
  }
  assertIdentifier(plan.remoteStorageId, "remoteStorageId");
  assertIdentifier(plan.transactionId, "transactionId");
  if (plan.manifest.remoteStorageId !== plan.remoteStorageId || plan.manifest.initializationTransactionId !== plan.transactionId) throw error("storage_provider_error", "Remote root plan identity does not match the transaction");
  if (plan.deviceConnection && (plan.deviceConnection.remoteStorageId !== plan.remoteStorageId || plan.deviceConnection.source !== "created")) throw error("storage_provider_error", "Device bootstrap connection does not match create plan");
  const fallbackLocation = { providerId: "local" as const, namespace: plan.remoteStorageId };
  if (physicalLocationFingerprint(plan.deviceConnection?.location ?? fallbackLocation) !== (plan.deviceConnection?.physicalLocationFingerprint ?? physicalLocationFingerprint(fallbackLocation))) {
    throw error("storage_remote_location_mismatch", "Device bootstrap physical location fingerprint is invalid");
  }

  const now = plan.now ?? (() => Date.now());
  const probe = await plan.provider.probe();
  if (!probe.ok) throw error("storage_unavailable", "The remote storage provider probe failed", probe.diagnostic === "authentication" || probe.diagnostic === "forbidden" || probe.diagnostic === "cors" || probe.diagnostic === "network" || probe.diagnostic === "configuration" || probe.diagnostic === "not-found" || probe.diagnostic === "provider" ? probe.diagnostic : "provider");
  if (probe.conditionalWrites !== "native") throw error("storage_provider_error", "The remote storage provider does not support atomic conditional creation", "provider");

  const before = await discoverRemoteStorageRoot(plan.provider, { authenticator: plan.authenticator, expectedRemoteStorageId: plan.remoteStorageId });
  if (before.status !== "absent") {
    if (before.status === "present" && before.object.manifest.initializationTransactionId === plan.transactionId) {
      const verified = await verifyPublishedRoot(plan, before.object.manifest);
      return finalizeCreateSuccess(plan, verified);
    }
    throw discoveryError(before, false);
  }

  const transactionPath = remoteInitializationTransactionPath(plan.transactionId);
  let transaction = await readTransaction(plan.provider, plan.transactionId, plan.authenticator);
  let transactionEtag = transaction?.etag;
  if (transaction && transaction.record.remoteStorageId !== plan.remoteStorageId) throw error("storage_conflict", "Initialization transaction ID is already bound to another remote storage");
  if (!transaction) {
    const reserved = await sealTransaction({ transactionId: plan.transactionId, remoteStorageId: plan.remoteStorageId, mode: "create", status: "reserved", createdAt: now(), updatedAt: now() }, plan.authenticator);
    try {
      const result = await plan.provider.put(transactionPath, transactionBytes(reserved), { ifNoneMatch: "*" });
      transaction = { record: reserved, etag: result.etag };
      transactionEtag = result.etag;
    } catch (caught) {
      if (isKnownConflict(caught)) {
        transaction = await readTransaction(plan.provider, plan.transactionId, plan.authenticator);
        if (!transaction) throw error("storage_conflict", "Initialization transaction was claimed concurrently");
        transactionEtag = transaction.etag;
      } else {
        await writeRecovery(plan.deviceBootstrap, { plan, status: "unknown", errorClass: recoveryErrorClass(caught), transactionFingerprint: transaction ? transactionFingerprint(transaction.record) : undefined });
        throw error("storage_remote_unknown_result", "Initialization transaction reservation result is unknown");
      }
    }
  }
  if (!transaction) throw error("storage_remote_corrupt", "Initialization transaction could not be recovered");
  if (!transactionEtag) {
    await writeRecovery(plan.deviceBootstrap, { plan, status: "unknown", errorClass: "unknown", transactionFingerprint: transactionFingerprint(transaction.record) }).catch(() => undefined);
    throw transactionCasRequiredError();
  }

  if (transaction.record.status === "reserved") {
    try {
      await plan.stageInitialData({ provider: plan.provider, transactionId: plan.transactionId, transactionPath, stagingPrefix: remoteInitializationStagingPath(plan.transactionId) });
      // The manifest is the namespace visibility boundary.  A callback return
      // value alone cannot prove that its referenced Hold/system objects were
      // actually committed, so read every declared entrypoint before moving
      // the transaction to staged or publishing the root.
      await verifyManifestEntrypoints(readOnlyProvider(plan.provider), await sealRemoteRootManifest(plan.manifest, plan.authenticator));
    } catch (caught) {
      await writeRecovery(plan.deviceBootstrap, { plan, status: "unknown", errorClass: recoveryErrorClass(caught), transactionFingerprint: transactionFingerprint(transaction.record) });
      if (storageErrorCode(caught) === "storage_remote_corrupt") throw caught;
      throw error("storage_remote_unknown_result", "Initial data staging result is unknown; retry with the same transaction ID");
    }
    const staged = await sealTransaction({ ...transactionUnsigned(transaction.record), status: "staged", updatedAt: now() }, plan.authenticator);
    try {
      const updated = await putTransaction(plan.provider, staged, transactionEtag);
      transaction = { record: staged, etag: updated.etag };
      transactionEtag = updated.etag;
    } catch (caught) {
      if (isKnownConflict(caught)) {
        const latest = await readTransaction(plan.provider, plan.transactionId, plan.authenticator);
        if (!latest) throw error("storage_remote_unknown_result", "Initialization transaction update result is unknown");
        transaction = latest;
        transactionEtag = latest.etag;
      } else {
        await writeRecovery(plan.deviceBootstrap, { plan, status: "unknown", errorClass: recoveryErrorClass(caught), transactionFingerprint: transactionFingerprint(transaction.record) });
        throw error("storage_remote_unknown_result", "Initial data staging result is unknown");
      }
    }
    if (!transactionEtag) {
      await writeRecovery(plan.deviceBootstrap, { plan, status: "unknown", errorClass: "unknown", transactionFingerprint: transactionFingerprint(transaction.record) }).catch(() => undefined);
      throw transactionCasRequiredError();
    }
  }

  const manifest = await sealRemoteRootManifest(plan.manifest, plan.authenticator);
  const manifestBytes = encodeRemoteRootManifest(manifest);
  try {
    await plan.provider.put(REMOTE_STORAGE_ROOT_MANIFEST_PATH, manifestBytes, { ifNoneMatch: "*" });
  } catch (caught) {
    if (isKnownConflict(caught)) {
      const winner = await discoverRemoteStorageRoot(plan.provider, { authenticator: plan.authenticator, expectedRemoteStorageId: plan.remoteStorageId });
      if (winner.status !== "present") throw error("storage_conflict", "Another initialization transaction won but its root cannot be read");
      if (winner.object.manifest.initializationTransactionId !== plan.transactionId) throw error("storage_remote_already_initialized", "The remote storage namespace was initialized concurrently");
    } else {
      await writeRecovery(plan.deviceBootstrap, { plan, status: "unknown", errorClass: recoveryErrorClass(caught), manifestFingerprint: remoteRootManifestFingerprint(manifestBytes) });
      throw error("storage_remote_unknown_result", "Remote root publication result is unknown; retry with the same transaction ID");
    }
  }

  let verified: { manifest: RemoteStorageRootManifestV1; fingerprint: string };
  try {
    verified = await verifyPublishedRoot(plan, manifest);
  } catch (caught) {
    if (storageErrorCode(caught) === "storage_remote_unknown_result") {
      await writeRecovery(plan.deviceBootstrap, { plan, status: "unknown", errorClass: recoveryErrorClass(caught), manifestFingerprint: remoteRootManifestFingerprint(manifestBytes) });
    }
    throw caught;
  }
  const published = await sealTransaction({ ...transactionUnsigned(transaction.record), status: "published", updatedAt: now(), manifestFingerprint: verified.fingerprint }, plan.authenticator);
  try {
    const updated = await putTransaction(plan.provider, published, transactionEtag);
    transactionEtag = updated.etag;
  } catch (caught) {
    if (!isKnownConflict(caught)) {
      await writeRecovery(plan.deviceBootstrap, { plan, status: "unknown", errorClass: recoveryErrorClass(caught), manifestFingerprint: verified.fingerprint, transactionFingerprint: transactionFingerprint(published) }).catch(() => undefined);
      throw error("storage_remote_unknown_result", "Initialization transaction result is unknown; retry with the same transaction ID");
    }
    throw error("storage_conflict", "Initialization transaction changed before completion");
  }
  return finalizeCreateSuccess(plan, verified);
}

async function finalizeCreateSuccess(
  plan: RemoteStorageCreatePlan,
  verified: { manifest: RemoteStorageRootManifestV1; fingerprint: string },
): Promise<RemoteStorageLifecycleSuccess> {
  const committed = await commitDeviceConnection(plan);
  try {
    await plan.installWorkerRuntime?.({ manifest: verified.manifest });
  } catch (caught) {
    await writeRecovery(plan.deviceBootstrap, {
      plan,
      status: "attention-required",
      errorClass: recoveryErrorClass(caught),
      manifestFingerprint: verified.fingerprint,
    }).catch(() => undefined);
    throw caught;
  }
  // A recovery pointer is evidence that the device did not yet know whether
  // the operation completed. Keep it when the device write itself failed so a
  // later explicit retry can finish the local commit.
  if (committed) await plan.deviceBootstrap?.removeRecovery(plan.transactionId);
  return { ok: true, remoteStorageId: plan.remoteStorageId, transactionId: plan.transactionId, manifest: verified.manifest, manifestFingerprint: verified.fingerprint, deviceBootstrapCommitted: committed };
}

async function commitDeviceConnection(plan: RemoteStorageCreatePlan): Promise<boolean> {
  if (!plan.deviceBootstrap || !plan.deviceConnection) return false;
  try {
    await plan.deviceBootstrap.upsertConnection(plan.deviceConnection);
    return true;
  } catch (caught) {
    if (storageErrorCode(caught) === "storage_remote_location_mismatch" || storageErrorCode(caught) === "storage_conflict") throw caught;
    // 远端已经验证成功；返回 false 让上层显示“稍后补写设备连接”，而不是
    // 重新创建远端空间或删除已发布数据。
    return false;
  }
}

/** 接入已有 namespace；除设备引导提交外，此流程不执行任何远端写入。 */
export async function connectExistingRemoteStorage(plan: RemoteStorageConnectPlan): Promise<RemoteStorageLifecycleSuccess> {
  if (!plan || typeof plan.authenticateHold !== "function" || typeof plan.loadMinimumRemoteIndex !== "function") {
    throw error("storage_provider_error", "Connect lifecycle requires Hold authentication and minimum-index loading callbacks");
  }
  if (!plan.authenticator && typeof plan.password !== "string") throw error("storage_identity_required", "Connect lifecycle requires a password or root authenticator", "authentication");
  const discovered = await discoverRemoteStorageRoot(plan.provider, {
    ...(plan.authenticator === undefined ? {} : { authenticator: plan.authenticator }),
    ...(plan.password === undefined ? {} : { password: plan.password }),
    ...(plan.remoteStorageId === undefined ? {} : { expectedRemoteStorageId: plan.remoteStorageId }),
  });
  if (discovered.status === "absent") throw error("storage_remote_not_initialized", "The remote storage namespace is not initialized");
  if (discovered.status !== "present") throw discoveryError(discovered, true);
  const manifest = discovered.object.manifest;
  if (plan.remoteStorageId !== undefined && manifest.remoteStorageId !== plan.remoteStorageId) throw error("storage_remote_location_mismatch", "Remote root identity does not match the requested storage");
  if (plan.deviceConnection && (plan.deviceConnection.remoteStorageId !== manifest.remoteStorageId || (plan.deviceConnection.source !== "connected" && plan.deviceConnection.source !== "created"))) throw error("storage_provider_error", "Device bootstrap connection does not match connected root");
  if (plan.deviceConnection && physicalLocationFingerprint(plan.deviceConnection.location) !== plan.deviceConnection.physicalLocationFingerprint) throw error("storage_remote_location_mismatch", "Device bootstrap physical location fingerprint is invalid");

  const readOnly = readOnlyProvider(plan.provider);
  await verifyManifestEntrypoints(readOnly, manifest);
  await plan.authenticateHold({ provider: readOnly, manifest });
  const minimumRemoteIndex = await plan.loadMinimumRemoteIndex({ provider: readOnly, manifest });
  if (plan.deviceConnection && (plan.deviceConnection.remoteStorageId !== manifest.remoteStorageId || (plan.deviceConnection.source !== "connected" && plan.deviceConnection.source !== "created"))) throw error("storage_provider_error", "Device bootstrap connection does not match connected root");
  if (plan.deviceConnection && physicalLocationFingerprint(plan.deviceConnection.location) !== plan.deviceConnection.physicalLocationFingerprint) throw error("storage_remote_location_mismatch", "Device bootstrap physical location fingerprint is invalid");
  let deviceBootstrapCommitted = false;
  if (plan.deviceBootstrap && plan.deviceConnection) {
    try {
      await plan.deviceBootstrap.upsertConnection(plan.deviceConnection);
      deviceBootstrapCommitted = true;
    } catch (caught) {
      if (storageErrorCode(caught) === "storage_remote_location_mismatch" || storageErrorCode(caught) === "storage_conflict") throw caught;
      deviceBootstrapCommitted = false;
    }
  }
  await plan.installWorkerRuntime?.({ manifest, ...(minimumRemoteIndex === undefined ? {} : { minimumRemoteIndex }) });
  return { ok: true, remoteStorageId: manifest.remoteStorageId, transactionId: manifest.initializationTransactionId, manifest, manifestFingerprint: discovered.object.fingerprint, deviceBootstrapCommitted };
}

/** 给需要密码派生根认证密钥的装配层提供最小工厂。 */
export { createHmacRemoteRootAuthenticator, deriveRemoteRootAuthenticator } from "./remoteRootProtocol.js";
