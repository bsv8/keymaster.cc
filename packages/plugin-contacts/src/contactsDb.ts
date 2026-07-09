// packages/plugin-contacts/src/contactsDb.ts
// 联系人 IndexedDB。
//
// 硬切换 2026-07-09 002：
//   - 联系人 store 只保留新 schema；
//   - 直接 bump DB version，并在 upgrade 时重建 contacts store；
//   - 不做旧 address -> publicKeyHex 猜测迁移；
//   - 旧数据视为废弃，避免新旧双读和脏身份延续。
//
// 设计要点：
//   - DB name 仍按 key namespace 隔离：`keymaster.key.<publicKeyHex>.plugin.contacts.book`。
//   - openContactsDb({ keyspace, publicKeyHex }) 只负责打开当前 namespace。
//   - openHandle 缓存当前 namespace 的 IDBDatabase，切 key 时自动关闭旧 handle。

import type { Contact, KeyScopedStorageHandle, KeyspaceService } from "@keymaster/contracts";

const PLUGIN_ID = "contacts";
const STORAGE_ID = "book";
const DB_VERSION = 2;

interface OpenHandle {
  publicKeyHex: string;
  close(): void;
  getDb(): IDBDatabase;
}

let openHandle: OpenHandle | undefined;

export type ContactsDbBundle = OpenHandle;

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
            // 已被 abort。
          }
          reject(e);
        }
      }
    );
  });
}

/**
 * 打开指定 publicKeyHex 的 namespace DB。
 *
 * 设计缘由：
 *   - key-scoped DB 已经能保证联系人归属，联系人表本身不需要再带 owner 字段；
 *   - 本次硬切换不保留旧 schema 兼容逻辑，upgrade 时直接重建 contacts store；
 *   - 旧数据不能从 address 可靠恢复 publicKeyHex，因此不做猜测式迁移。
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
      // 静默。
    }
    openHandle = undefined;
  }

  const handle: KeyScopedStorageHandle = await input.keyspace.openKeyStorage({
    publicKeyHex: input.publicKeyHex,
    pluginId: PLUGIN_ID,
    storageId: STORAGE_ID,
    version: DB_VERSION,
    upgrade(db) {
      if (db.objectStoreNames.contains("contacts")) {
        db.deleteObjectStore("contacts");
      }
      const store = db.createObjectStore("contacts", { keyPath: "id" });
      store.createIndex("publicKeyHex", "publicKeyHex", { unique: true });
    }
  });

  const next: OpenHandle = {
    publicKeyHex: input.publicKeyHex,
    close: () => {
      try {
        handle.close();
      } catch {
        // 静默。
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
    // 静默。
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
    async findByPublicKeyHex(publicKeyHex: string): Promise<Contact | undefined> {
      return tx(handle, "contacts", "readonly", (t) =>
        reqAsPromise(t.objectStore("contacts").index("publicKeyHex").get(publicKeyHex))
      );
    },
    async findByPublicKeyHexes(publicKeyHexes: string[]): Promise<Contact[]> {
      return tx(handle, "contacts", "readonly", (t) => {
        const store = t.objectStore("contacts").index("publicKeyHex");
        const seen = new Set<string>();
        const requests: Array<Promise<Contact | undefined>> = [];
        for (const hex of publicKeyHexes) {
          if (!hex || seen.has(hex)) continue;
          seen.add(hex);
          requests.push(reqAsPromise(store.get(hex)) as Promise<Contact | undefined>);
        }
        return Promise.all(requests).then((list) => list.filter((item): item is Contact => Boolean(item)));
      });
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
