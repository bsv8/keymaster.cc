// packages/contracts/src/vault.ts
// Vault 契约：私钥存储 + 内存解密的统一入口。
// 关键安全约束：明文私钥只允许在 withPrivateKey 回调内短暂存在。
//
// 硬切换（007）后的根身份：
//   - KeyIdentity 使用公钥身份（publicKeyHex / publicKeyHash / fingerprint）。
//   - `address` 与 `network` 不再是 KeyRef 的根身份字段；仅作为兼容展示
//     字段保留，业务方不应再通过 address 反查 key。
//   - 找 key 的主路径是 publicKeyHash，地址查找应交给 P2PKH 自己的 namespace。

export type BsvNetwork = "main" | "test";

/** 私钥元数据，写入 IndexedDB 时持久化的部分。 */
export interface KeyRef {
  /** 唯一 key id，由 vault 生成。 */
  id: string;
  /** 人类可读标签。 */
  label: string;
  /** 私钥格式，例如 "wif"、"hex"、"json-file"。 */
  format: string;
  /** 私钥支持的能力列表，例如 ["p2pkh"]。 */
  capabilities: string[];
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
  /** 导入来源，可选。 */
  source?: string;
  /** 压缩公钥 hex。 */
  publicKeyHex?: string;
  /** 公钥 hash（hex）。 */
  publicKeyHash?: string;
  /** 短展示指纹。 */
  fingerprint?: string;
  /**
   * 硬切换 008：identity backfill 状态。缺省或 "ready" 表示可作为
   * active key 候选；"failed" 表示 backfill 失败，keyspace 不会选为
   * active key。vault.listKeys 在 refreshKeyCache 时把 status 映射到 KeyRef。
   */
  identityStatus?: "ready" | "failed";
  /** backfill 失败原因；仅在 identityStatus === "failed" 时有值。 */
  identityError?: string;
  /**
   * 兼容字段：派生出来的 BSV 主网地址。已不再是 key 根身份。
   * 保留仅用于 Vault 设置页等兼容展示；业务插件应通过 P2PKH namespace
   * 在自己的 resource 内查地址。
   */
  address?: string;
  /**
   * 兼容字段：导入时推断的网络。已不再是 key 根身份。
   * 网络由具体 plugin/resource 派生。
   */
  network?: BsvNetwork;
}

/** 私钥明文材料：仅在内存中使用，禁止落盘。 */
export interface PrivateKeyMaterial {
  /** 32 字节十六进制小写编码。 */
  hex: string;
  /** 原始 WIF（如果导入时提供）。 */
  wif?: string;
}

/** Vault 状态机。
 *
 * 硬切换 008：`VaultStatus = "unlocked"` 的语义被收紧。
 *
 * - 旧语义：`masterKey` 已放入内存，masterSalt 已放入内存。
 * - 新语义：表示 Vault 会话**和** keyspace ready 边界都已完成——
 *   1) masterKey / masterSalt 已在内存；
 *   2) identity backfill（逐把 key 派生公钥身份）已完成；
 *   3) keyspace.onVaultUnlocked() 已 await 完成（即 keyspace 处于
 *      一致状态，active key 已选定或进入 mode="all"）。
 *
 * 业务插件在 status === "unlocked" 之后才允许读取 key-scoped storage。
 * 旧实现中"unlocked 早于 keyspace ready"会触发
 * "Key storage is not ready"，属于根因泄漏到 UI 的错误。
 *
 * 实现保证：unlock() 的完成顺序必须为
 *   backfillIdentities -> keyspace.onVaultUnlocked -> setStatus("unlocked") + emit
 * 失败时回退到 "locked" 并清空内存会话（fail-closed）。
 */
export type VaultStatus = "booting" | "uninitialized" | "locked" | "unlocked";

/**
 * 私钥导出 envelope（bsv8 key envelope）。
 * 设计缘由：导出必须由 Vault 完成，因为只有 Vault 能通过 withPrivateKey
 * 受控借用明文私钥。importer 插件不能借用明文，因此不能实现导出。
 * 格式与外部生态（bsv8）一致：加密 JSON（Argon2id + XChaCha20-Poly1305），
 * 不是 Keymaster 私有格式，也不提供明文 hex / WIF 导出。
 */
export interface KeyExportEnvelope {
  /** 可选 compressed public key hex，便于 bsv8 导入 API 直接使用。 */
  pubkey_hex?: string;
  version: "kek-v1";
  key_id: "default";
  kdf: "argon2id";
  kdf_params: {
    memory_kib: number;
    time_cost: number;
    parallelism: number;
    salt_hex: string;
  };
  cipher: "xchacha20poly1305";
  nonce_hex: string;
  ciphertext_hex: string;
  aad: string;
  created_at_unix: number;
}

