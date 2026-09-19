import type {
  StorageBucketListPage,
  StorageBucketObject,
  StorageBucketProbeResult,
  StorageBucketProvider,
  StorageBucketWriteCondition
} from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import type { StorageErrorCode } from "@keymaster/contracts";
import { StorageRuntimeError, storageErrorCode } from "../../runtime/storageError.js";
import { assertProviderPath, normalizeProviderLimit } from "../bucketProvider.js";

/** Local 桶的正式物理介质：一个 Origin 一个数据库、一个对象仓库。 */
export const LOCAL_INDEXED_DATABASE_NAME = "keymaster.local";
export const LOCAL_INDEXED_OBJECT_STORE = "objects";
export const LOCAL_INDEXED_SCHEMA_VERSION = 1;

export interface IndexedDbBucketProviderOptions {
  /** 抽象桶身份，不是物理 key 前缀。 */
  bucketId: string;
  /** 测试/宿主可注入的 IndexedDB 实现；缺省取当前全局 indexedDB。 */
  indexedDB?: IDBFactory;
  /** 测试可覆盖数据库名；生产固定使用 LOCAL_INDEXED_DATABASE_NAME。 */
  databaseName?: string;
  /** 测试可覆盖对象仓库名；生产固定使用 LOCAL_INDEXED_OBJECT_STORE。 */
  storeName?: string;
  /** 测试时可注入时钟。 */
  now?: () => number;
}

/** 对象仓库里的物理记录；bytes 用结构化克隆原样保存。 */
interface StoredObjectRecord {
  path: string;
  bytes: Uint8Array;
  lastModified: string;
  /**
   * 写入时算好的内容 ETag。list() 必须能廉价返回 ETag，不能为每个对象
   * 重新哈希全量字节（大文件桶会让一次列表遍历几百 MB）。旧记录缺省，
   * 读取时按需回退计算。
   */
  etag?: string;
}

function fail(code: StorageErrorCode, message: string): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function assertBucketId(bucketId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(bucketId)) {
    throw fail("storage_invalid_path", "Storage bucket ID is invalid");
  }
}

function etagFor(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeCursor(index: number): string {
  return btoa(JSON.stringify({ version: 1, index }));
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(atob(cursor)) as { version?: number; index?: number };
    if (value.version !== 1 || !Number.isSafeInteger(value.index) || value.index === undefined || value.index < 0) throw new Error();
    return value.index;
  } catch {
    throw fail("storage_invalid_path", "Storage cursor is invalid");
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function mapIndexedDbError(caught: unknown): StorageRuntimeError {
  if (caught instanceof StorageRuntimeError) return caught;
  // 跨 realm / WebLoom 传输后的领域错误可能丢原型，但保留 code。
  const transportedCode = storageErrorCode(caught);
  if (transportedCode) return fail(transportedCode, "IndexedDB bucket operation failed");
  const name = caught && typeof caught === "object" ? (caught as { name?: unknown }).name : undefined;
  if (name === "QuotaExceededError") return fail("storage_limit_exceeded", "IndexedDB quota was exceeded");
  if (name === "AbortError") return fail("storage_unavailable", "Storage operation was cancelled");
  if (name === "SecurityError" || name === "InvalidStateError") return fail("storage_unavailable", "IndexedDB storage is unavailable");
  if (name === "NotFoundError") return fail("storage_not_found", "Storage object was not found");
  return fail("storage_provider_error", `IndexedDB bucket operation failed: ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`);
}

function openDatabase(factory: IDBFactory, databaseName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, LOCAL_INDEXED_SCHEMA_VERSION);
    } catch (caught) {
      reject(mapIndexedDbError(caught));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName);
    };
    request.onsuccess = () => {
      const database = request.result;
      // 版本变化（例如未来升级或另一个标签页删除数据库）时立即让出，
      // 后续请求会重新打开，不把旧连接当成仍然可写。
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(mapIndexedDbError(request.error ?? new Error("IndexedDB open failed")));
    request.onblocked = () => reject(fail("storage_unavailable", "IndexedDB upgrade is blocked by another connection"));
  });
}

