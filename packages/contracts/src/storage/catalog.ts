// 存储桶目录、桶级加密配置和 Hold 快照契约。
//
// 这里刻意只放可序列化的 SDK 数据形状，不把密码、CryptoKey 或解密后的
// 配置放进契约。实现层通过 KeymasterHold SDK 产生/消费这些密文记录。

import type { KeyImportMaterial } from "../keyImport.js";

/** 正式的 V1 桶后端。 */
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
  /** 最终的 S3-compatible HTTPS Endpoint；AWS/R2 页面字段会先转换到这里。 */
  endpoint: string;
  /** AWS 区域或 S3 签名区域；R2 转换后固定为 `auto`。 */
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

/** 跨桶切换成功后的 Coordinator 结果；不返回密码、配置明文或私钥。 */
export interface StorageBucketSwitchResultV1 {
  /** 操作结果。 */
  ok: true;
  /** 已成为当前会话的运行时桶绑定。 */
  bucket: import("./profile.js").StorageRuntimeBucketV1;
  /** 目标桶当前是否已经有可用的 Key 会话。 */
  vaultUnlocked: boolean;
}

/**
 * 首次初始化提交计划。
 *
 * 页面只在最终确认时把这份完整计划交给 Coordinator；在此之前，密码、
 * S3 凭据和导入私钥材料只能存在于页面内存，不能分别调用桶/Vault API。
 */
export interface InitialSetupPlan {
  /** 本次初始化事务 ID；只用于幂等和回滚定位，不是桶身份。 */
  transactionId: string;
  /** 桶在本机界面显示的名称。 */
  bucketLabel: string;
  /** local 桶的本机 ID(= namespace,即设备记录键)；省略时由 Coordinator 随机生成，s3 按物理位置派生。 */
  remoteStorageId?: string;
  /** 与 connection.kind 对齐的正式后端。 */
  backend: StorageBucketBackend;
  /** 尚未持久化的连接配置；S3 凭据只在本次提交调用中出现。 */
  connection: StorageBucketConnectionConfigV1;
  /**
   * 启动密码（会话密码）；只有 s3 需要：用于加密设备记录里的连接参数,
   * 并把 KDF 参数写入 session。local 桶省略。
   */
  startupPassword?: string;
  /** 要和桶快照一起提交的第一把 Key（含它自己的密码）。 */
  firstKey: InitialSetupFirstKey;
}

/** 连接已有钱包（桶内已有 KeyHold 文件）的计划；不会创建新 Key。 */
export interface ExistingRemoteStorageConnectPlan {
  /** 本机连接操作 ID，只用于幂等。 */
  operationId: string;
  /** local 桶的本机 ID(= namespace)；s3 省略时由物理位置派生。 */
  remoteStorageId?: string;
  /** 本机显示名称。 */
  displayName: string;
  /** 与 connection.kind 对齐的 Provider。 */
  backend: StorageBucketBackend;
  /** 仅在本次 Worker 调用期间存在的连接位置与凭据。 */
  connection: StorageBucketConnectionConfigV1;
  /** 要解锁的 Key；省略时用 session.activeKey,再回退第一把。 */
  publicKeyHex?: string;
  /** 该 Key 自己的密码（KeyHold 文档）。 */
  keyPassword: string;
  /** 启动密码（会话密码）；s3 用于加密本机设备记录,local 省略。 */
  startupPassword?: string;
}

/** 连接前探测：只读 keys/ 目录,判定“已有钱包”还是“空桶”。 */
export interface BucketProbePlan {
  /** 探测操作 ID,只用于诊断。 */
  operationId: string;
  /** 与 connection.kind 对齐的 Provider。 */
  backend: StorageBucketBackend;
  /** 尚未持久化的连接位置与凭据。 */
  connection: StorageBucketConnectionConfigV1;
  /** local 桶的本机 ID(= namespace)；新建探测省略，由 Coordinator 按操作 ID 派生。 */
  remoteStorageId?: string;
}

