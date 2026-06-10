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

/** 派生 AES-GCM key（用于私钥加密）。 */
export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  assertWebCryptoAvailable();
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 200_000,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export interface EncryptedBlob {
  /** 16 字节随机 salt。 */
  salt: Uint8Array;
  /** 12 字节随机 IV。 */
  iv: Uint8Array;
  /** AES-GCM 密文（包含 tag）。 */
  ciphertext: Uint8Array;
}

/** 加密任意 bytes。 */
export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      plaintext as BufferSource
    )
  );
  return { salt, iv, ciphertext };
}

/** 解密。失败抛错（密码错误、篡改都会触发）。 */
export async function decryptBytes(key: CryptoKey, blob: EncryptedBlob): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.iv as BufferSource },
    key,
    blob.ciphertext as BufferSource
  );
  return new Uint8Array(plain);
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

/** 验证密码：保存一份 verifier，密码错误时 verifier 也对不上。 */
export async function encryptVerifier(key: CryptoKey): Promise<EncryptedBlob> {
  const marker = new TextEncoder().encode("vault:v1");
  return encryptBytes(key, marker);
}

export async function verifyVerifier(key: CryptoKey, blob: EncryptedBlob): Promise<boolean> {
  try {
    const plain = await decryptBytes(key, blob);
    return new TextDecoder().decode(plain) === "vault:v1";
  } catch {
    return false;
  }
}
