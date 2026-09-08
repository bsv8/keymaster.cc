// 存储桶目录、桶级加密配置和 Hold 快照契约。
//
// 这里刻意只放可序列化的 SDK 数据形状，不把密码、CryptoKey 或解密后的
// 配置放进契约。实现层通过 KeymasterHold SDK 产生/消费这些密文记录。

/** 正式的桶后端；`opfs` 只作为旧格式识别值，不属于新目录。 */
export type StorageBucketBackend = "local" | "s3";

/** Local 桶的连接配置；Local 桶数据本身位于 localStorage。 */
export interface LocalBucketConnectionConfigV1 {
  /** KeymasterHold 的存储类型标识。 */
  kind: "local";
}

/** S3 桶的连接配置；访问凭据只会出现在桶级加密记录的明文操作期间。 */
export interface S3BucketConnectionConfigV1 {
  /** KeymasterHold 的存储类型标识。 */
  kind: "s3";
  /** S3-compatible HTTPS Endpoint。 */
  endpoint: string;
  /** Provider 区域。 */
  region: string;
  /** 物理 S3 bucket 名称。 */
  bucket: string;
  /** S3 Access Key ID。 */
  accessKeyId: string;
  /** S3 Secret Access Key。 */
  secretAccessKey: string;
  /** 可选的会话令牌。 */
  sessionToken?: string;
  /** 可选的对象前缀。 */
  prefix?: string;
  /** 是否使用 path-style 请求。 */
  forcePathStyle?: boolean;
}

/** 桶配置明文的 SDK 兼容形状；不会被本机目录直接保存。 */
export type StorageBucketConnectionConfigV1 = LocalBucketConnectionConfigV1 | S3BucketConnectionConfigV1;

/** KeymasterHold 公共密码派生参数；不是派生出来的密钥。 */
export interface StorageKeyDerivationV1 {
  /** 固定的 PBKDF2-HMAC-SHA-256 算法标识。 */
  algorithm: "pbkdf2-hmac-sha-256";
  /** 密码编码方式。 */
  passwordEncoding: "utf-8";
  /** PBKDF2 迭代次数。 */
  iterations: number;
  /** 派生输出位数。 */
  outputLengthBits: 256;
  /** 公共随机盐，Base64URL 编码。 */
  saltB64Url: string;
}

/** KeymasterHold AES-GCM 密文封装。 */
export interface StorageCipherEnvelopeV1 {
  /** 加密算法。 */
  algorithm: "aes-gcm";
  /** 加密密钥长度。 */
  keyLengthBits: 256;
  /** 随机 nonce，Base64URL 编码。 */
  ivB64Url: string;
  /** GCM 标签长度。 */
  tagLengthBits: 128;
  /** 密文与认证标签，Base64URL 编码。 */
  ciphertextAndTagB64Url: string;
}

/** KeymasterHold 的桶配置密文记录；不包含明文连接凭据。 */
export interface StorageRecordV1 {
  /** 配置密文封装。 */
  cipher: StorageCipherEnvelopeV1;
}

/** 本机目录中的一个桶条目；不保存 Keys 列表。 */
export interface StorageBucketCatalogEntryV2 {
  /** 桶的稳定身份，不直接等同于 S3 bucket 名称。 */
  bucketId: string;
  /** 桶的显示名称。 */
  label: string;
  /** 正式后端：localStorage 或 S3。 */
  backend: StorageBucketBackend;
  /** 连接配置版本；关联同版本测试结果。 */
  configRevision: number;
  /** 与桶密码对应的公共 KDF 参数。 */
  keyDerivation: StorageKeyDerivationV1;
  /** KeymasterHold 加密的连接配置。 */
  encryptedConfig: StorageRecordV1;
  /** 最近一次提交的 Hold 快照版本；没有 Key 时仍可以为 0。 */
  snapshotRevision: number;
  /** 创建时间（毫秒）。 */
  createdAt: number;
  /** 最后修改时间（毫秒）。 */
  updatedAt: number;
}

/**
 * 桶内公开 Key 索引；只保存列表展示和选择所需的元数据。
 *
 * 私钥密文的唯一持久化真值是桶内已提交 Hold 快照中的 `KeyRecord`。
 * 这个索引故意不包含 `cipher`、KeyHold 文档或任何可解密材料；它可以
 * 在快照认证后重建，不能反过来生成或覆盖 Hold 密文。
 */
