// packages/plugin-vault/src/crypto.ts
// WebCrypto 封装：PBKDF2 派生 key + AES-GCM 加解密。
// 设计缘由：vault 完全跑在浏览器，依赖 WebCrypto；这样不引入额外依赖，避免 bundle 膨胀与审计面。

/** 启动期守卫：WebCrypto 不可用时立刻抛错，避免后续 importKey 出现 "undefined.importKey"。 */
export function assertWebCryptoAvailable(): void {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "WebCrypto (crypto.subtle) is not available. The app must be served from a secure context (HTTPS or localhost)."
    );
  }
}

/**
 * PBKDF2 派生参数（200k 迭代 + SHA-256）。
 *
 * 设计缘由（施工单 2026-06-29 001）：派生参数必须在 launcher 与
 * Session Window 之间完全一致；统一收敛在一处常量。
 */
export const PBKDF2_PARAMS = {
  iterations: 200_000,
  hash: "SHA-256"
} as const;

/** PBKDF2 派生 raw 256-bit key material。 */
export async function deriveKeyRawBits(password: string, salt: Uint8Array): Promise<Uint8Array> {
  assertWebCryptoAvailable();
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_PARAMS.iterations,
      hash: PBKDF2_PARAMS.hash
    },
    baseKey,
    256
  );
  return new Uint8Array(bits);
}

/** 从 raw 256-bit key material 导入 AES-GCM CryptoKey。 */
export async function aesGcmKeyFromRawBits(rawBits: Uint8Array): Promise<CryptoKey> {
  assertWebCryptoAvailable();
  if (rawBits.byteLength !== 32) {
    throw new Error("AES-GCM key material must be exactly 32 bytes");
  }
  return crypto.subtle.importKey(
    "raw",
    rawBits as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** 派生 AES-GCM key（用于私钥加密）。 */
export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const rawBits = await deriveKeyRawBits(password, salt);
  return aesGcmKeyFromRawBits(rawBits);
}

export interface EncryptedBlob {
  /** 16 字节随机 salt。 */
  salt: Uint8Array;
  /** 12 字节随机 IV。 */
  iv: Uint8Array;
  /** AES-GCM 密文（包含 tag）。 */
  ciphertext: Uint8Array;
  /** 版本化标识，便于调用方明确选择读取分支。 */
  version?: "v1" | "v2";
}

/** Vault v2 固定 key AAD。 */
export function vaultKeyAad(publicKeyHex: string): string {
  return `${VAULT_KEY_AAD_PREFIX}${publicKeyHex}`;
}

/** Vault v2 固定 verifier AAD。 */
export const VAULT_VERIFIER_AAD = "keymaster:v2|vault-verifier";

/** v2 引入 AAD 之前，Vault verifier 使用的固定明文标记。 */
export const LEGACY_VAULT_VERIFIER_MARKER = "vault:v1";

/** Vault v2 固定 key AAD 前缀。 */
export const VAULT_KEY_AAD_PREFIX = "keymaster:v2|vault-key|";

/** 加密任意 bytes。 */
export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<EncryptedBlob> {
  return encryptBytesWithAad(key, plaintext, undefined);
}

/** 加密任意 bytes，并显式指定 AAD。 */
export async function encryptBytesWithAad(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: string | undefined
): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Historical v1/v2 envelopes authenticate only the explicit AAD. Keep this
  // generic entry point byte-for-byte compatible; salt-bound envelopes use the
  // dedicated helpers below.
  const additionalData = aad ? new TextEncoder().encode(aad) : undefined;
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: additionalData as BufferSource | undefined
      },
      key,
      plaintext as BufferSource
    )
  );
  return { salt, iv, ciphertext, version: aad ? "v2" : "v1" };
}

/** 解密。失败抛错（密码错误、篡改都会触发）。 */
export async function decryptBytes(key: CryptoKey, blob: EncryptedBlob): Promise<Uint8Array> {
  return decryptBytesWithAad(key, blob, undefined);
}

