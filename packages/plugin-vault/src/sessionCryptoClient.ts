// packages/plugin-vault/src/sessionCryptoClient.ts
// Session Crypto capability client。
//
// 设计缘由：
//   - 浏览器环境优先用 Worker 隔离私钥；
//   - 本地实现只允许通过显式测试开关注入，生产路径 fail closed。

import type {
  ActiveKeyCryptoIdentity,
  ActiveKeyCryptoSealSendInputResult,
  ActiveKeyCryptoSignDigestResult,
  AppMsgMessage,
  ProviderSealedMessageRecord
} from "@keymaster/contracts";
import { ActiveKeySessionRevokedError } from "@keymaster/contracts";
import type { ActiveKeyCrypto } from "@keymaster/contracts";
import {
  deriveP2pkhAddress,
  hexToBytes,
  decryptSessionPrivateKeyBytes,
  openAppMessageLocalBytes,
  sealAppMessageLocalBytes,
  signDigestBytes,
  verifySessionKeyPair
} from "./sessionCryptoCore.js";
import { encryptVaultKeyMaterial as coordinatorEncryptVaultKeyMaterial } from "./vaultCoordinator.js";
import type {
  SessionCryptoBootstrapInput,
  SessionCryptoResponseMessage
} from "./sessionCryptoProtocol.js";

interface SessionCryptoEngineInput extends SessionCryptoBootstrapInput {}

interface SessionCryptoEngine {
  getIdentity(): ActiveKeyCryptoIdentity;
  signDigest(input: { publicKeyHex: string; digest: ArrayBuffer }): Promise<ActiveKeyCryptoSignDigestResult>;
  deriveP2pkhAddress(input: {
    publicKeyHex: string;
    network: "main" | "test";
  }): Promise<{ publicKeyHex: string; address: string }>;
  sealSendInput(input: {
    sender: { senderPublicKeyHex: string; senderOrigin?: string; senderAppId?: string };
    recipient: { recipientPublicKeyHex: string; recipientOrigin?: string; recipientAppId?: string };
    contentType: "text/plain" | "text/markdown";
    body: string;
    clientMessageId: string;
    createdAtMs: number;
  }): ActiveKeyCryptoSealSendInputResult | { error: string };
  openSealed(rec: ProviderSealedMessageRecord): Promise<AppMsgMessage | null>;
  encryptVaultKeyMaterial(input: {
    publicKeyHex: string;
    material: { hex: string; wif?: string };
  }): Promise<{
    cipherVersion: "v2";
    cipherSaltB64: string;
    cipherIvB64: string;
    cipherB64: string;
  }>;
  dispose(reason?: string): void;
}

export interface SessionCryptoClientOptions {
  engineFactory?: (input: SessionCryptoEngineInput) => Promise<SessionCryptoEngine>;
  allowLocalEngineForTests?: boolean;
}

function randomId(): string {
  return crypto.randomUUID();
}

export async function createSessionCryptoEngine(
  input: SessionCryptoEngineInput,
  options: SessionCryptoClientOptions = {}
): Promise<SessionCryptoEngine> {
  if (options.engineFactory) {
    return options.engineFactory(input);
  }
  const canUseWorker = typeof Worker !== "undefined";
  if (canUseWorker) {
    return createWorkerBackedEngine(input);
  }
  if (options.allowLocalEngineForTests) {
    return createLocalEngine(input);
  }
  throw new Error("Session crypto worker is unavailable");
}

