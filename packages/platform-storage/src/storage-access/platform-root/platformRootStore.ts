import type {
  OwnerAppStore,
  KeyValueStore,
  OwnerStorageActivation,
  PlatformRootStore,
  StorageBucketProvider,
  StorageBucketRef,
  StorageNamespaceBinding
} from "@keymaster/contracts";
import { buildStorageNamespaceRoot, validateOwnerPublicKeyHex, validatePlatformStorageId, validatePluginStorageDeclaration } from "@keymaster/contracts";
import { createKeyValueStore } from "../../kv-engine/partitionedKvEngine.js";
import { StorageRuntimeError } from "../../runtime/storageRuntimeError.js";
import { createOwnerAppStore } from "../owner-app/ownerAppStore.js";

export interface PlatformRootStoreOptions {
  /** 当前 Provider；只由 Coordinator 注入。 */
  provider: StorageBucketProvider;
  /** 当前抽象桶引用。 */
  bucket: StorageBucketRef;
  /** 只允许平台内部使用的 applicationStorageId。 */
  platformApplicationStorageIds?: readonly string[];
  /** 切桶/切 Key/切 keyspace 世代后让旧句柄 fail closed。 */
  isCurrent?: (binding: { ownerPublicKeyHex?: string; bucketGeneration: number; keyspaceGeneration?: number }) => boolean;
}

const DEFAULT_PLATFORM_IDS = ["keys", "settings", "logs", "protocol", "session", "storage", "coordinator"] as const;
const BUCKET_SCHEMA_PATH = ".keymaster/schema";
const BUCKET_SCHEMA_FORMAT = "keymaster.bucket-schema";
const BUCKET_SCHEMA_FORMAT_VERSION = 1;
const OWNER_LIFECYCLE_PREFIX = ".keymaster/owners/";
const OWNER_LIFECYCLE_FORMAT = "keymaster.owner-lifecycle";
const OWNER_LIFECYCLE_FORMAT_VERSION = 1;
const OWNER_DELETE_MAX_PASSES = 32;
const OWNER_DELETE_REQUIRED_EMPTY_PASSES = 2;
const OWNER_DELETE_DRAIN_TIMEOUT_MS = 5_000;
const OWNER_DELETE_DRAIN_POLL_MS = 10;

interface BucketSchemaRecord {
  /** 桶级 schema 记录格式版本，不是插件 namespace 的 schemaVersion。 */
  format: typeof BUCKET_SCHEMA_FORMAT;
  version: typeof BUCKET_SCHEMA_FORMAT_VERSION;
  /** 每个逻辑目录首次打开时锁定的 schemaVersion。 */
  namespaces: Record<string, number>;
}

type OwnerLifecycleStatus = "active" | "deleting" | "deleted";

interface OwnerLifecycleRecord {
  /** owner 生命周期记录格式版本。 */
  format: typeof OWNER_LIFECYCLE_FORMAT;
  version: typeof OWNER_LIFECYCLE_FORMAT_VERSION;
  /** 记录所属 owner，始终为规范化小写公钥。 */
  ownerPublicKeyHex: string;
  /** 同一公钥重新导入后的不可复用世代。 */
  generation: number;
  /** active：允许打开；deleting：拒绝新请求；deleted：只能显式重新激活。 */
  status: OwnerLifecycleStatus;
  /** 已经通过生命周期 CAS、仍在真实 Provider 操作中的请求数。 */
  activeOperations: number;
  /** 正在执行 owner 清理的删除事务数；为 0 才能发布 deleted。 */
  deletionOperations: number;
  /** 最近一次 CAS 状态变更时间。 */
  updatedAt: number;
}

interface OwnerLifecycleObject {
  record: OwnerLifecycleRecord;
  etag?: string;
}

function namespaceSchemaKey(binding: Pick<StorageNamespaceBinding, "scope" | "applicationStorageId" | "ownerPublicKeyHex">): string {
  return [binding.scope, binding.ownerPublicKeyHex ?? "", binding.applicationStorageId].join("|");
}

function decodeBucketSchema(bytes: Uint8Array): BucketSchemaRecord {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<BucketSchemaRecord>;
    if (value.format !== BUCKET_SCHEMA_FORMAT || value.version !== BUCKET_SCHEMA_FORMAT_VERSION || !value.namespaces || typeof value.namespaces !== "object") {
      throw new Error("schema format mismatch");
    }
    return { format: BUCKET_SCHEMA_FORMAT, version: BUCKET_SCHEMA_FORMAT_VERSION, namespaces: { ...value.namespaces } };
  } catch {
    throw new StorageRuntimeError("storage_provider_error", "Storage bucket schema is invalid or incompatible");
  }
}

function encodeBucketSchema(schema: BucketSchemaRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(schema));
}

