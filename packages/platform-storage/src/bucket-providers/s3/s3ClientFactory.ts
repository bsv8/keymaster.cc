import type {
  NormalizedStorageProviderConfig,
  StorageAwsConnection,
  StorageCompatibleConnection,
  StorageProviderConfigDraft,
  StorageProviderId,
  StorageProviderSummary,
  StorageR2Connection
} from "@keymaster/contracts";
import { StorageRuntimeError } from "../../runtime/storageRuntimeError.js";
import { normalizeDirectoryPath } from "../bucketPath.js";

function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new StorageRuntimeError("storage_invalid_path", `${field} is invalid`);
  }
  return value;
}

function region(value: unknown): string {
  const result = text(value, "region", 64).trim();
  if (!result) throw new StorageRuntimeError("storage_provider_error", "region is invalid");
  return result;
}

/** 新版通用 S3 连接可选字段的规范化；旧 AWS/R2 v1 不会走这里。 */
function optionalSessionToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return text(value, "sessionToken", 4096);
}

function optionalPrefix(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  const raw = text(value, "prefix", 1024);
  try {
    return normalizeDirectoryPath(raw);
  } catch {
    throw new StorageRuntimeError("storage_provider_error", "prefix is invalid");
  }
}

const AWS_REGION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u;
const UNSUPPORTED_AWS_PARTITION_PATTERN = /^(?:us-(?:iso|isob|isof|isoe|secret)-|eusc-|eu-isoe-)/u;

/**
 * 新版桶管理/初始设置页面支持的 R2 端点类型。
 *
 * 这是 UI 草稿语义，不是旧 StorageR2Connection v1 的持久化类型；旧
 * Profile v1 仍只接受 default、eu 和 fedramp。
 */
export const R2_ENDPOINT_VARIANTS = ["default", "eu", "fedramp", "us"] as const;
export type R2EndpointVariant = (typeof R2_ENDPOINT_VARIANTS)[number];

/**
 * 生成 AWS S3 区域端点。
 *
 * 当前明确支持 AWS 商业区、AWS 中国区和 AWS GovCloud。AWS ISO/Secret
 * 分区的域名规则不同且不能由商业区后缀推导；遇到这些区域必须在本地
 * 拒绝，不能静默生成一个看似合法但不可用的 URL。
 */
export function awsS3EndpointForRegion(value: unknown): string {
  const awsRegion = region(value);
  if (!AWS_REGION_PATTERN.test(awsRegion) || UNSUPPORTED_AWS_PARTITION_PATTERN.test(awsRegion)) {
    throw new StorageRuntimeError("storage_provider_error", "AWS region belongs to an unsupported partition or is invalid");
  }
  const suffix = awsRegion.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  return `https://s3.${awsRegion}.${suffix}`;
}

/** 生成新版页面使用的 R2 账户/端点变体 URL。 */
export function r2EndpointForAccount(accountIdValue: unknown, endpointVariant: unknown): string {
  const accountId = text(accountIdValue, "accountId", 64).trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/u.test(accountId)) throw new StorageRuntimeError("storage_provider_error", "accountId is invalid");
  if (typeof endpointVariant !== "string" || !(R2_ENDPOINT_VARIANTS as readonly string[]).includes(endpointVariant)) {
    throw new StorageRuntimeError("storage_provider_error", "endpointVariant is invalid");
  }
  const variant = endpointVariant === "default" ? "" : `.${endpointVariant}`;
  return `https://${accountId}${variant}.r2.cloudflarestorage.com`;
}

function bucket(value: unknown): string {
  const result = text(value, "bucket", 63);
  if (!/^[a-z0-9](?:[a-z0-9.-]{1,61})[a-z0-9]$/u.test(result)) {
    throw new StorageRuntimeError("storage_provider_error", "bucket is invalid");
  }
  return result;
}

