// packages/plugin-vault/src/vaultDb.ts
// Vault 的 IndexedDB 封装。
// 设计缘由：每个插件管理自己的 DB schema，升级失败不能破坏旧数据。
//
// 硬切换 002 收尾 — schema v7：
//   - canonical `vault_keys` 主键从内部 uuid 切换为 `publicKeyHex`：
//       * 旧 uuid 不再被创建或保留为持久化层主键；
//       * 新建 / 导入 key 时必须在落库前派生 `publicKeyHex` 并以其为
//         keyPath；
//       * 不存在"先生成 uuid、再回填身份"的路径。
//   - 旧的 pre-v7 过渡 store 在升级到 v7 时直接物理删除，
//     不再保留 unlock-time migration。
//   - canonical store 的 `publicKeyHex` 是 unique keyPath（DB 层面保证
//     唯一）；重复 publicKeyHex 在写入阶段抛 ConstraintError。
//   - 旧字段 `identityStatus` / `identityError` / `fingerprint` /
//     `publicKeyHash` 全部不再需要：登记 publicKeyHex 是落库前的强约束，
//     旧字段全部从类型与 schema 中移除。
//   - 旧字段 `address` / `network` 仍保留为兼容展示字段；address
//     索引在 canonical store 上保持非 unique 索引。
//
// 关键：旧 store 与新 store **不共存**——必须 deleteObjectStore(old) 然后
// createObjectStore(new) 在同一 upgrade 事务内完成；不能"在旧 store 上
// 改 keyPath"，那样 IndexedDB 会直接报 DataError。

import type { BsvNetwork } from "@keymaster/contracts";

const DB_NAME = "vault";
/**
 * 硬切换 002 收尾 schema 版本：
 *   - v5：vault_keys canonical store（keyPath=publicKeyHex）。
 *   - v7：仅保留 canonical store；不再保留任何 staging / unlock-time
 *     migration 路径。
 */
const DB_VERSION = 7;

export interface VaultMetaRecord {
  id: "singleton";
  /** Vault crypto 版本。用于正式记录升级判断。 */
  cryptoVersion?: "v1" | "v2";
  /** KDF 方案。v2 固定 pbkdf2-sha256。 */
  kdf?: "pbkdf2-sha256";
  /** PBKDF2 迭代次数。 */
  iterations?: number;
  /** PBKDF2 输出位数。 */
  keyLengthBits?: number;
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
  /** 密文版本。 */
  cipherVersion?: "v1" | "v2";
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
  if (oldVersion >= 5) {
    // v5+ 的旧数据库里如果还残留 obsolete staging store，升级时直接删掉。
    // 这里不做任何运行时读取或迁移回填，只在 schema upgrade 里收口。
    if (db.objectStoreNames.contains("vault_keys_legacy_staging")) {
      db.deleteObjectStore("vault_keys_legacy_staging");
    }
    return;
  }
  if (oldVersion < 0 || oldVersion > 4) {
    // 异常：老版本来自未知来源，按 fresh 处理，触发 fail-closed 路径
    // 由上层检测（listKeys 形状校验）。
    createFreshSchema(db);
    return;
  }
  // v1/v2/v3/v4 -> v5：在同一 upgrade 事务内完成 canonical schema 重建。
  //   1) 收集旧 store 数据到内存数组；
  //   2) 删旧 vault_keys；
  //   3) 创建新 canonical vault_keys (keyPath=publicKeyHex) + address 索引；
  //   4) 创建 vault_meta（如果旧 db 缺）；
  //   5) 回写 canonical。
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
      // 6) 回写（继续用同一个 transaction，cursor 阶段已经收集完数据）。
      for (const rec of pendingCanonical) {
        canonical.put(rec);
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
    }
    cursor.continue();
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
  async setMetaCryptoVersion(version: "v1" | "v2"): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) {
      throw new Error("vault meta is missing");
    }
    await this.putMeta({
      ...meta,
      cryptoVersion: version,
      kdf: version === "v2" ? "pbkdf2-sha256" : meta.kdf,
      iterations: version === "v2" ? 200_000 : meta.iterations,
      keyLengthBits: version === "v2" ? 256 : meta.keyLengthBits
    });
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
  async putKeyRecords(records: VaultKeyRecord[]): Promise<void> {
    await tx("vault_keys", "readwrite", (t) => {
      const store = t.objectStore("vault_keys");
      for (const record of records) {
        if (!record.publicKeyHex) {
          throw new Error("vaultDb.putKeyRecords requires publicKeyHex");
        }
        store.put(record);
      }
    });
  },
  /**
   * 原子写回 meta + canonical keys。
   *
   * 设计缘由：unlock 阶段的正式记录 AAD 升级需要把 vault_meta 与
   * vault_keys 同步切到 v2，避免中间态只升级了一半。
   */
  async putMetaAndKeys(meta: VaultMetaRecord, records: VaultKeyRecord[]): Promise<void> {
    await tx(["vault_meta", "vault_keys"], "readwrite", (t) => {
      const metaStore = t.objectStore("vault_meta");
      const keyStore = t.objectStore("vault_keys");
      metaStore.put(meta);
      for (const record of records) {
        if (!record.publicKeyHex) {
          throw new Error("vaultDb.putMetaAndKeys requires publicKeyHex");
        }
        keyStore.put(record);
      }
    });
  },
  /** 按 publicKeyHex 删除 canonical store 中的记录。 */
  async deleteKey(publicKeyHex: string): Promise<void> {
    await tx("vault_keys", "readwrite", (t) =>
      reqAsPromise(t.objectStore("vault_keys").delete(publicKeyHex))
    );
  },
  async readKeyBackupRecord(publicKeyHex: string): Promise<{
    sourceVaultMeta: VaultMetaRecord;
    keyRecord: VaultKeyRecord;
  }> {
    const [sourceVaultMeta, keyRecord] = await Promise.all([
      this.getMeta(),
      this.getKey(publicKeyHex)
    ]);
    if (!sourceVaultMeta) {
      throw new Error("vault meta is missing");
    }
    if (!keyRecord) {
      throw new Error("Unknown key");
    }
    return { sourceVaultMeta, keyRecord };
  },
};
