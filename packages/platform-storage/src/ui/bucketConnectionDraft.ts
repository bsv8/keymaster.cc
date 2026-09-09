import type {
  NormalizedStorageProviderConfig,
  S3BucketConnectionConfigV1,
  StorageBucketConnectionConfigV1,
  StorageBucketProvider,
  StorageProviderConfigDraft,
} from "@keymaster/contracts";
import { createLocalStorageBucketProvider } from "../bucket-providers/local/localStorageBucketProvider.js";
import { awsS3EndpointForRegion, normalizeProviderConfig, r2EndpointForAccount, R2_ENDPOINT_VARIANTS, type R2EndpointVariant } from "../bucket-providers/s3/s3ClientFactory.js";
import { createS3BucketProvider } from "../bucket-providers/s3/s3BucketProvider.js";
import { StorageRuntimeError } from "../runtime/storageRuntimeError.js";

/** S3 表单方式；它们只是页面模板，不是新的桶后端。 */
export const S3_CONFIG_MODES = ["aws-s3", "cloudflare-r2", "s3-compatible"] as const;
export type S3ConfigMode = (typeof S3_CONFIG_MODES)[number];

/** 用户可选择的正式桶后端。 */
export type BucketBackend = "local" | "s3";

/** 桶编辑草稿。密码和 S3 凭据只允许存在于当前页面内存。 */
export interface BucketDraft {
  /** 编辑中的目录桶 ID；新建桶没有此字段。 */
  editingBucketId?: string;
  /** 本机显示名称，不是物理 S3 bucket 名称。 */
  label: string;
  /** 正式桶后端；AWS/R2 仍归属于 `s3`。 */
  backend: BucketBackend;
  /** S3 表单配置方式，仅用于页面输入语义。 */
  s3ConfigMode: S3ConfigMode;
  /** Cloudflare 账户 ID，仅 R2 使用。 */
  accountId: string;
  /** R2 端点类型。 */
  endpointVariant: R2EndpointVariant;
  /** 桶密码，只在最终初始化/编辑调用期间使用。 */
  password: string;
  /** 桶密码确认值。 */
  passwordConfirm: string;
  /** 普通 S3-compatible 的 HTTPS 服务地址；AWS/R2 自动生成。 */
  endpoint: string;
  /** AWS 区域或 S3 签名区域；R2 自动使用 `auto`。 */
  region: string;
  /** 物理对象存储桶名称。 */
  bucket: string;
  /** S3 访问身份。 */
  accessKeyId: string;
  /** S3 访问密钥。 */
  secretAccessKey: string;
  /** 可选临时会话令牌。 */
  sessionToken: string;
  /** 可选用户对象路径前缀。 */
  prefix: string;
  /** 普通 S3-compatible 是否使用 path-style 请求。 */
  forcePathStyle: boolean;
}

export const EMPTY_BUCKET_DRAFT: BucketDraft = {
  label: "",
  backend: "local",
  s3ConfigMode: "aws-s3",
  accountId: "",
  endpointVariant: "default",
  password: "",
  passwordConfirm: "",
  endpoint: "",
  region: "",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  prefix: "",
  forcePathStyle: false
};

/** 配置草稿错误码；页面用这些稳定码映射中英文文案。 */
export type BucketDraftValidationCode =
  | "label-required"
  | "s3-mode-invalid"
  | "aws-region-required"
  | "aws-region-invalid"
  | "s3-region-required"
  | "r2-account-required"
  | "r2-account-invalid"
  | "r2-endpoint-variant-invalid"
  | "s3-endpoint-required"
  | "s3-endpoint-invalid"
  | "s3-bucket-required"
  | "s3-bucket-invalid"
  | "s3-credentials-required"
  | "s3-session-token-invalid"
  | "s3-prefix-invalid";

export interface BucketDraftValidationError {
  /** 稳定的字段错误码。 */
  code: BucketDraftValidationCode;
  /** 出错的页面字段。 */
  field: keyof BucketDraft;
  /** 没有 i18n 覆盖时仍可直接显示的中文说明。 */
  message: string;
}

function validationError(code: BucketDraftValidationCode, field: keyof BucketDraft, message: string): BucketDraftValidationError {
  return { code, field, message };
}

function isS3Mode(value: unknown): value is S3ConfigMode {
  return typeof value === "string" && (S3_CONFIG_MODES as readonly string[]).includes(value);
}

type S3BucketDraftConnection = Extract<S3BucketConnectionConfigV1, { kind: "s3" }>;

