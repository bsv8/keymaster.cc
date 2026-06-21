// packages/plugin-contacts/src/contactsDb.ts
// 联系人 IndexedDB。
// 硬切换 008：每个 key 一个 namespace DB（storageId="book"），由
// keyspace.openKeyStorage 打开。删除 key 时该 DB 整体被 keyspace 清理。
//
// 硬切换 001 收口：DB name 改为
// `keymaster.key.<publicKeyHex>.plugin.contacts.book`；platform identity
// 字段为 publicKeyHex，链上 hash 不再出现在本模块。
//
// 一次性迁移（contacts 专有，不抽成平台通用迁移器）：
//   - 旧命名 `keymaster.key.<legacyNamespaceSha256Hex>.plugin.contacts.book`
//     是 publicKeyHash 模型留下来的 namespace；如果浏览器里仍存在旧 DB
//     且新 DB 为空，则把旧 DB 的 contacts 全量复制到新 DB，并把行内
//     publicKeyHex 字段改写为新 hex；成功后 best-effort 删除旧 DB。
//   - 失败时不允许先删后丢：复制失败 / 旧 DB 仍存在时都不动旧库。
//   - 这条迁移只在 plugin-contacts 自己用，不放回 shared contract 或
//     helper。
//
// 设计要点：
//   - 模块级 openHandle 缓存当前 namespace 的 IDBDatabase。
//   - openContactsDb({ keyspace, publicKeyHex }) 工厂：切换 namespace 时
//     先关闭旧 handle；首次打开触发一次性迁移。
//   - 写操作（put/remove）必须由调用方先 resolveActiveKey 拿到 publicKeyHex。
//   - disposeContactsDb 仅供测试/资源管理使用。

import { sha256 } from "@noble/hashes/sha256";
import type { Contact, KeyScopedStorageHandle, KeyspaceService } from "@keymaster/contracts";

const PLUGIN_ID = "contacts";
const STORAGE_ID = "book";
const DB_VERSION = 1;

interface OpenHandle {
  publicKeyHex: string;
  close(): void;
  getDb(): IDBDatabase;
}

let openHandle: OpenHandle | undefined;

export type ContactsDbBundle = OpenHandle;

/**
 * 硬切换 001 收口（情况 6）：旧 `sha256(publicKeyHex)` 平台 namespace 派
 * 生 helper,只允许在 plugin-contacts 局部用于一次性迁移 / best-effort
 * 旧库清理。不放回 shared contract,不进入运行时业务对象字段。
 */
function legacyNamespaceSha256Hex(publicKeyHex: string): string {
  const bytes = hexToBytes(publicKeyHex);
  return bytesToHex(sha256(bytes));
}

/**
 * 一次性迁移（contacts 专有）：若新 hex namespace DB 为空,且浏览器
 * 仍存在按 `sha256(publicKeyHex)` 命名的旧 namespace DB，则把旧 DB
 * 的 contacts 全量复制到新 DB,行内 publicKeyHex 改写为新 hex,成
 * 功后 best-effort 删除旧 DB。
 *
 * 关键约束（硬切换 001 收口情况 5）：
 *   - **不**先删旧库再复制：旧库在迁移成功前必须保留。
 *   - 复制失败：新库可丢弃,但旧库必须仍在,允许下次打开时重试。
 *   - 不在 shared contract / helper 中暴露旧 namespace helper。
 *
 * 本函数幂等：若新库已有数据直接返回；若旧库不存在或为空也直接返回。
 */
