// 本机多桶目录。
//
// 目录只保存启动所需的最小元数据和桶级密文配置，绝不保存 KeyRecord、应用
// 数据或解密后的 S3 凭据。目录写入使用同一把 Web Lock，避免多标签页的
// “读目录 → 改目录 → 无条件覆盖”互相踩写。

import type {
  DeviceBootstrapCatalogV1,
  DeviceRemoteConnectionV1,
  StorageBucketCatalogEntryV2,
  StorageCatalogV2,
  StorageCipherEnvelopeV1,
  StorageKeyDerivationV1,
  StorageRecordV1
} from "@keymaster/contracts";
import { STORAGE_CATALOG_CHANGED_EVENT } from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";
import { browserStorageLocks } from "../runtime/browserLocks.js";
import {
  DEVICE_BOOTSTRAP_LOCK,
  defaultDeviceBootstrapStorage,
  readDeviceBootstrap,
  writeDeviceBootstrap,
  type DeviceBootstrapStorage,
} from "./deviceBootstrapRepository.js";

export const STORAGE_CATALOG_LOCK = DEVICE_BOOTSTRAP_LOCK;

/** 兼容旧目录 API 的类型别名；物理设备存储由 deviceBootstrapRepository 统一访问。 */
export type StorageCatalogStorage = DeviceBootstrapStorage;

export interface StorageCatalogLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface StorageCatalogRepositoryOptions {
  storage?: StorageCatalogStorage;
  locks?: StorageCatalogLocks;
  now?: () => number;
  generateId?: () => string;
}

export interface CreateStorageBucketInput {
  /** 桶显示名称。 */
  label: string;
  /** V1 Local 或 S3 后端。 */
  backend: "local" | "s3";
  /** KeymasterHold 公共 KDF 参数。 */
  keyDerivation: StorageKeyDerivationV1;
  /** KeymasterHold 加密的连接配置记录。 */
  encryptedConfig: StorageRecordV1;
  /** 初始连接配置修订号。 */
  configRevision?: number;
}

function catalogError(message: string): StorageRuntimeError {
  return new StorageRuntimeError("storage_provider_error", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertString(value: unknown, name: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw catalogError(`${name} is invalid`);
}

function assertDerivation(value: unknown): asserts value is StorageKeyDerivationV1 {
  if (!isRecord(value)
    || value.algorithm !== "pbkdf2-hmac-sha-256"
    || value.passwordEncoding !== "utf-8"
    || value.outputLengthBits !== 256
    || typeof value.iterations !== "number"
    || !Number.isSafeInteger(value.iterations)
    || value.iterations < 100_000
    || value.iterations > 2_000_000
    || typeof value.saltB64Url !== "string"
    || value.saltB64Url.length < 8
    || value.saltB64Url.length > 128) {
    throw catalogError("Storage bucket keyDerivation is invalid");
  }
}

function assertCipher(value: unknown): asserts value is StorageCipherEnvelopeV1 {
  if (!isRecord(value)
    || value.algorithm !== "aes-gcm"
    || value.keyLengthBits !== 256
    || value.tagLengthBits !== 128
    || typeof value.ivB64Url !== "string"
    || value.ivB64Url.length < 8
    || value.ivB64Url.length > 128
    || typeof value.ciphertextAndTagB64Url !== "string"
    || value.ciphertextAndTagB64Url.length === 0
    || value.ciphertextAndTagB64Url.length > 32 * 1024) {
    throw catalogError("Storage bucket encryptedConfig is invalid");
  }
}

function assertEncryptedConfig(value: unknown): asserts value is StorageRecordV1 {
  if (!isRecord(value)) throw catalogError("Storage bucket encryptedConfig is invalid");
  assertCipher(value.cipher);
}

function validateBucket(value: unknown): StorageBucketCatalogEntryV2 {
  if (!isRecord(value)) throw catalogError("Storage bucket entry is invalid");
  assertString(value.bucketId, "bucketId", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.bucketId)) throw catalogError("bucketId is invalid");
  assertString(value.label, "label", 128);
  if (value.backend !== "local" && value.backend !== "s3") throw catalogError("Storage bucket backend is invalid");
  for (const [name, field] of [["configRevision", value.configRevision], ["snapshotRevision", value.snapshotRevision], ["createdAt", value.createdAt], ["updatedAt", value.updatedAt]] as const) {
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) throw catalogError(`Storage bucket ${name} is invalid`);
  }
  assertDerivation(value.keyDerivation);
  assertEncryptedConfig(value.encryptedConfig);
  const configRevision = value.configRevision as number;
  const snapshotRevision = value.snapshotRevision as number;
  const createdAt = value.createdAt as number;
  const updatedAt = value.updatedAt as number;
  return {
    bucketId: value.bucketId,
    label: value.label,
    backend: value.backend,
    configRevision,
    keyDerivation: { ...value.keyDerivation },
    encryptedConfig: { cipher: { ...value.encryptedConfig.cipher } },
    snapshotRevision,
    createdAt,
    updatedAt
  };
}

