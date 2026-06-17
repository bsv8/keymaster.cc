// packages/plugin-p2pkh/src/p2pkhDb.ts
// P2PKH 资源库（硬切换 007 + 硬切换 001）。
// 设计缘由：
//   - 不再使用固定 DB_NAME = "p2pkh"；改为每个 active key 一个 namespace DB，
//     通过 keyspace.openKeyStorage 打开。
//   - DB name 形如 `keymaster.key.<publicKeyHash>.plugin.p2pkh.state`。
//   - store 中 keyId 字段保留为诊断字段，但删除 / 清理不再以 keyId index 为主路径。
//   - resourceId 改为不包含 Vault keyId：`p2pkh:<network>`。
//   - 原子提交：commitBackfillPage / commitRecentSnapshot 行为不变，但写入的 DB
//     是当前 key 的 namespace DB，不再有跨 key 数据混合风险。
//   - 切换 active key 时调用方需要重新拿 p2pkhDb(publicKeyHash) 才能继续访问。
//   - 硬切换 001：DB schema 升级到 v5，删除 `p2pkh_balances` store；
//     余额改为 service 每次基于当前 UTXO 快照现算，不再落库。
//
// 迁移策略：
//   - 旧全局 "p2pkh" DB 不再作为主路径；v3 schema 不再创建。
//   - best-effort 迁移：unlock 后 plugin-p2pkh 启动时如果检测到旧 DB
//     仍存在且 active key 已就绪，按旧记录 keyId 找 publicKeyHash，写入
//     对应 namespace DB；迁移成功后删除旧 DB。
//   - 迁移失败时只丢弃旧缓存，重新从 WOC 同步；不阻断钱包解锁。
//   - 硬切换 001：legacy migration 不再迁移 balance 行。

import type { BsvNetwork, KeyspaceService } from "@keymaster/contracts";
import type {
  P2pkhBackfillState,
  P2pkhHistoryItem,
  P2pkhKeyResource,
  P2pkhPendingTransfer,
  P2pkhRecentSyncState,
  P2pkhUtxo,
  P2pkhUtxoReservation
} from "./p2pkhContracts.js";
import type { P2pkhBackfillCommit, P2pkhRecentCommit } from "./p2pkhContracts.js";
import { makeResourceId } from "./p2pkhContracts.js";

const P2PKH_STORAGE_ID = "state";
/**
 * 硬切换 001：DB 版本升到 5。删除 `p2pkh_balances` store；
 * 余额改为 service 每次基于当前 UTXO 快照现算，不再落库。
 */
const P2PKH_DB_VERSION = 5;

/**
 * 旧全局 DB（v3）。best-effort 迁移期会读这个 DB；迁移完成后删除。
 * 设计缘由：硬切换不允许保留主路径；只允许"一次性读取 + 删除"作为迁移。
 */
const LEGACY_DB_NAME = "p2pkh";
const LEGACY_DB_VERSION = 3;

interface P2pkhDbBundle {
  /** 关闭当前 namespace db handle。 */
  close(): void;
  /** 用于 store 操作的 IDBDatabase。 */
  getDb(): IDBDatabase;
  /** 关联的 publicKeyHash。 */
  publicKeyHash: string;
}

export type { P2pkhDbBundle };

interface OpenHandle {
  publicKeyHash: string;
  close(): void;
  getDb(): IDBDatabase;
}

let openHandle: OpenHandle | undefined;

/**
 * 打开当前 active key 的 P2PKH namespace db。
 * 设计缘由：plugin 内部通过 keyspace 获取当前 active key，再打开对应 namespace。
 * 切换 active key 后必须重新调用此函数。
 */
