import { secp256k1 } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex, deriveKey, hexToBytes } from "./crypto.js";
import { createSessionCryptoEngine } from "./sessionCryptoClient.js";
import { __testHandleSessionCryptoRequest } from "./sessionCryptoWorker.js";

async function makePrivateKey(
  privateKeyBytes: Uint8Array
): Promise<{
  privateKeyBytes: Uint8Array;
}> {
  return { privateKeyBytes };
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

/**
 * 模拟 Worker 返回错误 format 的场景，用于测试 format mismatch 拒绝逻辑。
 * init 正常处理，signDigest 返回请求的对立格式。
 */
class FormatMismatchWorker {
  static instances: FormatMismatchWorker[] = [];
  onmessage: ((event: MessageEvent<{ requestId: string; ok: boolean; result?: unknown; error?: string }>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;

  constructor() {
    FormatMismatchWorker.instances.push(this);
  }

  postMessage(msg: Record<string, unknown>) {
    if (this.terminated) return;
    queueMicrotask(async () => {
      if (this.terminated) return;
      const responses = await __testHandleSessionCryptoRequest(msg as never);
      for (const response of responses) {
        if (this.terminated) return;
        // 对 signDigest 操作，翻转 format 字段
        if (msg.kind === "signDigest" && response.ok && response.result) {
          const result = response.result as { format: string; signature: ArrayBuffer; publicKeyHex: string };
          const flippedFormat = result.format === "der" ? "compact" : "der";
          this.onmessage?.({
            data: { ...response, result: { ...result, format: flippedFormat } }
          } as MessageEvent<{ requestId: string; ok: boolean; result?: unknown; error?: string }>);
        } else {
          this.onmessage?.({
            data: response
          } as MessageEvent<{ requestId: string; ok: boolean; result?: unknown; error?: string }>);
        }
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
      const { privateKeyBytes: rawPrivateKeyBytes } = await makePrivateKey(privateKeyBytes);
      await expect(
        createSessionCryptoEngine({
          sessionId: "session-a",
          publicKeyHex,
          privateKeyBytes: rawPrivateKeyBytes,
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
      const { privateKeyBytes: rawPrivateKeyBytes } = await makePrivateKey(privateKeyBytes);
      const engine = await createSessionCryptoEngine({
        sessionId: "session-b",
        publicKeyHex,
        privateKeyBytes: rawPrivateKeyBytes,
        label: "Key B",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString()
      }, { allowLocalEngineForTests: true, mode: "appview" });
      const digest = new Uint8Array(32);
      digest.fill(9);
      await expect(
        engine.signDigest({ publicKeyHex, digest: digest.buffer, format: "der" })
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
      const { privateKeyBytes: rawPrivateKeyBytes } = await makePrivateKey(privateKeyBytes);
      await expect(
        createSessionCryptoEngine({
          sessionId: "session-c",
          publicKeyHex,
          privateKeyBytes: rawPrivateKeyBytes,
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
      const { privateKeyBytes: rawPrivateKeyBytes } = await makePrivateKey(privateKeyBytes);
      const engine = await createSessionCryptoEngine({
        sessionId: "session-worker",
        publicKeyHex,
        privateKeyBytes: rawPrivateKeyBytes,
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
        engine.signDigest({ publicKeyHex, digest: digest.buffer, format: "der" })
      ).resolves.toMatchObject({ publicKeyHex });

      engine.dispose("window-close");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(worker?.terminated).toBe(true);

      await expect(
        engine.signDigest({ publicKeyHex, digest: digest.buffer, format: "der" })
      ).rejects.toThrow("Active key session has been revoked");
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    }
  });

  it("worker-backed engine: compact signing returns format=compact and 64-byte signature", async () => {
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    RecordingWorker.instances = [];
    (globalThis as { Worker?: typeof Worker }).Worker =
      RecordingWorker as unknown as typeof Worker;
    try {
      const privateKeyBytes = hexToBytes(
        "0000000000000000000000000000000000000000000000000000000000000001"
      );
      const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
      const { privateKeyBytes: rawPrivateKeyBytes } = await makePrivateKey(privateKeyBytes);
      const engine = await createSessionCryptoEngine({
        sessionId: "session-compact",
        publicKeyHex,
        privateKeyBytes: rawPrivateKeyBytes,
        label: "Key Compact",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString()
      }, { mode: "appview" });

      const digest = new Uint8Array(32);
      digest.fill(0xcc);
      const result = await engine.signDigest({ publicKeyHex, digest: digest.buffer, format: "compact" });
      expect(result.format).toBe("compact");
      expect(result.publicKeyHex).toBe(publicKeyHex);
      expect(new Uint8Array(result.signature).length).toBe(64);

      engine.dispose("test");
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    }
  });

  it("worker-backed engine: DER signing returns format=der and valid DER structure", async () => {
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    RecordingWorker.instances = [];
    (globalThis as { Worker?: typeof Worker }).Worker =
      RecordingWorker as unknown as typeof Worker;
    try {
      const privateKeyBytes = hexToBytes(
        "0000000000000000000000000000000000000000000000000000000000000001"
      );
      const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
      const { privateKeyBytes: rawPrivateKeyBytes } = await makePrivateKey(privateKeyBytes);
      const engine = await createSessionCryptoEngine({
        sessionId: "session-der",
        publicKeyHex,
        privateKeyBytes: rawPrivateKeyBytes,
        label: "Key DER",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString()
      }, { mode: "appview" });

      const digest = new Uint8Array(32);
      digest.fill(0xdd);
      const result = await engine.signDigest({ publicKeyHex, digest: digest.buffer, format: "der" });
      expect(result.format).toBe("der");
      expect(result.publicKeyHex).toBe(publicKeyHex);
      const sigBytes = new Uint8Array(result.signature);
      expect(sigBytes[0]).toBe(0x30); // DER SEQUENCE tag
      expect(sigBytes.length).toBeGreaterThanOrEqual(8);

      engine.dispose("test");
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    }
  });

  it("worker-backed engines preserve sender and recipient app IDs across two-party messaging", async () => {
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    RecordingWorker.instances = [];
    (globalThis as { Worker?: typeof Worker }).Worker =
      RecordingWorker as unknown as typeof Worker;
    let sender: Awaited<ReturnType<typeof createSessionCryptoEngine>> | undefined;
    let recipient: Awaited<ReturnType<typeof createSessionCryptoEngine>> | undefined;
    try {
      const senderPrivateKeyBytes = hexToBytes(
        "0000000000000000000000000000000000000000000000000000000000000001"
      );
      const recipientPrivateKeyBytes = hexToBytes(
        "0000000000000000000000000000000000000000000000000000000000000002"
      );
      const senderPublicKeyHex = bytesToHex(secp256k1.getPublicKey(senderPrivateKeyBytes, true));
      const recipientPublicKeyHex = bytesToHex(secp256k1.getPublicKey(recipientPrivateKeyBytes, true));
      sender = await createSessionCryptoEngine({
        sessionId: "session-message-sender",
        publicKeyHex: senderPublicKeyHex,
        privateKeyBytes: senderPrivateKeyBytes,
        label: "Sender",
        capabilities: [],
        createdAt: new Date().toISOString()
      }, { mode: "appview" });
      const sealed = await sender.sealSendInput({
        sender: { senderPublicKeyHex, senderAppId: "keymaster.message" },
        recipient: { recipientPublicKeyHex, recipientAppId: "keymaster.message" },
        contentType: "text/plain",
        body: "received body",
        clientMessageId: "client-received",
        createdAtMs: 200
      });
      expect("record" in sealed).toBe(true);
      if (!("record" in sealed)) throw new Error(sealed.error);
      // 测试 Worker 夹具复用单例状态；先释放发送方，再初始化接收方。
      sender.dispose("sender-finished");
      sender = undefined;
      await new Promise((resolve) => setTimeout(resolve, 0));

      recipient = await createSessionCryptoEngine({
        sessionId: "session-message-recipient",
        publicKeyHex: recipientPublicKeyHex,
        privateKeyBytes: recipientPrivateKeyBytes,
        label: "Recipient",
        capabilities: [],
        createdAt: new Date().toISOString()
      }, { mode: "appview" });
      const opened = await recipient.openSealed({
        ...sealed.record,
        messageId: "message-received",
        insertedAtMs: 201
      });

      expect(opened).toMatchObject({
        messageId: "message-received",
        senderPublicKeyHex,
        senderAppId: "keymaster.message",
        recipientPublicKeyHex,
        recipientAppId: "keymaster.message",
        body: "received body"
      });
    } finally {
      recipient?.dispose("test");
      sender?.dispose("test");
      await new Promise((resolve) => setTimeout(resolve, 0));
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    }
  });

  it("local engine: compact signing returns format=compact and 64-byte signature", async () => {
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    (globalThis as { Worker?: typeof Worker }).Worker = undefined;
    try {
      const privateKeyBytes = hexToBytes(
        "0000000000000000000000000000000000000000000000000000000000000001"
      );
      const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
      const { privateKeyBytes: rawPrivateKeyBytes } = await makePrivateKey(privateKeyBytes);
      const engine = await createSessionCryptoEngine({
        sessionId: "session-local-compact",
        publicKeyHex,
        privateKeyBytes: rawPrivateKeyBytes,
        label: "Key Local Compact",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString()
      }, { allowLocalEngineForTests: true, mode: "appview" });

      const digest = new Uint8Array(32);
      digest.fill(0xee);
      const result = await engine.signDigest({ publicKeyHex, digest: digest.buffer, format: "compact" });
      expect(result.format).toBe("compact");
      expect(new Uint8Array(result.signature).length).toBe(64);

      engine.dispose("test");
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    }
  });

  it("worker-backed engine: rejects when Worker returns mismatched format (compact→der)", async () => {
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    FormatMismatchWorker.instances = [];
    (globalThis as { Worker?: typeof Worker }).Worker =
      FormatMismatchWorker as unknown as typeof Worker;
    try {
      const privateKeyBytes = hexToBytes(
        "0000000000000000000000000000000000000000000000000000000000000001"
      );
      const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
      const { privateKeyBytes: rawPrivateKeyBytes } = await makePrivateKey(privateKeyBytes);
      const engine = await createSessionCryptoEngine({
        sessionId: "session-mismatch",
        publicKeyHex,
        privateKeyBytes: rawPrivateKeyBytes,
        label: "Key Mismatch",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString()
      }, { mode: "appview" });

      const digest = new Uint8Array(32);
      digest.fill(0xff);
      // 请求 compact，但 FormatMismatchWorker 会返回 der
      await expect(
        engine.signDigest({ publicKeyHex, digest: digest.buffer, format: "compact" })
      ).rejects.toThrow('signDigest format mismatch');

      engine.dispose("test");
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    }
  });

  it("worker-backed engine: rejects when Worker returns mismatched format (der→compact)", async () => {
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    FormatMismatchWorker.instances = [];
    (globalThis as { Worker?: typeof Worker }).Worker =
      FormatMismatchWorker as unknown as typeof Worker;
    try {
      const privateKeyBytes = hexToBytes(
        "0000000000000000000000000000000000000000000000000000000000000001"
      );
      const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
      const { privateKeyBytes: rawPrivateKeyBytes } = await makePrivateKey(privateKeyBytes);
      const engine = await createSessionCryptoEngine({
        sessionId: "session-mismatch-der",
        publicKeyHex,
        privateKeyBytes: rawPrivateKeyBytes,
        label: "Key Mismatch DER",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString()
      }, { mode: "appview" });

      const digest = new Uint8Array(32);
      digest.fill(0xfe);
      // 请求 der，但 FormatMismatchWorker 会返回 compact
      await expect(
        engine.signDigest({ publicKeyHex, digest: digest.buffer, format: "der" })
      ).rejects.toThrow('signDigest format mismatch');

      engine.dispose("test");
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    }
  });
});
