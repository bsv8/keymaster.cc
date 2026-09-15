// 设备引导层契约。
//
// 这个文件描述的是设备上的“连接控制面”，不是业务目录。实现层必须把
// 它当成一个严格的 allow-list：未知字段、过大的记录和任何运行态都拒绝。

import { sha256 } from "@noble/hashes/sha2.js";

import type {
  StorageBucketBackend,
  StorageCipherEnvelopeV1,
  StorageKeyDerivationV1,
  StorageRecordV1,
} from "./catalog.js";

/** 设备引导允许记住的远端 Provider 类型。Local 仅作为旧数据/开发适配器。 */
export type DeviceRemoteProviderId = StorageBucketBackend;

/** 不含访问凭据的规范化物理位置。 */
export type DeviceRemoteStorageLocationV1 =
  | {
      providerId: "local";
      /** Browser-local Provider namespace (the bucket object-key prefix). */
      namespace: string;
    }
  | {
      providerId: "s3";
      /** 规范化后的 HTTPS endpoint。 */
      endpoint: string;
      /** S3 签名区域。 */
      region: string;
      /** 物理 bucket 名称。 */
      bucket: string;
      /** 用户提供的对象前缀。 */
      prefix?: string;
      /** 是否使用 path-style 请求。 */
      forcePathStyle?: boolean;
    };

/** 设备上保存的一条远端连接；不包含明文密码、Key 或业务数据。 */
export interface DeviceRemoteConnectionV1 {
  /** 稳定的逻辑远端身份，不等于物理 bucket 名称。 */
  remoteStorageId: string;
  /** 本机显示名称。 */
  displayName: string;
  /** Provider 类型；业务层不应据此分叉。 */
  providerId: DeviceRemoteProviderId;
  /** 不含凭据的规范化物理位置；设备引导记录不得脱离位置指纹存在。 */
  location: DeviceRemoteStorageLocationV1;
  /** endpoint/bucket/prefix 等规范化位置的 SHA-256 指纹。 */
  physicalLocationFingerprint: string;
  /** 以远端密码保护的连接配置；其中不得出现明文凭据。 */
  encryptedConfig: StorageRecordV1;
  /** 加密连接配置所需的公开 KDF 参数。 */
  keyDerivation: StorageKeyDerivationV1;
  /** 首次写入该设备引导条目的来源。 */
  source: "created" | "connected";
  /** 创建时间（毫秒）。 */
  createdAt: number;
  /** 最后修改时间（毫秒）。 */
  updatedAt: number;
}

/** 恢复指针中的脱敏错误分类。 */
export type DeviceRemoteRecoveryErrorClass =
  | "authentication"
  | "forbidden"
  | "network"
  | "timeout"
  | "cors"
  | "corrupt"
  | "incompatible"
  | "unknown";

/** 未完成创建/连接事务的最小恢复指针。 */
export interface DeviceRemoteRecoveryPointerV1 {
  /** 本机唯一操作 ID。 */
  operationId: string;
  /** 明确区分新建和接入已有空间。 */
  mode: "create" | "connect";
  /** 操作目标的物理位置指纹。 */
  physicalLocationFingerprint: string;
  /** 已知的远端逻辑身份。 */
  remoteStorageId?: string;
  /** 已发布根 manifest 的指纹。 */
  manifestFingerprint?: string;
  /** 初始化事务记录的指纹。 */
  transactionFingerprint?: string;
  /** 结果未知或需要人工处理；不得据此自动覆盖远端。 */
  status: "unknown" | "attention-required";
  /** 脱敏错误分类。 */
  errorClass?: DeviceRemoteRecoveryErrorClass;
  /** 最近更新时间（毫秒）。 */
  updatedAt: number;
}

/** 唯一的设备引导目录。 */
export interface DeviceBootstrapCatalogV1 {
  format: "keymaster.device-bootstrap";
  version: 1;
  /** 当前启动时预选的远端身份。 */
  selectedRemoteStorageId?: string;
  /** 本机可用连接。 */
  connections: DeviceRemoteConnectionV1[];
  /** 只用于恢复未决事务。 */
  recoveries: DeviceRemoteRecoveryPointerV1[];
  /** 同一浏览器存储上下文的稳定 Worker profile 标识。 */
  workerProfileId: string;
}

