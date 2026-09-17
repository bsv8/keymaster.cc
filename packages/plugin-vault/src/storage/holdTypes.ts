// Vault Hold 适配器契约（Coordinator 注入）。
//
// 私钥密文只经由本接口读写桶内 `keys/<公钥>.keyhold`（一 Key 一文件）。
// 没有钱包级验密码元数据，也没有 Key 索引与生命周期日志。

/** Hold 适配器可安全跨包传输的 JSON 值。 */
export type VaultCatalogHoldJsonValue =
  | null
  | boolean
  | number
  | string
  | VaultCatalogHoldJsonValue[]
  | { [key: string]: VaultCatalogHoldJsonValue };

/**
 * 一份 `keys/<公钥>.keyhold` KeyHold 文档的 opaque 表示。
 *
 * `cipher` 的具体字段由 Coordinator/Hold 适配层解释；插件的
 * K-V 仓库永远不会把这个对象写入 system namespace。
 */
export interface VaultCatalogHoldRecord {
  publicKeyHex: string;
  label: string;
  cipher: { [key: string]: VaultCatalogHoldJsonValue };
  /**
   * 该 Key 自己的公开 KDF 参数（KeyHold 单 Key 文件模型）。
   * 旧 Hold 文档共享一份 KDF，因此该字段可选；KeyHold 文件必须带。
   */
  keyDerivation?: import("@keymaster/contracts").StorageKeyDerivationV1;
}

/** Hold 适配器返回的已认证当前提交；不暴露 Provider 或物理路径。 */
export interface VaultCatalogHoldSnapshot {
  revision: number;
  headEtag?: string;
  /** 用于备份封装的公开 KDF 参数；不包含密码或派生密钥。 */
  keyDerivation?: import("@keymaster/contracts").StorageKeyDerivationV1;
  keys: readonly VaultCatalogHoldRecord[];
}

/**
 * Coordinator 注入的 KeyHold 适配器（一 Key 一文件）。
 *
 * Coordinator 负责把本接口绑定到当前桶 Provider 的 `keys/` 目录。所有
 * add/import/export/password-change/delete 路径必须通过这些 KeyHold 操作
 * 完成；本接口没有普通 K-V 的私钥写入旁路。
 */
export interface VaultCatalogHoldAdapter {
  /** 读取并认证当前桶 `keys/` 下的全部 KeyHold 文件。 */
  readCommitted(input: { password: string }): Promise<VaultCatalogHoldSnapshot>;
  /**
   * 读取当前 Hold 中仍保持加密状态的记录，供锁定态冷备份使用。
   * 该路径不解密私钥，也不把 Provider 或物理路径暴露给插件/调用方。
   */
  readEncryptedSnapshot(): Promise<VaultCatalogHoldSnapshot>;
  /** 用该 Key 自己的密码把一把短生命周期明文私钥加密成 KeyHold 文件。 */
  encryptPrivateKey(input: {
    password: string;
    label: string;
    privateKey: Uint8Array;
  }): Promise<VaultCatalogHoldRecord>;
  /** 在当前操作内解开一条记录；返回值不得写入任何 K-V。 */
  decryptPrivateKey(input: {
    password: string;
    record: VaultCatalogHoldRecord;
  }): Promise<Uint8Array>;
  /**
   * 回报当前全部 KeyHold 文件（追加式,不按集合快照隐式删除）。
   * 删除必须由适配层的显式按公钥删除完成；expectedHead 仅为旧调用点保留。
   */
  publish(input: {
    password: string;
    keys: readonly VaultCatalogHoldRecord[];
    expectedHead: import("@keymaster/contracts").StorageHoldHeadExpectation;
  }): Promise<VaultCatalogHoldSnapshot>;
}
