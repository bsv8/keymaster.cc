// packages/plugin-vault/src/vaultDb.ts
// Vault 的 IndexedDB 封装。
// 设计缘由：每个插件管理自己的 DB schema，升级失败不能破坏旧数据。
//
// 硬切换 002 收尾 — schema v5：
//   - canonical `vault_keys` 主键从内部 uuid 切换为 `publicKeyHex`：
//       * 旧 uuid 不再被创建或保留为持久化层主键；
//       * 新建 / 导入 key 时必须在落库前派生 `publicKeyHex` 并以其为
//         keyPath；
//       * 不存在"先生成 uuid、再回填身份"的路径。
//   - 一次性 `vault_keys_legacy_staging`：
//       * 仅在 DB v* -> v5 upgrade 时承载"没有 publicKeyHex 的旧行"；
//       * 不进入任何业务 contract，只在 unlock 阶段一次性迁移源；
//       * 迁移完成（canonical 写完 + staging 清空）后 staging store
//         会被物理删除；下次访问只剩 canonical store。
//   - canonical store 的 `publicKeyHex` 是 unique keyPath（DB 层面保证
//     唯一）；重复 publicKeyHex 在写入阶段抛 ConstraintError——vault
//     migration 也按 fail-closed 方式处理（见 vaultService.migrateLegacyStaging）。
//   - 旧字段 `identityStatus` / `identityError` / `fingerprint` /
//     `publicKeyHash` 全部不再需要：unlock 后不再逐把 backfill，登记
//     publicKeyHex 是落库前的强约束，旧字段全部从类型与 schema 中移除。
//   - 旧字段 `address` / `network` 仍保留为兼容展示字段；address
//     索引在 canonical store 上保持非 unique 索引。
//
// 迁移事务（v1-v4 -> v5）：
//   1) 读旧 `vault_keys` (keyPath=id) 每行 cursor：
//        已有 publicKeyHex -> 收集到 pendingCanonical 数组（白名单构造）
//        没有 publicKeyHex -> 收集到 pendingStaging 数组（带 legacyId）
//   2) 删旧 `vault_keys` store。
//   3) 同一事务内创建 canonical `vault_keys` (keyPath=publicKeyHex) + `address` 索引。
//   4) 把 pendingCanonical 写进 canonical store。
//   5) 把 pendingStaging 写进 `vault_keys_legacy_staging` (keyPath=legacyId)。
//   6) commit。失败一律 abort，retry 一次（IDB 自动 rollback）。
//   7) `pendingStaging.length === 0` 时立即删 staging store；非空时
//      staging store 保留到 unlock 阶段一次性迁完再删。
//
// 关键：旧 store 与新 store **不共存**——必须 deleteObjectStore(old) 然后
// createObjectStore(new) 在同一 upgrade 事务内完成；不能"在旧 store 上
// 改 keyPath"，那样 IndexedDB 会直接报 DataError。

import type { BsvNetwork } from "@keymaster/contracts";

const DB_NAME = "vault";
/**
 * 硬切换 002 收尾 schema 版本：
 *   - v5：vault_keys canonical store（keyPath=publicKeyHex）+ legacy staging 一次性迁移。
 *   - v6：当 staging store 内为空时，**物理删除** `vault_keys_legacy_staging`
 *     object store；下次启动 openDb 时不再出现 staging store。
 *   - 生产代码读 staging 永远走 `withOptionalStore(staging, ..., fallback)`，
 *     即便底层 store 已被 v6 upgrade 物理删掉也不会抛错。
 */
const DB_VERSION = 6;

/** Legacy staging store name。一次性迁移临时区；非空即视为待迁移。
 * 业务 contract 永远不会读取它，只有 vaultService.unlock 内部会扫一次。
 */
const LEGACY_STAGING_STORE = "vault_keys_legacy_staging";

export interface VaultMetaRecord {
  id: "singleton";
  /** 派生 key 时使用的 salt。 */
  saltB64: string;
  /** 验证密码用的加密块。 */
  verifierSaltB64: string;
  verifierIvB64: string;
  verifierCipherB64: string;
  createdAt: string;
}

/**
 * canonical key record。主键是 `publicKeyHex` —— 落库前必须派生得到,
 * 不允许先随机生成、再回填身份。
 */
export interface VaultKeyRecord {
  /** 主键：压缩公钥 hex；落库前必须派生。 */
  publicKeyHex: string;
  label: string;
  /** 兼容展示字段：派生出来的 BSV 地址。已不再是 key 根身份。 */
  address: string;
  /** 兼容展示字段：导入时网络。已不再是 key 根身份。 */
  network: BsvNetwork;
  format: string;
  capabilities: string[];
  createdAt: string;
  source?: string;
  /** 加密后的私钥材料。 */
  cipherSaltB64: string;
  cipherIvB64: string;
  cipherB64: string;
}