/** Vault 服务：被 plugin-vault 实现并以 "vault.service" capability 暴露。 */
export interface VaultService {
  /** 当前状态。 */
  status(): VaultStatus;
  /** 订阅状态变化，返回取消订阅函数。 */
  onStatusChange(handler: (status: VaultStatus) => void): () => void;

  /** 是否存在 vault_meta（首次启动为 false）。 */
  hasVault(): Promise<boolean>;
  /** 创建 vault，密码用于派生加密 key。 */
  createVault(password: string): Promise<void>;
  /** 用密码解锁，会解密所有 key 索引（不解密私钥本身）。 */
  unlock(password: string): Promise<void>;
  /** 锁定，丢弃内存中的明文。 */
  lock(): Promise<void>;

  /** 列出所有 key 元数据。 */
  listKeys(): Promise<KeyRef[]>;
  /** 按 id 取单个 key 元数据。 */
  getKey(id: string): Promise<KeyRef | undefined>;
  /**
   * 按 publicKeyHash 查找 key 元数据。已成为平台身份查找的主路径。
   * 设计缘由：硬切换后地址不再是根 id，平台找 key 必须走公钥身份。
   */
  getKeyByPublicKeyHash(publicKeyHash: string): Promise<KeyRef | undefined>;
  /**
   * 兼容接口：按 address 查找 key 元数据。
   * 设计缘由：保留只是给历史路径兜底；新代码应使用 getKeyByPublicKeyHash。
   */
  findByAddress?(address: string): Promise<KeyRef | undefined>;

  /** 导入一个私钥，保存后返回 KeyRef。允许同一个 vault 存在多个 key。 */
  importPrivateKey(input: {
    label: string;
    material: PrivateKeyMaterial;
    format: string;
    capabilities: string[];
    source?: string;
  }): Promise<KeyRef>;
  /**
   * 在 Vault 内部安全生成一把新 secp256k1 Key，立即加密落库并返回公开 KeyRef。
   *
   * 设计缘由（硬切换 002）：
   *   - 私钥材料由 Vault 内部使用密码学安全随机源（noble secp256k1
   *     `utils.randomPrivateKey()`）生成；调用方只能拿到公开 KeyRef，
   *     永远拿不到明文私钥。
   *   - 明文私钥只允许在 `generateKey` 局部调用链中短暂存在；生成后立即
   *     按现有加密规则写入 `vault_keys`，并复用 `importPrivateKey` 的
   *     身份派生、重复检查、active 切换与事件发布路径。
   *   - 仅允许 Vault 已解锁时调用；locked 状态必须 fail closed。
   *   - 默认 `capabilities = ["p2pkh"]`；记录字段固定为
   *     `format = "generated"`、`source = "vault-generated"`，方便审计
   *     与回归测试。
   *
   * 不在公开契约中暴露：明文 hex / WIF、`material`、随机源替代接口。
   */
  generateKey(input: {
    label: string;
    capabilities?: string[];
  }): Promise<KeyRef>;
  /**
   * 删除一个 key 及其加密材料（硬切换 008）。
   * 设计缘由：实际删除流程由 keyspace.deleteKey 统一调度：
   *   1) background.cancelByKey
   *   2) 关闭 namespace db
   *   3) deleteDatabase namespace
   *   4) vault.deleteKeyMaterial（仅删私钥材料，不发 key.deleted 事件）
   *   5) emit key.deleted（由 keyspace 统一发一次）
   * 不允许业务插件直接调本方法绕过 keyspace。
   */
  deleteKeyMaterial(id: string): Promise<void>;
  /**
   * @deprecated 改用 keyspace.deleteKey。本方法保留仅为满足 contract 编译，
   * 实际调用将抛出 "Use keyspace.deleteKey instead"。
   */
  removeKey(id: string): Promise<void>;

  /**
   * 导出私钥为 bsv8 加密 envelope。
   * 设计缘由：明文私钥只能从 withPrivateKey 借出，因此导出必须经过 Vault。
   * 该方法不修改 key 列表，不触发 key.created / key.deleted 事件。
   */
  exportPrivateKey(input: { keyId: string; password: string }): Promise<KeyExportEnvelope>;

  /**
   * 临时借用私钥。
   * 关键设计缘由：明文私钥永远不进入 React state、不写普通 IndexedDB、不进 global capability。
   * 签名逻辑（如 P2PKH signer）必须通过 withPrivateKey 在闭包内使用，调用结束后立即释放。
   */
  withPrivateKey<T>(keyId: string, fn: (material: PrivateKeyMaterial) => Promise<T> | T): Promise<T>;
}