/**
 * 把页面的三种 S3 模板直接变成新版通用连接。
 *
 * 这里不构造旧 `StorageAwsConnection` / `StorageR2Connection`。它们属于
 * Storage Profile v1，不能因为新版页面字段增加而改变历史持久化语义。
 */
function rawS3ConnectionFromBucketDraft(draft: BucketDraft): S3BucketDraftConnection {
  if (draft.backend !== "s3") throw new StorageRuntimeError("storage_provider_error", "Only S3 drafts have a provider configuration");
  const prefix = draft.prefix.trim();
  const sessionToken = draft.sessionToken;
  if (draft.s3ConfigMode === "aws-s3") {
    return {
      kind: "s3",
      endpoint: awsS3EndpointForRegion(draft.region),
      region: draft.region.trim(),
      bucket: draft.bucket.trim(),
      accessKeyId: draft.accessKeyId,
      secretAccessKey: draft.secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
      ...(prefix ? { prefix } : {}),
      forcePathStyle: false
    };
  }
  if (draft.s3ConfigMode === "cloudflare-r2") {
    return {
      kind: "s3",
      endpoint: r2EndpointForAccount(draft.accountId, draft.endpointVariant),
      region: "auto",
      bucket: draft.bucket.trim(),
      accessKeyId: draft.accessKeyId,
      secretAccessKey: draft.secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
      ...(prefix ? { prefix } : {}),
      forcePathStyle: false
    };
  }
  if (draft.s3ConfigMode !== "s3-compatible") throw new StorageRuntimeError("storage_provider_error", "s3ConfigMode is invalid");
  return {
    kind: "s3",
    endpoint: draft.endpoint.trim(),
    region: draft.region.trim(),
    bucket: draft.bucket.trim(),
    accessKeyId: draft.accessKeyId,
    secretAccessKey: draft.secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(prefix ? { prefix } : {}),
    forcePathStyle: draft.forcePathStyle === true
  };
}

function providerDraftFromBucketDraft(draft: BucketDraft): StorageProviderConfigDraft {
  const connection = rawS3ConnectionFromBucketDraft(draft);
  return {
    // 新桶只用通用 S3 Provider 配置；AWS/R2 的模式只存在于当前页面。
    providerId: "s3-compatible",
    connection: {
      endpoint: connection.endpoint,
      region: connection.region,
      bucket: connection.bucket,
      ...(connection.sessionToken === undefined ? {} : { sessionToken: connection.sessionToken }),
      ...(connection.prefix === undefined ? {} : { prefix: connection.prefix }),
      forcePathStyle: connection.forcePathStyle === true
    },
    credentials: {
      mode: "replace",
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey
    }
  };
}

/**
 * 把页面语义转换为现有 Provider normalizer 的输入。
 *
 * 这个值只用于一次性校验/构造 Provider，不写入新版桶目录；新版目录
 * 仍只保存 `S3BucketConnectionConfigV1` 的加密结果。
 */
export function providerConfigFromBucketDraft(draft: BucketDraft): StorageProviderConfigDraft {
  return providerDraftFromBucketDraft(draft);
}

/** 返回按 AWS/R2/S3-compatible 规则校验后的内存 Provider 配置。 */
export function normalizedProviderConfigFromBucketDraft(draft: BucketDraft): NormalizedStorageProviderConfig {
  return normalizeProviderConfig(providerDraftFromBucketDraft(draft));
}

/**
 * 把三种 S3 表单统一转换成 Hold 使用的通用连接配置。
 * Endpoint、region、prefix 等规范化规则只由 s3ClientFactory 提供。
 */
export function connectionFromBucketDraft(draft: BucketDraft): StorageBucketConnectionConfigV1 {
  if (draft.backend === "local") return { kind: "local" };
  const normalized = normalizedProviderConfigFromBucketDraft(draft);
  const connection = normalized.connection as Extract<StorageProviderConfigDraft["connection"], { endpoint: string }>;
  return {
    kind: "s3",
    endpoint: connection.endpoint,
    region: connection.region,
    bucket: connection.bucket,
    accessKeyId: normalized.credentials.accessKeyId,
    secretAccessKey: normalized.credentials.secretAccessKey,
    ...(connection.sessionToken === undefined ? {} : { sessionToken: connection.sessionToken }),
    ...(connection.prefix === undefined ? {} : { prefix: connection.prefix }),
    // AWS/R2 的模板会在 raw connection 中固定为 false；普通 S3 保留用户选择。
    forcePathStyle: connection.forcePathStyle === true
  };
}

