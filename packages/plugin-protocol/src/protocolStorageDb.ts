// packages/plugin-protocol/src/protocolStorageDb.ts
// popup 协议存储 IndexedDB（commands / origins / feePools / connectSessions
// 四 store）。
//
// 设计缘由（施工单 002 + 2026-06-28 001 + 2026-06-28 002 硬切换）：
//   - DB 名：`keymaster.protocol`。**不**挂到 `keyspace.openKeyStorage()`
//     的 per-key namespace，因为命令历史按 domain 走，按 key 走会让
//     "切了 key 看不到旧站点历史" 这种行为偷偷出现。
//   - DB version：5。
//       - v2：单 `commands` store 升级为三 store（commands / origins / feePools）；
//       - v3：feePools record 结构变了（新增 `draftSpendTxHex` /
//         `draftClientSignBytes`），升级时清空 feePools store（不迁数据）；
//       - v4：新增 `connectSessions` store（auth session 真值；不含
//         unlock runtime / 密码）；
//       - v5（施工单 2026-06-28 002 硬切换）：owner 真值收口成
//         `ownerPublicKeyHex`，`ownerKeyId` 不再落库；feePool key 维度
//         补 `ownerPublicKeyHex`；旧 `connectSessions` / `feePools` /
//         `commands` 全部清空（owner 真值、session 归属、fee pool key、
//         业务方法 contract 都改了——为了保留旧数据而引入双读 / 双写
//         不值得；直接重建 DB 更简单）。commands 同步加
//         `connectSessionId` + `ownerPublicKeyHex` 字段。
//   - `commands`：命令流历史，主键 `record.id`（与 transport requestId
//     解耦）。索引 `origin` / `updatedAt` / compound `[origin, updatedAt]`。
//   - `origins`：按 exact origin 存站点级配置；主键 `origin`。
//   - `feePools`：按 `${origin}::${ownerPublicKeyHex}::${counterpartyPublicKeyHex}`
//     复合 key 存费用池状态（v5 补 ownerPublicKeyHex 维度）；主键 `poolKey`；
//     索引 `origin`（便于按 origin 列出）。
//   - `connectSessions`：auth session 真值；主键 `sessionId`；索引 `origin`
//     （便于按 origin 列出该站点的所有 session 含已 revoked 的）。
//   - **不**存 `operations` store（pending fee pool operation 走内存）。
//   - **不**存敏感正文：参见 "历史持久化范围"。
//   - **不**存密码 / 不存 unlock runtime 任何派生材料。
//   - **不**存 `ownerKeyId`：vault 内部借用句柄按需从 keyspace 解析。
//   - DB 异常一律 `console.error + rethrow`；调用方拿到错误时自己决定
//     怎么降级（p2pkh → manual confirm；feepool → fail-closed；connect
//     session 不可用 → caller 被要求重新登录）。

import type {
  ConnectSessionRecord,
  ProtocolCommandRecord,
  ProtocolFeePoolRecord,
  ProtocolOriginSettingsRecord,
  ProtocolStorageDb
} from "@keymaster/contracts";

const DB_NAME = "keymaster.protocol";
// V5（施工单 2026-06-28 002 硬切换）：owner 真值收口成 `ownerPublicKeyHex`，
// `ownerKeyId` 不再落库；feePool 持久化 key 补 `ownerPublicKeyHex` 维度；
// `connectSessions` / `feePools` / `commands` 全部清空重建。
// 设计缘由：硬切换改的是 owner 真值 / session 归属 / fee pool key /
// 业务方法 contract；为了保留旧数据而引入双读 / 双写 / 旧 shape 兼容
// 分支比直接重建 DB 更复杂也更脏。命令历史按 origin 归档，跨升级
// 失去历史不影响协议功能。
const DB_VERSION = 5;
const STORE_COMMANDS = "commands";
const STORE_ORIGINS = "origins";
const STORE_FEE_POOLS = "feePools";
const STORE_CONNECT_SESSIONS = "connectSessions";

