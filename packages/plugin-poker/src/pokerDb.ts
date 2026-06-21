// packages/plugin-poker/src/pokerDb.ts
// Poker key-scoped 本地缓存：只保存"明确属于某把 key 的扑克状态"——
// presences / tables / txIngest / lastPresence replay / ownedTablePublishes
// replay；**不**再保存全局网络配置，**不**再保存独立 poker identity 绑定。
//
// 设计缘由（硬切换 004）：
//   - proxyEndpoint / 双平面 announce / fallback 开关属于全局网络配置，
//     已迁到 pokerGlobalConfig.ts；本模块不再持有。
//   - "稳定 poker identity binding"概念被删除；plugin-poker 永远跟随
//     active key，不再有独立绑定持久化记录。
//   - DB 名称遵循 keyspace 规范：
//     `keymaster.key.<publicKeyHex>.plugin.plugin-poker.poker`。
//   - vault 锁定时 key-scoped storage 不可用，service 必须按 fail-closed
//     处理。
//   - DB schema 升级走 `upgradePokerDb`；新增 store 必须递增
//     `POKER_KEY_STORAGE_VERSION`。
//
// 旧版本（v1 / v2）里存在的 `settings` / `identityBinding` store 在 v3
// schema 升级时被**忽略**——既不删除旧 store（避免误删老用户数据，但
// 我们承诺从 v3 起不再读取），也不创建。这样旧 IDB 残留物对当前代码完全
// 透明，跨切 active key 也不会意外拿到旧全局配置。

export const POKER_KEY_STORAGE_ID = "poker";
/**
 * DB 版本号：
 *   - v1：settings / tables / presences / txIngest
 *   - v2：+ identityBinding（硬切换 001 修订版稳定身份，硬切换 004 已删除）
 *   - v3：删除 settings / identityBinding；只保留 tables / presences / txIngest
 *
 * 升级策略（v3）：旧 store 名（"settings"、"identityBinding"）如果在 db
 * 里存在就保留在原地（不再使用），但不再创建。tables / presences /
 * txIngest 数据原样保留，按各自的 keyPath。
 */
export const POKER_KEY_STORAGE_VERSION = 3;

export interface CachedTable {
  tableId: string;
  variant: string;
  seats: number;
  stakes: number;
  ownerPub: string;
  observedAt: number;
}

export interface CachedPresence {
  publicKeyHex: string;
  endpoint?: string;
  nick?: string;
  seenAt: number;
}

export interface CachedTxIngest {
  txid: string;
  route: string;
  kind?: string;
  reason?: string;
  rawTx: Uint8Array;
  receivedAt: number;
  consumed: boolean;
}

/** 升级 DB schema（首次创建 / v1 / v2 → v3）。 */
export function upgradePokerDb(
  db: IDBDatabase,
  oldVersion: number,
  _newVersion: number | null
): void {
  // v3：tables / presences / txIngest 是真正的 key-scoped 状态。
  if (!db.objectStoreNames.contains("tables")) {
    const s = db.createObjectStore("tables", { keyPath: "tableId" });
    s.createIndex("observedAt", "observedAt");
  }
  if (!db.objectStoreNames.contains("presences")) {
    const s = db.createObjectStore("presences", { keyPath: "publicKeyHex" });
    s.createIndex("seenAt", "seenAt");
  }
  if (!db.objectStoreNames.contains("txIngest")) {
    const s = db.createObjectStore("txIngest", { keyPath: "txid" });
    s.createIndex("receivedAt", "receivedAt");
  }
  // 旧版本（v1 / v2）的 settings / identityBinding store 升级时不再
  // 创建；如果旧 db 已经存在（oldVersion < 3），保留在原地但当前代码
  // 不再访问。IndexedDB 的 objectStoreNames.contains 检查可以确保我们
  // 不重复创建同名的 store。
  // 注意：不要在这里 deleteObjectStore——删除操作会丢掉老用户数据，
  // 而且 IndexedDB 在 v3 升级路径里并不要求删除旧 store 即可正常工作。
  void oldVersion;
}

// ----------------------------------------------------------------------------
// tables store helpers
// ----------------------------------------------------------------------------

/** 把 CachedTable 写入 / 覆盖 tables store。 */
export function writeTable(db: IDBDatabase, table: CachedTable): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tables", "readwrite");
    const store = tx.objectStore("tables");
    const req = store.put(table);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("writeTable failed"));
  });
}

