// 浏览器 session 契约（keymaster.session.v1）。
//
// 记录浏览器的稳定身份、当前上下文（active 桶 + active key）和启动密码
// （会话密码）的 KDF 参数。原生文档见 KeymasterFormats《浏览器session》。

/** 浏览器 session 的存储键。 */
export const KEYMASTER_SESSION_KEY = "keymaster.session";
/** 固定格式标识。 */
export const KEYMASTER_SESSION_FORMAT = "keymaster.session";
/** 固定格式版本。 */
export const KEYMASTER_SESSION_VERSION = 1;
/** sessionId 的字符规则。 */
export const KEYMASTER_SESSION_ID_PATTERN = /^[0-9a-f]{32}$/u;
/** 推荐的启动密码迭代次数。 */
export const KEYMASTER_SESSION_RECOMMENDED_ITERATIONS = 600_000;

/** 启动密码（会话密码）的公开 PBKDF2 参数；规则与 KeyHold 相同。 */
export interface KeymasterSessionKeyDerivationV1 {
  /** 固定 `"pbkdf2-hmac-sha-256"`。 */
  algorithm: "pbkdf2-hmac-sha-256";
  /** 固定 `"utf-8"`。 */
  passwordEncoding: "utf-8";
  /** `1 ~ 2147483647`；推荐 600000；必须执行原值，不静默降低。 */
  iterations: number;
  /** 固定 256。 */
  outputLengthBits: 256;
  /** 16 字节随机盐的无填充 Base64URL 编码。 */
  saltB64Url: string;
}

/** 浏览器 session 记录。 */
export interface KeymasterSessionV1 {
  /** 固定格式标识。 */
  format: "keymaster.session";
  /** 固定格式版本。 */
  version: 1;
  /** 32 位小写 hex；Key 应用锁的 holder 只认这个字段。 */
  sessionId: string;
  /** active 桶的 remoteStorageId；省略表示未选桶。 */
  activeBucketId?: string;
  /** active key 的压缩公钥；activeBucketId 缺失时禁止出现。 */
  activeKey?: string;
  /** 启动密码（会话密码）的 KDF 参数；没有 s3 桶时省略。 */
  keyDerivation?: KeymasterSessionKeyDerivationV1;
}

const SESSION_KEYS = ["activeBucketId", "activeKey", "format", "keyDerivation", "sessionId", "version"] as const;
const DERIVATION_KEYS = ["algorithm", "iterations", "outputLengthBits", "passwordEncoding", "saltB64Url"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fail(field: string): never {
  throw new TypeError(`Session ${field} is invalid`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) fail(`${field} fields`);
}

function decodeBase64Url(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) fail(field);
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  let binary: string;
  try {
    binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  } catch {
    fail(field);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  let canonical = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    canonical += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  if (btoa(canonical).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "") !== value) fail(field);
  return bytes;
}

/** 校验启动密码的 KDF 参数；规则与 KeyHold 相同。 */
export function validateKeymasterSessionKeyDerivation(value: unknown): KeymasterSessionKeyDerivationV1 {
  if (!isRecord(value)) fail("keyDerivation");
  assertExactKeys(value, DERIVATION_KEYS, "keyDerivation");
  if (value.algorithm !== "pbkdf2-hmac-sha-256" || value.passwordEncoding !== "utf-8" || value.outputLengthBits !== 256) fail("keyDerivation algorithm");
  const iterations = value.iterations;
  if (typeof iterations !== "number" || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 2_147_483_647) fail("keyDerivation.iterations");
  const saltB64Url = value.saltB64Url;
  if (typeof saltB64Url !== "string" || saltB64Url.length === 0 || saltB64Url.length > 128) fail("keyDerivation.saltB64Url");
  if (decodeBase64Url(saltB64Url, "keyDerivation.saltB64Url").byteLength !== 16) fail("keyDerivation.saltB64Url");
  return { algorithm: "pbkdf2-hmac-sha-256", passwordEncoding: "utf-8", iterations, outputLengthBits: 256, saltB64Url };
}