function normalizedProviderConfigFromConnection(config: Extract<StorageBucketConnectionConfigV1, { kind: "s3" }>): NormalizedStorageProviderConfig {
  return normalizeProviderConfig({
    providerId: "s3-compatible",
    connection: {
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
      ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
      forcePathStyle: config.forcePathStyle === true
    },
    credentials: { mode: "replace", accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
  });
}

export type BucketProviderInput = StorageBucketConnectionConfigV1 | BucketDraft;

function isBucketDraft(input: BucketProviderInput): input is BucketDraft {
  return typeof input === "object" && input !== null && "backend" in input;
}

/**
 * 构造唯一的 S3 桶 Provider 入口。
 *
 * 新草稿先按页面模板转换成通用 S3 Provider 配置；已提交的通用连接没有再携带
 * UI 配置方式，因此只按最终 HTTPS endpoint 构造兼容 Provider。这不改变
 * Hold/目录模型，也不会让 UI 专用字段进入持久化文档。
 */
export function createBucketProvider(input: BucketProviderInput, bucketId: string): StorageBucketProvider {
  if (isBucketDraft(input)) {
    if (input.backend === "local") return createLocalStorageBucketProvider({ bucketId });
    return createS3BucketProvider(normalizedProviderConfigFromBucketDraft(input), { bucketId });
  }
  if (input.kind === "local") return createLocalStorageBucketProvider({ bucketId });
  return createS3BucketProvider(normalizedProviderConfigFromConnection(input), { bucketId });
}

/**
 * 统一处理页面字段更新。切换 S3 方式时保留本机显示名和桶密码，清空
 * 旧方式的目标字段、全部访问凭据及测试相关输入，避免跨方式误提交。
 */
export function updateBucketDraft<K extends keyof BucketDraft>(draft: BucketDraft, key: K, value: BucketDraft[K]): BucketDraft {
  if (key === "backend" && (value === "local" || value === "s3") && value !== draft.backend) {
    return {
      ...draft,
      backend: value,
      s3ConfigMode: value === "s3" ? "aws-s3" : draft.s3ConfigMode,
      accountId: "",
      endpointVariant: "default",
      endpoint: "",
      region: "",
      bucket: "",
      accessKeyId: "",
      secretAccessKey: "",
      sessionToken: "",
      prefix: "",
      forcePathStyle: false
    };
  }
  if (key === "s3ConfigMode" && draft.backend === "s3" && isS3Mode(value) && value !== draft.s3ConfigMode) {
    return {
      ...draft,
      s3ConfigMode: value,
      accountId: "",
      endpointVariant: "default",
      endpoint: "",
      region: "",
      bucket: "",
      accessKeyId: "",
      secretAccessKey: "",
      sessionToken: "",
      prefix: "",
      forcePathStyle: false
    };
  }
  return { ...draft, [key]: value };
}

/** 测试结果指纹；只纳入当前后端/方式真正有意义的字段。 */
export function bucketDraftFingerprint(draft: BucketDraft): string {
  const mode = draft.backend === "s3" ? draft.s3ConfigMode : "local";
  const fields = {
    editingBucketId: draft.editingBucketId ?? "",
    backend: draft.backend,
    label: draft.label,
    password: draft.password,
    passwordConfirm: draft.passwordConfirm,
    s3ConfigMode: mode,
    ...(draft.backend === "s3" && mode === "aws-s3" ? {
      region: draft.region,
      bucket: draft.bucket,
      accessKeyId: draft.accessKeyId,
      secretAccessKey: draft.secretAccessKey,
      sessionToken: draft.sessionToken,
      prefix: draft.prefix
    } : {}),
    ...(draft.backend === "s3" && mode === "cloudflare-r2" ? {
      accountId: draft.accountId,
      endpointVariant: draft.endpointVariant,
      bucket: draft.bucket,
      accessKeyId: draft.accessKeyId,
      secretAccessKey: draft.secretAccessKey,
      sessionToken: draft.sessionToken,
      prefix: draft.prefix
    } : {}),
    ...(draft.backend === "s3" && mode === "s3-compatible" ? {
      endpoint: draft.endpoint,
      region: draft.region,
      bucket: draft.bucket,
      accessKeyId: draft.accessKeyId,
      secretAccessKey: draft.secretAccessKey,
      sessionToken: draft.sessionToken,
      prefix: draft.prefix,
      forcePathStyle: draft.forcePathStyle
    } : {})
  };
  return JSON.stringify(fields);
}

function mapNormalizerError(draft: BucketDraft, caught: unknown): BucketDraftValidationError {
  const message = caught instanceof Error ? caught.message : "";
  if (draft.s3ConfigMode === "aws-s3" && /region|partition|AWS/iu.test(message)) {
    return validationError("aws-region-invalid", "region", "AWS Region 不属于当前支持的分区，或格式不正确；支持 AWS 商业区、中国区和 GovCloud。");
  }
  if (draft.s3ConfigMode === "cloudflare-r2" && /accountId/iu.test(message)) {
    return validationError("r2-account-invalid", "accountId", "Account ID 必须是 32 位十六进制字符串。");
  }
  if (draft.s3ConfigMode === "cloudflare-r2" && /endpointVariant/iu.test(message)) {
    return validationError("r2-endpoint-variant-invalid", "endpointVariant", "Endpoint Variant 只能选择 Default、EU、US 或 FedRAMP。");
  }
  if (/endpoint/iu.test(message)) {
    return validationError("s3-endpoint-invalid", "endpoint", "Endpoint 必须是无用户名、无密码、无 query、无 fragment 的绝对 HTTPS 地址。");
  }
  if (/bucket/iu.test(message)) {
    return validationError("s3-bucket-invalid", "bucket", "Bucket 必须是 3～63 位小写字母、数字、点或连字符组成的名称。");
  }
  if (/sessionToken/iu.test(message)) {
    return validationError("s3-session-token-invalid", "sessionToken", "Session Token 不能为空，且不能包含控制字符。");
  }
  if (/prefix/iu.test(message)) {
    return validationError("s3-prefix-invalid", "prefix", "Prefix 必须是安全的相对对象路径，不能以 `/` 开头或包含 `.`、`..` 段。");
  }
  return validationError("s3-credentials-required", "accessKeyId", "S3 连接参数或访问凭据不合法，请检查中文字段说明后重试。");
}

/**
 * 无 React 的页面草稿校验；调用方应在构造 Provider 或发起 probe 前执行。
 */
export function validateBucketDraft(draft: BucketDraft): BucketDraftValidationError | undefined {
  if (!draft.label.trim()) return validationError("label-required", "label", "请输入桶名称（本机显示名称）。");
  if (draft.backend === "local") return undefined;
  if (!isS3Mode(draft.s3ConfigMode)) return validationError("s3-mode-invalid", "s3ConfigMode", "请选择 AWS S3、Cloudflare R2 或普通 S3-compatible 配置方式。");

  if (draft.s3ConfigMode === "aws-s3" && !draft.region.trim()) return validationError("aws-region-required", "region", "请填写 Region（AWS 区域）。");
  if (draft.s3ConfigMode === "cloudflare-r2") {
    if (!draft.accountId.trim()) return validationError("r2-account-required", "accountId", "请填写 Account ID（Cloudflare 账户 ID）。");
    if (!/^[a-f0-9]{32}$/iu.test(draft.accountId.trim())) return validationError("r2-account-invalid", "accountId", "Account ID 必须是 32 位十六进制字符串。");
    if (!R2_ENDPOINT_VARIANTS.includes(draft.endpointVariant)) {
      return validationError("r2-endpoint-variant-invalid", "endpointVariant", "Endpoint Variant 只能选择 Default、EU、US 或 FedRAMP。");
    }
  }
  if (draft.s3ConfigMode === "s3-compatible" && !draft.endpoint.trim()) return validationError("s3-endpoint-required", "endpoint", "请填写 Endpoint（HTTPS 服务地址）。");
  if (draft.s3ConfigMode === "s3-compatible" && !draft.region.trim()) return validationError("s3-region-required", "region", "请填写 Region（S3 签名区域）。");
  if (!draft.bucket.trim()) return validationError("s3-bucket-required", "bucket", "请填写 Bucket（物理桶名称）。");
  if (!draft.accessKeyId) return validationError("s3-credentials-required", "accessKeyId", "请填写 Access Key ID（访问身份）和 Secret Access Key（访问密钥）。");
  if (!draft.secretAccessKey) return validationError("s3-credentials-required", "secretAccessKey", "请填写 Access Key ID（访问身份）和 Secret Access Key（访问密钥）。");

  try {
    normalizedProviderConfigFromBucketDraft(draft);
    return undefined;
  } catch (caught) {
    return mapNormalizerError(draft, caught);
  }
}
