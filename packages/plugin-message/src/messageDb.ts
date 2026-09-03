// 消息本地历史库。
//
// 每个 owner 使用独立的 key-scoped IndexedDB。这里不保存 SSP 原始包，也不
// 提供远端 list/get；Message service 只在收到或发送成功后写入自己的本地记录。

import type { KeyspaceService, MessageRecord } from "@keymaster/contracts";

const PLUGIN_ID = "message";
const STORAGE_ID = "history";
// 版本 2 只补索引，不删除已有 messages store；历史数据必须保留。
const DB_VERSION = 2;
const STORE_NAME = "messages";

/** 一次异步消息操作捕获的 owner/session 守卫。返回 false 时必须放弃写入。 */
export type MessageDbOwnerGuard = () => boolean;

export interface MessageDb {
  /** 显式传入 owner，禁止 DB 自己读取“当前 active owner”。 */
  list(ownerPublicKeyHex: string, guard?: MessageDbOwnerGuard): Promise<MessageRecord[]>;
  get(ownerPublicKeyHex: string, messageId: string, guard?: MessageDbOwnerGuard): Promise<MessageRecord | undefined>;
  put(ownerPublicKeyHex: string, message: MessageRecord, guard?: MessageDbOwnerGuard): Promise<void>;
}

function transactionDone(tx: IDBTransaction, guard?: MessageDbOwnerGuard): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      // IndexedDB 的 commit 已发生；这个检查确保调用方不会把已失效的
      // owner 当成成功结果继续向 UI/业务传播。数据本身仍在原 owner DB 中。
      if (guard && !guard()) reject(new Error("Message history owner session became stale"));
      else resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function normalizeOwnerPublicKeyHex(ownerPublicKeyHex: string): string {
  const normalized = ownerPublicKeyHex.trim().toLowerCase();
  if (!/^(02|03)[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Message history owner public key is invalid");
  }
  return normalized;
}

/** 校验 owner/session 仍然有效；DB namespace 永远使用捕获的 owner。 */
function assertOwnerCurrent(
  keyspace: KeyspaceService,
  ownerPublicKeyHex: string,
  guard?: MessageDbOwnerGuard
): void {
  if (guard && !guard()) throw new Error("Message history owner session became stale");
  const active = keyspace.active().activePublicKeyHex?.trim().toLowerCase();
  if (active !== ownerPublicKeyHex) throw new Error("Message history owner changed");
}

/** 构造显式 owner 作用域的消息 DB facade。 */
export function createMessageDb(keyspace: KeyspaceService): MessageDb {
  async function withDatabase<T>(
    ownerPublicKeyHex: string,
    guard: MessageDbOwnerGuard | undefined,
    operation: (db: IDBDatabase) => Promise<T>
  ): Promise<T> {
    const owner = normalizeOwnerPublicKeyHex(ownerPublicKeyHex);
    assertOwnerCurrent(keyspace, owner, guard);
    const handle = await keyspace.openKeyStorage({
      publicKeyHex: owner,
      pluginId: PLUGIN_ID,
      storageId: STORAGE_ID,
      version: DB_VERSION,
      upgrade(db, _oldVersion, _newVersion, transaction) {
        let store: IDBObjectStore;
        if (db.objectStoreNames.contains(STORE_NAME)) {
          // 绝不能 delete/recreate：这会在升级时清空用户消息历史。
          if (!transaction) return;
          store = transaction.objectStore(STORE_NAME);
        } else {
          store = db.createObjectStore(STORE_NAME, { keyPath: "messageId" });
        }
        if (!store.indexNames.contains("insertedAtMs")) {
          store.createIndex("insertedAtMs", "insertedAtMs", { unique: false });
        }
      }
    });
    try {
      assertOwnerCurrent(keyspace, owner, guard);
      return await operation(handle.db);
    } finally {
      // 每次操作都关闭显式 owner 的 handle，避免 key 切换后旧 DB 连接泄漏。
      try { handle.close(); } catch { /* DB 已关闭时无须传播 */ }
    }
  }

  return {
    async list(ownerPublicKeyHex, guard) {
      const owner = normalizeOwnerPublicKeyHex(ownerPublicKeyHex);
      return withDatabase(owner, guard, async (db) => {
        assertOwnerCurrent(keyspace, owner, guard);
        const tx = db.transaction(STORE_NAME, "readonly");
        const rows = await requestValue<MessageRecord[]>(tx.objectStore(STORE_NAME).getAll());
        await transactionDone(tx, guard);
        return rows;
      });
    },
    async get(ownerPublicKeyHex, messageId, guard) {
      const owner = normalizeOwnerPublicKeyHex(ownerPublicKeyHex);
      return withDatabase(owner, guard, async (db) => {
        assertOwnerCurrent(keyspace, owner, guard);
        const tx = db.transaction(STORE_NAME, "readonly");
        const row = await requestValue<MessageRecord | undefined>(tx.objectStore(STORE_NAME).get(messageId));
        await transactionDone(tx, guard);
        return row;
      });
    },
    async put(ownerPublicKeyHex, message, guard) {
      const owner = normalizeOwnerPublicKeyHex(ownerPublicKeyHex);
      if (message.senderPublicKeyHex !== owner && message.recipientPublicKeyHex !== owner) {
        throw new Error("Message history record does not belong to owner");
      }
      await withDatabase(owner, guard, async (db) => {
        // 写入前再次校验；网络 await 期间发生切 key 时在这里 fail-closed。
        assertOwnerCurrent(keyspace, owner, guard);
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(message);
        await transactionDone(tx, guard);
      });
    }
  };
}