async function createWorkerBackedEngine(
  input: SessionCryptoEngineInput
): Promise<SessionCryptoEngine> {
  const worker = new Worker(new URL("./sessionCryptoWorker.ts", import.meta.url), {
    type: "module"
  });
  const pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  let disposed = false;
  let disposeCleanupTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (reason?: string): void => {
    if (disposed) return;
    disposed = true;
    if (disposeCleanupTimer !== null) {
      clearTimeout(disposeCleanupTimer);
      disposeCleanupTimer = null;
    }
    for (const [requestId, entry] of pending) {
      entry.reject(new Error(reason ?? `Session crypto worker disposed: ${requestId}`));
    }
    pending.clear();
    try {
      worker.terminate();
    } catch {
      /* noop */
    }
  };

  worker.onmessage = (event: MessageEvent<SessionCryptoResponseMessage<unknown>>) => {
    const msg = event.data;
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);
    if (msg.ok) {
      entry.resolve(msg.result);
    } else {
      entry.reject(new Error(msg.error ?? "Session crypto worker error"));
    }
  };
  worker.onerror = (event) => {
    cleanup(event.message || "Session crypto worker error");
  };
  worker.onmessageerror = () => cleanup("Session crypto worker message error");

  const request = <T>(
    kind: string,
    payload: Record<string, unknown>,
    transfer: Transferable[] = []
  ): Promise<T> => {
    if (disposed) {
      return Promise.reject(new ActiveKeySessionRevokedError());
    }
    const requestId = randomId();
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      worker.postMessage({ kind, requestId, ...payload }, transfer);
    });
  };

  let identity: ActiveKeyCryptoIdentity;
  try {
    identity = (await request<ActiveKeyCryptoIdentity>(
      "init",
      {
        sessionId: input.sessionId,
        publicKeyHex: input.publicKeyHex,
        passwordKey: input.passwordKey,
        encryptedPrivateKey: input.encryptedPrivateKey,
        label: input.label,
        capabilities: input.capabilities,
        createdAt: input.createdAt
      },
    )) as ActiveKeyCryptoIdentity;
  } catch (err) {
    cleanup(err instanceof Error ? err.message : String(err));
    throw err;
  }

  const guard = (): void => {
    if (disposed) {
      throw new ActiveKeySessionRevokedError();
    }
  };

  return {
    getIdentity() {
      guard();
      return identity;
    },
    async signDigest(signInput): Promise<ActiveKeyCryptoSignDigestResult> {
      guard();
      const result = (await request<ActiveKeyCryptoSignDigestResult>(
        "signDigest",
        {
          publicKeyHex: signInput.publicKeyHex,
          digest: signInput.digest
        },
        [signInput.digest]
      )) as ActiveKeyCryptoSignDigestResult;
      return result;
    },
    async deriveP2pkhAddress(deriveInput) {
      guard();
      return (await request("deriveP2pkhAddress", deriveInput)) as {
        publicKeyHex: string;
        address: string;
      };
    },
    sealSendInput(sealInput) {
      guard();
      return request<ActiveKeyCryptoSealSendInputResult | { error: string }>("sealSendInput", {
        input: sealInput
      }) as never;
    },
    async openSealed(rec): Promise<AppMsgMessage | null> {
      guard();
      try {
        const opened = (await request<AppMsgMessage | null>("openSealed", {
          rec
        })) as AppMsgMessage | null;
        return opened;
      } catch {
        return null;
      }
    },
    async encryptVaultKeyMaterial(input) {
      guard();
      const encrypted = (await request<{
        cipherVersion: "v2";
        cipherSaltB64: string;
        cipherIvB64: string;
        cipherB64: string;
      }>("encryptVaultKeyMaterial", input)) as {
        cipherVersion: "v2";
        cipherSaltB64: string;
        cipherIvB64: string;
        cipherB64: string;
      };
      return encrypted;
    },
    dispose(reason = "dispose") {
      if (disposed) return;
      void request("dispose", { reason })
        .then(() => cleanup(reason))
        .catch(() => cleanup(reason));
      disposeCleanupTimer = setTimeout(() => {
        cleanup(reason);
      }, 50);
    }
  };
}

