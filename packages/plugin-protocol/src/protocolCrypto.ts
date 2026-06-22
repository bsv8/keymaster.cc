// packages/plugin-protocol/src/protocolCrypto.ts
// 协议相关密码学 helper。
//
// 设计缘由（施工单 001）：
//   - 协议层需要的密码学原语都收敛在文件里：
//       sha256
//       signCompactSecp256k1 （compact 64-byte r||s）
//       deriveSiteKey         （HMAC-SHA256(privateKeySecret, "keymaster:cipher:v1|"+exactOrigin)）
//       aesGcmEncrypt / aesGcmDecrypt
//   - cipher 的站点绑定不依赖 `aud` 参数，**只**从 event.origin 原样参与派生。
//   - `AES-GCM` 固定 12 字节随机 nonce。
//   - 解密失败统一抛英文错误（"Decrypt failed"），不区分 origin / nonce / 密文。
//   - 这里不依赖 vault 的"密码加密私钥"逻辑；cipher 的职责和 vault 不同。

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** SHA-256(bytes) -> 32 字节。 */
export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

/**
 * secp256k1 签名：固定 compact 64-byte r||s。
 *
 * 设计缘由（施工单 001 + 协议 J）：
 *   - 施工单明确钉死 compact 64-byte 是 signature.bytes 的唯一格式。
 *   - 用 noble 默认 ECDSA（lowS=true / prehash=true），与现有 P2PKH
 *     路径行为一致；不切换 DER / Schnorr。
 */
export function signCompactSecp256k1(
  privateKeyHex: string,
  message: Uint8Array
): Uint8Array {
  const priv = hexToBytes(privateKeyHex);
  if (priv.length !== 32) {
    throw new Error("Private key must be 32 bytes");
  }
  // noble 的 secp256k1.sign 默认 prehash=true；我们输入的就是
  // "已经准备好的真值字节"，不应当再被 prehash 一次。
  // 施工单要求"对 envelope 真值字节直接签名"，所以这里显式
  // prehash=false，避免双重 SHA-256。
  const sig = secp256k1.sign(message, priv, { prehash: false, format: "compact" });
  if (sig.length !== 64) {
    throw new Error("Compact signature must be 64 bytes");
  }
  return sig;
}

/** 验证 secp256k1 签名；只用于内部单测 / 调试。 */
export function verifyCompactSecp256k1(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return secp256k1.verify(signature, message, publicKey, {
    prehash: false,
    format: "compact"
  });
}

/** cipher 站点绑定的协议常量。 */
export const CIPHER_CONTEXT_V1 = "keymaster:cipher:v1";

/**
 * 从 active key 的私钥 + `exactOrigin` 推导 32 字节 siteKey。
 *
 * 严格按 `HMAC-SHA256(privateKeySecret, "keymaster:cipher:v1|"+exactOrigin)`。
 * `exactOrigin` 必须原样来自 `event.origin`；本函数不做任何归一化。
 */
export function deriveSiteKey(privateKeyHex: string, exactOrigin: string): Uint8Array {
  const priv = hexToBytes(privateKeyHex);
  if (priv.length !== 32) {
    throw new Error("Private key must be 32 bytes");
  }
  const message = new TextEncoder().encode(`${CIPHER_CONTEXT_V1}|${exactOrigin}`);
  return hmac(sha256, priv, message);
}

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
