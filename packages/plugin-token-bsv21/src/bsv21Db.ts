// packages/plugin-token-bsv21/src/bsv21Db.ts
// BSV-21 key-scoped snapshot DB（IndexedDB 实现）。
//
// 设计缘由：
//   - 后台 task 原子提交 BSV-21 token snapshot，页面只读 DB。
//   - 使用 IndexedDB 事务保证原子性：删除旧数据 + 写入新数据在同一事务中。
//   - 跨标签页共享同一份持久化数据。
//   - snapshot 按 (publicKeyHex, network, address, origin) 唯一标识。
//     同一 token 可能被多个地址持有，需要按地址维度区分余额。

import type { BsvNetwork } from "@keymaster/contracts";

/** BSV-21 token snapshot。 */
export interface Bsv21TokenSnapshot {
  /** token origin（即 tokenId）。 */
  origin: string;
  /** 归属的 key namespace。 */
  publicKeyHex: string;
  /** 网络。 */
  network: BsvNetwork;
  /** 持有此 token 的地址。 */
  address: string;
  /** 余额。 */
  balance: { confirmed: number; unconfirmed: number };
  /** token 元数据。 */
  meta: {
    origin: string;
    symbol?: string;
    issuer?: string;
    decimals?: number;
  };
  /** 同步时间。 */
  syncedAt: string;
}

/** BSV-21 DB 接口。 */
export interface Bsv21Db {
  put(snapshot: Bsv21TokenSnapshot): Promise<void>;
  /**
   * 原子替换指定 publicKeyHex 的所有 snapshot。
   * 设计缘由：在同一 IndexedDB 事务中删除旧数据并写入新数据，
   * 保证中途失败时旧数据仍然完整。
   */
  replaceByPublicKey(publicKeyHex: string, snapshots: Bsv21TokenSnapshot[]): Promise<void>;
  listByPublicKey(publicKeyHex: string): Promise<Bsv21TokenSnapshot[]>;
  deleteByPublicKey(publicKeyHex: string): Promise<void>;
}

const DB_NAME = "keymaster-bsv21-snapshots";
const DB_VERSION = 2;
const STORE_NAME = "snapshots";

/**
 * 打开 IndexedDB 数据库。
 * 设计缘由：version 2 将主键从 [publicKeyHex, origin] 升级为
 * [publicKeyHex, network, address, origin]，以支持同一 token 被
 * 多个地址持有的场景。升级时删除旧 store 并重建（旧数据可由后台
 * 同步任务重新拉取，不需要迁移）。
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      // 删除旧 store（如果存在），重建为新主键结构
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      const store = db.createObjectStore(STORE_NAME, { keyPath: ["publicKeyHex", "network", "address", "origin"] });
      store.createIndex("publicKeyHex", "publicKeyHex", { unique: false });
    };
  });
}

/**
 * 创建 IndexedDB 实现的 BSV-21 DB。
 */
export function createBsv21Db(): Bsv21Db {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function getDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = openDb();
    }
    return dbPromise;
  }

  return {
    async put(snapshot) {
      const db = await getDb();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.put(snapshot);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async replaceByPublicKey(publicKeyHex, snapshots) {
      const db = await getDb();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const index = store.index("publicKeyHex");

        // 删除该 publicKeyHex 的所有旧数据
        const deleteRequest = index.openCursor(IDBKeyRange.only(publicKeyHex));
        deleteRequest.onsuccess = () => {
          const cursor = deleteRequest.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            // 删除完成，写入新数据
            for (const s of snapshots) {
              store.put(s);
            }
          }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async listByPublicKey(publicKeyHex) {
      const db = await getDb();
      return new Promise<Bsv21TokenSnapshot[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const index = store.index("publicKeyHex");
        const request = index.getAll(IDBKeyRange.only(publicKeyHex));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },

    async deleteByPublicKey(publicKeyHex) {
      const db = await getDb();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const index = store.index("publicKeyHex");
        const request = index.openCursor(IDBKeyRange.only(publicKeyHex));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  };
}