/** 列出 tables store 全部 row。 */
export function readAllTables(db: IDBDatabase): Promise<CachedTable[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tables", "readonly");
    const store = tx.objectStore("tables");
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as CachedTable[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("readAllTables failed"));
  });
}

/** 按 tableId 删除。 */
export function deleteTable(db: IDBDatabase, tableId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tables", "readwrite");
    const store = tx.objectStore("tables");
    const req = store.delete(tableId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("deleteTable failed"));
  });
}

/** 清空 tables store（key.deleting 清理）。 */
export function clearTables(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tables", "readwrite");
    const store = tx.objectStore("tables");
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("clearTables failed"));
  });
}

// ----------------------------------------------------------------------------
// presences store helpers
// ----------------------------------------------------------------------------

export function writePresence(db: IDBDatabase, presence: CachedPresence): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("presences", "readwrite");
    const store = tx.objectStore("presences");
    const req = store.put(presence);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("writePresence failed"));
  });
}

export function readAllPresences(db: IDBDatabase): Promise<CachedPresence[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("presences", "readonly");
    const store = tx.objectStore("presences");
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as CachedPresence[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("readAllPresences failed"));
  });
}

export function clearPresences(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("presences", "readwrite");
    const store = tx.objectStore("presences");
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("clearPresences failed"));
  });
}

// ----------------------------------------------------------------------------
// txIngest store helpers
// ----------------------------------------------------------------------------

export function writeTxIngest(db: IDBDatabase, txIngest: CachedTxIngest): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("txIngest", "readwrite");
    const store = tx.objectStore("txIngest");
    const req = store.put(txIngest);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("writeTxIngest failed"));
  });
}

export function readAllTxIngest(db: IDBDatabase, cap = 200): Promise<CachedTxIngest[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("txIngest", "readonly");
    const store = tx.objectStore("txIngest");
    const idx = store.index("receivedAt");
    const out: CachedTxIngest[] = [];
    const req = idx.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push(cursor.value as CachedTxIngest);
        cursor.continue();
      } else {
        // 按 receivedAt 升序取最后 cap 条。
        out.sort((a, b) => a.receivedAt - b.receivedAt);
        resolve(out.slice(-cap));
      }
    };
    req.onerror = () => reject(req.error ?? new Error("readAllTxIngest failed"));
  });
}

export function clearTxIngest(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("txIngest", "readwrite");
    const store = tx.objectStore("txIngest");
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("clearTxIngest failed"));
  });
}

// ----------------------------------------------------------------------------
// 旧 v1 / v2 settings 迁移（硬切换 004 一次性迁移）
// ----------------------------------------------------------------------------

/**
 * 旧 key-scoped settings 读取（仅 v1 / v2 留下来的 `settings` store）。
 *
 * 设计缘由：硬切换 004 把 settings 搬到全局 pokerGlobalConfig。本函数只
 * 用于"一次性迁移"——读老 DB 里 `id === "current"` 的 settings row，
 * 把其中网络配置字段搬到全局 localStorage 后，**不再回写 key-scoped**。
 *
 * 如果 `settings` store 不存在（v3 fresh install 或已被清掉），直接返回
 * null。`identityBinding` store 在迁移路径里**完全忽略**——硬切换 004 不
 * 再需要稳定身份绑定；旧数据留给 IndexedDB 自然 GC。
 */
export interface LegacyCachedSettings {
  proxyEndpoint?: string;
  announceP2PNodeEndpoint?: string;
  announceTxLinkEndpoint?: string;
  allowFallbackBroadcast?: boolean;
}

export function readLegacyKeyScopedSettings(db: IDBDatabase): Promise<LegacyCachedSettings | null> {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains("settings")) {
      resolve(null);
      return;
    }
    try {
      const tx = db.transaction("settings", "readonly");
      const store = tx.objectStore("settings");
      const req = store.get("current");
      req.onsuccess = () => {
        const row = req.result as
          | (LegacyCachedSettings & { id?: string })
          | undefined;
        if (!row) {
          resolve(null);
          return;
        }
        resolve({
          proxyEndpoint: row.proxyEndpoint,
          announceP2PNodeEndpoint: row.announceP2PNodeEndpoint,
          announceTxLinkEndpoint: row.announceTxLinkEndpoint,
          allowFallbackBroadcast: row.allowFallbackBroadcast
        });
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
