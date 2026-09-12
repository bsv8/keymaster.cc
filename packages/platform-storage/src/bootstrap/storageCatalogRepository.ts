// 本机多桶目录。
//
// 目录只保存启动所需的最小元数据和桶级密文配置，绝不保存 KeyRecord、应用
// 数据或解密后的 S3 凭据。目录写入使用同一把 Web Lock，避免多标签页的
// “读目录 → 改目录 → 无条件覆盖”互相踩写。

import type {
  StorageBucketCatalogEntryV2,
  StorageCatalogV2,
  StorageCipherEnvelopeV1,
  StorageKeyDerivationV1,
  StorageRecordV1
} from "@keymaster/contracts";
import { STORAGE_CATALOG_CHANGED_EVENT } from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageRuntimeError.js";
import { browserStorageLocks } from "../runtime/browserLocks.js";

export const STORAGE_CATALOG_KEY = "keymaster.storage.catalog.v2";
export const STORAGE_CATALOG_LOCK = "keymaster.storage.catalog.v2.lock";

export interface StorageCatalogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

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
  /** Local 或 S3；旧 OPFS 不允许新建。 */
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
  if (expectedEntry && !sameStorageCatalogEntry(current, expectedEntry)) {
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

function browserStorage(): StorageCatalogStorage {
  const storage = (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
  if (!storage) throw new StorageRuntimeError("storage_unavailable", "localStorage is unavailable");
  return storage;
}

/** 读本机目录；没有目录时返回空目录，而不是把旧业务数据当成桶。 */
export function readStorageCatalog(storage: StorageCatalogStorage = browserStorage()): StorageCatalogV2 {
  const raw = storage.getItem(STORAGE_CATALOG_KEY);
  if (!raw) return { format: "keymaster.storage.catalog", version: 2, buckets: [] };
  try { return validateStorageCatalog(JSON.parse(raw) as unknown); }
  catch (caught) {
    if (caught instanceof StorageRuntimeError) throw caught;
    throw catalogError("Storage catalog JSON is invalid");
  }
}

export function writeStorageCatalog(catalog: StorageCatalogV2, storage: StorageCatalogStorage = browserStorage()): void {
  const checked = validateStorageCatalog(catalog);
  try {
    storage.setItem(STORAGE_CATALOG_KEY, JSON.stringify(checked));
    if (typeof window !== "undefined") window.dispatchEvent(new Event(STORAGE_CATALOG_CHANGED_EVENT));
  }
  catch (caught) {
    if (caught instanceof StorageRuntimeError) throw caught;
    const name = caught && typeof caught === "object" ? (caught as { name?: unknown }).name : undefined;
    throw new StorageRuntimeError(name === "QuotaExceededError" ? "storage_limit_exceeded" : "storage_unavailable", "Storage catalog could not be saved");
  }
}

export function clearStorageCatalog(storage: StorageCatalogStorage = browserStorage()): void {
  storage.removeItem(STORAGE_CATALOG_KEY);
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
      if (catalog.buckets.some((item) => item.bucketId === checked.bucketId)) {
        throw new StorageRuntimeError("storage_conflict", "Storage bucket ID already exists");
      }
      return {
        ...catalog,
        buckets: [...catalog.buckets, checked],
        selectedBucketId: catalog.selectedBucketId ?? checked.bucketId
      };
    });
    return checked;
  }

  /** 兼容旧调用方：立即提交一个尚未带 Hold 快照的目录条目。 */
  async function createBucket(input: CreateStorageBucketInput): Promise<StorageBucketCatalogEntryV2> {
    return commitBucket(createBucketEntry(input));
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
      if (expectedEntry && !sameStorageCatalogEntry(current, expectedEntry)) {
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
    createBucket,
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
