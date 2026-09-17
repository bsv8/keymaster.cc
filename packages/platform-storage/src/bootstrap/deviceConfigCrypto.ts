// 设备桶记录的 S3 凭据加密（keymaster.device.v1）。
//
// 与 KeyHold 完全一致的密码学：PBKDF2-HMAC-SHA-256 输出 32 字节直接作为
// AES-256-GCM key，不使用 AAD；KDF 参数由浏览器 session 提供（一个浏览器
// 一把启动密码，所有 s3 桶共用同一把派生 key）。

import { gcm } from "@noble/ciphers/aes.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { DeviceCipherV1, DeviceConfigPlaintextV1, DeviceLocationV1, KeymasterSessionKeyDerivationV1 } from "@keymaster/contracts";
import {
  DEVICE_LIMITS,
  encodeBase64Url,
  validateDeviceCipher,
  validateDeviceConfigPlaintext,
  validateDeviceLocation,
} from "@keymaster/contracts";

/** S3 公开坐标（不含凭据）。 */
export type DeviceS3LocationV1 = Extract<DeviceLocationV1, { providerId: "s3" }>;

function fail(message: string): never {
  throw new TypeError(`Device config ${message}`);
}

function decodeBase64Url(value: string, field: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) fail(`${field} is invalid`);
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  let binary: string;
  try {
    binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  } catch {
    fail(`${field} is invalid`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (encodeBase64Url(bytes) !== value) fail(`${field} is not canonical`);
  return bytes;
}

function checkPassword(password: string): Uint8Array {
  if (typeof password !== "string" || password.length === 0) fail("password is invalid");
  if (!/^[\s\S]*$/u.test(password)) fail("password is invalid");
  const bytes = new TextEncoder().encode(password);
  if (bytes.byteLength > 1_024) fail("password is too long");
  return bytes;
}

function checkLocation(value: unknown): DeviceS3LocationV1 {
  const location = validateDeviceLocation(value);
  if (location.providerId !== "s3") fail("location must be s3");
  return location;
}

function checkDerivation(value: unknown): KeymasterSessionKeyDerivationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("keyDerivation is invalid");
  const record = value as Record<string, unknown>;
  if (record.algorithm !== "pbkdf2-hmac-sha-256" || record.passwordEncoding !== "utf-8" || record.outputLengthBits !== 256) fail("keyDerivation is invalid");
  const iterations = record.iterations;
  if (typeof iterations !== "number" || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 2_147_483_647) fail("keyDerivation iterations is invalid");
  if (typeof record.saltB64Url !== "string") fail("keyDerivation salt is invalid");
  if (decodeBase64Url(record.saltB64Url, "keyDerivation.saltB64Url").byteLength !== 16) fail("keyDerivation salt is invalid");
  return { algorithm: "pbkdf2-hmac-sha-256", passwordEncoding: "utf-8", iterations, outputLengthBits: 256, saltB64Url: record.saltB64Url };
}

function assertLocationMatchesPlaintext(location: DeviceS3LocationV1, plaintext: DeviceConfigPlaintextV1): void {
  if (location.endpoint !== plaintext.endpoint || location.region !== plaintext.region || location.bucket !== plaintext.bucket
    || location.prefix !== plaintext.prefix || location.forcePathStyle !== plaintext.forcePathStyle) {
    fail("plaintext location does not match public location");
  }
}

/** 用启动密码与 session KDF 加密一条 S3 凭据；密码和明文只在本调用内存中存在。 */
export async function encryptDeviceConfig(input: {
  password: string;
  keyDerivation: KeymasterSessionKeyDerivationV1;
  location: DeviceS3LocationV1;
  plaintext: DeviceConfigPlaintextV1;
}): Promise<DeviceCipherV1> {
  const location = checkLocation(input.location);
  const keyDerivation = checkDerivation(input.keyDerivation);
  const plaintext = validateDeviceConfigPlaintext(input.plaintext);
  assertLocationMatchesPlaintext(location, plaintext);
  const salt = decodeBase64Url(keyDerivation.saltB64Url, "keyDerivation.saltB64Url");
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const passwordBytes = checkPassword(input.password);
  let key: Uint8Array | undefined;
  let plaintextBytes: Uint8Array | undefined;
  let ciphertextAndTag: Uint8Array | undefined;
  try {
    key = await pbkdf2Async(sha256, passwordBytes, salt, { c: keyDerivation.iterations, dkLen: 32 });
    plaintextBytes = new TextEncoder().encode(JSON.stringify(plaintext));
    if (plaintextBytes.byteLength > DEVICE_LIMITS.maxConfigPlaintextBytes) fail("plaintext is too large");
    ciphertextAndTag = gcm(key, iv).encrypt(plaintextBytes);
    return {
      algorithm: "aes-gcm",
      keyLengthBits: 256,
      ivB64Url: encodeBase64Url(iv),
      tagLengthBits: 128,
      ciphertextAndTagB64Url: encodeBase64Url(ciphertextAndTag),
    };
  } finally {
    passwordBytes.fill(0);
    key?.fill(0);
    salt.fill(0);
    iv.fill(0);
    plaintextBytes?.fill(0);
    ciphertextAndTag?.fill(0);
  }
}

/** 解密并严格校验一条 S3 凭据；认证失败、白名单违规或坐标不符统一抛错。 */
export async function decryptDeviceConfig(input: {
  password: string;
  keyDerivation: KeymasterSessionKeyDerivationV1;
  location: DeviceS3LocationV1;
  cipher: DeviceCipherV1;
}): Promise<DeviceConfigPlaintextV1> {
  const location = checkLocation(input.location);
  const keyDerivation = checkDerivation(input.keyDerivation);
  const cipher = validateDeviceCipher(input.cipher);
  const salt = decodeBase64Url(keyDerivation.saltB64Url, "keyDerivation.saltB64Url");
  const iv = decodeBase64Url(cipher.ivB64Url, "cipher.ivB64Url");
  const ciphertextAndTag = decodeBase64Url(cipher.ciphertextAndTagB64Url, "cipher.ciphertextAndTagB64Url");
  const passwordBytes = checkPassword(input.password);
  let key: Uint8Array | undefined;
  let plaintextBytes: Uint8Array | undefined;
  try {
    key = await pbkdf2Async(sha256, passwordBytes, salt, { c: keyDerivation.iterations, dkLen: 32 });
    plaintextBytes = gcm(key, iv).decrypt(ciphertextAndTag);
  } finally {
    passwordBytes.fill(0);
    key?.fill(0);
    salt.fill(0);
    iv.fill(0);
    ciphertextAndTag.fill(0);
  }
  if (plaintextBytes.byteLength > DEVICE_LIMITS.maxConfigPlaintextBytes) {
    plaintextBytes.fill(0);
    fail("plaintext is too large");
  }
  try {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintextBytes)) as unknown;
    } catch {
      fail("plaintext is invalid");
    }
    const plaintext = validateDeviceConfigPlaintext(value);
    assertLocationMatchesPlaintext(location, plaintext);
    return plaintext;
  } finally {
    plaintextBytes.fill(0);
  }
}
