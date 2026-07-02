// packages/plugin-appmsg/src/signing.test.ts
// signCompactSecp256k1 单测：与 HubMsg Go 端 SignBind / VerifyBindSignature
// 必须 bit 级一致。
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { signCompactSecp256k1 } from "./signing.js";

describe("signCompactSecp256k1", () => {
  it("round-trip: verify recovers the same public key", () => {
    const priv = new Uint8Array(32);
    crypto.getRandomValues(priv);
    const pub = secp256k1.getPublicKey(priv, true);

    const sessionId = "0123456789abcdef0123456789abcdef";
    const nonce = "ffeeddccbbaa99887766554433221100";
    const issuedAtMs = 1700000000123;

    const privHex = bytesToHex(priv);
    const pubHex = bytesToHex(pub);

    const sigHex = signCompactSecp256k1(privHex, sessionId, nonce, pubHex, issuedAtMs);
    expect(sigHex).toHaveLength(128); // 64 bytes * 2 hex chars

    // 重建原文（与 HubMsg 端拼接一致）并 SHA-256 后验签。
    // 与 signing.ts 中 signCompactSecp256k1 内部 SHA-256 一致。
    const plaintext = `${sessionId}|${nonce}|${pubHex}|${issuedAtMs}`;
    const msgBytes = new TextEncoder().encode(plaintext);
    const digest = sha256Of(msgBytes);
    const sigBytes = hexToBytes(sigHex);
    const ok = secp256k1.verify(sigBytes, digest, pub, { prehash: false, format: "compact" });
    expect(ok).toBe(true);
  });

  it("rejects when tampered timestamp", () => {
    const priv = new Uint8Array(32);
    crypto.getRandomValues(priv);
    const pub = secp256k1.getPublicKey(priv, true);
    const privHex = bytesToHex(priv);
    const pubHex = bytesToHex(pub);

    const sigHex = signCompactSecp256k1(privHex, "sid", "nonce", pubHex, 1700000000123);
    const tamperedText = `sid|nonce|${pubHex}|1700000000124`;
    const tamperedDigest = sha256Of(new TextEncoder().encode(tamperedText));
    const ok = secp256k1.verify(hexToBytes(sigHex), tamperedDigest, pub, {
      prehash: false,
      format: "compact"
    });
    expect(ok).toBe(false);
  });

  it("rejects bad privKeyHex length", () => {
    expect(() => signCompactSecp256k1("abcd", "a", "b", "c", 1)).toThrow();
  });
});

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

function sha256Of(bytes: Uint8Array): Uint8Array {
  // 与 signing.ts 的内部 SHA-256 等价：使用 noble/hashes
  return sha256(bytes);
}