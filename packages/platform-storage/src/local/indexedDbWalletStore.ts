import type { WalletObjectMeta, WalletObject, WalletWriteCondition, WalletPutResult, WalletBatchOperation, WalletBatchCondition, WalletBatchInput, WalletBatchResult, WalletStore } from "@keymaster/contracts/storage-internal";
export type { WalletObjectMeta, WalletObject, WalletWriteCondition, WalletPutResult, WalletBatchOperation, WalletBatchCondition, WalletBatchInput, WalletBatchResult, WalletStore } from "@keymaster/contracts/storage-internal";
// 单 Key 钱包的正式本地介质。
//
// 这是本仓库唯一允许直接操作 IndexedDB 的生产文件:插件、页面和上层模块都
// 只能通过受限句柄使用它,不能自报路径、module 或 purpose。
//
// 与旧桶 Provider 的关键差异:
//   - 数据库独立为 keymaster.wallet,与旧 keymaster.local 完全分离,新版本
//     不读取、不迁移旧数据;
//   - 对象主键就是规范化的相对 path,没有桶身份与钱包 Owner 前缀;
//   - 条件创建、版本比较、写入、批量提交和重置都在同一个事务内完成,
//     成功依据是事务完成事件而不是单个 request;
//   - 字节与元数据分两个仓库,分页列举只读元数据,不会为翻页搬全部字节。

import {
  isPlatformReservedPath,
  WALLET_CURRENT_SCHEMA_VERSION,
  WALLET_KEYHOLD_PATH,
  WALLET_META_FORMAT,
  WALLET_META_PATH,
  normalizeRelativeStoragePath,
} from "@keymaster/contracts";
import type { StorageErrorCode } from "@keymaster/contracts";
import { StorageRuntimeError, storageErrorCode } from "../runtime/storageError.js";

/** 生产数据库名;与旧桶数据库刻意分开,避免误读旧复合主键。 */
export const WALLET_DATABASE_NAME = "keymaster.wallet";
/** 字节仓库名。 */
export const WALLET_OBJECT_STORE = "objects";
/** 元数据仓库名;与字节同事务写入,供分页列举使用。 */
export const WALLET_INDEX_STORE = "objectIndex";
/** IndexedDB schema 版本。 */
export const WALLET_SCHEMA_VERSION = 1;
/** list 一页的默认与硬上限。 */
export const WALLET_LIST_DEFAULT_LIMIT = 200;
export const WALLET_LIST_MAX_LIMIT = 1000;

export interface IndexedDbWalletStoreOptions {
  /** 测试/宿主可注入的 IndexedDB 实现;缺省取当前全局。 */
  indexedDB?: IDBFactory;
  /** 测试可覆盖数据库名;生产固定使用 WALLET_DATABASE_NAME。 */
  databaseName?: string;
  /** 测试可覆盖字节仓库名。 */
  storeName?: string;
  /** 测试可覆盖元数据仓库名。 */
  indexStoreName?: string;
  /** 测试可注入时钟。 */
  now?: () => number;
  /** 生成钱包身份世代;缺省使用 crypto.randomUUID。 */
  generateWalletGeneration?: () => string;
}

/** 字节仓库的物理形状:内嵌元数据,单仓库即可完成读取。 */
interface StoredObjectBytes {
  bytes: Uint8Array;
  meta: WalletObjectMeta;
}

function fail(code: StorageErrorCode, message: string): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * 事务完成才是提交成功的依据。
 *
 * 单个 request 成功只说明操作进入事务;崩溃或 abort 仍会丢弃它。只有
 * oncomplete 才代表这一批写入已经持久提交。
 */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function mapIndexedDbError(caught: unknown): StorageRuntimeError {
  if (caught instanceof StorageRuntimeError) return caught;
  // 跨 realm 传输后的领域错误可能丢原型,但保留 code。
  const transported = storageErrorCode(caught);
  if (transported) return fail(transported, "IndexedDB wallet operation failed");
  const name = caught && typeof caught === "object" ? (caught as { name?: unknown }).name : undefined;
  if (name === "QuotaExceededError") return fail("storage_limit_exceeded", "IndexedDB quota was exceeded");
  if (name === "AbortError") return fail("storage_unavailable", "Storage operation was cancelled");
  if (name === "SecurityError" || name === "InvalidStateError") throw fail("storage_unavailable", "IndexedDB storage is unavailable");
  if (name === "VersionError") throw fail("storage_wallet_unsupported", "IndexedDB schema version is not supported");
  if (name === "NotFoundError") throw fail("storage_not_found", "Storage object was not found");
  const detail = caught instanceof Error ? caught.name + ": " + caught.message : String(caught);
  return fail("storage_provider_error", "IndexedDB wallet operation failed: " + detail);
}