function ownerLifecyclePath(ownerPublicKeyHex: string): string {
  return `${OWNER_LIFECYCLE_PREFIX}${validateOwnerPublicKeyHex(ownerPublicKeyHex)}`;
}

function ownerSchemaPrefix(ownerPublicKeyHex: string): string {
  return `key|${validateOwnerPublicKeyHex(ownerPublicKeyHex)}|`;
}

function isStorageConflict(error: unknown): boolean {
  return error instanceof StorageRuntimeError && error.code === "storage_conflict"
    || Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "storage_conflict");
}

function decodeOwnerLifecycle(bytes: Uint8Array, expectedOwner: string): OwnerLifecycleRecord {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<OwnerLifecycleRecord>;
    const ownerPublicKeyHex = validateOwnerPublicKeyHex(String(value.ownerPublicKeyHex ?? ""));
    const generation = value.generation;
    const status = value.status;
    const updatedAt = value.updatedAt;
    // 兼容本轮实现之前已经创建的 v1 owner 记录；缺失字段表示没有
    // 持久化请求计数，下一次状态写入会补齐它。
    const activeOperations = value.activeOperations ?? 0;
    const deletionOperations = value.deletionOperations ?? 0;
    if (
      value.format !== OWNER_LIFECYCLE_FORMAT ||
      value.version !== OWNER_LIFECYCLE_FORMAT_VERSION ||
      ownerPublicKeyHex !== expectedOwner ||
      (status !== "active" && status !== "deleting" && status !== "deleted") ||
      !Number.isSafeInteger(generation) ||
      typeof generation !== "number" ||
      generation < 1 ||
      typeof updatedAt !== "number" ||
      !Number.isFinite(updatedAt) ||
      !Number.isSafeInteger(activeOperations) ||
      activeOperations < 0 ||
      !Number.isSafeInteger(deletionOperations) ||
      deletionOperations < 0
    ) throw new Error("owner lifecycle record is invalid");
    return {
      format: OWNER_LIFECYCLE_FORMAT,
      version: OWNER_LIFECYCLE_FORMAT_VERSION,
      ownerPublicKeyHex,
      generation,
      status,
      activeOperations,
      deletionOperations,
      updatedAt
    };
  } catch {
    throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle record is invalid or incompatible");
  }
}

function encodeOwnerLifecycle(record: OwnerLifecycleRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

async function readOwnerLifecycle(provider: StorageBucketProvider, ownerPublicKeyHex: string): Promise<OwnerLifecycleObject | undefined> {
  const owner = validateOwnerPublicKeyHex(ownerPublicKeyHex);
  const object = await provider.get(ownerLifecyclePath(owner));
  return object ? { record: decodeOwnerLifecycle(object.bytes, owner), etag: object.etag } : undefined;
}

function ownerLifecycleRecord(ownerPublicKeyHex: string, generation: number, status: OwnerLifecycleStatus, deletionOperations = 0): OwnerLifecycleRecord {
  return {
    format: OWNER_LIFECYCLE_FORMAT,
    version: OWNER_LIFECYCLE_FORMAT_VERSION,
    ownerPublicKeyHex: validateOwnerPublicKeyHex(ownerPublicKeyHex),
    generation,
    status,
    activeOperations: 0,
    deletionOperations,
    updatedAt: Date.now()
  };
}

function requireOwnerLifecycleEtag(object: OwnerLifecycleObject): string {
  if (!object.etag) throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle CAS is unavailable");
  return object.etag;
}

function assertOwnerLifecycleUsable(record: OwnerLifecycleRecord): void {
  if (record.status === "active") return;
  if (record.status === "deleting") throw new StorageRuntimeError("storage_unavailable", "Owner storage is being deleted");
  throw new StorageRuntimeError("storage_unavailable", "Owner storage has been deleted and must be explicitly reactivated");
}

async function ensureOwnerLifecycleActive(provider: StorageBucketProvider, ownerPublicKeyHex: string): Promise<OwnerLifecycleRecord> {
  const owner = validateOwnerPublicKeyHex(ownerPublicKeyHex);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await readOwnerLifecycle(provider, owner);
    if (!current) {
      try {
        const initial = ownerLifecycleRecord(owner, 1, "active");
        await provider.put(ownerLifecyclePath(owner), encodeOwnerLifecycle(initial), { ifNoneMatch: "*" });
        return initial;
      } catch (error) {
        if (isStorageConflict(error)) continue;
        throw error;
      }
    }
    assertOwnerLifecycleUsable(current.record);
    return current.record;
  }
  throw new StorageRuntimeError("storage_conflict", "Storage owner lifecycle changed concurrently");
}