function endpoint(value: unknown): string {
  const raw = text(value, "endpoint", 2048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new StorageRuntimeError("storage_provider_error", "endpoint must be an absolute HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.search || (raw !== parsed.toString() && raw !== parsed.toString().replace(/\/$/u, ""))) {
    throw new StorageRuntimeError("storage_provider_error", "endpoint must be an HTTPS URL without credentials");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function credentials(draft: StorageProviderConfigDraft, existing?: NormalizedStorageProviderConfig): { accessKeyId: string; secretAccessKey: string } {
  if (draft.credentials.mode === "retain") {
    if (!existing || existing.providerId !== draft.providerId) throw new StorageRuntimeError("storage_provider_error", "credentials must be replaced for a new provider");
    return { ...existing.credentials };
  }
  const accessKeyId = text(draft.credentials.accessKeyId, "accessKeyId", 256);
  const secretAccessKey = text(draft.credentials.secretAccessKey, "secretAccessKey", 1024);
  return { accessKeyId, secretAccessKey };
}

function connection(providerId: StorageProviderId, value: StorageProviderConfigDraft["connection"]): NormalizedStorageProviderConfig["connection"] {
  if (providerId === "aws-s3") {
    const input = value as StorageAwsConnection;
    // 这里是旧 Storage Profile v1 的兼容入口。不要把新版页面字段
    // （Session Token、Prefix 或自动 Endpoint）反向加入旧持久化语义。
    return { region: text(input.region, "region", 64), bucket: bucket(input.bucket) };
  }
  if (providerId === "cloudflare-r2") {
    const input = value as StorageR2Connection;
    const accountId = text(input.accountId, "accountId", 64);
    if (!/^[a-f0-9]{32}$/iu.test(accountId)) throw new StorageRuntimeError("storage_provider_error", "accountId is invalid");
    if (!["default", "eu", "fedramp"].includes(input.endpointVariant)) throw new StorageRuntimeError("storage_provider_error", "endpointVariant is invalid");
    return { accountId: accountId.toLowerCase(), endpointVariant: input.endpointVariant, bucket: bucket(input.bucket) };
  }
  const input = value as StorageCompatibleConnection;
  const sessionToken = optionalSessionToken(input.sessionToken);
  const prefix = optionalPrefix(input.prefix);
  return {
    endpoint: endpoint(input.endpoint),
    region: text(input.region, "region", 64),
    bucket: bucket(input.bucket),
    forcePathStyle: input.forcePathStyle === true,
    ...(sessionToken === undefined ? {} : { sessionToken }),
    ...(prefix === undefined ? {} : { prefix })
  };
}

export function normalizeProviderConfig(draft: StorageProviderConfigDraft, existing?: NormalizedStorageProviderConfig): NormalizedStorageProviderConfig {
  if (!draft || !["aws-s3", "cloudflare-r2", "s3-compatible"].includes(draft.providerId)) throw new StorageRuntimeError("storage_provider_error", "providerId is invalid");
  return { version: 1, providerId: draft.providerId, connection: connection(draft.providerId, draft.connection), credentials: { kind: "access-key", ...credentials(draft, existing) } };
}

export function providerEndpoint(config: NormalizedStorageProviderConfig): string | undefined {
  if (config.providerId === "s3-compatible") return (config.connection as StorageCompatibleConnection).endpoint;
  if (config.providerId !== "cloudflare-r2") return undefined;
  const input = config.connection as StorageR2Connection;
  const variant = input.endpointVariant === "default" ? "" : `.${input.endpointVariant}`;
  return `https://${input.accountId}${variant}.r2.cloudflarestorage.com`;
}

export function summaryForConfig(config: NormalizedStorageProviderConfig, generation: number, updatedAt: number): StorageProviderSummary {
  const bucketValue = (config.connection as { bucket: string }).bucket;
  const key = config.credentials.accessKeyId;
  return {
    providerId: config.providerId,
    bucketHint: bucketValue.length <= 6 ? "••••" : `${bucketValue.slice(0, 2)}••••${bucketValue.slice(-2)}`,
    endpointHint: providerEndpoint(config),
    accessKeyHint: key.length <= 4 ? "••••" : `••••${key.slice(-4)}`,
    secretConfigured: true,
    generation,
    updatedAt
  };
}

export function configToBytes(config: NormalizedStorageProviderConfig): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(config));
}

export function configFromBytes(bytes: Uint8Array): NormalizedStorageProviderConfig {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new StorageRuntimeError("storage_provider_error", "stored provider config is invalid"); }
  if (!parsed || typeof parsed !== "object") throw new StorageRuntimeError("storage_provider_error", "stored provider config is invalid");
  const value = parsed as NormalizedStorageProviderConfig;
  if (value.version !== 1 || !value.credentials || value.credentials.kind !== "access-key") throw new StorageRuntimeError("storage_provider_error", "stored provider config is invalid");
  return normalizeProviderConfig({ providerId: value.providerId, connection: value.connection, credentials: { mode: "replace", accessKeyId: value.credentials.accessKeyId, secretAccessKey: value.credentials.secretAccessKey } });
}