export function validateStorageCatalog(value: unknown): StorageCatalogV2 {
  if (!isRecord(value) || value.format !== "keymaster.storage.catalog" || value.version !== 2 || !Array.isArray(value.buckets)) {
    throw catalogError("Storage catalog format is invalid");
  }
  const buckets = value.buckets.map(validateBucket);
  const ids = new Set<string>();
  for (const bucket of buckets) {
    if (ids.has(bucket.bucketId)) throw catalogError("Storage catalog contains duplicate bucket IDs");
    ids.add(bucket.bucketId);
  }
  if (value.selectedBucketId !== undefined) {
    assertString(value.selectedBucketId, "selectedBucketId", 128);
    if (!ids.has(value.selectedBucketId)) throw catalogError("Storage catalog selected bucket does not exist");
  }
  return {
    format: "keymaster.storage.catalog",
    version: 2,
    ...(value.selectedBucketId === undefined ? {} : { selectedBucketId: value.selectedBucketId }),
    buckets
  };
}

function cloneCatalog(value: StorageCatalogV2): StorageCatalogV2 {
  return validateStorageCatalog(structuredClone(value));
}

/**
 * 删除本机目录中的连接项；调用方必须已经在目录锁内读取了 catalog。
 * 普通删除和“销毁数据后的最后一步”共用这段 CAS/当前桶保护逻辑，避免
 * 两条路径对 selectedBucketId 的语义不一致。
 */
export function removeStorageCatalogEntry(
  catalog: StorageCatalogV2,
  bucketId: string,
  expectedEntry?: StorageBucketCatalogEntryV2,
): StorageCatalogV2 {
  const current = catalog.buckets.find((bucket) => bucket.bucketId === bucketId);
  if (!current) throw new StorageRuntimeError("storage_not_found", "Storage bucket was not found");
  // Device bootstrap deliberately does not persist remote revision/cache
  // fields. Compare only the authenticated device projection or every
  // non-zero remote revision would look stale after a fresh catalog read.
  if (expectedEntry && !sameStorageCatalogDeviceProjection(current, expectedEntry)) {
    throw new StorageRuntimeError("storage_conflict", "Storage bucket changed concurrently; reload and retry");
  }
  if (catalog.selectedBucketId === bucketId) {
    throw new StorageRuntimeError("storage_forbidden", "The current storage bucket cannot be removed; switch buckets first");
  }
  return { ...catalog, buckets: catalog.buckets.filter((bucket) => bucket.bucketId !== bucketId) };
}

/**
 * 比较目录条目的持久化语义，而不是依赖 JSON 字段顺序。
 * Worker 改密通过页面桥做目录 CAS 时使用它，避免 SDK canonical JSON
 * 或 structured clone 改变字段顺序后误判为并发冲突。
 */