async function activateOwnerLifecycle(provider: StorageBucketProvider, ownerPublicKeyHex: string): Promise<OwnerStorageActivation> {
  const owner = validateOwnerPublicKeyHex(ownerPublicKeyHex);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await readOwnerLifecycle(provider, owner);
    if (!current) {
      try {
        const initial = ownerLifecycleRecord(owner, 1, "active");
        await provider.put(ownerLifecyclePath(owner), encodeOwnerLifecycle(initial), { ifNoneMatch: "*" });
        return { generation: initial.generation };
      } catch (error) {
        if (isStorageConflict(error)) continue;
        throw error;
      }
    }
    if (current.record.status === "active") return { generation: current.record.generation };
    if (current.record.status === "deleting") throw new StorageRuntimeError("storage_unavailable", "Owner storage is being deleted");
    const next = ownerLifecycleRecord(owner, current.record.generation + 1, "active");
    try {
      await provider.put(ownerLifecyclePath(owner), encodeOwnerLifecycle(next), { ifMatch: requireOwnerLifecycleEtag(current) });
      return { generation: next.generation };
    } catch (error) {
      if (isStorageConflict(error)) continue;
      throw error;
    }
  }
  throw new StorageRuntimeError("storage_conflict", "Storage owner lifecycle changed concurrently");
}

async function assertOwnerLifecycleCurrent(
  provider: StorageBucketProvider,
  ownerPublicKeyHex: string,
  expectedGeneration?: number
): Promise<void> {
  const owner = validateOwnerPublicKeyHex(ownerPublicKeyHex);
  const current = await readOwnerLifecycle(provider, owner);
  if (!current) throw new StorageRuntimeError("storage_unavailable", "Owner storage lifecycle is unavailable");
  assertOwnerLifecycleUsable(current.record);
  if (expectedGeneration !== undefined && current.record.generation !== expectedGeneration) {
    throw new StorageRuntimeError("storage_unavailable", "Owner storage generation changed");
  }
}

type OwnerStorageOperationRelease = () => Promise<void>;
interface OwnerDeletionLease {
  record: OwnerLifecycleRecord;
  release: OwnerStorageOperationRelease;
}

/**
 * 为一次真实 Provider 操作申请持久化 owner lease。
 *
 * `activeOperations` 让删除不仅能拒绝新请求，还能等待其它设备上已经
 * 通过 active 检查的请求完成；否则迟到 PUT 可能在最后一次扫描之后落盘。
 */
async function acquireOwnerStorageOperation(
  provider: StorageBucketProvider,
  ownerPublicKeyHex: string,
  expectedGeneration?: number
): Promise<OwnerStorageOperationRelease> {
  const owner = validateOwnerPublicKeyHex(ownerPublicKeyHex);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const current = await readOwnerLifecycle(provider, owner);
    if (!current) throw new StorageRuntimeError("storage_unavailable", "Owner storage lifecycle is unavailable");
    assertOwnerLifecycleUsable(current.record);
    if (expectedGeneration !== undefined && current.record.generation !== expectedGeneration) {
      throw new StorageRuntimeError("storage_unavailable", "Owner storage generation changed");
    }
    if (current.record.activeOperations >= Number.MAX_SAFE_INTEGER) {
      throw new StorageRuntimeError("storage_limit_exceeded", "Owner storage has too many active operations");
    }
    const next: OwnerLifecycleRecord = {
      ...current.record,
      activeOperations: current.record.activeOperations + 1,
      updatedAt: Date.now()
    };
    try {
      await provider.put(ownerLifecyclePath(owner), encodeOwnerLifecycle(next), { ifMatch: requireOwnerLifecycleEtag(current) });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        for (let releaseAttempt = 0; releaseAttempt < 16; releaseAttempt += 1) {
          const latest = await readOwnerLifecycle(provider, owner);
          // 只有同一世代的 active/deleting 记录拥有这笔计数。正常流程
          // 不会在计数非零时进入 deleted；这些分支只保护崩溃恢复/旧句柄。
          if (!latest || latest.record.generation !== next.generation || latest.record.status === "deleted" || latest.record.activeOperations === 0) return;
          const releasedRecord: OwnerLifecycleRecord = {
            ...latest.record,
            activeOperations: latest.record.activeOperations - 1,
            updatedAt: Date.now()
          };
          try {
            await provider.put(ownerLifecyclePath(owner), encodeOwnerLifecycle(releasedRecord), { ifMatch: requireOwnerLifecycleEtag(latest) });
            return;
          } catch (error) {
            if (isStorageConflict(error)) continue;
            throw error;
          }
        }
        throw new StorageRuntimeError("storage_conflict", "Storage owner operation lease changed concurrently");
      };
    } catch (error) {
      if (isStorageConflict(error)) continue;
      throw error;
    }
  }
  throw new StorageRuntimeError("storage_conflict", "Storage owner operation lease changed concurrently");
}

