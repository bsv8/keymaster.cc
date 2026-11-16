import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

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

/** 应用稳定归属根：<network>/<walletPublicKeyLower>/<appPublicKeyHex>/files/ */
export function appStorageRoot(network: string, walletPublicKeyHex: string, appPublicKeyHex: string): string {
  if (network !== "main" && network !== "test") {
    throw new OriginValidationError("network must be main or test");
  }
  if (!/^(02|03)[0-9a-f]{64}$/iu.test(walletPublicKeyHex)) {
    throw new OriginValidationError("wallet public key is invalid");
  }
  assertAppPublicKeyHex(appPublicKeyHex);
  return `${network}/${walletPublicKeyHex.toLowerCase()}/${appPublicKeyHex}/files/`;
}

/** App 级加密 scope：storage.encrypted-file.v1|<sha256hex(root + path)> */
export function appStorageScope(root: string, path: string): string {
  if (!root || !path) throw new OriginValidationError("storage root/path is invalid");
  const digest = sha256(new TextEncoder().encode(root + path));
  return `storage.encrypted-file.v1|${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 从已验证 App 公钥派生三方 App 的稳定 moduleId。
 * 域与 origin 版（v1）分离；同一公钥在不同设备一致，不残留 origin 或 App ID。
 */
export function deriveAppStorageModuleId(appPublicKeyHex: string): string {
  const app = assertAppPublicKeyHex(appPublicKeyHex);
  const bytes = new TextEncoder().encode(`keymaster.storage-module.v2\u0000${app}`);
  const digest = sha256(bytes);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