/** 设备引导字段和记录的硬上限。 */
export const DEVICE_BOOTSTRAP_LIMITS = Object.freeze({
  maxConnections: 32,
  maxRecoveries: 32,
  maxDisplayNameLength: 128,
  maxSerializedBytes: 128 * 1024,
  maxEncryptedConfigBytes: 32 * 1024,
});

const CONNECTION_KEYS = [
  "createdAt",
  "displayName",
  "encryptedConfig",
  "keyDerivation",
  "physicalLocationFingerprint",
  "providerId",
  "remoteStorageId",
  "source",
  "updatedAt",
  "location",
] as const;
const LOCATION_LOCAL_KEYS = ["namespace", "providerId"] as const;
const LOCATION_S3_KEYS = ["bucket", "endpoint", "forcePathStyle", "prefix", "providerId", "region"] as const;
const RECOVERY_KEYS = [
  "errorClass",
  "manifestFingerprint",
  "mode",
  "operationId",
  "physicalLocationFingerprint",
  "remoteStorageId",
  "status",
  "transactionFingerprint",
  "updatedAt",
] as const;
const CATALOG_KEYS = ["connections", "format", "recoveries", "selectedRemoteStorageId", "version", "workerProfileId"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fail(field: string): never {
  throw new TypeError(`Device bootstrap ${field} is invalid`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) fail(`${field} fields`);
}

function text(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || (pattern && !pattern.test(value))) fail(field);
  return value;
}

function optionalText(value: unknown, field: string, max: number, pattern?: RegExp): string | undefined {
  if (value === undefined) return undefined;
  return text(value, field, max, pattern);
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(field);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field);
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function validateDerivation(value: unknown): StorageKeyDerivationV1 {
  if (!isRecord(value)) fail("keyDerivation");
  assertExactKeys(value, ["algorithm", "iterations", "outputLengthBits", "passwordEncoding", "saltB64Url"], "keyDerivation");
  if (value.algorithm !== "pbkdf2-hmac-sha-256" || value.passwordEncoding !== "utf-8" || value.outputLengthBits !== 256) fail("keyDerivation");
  const iterations = integer(value.iterations, "keyDerivation.iterations", 100_000);
  if (iterations > 2_000_000) fail("keyDerivation.iterations");
  const saltB64Url = text(value.saltB64Url, "keyDerivation.saltB64Url", 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(saltB64Url)) fail("keyDerivation.saltB64Url");
  return { algorithm: "pbkdf2-hmac-sha-256", passwordEncoding: "utf-8", iterations, outputLengthBits: 256, saltB64Url };
}

function validateCipher(value: unknown): StorageCipherEnvelopeV1 {
  if (!isRecord(value)) fail("encryptedConfig.cipher");
  assertExactKeys(value, ["algorithm", "ciphertextAndTagB64Url", "ivB64Url", "keyLengthBits", "tagLengthBits"], "encryptedConfig.cipher");
  if (value.algorithm !== "aes-gcm" || value.keyLengthBits !== 256 || value.tagLengthBits !== 128) fail("encryptedConfig.cipher");
  const ivB64Url = text(value.ivB64Url, "encryptedConfig.cipher.ivB64Url", 128);
  const ciphertextAndTagB64Url = text(value.ciphertextAndTagB64Url, "encryptedConfig.cipher.ciphertextAndTagB64Url", DEVICE_BOOTSTRAP_LIMITS.maxEncryptedConfigBytes);
  if (!/^[A-Za-z0-9_-]+$/u.test(ivB64Url) || !/^[A-Za-z0-9_-]+$/u.test(ciphertextAndTagB64Url)) fail("encryptedConfig.cipher");
  return { algorithm: "aes-gcm", keyLengthBits: 256, ivB64Url, tagLengthBits: 128, ciphertextAndTagB64Url };
}

function validateEncryptedConfig(value: unknown): StorageRecordV1 {
  if (!isRecord(value)) fail("encryptedConfig");
  assertExactKeys(value, ["cipher"], "encryptedConfig");
  return { cipher: validateCipher(value.cipher) };
}