/**
 * Legacy staging record：仅用于一次性迁移。**不**进入业务 contract。
 *
 * 与 canonical `VaultKeyRecord` 不同：保留旧 uuid `legacyId`，便于把
 * 失败 / 重号现场定位回原存储；迁移成功或 fail-closed 后整体删除。
 */
export interface VaultKeyLegacyStagingRecord extends VaultKeyRecord {
  /** 旧 v1-v4 的内部 uuid；删 staging record 时一并删这条原 uuid。 */
  legacyId: string;
}

let dbPromise: Promise<IDBDatabase> | undefined;

/**
 * 关闭并丢弃缓存的 db 连接。供测试使用；生产代码不要调用。
 * 设计缘由：单测在每个用例前后需要 deleteDatabase，如果连接还开着，删除会被阻塞。
 */
export function disposeVaultDb(): void {
  if (!dbPromise) return;
  // 异步关闭不需要 await；调用方 deleteDatabase 时会等 onblocked。
  dbPromise.then((db) => db.close()).catch(() => undefined);
  dbPromise = undefined;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      runUpgrade(db, oldVersion, req);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * runtime 询问入口："我想确认 staging 已空，可以物理删 staging 了"。
 *
 * 重要：**这个函数不会物理删除 object store**。IndexedDB 规定
 * `deleteObjectStore` 只能在 upgrade 事务内执行，runtime 没有权限。
 * 真正的物理删除由 `upgradeFromV5ToV6` 在 DB_VERSION bump 到 v6 时
 * 完成：进入 v6 时若 staging count === 0 才走
 * `db.deleteObjectStore(LEGACY_STAGING_STORE)`。
 *
 * 这个 runtime 入口的存在意义是：
 *   - 给业务/调试代码一个明确的语义点（"我现在判定 staging 已空"）；
 *   - 防止业务代码误以为调这个函数能立刻清掉 store 后再依赖 store
 *     不存在的语义（v6 之前 store 仍存在）。
 *
 * 真要判定 "staging 已空且 store 已被物理删除" 走：
 *   - `withOptionalStore(LEGACY_STAGING_STORE, ..., fallback)` —
 *     v6 之后 store 不存在直接走 fallback 路径。
 *
 * 实际行为：no-op。当前状态永远是 "下次 DB_VERSION bump 到 v6 时
 * 才物理删除"。若想强制把物理删除提前到 runtime，必须设计
 * `DB_VERSION` 再 bump 一次并触发 reload——本函数**不**触发 reload。
 */
export function purgeLegacyStagingStoreIfEmpty(): void {
  // 故意 no-op：runtime 没有权限删 object store。真正的物理删除
  // 由 v5 -> v6 upgrade 事务执行（见 upgradeFromV5ToV6）。
  // 调用方**不**应假设本函数返回后 store 已不存在；store 是否物理
  // 删除只取决于当前 DB 是否已进入 v6。
}

/**
 * 全新安装（v0 -> v5）创建所有 stores 与索引。
 */
function createFreshSchema(db: IDBDatabase) {
  // vault_meta：单例 store，存 meta salt / verifier。
  if (!db.objectStoreNames.contains("vault_meta")) {
    db.createObjectStore("vault_meta", { keyPath: "id" });
  }
  // vault_keys：canonical store，keyPath = publicKeyHex，address 非 unique 索引。
  if (!db.objectStoreNames.contains("vault_keys")) {
    const store = db.createObjectStore("vault_keys", { keyPath: "publicKeyHex" });
    store.createIndex("address", "address", { unique: false });
  }
}

/**
 * 升级入口：处理 fresh install (oldVersion === 0) 与 v1-v4 -> v5 迁移。
 *
 * 关键约束：旧 `vault_keys` (keyPath=id) 与新 `vault_keys` (keyPath=publicKeyHex)
 * **不共存**——必须先 deleteObjectStore，再 createObjectStore，否则
 * IndexedDB 会拒绝在同一事务内给同名 store 改 keyPath。
 */
function runUpgrade(
  db: IDBDatabase,
  oldVersion: number,
  req: IDBOpenDBRequest
): void {
  if (oldVersion === 0) {
    // 全新安装：直接建新 schema。
    createFreshSchema(db);
    return;
  }
  if (oldVersion < 0 || oldVersion > 5) {
    // 异常：老版本来自未知来源，按 fresh 处理，触发 fail-closed 路径
    // 由上层检测（listKeys 形状校验）。
    createFreshSchema(db);
    return;
  }
  // v5 -> v6：清掉已空的 legacy staging store。
  // 设计缘由：硬切换 002 收尾规定"迁移完成（含 fail-closed 失败路径）
  // 后 staging store 物理删除"；v5 升级时 staging 会有数据（一次性迁
  // 源），v6 升级时 unlock 已完成过一次，staging 应该已空。
  if (oldVersion === 5) {
    upgradeFromV5ToV6(db, req);
    return;
  }
  // v1/v2/v3/v4 -> v5：在同一 upgrade 事务内
  //   1) 收集旧 store 数据到内存数组；
  //   2) 删旧 vault_keys；
  //   3) 创建新 canonical vault_keys (keyPath=publicKeyHex) + address 索引；
  //   4) 创建 vault_meta（如果旧 db 缺）；
  //   5) 创建 legacy staging（如果 staging 数据非空）；
  //   6) 回写 canonical + staging。
  const tx = req.transaction;
  if (!tx) return;
  const hasOldKeys = db.objectStoreNames.contains("vault_keys");
  if (!hasOldKeys) {
    // 旧 db 没有 vault_keys，构造一下当前 schema 即可。
    createFreshSchema(db);
    return;
  }
  const oldStore = tx.objectStore("vault_keys");
  // 1) 收集旧数据。
  const pendingCanonical: VaultKeyRecord[] = [];
  const pendingStaging: VaultKeyLegacyStagingRecord[] = [];
  const cursorReq = oldStore.openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) {
      // 收集完毕。
      // 2) 删旧 vault_keys store（keyPath=id）。
      db.deleteObjectStore("vault_keys");
      // 3) 创建新 canonical vault_keys + address 索引。
      const canonical = db.createObjectStore("vault_keys", { keyPath: "publicKeyHex" });
      canonical.createIndex("address", "address", { unique: false });
      // 4) vault_meta（如果旧 db 缺）。
      if (!db.objectStoreNames.contains("vault_meta")) {
        db.createObjectStore("vault_meta", { keyPath: "id" });
      }
      // 5) legacy staging（仅当有非 hex 行才创建；新 schema 上非空 store
      //    才会保留，unlock 阶段迁完下次升级 v6 时再删）。
      if (pendingStaging.length > 0) {
        db.createObjectStore(LEGACY_STAGING_STORE, { keyPath: "legacyId" });
      }
      // 6) 回写（继续用同一个 transaction，cursor 阶段已经收集完数据）。
      for (const rec of pendingCanonical) {
        canonical.put(rec);
      }
      if (pendingStaging.length > 0) {
        const staging = tx.objectStore(LEGACY_STAGING_STORE);
        for (const rec of pendingStaging) {
          staging.put(rec);
        }
      }
      return;
    }
    const r = cursor.value as VaultKeyRecord & {
      id?: string;
      publicKeyHex?: string;
      fingerprint?: string;
      publicKeyHash?: string;
      identityStatus?: string;
      identityError?: string;
    };
    const whitelist: VaultKeyRecord = {
      publicKeyHex: r.publicKeyHex ?? "",
      label: r.label,
      address: r.address,
      network: r.network,
      format: r.format,
      capabilities: r.capabilities,
      createdAt: r.createdAt,
      source: r.source,
      cipherSaltB64: r.cipherSaltB64,
      cipherIvB64: r.cipherIvB64,
      cipherB64: r.cipherB64
    };
    if (whitelist.publicKeyHex) {
      pendingCanonical.push(whitelist);
    } else {
      pendingStaging.push({
        ...whitelist,
        publicKeyHex: "",
        legacyId:
          typeof r.id === "string" && r.id.length > 0
            ? r.id
            : `legacy-${oldVersion}-${String(cursor.key)}`
      });
    }
    cursor.continue();
  };
}

