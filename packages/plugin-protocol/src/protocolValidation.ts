// packages/plugin-protocol/src/protocolValidation.ts
// 协议层校验：顶层 message 结构 / BinaryField 形状 / aud / iat / exp。
//
// 设计缘由（施工单 001）：
//   - 校验与业务执行分离：service 只调用这里抛错 / 返回值的接口。
//   - 校验失败全部映射为 ProtocolError，方便 service 直接组装 result。
//   - 不允许把"已经经过一轮校验的 request"再做一次隐式归一化。
//   - `aud` 严格按字节比较；不补默认端口、不 lower host、不改协议。
//   - 二进制字段必须含 `$type: "binary"` + ArrayBuffer；缺 mime 也接受。

import type {
  BinaryField,
  CipherDecryptParams,
  CipherEncryptParams,
  IdentityGetParams,
  IntentSignParams,
  MethodParams,
  ProtocolErrorCode,
  ProtocolMethod,
  ProtocolRequestMessage
} from "@keymaster/contracts";
import { PROTOCOL_METHODS, PROTOCOL_VERSION } from "@keymaster/contracts";

/** 校验失败：抛出的对象。service 会捕获并组装 ProtocolError。 */
export class ProtocolValidationError extends Error {
  readonly code: ProtocolErrorCode;
  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ProtocolValidationError";
  }
}

/**
 * 校验顶层 message 形状。返回 { id, method, params } 或抛错。
 *
 * 不接受非对象 / 缺字段 / method 不在 PROTOCOL_METHODS 内 / 缺 v/version 不对。
 */
export function parseRequestMessage(
  raw: unknown
): { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> } {
  if (!isPlainObject(raw)) {
    throw new ProtocolValidationError("invalid_request", "Request must be a plain object");
  }
  if (raw.v !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError("invalid_request", "Unsupported protocol version");
  }
  if (raw.type !== "request") {
    throw new ProtocolValidationError("invalid_request", "Message type must be 'request'");
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new ProtocolValidationError("invalid_request", "Request id is required");
  }
  if (typeof raw.method !== "string" || !PROTOCOL_METHODS.includes(raw.method as ProtocolMethod)) {
    throw new ProtocolValidationError("invalid_request", "Unknown method");
  }
  const method = raw.method as ProtocolMethod;
  const params = validateParams(method, raw.params, raw.id);
  return { id: raw.id, method, params };
}

/** 校验单个 method 的 params。抛 ProtocolValidationError。 */
function validateParams(
  method: ProtocolMethod,
  raw: unknown,
  _id: string
): MethodParams<ProtocolMethod> {
  switch (method) {
    case "identity.get":
      return validateIdentityGetParams(raw);
    case "intent.sign":
      return validateIntentSignParams(raw);
    case "cipher.encrypt":
      return validateCipherEncryptParams(raw);
    case "cipher.decrypt":
      return validateCipherDecryptParams(raw);
  }
}

function validateIdentityGetParams(raw: unknown): IdentityGetParams {
  const obj = expectObject(raw, "identity.get params");
  const aud = expectString(obj.aud, "aud");
  const iat = expectInteger(obj.iat, "iat");
  const exp = expectInteger(obj.exp, "exp");
  const text = expectString(obj.text, "text");
  if (exp <= iat) {
    throw new ProtocolValidationError("invalid_request", "exp must be greater than iat");
  }
  if (obj.claims !== undefined) {
    if (!Array.isArray(obj.claims)) {
      throw new ProtocolValidationError("invalid_request", "claims must be an array of strings");
    }
    for (const c of obj.claims) {
      if (typeof c !== "string") {
        throw new ProtocolValidationError("invalid_request", "claims entries must be strings");
      }
    }
  }
  return { aud, iat, exp, text, claims: obj.claims as string[] | undefined };
}

function validateIntentSignParams(raw: unknown): IntentSignParams {
  const obj = expectObject(raw, "intent.sign params");
  const aud = expectString(obj.aud, "aud");
  const iat = expectInteger(obj.iat, "iat");
  const exp = expectInteger(obj.exp, "exp");
  const text = expectString(obj.text, "text");
  const contentType = expectString(obj.contentType, "contentType");
  if (exp <= iat) {
    throw new ProtocolValidationError("invalid_request", "exp must be greater than iat");
  }
  const content = parseBinaryField(obj.content, "content");
  return { aud, iat, exp, text, contentType, content };
}

function validateCipherEncryptParams(raw: unknown): CipherEncryptParams {
  const obj = expectObject(raw, "cipher.encrypt params");
  const text = expectString(obj.text, "text");
  const contentType = expectString(obj.contentType, "contentType");
  const content = parseBinaryField(obj.content, "content");
  return { text, contentType, content };
}

function validateCipherDecryptParams(raw: unknown): CipherDecryptParams {
  const obj = expectObject(raw, "cipher.decrypt params");
  const text = expectString(obj.text, "text");
  const nonce = parseBinaryField(obj.nonce, "nonce");
  const cipherbytes = parseBinaryField(obj.cipherbytes, "cipherbytes");
  return { text, nonce, cipherbytes };
}

/** 严格比较 `aud` 与 `event.origin`；不补端口 / 不 lower host。 */
export function assertOriginMatches(aud: string, eventOrigin: string): void {
  if (aud !== eventOrigin) {
    throw new ProtocolValidationError("invalid_origin", "aud does not match event origin");
  }
}

/* ============== helpers ============== */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectObject(v: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(v)) {
    throw new ProtocolValidationError("invalid_request", `${name} must be an object`);
  }
  return v;
}

function expectString(v: unknown, name: string): string {
  if (typeof v !== "string") {
    throw new ProtocolValidationError("invalid_request", `${name} must be a string`);
  }
  return v;
}

function expectInteger(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ProtocolValidationError("invalid_request", `${name} must be an integer`);
  }
  return v;
}

function parseBinaryField(v: unknown, name: string): BinaryField {
  if (!isPlainObject(v)) {
    throw new ProtocolValidationError("invalid_request", `${name} must be a BinaryField object`);
  }
  if (v.$type !== "binary") {
    throw new ProtocolValidationError("invalid_request", `${name} must have $type="binary"`);
  }
  if (!(v.bytes instanceof ArrayBuffer)) {
    throw new ProtocolValidationError("invalid_request", `${name}.bytes must be ArrayBuffer`);
  }
  if (v.mime !== undefined && typeof v.mime !== "string") {
    throw new ProtocolValidationError("invalid_request", `${name}.mime must be string when present`);
  }
  return { $type: "binary", bytes: v.bytes, mime: v.mime as string | undefined };
}

/** 顶层 message 形状的"只看是不是已绑定 source 会话能接受的 request"。 */
export function isStructuredCloneRequestCandidate(v: unknown): v is ProtocolRequestMessage {
  if (!isPlainObject(v)) return false;
  if (v.v !== PROTOCOL_VERSION) return false;
  if (v.type !== "request") return false;
  if (typeof v.id !== "string") return false;
  if (typeof v.method !== "string") return false;
  return true;
}