/** 严格校验一份 session 记录；任何结构问题都抛错。 */
export function validateKeymasterSession(value: unknown): KeymasterSessionV1 {
  if (!isRecord(value)) fail("record");
  assertExactKeys(value, SESSION_KEYS, "record");
  if (value.format !== KEYMASTER_SESSION_FORMAT || value.version !== KEYMASTER_SESSION_VERSION) fail("format");
  if (typeof value.sessionId !== "string" || !KEYMASTER_SESSION_ID_PATTERN.test(value.sessionId)) fail("sessionId");
  const activeBucketId = value.activeBucketId === undefined
    ? undefined
    : (() => {
        if (typeof value.activeBucketId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.activeBucketId)) fail("activeBucketId");
        return value.activeBucketId;
      })();
  const activeKey = value.activeKey === undefined
    ? undefined
    : (() => {
        if (typeof value.activeKey !== "string" || !/^(02|03)[0-9a-f]{64}$/u.test(value.activeKey)) fail("activeKey");
        return value.activeKey;
      })();
  if (activeKey !== undefined && activeBucketId === undefined) fail("activeKey without activeBucketId");
  const keyDerivation = value.keyDerivation === undefined ? undefined : validateKeymasterSessionKeyDerivation(value.keyDerivation);
  return {
    format: KEYMASTER_SESSION_FORMAT,
    version: KEYMASTER_SESSION_VERSION,
    sessionId: value.sessionId,
    ...(activeBucketId === undefined ? {} : { activeBucketId }),
    ...(activeKey === undefined ? {} : { activeKey }),
    ...(keyDerivation === undefined ? {} : { keyDerivation }),
  };
}

/**
 * 宽容读取：坏 JSON、未知字段、格式/版本不符或 sessionId 非法 → undefined
 * （按"新浏览器"处理）；activeBucketId/activeKey/keyDerivation 非法时只丢弃
 * 对应字段，不影响其余内容。
 */
export function parseKeymasterSession(value: unknown): KeymasterSessionV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (value.format !== KEYMASTER_SESSION_FORMAT || value.version !== KEYMASTER_SESSION_VERSION) return undefined;
  if (typeof value.sessionId !== "string" || !KEYMASTER_SESSION_ID_PATTERN.test(value.sessionId)) return undefined;
  if (Object.keys(value).some((key) => !(SESSION_KEYS as readonly string[]).includes(key))) return undefined;
  const activeBucketId = typeof value.activeBucketId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.activeBucketId)
    ? value.activeBucketId
    : undefined;
  const activeKey = activeBucketId !== undefined && typeof value.activeKey === "string" && /^(02|03)[0-9a-f]{64}$/u.test(value.activeKey)
    ? value.activeKey
    : undefined;
  let keyDerivation: KeymasterSessionKeyDerivationV1 | undefined;
  if (value.keyDerivation !== undefined) {
    try {
      keyDerivation = validateKeymasterSessionKeyDerivation(value.keyDerivation);
    } catch {
      keyDerivation = undefined;
    }
  }
  return {
    format: KEYMASTER_SESSION_FORMAT,
    version: KEYMASTER_SESSION_VERSION,
    sessionId: value.sessionId,
    ...(activeBucketId === undefined ? {} : { activeBucketId }),
    ...(activeKey === undefined ? {} : { activeKey }),
    ...(keyDerivation === undefined ? {} : { keyDerivation }),
  };
}

/** 创建只带 sessionId 的空 session；id 非法时抛错。 */
export function createKeymasterSession(sessionId: string): KeymasterSessionV1 {
  if (typeof sessionId !== "string" || !KEYMASTER_SESSION_ID_PATTERN.test(sessionId)) fail("sessionId");
  return { format: KEYMASTER_SESSION_FORMAT, version: KEYMASTER_SESSION_VERSION, sessionId };
}
