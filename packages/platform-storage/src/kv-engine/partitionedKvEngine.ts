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
  StorageNamespaceBinding,
} from "@keymaster/contracts";
import { buildStorageNamespaceRoot, validatePluginStorageDeclaration, validateOwnerPublicKeyHex } from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { StorageRuntimeError } from "../runtime/storageError.js";
import type { StorageErrorCode } from "@keymaster/contracts";
import { assertProviderPath } from "../bucket-providers/bucketProvider.js";

const JSON_PREFIX = new TextEncoder().encode("keymaster-kv-v1:json\n");
const BINARY_PREFIX = new TextEncoder().encode("keymaster-kv-v1:binary\n");
const DEFAULT_PARTITION = "default";
const MAX_KEY_LENGTH = 1024;
const MAX_PARTITION_LENGTH = 128;
const MAX_AUTOMATIC_COMMIT_RETRIES = 8;

/**
 * V1 head 是某个 partition 的完整索引。它是唯一需要 CAS 的可变对象；
 * value object 使用不可复活的唯一 ID，hash 只负责完整性校验。
 */
interface HeadRecord {
  format: "keymaster.kv-head";
  version: 2;
  partition: string;
  revision: number;
  committedAt: number;
  entries: Array<{ key: string; valueId: string; valueHash: string; updatedAt: number }>;
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
  /** Host 校验后的中央 bucket/owner/module/purpose 绑定。 */
  binding: StorageNamespaceBinding;
  /** 可选世代判断；切桶/切 key 时由 Coordinator 使旧句柄失效。 */
  isCurrent?: () => boolean;
  /** 跨 Coordinator/设备的持久化 owner 生命周期栅栏。 */
  assertCurrentAsync?: () => Promise<void>;
  /** 为一次完整 K-V 请求持有持久化 owner lease。 */
  acquireCurrentAsync?: () => Promise<() => Promise<void>>;
  /** 测试时注入时钟和操作 ID。 */
  now?: () => number;
  generateId?: () => string;
  /** 分配 value object 身份；生产默认使用随机 UUID。 */
  generateValueId?: () => string;
}

export interface KeyValueStoreMaintenance {
  /** 读取指定 partition 的一致快照，供平台内部使用。 */
  snapshot(partition?: string): Promise<KeyValueListResult>;
  /** 只检查不可达 value 候选，不改变远端对象。 */
  inspectGarbageCandidates(options?: { minAgeMs?: number }): Promise<{ scanned: number; candidates: number }>;
  /** 在重新确认 head 可达性后回收安全年龄之外的孤儿 object。 */
  collectGarbage(options?: { minAgeMs?: number; maxDeletes?: number }): Promise<KeyValueGarbageCollectionResult>;
}

export interface KeyValueGarbageCollectionResult {
  scanned: number;
  candidates: number;
  deleted: number;
  failed: number;
}

interface InternalCommitResult extends KeyValueCommitResult {
  entries: Map<string, { valueId: string; valueHash: string; updatedAt: number }>;
}

interface EncodedValue {
  bytes: Uint8Array;
  valueHash: string;
}

interface ValueObjectRecord {
  format: "keymaster.kv-value";
  version: 1;
  valueId: string;
  partition: string;
  valueHash: string;
  createdAt: number;
  payload: Uint8Array;
}

