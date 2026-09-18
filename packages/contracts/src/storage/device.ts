// 设备桶记录契约（keymaster.device.v1）。
//
// 一个桶一条记录，直接以 `keymaster.device.<ID>` 为键保存；没有"连接列表"
// 外壳，也没有 selected 字段（当前选中的桶由 session 记录决定）。字段、坐标
// 规范化与唯一性规则以 KeymasterFormats《设备桶记录》为准。

/** 设备桶记录的存储键前缀；`<ID>` 就是 remoteStorageId。 */
export const DEVICE_KEY_PREFIX = "keymaster.device.";
/** 固定格式标识。 */
export const DEVICE_FORMAT = "keymaster.device";
/** 固定格式版本。 */
export const DEVICE_VERSION = 1;
/** `<ID>` 与 remoteStorageId 的字符规则。 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** 设备桶记录的硬上限。 */
export const DEVICE_LIMITS = Object.freeze({
  /** 最多登记 32 个桶。 */
  maxRecords: 32,
  /** 显示名称最多 128 个字符。 */
  maxDisplayNameLength: 128,
  /** 单条 JSON 记录最多 128 KiB。 */
  maxSerializedBytes: 128 * 1024,
  /** 密文 Base64URL 字符串最多 32768 个字符。 */
  maxCiphertextChars: 32 * 1024,
  /** 解密后的配置明文最大字节数。 */
  maxConfigPlaintextBytes: 32 * 1024,
});

/** 设备记录支持的 provider 类型。 */
export type DeviceProviderId = "local" | "s3";

/** 不含访问凭据的公开物理坐标。 */
export type DeviceLocationV1 =
  | {
      /** Local 的对象前缀就是键名里的 `<ID>`。 */
      providerId: "local";
    }
  | {
      /** S3-compatible 服务的规范化 HTTPS 地址。 */
      providerId: "s3";
      /** 规范化后的 HTTPS endpoint；末尾斜杠已去掉。 */
      endpoint: string;
      /** S3 签名区域。 */
      region: string;
      /** 物理 S3 bucket 名称。 */
      bucket: string;
      /** 可选对象前缀；保存前会去掉首尾斜杠。 */
      prefix?: string;
      /** 只有 true 才会写入；省略表示默认的虚拟主机风格。 */
      forcePathStyle?: boolean;
    };

/** 与 KeyHold 相同的 AES-256-GCM 密文封装；算法和长度必须完整写入。 */
export interface DeviceCipherV1 {
  /** 固定 `"aes-gcm"`。 */
  algorithm: "aes-gcm";
  /** 固定 256。 */
  keyLengthBits: 256;
  /** 12 字节随机 nonce 的无填充 Base64URL 编码。 */
  ivB64Url: string;
  /** 固定 128。 */
  tagLengthBits: 128;
  /** 密文与 16 字节认证标签拼接后的无填充 Base64URL 编码。 */
  ciphertextAndTagB64Url: string;
}

/** 解密后允许存在的连接配置字段；凭据只允许出现在这里。 */
export interface DeviceConfigPlaintextV1 {
  /** 最终 S3-compatible HTTPS Endpoint。 */
  endpoint: string;
  /** S3 签名区域。 */
  region: string;
  /** 物理 S3 桶名。 */
  bucket: string;
  /** S3 Access Key ID（敏感）。 */
  accessKeyId: string;
  /** S3 Secret Access Key（敏感）。 */
  secretAccessKey: string;
  /** 可选临时会话令牌（敏感）。 */
  sessionToken?: string;
  /** 可选对象前缀。 */
  prefix?: string;
  /** 是否使用 path-style 请求。 */
  forcePathStyle?: boolean;
}

/**
 * S3 桶已探测到的条件写能力缓存。
 *
 * - `"native"`：服务端原生执行 If-None-Match / If-Match（原子）。
 * - `"best-effort"`：服务端忽略条件头，改用读 ETag 后写入模拟（非原子）。
 *
 * 字段缺失表示尚未探测；不设过期时间，只通过显式“重新探测”更新。
 */
export interface DeviceCapabilitiesV1 {
  /** 条件写能力；只允许已探测成功的两个取值。 */
  conditionalWrites: "native" | "best-effort";
}

/** 一条设备桶记录：Local 没有 cipher，S3 必须有 cipher。 */
export type DeviceRecordV1 =
  | {
      /** 固定格式标识。 */
      format: "keymaster.device";
      /** 固定格式版本。 */
      version: 1;
      /** 本机显示名称，可省略。 */
      displayName?: string;
      /** Local 公开坐标。 */
      location: Extract<DeviceLocationV1, { providerId: "local" }>;
    }
  | {
      /** 固定格式标识。 */
      format: "keymaster.device";
      /** 固定格式版本。 */
      version: 1;
      /** 本机显示名称，可省略。 */
      displayName?: string;
      /** S3 公开坐标。 */
      location: Extract<DeviceLocationV1, { providerId: "s3" }>;
      /** 用启动密码（会话密码）派生的 key 加密的凭据密文。 */
      cipher: DeviceCipherV1;
      /** 已探测到的条件写能力缓存；缺失表示尚未探测。 */
      capabilities?: DeviceCapabilitiesV1;
    };