/**
 * 打开协议存储 DB。同一进程内只打开一次；后续 `openProtocolStorageDb()`
 * 调用复用同一连接。`onupgradeneeded` 里建缺失的 store + 索引；幂等升级。
 */
export async function openProtocolStorageDb(): Promise<ProtocolStorageDb> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  return new Promise<ProtocolStorageDb>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      const newVersion = event.newVersion ?? DB_VERSION;
      // commands（v1 已建过；v0 → v2 也会落这里）
      if (!db.objectStoreNames.contains(STORE_COMMANDS)) {
        const store = db.createObjectStore(STORE_COMMANDS, { keyPath: "id" });
        store.createIndex("origin", "origin", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
        // compound index: origin 优先，再按 updatedAt 倒序拉历史。
        store.createIndex("origin_updatedAt", ["origin", "updatedAt"], { unique: false });
      }
      // origins（v1 → v2 升级时新建）
      if (!db.objectStoreNames.contains(STORE_ORIGINS)) {
        db.createObjectStore(STORE_ORIGINS, { keyPath: "origin" });
      }
      // feePools（v1 → v2 升级时新建）
      if (!db.objectStoreNames.contains(STORE_FEE_POOLS)) {
        const store = db.createObjectStore(STORE_FEE_POOLS, { keyPath: "poolKey" });
        store.createIndex("origin", "origin", { unique: false });
      }
      // V3 迁移（施工单 002 收尾反馈 V5）：feePools record 结构变了
      // （新增 `draftSpendTxHex` / `draftClientSignBytes`，`serverAmount`
      // 语义改为"累计"）。旧 v2 记录里**没有**这些字段，进入新版
      // `spend` 路径读取 `prior.draftSpendTxHex` 时会读到 undefined，导致
      // 后续 `loadTx` 抛错。V3 升级时**清空** feePools store（不迁数据）；
      // site 第一次重新发起 transfer 时按新模型重建池。
      if (oldVersion < 3 && db.objectStoreNames.contains(STORE_FEE_POOLS)) {
        db.deleteObjectStore(STORE_FEE_POOLS);
        const store = db.createObjectStore(STORE_FEE_POOLS, { keyPath: "poolKey" });
        store.createIndex("origin", "origin", { unique: false });
      }
      // V4 迁移（施工单 2026-06-28 001 硬切换）：新增 connectSessions store；
      // 主键 sessionId，索引 origin（便于按 origin 列出该站点的所有
      // session，包括已 revoked）。无任何"密码 / 解锁运行时材料"字段
      // 落盘。
      if (!db.objectStoreNames.contains(STORE_CONNECT_SESSIONS)) {
        const store = db.createObjectStore(STORE_CONNECT_SESSIONS, { keyPath: "sessionId" });
        store.createIndex("origin", "origin", { unique: false });
      }
      // V5 迁移（施工单 2026-06-28 002 硬切换）：重建 commands / feePools /
      // connectSessions 三 store；origins 不动（per-origin 站点配置是
      // 业务策略，不属于"owner 真值 / 业务方法 contract"硬切范围）。
      // commands / feePools / connectSessions 数据全部清空——
      // owner 真值、session 归属、fee pool key、业务方法 contract 全部
      // 改过；保留旧数据需要为每个老 shape 写双读分支，比重建更脏。
      // site 升级后 caller 须重新走 connect.login；老 sessionId 全部
      // 失效——这是设计明确的边界。
      if (oldVersion < 5) {
        for (const storeName of [
          STORE_COMMANDS,
          STORE_FEE_POOLS,
          STORE_CONNECT_SESSIONS
        ]) {
          if (db.objectStoreNames.contains(storeName)) {
            db.deleteObjectStore(storeName);
          }
        }
        // commands：主键 id，索引 origin / updatedAt / [origin, updatedAt]。
        const cmdStore = db.createObjectStore(STORE_COMMANDS, { keyPath: "id" });
        cmdStore.createIndex("origin", "origin", { unique: false });
        cmdStore.createIndex("updatedAt", "updatedAt", { unique: false });
        cmdStore.createIndex("origin_updatedAt", ["origin", "updatedAt"], { unique: false });
        // feePools：v5 补 ownerPublicKeyHex 维度，但 IndexedDB 不需要单独的
        // ownerPublicKeyHex 索引（listFeePoolsByOrigin 已经够用）。如果
        // 未来需要按 owner 维度拉取，可再加 `origin_owner` 索引。
        const poolStore = db.createObjectStore(STORE_FEE_POOLS, { keyPath: "poolKey" });
        poolStore.createIndex("origin", "origin", { unique: false });
        const sessionStore = db.createObjectStore(STORE_CONNECT_SESSIONS, { keyPath: "sessionId" });
        sessionStore.createIndex("origin", "origin", { unique: false });
      }
      void newVersion;
    };
    req.onsuccess = () => {
      const db = req.result;
      resolve(createImpl(db));
    };
    req.onerror = () => {
      const err = req.error ?? new Error("Failed to open keymaster.protocol");
      reject(err);
    };
    req.onblocked = () => {
      // 另一标签页正持有旧连接，提示但不抛。
      console.error("[protocol.storageDb] open blocked by another tab");
    };
  });
}

