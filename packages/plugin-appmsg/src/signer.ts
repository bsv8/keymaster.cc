// packages/plugin-appmsg/src/signer.ts
// plugin-appmsg 内部的通用 secp256k1 签名实现（ProviderSigner 接口）。
//
// 设计缘由（硬切换 2026-07-04 001 修订）：
//   - 这是平台 vault 持有的 secp256k1 私钥对应的"通用签名原语"；
//   - `signChallengeWithSecp256k1(signDigest, challenge)` 接受任意
//     `challenge` 字节并返回 secp256k1 签名；
//   - **不**夹带任何具体 provider 的协议字段；HubMsg 的 `canonicalBindText`
//     拼接收口**只**存在于 `plugin-hubmsg` 的 `HubMsgBindSignerAdapter`；
//   - 与 HubMsg Go 端 `internal/ws/bind.go::SignBind` 等价：
//     `ecdsa.Sign(SHA-256(plaintext))` → 64-byte compact r||s。
//
// 实现缘由：
//   - noble 在 `prehash: false` 模式下对超 32 字节输入会做 mod n 缩减，
//     "末尾字节微改"会漏检。这里**显式**SHA-256 challenge → 32 字节
//     digest，再签，得到"原文字节级 tamper 都能 detect"的行为。

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBindText } from "@keymaster/contracts";

/**
 * 用受控签名能力对 `challenge` 字节做签名，返回 compact 64-byte hex。
 *
 * 关键约束：
 *   - `signDigest` 必须返回 64-byte compact 签名；
 *   - 输出是 `r || s`（32 + 32 = 64 字节）的小写 hex；
 *   - 签名算法 = `ecdsa.Sign(SHA-256(challenge))`，与 Go 端
 *     `ecdsa.Sign(SHA-256(plaintext))` 等价；
 *   - provider 拿到 hex 后按自己的协议格式使用（HubMsg 直接用；
 *     其它 provider 可自行验证格式）。
 */
export function signChallengeWithSecp256k1(
  signDigest: (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>,
  challenge: Uint8Array
): Promise<string> {
  if (!(challenge instanceof Uint8Array)) {
    throw new Error("signChallengeWithSecp256k1: challenge must be Uint8Array");
  }
  // 显式 SHA-256：避免 noble 在 `prehash: false` 模式下对超 32 字节
  // 输入的 mod n 缩减行为。
  const digest = sha256(challenge);
  return Promise.resolve(signDigest(digest)).then((sig) => {
    if (!(sig instanceof Uint8Array) || sig.length !== 64) {
      throw new Error("signChallengeWithSecp256k1: compact signature must be 64 bytes");
    }
    return bytesToHex(sig);
  });
}

/**
 * 保留 `signCompactSecp256k1(privKeyHex, sessionId, nonce, publicKeyHex,
 * issuedAtMs)` 命名**仅**为与 HubMsg Go 端 SignBind / 测试 fixture
 * 对齐的便利封装（仍走 `canonicalBindText`）；运行时**不**调用——
 * 业务层只走 `signChallengeWithSecp256k1`。
 *
 * 保留理由：
 *   - 跨仓联调一致性测试（crossBind）需要复用同一签名实现来生成
 *     fixture 验签材料；
 *   - 其它测试如果直接验证四元组拼接 + secp256k1 行为，可以少 import
 *     一层。
 */
export function signCompactSecp256k1(
  signDigest: ((digest: Uint8Array) => Uint8Array | Promise<Uint8Array>) | string,
  sessionId: string,
  nonce: string,
  publicKeyHex: string,
  issuedAtMs: number
): Promise<string> | string {
  const plainText = canonicalBindText(sessionId, nonce, publicKeyHex, issuedAtMs);
  const plainBytes = new TextEncoder().encode(plainText);
  if (typeof signDigest === "string") {
    const privHex = signDigest;
    const priv = hexToBytes(privHex);
    if (priv.length !== 32) {
      throw new Error("signCompactSecp256k1: private key must be 32 bytes");
    }
    const digest = sha256(plainBytes);
    const sig = secp256k1.sign(digest, priv, { prehash: false, format: "compact" });
    const out = sig instanceof Uint8Array ? sig : new Uint8Array(sig);
    return bytesToHex(out);
  }
  return signChallengeWithSecp256k1(signDigest, plainBytes);
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

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}
