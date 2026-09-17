// 桶内单 Key 文件 `keys/<公钥>.keyhold` 的契约。
//
// 一个文件只描述一把 Key，不再存在 `keymaster/keys.json` 容器、Key 列表
// 索引或整档 HMAC。每个文件都有自己的密码和 KDF；桶参数由
// device-bootstrap 独立保存，不能把两种密码混成一个密码域。

/** KeyHold v1 的公开 PBKDF2 参数。 */
export interface KeyHoldKeyDerivationV1 {
  /** 固定算法：PBKDF2-HMAC-SHA-256。 */
  algorithm: "pbkdf2-hmac-sha-256";
  /** 固定密码编码：UTF-8。 */
  passwordEncoding: "utf-8";
  /** PBKDF2 迭代次数。 */
  iterations: number;
  /** 固定派生输出长度：256 位。 */
  outputLengthBits: 256;
  /** 16 字节随机盐的无填充 Base64URL 编码。 */
  saltB64Url: string;
}

/** KeyHold v1 的 AES-256-GCM 密文封装。 */
export interface KeyHoldCipherV1 {
  /** 固定加密算法：AES-GCM。 */
  algorithm: "aes-gcm";
  /** 固定密钥长度：256 位。 */
  keyLengthBits: 256;
  /** 12 字节随机 IV 的无填充 Base64URL 编码。 */
  ivB64Url: string;
  /** 固定 GCM 标签长度：128 位。 */
  tagLengthBits: 128;
  /** 32 字节私钥密文和认证标签的无填充 Base64URL 编码。 */
  ciphertextAndTagB64Url: string;
}

/** `keys/<公钥>.keyhold` 的完整文件结构。 */
export interface KeyHoldDocumentV1 {
  /** 固定文件格式标识；不要写成 keymaster-hold。 */
  format: "keyhold";
  /** 固定文件格式版本。 */
  version: 1;
  /** UI 显示标签；不参与文件名计算。 */
  label: string;
  /** 小写压缩 secp256k1 公钥 hex；必须和文件名一致。 */
  publicKeyHex: string;
  /** 该 Key 独立的密码派生参数。 */
  keyDerivation: KeyHoldKeyDerivationV1;
  /** 该 Key 独立的私钥密文。 */
  cipher: KeyHoldCipherV1;
}

/** KeyHold v1 的资源限制。 */
export const KEYHOLD_LIMITS = Object.freeze({
  /** label 最大 UTF-8 字节数。 */
  maxLabelBytes: 1_024,
  /** 单个 KeyHold 文件最大 UTF-8 字节数。 */
  maxSerializedBytes: 16 * 1024 * 1024,
});

/** 便于代码中按文档大小写书写的别名。 */
export type KeymasterKeyHoldDocumentV1 = KeyHoldDocumentV1;
export type KeymasterKeyHoldKeyDerivationV1 = KeyHoldKeyDerivationV1;
export type KeymasterKeyHoldCipherV1 = KeyHoldCipherV1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fail(field: string): never {
  throw new TypeError(`KeyHold ${field} is invalid`);
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !allowed.has(key))) fail(`${field} fields`);
}

function text(value: unknown, field: string, maxBytes: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > maxBytes || (pattern !== undefined && !pattern.test(value))) {
    fail(field);
  }
  return value;
}

function base64Url(value: unknown, field: string, expectedBytes?: number): string {
  const encoded = text(value, field, 65_552);
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
  const canonical = btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  if (canonical !== encoded || (expectedBytes !== undefined && bytes.byteLength !== expectedBytes)) fail(field);
  return encoded;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(field);
  return value;
}

function validateKeyDerivation(value: unknown): KeyHoldKeyDerivationV1 {
  if (!isRecord(value)) fail("keyDerivation");
  exact(value, ["algorithm", "iterations", "outputLengthBits", "passwordEncoding", "saltB64Url"], "keyDerivation");
  if (value.algorithm !== "pbkdf2-hmac-sha-256" || value.passwordEncoding !== "utf-8" || value.outputLengthBits !== 256) fail("keyDerivation algorithm");
  const iterations = integer(value.iterations, "keyDerivation.iterations", 1, 2_147_483_647);
  const saltB64Url = base64Url(value.saltB64Url, "keyDerivation.saltB64Url", 16);
  return { algorithm: "pbkdf2-hmac-sha-256", passwordEncoding: "utf-8", iterations, outputLengthBits: 256, saltB64Url };
}

function validateCipher(value: unknown): KeyHoldCipherV1 {
  if (!isRecord(value)) fail("cipher");
  exact(value, ["algorithm", "ciphertextAndTagB64Url", "ivB64Url", "keyLengthBits", "tagLengthBits"], "cipher");
  if (value.algorithm !== "aes-gcm" || value.keyLengthBits !== 256 || value.tagLengthBits !== 128) fail("cipher algorithm");
  const ivB64Url = base64Url(value.ivB64Url, "cipher.ivB64Url", 12);
  const ciphertextAndTagB64Url = base64Url(value.ciphertextAndTagB64Url, "cipher.ciphertextAndTagB64Url", 48);
  return { algorithm: "aes-gcm", keyLengthBits: 256, ivB64Url, tagLengthBits: 128, ciphertextAndTagB64Url };
}

/** 校验并复制一份 KeyHold 文档；密码认证由平台适配层完成。 */
export function validateKeyHoldDocument(value: unknown): KeyHoldDocumentV1 {
  if (!isRecord(value)) fail("document");
  exact(value, ["cipher", "format", "keyDerivation", "label", "publicKeyHex", "version"], "document");
  if (value.format !== "keyhold" || value.version !== 1) fail("format");
  const label = text(value.label, "label", KEYHOLD_LIMITS.maxLabelBytes);
  const publicKeyHex = text(value.publicKeyHex, "publicKeyHex", 66, /^(02|03)[0-9a-f]{64}$/u);
  const keyDerivation = validateKeyDerivation(value.keyDerivation);
  const cipher = validateCipher(value.cipher);
  const document: KeyHoldDocumentV1 = { format: "keyhold", version: 1, label, publicKeyHex, keyDerivation, cipher };
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > KEYHOLD_LIMITS.maxSerializedBytes) fail("document size");
  return document;
}

/** 与 `validateKeyHoldDocument` 同义的文档名写法。 */
export const validateKeyholdDocument = validateKeyHoldDocument;