/**
 * 生成一个删除事务的持久化 release 函数。
 *
 * 删除者本身不能使用普通 owner operation lease（deleting 状态会拒绝新
 * 业务请求），所以单独记录 deletionOperations，防止两个协调器同时清理
 * 时其中一个先发布 deleted，另一个仍拿着旧列表去删除新 generation。
 */
function createOwnerDeletionRelease(
  provider: StorageBucketProvider,
  ownerPublicKeyHex: string,
  generation: number
): OwnerStorageOperationRelease {
  const owner = validateOwnerPublicKeyHex(ownerPublicKeyHex);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const latest = await readOwnerLifecycle(provider, owner);
      if (!latest || latest.record.generation !== generation || latest.record.status === "deleted" || latest.record.deletionOperations === 0) return;
      if (latest.record.status !== "deleting") throw new StorageRuntimeError("storage_unavailable", "Owner deletion lifecycle changed while releasing");
      const next: OwnerLifecycleRecord = {
        ...latest.record,
        deletionOperations: latest.record.deletionOperations - 1,
        updatedAt: Date.now()
      };
      try {
        await provider.put(ownerLifecyclePath(owner), encodeOwnerLifecycle(next), { ifMatch: requireOwnerLifecycleEtag(latest) });
        return;
      } catch (error) {
        if (isStorageConflict(error)) continue;
        throw error;
      }
    }
    throw new StorageRuntimeError("storage_conflict", "Storage owner deletion lease changed concurrently");
  };
}

async function acquireOwnerDeletionOperation(
  provider: StorageBucketProvider,
  ownerPublicKeyHex: string,
  generation: number
): Promise<OwnerDeletionLease> {
  const owner = validateOwnerPublicKeyHex(ownerPublicKeyHex);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const current = await readOwnerLifecycle(provider, owner);
    if (!current) throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle disappeared during deletion");
    if (current.record.status === "deleted") return { record: current.record, release: async () => undefined };
    if (current.record.status !== "deleting" || current.record.generation !== generation) {
      throw new StorageRuntimeError("storage_unavailable", "Storage owner lifecycle changed during deletion");
    }
    if (current.record.deletionOperations >= Number.MAX_SAFE_INTEGER) {
      throw new StorageRuntimeError("storage_limit_exceeded", "Storage owner has too many concurrent deletion operations");
    }
    const next: OwnerLifecycleRecord = {
      ...current.record,
      deletionOperations: current.record.deletionOperations + 1,
      updatedAt: Date.now()
    };
    try {
      await provider.put(ownerLifecyclePath(owner), encodeOwnerLifecycle(next), { ifMatch: requireOwnerLifecycleEtag(current) });
      return { record: next, release: createOwnerDeletionRelease(provider, owner, generation) };
    } catch (error) {
      if (isStorageConflict(error)) continue;
      throw error;
    }
  }
  throw new StorageRuntimeError("storage_conflict", "Storage owner deletion lease changed concurrently");
}

