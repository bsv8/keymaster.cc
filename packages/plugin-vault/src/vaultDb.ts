// packages/plugin-vault/src/vaultDb.ts
// Vault 的 IndexedDB 封装。
// 设计缘由：每个插件管理自己的 DB schema，升级失败不能破坏旧数据。
// 这里只创建 vault_meta / vault_keys 两张表，不与其他插件共用 schema 文件。
//
// 硬切换 007 / 硬切换 001 收口后:平台身份唯一字段是 publicKeyHex。
//   - 旧 schema v2 的 `publicKeyHash` index 已经在 v3->v4 升级路径中
//     显式删除；新代码不再创建或读取该 index。
//   - 旧 v1 老记录（没有 publicKeyHex）会在 unlock 后由 vaultService
//     backfillIdentities 走 withPrivateKey 重新派生并写回。
//   - 旧字段 address / network 仍保留为兼容展示，不再是 key 根身份。
//
// 硬切换 008 后的 schema v3：
//   - vault_keys 新增 identityStatus / identityError 两个可选字段。
//   - 老记录（v1/v2）没有这两个字段：读取时按 "ready" 处理；写时由
//     putKeyIdentityReady / putKeyIdentityFailed 显式维护。
//
// 硬切换 003 收尾：
//   - 旧 `fingerprint` 字段从类型上删除；新代码不再读写。
//   - 旧库记录里可能残留 `fingerprint`，读取时被忽略、写入时不再写。
//   - 显式构造允许保留的字段，**不**用 `...current` 续命旧字段。
//
// 硬切换 001 收口后的 schema v4：
//   - 删除 `publicKeyHash` index。
//   - 删除 `publicKeyHash` 字段：所有记录物理去掉该字段。
//   - 新增 publicKeyHex unique index `publicKeyHex`：查重主路径。
//   - upgrade 阶段（v3 -> v4）会逐条把旧记录 rewrite 成最终字段形状：
//     老 v1/v2 残留的 publicKeyHash 字段被物理删除；publicKeyHex 保留。
//   - 旧记录若没有 publicKeyHex（v1 老记录），仍保留为 ready,等待
//     backfill 阶段用 withPrivateKey 重新派生并写回。
//   - failed key 仍可能有 publicKeyHex（vaultDb.putKeyIdentityFailed
//     不动 identity 字段）；只是不参与 active 候选。

const DB_NAME = "vault";
const DB_VERSION = 4;

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

