// 冷启动运行时绑定契约。

/** Worker 冷启动只接收当前 session 选中的设备桶绑定。 */
export interface StorageRuntimeBucketV1 {
  /** 桶的逻辑身份；等于设备记录的 `<ID>`，也是 local 对象前缀。 */
  bucketId: string;
  /** 公开后端类型。 */
  backend: "local" | "s3";
  /** 本机显示名称；省略时读取方按坐标生成默认名。 */
  label?: string;
  /** 设备桶记录本体（keymaster.device.v1）。 */
  deviceRecord: import("./device.js").DeviceRecordV1;
  /**
   * 启动密码（会话密码）的公开 KDF 参数，来自 `keymaster.session`；
   * 仅 s3 绑定需要。密码本身永不落盘。
   */
  keyDerivation?: import("./session.js").KeymasterSessionKeyDerivationV1;
}

export interface StorageBootstrapState {
  /** 当前存储后端。 */
  selectedBackend: "local" | "s3";
  /** 当前选中的桶 ID。 */
  selectedProfileId: string;
  /** 当前选中的设备桶绑定；Worker 只接收这一项。 */
  selectedBucket: StorageRuntimeBucketV1;
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
  /** 可选的临时会话令牌；只存在当前 Coordinator 会话内存。 */
  sessionToken?: string;
  /** 可选的用户对象前缀；Provider 会在其下追加 Keymaster 桶隔离根。 */
  prefix?: string;
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
