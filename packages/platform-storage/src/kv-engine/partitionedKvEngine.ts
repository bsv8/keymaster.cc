import type {
  KeyValueCommitInput,
  KeyValueCommitResult,
  KeyValueEntry,
  KeyValueEntryMeta,
  KeyValueJson,
  KeyValueListInput,
  KeyValueListResult,
  KeyValueStore,
  KeyValueValue,
  KeyValueWriteCondition,
  StorageBucketProvider,
  StorageBucketObject,
  StorageNamespaceBinding
} from "@keymaster/contracts";
import { buildStorageNamespaceRoot, validateApplicationStorageId, validatePlatformStorageId, validatePluginStorageDeclaration, validateOwnerPublicKeyHex } from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { StorageRuntimeError } from "../runtime/storageRuntimeError.js";
import type { StorageErrorCode } from "@keymaster/contracts";
import { assertProviderPath } from "../bucket-providers/bucketProvider.js";

const JSON_PREFIX = new TextEncoder().encode("keymaster-kv-v1:json\n");
const BINARY_PREFIX = new TextEncoder().encode("keymaster-kv-v1:binary\n");
const DEFAULT_PARTITION = "default";
const MAX_KEY_LENGTH = 1024;
const MAX_PARTITION_LENGTH = 128;

interface HeadRecord {
  version: 1;
  revision: number;
  commitId: string;
}

interface CommitRecord {
  version: 1;
  partition: string;
  revision: number;
  commitId: string;
  committedAt: number;
  entries: Array<{ key: string; valueHash: string; updatedAt?: number }>;
}

interface CursorRecord {
  version: 1;
  partition: string;
  revision: number;
  offset: number;
  prefix: string;
}

export interface KeyValueStoreOptions {
  /** 已绑定到单个抽象桶的 Provider。 */
  provider: StorageBucketProvider;
  /** Host 校验后的 bucket/owner/App 绑定。 */
  binding: StorageNamespaceBinding;
  /** 可选世代判断；切桶/切 key 时由 Coordinator 使旧句柄失效。 */
  isCurrent?: () => boolean;
  /**
   * 可选的持久化绑定判断；用于跨 Worker/设备的 owner 生命周期栅栏。
   * 每次异步 Provider 读写前后都会调用，异常时必须 fail closed。
   */
  assertCurrentAsync?: () => Promise<void>;
  /** 为一次完整的真实 Provider 操作持有持久化 owner lease。 */
  acquireCurrentAsync?: () => Promise<() => Promise<void>>;
  /** 测试时注入时钟和 commit ID。 */
  now?: () => number;
  generateId?: () => string;
}

export interface KeyValueStoreMaintenance {
  /** 读取指定 partition 的一致快照，供平台 snapshot/compaction 使用。 */
  snapshot(partition?: string): Promise<KeyValueListResult>;
  /** 只检查不可达 commit/value 候选，不改变远端对象。 */
  inspectGarbageCandidates(options?: { minAgeMs?: number }): Promise<{ scanned: number; candidates: number }>;
}

function fail(code: StorageErrorCode, message: string = code): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function startsWithBytes(value: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((byte, index) => value[index] === byte);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

function encodeValue(value: unknown): { bytes: Uint8Array; valueHash: string } {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = concatBytes(BINARY_PREFIX, value);
  } else {
    try {
      const json = JSON.stringify(value);
      if (typeof json !== "string") throw new Error("undefined is not a JSON value");
      bytes = concatBytes(JSON_PREFIX, new TextEncoder().encode(json));
    } catch {
      throw fail("storage_provider_error", "K-V value is not serializable");
    }
  }
  return { bytes, valueHash: hex(sha256(bytes)) };
}

function decodeValue(bytes: Uint8Array): KeyValueValue {
  if (startsWithBytes(bytes, BINARY_PREFIX)) return cloneBytes(bytes.slice(BINARY_PREFIX.byteLength));
  if (!startsWithBytes(bytes, JSON_PREFIX)) throw fail("storage_provider_error", "K-V value envelope is invalid");
  try {
    return JSON.parse(new TextDecoder().decode(bytes.slice(JSON_PREFIX.byteLength))) as KeyValueJson;
  } catch {
    throw fail("storage_provider_error", "K-V JSON value is invalid");
  }
}

function validateKey(key: string): string {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("\u0000") ||
    key.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment === ".keymaster")
  ) throw fail("storage_invalid_path", "K-V key is invalid");
  return key;
}

function validatePartition(partition: string | undefined): string {
  const value = partition ?? DEFAULT_PARTITION;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PARTITION_LENGTH ||
    value.startsWith(".") ||
    value.includes("/") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) throw fail("storage_invalid_path", "K-V partition is invalid");
  return value;
}