function openDatabase(
  factory: IDBFactory,
  databaseName: string,
  storeName: string,
  indexStoreName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, WALLET_SCHEMA_VERSION);
    } catch (caught) {
      reject(mapIndexedDbError(caught));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      // 主键在 createObjectStore 时就固定为 path 本身:「对象主键不含 bucketId
      // 与钱包 Owner 前缀」是结构约束,不是一个可绕过的约定字段。
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName);
      if (!database.objectStoreNames.contains(indexStoreName)) database.createObjectStore(indexStoreName);
    };
    request.onsuccess = () => {
      const database = request.result;
      // 版本变化(升级或另一个标签页删除数据库)时立即让出连接,
      // 不把旧连接当成仍然可写。
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(mapIndexedDbError(request.error ?? new Error("IndexedDB open failed")));
    request.onblocked = () => reject(fail("storage_unavailable", "IndexedDB upgrade is blocked by another connection"));
  });
}

/**
 * 游标编码的是「上一页最后一个主键」,而不是偏移量。
 *
 * 因此并发写入不会让游标跳项或失效:下一页从该主键之后开始,与分页期间新增的
 * 对象无关。
 */
function encodeCursor(path: string): string {
  // 业务路径允许非 ASCII(例如「联系人01.json」),所以游标必须按 UTF-8 编码:
  // btoa 只接受 Latin-1,直接编码中文路径会抛 InvalidCharacterError。
  const json = JSON.stringify({ version: 1, path });
  const utf8 = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const binary = atob(cursor);
    const utf8 = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(utf8)) as { version?: number; path?: unknown };
    if (value.version !== 1 || typeof value.path !== "string" || value.path.length === 0) throw new Error("bad cursor");
    return value.path;
  } catch {
    throw fail("storage_invalid_path", "Storage cursor is invalid");
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return WALLET_LIST_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw fail("storage_invalid_path", "Storage list limit is invalid");
  return Math.min(limit, WALLET_LIST_MAX_LIMIT);
}

/** 前缀一律规范化为以 / 结尾,让「目录前缀」与「文件名前缀」行为一致。 */
function normalizePrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === "") return "";
  if (prefix.endsWith("/")) return normalizeRelativeStoragePath(prefix.slice(0, -1)) + "/";
  return normalizeRelativeStoragePath(prefix) + "/";
}

function assertPath(path: string): string {
  try {
    return normalizeRelativeStoragePath(path);
  } catch {
    // 路径被拒绝是调用方的输入问题,不是介质故障:必须落成可区分的
    // storage_invalid_path,而不是笼统的 provider 错误。
    throw fail("storage_invalid_path", "Storage path is invalid");
  }
}

/**
 * 主键范围。
 *
 * 前缀列举直接用前缀构造上下界,而不是先取全库再过滤:大目录翻页不该把整个
 * 索引读进内存。字符串上界用 prefix + U+FFFF 覆盖该前缀下所有 path。
 */
function keyRangeFor(prefix: string, after: string | undefined): IDBKeyRange | undefined {
  if (prefix !== "") {
    return after === undefined
      ? IDBKeyRange.bound(prefix, prefix + "\uffff")
      : IDBKeyRange.bound(after, prefix + "\uffff", true);
  }
  return after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
}

/**
 * 在同一事务内写入一个对象:字节与元数据两个仓库一起写。
 *
 * revision 单调递增且与内容无关:条件写依赖它,所以「用相同内容重写一次」
 * 仍然是一次新世代,不会被误判为无变化。
 */
async function writeObject(
  stores: { objects: IDBObjectStore; index: IDBObjectStore },
  path: string,
  bytes: Uint8Array,
  current: WalletObjectMeta | undefined,
  contentType: string | undefined,
  timestamp: string,
): Promise<WalletObjectMeta> {
  const meta: WalletObjectMeta = {
    path,
    size: bytes.byteLength,
    lastModified: timestamp,
    revision: (current?.revision ?? 0) + 1,
    ...(contentType === undefined ? {} : { contentType }),
  };
  const stored: StoredObjectBytes = { bytes: bytes.slice(), meta };
  await Promise.all([
    requestToPromise(stores.objects.put(stored, path)),
    requestToPromise(stores.index.put(meta, path)),
  ]);
  return meta;
}