async function waitForOwnerStorageOperations(
  provider: StorageBucketProvider,
  ownerPublicKeyHex: string,
  generation: number
): Promise<boolean> {
  const deadline = Date.now() + OWNER_DELETE_DRAIN_TIMEOUT_MS;
  while (true) {
    const current = await readOwnerLifecycle(provider, ownerPublicKeyHex);
    if (!current) throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle disappeared during deletion");
    if (current.record.status === "deleted" || (current.record.status === "active" && current.record.generation !== generation)) return false;
    if (current.record.status !== "deleting" || current.record.generation !== generation) throw new StorageRuntimeError("storage_unavailable", "Storage owner lifecycle changed during deletion");
    if (current.record.activeOperations === 0) return true;
    if (Date.now() >= deadline) throw new StorageRuntimeError("storage_unavailable", "Owner storage requests did not drain before deletion timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, OWNER_DELETE_DRAIN_POLL_MS));
  }
}

async function waitForOwnerDeletionOperations(
  provider: StorageBucketProvider,
  ownerPublicKeyHex: string,
  generation: number
): Promise<boolean> {
  const deadline = Date.now() + OWNER_DELETE_DRAIN_TIMEOUT_MS;
  while (true) {
    const current = await readOwnerLifecycle(provider, ownerPublicKeyHex);
    if (!current) throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle disappeared during deletion");
    if (current.record.status === "deleted" || (current.record.status === "active" && current.record.generation !== generation)) return false;
    if (current.record.status !== "deleting" || current.record.generation !== generation) throw new StorageRuntimeError("storage_unavailable", "Storage owner lifecycle changed during deletion");
    if (current.record.deletionOperations === 0) return true;
    if (Date.now() >= deadline) throw new StorageRuntimeError("storage_unavailable", "Concurrent owner deletion operations did not drain before deletion timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, OWNER_DELETE_DRAIN_POLL_MS));
  }
}

function ownerFromProviderPath(path: string): string | undefined {
  const match = /^(02|03)[0-9a-f]{64}(?:\/|$)/u.exec(path);
  return match ? path.slice(0, 66) : undefined;
}

/**
 * 给文件运行时使用的 Provider guard。
 *
 * 文件 API 不经过 K-V engine，因此不能只依赖 owner 句柄的异步栅栏。
 * 这个适配器在每次 owner 物理读写前后检查桶级生命周期记录；dispose
 * 只关闭适配器本身，不关闭被 K-V/其它 runtime 共享的真实 Provider。
 */
export function createOwnerLifecycleGuardedProvider(provider: StorageBucketProvider): StorageBucketProvider {
  const withPathOwnerLease = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
    const owner = ownerFromProviderPath(path);
    if (!owner) return operation();
    const release = await acquireOwnerStorageOperation(provider, owner);
    try {
      const result = await operation();
      await assertOwnerLifecycleCurrent(provider, owner);
      return result;
    } finally {
      await release();
    }
  };
  return {
    provider: provider.provider,
    bucketId: provider.bucketId,
    probe: (signal) => provider.probe(signal),
    async get(path, input) {
      return withPathOwnerLease(path, () => provider.get(path, input));
    },
    async list(input = {}) {
      return withPathOwnerLease(input.prefix ?? "", () => provider.list(input));
    },
    async put(path, bytes, condition) {
      return withPathOwnerLease(path, () => provider.put(path, bytes, condition));
    },
    async delete(path, input) {
      await withPathOwnerLease(path, () => provider.delete(path, input));
    },
    dispose() { /* shared Provider remains owned by the Coordinator Root */ }
  };
}

async function beginOwnerDeletion(provider: StorageBucketProvider, ownerPublicKeyHex: string): Promise<OwnerDeletionLease> {
  const owner = validateOwnerPublicKeyHex(ownerPublicKeyHex);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await readOwnerLifecycle(provider, owner);
    if (!current) {
      // 首次发现旧 owner 数据时也必须把当前删除者计入持久化 lease，
      // 否则另一个协调器可能在本方第一次扫描后抢先发布 deleted。
      const deleting = ownerLifecycleRecord(owner, 1, "deleting", 1);
      try {
        await provider.put(ownerLifecyclePath(owner), encodeOwnerLifecycle(deleting), { ifNoneMatch: "*" });
        return { record: deleting, release: createOwnerDeletionRelease(provider, owner, deleting.generation) };
      } catch (error) {
        if (isStorageConflict(error)) continue;
        throw error;
      }
    }
    if (current.record.status === "deleted") return { record: current.record, release: async () => undefined };
    if (current.record.status === "deleting") return acquireOwnerDeletionOperation(provider, owner, current.record.generation);
    if (current.record.deletionOperations !== 0) throw new StorageRuntimeError("storage_provider_error", "Active owner has deletion operations");
    const deleting: OwnerLifecycleRecord = {
      ...current.record,
      status: "deleting",
      deletionOperations: 1,
      updatedAt: Date.now()
    };
    try {
      await provider.put(ownerLifecyclePath(owner), encodeOwnerLifecycle(deleting), { ifMatch: requireOwnerLifecycleEtag(current) });
      return { record: deleting, release: createOwnerDeletionRelease(provider, owner, deleting.generation) };
    } catch (error) {
      if (isStorageConflict(error)) continue;
      throw error;
    }
  }
  throw new StorageRuntimeError("storage_conflict", "Storage owner lifecycle changed concurrently");
}

async function markOwnerDeleted(provider: StorageBucketProvider, ownerPublicKeyHex: string, generation: number): Promise<void> {
  const owner = validateOwnerPublicKeyHex(ownerPublicKeyHex);
  const deadline = Date.now() + OWNER_DELETE_DRAIN_TIMEOUT_MS;
  for (;;) {
    if (Date.now() >= deadline) throw new StorageRuntimeError("storage_unavailable", "Owner deletion did not finalize before timeout");
    const current = await readOwnerLifecycle(provider, owner);
    if (!current) throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle disappeared during deletion");
    if (current.record.status === "deleted") return;
    if (current.record.status === "active" && current.record.generation !== generation) return;
    if (current.record.status !== "deleting" || current.record.generation !== generation) {
      throw new StorageRuntimeError("storage_unavailable", "Storage owner lifecycle changed during deletion");
    }
    if (current.record.activeOperations !== 0) throw new StorageRuntimeError("storage_unavailable", "Owner storage requests are still active");
    if (current.record.deletionOperations !== 0) {
      if (Date.now() >= deadline) throw new StorageRuntimeError("storage_unavailable", "Owner deletion operations did not drain before deletion timeout");
      await new Promise<void>((resolve) => setTimeout(resolve, OWNER_DELETE_DRAIN_POLL_MS));
      continue;
    }
    const deleted = ownerLifecycleRecord(owner, generation, "deleted");
    try {
      await provider.put(ownerLifecyclePath(owner), encodeOwnerLifecycle(deleted), { ifMatch: requireOwnerLifecycleEtag(current) });
      return;
    } catch (error) {
      if (isStorageConflict(error)) continue;
      throw error;
    }
  }
}