/** 探测结果：读到至少一份可解析 KeyHold 文件 = has-keys。 */
export type BucketProbeResult =
  | {
      ok: true;
      state: "has-keys";
      /** 公开身份与标签,不含密码或密文。 */
      keys: Array<{ publicKeyHex: string; label: string }>;
    }
  | { ok: true; state: "empty" }
  | { ok: false; error: StorageUserFacingError };

/** 连接已有远端成功后公开的最小运行态摘要。 */
export type ExistingRemoteStorageConnectResult =
  | {
      ok: true;
      bucket: import("./profile.js").StorageRuntimeBucketV1;
      activeKey?: InitialSetupKeyResult;
    }
  | {
      ok: false;
      error: StorageUserFacingError;
    };

/** 首次初始化提交的第一把 Key 草稿。 */
export type InitialSetupFirstKey =
  | {
      /** 由受信任的 Coordinator 在提交边界内生成随机私钥。 */
      kind: "generate";
      /** Key 在界面和公开索引中的显示标签。 */
      label: string;
      /** 首 Key 的公开能力，例如 p2pkh。 */
      capabilities: string[];
      /** 这把 Key 自己的密码（KeyHold 文档）；与启动密码无关。 */
      password: string;
    }
  | {
      /** 导入由页面 importer 解析并校验过的私钥材料。 */
      kind: "import";
      /** Key 在界面和公开索引中的显示标签。 */
      label: string;
      /** 只在本次提交调用期间存在的私钥材料。 */
      material: KeyImportMaterial;
      /** importer 识别出的格式标识。 */
      format: string;
      /** 可选的公开导入来源说明。 */
      source?: string;
      /** 首 Key 的公开能力，例如 p2pkh。 */
      capabilities: string[];
      /** 这把 Key 自己的密码（KeyHold 文档）；与启动密码无关。 */
      password: string;
    };

/** 首次初始化可公开给页面的稳定阶段。 */
export type InitialSetupPhase = "validate" | "stage" | "hold" | "catalog-commit" | "runtime" | "rollback" | "complete";

/** 首次初始化失败时的回滚确认状态。 */
export type InitialSetupRollbackState = "not-started" | "confirmed" | "unconfirmed";

/** 面向用户的初始化错误；diagnostic 已由统一脱敏器生成。 */
export interface StorageUserFacingError {
  /** 中文短标题。 */
  title: string;
  /** 说明失败阶段及当前数据状态。 */
  summary: string;
  /** 用户可以执行的下一步。 */
  action?: string;
  /** 稳定错误码，用于工单和日志关联。 */
  code: string;
  /** 一次失败的公开关联 ID，不是租约或秘密 ID。 */
  incidentId: string;
  /** 允许在响应丢失后查询/清理的公开事务 ID；不包含任何秘密。 */
  transactionId?: string;
  /** 脱敏、默认折叠的技术诊断。 */
  diagnostic: string;
  /** 失败发生在哪个初始化阶段。 */
  phase: InitialSetupPhase;
  /** 是否已经确认恢复到事务前状态。 */
  rollback: InitialSetupRollbackState;
}

/** 首次初始化成功后返回的公开首 Key 摘要。 */
export interface InitialSetupKeyResult {
  /** 压缩公钥 hex；不包含私钥。 */
  publicKeyHex: string;
  /** Key 显示标签。 */
  label: string;
  /** 展示用地址。 */
  address: string;
  /** 导入/生成格式。 */
  format: string;
  /** 公开能力列表。 */
  capabilities: string[];
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
  /** 可选的公开来源说明。 */
  source?: string;
}

/** 首次初始化高层事务结果；失败也作为业务结果返回，便于页面展示诊断。 */
export type InitialSetupResult =
  | {
      /** 提交已完成，桶、Hold、Vault、首 Key 和运行态均已安装。 */
      ok: true;
      /** 已提交并选中的运行时桶绑定。 */
      bucket: import("./profile.js").StorageRuntimeBucketV1;
      /** 已激活的首 Key 公开摘要。 */
      firstKey: InitialSetupKeyResult;
    }
  | {
      /** 提交失败；页面不得继续进入业务界面。 */
      ok: false;
      /** 可行动错误。 */
      error: StorageUserFacingError;
    };