/** 解密。失败抛错（密码错误、篡改都会触发）。 */
export async function decryptBytesWithAad(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad: string | undefined
): Promise<Uint8Array> {
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: blob.iv as BufferSource,
        additionalData: aad ? new TextEncoder().encode(aad) as BufferSource : undefined
      },
      key,
      blob.ciphertext as BufferSource
    );
    return new Uint8Array(plain);
  } catch (error) {
    // Also accept the salt-bound variant emitted by the dedicated local-secret
    // helper, so records written during the transitional implementation remain
    // readable.
    const legacyAdditionalData = saltBoundAdditionalData(aad, blob.salt);
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: blob.iv as BufferSource,
        additionalData: legacyAdditionalData as BufferSource
      },
      key,
      blob.ciphertext as BufferSource
    ).catch(() => { throw error; });
    return new Uint8Array(plain);
  }
}

/**
 * Local-secret envelope variant whose random salt is authenticated as part of
 * the encryption input. It uses an explicit entry point so plugin-owned
 * secrets can opt into the versioned local-secret AAD contract.
 */
function saltBoundAdditionalData(aad: string | undefined, salt: Uint8Array): Uint8Array {
  const prefix = aad ? new TextEncoder().encode(aad) : new Uint8Array(0);
  const output = new Uint8Array(prefix.length + 1 + salt.length);
  output.set(prefix);
  output[prefix.length] = 0;
  output.set(salt, prefix.length + 1);
  return output;
}

export async function encryptBytesWithSaltBoundAad(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: string | undefined
): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: saltBoundAdditionalData(aad, salt) as BufferSource },
    key,
    plaintext as BufferSource
  ));
  return { salt, iv, ciphertext, version: "v2" };
}

export async function decryptBytesWithSaltBoundAad(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad: string | undefined
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.iv as BufferSource, additionalData: saltBoundAdditionalData(aad, blob.salt) as BufferSource },
    key,
    blob.ciphertext as BufferSource
  );
  return new Uint8Array(plaintext);
}

/** 便捷：hex 字符串 <-> bytes。 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 旧版 Vault 曾按字段名把二进制材料实际编码成 base64，而当前格式使用
 * hex。这个转换只用于读取旧持久化记录；所有新写入仍统一走 bytesToHex。
 */
export function base64ToBytes(value: string): Uint8Array {
  // 兼容旧版 standard base64，也接受曾被导出的 URL-safe base64。
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized || /[^A-Za-z0-9+/=]/.test(normalized)) {
    throw new Error("Invalid base64");
  }
  const unpadded = normalized.replace(/=+$/, "");
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  if (padded.length % 4 !== 0) throw new Error("Invalid base64 length");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invalid base64");
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** 验证密码：保存一份 verifier，密码错误时 verifier 也对不上。 */
export async function encryptVerifier(key: CryptoKey): Promise<EncryptedBlob> {
  const marker = new TextEncoder().encode(VAULT_VERIFIER_AAD);
  return encryptBytesWithAad(key, marker, VAULT_VERIFIER_AAD);
}

export async function verifyVerifier(key: CryptoKey, blob: EncryptedBlob): Promise<boolean> {
  try {
    const plain = await decryptBytesWithAad(key, blob, VAULT_VERIFIER_AAD);
    return new TextDecoder().decode(plain) === VAULT_VERIFIER_AAD;
  } catch {
    return false;
  }
}

/**
 * 校验 v1 Vault verifier。
 *
 * v1 没有 additionalData，且明文标记是 `vault:v1`；不能用 v2 verifier
 * 的 AAD 路径读取。仅用于解锁时迁移，任何新写入始终使用 encryptVerifier。
 */
export async function verifyLegacyVerifier(key: CryptoKey, blob: EncryptedBlob): Promise<boolean> {
  try {
    const plain = await decryptBytes(key, blob);
    return new TextDecoder().decode(plain) === LEGACY_VAULT_VERIFIER_MARKER;
  } catch {
    return false;
  }
}