const RECORD_LOCAL_KEYS = ["displayName", "format", "location", "version"] as const;
const RECORD_S3_KEYS = ["capabilities", "cipher", "displayName", "format", "location", "version"] as const;
const LOCATION_LOCAL_KEYS = ["providerId"] as const;
const LOCATION_S3_KEYS = ["bucket", "endpoint", "forcePathStyle", "prefix", "providerId", "region"] as const;
const CIPHER_KEYS = ["algorithm", "ciphertextAndTagB64Url", "ivB64Url", "keyLengthBits", "tagLengthBits"] as const;
const CAPABILITIES_KEYS = ["conditionalWrites"] as const;
const PLAINTEXT_KEYS = ["accessKeyId", "bucket", "endpoint", "forcePathStyle", "prefix", "region", "secretAccessKey", "sessionToken"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fail(field: string): never {
  throw new TypeError(`Device record ${field} is invalid`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) fail(`${field} fields`);
}

function text(value: unknown, field: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value) || (pattern && !pattern.test(value))) {
    fail(field);
  }
  return value;
}

function optionalText(value: unknown, field: string, maximum: number, pattern?: RegExp): string | undefined {
  return value === undefined ? undefined : text(value, field, maximum, pattern);
}

function decodeBase64Url(value: unknown, field: string, maximumChars: number): { encoded: string; bytes: Uint8Array } {
  const encoded = text(value, field, maximumChars);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length % 4 === 1) fail(field);
  const normalized = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
  let binary: string;
  try {
    binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  } catch {
    fail(field);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (encodeBase64Url(bytes) !== encoded) fail(field);
  return { encoded, bytes };
}

/** 无填充 Base64URL 编码。 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function codePointCompare(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** 规范化 JSON：对象键按 Unicode 码点排序，数组顺序保持不变；只用于比较。 */
export function canonicalizeDeviceJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeDeviceJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(codePointCompare)
      .map((key) => [key, canonicalizeDeviceJson(value[key])]),
  );
}

/** 返回紧凑规范 JSON 字符串。 */
export function canonicalizeDeviceJsonString(value: unknown): string {
  return JSON.stringify(canonicalizeDeviceJson(value));
}

/** 规范化 endpoint：只接受 HTTPS，去掉末尾全部斜杠。 */
export function normalizeDeviceEndpoint(value: unknown): string {
  const endpoint = text(value, "location.endpoint", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail("location.endpoint");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) fail("location.endpoint");
  return parsed.toString().replace(/\/+$/u, "");
}

/** 规范化 prefix：去掉首尾斜杠；空串表示省略。 */
export function normalizeDevicePrefix(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(value)) fail("location.prefix");
  const trimmed = value.replace(/^\/+|\/+$/gu, "");
  if (!trimmed) return undefined;
  if (trimmed.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\"))) fail("location.prefix");
  return trimmed;
}

/** 校验并规范化公开物理坐标。 */
export function validateDeviceLocation(value: unknown): DeviceLocationV1 {
  if (!isRecord(value)) fail("location");
  if (value.providerId === "local") {
    assertExactKeys(value, LOCATION_LOCAL_KEYS, "location");
    return { providerId: "local" };
  }
  if (value.providerId !== "s3") fail("location.providerId");
  assertExactKeys(value, LOCATION_S3_KEYS, "location");
  const endpoint = normalizeDeviceEndpoint(value.endpoint);
  const region = text(value.region, "location.region", 128);
  const bucket = text(value.bucket, "location.bucket", 63, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u);
  const prefix = normalizeDevicePrefix(value.prefix);
  if (value.forcePathStyle !== undefined && value.forcePathStyle !== true && value.forcePathStyle !== false) fail("location.forcePathStyle");
  return {
    providerId: "s3",
    endpoint,
    region,
    bucket,
    ...(prefix === undefined ? {} : { prefix }),
    ...(value.forcePathStyle === true ? { forcePathStyle: true as const } : {}),
  };
}