const VALUE_OBJECT_FORMAT = "keymaster.kv-value";
const VALUE_OBJECT_VERSION = 1;
const VALUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VALUE_OBJECT_HEADER_PREFIX = new TextEncoder().encode("keymaster-kv-value-v1:");

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
  return value.byteLength >= prefix.byteLength && prefix.every((byte, index) => value[index] === byte);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("not a JSON value");
  const normalized = JSON.parse(serialized) as unknown;
  const visit = (current: unknown): string => {
    if (current === null || typeof current !== "object") return JSON.stringify(current);
    if (Array.isArray(current)) return `[${current.map(visit).join(",")}]`;
    return `{${Object.entries(current as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${visit(entry)}`)
      .join(",")}}`;
  };
  return visit(normalized);
}

function encodeValue(value: unknown): EncodedValue {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = concatBytes(BINARY_PREFIX, value);
  } else {
    try {
      const json = canonicalJson(value);
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

/**
 * value object 的 envelope 把创建时间和唯一 ID 一起写入对象本身。
 * Local Provider 的 list 没有远端 Last-Modified 时，GC 仍可安全判断年龄；
 * payload 的 hash 仍以 head 中的 valueHash 为准，任何篡改都会 fail closed。
 */
function encodeValueObject(valueId: string, partition: string, encoded: EncodedValue, createdAt: number): Uint8Array {
  validateValueId(valueId);
  validatePartition(partition);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw fail("storage_provider_error", "K-V value object timestamp is invalid");
  const header = new TextEncoder().encode(`${new TextDecoder().decode(VALUE_OBJECT_HEADER_PREFIX)}${JSON.stringify({
    format: VALUE_OBJECT_FORMAT,
    version: VALUE_OBJECT_VERSION,
    valueId,
    partition,
    valueHash: encoded.valueHash,
    createdAt,
  })}\n`);
  return concatBytes(header, encoded.bytes);
}

function parseValueObjectEnvelope(bytes: Uint8Array): ValueObjectRecord {
  if (!startsWithBytes(bytes, VALUE_OBJECT_HEADER_PREFIX)) {
    throw fail("storage_provider_error", "K-V value object envelope is invalid");
  }
  let separator = -1;
  for (let index = VALUE_OBJECT_HEADER_PREFIX.byteLength; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a) {
      separator = index;
      break;
    }
  }
  if (separator < 0) throw fail("storage_provider_error", "K-V value object envelope is invalid");
  const header = parseJson<unknown>(
    bytes.slice(VALUE_OBJECT_HEADER_PREFIX.byteLength, separator),
    "K-V value object envelope is invalid",
  );
  if (!header || typeof header !== "object" || Array.isArray(header)
    || !exactKeys(header, ["format", "version", "valueId", "partition", "valueHash", "createdAt"])) {
    throw fail("storage_provider_error", "K-V value object envelope is invalid");
  }
  const candidate = header as Partial<ValueObjectRecord>;
  if (candidate.format !== VALUE_OBJECT_FORMAT || candidate.version !== VALUE_OBJECT_VERSION
    || typeof candidate.valueId !== "string" || typeof candidate.partition !== "string" || typeof candidate.valueHash !== "string"
    || !VALUE_ID_PATTERN.test(candidate.valueId)
    || (() => { try { validatePartition(candidate.partition); return false; } catch { return true; } })()
    || !/^[0-9a-f]{64}$/u.test(candidate.valueHash)
    || !Number.isSafeInteger(candidate.createdAt) || (candidate.createdAt as number) < 0) {
    throw fail("storage_provider_error", "K-V value object envelope is invalid");
  }
  const payload = bytes.slice(separator + 1);
  if (hex(sha256(payload)) !== candidate.valueHash) throw fail("storage_provider_error", "K-V value hash mismatch");
  return {
    format: VALUE_OBJECT_FORMAT,
    version: VALUE_OBJECT_VERSION,
    valueId: candidate.valueId,
    partition: candidate.partition,
    valueHash: candidate.valueHash,
    createdAt: candidate.createdAt as number,
    payload,
  };
}

function parseValueObject(bytes: Uint8Array, expectedValueId: string, expectedPartition: string, expectedValueHash: string): ValueObjectRecord {
  validateValueId(expectedValueId);
  validatePartition(expectedPartition);
  if (!/^[0-9a-f]{64}$/u.test(expectedValueHash)) throw fail("storage_provider_error", "K-V value reference is invalid");
  const record = parseValueObjectEnvelope(bytes);
  if (record.valueId !== expectedValueId || record.partition !== expectedPartition || record.valueHash !== expectedValueHash) {
    throw fail("storage_provider_error", "K-V value object reference mismatch");
  }
  return record;
}

function validateKey(key: string): string {
  if (
    typeof key !== "string"
    || key.length === 0
    || key.length > MAX_KEY_LENGTH
    || key.startsWith("/")
    || key.includes("\\")
    || key.includes("\u0000")
    || key.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment === ".keymaster")
  ) throw fail("storage_invalid_path", "K-V key is invalid");
  return key;
}

function validatePartition(partition: string | undefined): string {
  const value = partition ?? DEFAULT_PARTITION;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PARTITION_LENGTH
    || value.startsWith(".")
    || value.includes("/")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) throw fail("storage_invalid_path", "K-V partition is invalid");
  return value;
}

function encodeCursor(cursor: CursorRecord): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes));
}

function decodeCursor(value: string | undefined): CursorRecord | undefined {
  if (!value) return undefined;
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const cursor = JSON.parse(new TextDecoder().decode(bytes)) as CursorRecord;
    if (
      !cursor
      || cursor.version !== 1
      || typeof cursor.partition !== "string"
      || typeof cursor.prefix !== "string"
      || !Number.isSafeInteger(cursor.revision)
      || cursor.revision < 0
      || !Number.isSafeInteger(cursor.offset)
      || cursor.offset < 0
    ) throw new Error();
    validatePartition(cursor.partition);
    return cursor;
  } catch {
    throw fail("storage_invalid_path", "K-V cursor is invalid");
  }
}

function jsonBytes(value: unknown): Uint8Array {
  try {
    return new TextEncoder().encode(JSON.stringify(value));
  } catch {
    throw fail("storage_provider_error", "K-V head is not serializable");
  }
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

function validateValueId(valueId: string): string {
  if (typeof valueId !== "string" || !VALUE_ID_PATTERN.test(valueId)) {
    throw fail("storage_provider_error", "K-V value object ID is invalid");
  }
  return valueId;
}

function valuePath(root: string, valueId: string): string {
  return physicalPath(root, `values/${validateValueId(valueId)}`);
}

function headPath(root: string, partition: string): string {
  return physicalPath(root, `heads/${partition}`);
}

function asStorageError(error: unknown): StorageRuntimeError {
  if (error instanceof StorageRuntimeError) return error;
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "storage_conflict") {
    return fail("storage_conflict", "K-V head CAS conflicted");
  }
  return fail("storage_provider_error", "K-V storage operation failed");
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function parseHead(bytes: Uint8Array, partition: string): HeadRecord {
  const value = parseJson<unknown>(bytes, "K-V partition head is invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, ["format", "version", "partition", "revision", "committedAt", "entries"])) {
    throw fail("storage_provider_error", "K-V partition head is invalid");
  }
  const candidate = value as Partial<HeadRecord>;
  const revision = candidate.revision;
  const committedAt = candidate.committedAt;
  if (candidate.format !== "keymaster.kv-head" || candidate.version !== 2 || candidate.partition !== partition
    || !Number.isSafeInteger(revision) || (revision as number) < 1
    || !Number.isSafeInteger(committedAt) || (committedAt as number) < 0
    || !Array.isArray(candidate.entries)) throw fail("storage_provider_error", "K-V partition head is invalid");
  const entries: HeadRecord["entries"] = [];
  const seen = new Set<string>();
  for (const item of candidate.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || !exactKeys(item, ["key", "valueId", "valueHash", "updatedAt"])) throw fail("storage_provider_error", "K-V partition head entry is invalid");
    const entry = item as { key?: unknown; valueId?: unknown; valueHash?: unknown; updatedAt?: unknown };
    if (typeof entry.key !== "string" || seen.has(entry.key)) throw fail("storage_provider_error", "K-V partition head entry is invalid");
    validateKey(entry.key);
    if (typeof entry.valueId !== "string") throw fail("storage_provider_error", "K-V value object ID is invalid");
    validateValueId(entry.valueId);
    if (typeof entry.valueHash !== "string" || !/^[0-9a-f]{64}$/u.test(entry.valueHash)) throw fail("storage_provider_error", "K-V value reference is invalid");
    if (!Number.isSafeInteger(entry.updatedAt) || (entry.updatedAt as number) < 0) throw fail("storage_provider_error", "K-V partition head timestamp is invalid");
    seen.add(entry.key);
    entries.push({ key: entry.key, valueId: entry.valueId, valueHash: entry.valueHash, updatedAt: entry.updatedAt as number });
  }
  return {
    format: "keymaster.kv-head",
    version: 2,
    partition,
    revision: revision as number,
    committedAt: committedAt as number,
    entries,
  };
}

/**
 * 统一 K-V full-head engine。
 *
 * 每次 commit 先写带唯一 ID 的 value objects，再用固定 partition head 的
 * ETag 做 CAS。head 自身携带完整索引，所以崩溃后可见状态始终是旧 head
 * 或新 head；不存在 immutable commits 对象层，也不存在读旧格式回退。
 */
export function createKeyValueStore(options: KeyValueStoreOptions): KeyValueStore & KeyValueStoreMaintenance {
  const declaration = validatePluginStorageDeclaration(options.binding);
  if (declaration.model !== "kv") throw fail("storage_forbidden", "K-V store requires kv model");
  if (options.provider.bucketId !== options.binding.bucketId) throw fail("storage_forbidden", "Storage bucket binding mismatch");
  if (declaration.scope === "owner") {
    if (!options.binding.ownerPublicKeyHex) throw fail("storage_forbidden", "Owner K-V binding is missing an owner");
    validateOwnerPublicKeyHex(options.binding.ownerPublicKeyHex);
  } else if (options.binding.ownerPublicKeyHex !== undefined) {
    throw fail("storage_forbidden", "Bucket K-V binding must not contain an owner");
  }
  const root = buildStorageNamespaceRoot(options.binding);
  const now = options.now ?? (() => Date.now());
  const generateId = options.generateId ?? (() => crypto.randomUUID());
  const generateValueId = options.generateValueId ?? (() => crypto.randomUUID());
  let closed = false;
  let maintenanceTail: Promise<void> = Promise.resolve();
  const allocatedValueIds = new Set<string>();

  function withMaintenanceLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = maintenanceTail.then(operation, operation);
    maintenanceTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function assertOpen(): void {
    if (closed || options.isCurrent?.() === false) throw fail("storage_unavailable", "Storage handle is stale");
  }

  async function assertCurrentBinding(): Promise<void> {
    assertOpen();
    await options.assertCurrentAsync?.();
    assertOpen();
  }

  async function withCurrentLease<T>(operation: () => Promise<T>): Promise<T> {
    const release = options.acquireCurrentAsync ? await options.acquireCurrentAsync() : undefined;
    try {
      return await operation();
    } finally {
      if (release) await release();
    }
  }

  async function readHead(partition: string): Promise<{ head?: HeadRecord; etag?: string; entries: Map<string, { valueId: string; valueHash: string; updatedAt: number }> }> {
    await assertCurrentBinding();
    const object = await options.provider.get(headPath(root, partition));
    await assertCurrentBinding();
    if (!object) return { entries: new Map() };
    const head = parseHead(object.bytes, partition);
    const entries = new Map<string, { valueId: string; valueHash: string; updatedAt: number }>();
    for (const entry of head.entries) entries.set(entry.key, { valueId: entry.valueId, valueHash: entry.valueHash, updatedAt: entry.updatedAt });
    return { head, etag: object.etag, entries };
  }

  async function loadValue(valueId: string, partition: string, valueHash: string): Promise<KeyValueValue> {
    await assertCurrentBinding();
    const object = await options.provider.get(valuePath(root, valueId));
    await assertCurrentBinding();
    if (!object) throw fail("storage_provider_error", "K-V value is missing");
    return decodeValue(parseValueObject(object.bytes, valueId, partition, valueHash).payload);
  }

  async function readSnapshot(partitionInput?: string): Promise<{ partition: string; revision: number; entries: Map<string, { valueId: string; valueHash: string; updatedAt: number }> }> {
    const partition = validatePartition(partitionInput);
    const state = await readHead(partition);
    return { partition, revision: state.head?.revision ?? 0, entries: state.entries };
  }

  async function commitUnlocked(input: KeyValueCommitInput): Promise<InternalCommitResult> {
    await assertCurrentBinding();
    const partition = validatePartition(input.partition);
    if (!Array.isArray(input.operations) || input.operations.length > 10_000) throw fail("storage_limit_exceeded", "K-V commit contains too many operations");
    const state = await readHead(partition);
    const currentRevision = state.head?.revision ?? 0;
    if (input.ifRevision !== undefined && input.ifRevision !== currentRevision) throw fail("storage_conflict", "K-V partition revision changed");
    const next = new Map(state.entries);
    const encodedByHash = new Map<string, EncodedValue>();
    const referencesByHash = new Map<string, { valueId: string; valueHash: string; updatedAt: number }>();
    for (const reference of state.entries.values()) {
      if (!referencesByHash.has(reference.valueHash)) referencesByHash.set(reference.valueHash, reference);
    }
    const committedAt = now();
    const allocateReference = (encoded: EncodedValue): { valueId: string; valueHash: string; updatedAt: number } => {
      const existing = referencesByHash.get(encoded.valueHash);
      if (existing) return existing;
      let valueId = "";
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = generateValueId();
        if (VALUE_ID_PATTERN.test(candidate) && !allocatedValueIds.has(candidate)) {
          valueId = candidate;
          break;
        }
      }
      if (!valueId) throw fail("storage_provider_error", "K-V value object ID generator produced a duplicate or invalid ID");
      allocatedValueIds.add(valueId);
      const reference = { valueId, valueHash: encoded.valueHash, updatedAt: committedAt };
      referencesByHash.set(encoded.valueHash, reference);
      encodedByHash.set(encoded.valueHash, encoded);
      return reference;
    };
    for (const operation of input.operations) {
      if (!operation || typeof operation !== "object") throw fail("storage_provider_error", "K-V operation is invalid");
      validateKey(operation.key);
      if (operation.type === "delete") {
        next.delete(operation.key);
        continue;
      }
      if (operation.type !== "put") throw fail("storage_provider_error", "K-V operation is invalid");
      const encoded = encodeValue(operation.value);
      const previous = next.get(operation.key);
      if (!previous || previous.valueHash !== encoded.valueHash) {
        const reference = allocateReference(encoded);
        next.set(operation.key, { ...reference, updatedAt: committedAt });
      }
    }
    const changed = next.size !== state.entries.size || [...next].some(([key, value]) => state.entries.get(key)?.valueHash !== value.valueHash);
    if (!changed) {
      return { revision: currentRevision, commitId: "", committedAt: state.head?.committedAt ?? 0, entries: state.entries };
    }

    const currentValueIds = new Set([...state.entries.values()].map((entry) => entry.valueId));
    const encodedValues = new Map<string, Uint8Array>();
    for (const reference of next.values()) {
      if (currentValueIds.has(reference.valueId)) continue;
      const encoded = encodedByHash.get(reference.valueHash);
      if (!encoded) throw fail("storage_provider_error", "K-V final value is missing from the commit");
        encodedValues.set(reference.valueId, encodeValueObject(reference.valueId, partition, encoded, committedAt));
    }

    const revision = currentRevision + 1;
    const commitId = generateId();
    try {
      for (const [valueId, bytes] of encodedValues) {
        await assertCurrentBinding();
        try {
          await options.provider.put(valuePath(root, valueId), bytes, { ifNoneMatch: "*" });
        } catch (caught) {
          const mapped = asStorageError(caught);
          if (mapped.code === "storage_conflict") {
            // value ID 绝不做幂等复用。即使已有 object 的 payload 恰好
            // 相同，也不能重新挂回一个可能来自崩溃前提交的旧引用。
            throw fail("storage_provider_error", "K-V value object ID collision");
          }
          throw mapped;
        }
      }
      const head: HeadRecord = {
        format: "keymaster.kv-head",
        version: 2,
        partition,
        revision,
        committedAt,
        entries: [...next.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, reference]) => ({ key, valueId: reference.valueId, valueHash: reference.valueHash, updatedAt: reference.updatedAt })),
      };
      await assertCurrentBinding();
      const condition = state.etag ? { ifMatch: state.etag } : { ifNoneMatch: "*" as const };
      await options.provider.put(headPath(root, partition), jsonBytes(head), condition);
      await assertCurrentBinding();
      return { revision, commitId, committedAt, entries: next };
    } catch (caught) {
      throw asStorageError(caught);
    }
  }

  async function commitInternal(input: KeyValueCommitInput): Promise<InternalCommitResult> {
    return withMaintenanceLock(async () => {
      for (let attempt = 0; attempt < MAX_AUTOMATIC_COMMIT_RETRIES; attempt += 1) {
        try {
          return await withCurrentLease(() => commitUnlocked(input));
        } catch (caught) {
          if (input.ifRevision !== undefined || !(caught instanceof StorageRuntimeError)
            || caught.code !== "storage_conflict" || attempt + 1 >= MAX_AUTOMATIC_COMMIT_RETRIES) throw caught;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      throw fail("storage_conflict", "K-V commit retry limit reached");
    });
  }

  async function commit(input: KeyValueCommitInput): Promise<KeyValueCommitResult> {
    const { revision, commitId, committedAt } = await commitInternal(input);
    return { revision, commitId, committedAt };
  }

  const store: KeyValueStore & KeyValueStoreMaintenance = {
    bucketId: options.binding.bucketId,
    bucketGeneration: options.binding.bucketGeneration,
    ownerPublicKeyHex: options.binding.ownerPublicKeyHex ?? "",
    moduleId: options.binding.moduleId,
    purposeId: options.binding.purposeId,
    scope: options.binding.scope,
    authority: options.binding.authority,
    model: "kv",
    schemaVersion: options.binding.schemaVersion,
    async get<T = KeyValueValue>(key: string, input: { partition?: string } = {}): Promise<KeyValueEntry<T> | undefined> {
      return withCurrentLease(async () => {
        await assertCurrentBinding();
        validateKey(key);
        const state = await readSnapshot(input.partition);
        const reference = state.entries.get(key);
        if (!reference) return undefined;
        const value = await loadValue(reference.valueId, state.partition, reference.valueHash);
        await assertCurrentBinding();
        return { key, value: value as T, revision: state.revision, updatedAt: reference.updatedAt };
      });
    },
    async list(input: KeyValueListInput = {}): Promise<KeyValueListResult> {
      return withCurrentLease(async () => {
        await assertCurrentBinding();
        const partition = validatePartition(input.partition);
        const state = await readSnapshot(partition);
        const prefix = input.prefix ?? "";
        if (prefix) validateKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
        const cursor = decodeCursor(input.cursor);
        if (cursor && (cursor.partition !== partition || cursor.revision !== state.revision || cursor.prefix !== prefix)) {
          throw fail("storage_conflict", "K-V cursor does not match this prefix snapshot");
        }
        const keys = [...state.entries.keys()].filter((key) => key.startsWith(prefix)).sort((left, right) => left.localeCompare(right));
        const limit = input.limit ?? 200;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail("storage_limit_exceeded", "K-V list limit is invalid");
        const offset = cursor?.offset ?? 0;
        const pageKeys = keys.slice(offset, offset + limit);
        const entries = await Promise.all(pageKeys.map(async (key) => {
          const reference = state.entries.get(key)!;
          const value = await loadValue(reference.valueId, state.partition, reference.valueHash);
          await assertCurrentBinding();
          return { key, value, revision: state.revision, updatedAt: reference.updatedAt };
        }));
        await assertCurrentBinding();
        const nextOffset = offset + pageKeys.length;
        return {
          revision: state.revision,
          entries,
          nextCursor: nextOffset < keys.length ? encodeCursor({ version: 1, partition, revision: state.revision, offset: nextOffset, prefix }) : undefined,
        };
      });
    },
    async put<T = KeyValueValue>(key: string, value: T, condition: KeyValueWriteCondition = {}): Promise<KeyValueEntryMeta> {
      const partition = validatePartition(condition.partition);
      const result = await commitInternal({ partition, ifRevision: condition.ifRevision, operations: [{ type: "put", key, value }] });
      const updatedAt = result.entries.get(key)?.updatedAt;
      if (updatedAt === undefined) throw fail("storage_provider_error", "K-V put did not produce an entry");
      return { key, revision: result.revision, updatedAt };
    },
    async delete(key: string, condition: KeyValueWriteCondition = {}): Promise<void> {
      await commit({ partition: validatePartition(condition.partition), ifRevision: condition.ifRevision, operations: [{ type: "delete", key }] });
    },
    commit,
    close() { closed = true; },
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
    },
    collectGarbage,
  };

  interface GarbageCandidate {
    object: StorageBucketObject;
    valueId: string;
    createdAt: number;
    partition: string;
  }

  interface ReachabilitySnapshot {
    valueIds: Set<string>;
    /** 当前 head 的 Provider 时间；没有 lastModified 时回退到 committedAt。 */
    headUpdatedAt: Map<string, number>;
  }

  function providerTimestamp(object: StorageBucketObject | undefined, fallback: number): number {
    const remote = object?.lastModified ? Date.parse(object.lastModified) : Number.NaN;
    return Number.isFinite(remote) && remote >= 0 ? remote : fallback;
  }

  async function listAllObjects(prefix: string): Promise<StorageBucketObject[]> {
    const objects: StorageBucketObject[] = [];
    let cursor: string | undefined;
    do {
      await assertCurrentBinding();
      const page = await options.provider.list({ prefix, cursor, limit: 1000 });
      objects.push(...page.objects);
      cursor = page.nextCursor;
    } while (cursor);
    return objects;
  }

  async function reachableValueIds(): Promise<ReachabilitySnapshot> {
    const headPrefix = `${root}.keymaster/heads/`;
    const valueIds = new Set<string>();
    const headUpdatedAt = new Map<string, number>();
    for (const object of await listAllObjects(headPrefix)) {
      const partition = object.path.slice(headPrefix.length);
      if (!partition || partition.includes("/")) throw fail("storage_provider_error", "K-V head path is invalid");
      const headObject = await options.provider.get(object.path);
      if (!headObject) continue;
      const head = parseHead(headObject.bytes, partition);
      headUpdatedAt.set(partition, providerTimestamp(headObject, head.committedAt));
      for (const entry of head.entries) valueIds.add(entry.valueId);
    }
    return { valueIds, headUpdatedAt };
  }

  async function objectForGarbageInspection(object: StorageBucketObject, valueId: string): Promise<{ object: StorageBucketObject; record: ValueObjectRecord } | undefined> {
    const full = object.bytes.byteLength > 0 ? object : await options.provider.get(object.path);
    if (!full) return undefined;
    try {
      const record = parseValueObjectEnvelope(full.bytes);
      if (record.valueId !== valueId) return undefined;
      return { object: full, record };
    } catch {
      // 未知/损坏 object 不能由 GC 擅自删除；读取它的任务会继续 fail
      // closed，后续人工维护可以依据 Provider 侧诊断处理。
      return undefined;
    }
  }

  async function garbageCandidatesUnlocked(input: { minAgeMs?: number } = {}): Promise<{ scanned: number; candidates: GarbageCandidate[] }> {
    await assertCurrentBinding();
    const minAgeMs = input.minAgeMs ?? 60_000;
    if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0) throw fail("storage_provider_error", "K-V garbage inspection age is invalid");
    const prefix = `${root}.keymaster/values/`;
    const objects = await listAllObjects(prefix);
    const reachability = await reachableValueIds();
    const cutoff = now() - minAgeMs;
    const candidates: GarbageCandidate[] = [];
    for (const object of objects) {
      const valueId = object.path.slice(prefix.length);
      if (!VALUE_ID_PATTERN.test(valueId) || reachability.valueIds.has(valueId)) continue;
      const inspected = await objectForGarbageInspection(object, valueId);
      if (!inspected) continue;
      // A value that was reachable from a recently updated head may still be
      // in flight in a reader which already fetched that old head.  Keep the
      // entire partition for the head grace window.  A value with no head is
      // a crash orphan and uses its own object timestamp instead.
      const modifiedAt = reachability.headUpdatedAt.get(inspected.record.partition)
        ?? providerTimestamp(object, inspected.record.createdAt);
      if (modifiedAt <= cutoff) candidates.push({ object: inspected.object, valueId, createdAt: inspected.record.createdAt, partition: inspected.record.partition });
    }
    await assertCurrentBinding();
    return { scanned: objects.length, candidates };
  }

  async function inspectGarbageCandidatesUnlocked(input: { minAgeMs?: number } = {}) {
    const result = await garbageCandidatesUnlocked(input);
    return { scanned: result.scanned, candidates: result.candidates.length };
  }

  async function collectGarbageUnlocked(input: { minAgeMs?: number; maxDeletes?: number } = {}): Promise<KeyValueGarbageCollectionResult> {
    const minAgeMs = input.minAgeMs ?? 60_000;
    const maxDeletes = input.maxDeletes ?? 100;
    if (!Number.isSafeInteger(maxDeletes) || maxDeletes < 0 || maxDeletes > 10_000) {
      throw fail("storage_provider_error", "K-V garbage collection delete limit is invalid");
    }
    const result = await garbageCandidatesUnlocked({ minAgeMs });
    let deleted = 0;
    let failed = 0;
    for (const candidate of result.candidates) {
      if (deleted >= maxDeletes) break;
      await assertCurrentBinding();
      // 在每个删除点重新读取所有 head。Provider 没有跨对象事务，
      // 因此必须至少把“扫描时不可达”收紧为“删除前仍不可达”，而
      // minAge grace period 则覆盖正在上传但尚未发布 head 的崩溃窗口。
      const reachability = await reachableValueIds();
      if (reachability.valueIds.has(candidate.valueId)) continue;
      const current = await options.provider.get(candidate.object.path);
      if (!current) {
        failed += 1;
        continue;
      }
      const inspected = await objectForGarbageInspection(current, candidate.valueId);
      if (!inspected) continue;
      const modifiedAt = reachability.headUpdatedAt.get(inspected.record.partition)
        ?? providerTimestamp(current, inspected.record.createdAt);
      if (modifiedAt > now() - minAgeMs) continue;
      if ((await reachableValueIds()).valueIds.has(candidate.valueId)) continue;
      try {
        await options.provider.delete(candidate.object.path, current.etag ? { ifMatch: current.etag } : undefined);
        deleted += 1;
      } catch (caught) {
        if (asStorageError(caught).code === "storage_conflict") {
          // 另一个维护者已删除/替换该 object；这次清扫无需重试同一引用。
          failed += 1;
          continue;
        }
        throw caught;
      }
    }
    await assertCurrentBinding();
    return { scanned: result.scanned, candidates: result.candidates.length, deleted, failed };
  }

  async function collectGarbage(input: { minAgeMs?: number; maxDeletes?: number } = {}): Promise<KeyValueGarbageCollectionResult> {
    return withMaintenanceLock(() => withCurrentLease(() => collectGarbageUnlocked(input)));
  }

  return store;
}
