// 冷启动 Profile envelope 与本机 bootstrap 状态契约。

/** 独立于 Vault 的加密 Storage Profile envelope。 */
export interface StorageProfileEnvelopeV1 {
  /** 固定格式标识，防止把业务 JSON 当 Profile 解密。 */
  format: "keymaster.storage-profile";
  /** envelope 格式版本。 */
  version: 1;
  /** 独立存储密码 KDF。 */
  kdf: "pbkdf2-sha256";
  /** PBKDF2 迭代次数。 */
  iterations: number;
  /** KDF salt，hex 编码。 */
  saltHex: string;
  /** AES-GCM nonce，hex 编码。 */
  nonceHex: string;
  /** 加密后的 Profile JSON，hex 编码。 */
  ciphertextHex: string;
}

/** 本机 bootstrap 只保存连接器 envelope 与首帧偏好。 */
export interface StorageBootstrapState {
  /** 首选统一存储后端；未选择时整个系统必须停留在启动页。 */
  selectedBackend: "opfs" | "s3";
  /** 当前选中的 Profile ID。 */
  selectedProfileId?: string;
  /** 与导出文件共用的加密 Profile envelope。 */
  encryptedStorageProfileEnvelope?: StorageProfileEnvelopeV1;
  /** 首帧语言镜像。 */
  language?: string;
  /** 首帧主题镜像。 */
  theme?: string;
}

/** Storage Profile 使用的 Provider 连接类型。 */
export type StorageProviderId = "cloudflare-r2" | "aws-s3" | "s3-compatible";

export interface StorageAccessKeyAuth {
  /** 凭据类型。 */
  kind: "access-key";
  /** S3 Access Key ID。 */
  accessKeyId: string;
  /** S3 Secret Access Key。 */
  secretAccessKey: string;
}

export interface StorageR2Connection {
  /** Cloudflare 账户 ID。 */
  accountId: string;
  /** R2 Endpoint 变体。 */
  endpointVariant: "default" | "eu" | "fedramp";
  /** Bucket 名称。 */
  bucket: string;
}

export interface StorageAwsConnection {
  /** AWS 区域。 */
  region: string;
  /** Bucket 名称。 */
  bucket: string;
}

export interface StorageCompatibleConnection {
  /** S3-compatible HTTPS Endpoint。 */
  endpoint: string;
  /** Provider 区域。 */
  region: string;
  /** Bucket 名称。 */
  bucket: string;
  /** 是否使用 path-style 请求。 */
  forcePathStyle: boolean;
}

export type StorageConnection = StorageR2Connection | StorageAwsConnection | StorageCompatibleConnection;

/** 设置页传入的凭据变更方式。 */
export type StorageSecretUpdate =
  | { mode: "retain" }
  | { mode: "replace"; accessKeyId: string; secretAccessKey: string };

/** 设置页提交给 Runtime 的 Provider 配置草稿。 */
export interface StorageProviderConfigDraft {
  /** Provider 类型。 */
  providerId: StorageProviderId;
  /** 连接位置。 */
  connection: StorageConnection;
  /** 凭据保留或替换方式。 */
  credentials: StorageSecretUpdate;
  /**
   * Storage Profile 独立密码；只在激活/解锁请求的内存消息中出现，
   * 不会写入规范化配置或 Provider 摘要。
   */
  profilePassword?: string;
}

/** 不含密钥的已规范化 Provider 配置。 */
export interface NormalizedStorageProviderConfig {
  /** 内部配置版本。 */
  version: 1;
  /** Provider 类型。 */
  providerId: StorageProviderId;
  /** 连接位置。 */
  connection: StorageConnection;
  /** 运行时内存中的访问凭据。 */
  credentials: StorageAccessKeyAuth;
}
