import { secp256k1 } from "@noble/curves/secp256k1.js";

export class OriginValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginValidationError";
  }
}

function parseHttpUrl(input: unknown): URL {
  if (typeof input !== "string" || !input) {
    throw new OriginValidationError("url must be a non-empty string");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OriginValidationError("url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OriginValidationError("url must use http or https");
  }
  if (url.username || url.password) {
    throw new OriginValidationError("url must not contain credentials");
  }
  if (url.origin === "null" || url.origin === "") {
    throw new OriginValidationError("url has an opaque origin");
  }
  if (!url.host) {
    throw new OriginValidationError("url is invalid");
  }
  return url;
}

/** 从应用入口 URL 推导 canonical origin。 */
export function parseEntryUrl(input: unknown): { origin: string; url: string } {
  const url = parseHttpUrl(input);
  return { origin: url.origin, url: url.href };
}

/** 校验并规范化可信 origin 输入（WHATWG origin 序列化）。 */
export function canonicalOrigin(input: unknown): string {
  const url = parseHttpUrl(input);
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new OriginValidationError("origin must not contain a path");
  }
  if (url.search || url.hash) {
    throw new OriginValidationError("origin must not contain query or fragment");
  }
  return url.origin;
}

/* ============== App 公钥身份（应用发布与公钥身份） ============== */

/**
 * App 公钥是唯一稳定应用身份：有效 secp256k1 压缩公钥，小写 hex，33 字节。
 * 此处同时校验压缩格式与曲线有效性，供许可和存储绑定复用。
 * 属于钱包、交易发行人或其他业务主体的公钥不得填入该字段。
 */
export function assertAppPublicKeyHex(value: unknown, field = "appPublicKeyHex"): string {
  if (typeof value !== "string" || !/^(02|03)[0-9a-f]{64}$/.test(value)) {
    throw new OriginValidationError(`${field} must be a 33-byte compressed secp256k1 public key in lower-case hex`);
  }
  try { secp256k1.Point.fromHex(value); } catch {
    throw new OriginValidationError(`${field} must be a valid secp256k1 public key`);
  }
  return value;
}
