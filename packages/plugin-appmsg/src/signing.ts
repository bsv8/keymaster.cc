// packages/plugin-appmsg/src/signing.ts
// secp256k1 compact 签名 + HubMsg client_bind 签名消息构造。
//
// 设计缘由：
//   - plugin-appmsg 必须能完成 HubMsg client_bind 的 secp256k1 compact
//     签名；签名责任由 owner runtime 提供 privKeyHex，本模块只负责
//     "privKeyHex + message -> 64-byte sig hex"；
//   - 不直接 import `@keymaster/plugin-protocol/protocolCrypto`：plugin-appmsg
//     是 platform plugin，与 protocolService 是兄弟；协议侧 crypto 内部
//     实现属于 protocol-plugin。
//   - 这里直接走 `@noble/curves/secp256k1`，保持 sig 形状一致。
//   - 与 plugin-protocol 的 `signCompactSecp256k1` 行为对齐：prehash=false，
//     因为输入的"消息"已经是平台决定好的真值字节（HubMsg `sessionId|nonce|
//     publicKeyHex|issuedAtMs`），不应再被 SHA-256 一次。

import { secp256k1 } from "@noble/curves/secp256k1.js";

/**
 * 用 secp256k1 私钥对 `message` 字符串签名，返回 compact 64-byte hex。
 *
 * 关键约束：
 *   - `message` 是字符串，按 UTF-8 编码转字节；
 *   - 输出是 `r || s`（32 + 32 = 64 字节）的小写 hex；
 *   - 私钥必须是 32 字节 hex；非法长度抛错；
 *   - prehash=false（与 plugin-protocol 同语义）。
 */
export function signCompactSecp256k1(privKeyHex: string, message: string): string {
  if (typeof privKeyHex !== "string" || privKeyHex.length !== 64) {
    throw new Error("signCompactSecp256k1: privKeyHex must be 32-byte hex");
  }
  const privBytes = hexToBytes(privKeyHex);
  const msgBytes = new TextEncoder().encode(message);
  const sig = secp256k1.sign(msgBytes, privBytes, { prehash: false, format: "compact" });
  if (sig.length !== 64) {
    throw new Error("signCompactSecp256k1: compact signature must be 64 bytes");
  }
  return bytesToHex(sig);
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