export interface VaultKeyRecord {
  /** 与 VaultKeyRef.id 一致。 */
  id: string;
  label: string;
  /** 兼容展示字段：派生出来的 BSV 地址。已不再是 key 根身份。 */
  address: string;
  /** 兼容展示字段：导入时网络。已不再是 key 根身份。 */
  network: "main" | "test";
  format: string;
  capabilities: string[];
  createdAt: string;
  source?: string;
  /** 加密后的私钥材料。 */
  cipherSaltB64: string;
  cipherIvB64: string;
  cipherB64: string;
  /** 压缩公钥 hex；平台公开身份根字段。ready 必有，failed 可能缺省。 */
  publicKeyHex?: string;
  /**
   * 硬切换 008：identity 状态。
   *   - "ready" 或缺省：可作为 active key 候选。
   *   - "failed"：backfill 失败，不参与 active key 切换。
   * 老记录没有该字段；读取时按 "ready" 处理。
   */
  identityStatus?: "ready" | "failed";
  /** backfill 失败原因。仅在 identityStatus === "failed" 时有值。 */
  identityError?: string;
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
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains("vault_meta")) {
          db.createObjectStore("vault_meta", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("vault_keys")) {
          const store = db.createObjectStore("vault_keys", { keyPath: "id" });
          store.createIndex("address", "address", { unique: false });
        }
      }
      if (oldVersion < 2) {
        // v1 -> v4:硬切换 001 收口后,任何从 v1 直接升级到 v4 的路径都不
        // 再创建旧 `publicKeyHash` 索引;v3->v4 升级时显式删除。
        // 旧 v1 老记录没有 publicKeyHex,backfill 阶段由 vaultService
        // 走 withPrivateKey 重新派生并写回。
      }
      if (oldVersion < 3) {
        // v2 -> v3：硬切换 008。identityStatus / identityError 是 vault_keys
        // store 的可选字段，不需新增 store；老记录缺省按 "ready" 处理。
        // 这里什么都不做——读时 map，写时显式 put。
      }
      if (oldVersion < 4) {
        // v3 -> v4：硬切换 001 收口。
        //   - 删除 publicKeyHash 唯一索引；
        //   - 新增 publicKeyHex 唯一索引；
        //   - 逐条 rewrite vault_keys 记录：显式构造字段白名单,物理删
        //     旧 publicKeyHash 字段（即使老记录里有也丢掉），保留
        //     publicKeyHex。失败的 key 仍可能没有 publicKeyHex,backfill
        //     阶段由 vaultService 重新派生并写回。
        const tx = req.transaction;
        if (tx) {
          const store = tx.objectStore("vault_keys");
          if (store.indexNames.contains("publicKeyHash")) {
            store.deleteIndex("publicKeyHash");
          }
          if (!store.indexNames.contains("publicKeyHex")) {
            store.createIndex("publicKeyHex", "publicKeyHex", { unique: true });
          }
          // 物理清理旧字段：cursor 遍历所有记录,显式构造最终形状。
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const r = cursor.value as VaultKeyRecord & {
              publicKeyHash?: string;
            };
            const next: VaultKeyRecord = {
              id: r.id,
              label: r.label,
              address: r.address,
              network: r.network,
              format: r.format,
              capabilities: r.capabilities,
              createdAt: r.createdAt,
              source: r.source,
              cipherSaltB64: r.cipherSaltB64,
              cipherIvB64: r.cipherIvB64,
              cipherB64: r.cipherB64,
              publicKeyHex: r.publicKeyHex,
              identityStatus: r.identityStatus,
              identityError: r.identityError
            };
            cursor.update(next);
            cursor.continue();
          };
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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
    return tx("vault_meta", "readonly", (t) => reqAsPromise(t.objectStore("vault_meta").get("singleton")));
  },
  async putMeta(meta: VaultMetaRecord): Promise<void> {
    await tx("vault_meta", "readwrite", (t) => reqAsPromise(t.objectStore("vault_meta").put(meta)));
  },
  /**
   * 硬切换 008 收尾：删除 vault_meta。createVault 失败回滚时调用，
   * 避免"内存状态 = uninitialized、存储里却有 Vault"的不一致。
   */
  async deleteMeta(): Promise<void> {
    await tx("vault_meta", "readwrite", (t) => reqAsPromise(t.objectStore("vault_meta").delete("singleton")));
  },
  async listKeys(): Promise<VaultKeyRecord[]> {
    return tx("vault_keys", "readonly", (t) => reqAsPromise(t.objectStore("vault_keys").getAll()));
  },
  async getKey(id: string): Promise<VaultKeyRecord | undefined> {
    return tx("vault_keys", "readonly", (t) => reqAsPromise(t.objectStore("vault_keys").get(id)));
  },
  async getKeyByAddress(address: string): Promise<VaultKeyRecord | undefined> {
    return tx("vault_keys", "readonly", async (t) => {
      const idx = t.objectStore("vault_keys").index("address");
      return reqAsPromise(idx.get(address));
    });
  },
  async getKeyByPublicKeyHex(publicKeyHex: string): Promise<VaultKeyRecord | undefined> {
    return tx("vault_keys", "readonly", async (t) => {
      const store = t.objectStore("vault_keys");
      if (!store.indexNames.contains("publicKeyHex")) return undefined;
      return reqAsPromise(store.index("publicKeyHex").get(publicKeyHex));
    });
  },
  async putKey(record: VaultKeyRecord): Promise<void> {
    await tx("vault_keys", "readwrite", (t) => reqAsPromise(t.objectStore("vault_keys").put(record)));
  },
  /**
   * 仅回写 identity 字段。设计缘由：backfill 阶段需要补 publicKeyHex,
   * 但不应替换整个 record（避免与并发 import 冲突）。
   * 同时写 identityStatus = "ready"、清 identityError。
   *
   * 硬切换 003 收尾：本方法**不**接收 fingerprint；旧字段即使在
   * `current` 记录上残留也**不**会被续命（只白名单写出 publicKeyHex
   * / identityStatus / identityError）。
   * 硬切换 008：vaultService 调本方法，并在成功后发 key.identity.ready 事件。
   * 硬切换 001 收口：本方法不再写 publicKeyHash 字段。
   */
  async putKeyIdentity(id: string, identity: {
    publicKeyHex: string;
  }): Promise<void> {
    await tx("vault_keys", "readwrite", async (t) => {
      const store = t.objectStore("vault_keys");
      const current = await reqAsPromise<VaultKeyRecord | undefined>(store.get(id));
      if (!current) throw new Error(`Unknown key ${id}`);
      // 硬切换 003 收尾：白名单构造允许保留的字段，避免 `...current` 把
      // 旧库残留的 `fingerprint` 续命回 DB。其它业务字段（label / cipher*
      // / format / capabilities / source / createdAt 等）必须原样保留。
      const next: VaultKeyRecord = {
        id: current.id,
        label: current.label,
        address: current.address,
        network: current.network,
        format: current.format,
        capabilities: current.capabilities,
        createdAt: current.createdAt,
        source: current.source,
        cipherSaltB64: current.cipherSaltB64,
        cipherIvB64: current.cipherIvB64,
        cipherB64: current.cipherB64,
        publicKeyHex: identity.publicKeyHex,
        identityStatus: "ready",
        identityError: undefined
      };
      await reqAsPromise(store.put(next));
    });
  },
  /**
   * 硬切换 008：标记某把 key 的 identity backfill 失败。
   * 写 identityStatus = "failed" + identityError；**不动**已有 identity
   * 字段（publicKeyHex）。设计缘由：公钥
   * 身份与 backfill 状态是两件事——失败 status 表示"暂时无法重新派
   * 生",不应丢弃已知公钥；keyspace 也不会把 failed key 选为 active。
   * 重试时由 putKeyIdentity 重新走派生并写回。
   * 失败 key 不会被 keyspace 选为 active key 候选。
   *
   * 硬切换 003 收尾：显式构造字段,避免把旧 `fingerprint` 写回。
   * 硬切换 001 收口：不再写 publicKeyHash 字段。
   */
  async putKeyIdentityFailed(id: string, error: string): Promise<void> {
    await tx("vault_keys", "readwrite", async (t) => {
      const store = t.objectStore("vault_keys");
      const current = await reqAsPromise<VaultKeyRecord | undefined>(store.get(id));
      if (!current) throw new Error(`Unknown key ${id}`);
      const next: VaultKeyRecord = {
        id: current.id,
        label: current.label,
        address: current.address,
        network: current.network,
        format: current.format,
        capabilities: current.capabilities,
        createdAt: current.createdAt,
        source: current.source,
        cipherSaltB64: current.cipherSaltB64,
        cipherIvB64: current.cipherIvB64,
        cipherB64: current.cipherB64,
        publicKeyHex: current.publicKeyHex,
        identityStatus: "failed",
        identityError: error
      };
      await reqAsPromise(store.put(next));
    });
  },
  /**
   * 硬切换 008：把失败 key 重置为 ready（用于重试 backfill 时清状态）。
   * 实际身份字段由 putKeyIdentity 写回；本方法只清状态。
   *
   * 硬切换 003 收尾：显式构造字段,避免把旧 `fingerprint` 写回。
   * 硬切换 001 收口：不再写 publicKeyHash 字段。
   */
  async putKeyIdentityReady(id: string): Promise<void> {
    await tx("vault_keys", "readwrite", async (t) => {
      const store = t.objectStore("vault_keys");
      const current = await reqAsPromise<VaultKeyRecord | undefined>(store.get(id));
      if (!current) throw new Error(`Unknown key ${id}`);
      const next: VaultKeyRecord = {
        id: current.id,
        label: current.label,
        address: current.address,
        network: current.network,
        format: current.format,
        capabilities: current.capabilities,
        createdAt: current.createdAt,
        source: current.source,
        cipherSaltB64: current.cipherSaltB64,
        cipherIvB64: current.cipherIvB64,
        cipherB64: current.cipherB64,
        publicKeyHex: current.publicKeyHex,
        identityStatus: "ready",
        identityError: undefined
      };
      await reqAsPromise(store.put(next));
    });
  },
  async deleteKey(id: string): Promise<void> {
    await tx("vault_keys", "readwrite", (t) => reqAsPromise(t.objectStore("vault_keys").delete(id)));
  }
};
