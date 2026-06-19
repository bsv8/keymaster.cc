// packages/runtime/src/log/logDb.ts
// 全局日志 DB 封装（施工单 002 硬切换）。
//
// 设计缘由：
//   - 日志是系统诊断面，不是某把 key 的业务真值。
//     用全局 IndexedDB（keymaster.logs）而不是 key-scoped storage：
//       * 避免日志随 key 删除而丢失诊断上下文。
//       * 避免与 per-plugin storage 重复结构。
//   - 不为任何插件创建专属日志 DB / 专属 store。
//   - 配置（config）与 entry 共库，不再分第二套存储。
//   - DB 错误只向调用方抛普通英文错误，不做复杂恢复。
//   - 关闭 / 打开失败时调用方应自行决定是否降级。

/** 全局日志 DB 名称。 */
export const LOG_DB_NAME = "keymaster.logs";
/** 全局日志 DB 版本。 */
export const LOG_DB_VERSION = 1;
/** entries store 名。 */
export const LOG_STORE_ENTRIES = "entries";
/** config store 名（singleton 配置）。 */
export const LOG_STORE_CONFIG = "config";

/** 持久化 entry 形态。运行时 schema 是统一 LogEntry（见 contracts/log.ts）。 */
export interface LogEntryRow {
  id: string;
  ts: string;
  level: string;
  pluginId: string;
  scope: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
  keyScope?: { publicKeyHash: string };
  error?: { name?: string; message: string; stack?: string };
}

/** config store 中的 singleton 记录。 */
export interface LogConfigRow {
  id: "singleton";
  retentionDays: number;
  debugEnabled: boolean;
}

let dbPromise: Promise<IDBDatabase> | undefined;

/**
 * 关闭并丢弃缓存的 db 连接。供测试 / dispose 使用。
 * 返回 Promise，在连接真正关闭后 resolve。
 * 设计缘由：单测在每个用例前后需要 deleteDatabase；如果连接还开着，
 * 删除会被阻塞。生产代码不要主动调用。
 */
export function disposeLogDb(): Promise<void> {
  if (!dbPromise) return Promise.resolve();
  const p = dbPromise;
  dbPromise = undefined;
  return p
    .then((db) => {
      try {
        db.close();
      } catch {
        // 静默
      }
    })
    .catch(() => undefined);
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(LOG_DB_NAME, LOG_DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains(LOG_STORE_ENTRIES)) {
          // entries：主键 id；索引覆盖 ts / pluginId / level / scope / event。
          // 不在 scope 上建 unique 索引：业务允许同名 scope / event。
          const store = db.createObjectStore(LOG_STORE_ENTRIES, { keyPath: "id" });
          store.createIndex("ts", "ts", { unique: false });
          store.createIndex("pluginId", "pluginId", { unique: false });
          store.createIndex("level", "level", { unique: false });
          store.createIndex("scope", "scope", { unique: false });
          store.createIndex("event", "event", { unique: false });
        }
        if (!db.objectStoreNames.contains(LOG_STORE_CONFIG)) {
          // config：单条记录 id="singleton"。
          db.createObjectStore(LOG_STORE_CONFIG, { keyPath: "id" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // 打开被另一 tab 阻塞时不要无限等。
    req.onblocked = () => reject(new Error("Log DB open blocked by another connection"));
  });
  return dbPromise;
}

interface TxAndStore {
  tx: IDBTransaction;
  store: IDBObjectStore;
}

function openTx(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode
): TxAndStore {
  const tx = db.transaction(storeName, mode);
  return { tx, store: tx.objectStore(storeName) };
}

function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function awaitTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** 写入或覆盖单条 entry。 */
export async function putEntry(row: LogEntryRow): Promise<void> {
  const db = await openDb();
  const { tx, store } = openTx(db, LOG_STORE_ENTRIES, "readwrite");
  store.put(row);
  await awaitTx(tx);
}

/** 按 id 取单条 entry；不存在返回 undefined。 */
export async function getEntry(id: string): Promise<LogEntryRow | undefined> {
  const db = await openDb();
  const { tx, store } = openTx(db, LOG_STORE_ENTRIES, "readonly");
  const value = (await awaitRequest(store.get(id))) as LogEntryRow | undefined;
  await awaitTx(tx);
  return value ?? undefined;
}

/** 列举全部 entries（按 ts 倒序），供 listEntries 内部使用。 */
export async function listAllEntries(): Promise<LogEntryRow[]> {
  const db = await openDb();
  const { tx, store } = openTx(db, LOG_STORE_ENTRIES, "readonly");
  const tsIndex = store.index("ts");
  const out: LogEntryRow[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = tsIndex.openCursor(null, "prev");
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        resolve();
        return;
      }
      out.push(cur.value as LogEntryRow);
      cur.continue();
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB cursor failed"));
  });
  await awaitTx(tx);
  return out;
}

/** 按 pluginId 索引获取；用于 prune / 清理。 */
export async function listByPlugin(pluginId: string): Promise<LogEntryRow[]> {
  const db = await openDb();
  const { tx, store } = openTx(db, LOG_STORE_ENTRIES, "readonly");
  const index = store.index("pluginId");
  const out: LogEntryRow[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = index.openCursor(IDBKeyRange.only(pluginId));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        resolve();
        return;
      }
      out.push(cur.value as LogEntryRow);
      cur.continue();
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB cursor failed"));
  });
  await awaitTx(tx);
  return out;
}

/**
 * 按条件删除 entries。
 * predicate 返回 true 即删除。
 * 返回删除条数。失败时抛普通英文错误。
 */
export async function deleteWhere(predicate: (row: LogEntryRow) => boolean): Promise<number> {
  const db = await openDb();
  const { tx, store } = openTx(db, LOG_STORE_ENTRIES, "readwrite");
  const index = store.index("ts");
  let removed = 0;
  await new Promise<void>((resolve, reject) => {
    const cursorReq = index.openCursor(null, "prev");
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result;
      if (!cur) {
        resolve();
        return;
      }
      const row = cur.value as LogEntryRow;
      if (predicate(row)) {
        store.delete(row.id);
        removed += 1;
      }
      cur.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error ?? new Error("IndexedDB cursor failed"));
  });
  await awaitTx(tx);
  return removed;
}

/** 读取 config（不存在返回 undefined）。 */
export async function getConfigRow(): Promise<LogConfigRow | undefined> {
  const db = await openDb();
  const { tx, store } = openTx(db, LOG_STORE_CONFIG, "readonly");
  const value = (await awaitRequest(store.get("singleton"))) as LogConfigRow | undefined;
  await awaitTx(tx);
  return value ?? undefined;
}

/** 写入或覆盖 config。 */
export async function putConfigRow(row: LogConfigRow): Promise<void> {
  const db = await openDb();
  const { tx, store } = openTx(db, LOG_STORE_CONFIG, "readwrite");
  store.put(row);
  await awaitTx(tx);
}