/** 校验并规范化 AES-GCM 密文封装。 */
export function validateDeviceCipher(value: unknown): DeviceCipherV1 {
  if (!isRecord(value)) fail("cipher");
  assertExactKeys(value, CIPHER_KEYS, "cipher");
  if (value.algorithm !== "aes-gcm" || value.keyLengthBits !== 256 || value.tagLengthBits !== 128) fail("cipher algorithm");
  const { encoded: ivB64Url, bytes: iv } = decodeBase64Url(value.ivB64Url, "cipher.ivB64Url", 128);
  if (iv.byteLength !== 12) fail("cipher.ivB64Url");
  const { encoded: ciphertextAndTagB64Url, bytes: ciphertextAndTag } = decodeBase64Url(value.ciphertextAndTagB64Url, "cipher.ciphertextAndTagB64Url", DEVICE_LIMITS.maxCiphertextChars);
  if (ciphertextAndTag.byteLength < 16) fail("cipher.ciphertextAndTagB64Url");
  return { algorithm: "aes-gcm", keyLengthBits: 256, ivB64Url, tagLengthBits: 128, ciphertextAndTagB64Url };
}

/** 校验解密后的配置明文；字段白名单，未知字段直接失败。 */
export function validateDeviceConfigPlaintext(value: unknown): DeviceConfigPlaintextV1 {
  if (!isRecord(value)) fail("config plaintext");
  assertExactKeys(value, PLAINTEXT_KEYS, "config plaintext");
  const endpoint = normalizeDeviceEndpoint(value.endpoint);
  const region = text(value.region, "config.region", 128);
  const bucket = text(value.bucket, "config.bucket", 63, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u);
  const accessKeyId = text(value.accessKeyId, "config.accessKeyId", 1_024);
  const secretAccessKey = text(value.secretAccessKey, "config.secretAccessKey", 4_096);
  const sessionToken = optionalText(value.sessionToken, "config.sessionToken", 8_192);
  const prefix = normalizeDevicePrefix(value.prefix);
  if (value.forcePathStyle !== undefined && value.forcePathStyle !== true && value.forcePathStyle !== false) fail("config.forcePathStyle");
  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(value.forcePathStyle === true ? { forcePathStyle: true as const } : {}),
  };
}

/** 校验条件写能力缓存；只允许已探测成功的两种取值。 */
export function validateDeviceCapabilities(value: unknown): DeviceCapabilitiesV1 {
  if (!isRecord(value)) fail("capabilities");
  assertExactKeys(value, CAPABILITIES_KEYS, "capabilities");
  if (value.conditionalWrites !== "native" && value.conditionalWrites !== "best-effort") fail("capabilities.conditionalWrites");
  return { conditionalWrites: value.conditionalWrites };
}

/** 校验单条设备桶记录；Local 禁止 cipher 与 capabilities，S3 必须有 cipher。 */
export function validateDeviceRecord(value: unknown): DeviceRecordV1 {
  if (!isRecord(value)) fail("record");
  if (value.format !== DEVICE_FORMAT || value.version !== DEVICE_VERSION) fail("format");
  const location = validateDeviceLocation(value.location);
  const displayName = optionalText(value.displayName, "displayName", DEVICE_LIMITS.maxDisplayNameLength);
  if (location.providerId === "local") {
    assertExactKeys(value, RECORD_LOCAL_KEYS, "record");
    return { format: DEVICE_FORMAT, version: DEVICE_VERSION, ...(displayName === undefined ? {} : { displayName }), location };
  }
  assertExactKeys(value, RECORD_S3_KEYS, "record");
  const cipher = validateDeviceCipher(value.cipher);
  const capabilities = value.capabilities === undefined ? undefined : validateDeviceCapabilities(value.capabilities);
  const record: DeviceRecordV1 = { format: DEVICE_FORMAT, version: DEVICE_VERSION, ...(displayName === undefined ? {} : { displayName }), location, cipher, ...(capabilities === undefined ? {} : { capabilities }) };
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > DEVICE_LIMITS.maxSerializedBytes) fail("record size");
  return record;
}

/** 构造存储键；ID 非法时抛错。 */
export function deviceKeyFor(remoteStorageId: string): string {
  if (typeof remoteStorageId !== "string" || !DEVICE_ID_PATTERN.test(remoteStorageId)) fail("key");
  return `${DEVICE_KEY_PREFIX}${remoteStorageId}`;
}

/** 从存储键解析 ID；不是设备键或 ID 非法时返回 undefined。 */
export function parseDeviceKey(key: string): string | undefined {
  if (typeof key !== "string" || !key.startsWith(DEVICE_KEY_PREFIX)) return undefined;
  const id = key.slice(DEVICE_KEY_PREFIX.length);
  return DEVICE_ID_PATTERN.test(id) ? id : undefined;
}

/** 用于跨记录唯一性比较的规范化位置字符串。 */
export function deviceLocationCanonical(location: DeviceLocationV1): string {
  return canonicalizeDeviceJsonString(validateDeviceLocation(location));
}
