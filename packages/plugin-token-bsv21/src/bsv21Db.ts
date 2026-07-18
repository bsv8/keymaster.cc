// packages/plugin-token-bsv21/src/bsv21Db.ts
// BSV-21 key-scoped snapshot DB（IndexedDB 实现）。
//
// 设计缘由：
//   - 后台 task 原子提交 BSV-21 token snapshot，页面只读 DB。
//   - 使用 IndexedDB 事务保证原子性：删除旧数据 + 写入新数据在同一事务中。
//   - 跨标签页共享同一份持久化数据。
//   - 每个 active key 拥有独立的 IndexedDB（通过 keyspace.openKeyStorage），
//     主键为 [network, address, origin]，不需要 publicKeyHex 维度。
//   - 不做 handle 缓存：每次 DB 操作都通过 keyspace.openKeyStorage() 取 handle；
//     由 keyspace 负责 namespace 连接缓存、关闭和删除。避免 A→B→A 切换时
//     复用 keyspace 已关闭的连接导致 InvalidStateError。

import type { BsvNetwork, KeyspaceService } from "@keymaster/contracts";

/** BSV-21 token snapshot。 */
export interface Bsv21TokenSnapshot {
  /** token origin（即 tokenId）。 */
  origin: string;
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

/** BSV-21 DB 接口（key-scoped：所有操作隐式作用于当前 active key 的 namespace）。 */
export interface Bsv21Db {
  put(snapshot: Bsv21TokenSnapshot): Promise<void>;
  /**
   * 原子替换当前 namespace 的所有 snapshot。
   * 设计缘由：在同一 IndexedDB 事务中删除旧数据并写入新数据，
   * 保证中途失败时旧数据仍然完整。
   */
  replaceAll(snapshots: Bsv21TokenSnapshot[]): Promise<void>;
  /** 列出当前 namespace 的所有 snapshot。 */
  list(): Promise<Bsv21TokenSnapshot[]>;
  /** 关闭当前缓存的 DB handle。 */
  close(): void;
}

const STORAGE_ID = "snapshots";
const DB_VERSION = 2;
const STORE_NAME = "snapshots";

/**
 * 打开 IndexedDB upgrade 回调。
 * 主键 [network, address, origin]，不需要 publicKeyHex（已由 namespace 隔离）。
 */
function upgrade(db: IDBDatabase, oldVersion: number): void {
  if (db.objectStoreNames.contains(STORE_NAME)) {
    db.deleteObjectStore(STORE_NAME);
  }
  const store = db.createObjectStore(STORE_NAME, { keyPath: ["network", "address", "origin"] });
  // 保留 network index 用于按网络过滤
  store.createIndex("network", "network", { unique: false });
}

/**
 * 创建 key-scoped BSV-21 DB。
 * 设计缘由：不做 handle 缓存，每次 DB 操作都通过 keyspace.openKeyStorage()
 * 取 handle；由 keyspace 负责 namespace 连接缓存、关闭和删除。
 * 这样 A→B→A 切换时不会复用 keyspace 已关闭的连接。
 */
export function createBsv21Db(keyspace: KeyspaceService): Bsv21Db {
  /**
   * 获取当前 active key 的 DB handle。
   * 每次调用都走 keyspace.openKeyStorage()，不做本地缓存。
   */
  async function getHandle(): Promise<{ db: IDBDatabase }> {
    const state = keyspace.active();
    if (!state.activePublicKeyHex) {
      throw new Error("createBsv21Db: no active key");
    }
    const handle = await keyspace.openKeyStorage({
      publicKeyHex: state.activePublicKeyHex,
      pluginId: "plugin-token-bsv21",
      storageId: STORAGE_ID,
      version: DB_VERSION,
      upgrade,
    });
    return { db: handle.db };
  }

  return {
    async put(snapshot) {
      const { db } = await getHandle();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.put(snapshot);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async replaceAll(snapshots) {
      const { db } = await getHandle();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        // 删除所有旧数据
        const deleteRequest = store.openCursor();
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

    async list() {
      const { db } = await getHandle();
      return new Promise<Bsv21TokenSnapshot[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },

    close() {
      // no-op：handle 生命周期由 keyspace 管理，不再做本地缓存。
    },
  };
}