function encodeCursor(cursor: CursorRecord): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  // Cursor content is opaque to the caller. Base64 is only an encoding here;
  // the namespace binding and current revision remain the authoritative guard.
  return btoa(String.fromCharCode(...bytes));
}

function decodeCursor(value: string | undefined): CursorRecord | undefined {
  if (!value) return undefined;
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const cursor = JSON.parse(new TextDecoder().decode(bytes)) as CursorRecord;
    if (cursor.version !== 1 || typeof cursor.prefix !== "string" || !Number.isSafeInteger(cursor.revision) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
    return cursor;
  } catch {
    throw fail("storage_invalid_path", "K-V cursor is invalid");
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function parseJson<T>(bytes: Uint8Array, message: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw fail("storage_provider_error", message);
  }
}

function physicalPath(root: string, suffix: string): string {
  const path = `${root}.keymaster/${suffix}`;
  assertProviderPath(path);
  return path;
}

function commitPath(root: string, partition: string, revision: number, commitId: string): string {
  return physicalPath(root, `commits/${partition}/${revision}-${commitId}`);
}

function valuePath(root: string, valueHash: string): string {
  return physicalPath(root, `values/${valueHash}`);
}

function headPath(root: string, partition: string): string {
  return physicalPath(root, `heads/${partition}`);
}

function asStorageError(error: unknown): StorageRuntimeError {
  if (error instanceof StorageRuntimeError) return error;
  return fail("storage_provider_error", "K-V storage operation failed");
}

/**
 * 统一 K-V commit engine。
 *
 * 每次 commit 先写 content-addressed value 和 immutable commit，再用 head
 * 的 ETag 做一次 CAS。读者只接受 head 指向的 commit，因此中途崩溃最多
 * 留下不可达对象，不会观察到半个业务版本。
 */
export function createKeyValueStore(options: KeyValueStoreOptions): KeyValueStore & KeyValueStoreMaintenance {
  const declaration = validatePluginStorageDeclaration(options.binding);
  const root = buildStorageNamespaceRoot(options.binding);
  if (options.provider.bucketId !== options.binding.bucketId) throw fail("storage_forbidden", "Storage bucket binding mismatch");
  if (declaration.scope === "key" && options.binding.ownerPublicKeyHex) validateOwnerPublicKeyHex(options.binding.ownerPublicKeyHex);
  if (declaration.scope === "platform") validatePlatformStorageId(declaration.applicationStorageId);
  else validateApplicationStorageId(declaration.applicationStorageId);
  const now = options.now ?? (() => Date.now());
  const generateId = options.generateId ?? (() => crypto.randomUUID());
  let closed = false;
  // 同一句柄内串行化 commit 与垃圾候选扫描；跨句柄的正确性仍由 head CAS 保证。
  let maintenanceTail: Promise<void> = Promise.resolve();

  function withMaintenanceLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = maintenanceTail.then(operation, operation);
    maintenanceTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function assertOpen(): void {
    if (closed || options.isCurrent?.() === false) throw fail("storage_unavailable", "Storage handle is stale");
  }

  /** Provider 异步读取可能跨越切 Key/切 Root；返回前再次验证绑定。 */
  async function assertCurrentBinding(): Promise<void> {
    assertOpen();
    if (options.assertCurrentAsync) await options.assertCurrentAsync();
  }

  async function withCurrentLease<T>(operation: () => Promise<T>): Promise<T> {
    const release = options.acquireCurrentAsync ? await options.acquireCurrentAsync() : undefined;
    try {
      return await operation();
    } finally {
      if (release) await release();
    }
  }

  async function readHead(partition: string): Promise<{ head?: HeadRecord; etag?: string; entries: Map<string, { valueHash: string; updatedAt: number }> }> {
    await assertCurrentBinding();
    const object = await options.provider.get(headPath(root, partition));
    await assertCurrentBinding();
    if (!object) return { entries: new Map() };
    const head = parseJson<HeadRecord>(object.bytes, "K-V partition head is invalid");
    if (head.version !== 1 || !Number.isSafeInteger(head.revision) || head.revision < 1 || !head.commitId) throw fail("storage_provider_error", "K-V partition head is invalid");
    const commitObject = await options.provider.get(commitPath(root, partition, head.revision, head.commitId));
    await assertCurrentBinding();
    if (!commitObject) throw fail("storage_provider_error", "K-V commit is missing");
    const commit = parseJson<CommitRecord>(commitObject.bytes, "K-V commit is invalid");
    if (commit.version !== 1 || commit.partition !== partition || commit.revision !== head.revision || commit.commitId !== head.commitId || !Array.isArray(commit.entries)) {
      throw fail("storage_provider_error", "K-V commit is invalid");
    }
    const entries = new Map<string, { valueHash: string; updatedAt: number }>();
    for (const entry of commit.entries) {
      validateKey(entry.key);
      if (!/^[0-9a-f]{64}$/u.test(entry.valueHash)) throw fail("storage_provider_error", "K-V value reference is invalid");
      entries.set(entry.key, { valueHash: entry.valueHash, updatedAt: entry.updatedAt ?? commit.committedAt });
    }
    return { head, etag: object.etag, entries };
  }

  async function loadValue(valueHash: string): Promise<KeyValueValue> {
    await assertCurrentBinding();
    const object = await options.provider.get(valuePath(root, valueHash));
    await assertCurrentBinding();
    if (!object) throw fail("storage_provider_error", "K-V value is missing");
    if (hex(sha256(object.bytes)) !== valueHash) throw fail("storage_provider_error", "K-V value hash mismatch");
    return decodeValue(object.bytes);
  }

  async function readSnapshot(partitionInput?: string): Promise<{ partition: string; revision: number; entries: Map<string, { valueHash: string; updatedAt: number }> }> {
    const partition = validatePartition(partitionInput);
    const state = await readHead(partition);
    return { partition, revision: state.head?.revision ?? 0, entries: state.entries };
  }

  async function commitUnlocked(input: KeyValueCommitInput): Promise<KeyValueCommitResult> {
    await assertCurrentBinding();
    const partition = validatePartition(input.partition);
    if (!Array.isArray(input.operations) || input.operations.length > 10_000) throw fail("storage_limit_exceeded", "K-V commit contains too many operations");
    const state = await readHead(partition);
    const currentRevision = state.head?.revision ?? 0;
    if (input.ifRevision !== undefined && input.ifRevision !== currentRevision) throw fail("storage_conflict", "K-V partition revision changed");
    const next = new Map(state.entries);
    const encodedValues = new Map<string, Uint8Array>();
    const committedAt = now();
    for (const operation of input.operations) {
      validateKey(operation.key);
      if (operation.type === "delete") {
        next.delete(operation.key);
        continue;
      }
      const encoded = encodeValue(operation.value);
      next.set(operation.key, { valueHash: encoded.valueHash, updatedAt: committedAt });
      encodedValues.set(encoded.valueHash, encoded.bytes);
    }
    if (input.operations.length === 0) {
      return { revision: currentRevision, commitId: state.head?.commitId ?? "", committedAt: now() };
    }

    const revision = currentRevision + 1;
    const commitId = generateId();
    try {
      for (const [valueHash, bytes] of encodedValues) {
        await assertCurrentBinding();
        try {
          await options.provider.put(valuePath(root, valueHash), bytes, { ifNoneMatch: "*" });
        } catch (caught) {
          // The same content hash may already have been published by another
          // commit. That is harmless; the immutable value remains identical.
          const mapped = asStorageError(caught);
          if (mapped.code !== "storage_conflict") throw mapped;
        }
      }
      const immutableCommit: CommitRecord = {
        version: 1,
        partition,
        revision,
        commitId,
        committedAt,
        entries: [...next.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, reference]) => ({ key, valueHash: reference.valueHash, updatedAt: reference.updatedAt }))
      };
      await assertCurrentBinding();
      await options.provider.put(commitPath(root, partition, revision, commitId), jsonBytes(immutableCommit), { ifNoneMatch: "*" });
      const nextHead: HeadRecord = { version: 1, revision, commitId };
      const condition = state.etag ? { ifMatch: state.etag } : { ifNoneMatch: "*" as const };
      // Root/owner 可能在 immutable commit 写入期间切换；提交 head 前再次
      // 检查，防止旧 owner 的后台请求把新世代状态发布出去。
      await assertCurrentBinding();
      await options.provider.put(headPath(root, partition), jsonBytes(nextHead), condition);
      await assertCurrentBinding();
      return { revision, commitId, committedAt };
    } catch (caught) {
      const mapped = asStorageError(caught);
      if (mapped.code === "storage_conflict") throw mapped;
      throw mapped;
    }
  }

  function commit(input: KeyValueCommitInput): Promise<KeyValueCommitResult> {
    return withMaintenanceLock(() => withCurrentLease(() => commitUnlocked(input)));
  }

  const store: KeyValueStore & KeyValueStoreMaintenance = {
    bucketId: options.binding.bucketId,
    bucketGeneration: options.binding.bucketGeneration,
    ownerPublicKeyHex: options.binding.ownerPublicKeyHex ?? "",
    applicationStorageId: options.binding.applicationStorageId,
    async get<T = KeyValueValue>(key: string, input: { partition?: string } = {}): Promise<KeyValueEntry<T> | undefined> {
      return withCurrentLease(async () => {
        await assertCurrentBinding();
        validateKey(key);
        const state = await readSnapshot(input.partition);
        await assertCurrentBinding();
        const value = state.entries.get(key);
        if (!value) return undefined;
        const loaded = await loadValue(value.valueHash);
        await assertCurrentBinding();
        return { key, value: loaded as T, revision: state.revision, updatedAt: value.updatedAt };
      });
    },
    async list(input: KeyValueListInput = {}): Promise<KeyValueListResult> {
      return withCurrentLease(async () => {
        await assertCurrentBinding();
        const partition = validatePartition(input.partition);
        const state = await readSnapshot(partition);
        await assertCurrentBinding();
        const prefix = input.prefix ?? "";
        if (prefix) validateKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
        const cursor = decodeCursor(input.cursor);
        if (cursor && (cursor.partition !== partition || cursor.revision !== state.revision || cursor.prefix !== prefix)) throw fail("storage_conflict", "K-V cursor does not match this prefix snapshot");
        const keys = [...state.entries.keys()].filter((key) => key.startsWith(prefix)).sort((a, b) => a.localeCompare(b));
        const limit = input.limit ?? 200;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail("storage_limit_exceeded", "K-V list limit is invalid");
        const offset = cursor?.offset ?? 0;
        const pageKeys = keys.slice(offset, offset + limit);
        const entries = await Promise.all(pageKeys.map(async (key) => {
          const reference = state.entries.get(key)!;
          const value = await loadValue(reference.valueHash);
          await assertCurrentBinding();
          return { key, value, revision: state.revision, updatedAt: reference.updatedAt };
        }));
        await assertCurrentBinding();
        const nextOffset = offset + pageKeys.length;
        return {
          revision: state.revision,
          entries,
          nextCursor: nextOffset < keys.length ? encodeCursor({ version: 1, partition, revision: state.revision, offset: nextOffset, prefix }) : undefined
        };
      });
    },
    async put<T = KeyValueValue>(key: string, value: T, condition: KeyValueWriteCondition = {}): Promise<KeyValueEntryMeta> {
      const partition = validatePartition(condition.partition);
      const result = await commit({ partition, ifRevision: condition.ifRevision, operations: [{ type: "put", key, value }] });
      return { key, revision: result.revision, updatedAt: result.committedAt };
    },
    async delete(key: string, condition: KeyValueWriteCondition = {}): Promise<void> {
      await commit({ partition: validatePartition(condition.partition), ifRevision: condition.ifRevision, operations: [{ type: "delete", key }] });
    },
    commit,
    close() {
      closed = true;
    },
    async snapshot(partition) {
      const entries: KeyValueEntry[] = [];
      let cursor: string | undefined;
      let revision = 0;
      do {
        const page = await store.list({ partition, cursor, limit: 1000 });
        revision = page.revision;
        entries.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor);
      return { revision, entries };
    },
    async inspectGarbageCandidates(input = {}) {
      return withMaintenanceLock(() => withCurrentLease(() => inspectGarbageCandidatesUnlocked(input)));
    }
  };

  async function inspectGarbageCandidatesUnlocked(input: { minAgeMs?: number } = {}) {
    await assertCurrentBinding();
    const minAgeMs = input.minAgeMs ?? 60_000;
    if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0) throw fail("storage_provider_error", "K-V garbage inspection age is invalid");
    const objects: StorageBucketObject[] = [];
    let cursor: string | undefined;
    const prefix = `${root}.keymaster/`;
    do {
      const page = await options.provider.list({ prefix, cursor, limit: 1000 });
      objects.push(...page.objects);
      cursor = page.nextCursor;
    } while (cursor);
    const reachable = new Set<string>();
    for (const object of objects.filter((candidate) => candidate.path.startsWith(`${prefix}heads/`))) {
      const headObject = await options.provider.get(object.path);
      if (!headObject) continue;
      const head = parseJson<HeadRecord>(headObject.bytes, "K-V partition head is invalid");
      const commitObject = await options.provider.get(commitPath(root, object.path.slice(`${prefix}heads/`.length), head.revision, head.commitId));
      if (!commitObject) continue;
      reachable.add(commitObject.path);
      const commit = parseJson<CommitRecord>(commitObject.bytes, "K-V commit is invalid");
      for (const entry of commit.entries) reachable.add(valuePath(root, entry.valueHash));
    }
    const now = Date.now();
    const unreachable = objects.filter((object) => {
      if (!(object.path.includes("/.keymaster/commits/") || object.path.includes("/.keymaster/values/")) || reachable.has(object.path)) return false;
      if (!object.lastModified) return false;
      const modifiedAt = Date.parse(object.lastModified);
      return Number.isFinite(modifiedAt) && now - modifiedAt >= minAgeMs;
    });
    await assertCurrentBinding();
    return { scanned: objects.length, candidates: unreachable.length };
  }
  return store;
}
