import { secp256k1 } from "@noble/curves/secp256k1.js";
import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CIPHER_CONTEXT_V2 as SHARED_CIPHER_CONTEXT_V2 } from "@keymaster/contracts";

/** SHA-256(bytes) -> 32 字节。 */
export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

/**
 * 断言签名为 compact 64-byte r||s 格式。
 *
 * 设计缘由（施工单 001 硬切换）：
 *   - 提取为独立函数，供 signCompactSecp256k1 及协议调用处复用。
 *   - compact 格式固定 64 字节：r(32) || s(32)。
 */
export function assertCompactSignature(sig: unknown): asserts sig is Uint8Array {
  if (!(sig instanceof Uint8Array)) {
    throw new Error("assertCompactSignature: expected Uint8Array");
  }
  if (sig.length !== 64) {
    throw new Error(`assertCompactSignature: expected 64 bytes, got ${sig.length}`);
  }
}

/**
 * secp256k1 签名：固定 compact 64-byte r||s。
 *
 * 设计缘由（施工单 001 硬切换）：
 *   - 施工单明确钉死 compact 64-byte 是 signature.bytes 的唯一格式。
 *   - 调用方必须通过 `ActiveKeyCrypto.signDigest({ ..., format: "compact" })`
 *     请求 compact 格式，本函数只做最终校验。
 *   - 不再做 DER -> compact 转换；格式应在 signer capability 请求时确定。
 */
export function signCompactSecp256k1(
  signDigest: (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>,
  message: Uint8Array
): Promise<Uint8Array> {
  const digest = sha256Bytes(message);
  return Promise.resolve(signDigest(digest)).then((sig) => {
    assertCompactSignature(sig);
    return sig;
  });
}

/** 验证 secp256k1 签名；只用于内部单测 / 调试。 */
export function verifyCompactSecp256k1(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return secp256k1.verify(signature, sha256Bytes(message), publicKey, {
    prehash: false,
    format: "compact"
  });
}

/** cipher 站点绑定的协议常量（唯一真源见 contracts，与 Go 一致）。 */
export const CIPHER_CONTEXT_V2 = SHARED_CIPHER_CONTEXT_V2;

/**
 * AES-256-GCM 加密。返回 `nonce + cipherbytes`。
 * `nonce` 是 12 字节随机值；`cipherbytes` 是 GCM 模式输出（含 tag）。
 */
export function aesGcmEncrypt(siteKey: Uint8Array, plain: Uint8Array): {
  nonce: Uint8Array;
  cipherbytes: Uint8Array;
} {
  if (siteKey.length !== 32) {
    throw new Error("siteKey must be 32 bytes");
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = gcm(siteKey, nonce);
  const cipherbytes = cipher.encrypt(plain);
  return { nonce, cipherbytes };
}

/**
 * AES-256-GCM 解密。失败统一抛 `Decrypt failed`。
 *
 * 设计缘由：origin 不匹配、nonce 错误、密文被篡改在 V1 都表现为同一种
 * 失败，不向调用方细分原因（避免泄漏"密文格式有效 / 仅 siteKey 错"
 * 这类旁路信息）。
 */
export function aesGcmDecrypt(
  siteKey: Uint8Array,
  nonce: Uint8Array,
  cipherbytes: Uint8Array
): Uint8Array {
  if (siteKey.length !== 32) {
    throw new Error("siteKey must be 32 bytes");
  }
  if (nonce.length !== 12) {
    throw new Error("Decrypt failed");
  }
  try {
    const cipher = gcm(siteKey, nonce);
    return cipher.decrypt(cipherbytes);
  } catch {
    throw new Error("Decrypt failed");
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("Invalid hex characters");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** bytes -> hex（小写）。 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * 从 32 字节 secp256k1 私钥推出压缩公钥 hex（33 字节）。
 *
 * 设计缘由（施工单 2026-06-30 002 硬切换）：`applyLauncherBootstrap`
 * 用此方法校验 launcher 交过来的 owner runtime bootstrap 私钥 hex
 * 真的对应声明的 `ownerPublicKeyHex`。
 */
export function getCompressedPubHexFromPrivHex(privHex: string): string {
  const priv = hexToBytes(privHex);
  if (priv.length !== 32) {
    throw new Error("Private key must be 32 bytes");
  }
  const pub = secp256k1.getPublicKey(priv, true);
  return bytesToHex(pub);
}
