// 已绑定逻辑根的本地 K-V 引擎。
//
// 领域格式保持不变：一个 partition 有一个完整 head（唯一需要 CAS 的对象），
// value object 使用不可复活的唯一 ID。变化只在于所有 I/O 落到 WalletStore 的
// 条件写与原子批量之上——IndexedDB 事务本身就是 CAS 边界，因此这里不再模拟
// 远端 ETag，也不会出现「head 写成功但 value 丢失」的中间态。
//
// 关键结构约束：head 与 value 都写在 namespace 根下的 `.keymaster/` 子目录，
// 属于该模块自己的记录，不与业务文件混写，也不产生第二份业务真值。

import type {
  KeyValueCommitInput,
  KeyValueCommitResult,
  KeyValueEntry,
  KeyValueEntryMeta,
  KeyValueJson,
  KeyValueListInput,
  KeyValueListResult,
  KeyValueGarbageResult,
  KeyValueMaintenanceCapable,
  KeyValueStore,
  KeyValueValue,
  KeyValueWriteCondition,
  PluginStorageDeclaration,
  StorageErrorCode,
  StorageNamespaceBinding,
} from "@keymaster/contracts";
import { buildStorageNamespaceRoot, validatePluginStorageDeclaration } from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import type { WalletStore } from "../local/indexedDbWalletStore.js";
import { StorageRuntimeError, storageErrorCode } from "../runtime/storageError.js";

// head、value object、载荷前缀与信封解析只有 kvValueCodec.ts 一份实现：写路径
// 与存储浏览器因此不会各自解释同一批字节。
import {
  KV_VALUE_ID_PATTERN,
  kvDecodeValueObject,
  kvDecodeValue,
  kvEncodeValue,
  kvEncodeValueObject,
  kvJsonBytes,
  kvParseHead,
  kvParseValueObject,
  kvValidateKey,
  kvValidatePartition,
  kvValidateValueId,
  type KvEncodedValue,
  type KvHeadRecord,
  type KvValueObjectRecord,
} from "./kvValueCodec.js";
const MAX_AUTOMATIC_COMMIT_RETRIES = 8;
/** 垃圾回收一次扫描的元数据分页大小；分页扫描，不全量解码字节。 */
const GARBAGE_SCAN_PAGE_LIMIT = 256;
/** 单次回收默认删除上限：留出余量，避免一次长事务占住 IndexedDB 连接。 */
const DEFAULT_GARBAGE_MAX_DELETES = 64;


interface CursorRecord {
  version: 1;
  partition: string;
  revision: number;
  offset: number;
  prefix: string;
}

export interface KeyValueStoreOptions {
  /** 正式本地介质；业务调用方不能替换。 */
  store: WalletStore;
  /** Coordinator 已完成中央声明校验与世代预绑定的不可变绑定。 */
  binding: StorageNamespaceBinding;
  /** 世代栅栏；返回 false 表示句柄已失效。 */
  isCurrent?: () => boolean;
  now?: () => number;
  generateId?: () => string;
  generateValueId?: () => string;
}

interface InternalCommitResult extends KeyValueCommitResult {
  entries: Map<string, { valueId: string; valueHash: string; updatedAt: number }>;
}

function fail(code: StorageErrorCode, message: string = code): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function asStorageError(error: unknown): StorageRuntimeError {
  if (error instanceof StorageRuntimeError) return error;
  const code = storageErrorCode(error);
  if (code) return new StorageRuntimeError(code);
  return fail("storage_provider_error", "K-V storage operation failed");
}

function encodeCursor(cursor: CursorRecord): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeCursor(value: string | undefined): CursorRecord | undefined {
  if (!value) return undefined;
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const cursor = JSON.parse(new TextDecoder().decode(bytes)) as CursorRecord;
    if (!cursor || cursor.version !== 1 || typeof cursor.partition !== "string" || typeof cursor.prefix !== "string"
      || !Number.isSafeInteger(cursor.revision) || cursor.revision < 0
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
    kvValidatePartition(cursor.partition);
    return cursor;
  } catch {
    throw fail("storage_invalid_path", "K-V cursor is invalid");
  }
}