export function sameStorageCatalogEntry(left: StorageBucketCatalogEntryV2, right: StorageBucketCatalogEntryV2): boolean {
  return left.bucketId === right.bucketId
    && left.label === right.label
    && left.backend === right.backend
    && left.configRevision === right.configRevision
    && left.keyDerivation.algorithm === right.keyDerivation.algorithm
    && left.keyDerivation.passwordEncoding === right.keyDerivation.passwordEncoding
    && left.keyDerivation.iterations === right.keyDerivation.iterations
    && left.keyDerivation.outputLengthBits === right.keyDerivation.outputLengthBits
    && left.keyDerivation.saltB64Url === right.keyDerivation.saltB64Url
    && left.encryptedConfig.cipher.algorithm === right.encryptedConfig.cipher.algorithm
    && left.encryptedConfig.cipher.keyLengthBits === right.encryptedConfig.cipher.keyLengthBits
    && left.encryptedConfig.cipher.ivB64Url === right.encryptedConfig.cipher.ivB64Url
    && left.encryptedConfig.cipher.tagLengthBits === right.encryptedConfig.cipher.tagLengthBits
    && left.encryptedConfig.cipher.ciphertextAndTagB64Url === right.encryptedConfig.cipher.ciphertextAndTagB64Url
    && left.snapshotRevision === right.snapshotRevision
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function browserStorage(): StorageCatalogStorage { return defaultDeviceBootstrapStorage(); }

function catalogEntryFromConnection(connection: DeviceRemoteConnectionV1): StorageBucketCatalogEntryV2 {
  return {
    bucketId: connection.remoteStorageId,
    label: connection.displayName,
    backend: connection.providerId,
    // Remote revisions are intentionally absent from device bootstrap. These
    // values are non-authoritative placeholders replaced from the authenticated
    // Hold before a Worker runtime is installed.
    configRevision: 0,
    keyDerivation: structuredClone(connection.keyDerivation),
    encryptedConfig: structuredClone(connection.encryptedConfig),
    snapshotRevision: 0,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export function sameStorageCatalogDeviceProjection(left: StorageBucketCatalogEntryV2, right: StorageBucketCatalogEntryV2): boolean {
  return left.bucketId === right.bucketId
    && left.label === right.label
    && left.backend === right.backend
    && left.keyDerivation.algorithm === right.keyDerivation.algorithm
    && left.keyDerivation.passwordEncoding === right.keyDerivation.passwordEncoding
    && left.keyDerivation.iterations === right.keyDerivation.iterations
    && left.keyDerivation.outputLengthBits === right.keyDerivation.outputLengthBits
    && left.keyDerivation.saltB64Url === right.keyDerivation.saltB64Url
    && JSON.stringify(left.encryptedConfig) === JSON.stringify(right.encryptedConfig);
}

function catalogFromDeviceBootstrap(catalog: DeviceBootstrapCatalogV1 | null): StorageCatalogV2 {
  if (!catalog) return { format: "keymaster.storage.catalog", version: 2, buckets: [] };
  return {
    format: "keymaster.storage.catalog",
    version: 2,
    ...(catalog.selectedRemoteStorageId === undefined ? {} : { selectedBucketId: catalog.selectedRemoteStorageId }),
    buckets: catalog.connections.map(catalogEntryFromConnection),
  };
}

/** 读本机目录；没有目录时返回空目录，而不是把旧业务数据当成桶。 */
export function readStorageCatalog(storage: StorageCatalogStorage = browserStorage()): StorageCatalogV2 {
  return catalogFromDeviceBootstrap(readDeviceBootstrap(storage));
}

export function writeStorageCatalog(catalog: StorageCatalogV2, storage: StorageCatalogStorage = browserStorage()): void {
  const checked = validateStorageCatalog(catalog);
  try {
    const current = readDeviceBootstrap(storage);
    if (!current) {
      if (checked.buckets.length === 0) return;
      throw new StorageRuntimeError("storage_conflict", "Device connections must be authenticated before they can appear in the catalog view");
    }
    const byId = new Map(current.connections.map((connection) => [connection.remoteStorageId, connection] as const));
    const connections = checked.buckets.map((entry) => {
      const existing = byId.get(entry.bucketId);
      if (!existing) throw new StorageRuntimeError("storage_conflict", "Catalog entry has no authenticated device connection");
      if (existing.providerId !== entry.backend) throw new StorageRuntimeError("storage_remote_location_mismatch", "Catalog backend does not match the authenticated device connection");
      return {
        ...existing,
        displayName: entry.label,
        keyDerivation: structuredClone(entry.keyDerivation),
        encryptedConfig: structuredClone(entry.encryptedConfig),
        updatedAt: entry.updatedAt,
      } satisfies DeviceRemoteConnectionV1;
    });
    writeDeviceBootstrap({
      ...current,
      connections,
      ...(checked.selectedBucketId === undefined ? { selectedRemoteStorageId: undefined } : { selectedRemoteStorageId: checked.selectedBucketId }),
    }, storage);
    if (typeof window !== "undefined") window.dispatchEvent(new Event(STORAGE_CATALOG_CHANGED_EVENT));
  }
  catch (caught) {
    if (caught instanceof StorageRuntimeError) throw caught;
    const name = caught && typeof caught === "object" ? (caught as { name?: unknown }).name : undefined;
    throw new StorageRuntimeError(name === "QuotaExceededError" ? "storage_limit_exceeded" : "storage_unavailable", "Storage catalog could not be saved");
  }
}

export function clearStorageCatalog(storage: StorageCatalogStorage = browserStorage()): void {
  const current = readDeviceBootstrap(storage);
  if (!current) return;
  const next = { ...current, connections: [] } as DeviceBootstrapCatalogV1;
  delete next.selectedRemoteStorageId;
  writeDeviceBootstrap(next, storage);
}

/** 目录修改优先使用 Web Locks；HTTP fallback 只保证当前页面内串行。 */
export function createStorageCatalogRepository(options: StorageCatalogRepositoryOptions = {}) {
  const storage = options.storage ?? browserStorage();
  const locks = options.locks ?? browserStorageLocks();
  const now = options.now ?? (() => Date.now());
  const generateId = options.generateId ?? (() => crypto.randomUUID());

  async function withCatalogLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!locks) throw new StorageRuntimeError("storage_unavailable", "Storage catalog locking is unavailable");
    return locks.request(STORAGE_CATALOG_LOCK, operation);
  }

  async function mutate(mutator: (catalog: StorageCatalogV2) => StorageCatalogV2 | Promise<StorageCatalogV2>): Promise<StorageCatalogV2> {
    return withCatalogLock(async () => {
      const current = readStorageCatalog(storage);
      const next = await mutator(cloneCatalog(current));
      writeStorageCatalog(next, storage);
      return cloneCatalog(next);
    });
  }

  /**
   * 只在内存中构造一个新的目录条目。
   *
   * 创建/导入流程会先用这个稳定 bucketId 建 Provider 并提交首个 Hold
   * 快照，最后才调用 commitBucket 一次性把条目和 selectedBucketId 写入
   * 目录。这样其他标签页永远看不到“尚未初始化”的桶。
   */
  function createBucketEntry(input: CreateStorageBucketInput): StorageBucketCatalogEntryV2 {
    const nowValue = now();
    const bucket: StorageBucketCatalogEntryV2 = {
      bucketId: generateId().replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 128) || "bucket",
      label: input.label,
      backend: input.backend,
      configRevision: input.configRevision ?? 1,
      keyDerivation: { ...input.keyDerivation },
      encryptedConfig: { cipher: { ...input.encryptedConfig.cipher } },
      snapshotRevision: 0,
      createdAt: nowValue,
      updatedAt: nowValue
    };
    validateBucket(bucket);
    return cloneCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [bucket] }).buckets[0]!;
  }

  /** 在一次目录 CAS 中加入一个已完成初始化的条目，并按需选择首桶。 */
  async function commitBucket(entry: StorageBucketCatalogEntryV2): Promise<StorageBucketCatalogEntryV2> {
    const checked = validateBucket(entry);
    await mutate((catalog) => {
      const existing = catalog.buckets.find((item) => item.bucketId === checked.bucketId);
      if (!existing) throw new StorageRuntimeError("storage_conflict", "Storage bucket has no authenticated device connection");
      if (!sameStorageCatalogDeviceProjection(existing, checked)) throw new StorageRuntimeError("storage_conflict", "Device connection changed before catalog commit");
      return {
        ...catalog,
        buckets: catalog.buckets.map((item) => item.bucketId === checked.bucketId ? checked : item),
        selectedBucketId: catalog.selectedBucketId ?? checked.bucketId
      };
    });
    return checked;
  }

  async function updateBucket(
    bucketId: string,
    update: Partial<Pick<StorageBucketCatalogEntryV2, "label" | "backend" | "configRevision" | "keyDerivation" | "encryptedConfig" | "snapshotRevision">>,
    /** 读取条目的完整版本；提供后会在同一把 Web Lock 内执行 CAS。 */
    expectedEntry?: StorageBucketCatalogEntryV2
  ): Promise<StorageBucketCatalogEntryV2> {
    let updated: StorageBucketCatalogEntryV2 | undefined;
    await mutate((catalog) => {
      const index = catalog.buckets.findIndex((item) => item.bucketId === bucketId);
      if (index < 0) throw new StorageRuntimeError("storage_not_found", "Storage bucket was not found");
      const current = catalog.buckets[index]!;
      if (expectedEntry && !sameStorageCatalogDeviceProjection(current, expectedEntry)) {
        throw new StorageRuntimeError("storage_conflict", "Storage bucket changed concurrently; reload and retry");
      }
      updated = validateBucket({ ...current, ...update, bucketId, updatedAt: now() });
      const buckets = [...catalog.buckets];
      buckets[index] = updated;
      return { ...catalog, buckets };
    });
    if (!updated) throw catalogError("Storage bucket update did not produce a bucket");
    return cloneCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [updated] }).buckets[0]!;
  }

  return {
    read: () => readStorageCatalog(storage),
    write: (catalog: StorageCatalogV2) => writeStorageCatalog(catalog, storage),
    mutate,
    createBucketEntry,
    commitBucket,
    updateBucket,
    selectBucket: (bucketId: string) => mutate((catalog) => {
      if (!catalog.buckets.some((bucket) => bucket.bucketId === bucketId)) throw new StorageRuntimeError("storage_not_found", "Storage bucket was not found");
      return { ...catalog, selectedBucketId: bucketId };
    }),
    removeBucket: (bucketId: string, expectedEntry?: StorageBucketCatalogEntryV2) => mutate((catalog) => removeStorageCatalogEntry(catalog, bucketId, expectedEntry)),
    /** 在已持有目录锁时运行跨 Provider 的受保护操作（例如销毁数据）。 */
    withCatalogLock,
  };
}
