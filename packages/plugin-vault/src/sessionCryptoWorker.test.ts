// packages/plugin-vault/src/sessionCryptoWorker.test.ts
// Session Crypto Worker 回归测试。
//
// 关键不变量：
//   - init 后才能签名；
//   - dispose 后 worker 状态撤销，后续 operation 失败；
//   - worker 不返回 raw 私钥，只返回显式 operation 结果。

import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex, deriveKey, encryptBytesWithAad, hexToBytes, vaultKeyAad } from "./crypto.js";
import { __testHandleSessionCryptoRequest } from "./sessionCryptoWorker.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { SessionCryptoRequestMessage } from "./sessionCryptoProtocol.js";

const TEST_PRIV_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const TEST_PRIV_BYTES = hexToBytes(TEST_PRIV_HEX);
const TEST_PUB_HEX = bytesToHex(secp256k1.getPublicKey(TEST_PRIV_BYTES, true));

async function makeEncryptedPrivateKey() {
  const passwordKey = await deriveKey("worker-password", crypto.getRandomValues(new Uint8Array(16)));
  const payload = new TextEncoder().encode(JSON.stringify({ hex: TEST_PRIV_HEX }));
  const blob = await encryptBytesWithAad(passwordKey, payload, vaultKeyAad(TEST_PUB_HEX));
  return {
    passwordKey,
    encryptedPrivateKey: {
      publicKeyHex: TEST_PUB_HEX,
      cipherVersion: blob.version ?? "v2",
      cipherSaltB64: bytesToHex(blob.salt),
      cipherIvB64: bytesToHex(blob.iv),
      cipherB64: bytesToHex(blob.ciphertext)
    }
  };
}

async function send(msg: SessionCryptoRequestMessage) {
  return __testHandleSessionCryptoRequest(msg);
}