export interface StorageCatalogKeyIndexRecordV1 {
  /** 索引记录格式版本。 */
  format: "keymaster.storage.catalog-key-index";
  /** 平台公开身份根字段：压缩公钥 hex。 */
  publicKeyHex: string;
  /** Key 的显示名称。 */
  label: string;
  /** 仅用于兼容展示的地址，不是 Key 身份真值。 */
  address?: string;
  /** 仅用于兼容展示的网络，不是 Key 身份真值。 */
  network?: "main" | "test";
  /** 导入或生成格式，仅用于展示和审计。 */
  keyFormat: string;
  /** Key 支持的公开能力列表。 */
  capabilities: string[];
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
  /** 导入来源，仅用于展示和审计。 */
  source?: string;
}

/** 本机 localStorage 中的多桶目录。 */
export interface StorageCatalogV2 {
  /** 固定目录格式标识。 */
  format: "keymaster.storage.catalog";
  /** 目录版本。 */
  version: 2;
  /** 当前选中的桶；未选择时为空。 */
  selectedBucketId?: string;
  /** 本机连接目录；不复制桶内 Keys。 */
  buckets: StorageBucketCatalogEntryV2[];
}

/** 页面内目录写入后的同步通知；跨标签页仍使用原生 storage 事件。 */
export const STORAGE_CATALOG_CHANGED_EVENT = "keymaster.storage.catalog-changed";

/** 当前桶改密成功后返回给页面的目录更新载荷；不包含密码或明文 Key。 */
export interface StorageBucketPasswordRotationResultV1 {
  /** 操作结果。 */
  ok: true;
  /** 需要由页面目录按 Web Lock 写回的新版桶条目。 */
  bucket: StorageBucketCatalogEntryV2;
}

/** 跨桶切换成功后的 Coordinator 结果；不返回密码、配置明文或私钥。 */
export interface StorageBucketSwitchResultV1 {
  /** 操作结果。 */
  ok: true;
  /** 已通过目标桶密码认证并成为当前会话的目录条目。 */
  bucket: StorageBucketCatalogEntryV2;
  /** 目标桶当前是否已经有可用的 Key 会话。 */
  vaultUnlocked: boolean;
}

/** Hold 快照的认证标签。 */
export interface StorageHoldIntegrityV1 {
  /** 整份 Hold 文档使用的认证算法。 */
  algorithm: "hmac-sha-256";
  /** SDK 产生的认证标签，Base64URL 编码。 */
  tagB64Url: string;
}

/** 桶内不可变 Hold 快照头。 */
export interface StorageHoldSnapshotHeaderV1 {
  /** 内部快照头格式标识，不会导出到 HoldDocument。 */
  format: "keymaster.storage-hold-snapshot";
  /** 快照头版本。 */
  version: 1;
  /** 不可变快照身份。 */
  snapshotId: string;
  /** 桶内单调递增的完整快照版本。 */
  snapshotRevision: number;
  /** 关联的桶配置版本。 */
  configRevision: number;
  /** SDK 公共 KDF 参数。 */
  keyDerivation: StorageKeyDerivationV1;
  /** 原始 Hold 文档的完整认证标签。 */
  integrity: StorageHoldIntegrityV1;
  /** 快照内 storage 记录所在的固定对象路径。 */
  storagePath: string;
  /** 快照内 KeyRecord 集合所在的固定对象路径。 */
  keysPath: string;
  /** KeyRecord 有序集合的数量。 */
  keyCount: number;
  /** KeyRecord 的有序公钥清单；便于完整性和缺失检查。 */
  keyPublicKeys: string[];
  /** 生成时间（毫秒）。 */
  createdAt: number;
}

/** 指向完整不可变快照的单一提交头。 */
export interface StorageHoldCommitHeadV1 {
  /** 提交头格式标识。 */
  format: "keymaster.storage-hold-commit";
  /** 提交头版本。 */
  version: 1;
  /** 当前已发布快照身份。 */
  snapshotId: string;
  /** 当前已发布的完整快照版本。 */
  snapshotRevision: number;
  /** 当前桶配置版本。 */
  configRevision: number;
  /** 当前桶快照世代。 */
  bucketGeneration: number;
  /** 发布时的时间（毫秒）。 */
  committedAt: number;
}