async function listOwnerObjects(provider: StorageBucketProvider, ownerPublicKeyHex: string): Promise<Array<{ path: string; etag?: string }>> {
  const root = `${validateOwnerPublicKeyHex(ownerPublicKeyHex)}/`;
  const objects: Array<{ path: string; etag?: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await provider.list({ prefix: root, cursor, limit: 1000 });
    objects.push(...page.objects.map((object) => ({ path: object.path, etag: object.etag })));
    cursor = page.nextCursor;
  } while (cursor);
  return objects;
}

async function deleteOwnerObjectsUntilEmpty(provider: StorageBucketProvider, ownerPublicKeyHex: string, generation: number): Promise<boolean> {
  let emptyPasses = 0;
  for (let pass = 0; pass < OWNER_DELETE_MAX_PASSES; pass += 1) {
    const lifecycle = await readOwnerLifecycle(provider, ownerPublicKeyHex);
    if (!lifecycle) {
      throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle disappeared during deletion");
    }
    if (lifecycle.record.status === "deleted" || (lifecycle.record.status === "active" && lifecycle.record.generation !== generation)) {
      return false;
    }
    if (lifecycle.record.status !== "deleting" || lifecycle.record.generation !== generation) {
      throw new StorageRuntimeError("storage_unavailable", "Storage owner lifecycle changed during deletion");
    }
    const objects = await listOwnerObjects(provider, ownerPublicKeyHex);
    if (objects.length === 0) {
      emptyPasses += 1;
      if (emptyPasses >= OWNER_DELETE_REQUIRED_EMPTY_PASSES) return true;
      continue;
    }
    emptyPasses = 0;
    for (const object of objects) {
      const current = await readOwnerLifecycle(provider, ownerPublicKeyHex);
      if (!current) {
        throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle disappeared during deletion");
      }
      if (current.record.status === "deleted" || (current.record.status === "active" && current.record.generation !== generation)) {
        return false;
      }
      if (current.record.status !== "deleting" || current.record.generation !== generation) {
        throw new StorageRuntimeError("storage_unavailable", "Storage owner lifecycle changed during deletion");
      }
      try {
        await provider.delete(object.path, object.etag ? { ifMatch: object.etag } : undefined);
      } catch (error) {
        // 对象可能在列出后被另一个清理者删除或被迟到请求替换；下一轮
        // 重新列出并使用最新 ETag，不能因为一次 CAS 冲突中止清理。
        if (!isStorageConflict(error)) throw error;
      }
    }
  }
  throw new StorageRuntimeError("storage_unavailable", "Owner storage did not become empty before deletion timeout");
}

async function removeOwnerSchemaEntries(provider: StorageBucketProvider, ownerPublicKeyHex: string, generation: number): Promise<boolean> {
  const prefix = ownerSchemaPrefix(ownerPublicKeyHex);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const lifecycle = await readOwnerLifecycle(provider, ownerPublicKeyHex);
    if (!lifecycle) throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle disappeared during deletion");
    if (lifecycle.record.status === "deleted" || (lifecycle.record.status === "active" && lifecycle.record.generation !== generation)) return false;
    if (lifecycle.record.status !== "deleting" || lifecycle.record.generation !== generation) throw new StorageRuntimeError("storage_unavailable", "Storage owner lifecycle changed during deletion");
    const object = await provider.get(BUCKET_SCHEMA_PATH);
    const afterRead = await readOwnerLifecycle(provider, ownerPublicKeyHex);
    if (!afterRead) throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle disappeared during deletion");
    if (afterRead.record.status === "deleted" || (afterRead.record.status === "active" && afterRead.record.generation !== generation)) return false;
    if (afterRead.record.status !== "deleting" || afterRead.record.generation !== generation) throw new StorageRuntimeError("storage_unavailable", "Storage owner lifecycle changed during deletion");
    if (!object) return true;
    const current = decodeBucketSchema(object.bytes);
    const namespaces = Object.fromEntries(Object.entries(current.namespaces).filter(([key]) => !key.startsWith(prefix)));
    if (Object.keys(namespaces).length === Object.keys(current.namespaces).length) return true;
    if (!object.etag) throw new StorageRuntimeError("storage_provider_error", "Storage bucket schema CAS is unavailable");
    try {
      const beforeWrite = await readOwnerLifecycle(provider, ownerPublicKeyHex);
      if (!beforeWrite) throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle disappeared during deletion");
      if (beforeWrite.record.status === "deleted" || (beforeWrite.record.status === "active" && beforeWrite.record.generation !== generation)) return false;
      if (beforeWrite.record.status !== "deleting" || beforeWrite.record.generation !== generation) throw new StorageRuntimeError("storage_unavailable", "Storage owner lifecycle changed during deletion");
      await provider.put(BUCKET_SCHEMA_PATH, encodeBucketSchema({ ...current, namespaces }), { ifMatch: object.etag });
      const afterWrite = await readOwnerLifecycle(provider, ownerPublicKeyHex);
      if (!afterWrite) throw new StorageRuntimeError("storage_provider_error", "Storage owner lifecycle disappeared during deletion");
      if (afterWrite.record.status === "deleted" || (afterWrite.record.status === "active" && afterWrite.record.generation !== generation)) return false;
      if (afterWrite.record.status !== "deleting" || afterWrite.record.generation !== generation) throw new StorageRuntimeError("storage_unavailable", "Storage owner lifecycle changed during deletion");
      return true;
    } catch (error) {
      if (isStorageConflict(error)) continue;
      throw error;
    }
  }
  throw new StorageRuntimeError("storage_conflict", "Storage bucket schema changed concurrently");
}