export async function openP2pkhDb(input: {
  keyspace: KeyspaceService;
  publicKeyHash: string;
}): Promise<P2pkhDbBundle> {
  if (openHandle && openHandle.publicKeyHash === input.publicKeyHash) {
    return openHandle as P2pkhDbBundle;
  }
  // 切换 namespace：关闭旧的。
  if (openHandle) {
    try {
      openHandle.close();
    } catch {
      // 静默
    }
    openHandle = undefined;
  }
  const handle = await input.keyspace.openKeyStorage({
    publicKeyHash: input.publicKeyHash,
    pluginId: "p2pkh",
    storageId: P2PKH_STORAGE_ID,
    version: P2PKH_DB_VERSION,
    upgrade: (db, _oldVersion, _newVersion) => {
      createV5Stores(db);
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
  return next as P2pkhDbBundle;
}

/** 关闭并清空缓存的 db handle（仅用于测试与 dispose）。 */
export function disposeP2pkhDb(): void {
  if (openHandle) {
    try {
      openHandle.close();
    } catch {
      // 静默
    }
    openHandle = undefined;
  }
}

/**
 * v5 schema（硬切换 001）：
 *   - 删除 `p2pkh_balances` store；余额不再是持久化实体。
 *   - 保留 v4 已建立的 addresses / utxos / history / history_backfill /
 *     recent_sync / pending_transfers / utxo_reservations 七个 store。
 *   - 把 `p2pkh_balances` 加入 legacy 删除列表，保证从 v4 升级时旧 store 也会被清掉。
 */
function createV5Stores(db: IDBDatabase) {
  // v5：删除 v1-v4 旧 store（包含 p2pkh_balances），重建 namespace stores。
  const legacy = [
    "p2pkh_v1_addresses",
    "p2pkh_v1_balances",
    "p2pkh_v1_utxos",
    "p2pkh_v1_history",
    "p2pkh_addresses",
    "p2pkh_balances",
    "p2pkh_utxos",
    "p2pkh_history"
  ];
  for (const name of legacy) {
    if (db.objectStoreNames.contains(name)) {
      db.deleteObjectStore(name);
    }
  }
  if (!db.objectStoreNames.contains("p2pkh_addresses")) {
    const store = db.createObjectStore("p2pkh_addresses", { keyPath: "resourceId" });
    // publicKeyHash 是诊断字段（key switch 时排错用），不再做唯一约束。
    store.createIndex("publicKeyHash", "publicKeyHash", { unique: false });
    store.createIndex("network", "network", { unique: false });
    store.createIndex("address", "address", { unique: true });
  }
  if (!db.objectStoreNames.contains("p2pkh_utxos")) {
    const store = db.createObjectStore("p2pkh_utxos", { keyPath: "id" });
    store.createIndex("resourceId", "resourceId", { unique: false });
    store.createIndex("publicKeyHash", "publicKeyHash", { unique: false });
    store.createIndex("network", "network", { unique: false });
  }
  if (!db.objectStoreNames.contains("p2pkh_history")) {
    const store = db.createObjectStore("p2pkh_history", { keyPath: "id" });
    store.createIndex("resourceId", "resourceId", { unique: false });
    store.createIndex("publicKeyHash", "publicKeyHash", { unique: false });
    store.createIndex("network", "network", { unique: false });
  }
  if (!db.objectStoreNames.contains("p2pkh_history_backfill")) {
    db.createObjectStore("p2pkh_history_backfill", { keyPath: "resourceId" });
  }
  if (!db.objectStoreNames.contains("p2pkh_recent_sync")) {
    db.createObjectStore("p2pkh_recent_sync", { keyPath: "resourceId" });
  }
  if (!db.objectStoreNames.contains("p2pkh_pending_transfers")) {
    const s = db.createObjectStore("p2pkh_pending_transfers", { keyPath: "id" });
    s.createIndex("resourceId", "resourceId", { unique: false });
    s.createIndex("status", "status", { unique: false });
  }
  if (!db.objectStoreNames.contains("p2pkh_utxo_reservations")) {
    const s = db.createObjectStore("p2pkh_utxo_reservations", { keyPath: "id" });
    s.createIndex("resourceId", "resourceId", { unique: false });
  }
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  handle: P2pkhDbBundle,
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
 * 硬切换 001：`P2pkhBalanceRow` 已删除。余额不再落库，由 service 每次
 * 基于当前 UTXO 快照现算。如果以后出现外部代码仍 import 此类型，
 * 会立即在编译期暴露（unknown 字段不能赋值）。
 */
void (0 as unknown as BsvNetwork);

function newHistoryId(resourceId: string, txid: string): string {
  return `${resourceId}:${txid}`;
}
function newReservationId(resourceId: string, txid: string, vout: number): string {
  return `${resourceId}:${txid}:${vout}`;
}

/** 工厂：构造一个绑定到指定 handle 的 p2pkh db 操作集合。 */
export function createP2pkhDb(handle: P2pkhDbBundle) {
  return {
    /** 测试 / 资源管理：返回底层 IDBDatabase 引用，用于 deleteDatabase 前主动 close。 */
    getDb(): IDBDatabase {
      return handle.getDb();
    },
    /** 关闭当前 namespace db handle。 */
    close(): void {
      handle.close();
    },
    // ---------- address ----------
    async putAddress(r: P2pkhKeyResource): Promise<void> {
      await tx(handle, "p2pkh_addresses", "readwrite", (t) =>
        reqAsPromise(t.objectStore("p2pkh_addresses").put(r))
      );
    },
    async removeResource(resourceId: string): Promise<void> {
      await tx(handle, "p2pkh_addresses", "readwrite", (t) =>
        reqAsPromise(t.objectStore("p2pkh_addresses").delete(resourceId))
      );
    },
    async listAddresses(): Promise<P2pkhKeyResource[]> {
      return tx(handle, "p2pkh_addresses", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_addresses").getAll())
      );
    },
    async getResource(resourceId: string): Promise<P2pkhKeyResource | undefined> {
      return tx(handle, "p2pkh_addresses", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_addresses").get(resourceId))
      );
    },
    async listResourcesByKey(_keyId: string): Promise<P2pkhKeyResource[]> {
      // key scoped DB 里 keyId 不可靠；列出当前 namespace 全部 resource。
      return tx(handle, "p2pkh_addresses", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_addresses").getAll())
      );
    },

    // ---------- utxos ----------
    async putUtxos(rows: P2pkhUtxo[]): Promise<void> {
      if (rows.length === 0) return;
      await tx(handle, "p2pkh_utxos", "readwrite", (t) => {
        const store = t.objectStore("p2pkh_utxos");
        return Promise.all(rows.map((r) => reqAsPromise(store.put(r))));
      });
    },
    async clearUtxosForResource(resourceId: string): Promise<void> {
      await tx(handle, "p2pkh_utxos", "readwrite", async (t) => {
        const idx = t.objectStore("p2pkh_utxos").index("resourceId");
        const keys: IDBValidKey[] = await reqAsPromise(idx.getAllKeys(resourceId));
        const store = t.objectStore("p2pkh_utxos");
        return Promise.all(keys.map((k) => reqAsPromise(store.delete(k))));
      });
    },
    async replaceUtxosForResource(resourceId: string, rows: P2pkhUtxo[]): Promise<void> {
      await tx(handle, "p2pkh_utxos", "readwrite", async (t) => {
        const store = t.objectStore("p2pkh_utxos");
        const idx = store.index("resourceId");
        const keys: IDBValidKey[] = await reqAsPromise(idx.getAllKeys(resourceId));
        await Promise.all(keys.map((k) => reqAsPromise(store.delete(k))));
        await Promise.all(rows.map((r) => reqAsPromise(store.put(r))));
      });
    },
    async listUtxos(): Promise<P2pkhUtxo[]> {
      return tx(handle, "p2pkh_utxos", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_utxos").getAll())
      );
    },

    // ---------- history ----------
    async putHistory(rows: P2pkhHistoryItem[]): Promise<void> {
      if (rows.length === 0) return;
      await tx(handle, "p2pkh_history", "readwrite", (t) => {
        const store = t.objectStore("p2pkh_history");
        return Promise.all(rows.map((r) => reqAsPromise(store.put(r))));
      });
    },
    async listHistory(): Promise<P2pkhHistoryItem[]> {
      return tx(handle, "p2pkh_history", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history").getAll())
      );
    },
    async clearHistoryForResource(resourceId: string): Promise<void> {
      await tx(handle, "p2pkh_history", "readwrite", async (t) => {
        const idx = t.objectStore("p2pkh_history").index("resourceId");
        const keys: IDBValidKey[] = await reqAsPromise(idx.getAllKeys(resourceId));
        const store = t.objectStore("p2pkh_history");
        return Promise.all(keys.map((k) => reqAsPromise(store.delete(k))));
      });
    },
    async getHistoryByTxid(resourceId: string, txid: string): Promise<P2pkhHistoryItem | undefined> {
      return tx(handle, "p2pkh_history", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history").get(newHistoryId(resourceId, txid)))
      );
    },

    // ---------- backfill ----------
    async getBackfillState(resourceId: string): Promise<P2pkhBackfillState | undefined> {
      return tx(handle, "p2pkh_history_backfill", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history_backfill").get(resourceId))
      );
    },
    async putBackfillState(state: P2pkhBackfillState): Promise<void> {
      await tx(handle, "p2pkh_history_backfill", "readwrite", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history_backfill").put(state))
      );
    },
    async listBackfillStates(): Promise<P2pkhBackfillState[]> {
      return tx(handle, "p2pkh_history_backfill", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history_backfill").getAll())
      );
    },
    async clearBackfillState(resourceId: string): Promise<void> {
      await tx(handle, "p2pkh_history_backfill", "readwrite", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history_backfill").delete(resourceId))
      );
    },

    // ---------- recent sync ----------
    async getRecentSyncState(resourceId: string): Promise<P2pkhRecentSyncState | undefined> {
      return tx(handle, "p2pkh_recent_sync", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_recent_sync").get(resourceId))
      );
    },
    async putRecentSyncState(state: P2pkhRecentSyncState): Promise<void> {
      await tx(handle, "p2pkh_recent_sync", "readwrite", (t) =>
        reqAsPromise(t.objectStore("p2pkh_recent_sync").put(state))
      );
    },
    async listRecentSyncStates(): Promise<P2pkhRecentSyncState[]> {
      return tx(handle, "p2pkh_recent_sync", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_recent_sync").getAll())
      );
    },

    // ---------- pending transfers ----------
    async putPendingTransfer(t: P2pkhPendingTransfer): Promise<void> {
      await tx(handle, "p2pkh_pending_transfers", "readwrite", (store) =>
        reqAsPromise(store.objectStore("p2pkh_pending_transfers").put(t))
      );
    },
    async listPendingTransfers(): Promise<P2pkhPendingTransfer[]> {
      return tx(handle, "p2pkh_pending_transfers", "readonly", (store) =>
        reqAsPromise(store.objectStore("p2pkh_pending_transfers").getAll())
      );
    },
    async listPendingTransfersByResource(resourceId: string): Promise<P2pkhPendingTransfer[]> {
      return tx(handle, "p2pkh_pending_transfers", "readonly", (store) =>
        reqAsPromise(store.objectStore("p2pkh_pending_transfers").index("resourceId").getAll(resourceId))
      );
    },
    async removePendingTransfer(id: string): Promise<void> {
      await tx(handle, "p2pkh_pending_transfers", "readwrite", (store) =>
        reqAsPromise(store.objectStore("p2pkh_pending_transfers").delete(id))
      );
    },

    // ---------- reservations ----------
    async putReservation(r: P2pkhUtxoReservation): Promise<void> {
      await tx(handle, "p2pkh_utxo_reservations", "readwrite", (store) =>
        reqAsPromise(store.objectStore("p2pkh_utxo_reservations").put(r))
      );
    },
    async listReservations(): Promise<P2pkhUtxoReservation[]> {
      return tx(handle, "p2pkh_utxo_reservations", "readonly", (store) =>
        reqAsPromise(store.objectStore("p2pkh_utxo_reservations").getAll())
      );
    },
    async listReservationsByResource(resourceId: string): Promise<P2pkhUtxoReservation[]> {
      return tx(handle, "p2pkh_utxo_reservations", "readonly", (store) =>
        reqAsPromise(store.objectStore("p2pkh_utxo_reservations").index("resourceId").getAll(resourceId))
      );
    },
    async removeReservation(id: string): Promise<void> {
      await tx(handle, "p2pkh_utxo_reservations", "readwrite", (store) =>
        reqAsPromise(store.objectStore("p2pkh_utxo_reservations").delete(id))
      );
    },

    // ---------- 原子提交 ----------
    async commitBackfillPage(commit: P2pkhBackfillCommit): Promise<void> {
      await tx(
        handle,
        ["p2pkh_addresses", "p2pkh_history", "p2pkh_history_backfill"],
        "readwrite",
        async (t) => {
          const addressStore = t.objectStore("p2pkh_addresses");
          const histStore = t.objectStore("p2pkh_history");
          const backfillStore = t.objectStore("p2pkh_history_backfill");
          const currentAddress = await reqAsPromise<P2pkhKeyResource | undefined>(addressStore.get(commit.resourceId));
          if (!currentAddress) {
            throw new Error("resource deleted");
          }
          if (currentAddress.generation !== commit.expectedGeneration) {
            throw new Error("generation mismatch");
          }
          const existing = await reqAsPromise<P2pkhBackfillState | undefined>(
            backfillStore.get(commit.resourceId)
          );
          const currentRevision = existing?.revision ?? 0;
          if (currentRevision !== commit.expectedRevision) {
            throw new Error("revision mismatch");
          }
          const now = new Date().toISOString();
          for (const item of commit.page) {
            const id = newHistoryId(commit.resourceId, item.txid);
            const prev = (await reqAsPromise<P2pkhHistoryItem | undefined>(histStore.get(id))) ?? null;
            const merged: P2pkhHistoryItem = {
              id,
              resourceId: commit.resourceId,
              keyId: currentAddress.keyId,
              publicKeyHash: currentAddress.publicKeyHash,
              network: currentAddress.network,
              address: currentAddress.address,
              txid: item.txid,
              height: item.height,
              status: "confirmed",
              source: "woc-confirmed",
              syncedAt: prev?.syncedAt ?? now
            };
            if (prev) {
              if (prev.status === "confirmed" || prev.status === "unconfirmed" || prev.status === "pending") {
                merged.status = "confirmed";
              }
              if (prev.syncedAt) merged.syncedAt = prev.syncedAt;
              if (prev.source && prev.source !== "woc-confirmed") merged.source = prev.source;
              if (prev.publicKeyHash) merged.publicKeyHash = prev.publicKeyHash;
              if (prev.network) merged.network = prev.network;
              if (prev.address) merged.address = prev.address;
            }
            await reqAsPromise(histStore.put(merged));
          }
          const next: P2pkhBackfillState = {
            resourceId: commit.resourceId,
            status: commit.nextPageToken ? "running" : "complete",
            nextPageToken: commit.nextPageToken,
            anchorTxids: existing?.anchorTxids ?? [],
            pagesSynced: (existing?.pagesSynced ?? 0) + 1,
            recordsSynced: (existing?.recordsSynced ?? 0) + commit.page.length,
            revision: currentRevision + 1,
            lastError: undefined,
            updatedAt: now
          };
          await reqAsPromise(backfillStore.put(next));
        }
      );
    },

    async commitRecentSnapshot(commit: P2pkhRecentCommit): Promise<void> {
      // 硬切换 001：事务范围不再包含 p2pkh_balances——余额不再落库。
      await tx(
        handle,
        [
          "p2pkh_addresses",
          "p2pkh_utxos",
          "p2pkh_history",
          "p2pkh_recent_sync",
          "p2pkh_utxo_reservations",
          "p2pkh_pending_transfers"
        ],
        "readwrite",
        async (t) => {
          const addressStore = t.objectStore("p2pkh_addresses");
          const now = new Date().toISOString();
          const currentAddress = await reqAsPromise<P2pkhKeyResource | undefined>(addressStore.get(commit.resourceId));
          if (!currentAddress) {
            throw new Error("resource deleted");
          }
          if (commit.expectedGeneration !== undefined && currentAddress.generation !== commit.expectedGeneration) {
            throw new Error("generation mismatch");
          }
          const effectiveResource = currentAddress;
          if (commit.utxos) {
            const utxoStore = t.objectStore("p2pkh_utxos");
            const idx = utxoStore.index("resourceId");
            const keys: IDBValidKey[] = await reqAsPromise(idx.getAllKeys(commit.resourceId));
            for (const k of keys) await reqAsPromise(utxoStore.delete(k));
            for (const u of commit.utxos) await reqAsPromise(utxoStore.put(u));
          }
          if (commit.recentHistory) {
            const histStore = t.objectStore("p2pkh_history");
            for (const h of commit.recentHistory) {
              const id = newHistoryId(commit.resourceId, h.txid);
              const prev = await reqAsPromise<P2pkhHistoryItem | undefined>(histStore.get(id));
              if (prev?.status === "confirmed" && h.status !== "confirmed") continue;
              const merged: P2pkhHistoryItem = {
                id,
                resourceId: commit.resourceId,
                keyId: effectiveResource.keyId,
                publicKeyHash: effectiveResource.publicKeyHash,
                network: effectiveResource.network,
                address: effectiveResource.address,
                txid: h.txid,
                height: h.height,
                status: h.status,
                source: h.source,
                syncedAt: prev?.syncedAt && prev?.syncedAt > h.syncedAt ? prev.syncedAt : h.syncedAt
              };
              await reqAsPromise(histStore.put(merged));
            }
          }
          if (commit.unconfirmedHistory) {
            const histStore = t.objectStore("p2pkh_history");
            const presentIds = new Set(
              commit.unconfirmedHistory.map((h) => newHistoryId(commit.resourceId, h.txid))
            );
            const allForResource = await reqAsPromise<IDBValidKey[]>(
              histStore.index("resourceId").getAllKeys(commit.resourceId)
            );
            const MISSING_THRESHOLD = 3;
            for (const key of allForResource) {
              const id = String(key);
              const prev = await reqAsPromise<P2pkhHistoryItem | undefined>(histStore.get(id));
              if (!prev) continue;
              if (prev.status === "confirmed") continue;
              if (presentIds.has(id)) {
                if (prev.missingObservationCount) {
                  await reqAsPromise(histStore.put({ ...prev, missingObservationCount: 0, syncedAt: now }));
                }
                continue;
              }
              const count = (prev.missingObservationCount ?? 0) + 1;
              if (count >= MISSING_THRESHOLD) {
                if (prev.status !== "dropped") {
                  await reqAsPromise(histStore.put({ ...prev, status: "dropped", missingObservationCount: count, syncedAt: now }));
                }
              } else if (count !== prev.missingObservationCount) {
                await reqAsPromise(histStore.put({ ...prev, missingObservationCount: count, syncedAt: now }));
              }
            }
            for (const h of commit.unconfirmedHistory) {
              const id = newHistoryId(commit.resourceId, h.txid);
              const prev = await reqAsPromise<P2pkhHistoryItem | undefined>(histStore.get(id));
              if (prev?.status === "confirmed") continue;
              await reqAsPromise(histStore.put({
                ...h,
                id,
                resourceId: commit.resourceId,
                publicKeyHash: effectiveResource.publicKeyHash,
                network: effectiveResource.network,
                address: effectiveResource.address
              }));
            }
          }
          if (commit.recentConfirmedTxids) {
            const recentStore = t.objectStore("p2pkh_recent_sync");
            const existing = await reqAsPromise<P2pkhRecentSyncState | undefined>(recentStore.get(commit.resourceId));
            const next: P2pkhRecentSyncState = {
              resourceId: commit.resourceId,
              recentConfirmedTxids: commit.recentConfirmedTxids,
              lastCheckedAt: now,
              lastSuccessAt: now,
              lastError: existing?.lastError
            };
            await reqAsPromise(recentStore.put(next));
          }
          if (commit.reservations) {
            const store = t.objectStore("p2pkh_utxo_reservations");
            for (const r of commit.reservations) await reqAsPromise(store.put(r));
          }
          if (commit.pendingTransfers) {
            const store = t.objectStore("p2pkh_pending_transfers");
            for (const p of commit.pendingTransfers) await reqAsPromise(store.put(p));
          }
        }
      );
    },

    // ---------- 清理 ----------
    /** 清理当前 namespace 内所有数据。设计缘由：删除 key 时 namespace DB 整体删除，
     *  本方法用于手动重置或迁移失败回滚。硬切换 001：余额不再落库，
     *  clearAll 不再调用 clearBalance。 */
    async clearAll(): Promise<void> {
      const resources = await this.listResourcesByKey("");
      for (const r of resources) {
        await this.removeResource(r.resourceId);
        await this.clearUtxosForResource(r.resourceId);
        await this.clearHistoryForResource(r.resourceId);
        await this.clearBackfillState(r.resourceId);
        const pendings = await this.listPendingTransfersByResource(r.resourceId);
        for (const p of pendings) await this.removePendingTransfer(p.id);
        const reservations = await this.listReservationsByResource(r.resourceId);
        for (const rs of reservations) await this.removeReservation(rs.id);
      }
    }
  };
}

export type P2pkhDbHandle = ReturnType<typeof createP2pkhDb>;

/** 工具：从已知的 keyId/network 构造 resourceId（保留供 transfer service 等调用）。 */
export function resourceIdFor(keyId: string, network: BsvNetwork): string {
  return makeResourceId(keyId, network);
}

/** 工具：reservation id。 */
export function reservationIdFor(resourceId: string, txid: string, vout: number): string {
  return newReservationId(resourceId, txid, vout);
}

/**
 * best-effort 旧 DB 迁移：把全局 "p2pkh" DB 的资源按 keyId 找对应 publicKeyHash，
 * 写入对应 namespace DB；迁移成功后删除旧 DB。
 * 失败时只丢弃旧缓存；不阻断解锁。
 */
export interface LegacyMigrationSummary {
  migrated: number;
  failed: number;
  abandoned: boolean;
}

export async function migrateLegacyP2pkhDb(input: {
  keyspace: KeyspaceService;
  /** 把旧记录 keyId 映射到当前 active 的 publicKeyHash；找不到时跳过。 */
  resolvePublicKeyHash: (oldKeyId: string) => Promise<string | undefined>;
  onProgress?: (summary: LegacyMigrationSummary) => void;
}): Promise<LegacyMigrationSummary> {
  if (typeof indexedDB === "undefined") {
    return { migrated: 0, failed: 0, abandoned: false };
  }
  // 1) 读取旧 DB。
  const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);
    req.onupgradeneeded = () => {
      // 旧 DB 不应该在我们手里被升级；保留 onupgradeneeded 占位但不创建新 store。
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => undefined);
  if (!oldDb) return { migrated: 0, failed: 0, abandoned: false };
  try {
    const stores = [...oldDb.objectStoreNames];
    if (!stores.includes("p2pkh_addresses")) {
      return { migrated: 0, failed: 0, abandoned: false };
    }
    const oldResources = await readAllFromLegacy<P2pkhKeyResource>(oldDb, "p2pkh_addresses");
    const oldUtxos = await readAllFromLegacy<P2pkhUtxo>(oldDb, "p2pkh_utxos");
    const oldHistory = await readAllFromLegacy<P2pkhHistoryItem>(oldDb, "p2pkh_history");
    // 硬切换 001：不再迁移旧 balance 行——余额改为 service 现算，
    // 即使旧 DB 仍有 p2pkh_balances 行也只能让它们随旧 DB 删除一起丢弃。
    const summary: LegacyMigrationSummary = { migrated: 0, failed: 0, abandoned: false };
    // 按 keyId 分组写到对应 namespace。
    const byKey = new Map<string, { resources: P2pkhKeyResource[]; utxos: P2pkhUtxo[]; history: P2pkhHistoryItem[] }>();
    function bucket(keyId: string) {
      let b = byKey.get(keyId);
      if (!b) {
        b = { resources: [], utxos: [], history: [] };
        byKey.set(keyId, b);
      }
      return b;
    }
    for (const r of oldResources) bucket(r.keyId).resources.push(r);
    for (const u of oldUtxos) bucket(u.keyId).utxos.push(u);
    for (const h of oldHistory) bucket(h.keyId).history.push(h);
    for (const [oldKeyId, group] of byKey) {
      const publicKeyHash = await input.resolvePublicKeyHash(oldKeyId);
      if (!publicKeyHash) {
        summary.failed += group.resources.length;
        continue;
      }
      try {
        const handle = await input.keyspace.openKeyStorage({
          publicKeyHash,
          pluginId: "p2pkh",
          storageId: P2PKH_STORAGE_ID,
          version: P2PKH_DB_VERSION,
          upgrade: (db) => createV5Stores(db)
        });
        const target = createP2pkhDb({
          publicKeyHash,
          close: () => handle.close(),
          getDb: () => handle.db
        });
        for (const r of group.resources) {
          await target.putAddress({ ...r, publicKeyHash });
        }
        for (const u of group.utxos) {
          await target.putUtxos([{ ...u, publicKeyHash }]);
        }
        for (const h of group.history) {
          await target.putHistory([{ ...h, publicKeyHash }]);
        }
        handle.close();
        summary.migrated += group.resources.length;
      } catch (err) {
        summary.failed += group.resources.length;
        summary.abandoned = true;
        console.error("P2PKH legacy migration failed for key", oldKeyId, err);
      }
    }
    input.onProgress?.(summary);
    // 2) 迁移成功后删除旧 DB。
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(LEGACY_DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("legacy p2pkh DB delete blocked"));
    });
    return summary;
  } catch (err) {
    console.error("P2PKH legacy migration failed", err);
    return { migrated: 0, failed: 0, abandoned: true };
  } finally {
    try {
      oldDb.close();
    } catch {
      // 静默
    }
  }
}

function readAllFromLegacy<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}