/**
 * Local 桶的 IndexedDB Provider。
 *
 * 它只读写本桶命名空间内的对象；条件写在同一 IndexedDB 事务内完成
 * 读-判-写，因此 CAS 是原生的，不需要额外 Web Lock 才安全。IndexedDB
 * 的对象仓库天然在跨标签页之间共享，同一事务的串行化保证不会观察到
 * 半写入对象。
 */
export function createIndexedDbBucketProvider(options: IndexedDbBucketProviderOptions): StorageBucketProvider {
  const bucketId = options.bucketId;
  assertBucketId(bucketId);
  const factory = options.indexedDB ?? (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) throw fail("storage_unavailable", "IndexedDB is unavailable");
  const databaseName = options.databaseName ?? LOCAL_INDEXED_DATABASE_NAME;
  const storeName = options.storeName ?? LOCAL_INDEXED_OBJECT_STORE;
  const now = options.now ?? (() => Date.now());
  let closed = false;
  let databasePromise: Promise<IDBDatabase> | undefined;

  function assertOpen(path?: string, options: { allowEmptyPath?: boolean } = {}): void {
    if (closed) throw fail("storage_unavailable", "IndexedDB bucket provider is closed");
    if (path !== undefined && !(options.allowEmptyPath && path === "")) assertProviderPath(path);
  }

  function database(): Promise<IDBDatabase> {
    assertOpen();
    databasePromise ??= openDatabase(factory!, databaseName, storeName).catch((caught) => {
      // 打开失败不能缓存成一个永远失败的 Promise；下一次操作重新尝试。
      databasePromise = undefined;
      throw mapIndexedDbError(caught);
    });
    return databasePromise;
  }

  function recordKey(path: string): [string, string] {
    return [bucketId, path];
  }

  function toObject(record: StoredObjectRecord): StorageBucketObject {
    const bytes = record.bytes instanceof Uint8Array ? record.bytes : new Uint8Array(record.bytes as ArrayBufferLike);
    return {
      path: record.path,
      bytes,
      size: bytes.byteLength,
      etag: record.etag ?? etagFor(bytes),
      lastModified: record.lastModified,
    };
  }

  async function readRecord(store: IDBObjectStore, path: string): Promise<StoredObjectRecord | undefined> {
    return requestToPromise<StoredObjectRecord | undefined>(store.get(recordKey(path)));
  }

  async function get(path: string, input: { signal?: AbortSignal; ifMatch?: string } = {}): Promise<StorageBucketObject | undefined> {
    assertOpen(path);
    if (input.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    try {
      const db = await database();
      const transaction = db.transaction(storeName, "readonly");
      const record = await readRecord(transaction.objectStore(storeName), path);
      await transactionDone(transaction);
      if (!record) return undefined;
      const object = toObject(record);
      if (input.ifMatch !== undefined && object.etag !== input.ifMatch) throw fail("storage_conflict", "Storage object changed");
      return object;
    } catch (caught) {
      throw mapIndexedDbError(caught);
    }
  }

  async function list(input: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<StorageBucketListPage> {
    const prefix = input.prefix ?? "";
    // 目录前缀允许以 `/` 结尾（例如 owner namespace）；校验时剥离末尾斜杠。
    assertOpen(prefix && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix, { allowEmptyPath: true });
    if (prefix) assertProviderPath(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
    if (input.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    try {
      const db = await database();
      const transaction = db.transaction(storeName, "readonly");
      // 直接用前缀构造主键范围，而不是先读出整桶再过滤：大文件桶的块对象
      // 会让「列出 seeds/」这种请求读取并哈希几百 MB。
      //
      // `[bucketId]` 到 `[bucketId, []]` 覆盖本桶全部字符串 path（IDB 键排序
      // 中字符串小于数组，上界不会误收其它桶）；带前缀时用
      // `prefix + "\uffff"` 作为字符串上界，前缀内的 path 全部落在范围内。
      const range = prefix === ""
        ? IDBKeyRange.bound([bucketId], [bucketId, []])
        : IDBKeyRange.bound([bucketId, prefix], [bucketId, `${prefix}\uffff`]);
      const records = await requestToPromise<StoredObjectRecord[]>(transaction.objectStore(storeName).getAll(range));
      await transactionDone(transaction);
      const objects = records
        .map(toObject)
        .filter((object) => object.path.startsWith(prefix))
        .sort((left, right) => left.path.localeCompare(right.path));
      const start = decodeCursor(input.cursor);
      const limit = normalizeProviderLimit(input.limit);
      const page = objects.slice(start, start + limit);
      return { objects: page, nextCursor: start + page.length < objects.length ? encodeCursor(start + page.length) : undefined };
    } catch (caught) {
      throw mapIndexedDbError(caught);
    }
  }

  async function put(path: string, bytes: Uint8Array, condition: StorageBucketWriteCondition & { signal?: AbortSignal } = {}): Promise<{ etag?: string; lastModified?: string }> {
    assertOpen(path);
    if (!(bytes instanceof Uint8Array)) throw fail("storage_provider_error", "Storage value must be bytes");
    if (condition.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    const db = await database();
    const transaction = db.transaction(storeName, "readwrite");
    try {
      const store = transaction.objectStore(storeName);
      const current = await readRecord(store, path);
      if (condition.ifNoneMatch === "*" && current) throw fail("storage_conflict", "Storage object already exists");
      if (condition.ifMatch !== undefined && (!current || etagFor(current.bytes) !== condition.ifMatch)) {
        throw fail("storage_conflict", "Storage object changed");
      }
      const lastModified = new Date(now()).toISOString();
      const etag = etagFor(bytes);
      const record: StoredObjectRecord = { path, bytes: bytes.slice(), lastModified, etag };
      await requestToPromise(store.put(record, recordKey(path)));
      await transactionDone(transaction);
      return { etag, lastModified };
    } catch (caught) {
      try { transaction.abort(); } catch { /* transaction already finished */ }
      throw mapIndexedDbError(caught);
    }
  }

  async function remove(path: string, input: { signal?: AbortSignal; ifMatch?: string } = {}): Promise<void> {
    assertOpen(path);
    if (input.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    const db = await database();
    const transaction = db.transaction(storeName, "readwrite");
    try {
      const store = transaction.objectStore(storeName);
      const current = await readRecord(store, path);
      if (!current) {
        await transactionDone(transaction);
        return;
      }
      if (input.ifMatch !== undefined && etagFor(current.bytes) !== input.ifMatch) {
        throw fail("storage_conflict", "Storage object changed");
      }
      await requestToPromise(store.delete(recordKey(path)));
      await transactionDone(transaction);
    } catch (caught) {
      try { transaction.abort(); } catch { /* transaction already finished */ }
      throw mapIndexedDbError(caught);
    }
  }

  return {
    provider: "local",
    bucketId,
    async probe(signal): Promise<StorageBucketProbeResult> {
      const started = now();
      const probePath = `.keymaster/probes/${crypto.randomUUID()}`;
      const bytes = new TextEncoder().encode("keymaster-indexeddb-probe");
      try {
        await put(probePath, bytes, { ifNoneMatch: "*", signal });
        const readback = await get(probePath, { signal });
        if (!readback || readback.etag !== etagFor(bytes)) throw fail("storage_provider_error", "IndexedDB provider probe readback failed");
        try {
          await put(probePath, bytes, { ifMatch: "keymaster-invalid-etag", signal });
          throw fail("storage_provider_error", "IndexedDB provider ignored If-Match");
        } catch (caught) {
          if (!(caught instanceof StorageRuntimeError) || caught.code !== "storage_conflict") throw caught;
        }
        await remove(probePath, { signal });
        return { ok: true, conditionalWrites: "native", latencyMs: Math.max(0, now() - started) };
      } catch (caught) {
        if (caught instanceof StorageRuntimeError) throw caught;
        throw mapIndexedDbError(caught);
      }
    },
    get,
    list,
    put,
    delete: remove,
    dispose() {
      closed = true;
      const pending = databasePromise;
      databasePromise = undefined;
      if (pending) void pending.then((db) => db.close()).catch(() => undefined);
    }
  };
}
