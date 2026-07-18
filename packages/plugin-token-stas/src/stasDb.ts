// packages/plugin-token-stas/src/stasDb.ts
// STAS key-scoped snapshot DB（IndexedDB 实现）。
//
// 设计缘由：
//   - 后台 task 原子提交 STAS token snapshot，页面只读 DB。
//   - 使用 IndexedDB 事务保证原子性：删除旧数据 + 写入新数据在同一事务中。
//   - 跨标签页共享同一份持久化数据。
//   - snapshot 按 (publicKeyHex, network, address, issuer, symbol) 唯一标识。
//     避免不同发行方的同名 STAS 资产相互覆盖。
//   - provider 层通过 listByPublicKey + filter/aggregate 做查询，
//     不提供单条 getBySymbol 查询接口。

import type { BsvNetwork } from "@keymaster/contracts";

/** STAS token snapshot。 */
export interface StasTokenSnapshot {
  /** token symbol。 */
  symbol: string;
  /** 归属的 key namespace。 */
  publicKeyHex: string;
  /** 网络。 */
  network: BsvNetwork;
  /** 持有此 token 的地址。 */
  address: string;
  /** 余额。 */
  balance: number;
  /** 发行方（规范化：空字符串表示无 issuer）。 */
  issuer: string;
  /** 同步时间。 */
  syncedAt: string;
}

/** STAS DB 接口。 */
export interface StasDb {
  put(snapshot: StasTokenSnapshot): Promise<void>;
  /**
   * 原子替换指定 publicKeyHex 的所有 snapshot。
   * 设计缘由：在同一 IndexedDB 事务中删除旧数据并写入新数据，
   * 保证中途失败时旧数据仍然完整。
   */
  replaceByPublicKey(publicKeyHex: string, snapshots: StasTokenSnapshot[]): Promise<void>;
  listByPublicKey(publicKeyHex: string): Promise<StasTokenSnapshot[]>;
  deleteByPublicKey(publicKeyHex: string): Promise<void>;
}

const DB_NAME = "keymaster-stas-snapshots";
const DB_VERSION = 3;
const STORE_NAME = "snapshots";

/**
 * 打开 IndexedDB 数据库。
 * 设计缘由：version 3 将主键从 [publicKeyHex, network, address, symbol]
 * 升级为 [publicKeyHex, network, address, issuer, symbol]，避免不同
 * 发行方的同名 STAS 资产相互覆盖。升级时删除旧 store 并重建（旧数据
 * 可由后台同步任务重新拉取，不需要迁移）。
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
      const store = db.createObjectStore(STORE_NAME, { keyPath: ["publicKeyHex", "network", "address", "issuer", "symbol"] });
      store.createIndex("publicKeyHex", "publicKeyHex", { unique: false });
    };
  });
}

/**
 * 创建 IndexedDB 实现的 STAS DB。
 */
export function createStasDb(): StasDb {
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
      return new Promise<StasTokenSnapshot[]>((resolve, reject) => {
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
