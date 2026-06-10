// packages/plugin-contacts/src/contactsDb.ts
// 联系人 IndexedDB。
// 硬切换 008：每个 key 一个 namespace DB（storageId="book"），由
// keyspace.openKeyStorage 打开。删除 key 时该 DB 整体被 keyspace 清理。
//
// 设计要点：
//   - 模块级 openHandle 缓存当前 namespace 的 IDBDatabase。
//   - openContactsDb({ keyspace, publicKeyHash }) 工厂：切换 namespace 时
//     先关闭旧 handle。
//   - 写操作（put/remove）必须由调用方先 resolveActiveKey 拿到 publicKeyHash。
//   - disposeContactsDb 仅供测试/资源管理使用。

import type { Contact, KeyScopedStorageHandle, KeyspaceService } from "@keymaster/contracts";

const PLUGIN_ID = "contacts";
const STORAGE_ID = "book";
const DB_VERSION = 1;

interface OpenHandle {
  publicKeyHash: string;
  close(): void;
  getDb(): IDBDatabase;
}

let openHandle: OpenHandle | undefined;

export type ContactsDbBundle = OpenHandle;

/**
 * 打开指定 publicKeyHash 的 namespace DB。
 * 同一 publicKeyHash 重复调用复用 handle；切换 namespace 时关闭旧 handle。
 */
export async function openContactsDb(input: {
  keyspace: KeyspaceService;
  publicKeyHash: string;
}): Promise<ContactsDbBundle> {
  if (openHandle && openHandle.publicKeyHash === input.publicKeyHash) {
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
    publicKeyHash: input.publicKeyHash,
    pluginId: PLUGIN_ID,
    storageId: STORAGE_ID,
    version: DB_VERSION,
    upgrade(db) {
      if (!db.objectStoreNames.contains("contacts")) {
        const store = db.createObjectStore("contacts", { keyPath: "id" });
        // address 在同一 namespace 内仍然唯一；不同 key 的同一 address
        // 属于不同 DB，互不冲突。
        store.createIndex("address", "address", { unique: true });
        // publicKeyHash 仅作展示/诊断用，不做唯一约束。
        store.createIndex("publicKeyHash", "publicKeyHash", { unique: false });
      }
    }
  });
  const next: OpenHandle = {
    publicKeyHash: input.publicKeyHash,
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

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