async function createLocalEngine(input: SessionCryptoEngineInput): Promise<SessionCryptoEngine> {
  const privateKeyBytes = await decryptSessionPrivateKeyBytes({
    passwordKey: input.passwordKey,
    encryptedPrivateKey: input.encryptedPrivateKey
  });
  verifySessionKeyPair({ publicKeyHex: input.publicKeyHex, privateKeyBytes });
  let revoked = false;
  const identity: ActiveKeyCryptoIdentity = {
    sessionId: input.sessionId,
    publicKeyHex: input.publicKeyHex,
    label: input.label,
    capabilities: input.capabilities,
    createdAt: input.createdAt
  };
  const guard = (): void => {
    if (revoked) throw new ActiveKeySessionRevokedError();
  };
  return {
    getIdentity() {
      guard();
      return identity;
    },
    async signDigest(signInput): Promise<ActiveKeyCryptoSignDigestResult> {
      guard();
      if (signInput.publicKeyHex !== input.publicKeyHex) {
        throw new Error("session_key_mismatch");
      }
      const sig = await signDigestBytes(privateKeyBytes, new Uint8Array(signInput.digest));
      return { publicKeyHex: input.publicKeyHex, signature: new Uint8Array(sig).buffer as ArrayBuffer };
    },
    async deriveP2pkhAddress(deriveInput) {
      guard();
      if (deriveInput.publicKeyHex !== input.publicKeyHex) {
        throw new Error("session_key_mismatch");
      }
      return {
        publicKeyHex: input.publicKeyHex,
        address: deriveP2pkhAddress(input.publicKeyHex, deriveInput.network)
      };
    },
    sealSendInput(sealInput) {
      guard();
      if (sealInput.sender.senderPublicKeyHex !== input.publicKeyHex) {
        return { error: "session_key_mismatch" };
      }
      try {
        const sealed = sealAppMessageLocalBytes({
          senderPrivateKeyBytes: privateKeyBytes,
          senderPublicKeyBytes: hexToBytes(input.publicKeyHex),
          recipientPublicKeyBytes: hexToBytes(sealInput.recipient.recipientPublicKeyHex),
          senderEndpoint: {
            kind: sealInput.sender.senderOrigin ? "origin" : "plugin",
            id: sealInput.sender.senderOrigin ?? sealInput.sender.senderAppId ?? ""
          },
          recipientEndpoint: {
            kind: sealInput.recipient.recipientOrigin ? "origin" : "plugin",
            id: sealInput.recipient.recipientOrigin ?? sealInput.recipient.recipientAppId ?? ""
          },
          contentType: sealInput.contentType,
          body: sealInput.body,
          clientMessageId: sealInput.clientMessageId,
          createdAtMs: sealInput.createdAtMs
        });
        return {
          record: {
            messageId: "",
            senderPublicKeyHex: input.publicKeyHex,
            senderEndpointId: sealInput.sender.senderOrigin ?? sealInput.sender.senderAppId ?? "",
            senderEndpointKind: sealInput.sender.senderOrigin ? "origin" : "plugin",
            recipientPublicKeyHex: sealInput.recipient.recipientPublicKeyHex,
            recipientEndpointId:
              sealInput.recipient.recipientOrigin ?? sealInput.recipient.recipientAppId ?? "",
            recipientEndpointKind: sealInput.recipient.recipientOrigin ? "origin" : "plugin",
            clientMessageId: sealInput.clientMessageId,
            createdAtMs: sealInput.createdAtMs,
            insertedAtMs: sealInput.createdAtMs,
            envelope: {
              envelopeBytes: sealed.envelope,
              signatureBytes: sealed.signatureBytes
            }
          }
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    async openSealed(rec): Promise<AppMsgMessage | null> {
      guard();
      try {
        const opened = openAppMessageLocalBytes({
          signed: rec.envelope,
          recipientPrivateKeyBytes: privateKeyBytes,
          recipientPublicKeyBytes: hexToBytes(input.publicKeyHex)
        });
        const bodyStr = new TextDecoder("utf-8", { fatal: true }).decode(opened.bodyUtf8);
        const out: AppMsgMessage = {
          messageId: rec.messageId,
          clientMessageId: opened.clientMessageId,
          senderPublicKeyHex: opened.senderPublicKeyHex,
          recipientPublicKeyHex: opened.recipientPublicKeyHex,
          contentType: opened.contentType,
          body: bodyStr,
          createdAtMs: opened.createdAtMs,
          insertedAtMs: rec.insertedAtMs
        };
        if (opened.senderEndpointKind === "origin") {
          return { ...out, senderOrigin: opened.senderEndpointId };
        }
        if (opened.senderEndpointKind === "plugin") {
          return { ...out, senderAppId: opened.senderEndpointId };
        }
        if (opened.recipientEndpointKind === "origin") {
          return { ...out, recipientOrigin: opened.recipientEndpointId };
        }
        if (opened.recipientEndpointKind === "plugin") {
          return { ...out, recipientAppId: opened.recipientEndpointId };
        }
        return out;
      } catch {
        return null;
      }
    },
    async encryptVaultKeyMaterial(encryptInput) {
      guard();
      return coordinatorEncryptVaultKeyMaterial(
        input.passwordKey,
        encryptInput.publicKeyHex,
        encryptInput.material
      );
    },
    dispose() {
      privateKeyBytes.fill(0);
      revoked = true;
    }
  };
}
