// packages/plugin-appmsg/src/signing.ts
// secp256k1 compact 64-byte sig + 共享 canonicalBindText。
//
// 设计缘由：
//   - 拼接函数由 `packages/contracts/src/appmsgBind.ts` 提供，与 HubMsg
//     `internal/ws/bind.go::CanonicalBindText` 必须 bit 级一致；
//     任何修改必须两仓同步；
//   - ECDSA 实际输入是 noble 内部 SHA-256 一次（`prehash: false`），
//     与 Go 端 `ecdsa.Sign(SHA256(...))` 等价；
//   - 不直接依赖 `@keymaster/plugin-protocol`——plugin-appmsg 与
//     protocol-plugin 是兄弟，crypto 各自维护。

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBindText } from "@keymaster/contracts";

/**
 * 用 secp256k1 私钥对 bind 原文签名，返回 compact 64-byte hex。
 *
 * 关键约束：
 *   - `privKeyHex` 必须是 32 字节小写 hex；非法长度抛错；
 *   - 原文 = `canonicalBindText(sessionId, nonce, publicKeyHex, issuedAtMs)`；
 *   - 输出是 `r || s`（32 + 32 = 64 字节）的小写 hex；
 *   - 调用方**必须**自己 SHA-256 一次再传入 noble
 *     （`prehash: false` 模式）；与 HubMsg `internal/ws/bind.go::SignBind`
 *     等价。
 *
 * 实现缘由：
 *   - `noble/curves secp256k1.sign(msg, priv, { prehash: true })` 会自动
 *     SHA-256；但**只**对 32 字节以下的 msg 实际计算
 *     `r = (k*G).x mod n` 的 hash 部分；
 *     超过 32 字节的 msg 会被 mod n 缩减，导致"末尾字节微改"漏检。
 *   - 因此本函数**显式**把 bind 原文 SHA-256 成 32 字节 digest 再签名；
 *     短/长原文都得到"原文字节级 tamper 都能 detect"的行为。
 *   - HubMsg Go 端 `internal/ws/bind.go::SignBind` 走
 *     `ecdsa.Sign(SHA256(plaintext))` 等价。
 */
export function signCompactSecp256k1(
  privKeyHex: string,
  sessionId: string,
  nonce: string,
  publicKeyHex: string,
  issuedAtMs: number
): string {
  if (typeof privKeyHex !== "string" || privKeyHex.length !== 64) {
    throw new Error("signCompactSecp256k1: privKeyHex must be 32-byte hex");
  }
  const privBytes = hexToBytes(privKeyHex);
  const plainText = canonicalBindText(sessionId, nonce, publicKeyHex, issuedAtMs);
  const plainBytes = new TextEncoder().encode(plainText);
  // 显式 SHA-256：避免 noble 在 `prehash: false` 模式下对超 32 字节
  // 输入的 mod n 缩减行为。
  const digest = sha256Bytes(plainBytes);
  const sig = secp256k1.sign(digest, privBytes, { prehash: false, format: "compact" });
  if (sig.length !== 64) {
    throw new Error("signCompactSecp256k1: compact signature must be 64 bytes");
  }
  return bytesToHex(sig);
}

/** SHA-256(bytes) -> 32 字节。 */
function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
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