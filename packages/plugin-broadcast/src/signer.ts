// packages/plugin-broadcast/src/signer.ts
// broadcast core 内部的 secp256k1 签名 / 验签工具。
//
// 设计缘由（施工单 §6.4）：
//   - plugin-broadcast 是浏览器侧**唯一**允许做广播 envelope 签名与
//     验签的边界；
//   - 签名算法 = `ecdsa.Sign(SHA-256(envelopeBytes))` → 64-byte
//     compact r||s；
//   - 验签算法 = `ecdsa.Verify(SHA-256(envelopeBytes), signature, pubkey)`，
//     验签直接对 envelopeBytes（deterministic CBOR 真值字节）进行；
//   - 与 plugin-appmsg 的 `signChallengeWithSecp256k1` 同源：
//     都显式 SHA-256 输入，避免 noble `prehash: false` 模式对超 32
//     字节输入的 mod n 缩减行为。

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * 用受控签名能力对 `envelopeBytes` 做签名，返回 compact 64-byte hex。
 *
 * 关键约束：
 *   - `signDigest` 必须返回 64 字节 compact 签名；
 *   - 输出是 `r || s`（32 + 32 = 64 字节）的小写 hex；
 *   - 签名算法 = `ecdsa.Sign(SHA-256(envelopeBytes))`。
 */
export function signBroadcastEnvelope(
  envelopeBytes: Uint8Array,
  signDigest: (digest: Uint8Array) => Promise<Uint8Array> | Uint8Array
): Promise<string> {
  if (!(envelopeBytes instanceof Uint8Array)) {
    throw new Error("signBroadcastEnvelope: envelopeBytes must be Uint8Array");
  }
  // 显式 SHA-256：避免 noble 在 prehash:false 模式下对超 32 字节
  // 输入的 mod n 缩减行为。
  const digest = sha256(envelopeBytes);
  return Promise.resolve(signDigest(digest)).then((sig) => {
    if (!(sig instanceof Uint8Array) || sig.length !== 64) {
      throw new Error("signBroadcastEnvelope: compact signature must be 64 bytes");
    }
    return bytesToHex(sig);
  });
}

/**
 * 验签 envelope：直接对 `envelopeBytes` 验证 `signatureBytes` 与
 * `publisherPublicKeyHex`。
 *
 * 关键约束：
 *   - `signatureBytes.length === 64`（compact secp256k1 r||s）；
 *   - `publisherPublicKeyHex` 必须是 33 字节 compressed 公钥 hex；
 *   - **不**接受公钥去重 / 投影变换——调用方拿到的公钥就是验签公钥；
 *   - 验签失败返回 false，**不**抛错；调用方按"verify → fail-closed"
 *     顺序处理。
 */
export function verifyBroadcastEnvelope(input: {
  envelopeBytes: Uint8Array;
  signatureBytes: Uint8Array;
  publisherPublicKeyHex: string;
}): boolean {
  if (!(input.envelopeBytes instanceof Uint8Array)) return false;
  if (!(input.signatureBytes instanceof Uint8Array)) return false;
  if (input.signatureBytes.length !== 64) return false;
  if (typeof input.publisherPublicKeyHex !== "string") return false;
  if (input.publisherPublicKeyHex.length !== 66) return false;
  let pubBytes: Uint8Array;
  try {
    pubBytes = hexToBytes(input.publisherPublicKeyHex);
  } catch {
    return false;
  }
  if (pubBytes.length !== 33) return false;
  let sigBytes: Uint8Array;
  try {
    sigBytes = input.signatureBytes instanceof Uint8Array
      ? input.signatureBytes
      : new Uint8Array(input.signatureBytes);
  } catch {
    return false;
  }
  try {
    const digest = sha256(input.envelopeBytes);
    return secp256k1.verify(sigBytes, digest, pubBytes, { prehash: false, format: "compact" });
  } catch {
    return false;
  }
}

/** hex -> Uint8Array（小写 hex）。 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

/** Uint8Array -> 小写 hex。 */
function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    s += b.toString(16).padStart(2, "0");
  }
  return s;
}

/** Uint8Array -> 大写 hex（公钥匹配用）。 */
export function bytesToHexUpper(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    s += b.toString(16).padStart(2, "0").toUpperCase();
  }
  return s;
}