/**
 * 绑定后的本地 K-V 句柄。
 *
 * `put`/`delete` 走一次 commit；`commit` 在同一个 IndexedDB 事务里先写新 value
 * object，再以 head revision 做条件替换。事务失败或条件不成立时整体 abort，
 * 不会出现值已写但 head 未更新的中间态。
 */
export function createKeyValueStore(options: KeyValueStoreOptions): KeyValueStore & KeyValueMaintenanceCapable {
  const declaration: PluginStorageDeclaration = validatePluginStorageDeclaration(options.binding);
  if (declaration.model !== "kv") throw fail("storage_forbidden", "K-V store requires the kv model");
  if (declaration.authority === "third-party-app") throw fail("storage_forbidden", "Third-party app storage cannot use the K-V model");
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

  const headPath = (partition: string): string => `${root}.keymaster/heads/${kvValidatePartition(partition)}`;
  const valuePath = (valueId: string): string => `${root}.keymaster/values/${kvValidateValueId(valueId)}`;

  async function readHead(partition: string): Promise<{ head?: KvHeadRecord; revision: number; entries: Map<string, { valueId: string; valueHash: string; updatedAt: number }> }> {
    assertOpen();
    const object = await options.store.get(headPath(partition));
    assertOpen();
    if (!object) return { revision: 0, entries: new Map() };
    const head = kvParseHead(object.bytes, partition);
    const entries = new Map<string, { valueId: string; valueHash: string; updatedAt: number }>();
    for (const entry of head.entries) entries.set(entry.key, { valueId: entry.valueId, valueHash: entry.valueHash, updatedAt: entry.updatedAt });
    return { head, revision: head.revision, entries };
  }

  async function loadValue(valueId: string, partition: string, valueHash: string): Promise<KeyValueValue> {
    assertOpen();
    const object = await options.store.get(valuePath(valueId));
    assertOpen();
    if (!object) throw fail("storage_provider_error", "K-V value is missing");
    return kvDecodeValue(kvParseValueObject(object.bytes, valueId, partition, valueHash).payload);
  }

  /**
   * 回收不再被任何 partition head 引用的 value object。
   *
   * value object 不可复活且内容寻址：覆盖写与 delete 都只改写 head，被换掉的
   * 旧 value 会永远留在库里。不回收的话本地库单调增长，最终撞上 IndexedDB 配额。
   *
   * 删除前先读取「全部 partition head 的引用集合」：value object 的路径里没有
   * partition 段（归属只写在 envelope 内），扫到路径时无法判断它属于哪个
   * partition，只看当前 partition 会误删别的 partition 仍引用的对象。
   * minAgeMs 进一步避免删掉刚写完、可能仍被在途读取的对象。
   */
  async function collectGarbageInternal(input: { minAgeMs?: number; maxDeletes?: number } = {}): Promise<KeyValueGarbageResult> {
    const minAgeMs = input.minAgeMs ?? 0;
    const maxDeletes = input.maxDeletes ?? DEFAULT_GARBAGE_MAX_DELETES;
    if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0) throw fail("storage_provider_error", "K-V garbage minAgeMs is invalid");
    if (!Number.isSafeInteger(maxDeletes) || maxDeletes < 0) throw fail("storage_provider_error", "K-V garbage maxDeletes is invalid");
    return withMaintenanceLock(async () => {
      assertOpen();
      const valuePrefix = root + ".keymaster/values/";
      const headPrefix = root + ".keymaster/heads/";
      // 全量列举只读元数据，不解码字节。
      const valueIds: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        assertOpen();
        const page = await options.store.list({ prefix: valuePrefix, ...(cursor === undefined ? {} : { cursor }), limit: GARBAGE_SCAN_PAGE_LIMIT });
        for (const object of page.objects) valueIds.push(object.path.slice(valuePrefix.length));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const referenced = new Set<string>();
      let headCursor: string | undefined;
      for (;;) {
        assertOpen();
        const page = await options.store.list({ prefix: headPrefix, ...(headCursor === undefined ? {} : { cursor: headCursor }), limit: GARBAGE_SCAN_PAGE_LIMIT });
        for (const object of page.objects) {
          const partition = object.path.slice(headPrefix.length);
          if (!partition) continue;
          const head = await readHead(partition);
          for (const reference of head.entries.values()) referenced.add(reference.valueId);
        }
        if (!page.nextCursor) break;
        headCursor = page.nextCursor;
      }
      const cutoff = now() - minAgeMs;
      let candidates = 0;
      let deleted = 0;
      let failed = 0;
      for (const valueId of valueIds) {
        assertOpen();
        if (referenced.has(valueId)) continue;
        const object = await options.store.get(valuePath(valueId));
        if (!object) continue;
        // 无法解析的对象不是本引擎写的 value：宁可保留，也不猜测删除。
        const decoded = kvDecodeValueObject(object.bytes);
        if (!decoded.ok) continue;
        const createdAt = decoded.record.createdAt;
        if (createdAt > cutoff) continue;
        candidates += 1;
        if (deleted + failed >= maxDeletes) continue;
        try {
          await options.store.delete(valuePath(valueId), { ifRevision: object.revision });
          deleted += 1;
        } catch {
          // 并发 commit 或事务失败时保留对象；下一轮清扫会重新判定。
          failed += 1;
        }
      }
      return { scanned: valueIds.length, candidates, deleted, failed };
    });
  }

  async function readSnapshot(partitionInput?: string) {
    const partition = kvValidatePartition(partitionInput);
    const state = await readHead(partition);
    return { partition, revision: state.revision, entries: state.entries };
  }

  async function commitUnlocked(input: KeyValueCommitInput): Promise<InternalCommitResult> {
    assertOpen();
    const partition = kvValidatePartition(input.partition);
    if (!Array.isArray(input.operations) || input.operations.length > 10_000) throw fail("storage_limit_exceeded", "K-V commit contains too many operations");
    const state = await readHead(partition);
    const currentRevision = state.revision;
    if (input.ifRevision !== undefined && input.ifRevision !== currentRevision) throw fail("storage_conflict", "K-V partition revision changed");
    const next = new Map(state.entries);
    const encodedByHash = new Map<string, KvEncodedValue>();
    const referencesByHash = new Map<string, { valueId: string; valueHash: string; updatedAt: number }>();
    for (const reference of state.entries.values()) {
      if (!referencesByHash.has(reference.valueHash)) referencesByHash.set(reference.valueHash, reference);
    }
    const committedAt = now();
    const allocateReference = (encoded: KvEncodedValue): { valueId: string; valueHash: string; updatedAt: number } => {
      const existing = referencesByHash.get(encoded.valueHash);
      if (existing) return existing;
      let valueId = "";
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = generateValueId();
        if (KV_VALUE_ID_PATTERN.test(candidate) && !allocatedValueIds.has(candidate)) { valueId = candidate; break; }
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
      kvValidateKey(operation.key);
      if (operation.type === "delete") { next.delete(operation.key); continue; }
      if (operation.type !== "put") throw fail("storage_provider_error", "K-V operation is invalid");
      const encoded = kvEncodeValue(operation.value);
      const previous = next.get(operation.key);
      if (!previous || previous.valueHash !== encoded.valueHash) next.set(operation.key, { ...allocateReference(encoded), updatedAt: committedAt });
    }
    const changed = next.size !== state.entries.size || [...next].some(([key, value]) => state.entries.get(key)?.valueHash !== value.valueHash);
    if (!changed) return { revision: currentRevision, commitId: "", committedAt: state.head?.committedAt ?? 0, entries: state.entries };

    // 已被新 head 引用的 value object 不需要重写;其余必须与 head 在同一个事务
    // 内落盘,否则崩溃会留下 head 指向不存在 value 的状态。
    const currentValueIds = new Set([...state.entries.values()].map((entry) => entry.valueId));
    const operations: Array<{ type: "put"; path: string; bytes: Uint8Array }> = [];
    for (const reference of next.values()) {
      if (currentValueIds.has(reference.valueId)) continue;
      const encoded = encodedByHash.get(reference.valueHash);
      if (!encoded) throw fail("storage_provider_error", "K-V final value is missing from the commit");
      operations.push({ type: "put", path: valuePath(reference.valueId), bytes: kvEncodeValueObject(reference.valueId, partition, encoded, committedAt) });
    }
    const head: KvHeadRecord = {
      format: "keymaster.kv-head",
      version: 2,
      partition,
      revision: currentRevision + 1,
      committedAt,
      entries: [...next.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, reference]) => ({ key, valueId: reference.valueId, valueHash: reference.valueHash, updatedAt: reference.updatedAt })),
    };
    const headRecordPath = headPath(partition);
    operations.push({ type: "put", path: headRecordPath, bytes: kvJsonBytes(head) });
    assertOpen();
    try {
      // head 的条件替换与所有新 value object 在同一事务:条件不成立时整体 abort。
      await options.store.batch({
        operations,
        conditions: [{ path: headRecordPath, ifRevision: currentRevision }],
      });
    } catch (caught) {
      const mapped = asStorageError(caught);
      if (mapped.code === "storage_conflict") throw fail("storage_conflict", "K-V head CAS conflicted");
      throw mapped;
    }
    assertOpen();
    return { revision: head.revision, commitId: generateId(), committedAt, entries: next };
  }

  async function commitInternal(input: KeyValueCommitInput): Promise<InternalCommitResult> {
    return withMaintenanceLock(async () => {
      for (let attempt = 0; attempt < MAX_AUTOMATIC_COMMIT_RETRIES; attempt += 1) {
        try {
          return await commitUnlocked(input);
        } catch (caught) {
          if (input.ifRevision !== undefined || !caught || typeof caught !== "object"
            || (caught as { code?: unknown }).code !== "storage_conflict" || attempt + 1 >= MAX_AUTOMATIC_COMMIT_RETRIES) {
            throw caught;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      throw fail("storage_conflict", "K-V commit retry limit reached");
    });
  }

  return {
    get walletGeneration() { return options.binding.walletGeneration; },
    get sessionEpoch() { return options.binding.sessionEpoch; },
    get runGeneration() { return options.binding.runGeneration; },
    moduleId: declaration.moduleId,
    purposeId: declaration.purposeId,
    authority: declaration.authority as "platform-only" | "built-in-module",
    model: "kv",
    schemaVersion: declaration.schemaVersion,
    async get<T = KeyValueValue>(key: string, input: { partition?: string } = {}): Promise<KeyValueEntry<T> | undefined> {
      assertOpen();
      kvValidateKey(key);
      const state = await readSnapshot(input.partition);
      const reference = state.entries.get(key);
      if (!reference) return undefined;
      const value = await loadValue(reference.valueId, state.partition, reference.valueHash);
      assertOpen();
      return { key, value: value as T, revision: state.revision, updatedAt: reference.updatedAt };
    },
    async list(input: KeyValueListInput = {}): Promise<KeyValueListResult> {
      assertOpen();
      const partition = kvValidatePartition(input.partition);
      const state = await readSnapshot(partition);
      const prefix = input.prefix ?? "";
      if (prefix) kvValidateKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
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
        assertOpen();
        return { key, value, revision: state.revision, updatedAt: reference.updatedAt };
      }));
      assertOpen();
      const nextOffset = offset + pageKeys.length;
      return {
        revision: state.revision,
        entries,
        ...(nextOffset < keys.length ? { nextCursor: encodeCursor({ version: 1, partition, revision: state.revision, offset: nextOffset, prefix }) } : {}),
      };
    },
    async put<T = KeyValueValue>(key: string, value: T, condition: KeyValueWriteCondition = {}): Promise<KeyValueEntryMeta> {
      const result = await commitInternal({ partition: kvValidatePartition(condition.partition), ...(condition.ifRevision === undefined ? {} : { ifRevision: condition.ifRevision }), operations: [{ type: "put", key, value }] });
      const updatedAt = result.entries.get(key)?.updatedAt;
      if (updatedAt === undefined) throw fail("storage_provider_error", "K-V put did not produce an entry");
      return { key, revision: result.revision, updatedAt };
    },
    async delete(key: string, condition: KeyValueWriteCondition = {}): Promise<void> {
      await commitInternal({ partition: kvValidatePartition(condition.partition), ...(condition.ifRevision === undefined ? {} : { ifRevision: condition.ifRevision }), operations: [{ type: "delete", key }] });
    },
    async commit(input: KeyValueCommitInput): Promise<KeyValueCommitResult> {
      const { revision, commitId, committedAt } = await commitInternal(input);
      return { revision, commitId, committedAt };
    },
    collectGarbage: async (input?: { minAgeMs?: number; maxDeletes?: number }) => await collectGarbageInternal(input),
    close() { closed = true; },
  };
}