/**
 * 初始化恢复/清理的结果；它与 InitialSetupResult 分开，避免把“初始化早已
 * 成功”和“候选数据已经清理”都编码成 ok: true。
 */
export type InitialSetupRecoveryResult =
  | {
      /** 已经提交成功；页面应进入已初始化的 Vault，而不是重新开始。 */
      status: "setup-succeeded";
      /** 可重建的公开初始化结果。 */
      result: Extract<InitialSetupResult, { ok: true }>;
    }
  | {
      /** 候选数据已清理，页面可以清空草稿并允许重新初始化。 */
      status: "cleanup-confirmed";
    }
  | {
      /** 清理仍未确认；页面必须继续展示恢复入口。 */
      status: "cleanup-required";
      /** 已脱敏、可行动的清理错误。 */
      error: StorageUserFacingError;
    }
  | {
      /** 恢复记录不存在；页面不能据此盲目创建新事务。 */
      status: "not-found";
    };

/** 首次初始化恢复记录中的公开成功摘要；不保存密码、凭据或私钥材料。 */
export interface InitialSetupRecoverySuccessV1 {
  /** 桶目录显示名称。 */
  bucketLabel: string;
  /** 首 Key 的压缩公钥。 */
  publicKeyHex: string;
  /** 首 Key 显示标签。 */
  label: string;
  /** 首 Key 展示地址。 */
  address: string;
  /** 首 Key 导入/生成格式。 */
  format: string;
  /** 首 Key 公开能力。 */
  capabilities: string[];
  /** 首 Key 创建时间。 */
  createdAt: string;
  /** 可选的公开导入来源。 */
  source?: string;
}

/** 事务恢复记录的目录提交状态。 */
export type InitialSetupRecoveryCatalogState = "not-started" | "committed" | "rolled-back" | "competing" | "empty" | "unknown";

/** 事务恢复记录的持久化状态。 */
export interface InitialSetupRecoveryRecordV1 {
  /** 恢复记录格式标识。 */
  format: "keymaster.storage.initial-setup-recovery";
  /** 恢复记录版本。 */
  version: 1;
  /** 初始化事务 ID；不是桶身份，也不是秘密。 */
  transactionId: string;
  /** 本次候选桶 ID。 */
  bucketId: string;
  /** 完整目录条目的非秘密指纹，用于确认目录条目属于本事务。 */
  catalogEntryFingerprint: string;
  /** 候选目录配置版本，用于恢复时拒绝清理同 ID 的新条目。 */
  configRevision: number;
  /** 候选 Hold 快照版本，用于恢复时拒绝清理同 ID 的新条目。 */
  snapshotRevision: number;
  /** 候选桶后端。 */
  backend: StorageBucketBackend;
  /** 物理目标的非秘密指纹；不包含 Access Key、Secret 或 Session Token。 */
  connectionFingerprint: string;
  /** 最近一次已持久化的事务阶段。 */
  phase: InitialSetupPhase;
  /** 目录权威引用状态。 */
  catalog: InitialSetupRecoveryCatalogState;
  /** 是否曾安装本事务的 Root/运行态。 */
  runtimeInstalled: boolean;
  /** 暂存对象清理状态。 */
  cleanup: InitialSetupRollbackState;
  /** 记录当前是否仍在进行、已成功或已失败。 */
  status: "pending" | "succeeded" | "failed";
  /** 成功时只保存公开结果摘要。 */
  success?: InitialSetupRecoverySuccessV1;
  /** 失败时保存已经脱敏的用户错误。 */
  error?: StorageUserFacingError;
  /** 最近更新时间。 */
  updatedAt: number;
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