function createImpl(db: IDBDatabase): ProtocolStorageDb {
  function txCommands(mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(STORE_COMMANDS, mode).objectStore(STORE_COMMANDS);
  }
  function txOrigins(mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(STORE_ORIGINS, mode).objectStore(STORE_ORIGINS);
  }
  function txFeePools(mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(STORE_FEE_POOLS, mode).objectStore(STORE_FEE_POOLS);
  }
  function txConnectSessions(mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(STORE_CONNECT_SESSIONS, mode).objectStore(STORE_CONNECT_SESSIONS);
  }

  return {
    /* ============== commands ============== */
    async putCommand(record: ProtocolCommandRecord): Promise<void> {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = txCommands("readwrite").put(record);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error ?? new Error("putCommand failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] putCommand failed", {
          id: record.id,
          origin: record.origin,
          method: record.method,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async getCommand(id: string): Promise<ProtocolCommandRecord | null> {
      try {
        return await new Promise<ProtocolCommandRecord | null>((resolve, reject) => {
          const req = txCommands("readonly").get(id);
          req.onsuccess = () => {
            const v = req.result as ProtocolCommandRecord | undefined;
            resolve(v ?? null);
          };
          req.onerror = () => reject(req.error ?? new Error("getCommand failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] getCommand failed", {
          id,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async listCommandsByOrigin(origin: string): Promise<ProtocolCommandRecord[]> {
      try {
        return await new Promise<ProtocolCommandRecord[]>((resolve, reject) => {
          const store = txCommands("readonly");
          const idx = store.index("origin_updatedAt");
          // IDBKeyRange.bound 用 [origin, 0] -> [origin, +∞] 做 prefix
          // 范围，再用 `prev` 拿 updatedAt 倒序。
          const range = IDBKeyRange.bound([origin, 0], [origin, Number.MAX_SAFE_INTEGER]);
          const out: ProtocolCommandRecord[] = [];
          const req = idx.openCursor(range, "prev");
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
              const value = cursor.value as ProtocolCommandRecord;
              if (value.origin === origin) {
                out.push(value);
              }
              cursor.continue();
            } else {
              resolve(out);
            }
          };
          req.onerror = () => reject(req.error ?? new Error("listCommandsByOrigin failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] listCommandsByOrigin failed", {
          origin,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },

    /* ============== origins ============== */
    async getOrigin(origin: string): Promise<ProtocolOriginSettingsRecord | null> {
      try {
        return await new Promise<ProtocolOriginSettingsRecord | null>((resolve, reject) => {
          const req = txOrigins("readonly").get(origin);
          req.onsuccess = () => {
            const v = req.result as ProtocolOriginSettingsRecord | undefined;
            resolve(v ?? null);
          };
          req.onerror = () => reject(req.error ?? new Error("getOrigin failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] getOrigin failed", {
          origin,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async putOrigin(record: ProtocolOriginSettingsRecord): Promise<void> {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = txOrigins("readwrite").put(record);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error ?? new Error("putOrigin failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] putOrigin failed", {
          origin: record.origin,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async listOrigins(): Promise<ProtocolOriginSettingsRecord[]> {
      try {
        return await new Promise<ProtocolOriginSettingsRecord[]>((resolve, reject) => {
          const out: ProtocolOriginSettingsRecord[] = [];
          const req = txOrigins("readonly").openCursor();
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
              out.push(cursor.value as ProtocolOriginSettingsRecord);
              cursor.continue();
            } else {
              resolve(out);
            }
          };
          req.onerror = () => reject(req.error ?? new Error("listOrigins failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] listOrigins failed", {
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },

    /* ============== feePools ============== */
    async getFeePool(poolKey: string): Promise<ProtocolFeePoolRecord | null> {
      try {
        return await new Promise<ProtocolFeePoolRecord | null>((resolve, reject) => {
          const req = txFeePools("readonly").get(poolKey);
          req.onsuccess = () => {
            const v = req.result as ProtocolFeePoolRecord | undefined;
            resolve(v ?? null);
          };
          req.onerror = () => reject(req.error ?? new Error("getFeePool failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] getFeePool failed", {
          poolKey,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async putFeePool(record: ProtocolFeePoolRecord): Promise<void> {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = txFeePools("readwrite").put(record);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error ?? new Error("putFeePool failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] putFeePool failed", {
          poolKey: record.poolKey,
          origin: record.origin,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async deleteFeePool(poolKey: string): Promise<void> {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = txFeePools("readwrite").delete(poolKey);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error ?? new Error("deleteFeePool failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] deleteFeePool failed", {
          poolKey,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async listFeePoolsByOrigin(origin: string): Promise<ProtocolFeePoolRecord[]> {
      try {
        return await new Promise<ProtocolFeePoolRecord[]>((resolve, reject) => {
          const store = txFeePools("readonly");
          const idx = store.index("origin");
          const out: ProtocolFeePoolRecord[] = [];
          const req = idx.openCursor(IDBKeyRange.only(origin));
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
              out.push(cursor.value as ProtocolFeePoolRecord);
              cursor.continue();
            } else {
              resolve(out);
            }
          };
          req.onerror = () => reject(req.error ?? new Error("listFeePoolsByOrigin failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] listFeePoolsByOrigin failed", {
          origin,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },

    /* ============== connectSessions（施工单 2026-06-28 001） ============== */
    async putConnectSession(record: ConnectSessionRecord): Promise<void> {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = txConnectSessions("readwrite").put(record);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error ?? new Error("putConnectSession failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] putConnectSession failed", {
          sessionId: record.sessionId,
          origin: record.origin,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async getConnectSession(sessionId: string): Promise<ConnectSessionRecord | null> {
      try {
        return await new Promise<ConnectSessionRecord | null>((resolve, reject) => {
          const req = txConnectSessions("readonly").get(sessionId);
          req.onsuccess = () => {
            const v = req.result as ConnectSessionRecord | undefined;
            resolve(v ?? null);
          };
          req.onerror = () => reject(req.error ?? new Error("getConnectSession failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] getConnectSession failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async listConnectSessionsByOrigin(origin: string): Promise<ConnectSessionRecord[]> {
      try {
        return await new Promise<ConnectSessionRecord[]>((resolve, reject) => {
          const store = txConnectSessions("readonly");
          const idx = store.index("origin");
          const out: ConnectSessionRecord[] = [];
          const req = idx.openCursor(IDBKeyRange.only(origin));
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
              out.push(cursor.value as ConnectSessionRecord);
              cursor.continue();
            } else {
              resolve(out);
            }
          };
          req.onerror = () => reject(req.error ?? new Error("listConnectSessionsByOrigin failed"));
        });
      } catch (err) {
        console.error("[protocol.storageDb] listConnectSessionsByOrigin failed", {
          origin,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  };
}
