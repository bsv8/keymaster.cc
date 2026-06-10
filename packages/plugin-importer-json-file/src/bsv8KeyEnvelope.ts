// packages/plugin-importer-json-file/src/bsv8KeyEnvelope.ts
// bsv8 key envelope 解密工具（导入时使用）。
// 设计缘由：bsv8 envelope 是加密 JSON；它必须真的解密出 32 字节私钥材料，
// 不能只识别字段后假装支持，也不能被误判为普通 JSON 私钥字段。
// 该模块不写 Vault、不弹 UI、不读取文件 —— 只负责解析 + 解密。

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2id } from "@noble/hashes/argon2.js";

/** 与 bsv8 当前默认 AAD。 */
const PRIMARY_AAD = "bitfs-keyring|client|default";

/** 历史 envelope 兼容默认 AAD 列表（按顺序尝试）。 */
const FALLBACK_AADS = [
  "bitfs-keyring|client|default",
  "bitfs-keyring|bitfs|default|kek-v1",
  "bitfs-keyring|gateway|default|kek-v1"
] as const;

/** secp256k1 阶 n（big-endian），用于私钥范围校验。 */
const SECP256K1_N_HEX =
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

/** KDF 参数上限：避免恶意文件让浏览器卡死。 */
const KDF_LIMITS = {
  memoryKib: 262144,
  timeCost: 8,
  parallelism: 8
} as const;

/** 探测某个 JSON 对象是否像 bsv8 envelope。 */
export function isBsv8KeyEnvelope(obj: unknown): obj is Bsv8EnvelopeShape {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    o["version"] === "kek-v1" &&
    o["kdf"] === "argon2id" &&
    o["cipher"] === "xchacha20poly1305" &&
    typeof o["kdf_params"] === "object" &&
    o["kdf_params"] !== null &&
    typeof o["ciphertext_hex"] === "string" &&
    typeof o["nonce_hex"] === "string"
  );
}

/** bsv8 envelope 必填字段类型。 */
export interface Bsv8EnvelopeShape {
  version: "kek-v1";
  key_id: "default";
  kdf: "argon2id";
  kdf_params: {
    memory_kib: number;
    time_cost: number;
    parallelism: number;
    salt_hex: string;
  };
  cipher: "xchacha20poly1305";
  nonce_hex: string;
  ciphertext_hex: string;
  aad?: string;
  pubkey_hex?: string;
  created_at_unix?: number;
}

/**
 * 用用户提供的备份密码解密 bsv8 envelope，返回 32 字节 hex 私钥（小写）。
 * 失败抛错（密码错误、AAD 不匹配、字段缺失都视作解析失败）。
 */
export function decryptBsv8KeyEnvelope(input: { envelope: Bsv8EnvelopeShape; password: string }): string {
  const { envelope, password } = input;
  if (!password) {
    throw new Error("Password is required for encrypted key file");
  }
  validateKdfParams(envelope);
  const salt = hexToBytes(envelope.kdf_params.salt_hex, "salt_hex");
  const nonce = hexToBytes(envelope.nonce_hex, "nonce_hex", 24);
  const ciphertext = hexToBytes(envelope.ciphertext_hex, "ciphertext_hex");

  const key = argon2id(password, salt, {
    m: envelope.kdf_params.memory_kib,
    t: envelope.kdf_params.time_cost,
    p: envelope.kdf_params.parallelism,
    dkLen: 32,
    maxmem: 1024 * 1024 * 1024 // 1 GiB —— 足够覆盖 KDF_LIMITS
  });

  // 文件内显式 AAD 总是优先；缺少 aad 时按 bsv8 兼容默认 AAD 列表尝试。
  // 全部失败抛统一错误，不向用户暴露尝试列表。
  const triedAads: string[] = envelope.aad ? [envelope.aad] : [...FALLBACK_AADS];
  for (const aad of triedAads) {
    const plain = tryDecrypt(ciphertext, key, nonce, aad);
    if (plain) return bytesToHex(plain);
  }
  throw new Error("Invalid password or corrupted key material");
}

function tryDecrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: string
): Uint8Array | null {
  try {
    const cipher = xchacha20poly1305(key, nonce, new TextEncoder().encode(aad));
    const plain = cipher.decrypt(ciphertext);
    if (plain.length !== 32) return null;
    if (!isLikelySecp256k1Priv(plain)) return null;
    return plain;
  } catch {
    return null;
  }
}

function validateKdfParams(env: Bsv8EnvelopeShape): void {
  const p = env.kdf_params;
  if (!p || typeof p !== "object") throw new Error("Missing kdf_params");
  if (typeof p.memory_kib !== "number" || p.memory_kib <= 0) {
    throw new Error("Unsupported key kdf params");
  }
  if (typeof p.time_cost !== "number" || p.time_cost <= 0) {
    throw new Error("Unsupported key kdf params");
  }
  if (typeof p.parallelism !== "number" || p.parallelism <= 0) {
    throw new Error("Unsupported key kdf params");
  }
  if (p.memory_kib > KDF_LIMITS.memoryKib) throw new Error("Unsupported key kdf params");
  if (p.time_cost > KDF_LIMITS.timeCost) throw new Error("Unsupported key kdf params");
  if (p.parallelism > KDF_LIMITS.parallelism) throw new Error("Unsupported key kdf params");
}

// ---------- helpers ----------

function hexToBytes(hex: string, field: string, expectedLen?: number): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) throw new Error(`Invalid hex length for ${field}`);
  if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error(`Invalid hex characters in ${field}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  if (expectedLen !== undefined && out.length !== expectedLen) {
    throw new Error(`Field ${field} must be ${expectedLen} bytes`);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
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

/** secp256k1 阶 n 的 32 字节 big-endian 表示。 */
const SECP256K1_N_BYTES: Uint8Array = (() => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(SECP256K1_N_HEX.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
})();