async function migrateLegacyHashNamespaceIfNeeded(input: {
  newDb: IDBDatabase;
  publicKeyHex: string;
}): Promise<void> {
  // 新库已有数据：旧库不动。
  const existing = await reqAsPromise(
    input.newDb.transaction("contacts", "readonly").objectStore("contacts").count()
  );
  if (existing > 0) return;
  // 旧库名 = `keymaster.key.<sha256(publicKeyHex)>.plugin.contacts.book`。
  const legacyDbName = `keymaster.key.${legacyNamespaceSha256Hex(input.publicKeyHex)}.plugin.${PLUGIN_ID}.${STORAGE_ID}`;
  // 旧库若不存在：不报错,直接返回。
  let legacyDb: IDBDatabase;
  try {
    legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(legacyDbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return;
  }
  try {
    // 旧库可能 schema 不一致：我们只读 `contacts` store,缺则按空处理。
    if (!legacyDb.objectStoreNames.contains("contacts")) {
      await deleteDatabaseBestEffort(legacyDbName);
      return;
    }
    const tx = legacyDb.transaction("contacts", "readonly");
    const rows = await reqAsPromise(tx.objectStore("contacts").getAll());
    const list = (rows ?? []) as Contact[];
    if (list.length === 0) {
      await deleteDatabaseBestEffort(legacyDbName);
      return;
    }
    // 复制到新库,行内 publicKeyHex 改写为新 hex。
    const newTx = input.newDb.transaction("contacts", "readwrite");
    const newStore = newTx.objectStore("contacts");
    for (const row of list) {
      const next: Contact = {
        ...row,
        publicKeyHex: input.publicKeyHex
      };
      newStore.put(next);
    }
    await txDone(newTx);
    // 复制成功后才删旧库。
    await deleteDatabaseBestEffort(legacyDbName);
  } catch (err) {
    // 失败：保留旧库。错误信息使用英文。
    console.error("contacts legacy hash namespace migration failed", err);
  } finally {
    try {
      legacyDb.close();
    } catch {
      // 静默
    }
  }
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function deleteDatabaseBestEffort(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function tx<T>(
  handle: ContactsDbBundle,
  store: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
  const db = handle.getDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result: T;
    let settled = false;
    t.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    t.onerror = () => {
      if (!settled) {
        settled = true;
        reject(t.error);
      }
    };
    t.onabort = () => {
      if (!settled) {
        settled = true;
        reject(t.error);
      }
    };
    Promise.resolve(fn(t)).then(
      (r) => {
        result = r;
      },
      (e) => {
        if (!settled) {
          settled = true;
          try {
            t.abort();
          } catch {
            // 已被 abort
          }
          reject(e);
        }
      }
    );
  });
}

/**
 * 打开指定 publicKeyHex 的 namespace DB。
 * 同一 publicKeyHex 重复调用复用 handle；切换 namespace 时关闭旧 handle。
 * 首次打开时触发一次性迁移（见上）。
 */
export async function openContactsDb(input: {
  keyspace: KeyspaceService;
  publicKeyHex: string;
}): Promise<ContactsDbBundle> {
  if (openHandle && openHandle.publicKeyHex === input.publicKeyHex) {
    return openHandle;
  }
  if (openHandle) {
    try {
      openHandle.close();
    } catch {
      // 静默
    }
    openHandle = undefined;
  }
  const handle: KeyScopedStorageHandle = await input.keyspace.openKeyStorage({
    publicKeyHex: input.publicKeyHex,
    pluginId: PLUGIN_ID,
    storageId: STORAGE_ID,
    version: DB_VERSION,
    upgrade(db) {
      if (!db.objectStoreNames.contains("contacts")) {
        const store = db.createObjectStore("contacts", { keyPath: "id" });
        // address 在同一 namespace 内仍然唯一；不同 key 的同一 address
        // 属于不同 DB，互不冲突。
        store.createIndex("address", "address", { unique: true });
        // publicKeyHex 仅作展示/诊断用，不做唯一约束。
        store.createIndex("publicKeyHex", "publicKeyHex", { unique: false });
      }
    }
  });
  // 触发一次性迁移（best-effort,失败不阻断主流程）。
  try {
    await migrateLegacyHashNamespaceIfNeeded({
      newDb: handle.db,
      publicKeyHex: input.publicKeyHex
    });
  } catch (err) {
    console.error("contacts legacy hash migration threw", err);
  }
  const next: OpenHandle = {
    publicKeyHex: input.publicKeyHex,
    close: () => {
      try {
        handle.close();
      } catch {
        // 静默
      }
      if (openHandle === next) openHandle = undefined;
    },
    getDb: () => handle.db
  };
  openHandle = next;
  return next;
}

/** 关闭并清空缓存的 db handle（仅用于测试与 dispose）。 */
export function disposeContactsDb(): void {
  if (!openHandle) return;
  try {
    openHandle.close();
  } catch {
    // 静默
  }
  openHandle = undefined;
}

/** 工厂：构造一个绑定到指定 handle 的 contacts db 操作集合。 */
export function createContactsDb(handle: ContactsDbBundle) {
  return {
    /** 测试 / 资源管理：返回底层 IDBDatabase 引用。 */
    getDb(): IDBDatabase {
      return handle.getDb();
    },
    /** 关闭当前 namespace db handle。 */
    close(): void {
      handle.close();
    },
    async list(): Promise<Contact[]> {
      return tx(handle, "contacts", "readonly", (t) =>
        reqAsPromise(t.objectStore("contacts").getAll())
      );
    },
    async get(id: string): Promise<Contact | undefined> {
      return tx(handle, "contacts", "readonly", (t) =>
        reqAsPromise(t.objectStore("contacts").get(id))
      );
    },
    async findByAddress(address: string): Promise<Contact | undefined> {
      return tx(handle, "contacts", "readonly", (t) =>
        reqAsPromise(t.objectStore("contacts").index("address").get(address))
      );
    },
    async put(contact: Contact): Promise<void> {
      await tx(handle, "contacts", "readwrite", (t) =>
        reqAsPromise(t.objectStore("contacts").put(contact))
      );
    },
    async remove(id: string): Promise<void> {
      await tx(handle, "contacts", "readwrite", (t) =>
        reqAsPromise(t.objectStore("contacts").delete(id))
      );
    }
  };
}

export type ContactsDbHandle = ReturnType<typeof createContactsDb>;
