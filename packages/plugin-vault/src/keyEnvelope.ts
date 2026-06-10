// packages/plugin-vault/src/keyEnvelope.ts
// bsv8 key envelope 加密工具（导出时使用）。
// 设计缘由：导出格式必须与 bsv8 生态一致 —— 加密 JSON
// （Argon2id KDF + XChaCha20-Poly1305 AEAD），不能使用 Keymaster 私有格式，
// 也不能提供明文 hex / WIF 导出。
//
// 该模块不访问 IndexedDB、不持有 React 状态、不保存密码、不处理文件下载：
// 边界由 vaultService 持有，它负责把 withPrivateKey 借出的明文传入这里。

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { getPublicKey } from "@noble/secp256k1";
import type { KeyExportEnvelope } from "@keymaster/contracts";

/** 默认 AAD，与 bsv8 兼容。 */
export const DEFAULT_AAD = "bitfs-keyring|client|default";

/** Argon2id KDF 参数（与 bsv8 保持一致）。 */
const KDF_PARAMS = {
  memoryKib: 65536,
  timeCost: 3,
  parallelism: 4,
  dkLen: 32
} as const;

/** secp256k1 阶 n（big-endian），用于私钥范围校验。 */
const SECP256K1_N_HEX =
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

/** secp256k1 阶 n 的 32 字节 big-endian 表示。 */
const SECP256K1_N_BYTES: Uint8Array = (() => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(SECP256K1_N_HEX.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
})();

/**
 * 把 32 字节 secp256k1 私钥加密为 bsv8 envelope。
 * 流程：Argon2id 派生 32 字节 key -> XChaCha20-Poly1305 加密 32 字节私钥
 *       -> 写 compressed pubkey_hex 便于 bsv8 导入 API 直接使用。
 */
export function encryptBsv8KeyEnvelope(privateKeyHex: string, password: string): KeyExportEnvelope {
  if (!privateKeyHex) throw new Error("Private key is required");
  if (!password) throw new Error("Backup password is required");
  const priv = normalizeHex(privateKeyHex, 32, "private key");
  if (!isLikelySecp256k1Priv(priv)) throw new Error("Invalid secp256k1 private key");

  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const aad = DEFAULT_AAD;

  // Argon2id 必须限制最大内存；noble 自身在超限时抛错，我们额外做参数守卫。
  // noble 内部 memused = 4*p*floor(m/4p) * 256 字节，maxmem 必须 ≥ memused。
  const key = argon2id(password, salt, {
    m: KDF_PARAMS.memoryKib,
    t: KDF_PARAMS.timeCost,
    p: KDF_PARAMS.parallelism,
    dkLen: KDF_PARAMS.dkLen,
    maxmem: 1024 * 1024 * 1024 // 1 GiB —— 足够覆盖我们设定的内存上限
  });
  const cipher = xchacha20poly1305(key, nonce, new TextEncoder().encode(aad));
  const ciphertext = cipher.encrypt(priv);

  const pub = getPublicKey(priv, true);
  return {
    pubkey_hex: bytesToHex(pub),
    version: "kek-v1",
    key_id: "default",
    kdf: "argon2id",
    kdf_params: {
      memory_kib: KDF_PARAMS.memoryKib,
      time_cost: KDF_PARAMS.timeCost,
      parallelism: KDF_PARAMS.parallelism,
      salt_hex: bytesToHex(salt)
    },
    cipher: "xchacha20poly1305",
    nonce_hex: bytesToHex(nonce),
    ciphertext_hex: bytesToHex(ciphertext),
    aad,
    created_at_unix: Math.floor(Date.now() / 1000)
  };
}

/** 暴露给测试/校验使用。 */
export const envelopeCrypto = {
  KDF_PARAMS,
  DEFAULT_AAD,
  SECP256K1_N_HEX
} as const;

// ---------- helpers ----------

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

function normalizeHex(value: string, expectedBytes: number, label: string): Uint8Array {
  const clean = value.replace(/^0x/, "").trim().toLowerCase();
  if (clean.length !== expectedBytes * 2) {
    throw new Error(`${label} must be ${expectedBytes} bytes hex`);
  }
  if (!/^[0-9a-f]+$/.test(clean)) throw new Error(`${label} contains non-hex characters`);
  const out = new Uint8Array(expectedBytes);
  for (let i = 0; i < expectedBytes; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function isLikelySecp256k1Priv(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  // 拒绝全 0：私钥不能为 0。
  let allZero = true;
  for (const b of bytes) {
    if (b !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) return false;
  // big-endian 与 secp256k1 阶 n 比较：必须严格小于 n。
  // key === n 和 key > n 都必须拒绝（n 是无效私钥）。
  return compareBytes(bytes, SECP256K1_N_BYTES) < 0;
}

/** big-endian 字节串比较：-1 表示 a < b, 0 表示 a === b, 1 表示 a > b。 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  if (a.length < b.length) return -1;
  if (a.length > b.length) return 1;
  return 0;
}
