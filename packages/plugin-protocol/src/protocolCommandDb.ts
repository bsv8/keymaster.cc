// packages/plugin-protocol/src/protocolCommandDb.ts
// popup 命令流历史 IndexedDB。
//
// 设计缘由（施工单 002 硬切换：popup 复用与命令流）：
//   - DB 名：`keymaster.protocol`。**不**挂到 `keyspace.openKeyStorage()`
//     的 per-key namespace，因为命令历史按 domain 走，按 key 走会让
//     "切了 key 看不到旧站点历史" 这种行为偷偷出现。
//   - store 名：`commands`，主键为 `record.id`（与 transport requestId
//     同源但语义不同）。
//   - 索引：
//       * `origin`  → 按 origin 检索
//       * `updatedAt` → 按时间排序
//       * compound `[origin, updatedAt]` → 按 origin 拉历史 + 按时间倒序
//   - 不存敏感正文：参见施工单 "历史持久化范围"。
//   - DB 异常不抛出在调用方路径上：本模块所有方法 `await` 后 try/catch
//     并把错误以英文写到 console.error；调用方拿不到时按"historyAvailable=false"
//     降级。

import type {
  ProtocolCommandDb,
  ProtocolCommandRecord
} from "@keymaster/contracts";

const DB_NAME = "keymaster.protocol";
const DB_VERSION = 1;
const STORE_COMMANDS = "commands";

/**
 * 打开协议命令 DB。同一进程内只打开一次；后续 `openProtocolCommandDb()`
 * 调用复用同一连接。`onupgradeneeded` 里建 store + 索引。
 */
export async function openProtocolCommandDb(): Promise<ProtocolCommandDb> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  return new Promise<ProtocolCommandDb>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_COMMANDS)) {
        const store = db.createObjectStore(STORE_COMMANDS, { keyPath: "id" });
        store.createIndex("origin", "origin", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
        // compound index: origin 优先，再按 updatedAt 倒序拉历史。
        store.createIndex("origin_updatedAt", ["origin", "updatedAt"], { unique: false });
      }
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
      console.error("[protocol.commandDb] open blocked by another tab");
    };
  });
}

function createImpl(db: IDBDatabase): ProtocolCommandDb {
  function tx(mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(STORE_COMMANDS, mode).objectStore(STORE_COMMANDS);
  }
  return {
    async putCommand(record: ProtocolCommandRecord): Promise<void> {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = tx("readwrite").put(record);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error ?? new Error("putCommand failed"));
        });
      } catch (err) {
        console.error("[protocol.commandDb] putCommand failed", {
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
          const req = tx("readonly").get(id);
          req.onsuccess = () => {
            const v = req.result as ProtocolCommandRecord | undefined;
            resolve(v ?? null);
          };
          req.onerror = () => reject(req.error ?? new Error("getCommand failed"));
        });
      } catch (err) {
        console.error("[protocol.commandDb] getCommand failed", {
          id,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async listCommandsByOrigin(origin: string): Promise<ProtocolCommandRecord[]> {
      try {
        return await new Promise<ProtocolCommandRecord[]>((resolve, reject) => {
          const store = tx("readonly");
          const idx = store.index("origin_updatedAt");
          // IDBKeyRange.bound 用 [origin, 0] -> [origin, +∞] 做 prefix
          // 范围，再用 `reverse()` 拿 updatedAt 倒序。
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
        console.error("[protocol.commandDb] listCommandsByOrigin failed", {
          origin,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  };
}