describe("sessionCryptoWorker", () => {
  afterEach(() => {
    // worker module uses internal singleton state; dispose resets it.
  });

  it("init/signDigest/dispose/revoke behaves as a single-session capability", async () => {
    const { passwordKey, encryptedPrivateKey } = await makeEncryptedPrivateKey();

    const initRes = await send({
      kind: "init",
      requestId: "req-init",
      sessionId: "sess-1",
      publicKeyHex: TEST_PUB_HEX,
      passwordKey,
      encryptedPrivateKey,
      label: "Key A",
      capabilities: ["p2pkh"],
      createdAt: "2026-07-17T00:00:00.000Z"
    });
    expect(initRes).toMatchObject([
      {
        requestId: "req-init",
        ok: true,
        result: {
          sessionId: "sess-1",
          publicKeyHex: TEST_PUB_HEX
        }
      }
    ]);

    const digest = new Uint8Array(32);
    digest.fill(7);
    const signRes = await send({
      kind: "signDigest",
      requestId: "req-sign",
      publicKeyHex: TEST_PUB_HEX,
      digest: digest.buffer,
      format: "der"
    });
    expect(signRes).toHaveLength(1);
    expect(signRes[0]).toMatchObject({
      requestId: "req-sign",
      ok: true
    });
    if (signRes[0]?.ok) {
      expect(signRes[0].result).toMatchObject({
        publicKeyHex: TEST_PUB_HEX,
        format: "der"
      });
    }

    const disposeRes = await send({
      kind: "dispose",
      requestId: "req-dispose",
      reason: "window-close"
    });
    expect(disposeRes).toMatchObject([
      {
        requestId: "req-dispose",
        ok: true,
        result: null
      }
    ]);

    const revokedRes = await send({
      kind: "signDigest",
      requestId: "req-sign-after-dispose",
      publicKeyHex: TEST_PUB_HEX,
      digest: digest.buffer,
      format: "der"
    });
    expect(revokedRes).toMatchObject([
      {
        requestId: "req-sign-after-dispose",
        ok: false,
        error: "Active key session has been revoked"
      }
    ]);
  });

  it("rejects repeated init while a live session exists", async () => {
    const { passwordKey, encryptedPrivateKey } = await makeEncryptedPrivateKey();

    const first = await send({
      kind: "init",
      requestId: "req-init-1",
      sessionId: "sess-1",
      publicKeyHex: TEST_PUB_HEX,
      passwordKey,
      encryptedPrivateKey,
      label: "Key A",
      capabilities: ["p2pkh"],
      createdAt: "2026-07-17T00:00:00.000Z"
    });
    expect(first).toMatchObject([
      {
        requestId: "req-init-1",
        ok: true
      }
    ]);

    const second = await send({
      kind: "init",
      requestId: "req-init-2",
      sessionId: "sess-2",
      publicKeyHex: TEST_PUB_HEX,
      passwordKey,
      encryptedPrivateKey,
      label: "Key B",
      capabilities: ["p2pkh"],
      createdAt: "2026-07-17T00:00:00.000Z"
    });
    expect(second).toMatchObject([
      {
        requestId: "req-init-2",
        ok: false,
        error: "Session crypto worker is already initialized"
      }
    ]);

    await send({
      kind: "dispose",
      requestId: "req-dispose",
      reason: "test-cleanup"
    });
  });

  it("signDigest with format=der returns DER signature with correct format field", async () => {
    const { passwordKey, encryptedPrivateKey } = await makeEncryptedPrivateKey();

    await send({
      kind: "init",
      requestId: "req-init-der",
      sessionId: "sess-der",
      publicKeyHex: TEST_PUB_HEX,
      passwordKey,
      encryptedPrivateKey,
      label: "Key DER",
      capabilities: ["p2pkh"],
      createdAt: "2026-07-19T00:00:00.000Z"
    });

    const digest = new Uint8Array(32);
    digest.fill(0xab);
    const signRes = await send({
      kind: "signDigest",
      requestId: "req-sign-der",
      publicKeyHex: TEST_PUB_HEX,
      digest: digest.buffer,
      format: "der"
    });
    expect(signRes).toHaveLength(1);
    expect(signRes[0]?.ok).toBe(true);
    if (signRes[0]?.ok) {
      const result = signRes[0].result as { publicKeyHex: string; format: string; signature: ArrayBuffer };
      expect(result.format).toBe("der");
      expect(result.publicKeyHex).toBe(TEST_PUB_HEX);
      const sigBytes = new Uint8Array(result.signature);
      // DER 签名必须以 0x30 (SEQUENCE) 开头
      expect(sigBytes[0]).toBe(0x30);
      expect(sigBytes.length).toBeGreaterThanOrEqual(8);
    }

    await send({ kind: "dispose", requestId: "req-dispose-der", reason: "test-cleanup" });
  });

  it("signDigest with format=compact returns 64-byte compact signature", async () => {
    const { passwordKey, encryptedPrivateKey } = await makeEncryptedPrivateKey();

    await send({
      kind: "init",
      requestId: "req-init-compact",
      sessionId: "sess-compact",
      publicKeyHex: TEST_PUB_HEX,
      passwordKey,
      encryptedPrivateKey,
      label: "Key Compact",
      capabilities: ["p2pkh"],
      createdAt: "2026-07-19T00:00:00.000Z"
    });

    const digest = new Uint8Array(32);
    digest.fill(0xcd);
    const signRes = await send({
      kind: "signDigest",
      requestId: "req-sign-compact",
      publicKeyHex: TEST_PUB_HEX,
      digest: digest.buffer,
      format: "compact"
    });
    expect(signRes).toHaveLength(1);
    expect(signRes[0]?.ok).toBe(true);
    if (signRes[0]?.ok) {
      const result = signRes[0].result as { publicKeyHex: string; format: string; signature: ArrayBuffer };
      expect(result.format).toBe("compact");
      expect(result.publicKeyHex).toBe(TEST_PUB_HEX);
      const sigBytes = new Uint8Array(result.signature);
      // compact 签名固定 64 字节
      expect(sigBytes.length).toBe(64);
    }

    await send({ kind: "dispose", requestId: "req-dispose-compact", reason: "test-cleanup" });
  });

  it("signDigest rejects non-32-byte digest", async () => {
    const { passwordKey, encryptedPrivateKey } = await makeEncryptedPrivateKey();

    await send({
      kind: "init",
      requestId: "req-init-bad-digest",
      sessionId: "sess-bad-digest",
      publicKeyHex: TEST_PUB_HEX,
      passwordKey,
      encryptedPrivateKey,
      label: "Key BadDigest",
      capabilities: ["p2pkh"],
      createdAt: "2026-07-19T00:00:00.000Z"
    });

    const badDigest = new Uint8Array(16);
    badDigest.fill(1);
    const signRes = await send({
      kind: "signDigest",
      requestId: "req-sign-bad-digest",
      publicKeyHex: TEST_PUB_HEX,
      digest: badDigest.buffer,
      format: "der"
    });
    expect(signRes).toHaveLength(1);
    const response = signRes[0];
    expect(response?.ok).toBe(false);
    if (response?.ok === false) {
      expect(response.error).toContain("digest must be 32 bytes");
    }

    await send({ kind: "dispose", requestId: "req-dispose-bad-digest", reason: "test-cleanup" });
  });
});