/** 校验不含凭据的物理位置。 */
export function validateDeviceRemoteStorageLocation(value: unknown): DeviceRemoteStorageLocationV1 {
  if (!isRecord(value)) fail("location");
  if (value.providerId === "local") {
    assertExactKeys(value, LOCATION_LOCAL_KEYS, "location");
    return { providerId: "local", namespace: text(value.namespace, "location.namespace", 128, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u) };
  }
  if (value.providerId !== "s3") fail("location.providerId");
  assertExactKeys(value, LOCATION_S3_KEYS, "location");
  const endpoint = text(value.endpoint, "location.endpoint", 2_048);
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { fail("location.endpoint"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) fail("location.endpoint");
  const region = text(value.region, "location.region", 128);
  const bucket = text(value.bucket, "location.bucket", 63, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u);
  const prefix = optionalText(value.prefix, "location.prefix", 1_024);
  if (prefix !== undefined && (prefix.startsWith("/") || prefix.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\")))) fail("location.prefix");
  const forcePathStyle = value.forcePathStyle === undefined ? undefined : boolean(value.forcePathStyle, "location.forcePathStyle");
  return { providerId: "s3", endpoint: parsed.toString().replace(/\/$/u, ""), region, bucket, ...(prefix === undefined ? {} : { prefix }), ...(forcePathStyle === undefined ? {} : { forcePathStyle }) };
}

/** 对已经规范化的物理位置计算稳定指纹。 */
export function deviceRemoteStorageLocationFingerprint(location: DeviceRemoteStorageLocationV1): string {
  const checked = validateDeviceRemoteStorageLocation(location);
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(checked)));
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 校验单条设备连接。 */
export function validateDeviceRemoteConnection(value: unknown): DeviceRemoteConnectionV1 {
  if (!isRecord(value)) fail("connection");
  assertExactKeys(value, CONNECTION_KEYS, "connection");
  const remoteStorageId = text(value.remoteStorageId, "connection.remoteStorageId", 128, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  const displayName = text(value.displayName, "connection.displayName", DEVICE_BOOTSTRAP_LIMITS.maxDisplayNameLength);
  const providerId = value.providerId;
  if (providerId !== "local" && providerId !== "s3") fail("connection.providerId");
  const location = validateDeviceRemoteStorageLocation(value.location);
  if (location.providerId !== providerId) fail("connection.location.providerId");
  const physicalLocationFingerprint = text(value.physicalLocationFingerprint, "connection.physicalLocationFingerprint", 64, /^[0-9a-f]{64}$/u);
  if (deviceRemoteStorageLocationFingerprint(location) !== physicalLocationFingerprint) fail("connection.physicalLocationFingerprint");
  const encryptedConfig = validateEncryptedConfig(value.encryptedConfig);
  const keyDerivation = validateDerivation(value.keyDerivation);
  const source = value.source;
  if (source !== "created" && source !== "connected") fail("connection.source");
  const createdAt = integer(value.createdAt, "connection.createdAt");
  const updatedAt = integer(value.updatedAt, "connection.updatedAt");
  return {
    remoteStorageId,
    displayName,
    providerId,
    location,
    physicalLocationFingerprint,
    encryptedConfig,
    keyDerivation,
    source,
    createdAt,
    updatedAt,
  };
}

/** 校验单条恢复指针。 */
export function validateDeviceRemoteRecoveryPointer(value: unknown): DeviceRemoteRecoveryPointerV1 {
  if (!isRecord(value)) fail("recovery");
  assertExactKeys(value, RECOVERY_KEYS, "recovery");
  const operationId = text(value.operationId, "recovery.operationId", 128, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
  const mode = value.mode;
  if (mode !== "create" && mode !== "connect") fail("recovery.mode");
  const physicalLocationFingerprint = text(value.physicalLocationFingerprint, "recovery.physicalLocationFingerprint", 64, /^[0-9a-f]{64}$/u);
  const remoteStorageId = optionalText(value.remoteStorageId, "recovery.remoteStorageId", 128, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  const manifestFingerprint = optionalText(value.manifestFingerprint, "recovery.manifestFingerprint", 64, /^[0-9a-f]{64}$/u);
  const transactionFingerprint = optionalText(value.transactionFingerprint, "recovery.transactionFingerprint", 64, /^[0-9a-f]{64}$/u);
  const status = value.status;
  if (status !== "unknown" && status !== "attention-required") fail("recovery.status");
  const errorClass = value.errorClass;
  if (errorClass !== undefined && !["authentication", "forbidden", "network", "timeout", "cors", "corrupt", "incompatible", "unknown"].includes(String(errorClass))) fail("recovery.errorClass");
  return {
    operationId,
    mode,
    physicalLocationFingerprint,
    ...(remoteStorageId === undefined ? {} : { remoteStorageId }),
    ...(manifestFingerprint === undefined ? {} : { manifestFingerprint }),
    ...(transactionFingerprint === undefined ? {} : { transactionFingerprint }),
    status,
    ...(errorClass === undefined ? {} : { errorClass: errorClass as DeviceRemoteRecoveryErrorClass }),
    updatedAt: integer(value.updatedAt, "recovery.updatedAt"),
  };
}

function assertSerializedSize(value: DeviceBootstrapCatalogV1): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > DEVICE_BOOTSTRAP_LIMITS.maxSerializedBytes) fail("catalog size");
}

/** 严格解析设备引导目录；未知字段和重复身份都会失败。 */
export function validateDeviceBootstrapCatalog(value: unknown): DeviceBootstrapCatalogV1 {
  if (!isRecord(value)) fail("catalog");
  assertExactKeys(value, CATALOG_KEYS, "catalog");
  if (value.format !== "keymaster.device-bootstrap" || value.version !== 1) fail("catalog.format");
  const workerProfileId = text(value.workerProfileId, "catalog.workerProfileId", 128, /^profile-[A-Za-z0-9_-]{1,120}$/u);
  if (!Array.isArray(value.connections) || value.connections.length > DEVICE_BOOTSTRAP_LIMITS.maxConnections) fail("catalog.connections");
  if (!Array.isArray(value.recoveries) || value.recoveries.length > DEVICE_BOOTSTRAP_LIMITS.maxRecoveries) fail("catalog.recoveries");
  const connections = value.connections.map(validateDeviceRemoteConnection);
  const remoteIds = new Set<string>();
  const physicalLocationIds = new Set<string>();
  for (const connection of connections) {
    if (remoteIds.has(connection.remoteStorageId)) fail("catalog duplicate remoteStorageId");
    remoteIds.add(connection.remoteStorageId);
    if (physicalLocationIds.has(connection.physicalLocationFingerprint)) fail("catalog duplicate physical location");
    physicalLocationIds.add(connection.physicalLocationFingerprint);
  }
  const recoveries = value.recoveries.map(validateDeviceRemoteRecoveryPointer);
  const operationIds = new Set<string>();
  for (const recovery of recoveries) {
    if (operationIds.has(recovery.operationId)) fail("catalog duplicate operationId");
    operationIds.add(recovery.operationId);
  }
  const selectedRemoteStorageId = optionalText(value.selectedRemoteStorageId, "catalog.selectedRemoteStorageId", 128, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  if (selectedRemoteStorageId !== undefined && !remoteIds.has(selectedRemoteStorageId)) fail("catalog.selectedRemoteStorageId");
  const catalog: DeviceBootstrapCatalogV1 = {
    format: "keymaster.device-bootstrap",
    version: 1,
    ...(selectedRemoteStorageId === undefined ? {} : { selectedRemoteStorageId }),
    connections,
    recoveries,
    workerProfileId,
  };
  assertSerializedSize(catalog);
  return catalog;
}

/** 创建没有连接的引导目录；调用方应随后以一次受保护写入提交它。 */
export function createEmptyDeviceBootstrapCatalog(workerProfileId: string): DeviceBootstrapCatalogV1 {
  return validateDeviceBootstrapCatalog({ format: "keymaster.device-bootstrap", version: 1, connections: [], recoveries: [], workerProfileId });
}
