// packages/plugin-poker/src/pokerDb.ts
// Poker key-scoped 本地缓存：保存 proxy endpoint、settings、稳定身份
// 绑定、最近 tables / sessions / pending tx ingest。
//
// 设计缘由：
//   - 硬切换 001 修订版要求 plugin-poker 持有"稳定 poker identity 绑定"
//     而不是跟随 active key 漂移；该绑定必须落到 key-scoped storage 才
//     能跨刷新存活。
//   - DB 名称遵循 keyspace 规范：
//     `keymaster.key.<publicKeyHash>.plugin.plugin-poker.poker`。
//   - vault 锁定时 key-scoped storage 不可用，UI 必须按 keyspace ready
//     边界降级显示。
//   - 注意：DB schema 升级走 `upgradePokerDb`；新增 store 必须递增
//     `POKER_KEY_STORAGE_VERSION`。

export const POKER_KEY_STORAGE_ID = "poker";
/**
 * DB 版本号：
 *   - v1：settings / tables / presences / txIngest
 *   - v2：identityBinding（硬切换 001 修订版稳定身份）
 */
export const POKER_KEY_STORAGE_VERSION = 2;

export interface CachedSettings {
  proxyEndpoint: string;
  /** 公告里要写的 P2PNode 入口（host:port）；硬切换双平面要求分别命名。 */
  announceP2PNodeEndpoint?: string;
  /** 公告里要写的 TxLink 入口（host:port）。 */
  announceTxLinkEndpoint?: string;
  allowFallbackBroadcast: boolean;
}

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

/**
 * 稳定身份绑定持久化结构。
 *
 * 设计缘由：硬切换文档要求 poker identity 独立于 active key 漂移；
 * 单 row（id="binding"），写入 / 读取 / 删除都走 settings store。
 * 字段含义见 contracts/poker.ts 的 PokerIdentityBinding。
 */
export interface CachedIdentityBinding {
  id: "binding";
  publicKeyHash: string;
  publicKeyHex: string;
  keyId: string;
  label: string;
  boundAt: number;
}

/** 升级 DB schema（首次创建 / v1 → v2）。 */
export function upgradePokerDb(
  db: IDBDatabase,
  oldVersion: number,
  _newVersion: number | null
): void {
  if (!db.objectStoreNames.contains("settings")) {
    db.createObjectStore("settings", { keyPath: "id" });
  }
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
  // v2: 稳定身份绑定
  if (oldVersion < 2 && !db.objectStoreNames.contains("identityBinding")) {
    db.createObjectStore("identityBinding", { keyPath: "id" });
  }
}

/** settings store 默认值。 */
export function defaultSettings(): CachedSettings {
  return {
    proxyEndpoint: "",
    announceP2PNodeEndpoint: "",
    announceTxLinkEndpoint: "",
    allowFallbackBroadcast: true
  };
}

/**
 * IndexedDB helper：读取 identity binding；返回 null 表示尚未绑定。
 *
 * 设计缘由：所有 DB 操作走最小 Promise 化封装；plugin-poker 不依赖
 * idb 第三方库，避免污染 runtime 边界。
 */
export function readIdentityBinding(db: IDBDatabase): Promise<CachedIdentityBinding | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("identityBinding", "readonly");
    const store = tx.objectStore("identityBinding");
    const req = store.get("binding");
    req.onsuccess = () => resolve((req.result as CachedIdentityBinding | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("readIdentityBinding failed"));
  });
}

/** 写入或覆盖 identity binding。 */
export function writeIdentityBinding(db: IDBDatabase, binding: CachedIdentityBinding): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("identityBinding", "readwrite");
    const store = tx.objectStore("identityBinding");
    const req = store.put({ ...binding, id: "binding" });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("writeIdentityBinding failed"));
  });
}

/** 清除 identity binding（unbindIdentity）。 */
export function clearIdentityBinding(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("identityBinding", "readwrite");
    const store = tx.objectStore("identityBinding");
    const req = store.delete("binding");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("clearIdentityBinding failed"));
  });
}

// ----------------------------------------------------------------------------
// settings store helpers
//
// 设计缘由（硬切换 001 修订版 567 行）：plugin-poker 的 key-scoped DB
// 写入 "proxy endpoint / 双平面 announce / fallback 开关"等本地偏好，
// 刷新页面后必须能恢复，否则用户重连前要重填一遍设置——这条已被
// 标识为中等严重的回归。
// ----------------------------------------------------------------------------

/** 把 settings 写入 IDB（覆盖式）。 */
export function writeSettings(db: IDBDatabase, settings: CachedSettings): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    const store = tx.objectStore("settings");
    // settings store 的 keyPath 是 "id"；统一用单 row "current"。
    const req = store.put({ id: "current", ...settings });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("writeSettings failed"));
  });
}

/** 从 IDB 读 settings；不存在返回 defaultSettings()。 */
export function readSettings(db: IDBDatabase): Promise<CachedSettings> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readonly");
    const store = tx.objectStore("settings");
    const req = store.get("current");
    req.onsuccess = () => {
      const row = req.result as (CachedSettings & { id: string }) | undefined;
      if (!row) {
        resolve(defaultSettings());
        return;
      }
      resolve({
        proxyEndpoint: row.proxyEndpoint ?? "",
        announceP2PNodeEndpoint: row.announceP2PNodeEndpoint ?? "",
        announceTxLinkEndpoint: row.announceTxLinkEndpoint ?? "",
        allowFallbackBroadcast: row.allowFallbackBroadcast ?? true
      });
    };
    req.onerror = () => reject(req.error ?? new Error("readSettings failed"));
  });
}
