import { secp256k1 } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex, deriveKey, encryptBytesWithAad, hexToBytes, vaultKeyAad } from "./crypto.js";
import { createSessionCryptoEngine } from "./sessionCryptoClient.js";
import { __testHandleSessionCryptoRequest } from "./sessionCryptoWorker.js";
import type { SessionCryptoEncryptedKeyMaterial } from "./sessionCryptoProtocol.js";

async function makeEncryptedPrivateKey(
  privateKeyBytes: Uint8Array
): Promise<{
  passwordKey: CryptoKey;
  encryptedPrivateKey: SessionCryptoEncryptedKeyMaterial;
}> {
  const passwordKey = await deriveKey("test-password", crypto.getRandomValues(new Uint8Array(16)));
  const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
  const payload = new TextEncoder().encode(JSON.stringify({ hex: bytesToHex(privateKeyBytes) }));
  const blob = await encryptBytesWithAad(passwordKey, payload, vaultKeyAad(publicKeyHex));
  return {
    passwordKey,
    encryptedPrivateKey: {
      publicKeyHex,
      cipherVersion: blob.version ?? "v2",
      cipherSaltB64: bytesToHex(blob.salt),
      cipherIvB64: bytesToHex(blob.iv),
      cipherB64: bytesToHex(blob.ciphertext)
    }
  };
}

class FailingWorker {
  onmessage: ((event: MessageEvent<{ requestId: string; ok: boolean; error: string }>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  constructor() {
    // noop
  }
  postMessage(msg: { requestId: string }) {
    queueMicrotask(() => {
      this.onmessage?.({
        data: { requestId: msg.requestId, ok: false, error: "worker init failed" }
      } as MessageEvent<{ requestId: string; ok: boolean; error: string }>);
    });
  }
  terminate() {
    // noop
  }
}

class RecordingWorker {
  static instances: RecordingWorker[] = [];
  onmessage: ((event: MessageEvent<{ requestId: string; ok: boolean; result?: unknown; error?: string }>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;

  constructor() {
    RecordingWorker.instances.push(this);
  }

  postMessage(msg: Record<string, unknown>) {
    if (this.terminated) return;
    queueMicrotask(async () => {
      if (this.terminated) return;
      const responses = await __testHandleSessionCryptoRequest(msg as never);
      for (const response of responses) {
        if (this.terminated) return;
        this.onmessage?.({
          data: response
        } as MessageEvent<{ requestId: string; ok: boolean; result?: unknown; error?: string }>);
      }
    });
  }

  terminate() {
    this.terminated = true;
  }
}

describe("sessionCryptoClient", () => {
  afterEach(() => {
    // 恢复 Worker 全局，避免影响其它测试。
    if ("Worker" in globalThis) {
      // noop: Vitest/Node 里通常本来就没有 Worker。
    }
  });

  it("rejects when Worker is unavailable unless test fallback is explicitly enabled", async () => {
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    (globalThis as { Worker?: typeof Worker }).Worker = undefined;
    try {
      const privateKeyBytes = hexToBytes(
        "0000000000000000000000000000000000000000000000000000000000000001"
      );
      const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
      const { passwordKey, encryptedPrivateKey } = await makeEncryptedPrivateKey(privateKeyBytes);
      await expect(
        createSessionCryptoEngine({
          sessionId: "session-a",
          publicKeyHex,
          passwordKey,
          encryptedPrivateKey,
          label: "Key A",
          capabilities: ["p2pkh"],
          createdAt: new Date().toISOString()
        }, { mode: "appview" })
      ).rejects.toThrow("Session crypto worker is unavailable");
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    }
  });

  it("uses the local engine only when explicitly allowed for tests", async () => {
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    (globalThis as { Worker?: typeof Worker }).Worker = undefined;
    try {
      const privateKeyBytes = hexToBytes(
        "0000000000000000000000000000000000000000000000000000000000000001"
      );
      const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
      const { passwordKey, encryptedPrivateKey } = await makeEncryptedPrivateKey(privateKeyBytes);
      const engine = await createSessionCryptoEngine({
        sessionId: "session-b",
        publicKeyHex,
        passwordKey,
        encryptedPrivateKey,
        label: "Key B",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString()
      }, { allowLocalEngineForTests: true, mode: "appview" });
      const digest = new Uint8Array(32);
      digest.fill(9);
      await expect(
        engine.signDigest({ publicKeyHex, digest: digest.buffer })
      ).resolves.toMatchObject({ publicKeyHex });
      engine.dispose?.("test");
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    }
  });

  it("fails closed when worker init returns an error", async () => {
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    (globalThis as { Worker?: typeof Worker }).Worker = FailingWorker as unknown as typeof Worker;
    try {
      const privateKeyBytes = hexToBytes(
        "0000000000000000000000000000000000000000000000000000000000000001"
      );
      const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
      const { passwordKey, encryptedPrivateKey } = await makeEncryptedPrivateKey(privateKeyBytes);
      await expect(
        createSessionCryptoEngine({
          sessionId: "session-c",
          publicKeyHex,
          passwordKey,
          encryptedPrivateKey,
          label: "Key C",
          capabilities: ["p2pkh"],
          createdAt: new Date().toISOString()
        }, { mode: "appview" })
      ).rejects.toThrow("worker init failed");
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    }
  });

  it("uses the worker-backed engine when Worker is available and terminates it on dispose", async () => {
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    RecordingWorker.instances = [];
    (globalThis as { Worker?: typeof Worker }).Worker =
      RecordingWorker as unknown as typeof Worker;
    try {
      const privateKeyBytes = hexToBytes(
        "0000000000000000000000000000000000000000000000000000000000000001"
      );
      const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
      const { passwordKey, encryptedPrivateKey } = await makeEncryptedPrivateKey(privateKeyBytes);
      const engine = await createSessionCryptoEngine({
        sessionId: "session-worker",
        publicKeyHex,
        passwordKey,
        encryptedPrivateKey,
        label: "Key W",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString()
      }, { mode: "appview" });

      expect(RecordingWorker.instances).toHaveLength(1);
      const worker = RecordingWorker.instances[0];
      expect(worker?.terminated).toBe(false);

      const digest = new Uint8Array(32);
      digest.fill(11);
      await expect(
        engine.signDigest({ publicKeyHex, digest: digest.buffer })
      ).resolves.toMatchObject({ publicKeyHex });

      engine.dispose("window-close");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(worker?.terminated).toBe(true);

      await expect(
        engine.signDigest({ publicKeyHex, digest: digest.buffer })
      ).rejects.toThrow("Active key session has been revoked");
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    }
  });
});