async function removeObject(
  stores: { objects: IDBObjectStore; index: IDBObjectStore },
  path: string,
): Promise<void> {
  await Promise.all([
    requestToPromise(stores.objects.delete(path)),
    requestToPromise(stores.index.delete(path)),
  ]);
}

/**
 * 创建绑定本 Origin 钱包数据库的对象引擎。
 *
 * 引擎本身不识别任何业务模块:它只按规范化相对路径存取字节,并把条件写、批量
 * 提交和重置的原子性交给 IndexedDB 事务。
 */
export function createIndexedDbWalletStore(options: IndexedDbWalletStoreOptions = {}): WalletStore {
  const factory = options.indexedDB ?? (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) throw fail("storage_unavailable", "IndexedDB is unavailable");
  const databaseName = options.databaseName ?? WALLET_DATABASE_NAME;
  const storeName = options.storeName ?? WALLET_OBJECT_STORE;
  const indexStoreName = options.indexStoreName ?? WALLET_INDEX_STORE;
  const now = options.now ?? (() => Date.now());
  const generateWalletGeneration = options.generateWalletGeneration ?? (() => crypto.randomUUID());
  let closed = false;
  let databasePromise: Promise<IDBDatabase> | undefined;

  function assertOpen(): void {
    if (closed) throw fail("storage_unavailable", "IndexedDB wallet store is closed");
  }

  /** 校验路径并确认引擎仍然打开;所有按路径的入口都先过这一关。 */
  function openPath(path: string): string {
    assertOpen();
    return assertPath(path);
  }

  function database(): Promise<IDBDatabase> {
    assertOpen();
    databasePromise ??= openDatabase(factory!, databaseName, storeName, indexStoreName).catch((caught) => {
      // 打开失败不能缓存成永远失败的 Promise:下一次操作重新尝试,不因一次失败
      // 把数据库标记为不可恢复,也不自动清空数据。
      databasePromise = undefined;
      throw mapIndexedDbError(caught);
    });
    return databasePromise;
  }

  /** 打开覆盖两个仓库的事务;两仓库总是同事务写入,不会互相读脏。 */
  async function withStores(
    mode: IDBTransactionMode,
    body: (stores: { objects: IDBObjectStore; index: IDBObjectStore }) => Promise<void>,
  ): Promise<void> {
    const opened = await database();
    const transaction = opened.transaction([storeName, indexStoreName], mode);
    try {
      await body({ objects: transaction.objectStore(storeName), index: transaction.objectStore(indexStoreName) });
      await transactionDone(transaction);
    } catch (caught) {
      try {
        transaction.abort();
      } catch {
        /* transaction already finished */
      }
      throw mapIndexedDbError(caught);
    }
  }

  async function readMetaOnly(store: IDBObjectStore, path: string): Promise<WalletObjectMeta | undefined> {
    return await requestToPromise<WalletObjectMeta | undefined>(store.get(path));
  }

  async function readBytes(store: IDBObjectStore, path: string): Promise<StoredObjectBytes | undefined> {
    return await requestToPromise<StoredObjectBytes | undefined>(store.get(path));
  }

  async function readObject(store: IDBObjectStore, path: string): Promise<WalletObject | undefined> {
    const stored = await readBytes(store, path);
    if (!stored) return undefined;
    const bytes = stored.bytes instanceof Uint8Array ? stored.bytes : new Uint8Array(stored.bytes as ArrayBufferLike);
    return { ...stored.meta, bytes };
  }

  async function readMeta(): Promise<WalletObject | undefined> {
    assertOpen();
    const opened = await database();
    const transaction = opened.transaction(storeName, "readonly");
    const record = await readObject(transaction.objectStore(storeName), WALLET_META_PATH);
    await transactionDone(transaction);
    return record;
  }

  async function readKeyHold(): Promise<Uint8Array | undefined> {
    assertOpen();
    const opened = await database();
    const transaction = opened.transaction(storeName, "readonly");
    const stored = await readBytes(transaction.objectStore(storeName), WALLET_KEYHOLD_PATH);
    await transactionDone(transaction);
    return stored ? new Uint8Array(stored.bytes) : undefined;
  }

  async function get(path: string, input: { ifRevision?: number; signal?: AbortSignal } = {}): Promise<WalletObject | undefined> {
    const normalized = openPath(path);
    if (input.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    const opened = await database();
    const transaction = opened.transaction(storeName, "readonly");
    const record = await readObject(transaction.objectStore(storeName), normalized);
    await transactionDone(transaction);
    if (record && input.ifRevision !== undefined && record.revision !== input.ifRevision) {
      throw fail("storage_conflict", "Storage object changed");
    }
    return record;
  }

  async function getRange(
    path: string,
    range: { offset: number; length: number },
    options: { ifRevision?: number } = {},
  ): Promise<WalletObject | undefined> {
    const normalized = openPath(path);
    if (!Number.isSafeInteger(range.offset) || range.offset < 0
      || !Number.isSafeInteger(range.length) || range.length < 0) {
      throw fail("storage_invalid_path", "Storage range is invalid");
    }
    const opened = await database();
    const transaction = opened.transaction(storeName, "readonly");
    const record = await readObject(transaction.objectStore(storeName), normalized);
    await transactionDone(transaction);
    if (!record) return undefined;
    if (options.ifRevision !== undefined && record.revision !== options.ifRevision) {
      throw fail("storage_conflict", "Storage object changed");
    }
    const end = Math.min(record.bytes.byteLength, range.offset + range.length);
    // size 仍是完整对象大小,bytes 只含请求区间;调用方据此判断是否还有后续。
    return { ...record, bytes: record.bytes.slice(range.offset, Math.max(range.offset, end)) };
  }

  async function list(input: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<{
    objects: WalletObjectMeta[];
    nextCursor?: string;
  }> {
    assertOpen();
    if (input.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    const prefix = normalizePrefix(input.prefix);
    const limit = normalizeLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const opened = await database();
    const transaction = opened.transaction(indexStoreName, "readonly");
    // 只读元数据仓库:分页列举不接触任何对象字节。
    // 多取一条判断是否还有下一页,避免为 hasMore 再开一次事务。
    const records = await requestToPromise<WalletObjectMeta[]>(
      transaction.objectStore(indexStoreName).getAll(keyRangeFor(prefix, after), limit + 1)
    );
    await transactionDone(transaction);
    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    return { objects: page, ...(records.length > limit && last ? { nextCursor: encodeCursor(last.path) } : {}) };
  }

  async function put(
    path: string,
    bytes: Uint8Array,
    input: WalletWriteCondition & { contentType?: string; signal?: AbortSignal } = {},
  ): Promise<WalletPutResult> {
    const normalized = openPath(path);
    if (!(bytes instanceof Uint8Array)) throw fail("storage_provider_error", "Storage value must be bytes");
    if (input.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    let written: WalletObjectMeta | undefined;
    await withStores("readwrite", async (stores) => {
      const current = await readMetaOnly(stores.index, normalized);
      // 条件判定与写入在同一事务内:不存在「先读后写」的竞态窗口。
      if (input.ifNoneMatch === true && current) throw fail("storage_conflict", "Storage object already exists");
      if (input.ifRevision !== undefined && (current?.revision ?? 0) !== input.ifRevision) {
        throw fail("storage_conflict", "Storage object changed");
      }
      written = await writeObject(stores, normalized, bytes, current, input.contentType, new Date(now()).toISOString());
    });
    return written!;
  }

  async function remove(path: string, input: { ifRevision?: number; signal?: AbortSignal } = {}): Promise<void> {
    const normalized = openPath(path);
    if (input.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    await withStores("readwrite", async (stores) => {
      const current = await readMetaOnly(stores.index, normalized);
      if (!current) return;
      if (input.ifRevision !== undefined && current.revision !== input.ifRevision) {
        throw fail("storage_conflict", "Storage object changed");
      }
      await removeObject(stores, normalized);
    });
  }

  /**
   * 同一事务内提交一批 put/delete。
   *
   * 这是 K-V、snapshot、文件批量和钱包初始化的共同原子边界:先在同一事务里读判
   * 全部前置 revision,再全部写入,任何一条不满足就整体 abort。因此不会出现
   * 「值已写但 head 未更新」的中间态,也不会留下崩溃后的内部孤儿。
   */
  async function batch(input: WalletBatchInput, options: { signal?: AbortSignal } = {}): Promise<WalletBatchResult> {
    assertOpen();
    if (options.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
      throw fail("storage_invalid_path", "Storage batch requires at least one operation");
    }
    const timestamp = new Date(now()).toISOString();
    const paths: string[] = [];
    await withStores("readwrite", async (stores) => {
      for (const condition of input.conditions ?? []) {
        const path = assertPath(condition.path);
        const current = await readMetaOnly(stores.index, path);
        if (condition.ifNoneMatch === true && current) throw fail("storage_conflict", "Storage object already exists");
        if (condition.ifRevision !== undefined && (current?.revision ?? 0) !== condition.ifRevision) {
          throw fail("storage_conflict", "Storage object changed");
        }
      }
      // 同一路径在一个 batch 内可能被多次操作:用本地缓存保持 revision 单调,
      // 不为每次操作回读 IndexedDB。元数据足够判断存在性与世代。
      const staged = new Map<string, WalletObjectMeta | undefined>();
      const currentMeta = async (path: string): Promise<WalletObjectMeta | undefined> =>
        staged.has(path) ? staged.get(path) : readMetaOnly(stores.index, path);
      for (const operation of input.operations) {
        const path = assertPath(operation.path);
        paths.push(path);
        if (operation.type === "delete") {
          if (await currentMeta(path)) {
            await removeObject(stores, path);
            staged.set(path, undefined);
          }
          continue;
        }
        if (!(operation.bytes instanceof Uint8Array)) throw fail("storage_provider_error", "Storage value must be bytes");
        const meta = await writeObject(
          stores,
          path,
          operation.bytes,
          await currentMeta(path),
          operation.contentType,
          timestamp,
        );
        staged.set(path, meta);
      }
    });
    return { paths, committedAt: timestamp };
  }

  /**
   * 重置钱包:同一事务内清空新格式全部数据,并写入新的钱包身份世代。
   *
   * 调用方必须先撤销会话、grant 与任务权限——本方法只负责数据层。清空与世代递增
   * 同事务,所以失败时既不会留下「数据已清但世代没变」的中间态,也不会把旧授权
   * 带进新钱包。旧桶数据库不在清理范围内。
   */
  async function resetWallet(options: { signal?: AbortSignal } = {}): Promise<{ walletGeneration: string; clearedAt: string }> {
    assertOpen();
    if (options.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    const clearedAt = new Date(now()).toISOString();
    const walletGeneration = generateWalletGeneration();
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        format: WALLET_META_FORMAT,
        version: 1,
        schemaVersion: WALLET_CURRENT_SCHEMA_VERSION,
        initialized: false,
        walletGeneration,
        createdAt: clearedAt,
      })
    );
    const meta: WalletObjectMeta = {
      path: WALLET_META_PATH,
      size: bytes.byteLength,
      lastModified: clearedAt,
      revision: 1,
      contentType: "application/json",
    };
    await withStores("readwrite", async (stores) => {
      await Promise.all([
        requestToPromise(stores.objects.clear()),
        requestToPromise(stores.index.clear()),
      ]);
      await Promise.all([
        requestToPromise(stores.objects.put({ bytes, meta } satisfies StoredObjectBytes, WALLET_META_PATH)),
        requestToPromise(stores.index.put(meta, WALLET_META_PATH)),
      ]);
    });
    return { walletGeneration, clearedAt };
  }

  async function persistence(): Promise<{ persisted: boolean; usageBytes?: number; quotaBytes?: number }> {
    try {
      const estimate = await navigator.storage?.estimate?.();
      const persisted = (await navigator.storage?.persisted?.()) ?? false;
      return {
        persisted,
        ...(estimate?.usage === undefined ? {} : { usageBytes: estimate.usage }),
        ...(estimate?.quota === undefined ? {} : { quotaBytes: estimate.quota }),
      };
    } catch {
      // 宿主不支持持久化查询时按未授权报告;不因此改变数据可用性。
      return { persisted: false };
    }
  }

  return {
    readMeta,
    readKeyHold,
    get,
    getRange,
    list,
    put,
    delete: remove,
    batch,
    resetWallet,
    persistence,
    close() {
      closed = true;
      const pending = databasePromise;
      databasePromise = undefined;
      if (pending) void pending.then((open) => open.close()).catch(() => undefined);
    },
  };
}

/** 该路径是否由平台专属权限守卫;句柄层用它拒绝普通插件访问保留区。 */
export function isReservedWalletPath(path: string): boolean {
  return isPlatformReservedPath(path);
}