/**
 * 在桶级 `.keymaster/schema` 中登记 namespace 的 schemaVersion。
 * 登记使用 Provider CAS，因此并发首次打开不会互相覆盖；同一逻辑目录
 * 之后只能用原版本打开，避免旧数据被不同格式解释。
 */
async function ensureBucketNamespaceSchema(
  provider: StorageBucketProvider,
  binding: Pick<StorageNamespaceBinding, "scope" | "applicationStorageId" | "ownerPublicKeyHex">,
  schemaVersion: number,
  assertCurrent?: () => Promise<void>
): Promise<void> {
  const key = namespaceSchemaKey(binding);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await assertCurrent?.();
    const object = await provider.get(BUCKET_SCHEMA_PATH);
    await assertCurrent?.();
    if (!object) {
      const initial: BucketSchemaRecord = {
        format: BUCKET_SCHEMA_FORMAT,
        version: BUCKET_SCHEMA_FORMAT_VERSION,
        namespaces: { [key]: schemaVersion }
      };
      try {
        await assertCurrent?.();
        await provider.put(BUCKET_SCHEMA_PATH, encodeBucketSchema(initial), { ifNoneMatch: "*" });
        await assertCurrent?.();
        return;
      } catch (error) {
        if (!isStorageConflict(error)) throw error;
        // 另一个打开者刚刚创建了 schema；重新读取并按 CAS 合并。
        continue;
      }
    }
    const current = decodeBucketSchema(object.bytes);
    const recorded = current.namespaces[key];
    if (recorded !== undefined) {
      if (recorded !== schemaVersion) throw new StorageRuntimeError("storage_provider_error", "Storage namespace schema version is incompatible");
      return;
    }
    const next: BucketSchemaRecord = {
      format: current.format,
      version: current.version,
      namespaces: { ...current.namespaces, [key]: schemaVersion }
    };
    try {
      await assertCurrent?.();
      await provider.put(BUCKET_SCHEMA_PATH, encodeBucketSchema(next), { ifMatch: object.etag });
      await assertCurrent?.();
      return;
    } catch (error) {
      if (!isStorageConflict(error)) throw error;
      // schema 被并发修改；下一轮读取最新记录。
    }
  }
  throw new StorageRuntimeError("storage_conflict", "Storage bucket schema changed concurrently");
}

/**
 * Storage 平台层。
 *
 * 这里是唯一可以构造 `keys/` 平台根的入口；业务插件拿到的只能是
 * `openKeyValueStore()` 返回的 owner/App 受限句柄。
 */