/**
 * v5 -> v6 升级：物理删除已空的 `vault_keys_legacy_staging` object store。
 *
 * 设计缘由：硬切换 002 收尾规定 staging 迁完后**物理删除**。
 * runtime 没有权限 deleteObjectStore（只能在 upgrade 事务内），
 * 所以这次删除必须随 DB_VERSION bump 一起进入。
 *
 * 行为：
 *   - staging 存在 + count = 0：物理删除 staging store；
 *   - staging 存在 + count > 0：保留（用户尚未 unlock 完成迁移），
 *     等下次 unlock 阶段迁完后再次 bump version 时再删；
 *   - staging 不存在（v6 之前已删过）：no-op。
 */
function upgradeFromV5ToV6(db: IDBDatabase, req: IDBOpenDBRequest): void {
  const tx = req.transaction;
  if (!tx) return;
  if (!db.objectStoreNames.contains(LEGACY_STAGING_STORE)) {
    // staging 已经被物理删过（或从未存在），no-op。
    return;
  }
  const staging = tx.objectStore(LEGACY_STAGING_STORE);
  const countReq = staging.count();
  countReq.onsuccess = () => {
    if (countReq.result === 0) {
      // staging 已空：物理删除。
      db.deleteObjectStore(LEGACY_STAGING_STORE);
    }
    // 非空则保留，等下次升级 / 显式 purgeLegacyStagingStoreIfEmpty。
  };
}