export function createPlatformRootStore(options: PlatformRootStoreOptions): PlatformRootStore {
  if (options.provider.bucketId !== options.bucket.bucketId) throw new StorageRuntimeError("storage_forbidden", "Storage bucket binding mismatch");
  const platformIds = new Set(options.platformApplicationStorageIds ?? DEFAULT_PLATFORM_IDS);
  const openPlatformNamespace = async (applicationStorageId: string, schemaVersion: number): Promise<KeyValueStore> => {
    validatePlatformStorageId(applicationStorageId);
    if (!platformIds.has(applicationStorageId)) throw new StorageRuntimeError("storage_forbidden", "Platform storage namespace is not authorized");
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new StorageRuntimeError("storage_provider_error", "Storage schema version is invalid");
    const declaration = validatePluginStorageDeclaration({ scope: "platform", applicationStorageId, schemaVersion });
    await ensureBucketNamespaceSchema(options.provider, declaration, schemaVersion);
    const binding = Object.freeze({ ...declaration, bucketId: options.bucket.bucketId, bucketGeneration: options.bucket.bucketGeneration });
    buildStorageNamespaceRoot(binding);
    return createKeyValueStore({ provider: options.provider, binding, isCurrent: () => options.isCurrent?.({ bucketGeneration: binding.bucketGeneration }) ?? true });
  };
  return {
    bucket: Object.freeze({ ...options.bucket }),
    async openKeyValueStore(input): Promise<OwnerAppStore> {
      if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) throw new StorageRuntimeError("storage_provider_error", "Storage schema version is invalid");
      const declaration = validatePluginStorageDeclaration({ scope: "key", applicationStorageId: input.applicationStorageId, schemaVersion: input.schemaVersion });
      const ownerPublicKeyHex = validateOwnerPublicKeyHex(input.ownerPublicKeyHex);
      const schemaBinding: Pick<StorageNamespaceBinding, "scope" | "applicationStorageId" | "ownerPublicKeyHex"> = {
        ...declaration,
        ownerPublicKeyHex
      };
      const lifecycle = await ensureOwnerLifecycleActive(options.provider, ownerPublicKeyHex);
      const assertCurrent = () => assertOwnerLifecycleCurrent(options.provider, ownerPublicKeyHex, lifecycle.generation);
      const releaseSchemaLease = await acquireOwnerStorageOperation(options.provider, ownerPublicKeyHex, lifecycle.generation);
      try {
        await ensureBucketNamespaceSchema(options.provider, schemaBinding, input.schemaVersion, assertCurrent);
        await assertCurrent();
      } finally {
        await releaseSchemaLease();
      }
      return createOwnerAppStore({
        provider: options.provider,
        bucket: options.bucket,
        ownerPublicKeyHex,
        declaration,
        isCurrent: () => options.isCurrent?.({
          ownerPublicKeyHex,
          bucketGeneration: options.bucket.bucketGeneration,
          keyspaceGeneration: input.keyspaceGeneration
        }) ?? true,
        assertCurrentAsync: assertCurrent,
        acquireCurrentAsync: () => acquireOwnerStorageOperation(options.provider, ownerPublicKeyHex, lifecycle.generation)
      });
    },
    async activateOwnerStorage(input): Promise<OwnerStorageActivation> {
      return activateOwnerLifecycle(options.provider, input.ownerPublicKeyHex);
    },
    async getOwnerStorageGeneration(input): Promise<number> {
      return (await ensureOwnerLifecycleActive(options.provider, input.ownerPublicKeyHex)).generation;
    },
    async assertOwnerStorageCurrent(input): Promise<void> {
      await assertOwnerLifecycleCurrent(options.provider, input.ownerPublicKeyHex, input.generation);
    },
    async deleteOwnerStorage(input) {
      const ownerPublicKeyHex = validateOwnerPublicKeyHex(input.ownerPublicKeyHex);
      const lifecycle = await beginOwnerDeletion(options.provider, ownerPublicKeyHex);
      if (lifecycle.record.status === "deleted") return;
      try {
        if (!await waitForOwnerStorageOperations(options.provider, ownerPublicKeyHex, lifecycle.record.generation)) return;
        if (!await deleteOwnerObjectsUntilEmpty(options.provider, ownerPublicKeyHex, lifecycle.record.generation)) return;
        // schema 是桶级对象，必须在 owner 数据清理后按 CAS 删除该 owner 的
        // namespace 锁定记录；重复执行用于覆盖清理期间的迟到写入。
        if (!await removeOwnerSchemaEntries(options.provider, ownerPublicKeyHex, lifecycle.record.generation)) return;
        if (!await deleteOwnerObjectsUntilEmpty(options.provider, ownerPublicKeyHex, lifecycle.record.generation)) return;
        if (!await removeOwnerSchemaEntries(options.provider, ownerPublicKeyHex, lifecycle.record.generation)) return;
      } finally {
        // 只有本次删除者完成全部物理清理后才释放 lease；其它协调器即使
        // 同时进入 deleteOwnerStorage，也不能在此之前发布 deleted。
        await lifecycle.release();
      }
      if (!await waitForOwnerStorageOperations(options.provider, ownerPublicKeyHex, lifecycle.record.generation)) return;
      if (!await waitForOwnerDeletionOperations(options.provider, ownerPublicKeyHex, lifecycle.record.generation)) return;
      await markOwnerDeleted(options.provider, ownerPublicKeyHex, lifecycle.record.generation);
    },
    openPlatformStore: (input) => openPlatformNamespace(input.applicationStorageId, input.schemaVersion),
    openPlatformKeysStore: (schemaVersion) => openPlatformNamespace("keys", schemaVersion)
  };
}