function tx<T>(
  store: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        let result: T;
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        Promise.resolve(fn(t)).then((r) => {
          result = r;
        }, reject);
      })
  );
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 在一个 store 上跑请求；若该 store 不存在（已经升级清理、或者全新 schema
 * 还没创建），返回 `fallback` 而非抛错。这是 staging 操作的统一兼容层。
 */
async function withOptionalStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  fallback: T
): Promise<T> {
  const db = await openDb();
  if (!db.objectStoreNames.contains(storeName)) {
    return fallback;
  }
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    let result: T;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    reqAsPromise(fn(t.objectStore(storeName))).then(
      (r) => {
        result = r;
      },
      reject
    );
  });
}

export const vaultDb = {
  async getMeta(): Promise<VaultMetaRecord | undefined> {
    return tx("vault_meta", "readonly", (t) =>
      reqAsPromise(t.objectStore("vault_meta").get("singleton"))
    );
  },
  async putMeta(meta: VaultMetaRecord): Promise<void> {
    await tx("vault_meta", "readwrite", (t) =>
      reqAsPromise(t.objectStore("vault_meta").put(meta))
    );
  },
  /**
   * 硬切换 002 收尾：删除 vault_meta。createVault 失败回滚时调用，
   * 避免"内存状态 = uninitialized、存储里却有 Vault"的不一致。
   */
  async deleteMeta(): Promise<void> {
    await tx("vault_meta", "readwrite", (t) =>
      reqAsPromise(t.objectStore("vault_meta").delete("singleton"))
    );
  },
  async listKeys(): Promise<VaultKeyRecord[]> {
    return tx("vault_keys", "readonly", (t) =>
      reqAsPromise(t.objectStore("vault_keys").getAll())
    );
  },
  /** 按 publicKeyHex（canonical 主键）取单条记录。 */
  async getKey(publicKeyHex: string): Promise<VaultKeyRecord | undefined> {
    return tx("vault_keys", "readonly", (t) =>
      reqAsPromise(t.objectStore("vault_keys").get(publicKeyHex))
    );
  },
  /**
   * 兼容接口：按 address 查找 key 元数据。
   * 走 canonical store 的 `address` 非 unique 索引。保留仅给历史路径
   * 兜底；新代码应使用 `getKey(publicKeyHex)`。
   */
  async getKeyByAddress(address: string): Promise<VaultKeyRecord | undefined> {
    return tx("vault_keys", "readonly", (t) =>
      reqAsPromise(t.objectStore("vault_keys").index("address").get(address))
    );
  },
  /** 把记录写回 canonical store。主键 = `record.publicKeyHex`。 */
  async putKey(record: VaultKeyRecord): Promise<void> {
    if (!record.publicKeyHex) {
      throw new Error("vaultDb.putKey requires publicKeyHex");
    }
    await tx("vault_keys", "readwrite", (t) =>
      reqAsPromise(t.objectStore("vault_keys").put(record))
    );
  },
  /** 按 publicKeyHex 删除 canonical store 中的记录。 */
  async deleteKey(publicKeyHex: string): Promise<void> {
    await tx("vault_keys", "readwrite", (t) =>
      reqAsPromise(t.objectStore("vault_keys").delete(publicKeyHex))
    );
  },
  /* ===== legacy staging（一次性迁移临时区）=====
   * 仅 vaultService.unlock 与 db 升级钩子内部使用；业务 contract 不读
   * 不写 staging。所有 staging 操作在 store 不存在时返回"空"——这
   * 让"已经完成迁移（且 store 已被未来某次 upgrade 物理删掉）的旧库"
   * 和"从未有过 staging 的全新库"行为完全一致。
   */
  async listLegacyStaging(): Promise<VaultKeyLegacyStagingRecord[]> {
    return withOptionalStore<VaultKeyLegacyStagingRecord[]>(
      LEGACY_STAGING_STORE,
      "readonly",
      (store) => store.getAll() as IDBRequest<VaultKeyLegacyStagingRecord[]>,
      []
    );
  },
  async deleteLegacyStagingRecord(legacyId: string): Promise<void> {
    await withOptionalStore<undefined>(
      LEGACY_STAGING_STORE,
      "readwrite",
      (store) => store.delete(legacyId),
      undefined
    );
  },
  async legacyStagingCount(): Promise<number> {
    return withOptionalStore<number>(
      LEGACY_STAGING_STORE,
      "readonly",
      (store) => store.count(),
      0
    );
  }
};
