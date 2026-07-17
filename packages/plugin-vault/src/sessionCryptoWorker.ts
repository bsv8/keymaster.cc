// packages/plugin-vault/src/sessionCryptoWorker.ts
// Session Crypto Worker：持有单一 active private key 的最小受控执行环境。
//
// 设计缘由：
//   - 私钥 hex 只进入 worker 全局闭包，不进入插件 service / React state。
//   - worker 只接受显式 operation，不执行任意回调。

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
  SessionCryptoRequestMessage,
  SessionCryptoResponseMessage
} from "./sessionCryptoProtocol.js";

interface WorkerState {
  sessionId: string;
  publicKeyHex: string;
  passwordKey: CryptoKey;
  privateKeyBytes: Uint8Array;
  label: string;
  capabilities: string[];
  createdAt: string;
  revoked: boolean;
}

interface WorkerStateRef {
  current: WorkerState | null;
}

const singletonStateRef: WorkerStateRef = { current: null };

const workerScope = globalThis as unknown as {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<SessionCryptoRequestMessage>) => void
  ) => void;
  postMessage: (msg: SessionCryptoResponseMessage) => void;
};

function ensureState(stateRef: WorkerStateRef): WorkerState {
  if (!stateRef.current || stateRef.current.revoked) {
    throw new Error("Active key session has been revoked");
  }
  return stateRef.current;
}

function reply(message: SessionCryptoResponseMessage): void {
  workerScope.postMessage(message);
}

function closeWorkerScope(): void {
  const maybeClose = (globalThis as unknown as { close?: () => void }).close;
  if (typeof maybeClose === "function") {
    try {
      maybeClose.call(globalThis);
    } catch {
      /* noop */
    }
  }
}

function createSessionCryptoRequestHandler(stateRef: WorkerStateRef) {
  return async function handleRequest(
    message: SessionCryptoRequestMessage,
    scope: { postMessage: (msg: SessionCryptoResponseMessage) => void } = workerScope
  ): Promise<void> {
    const post = (msg: SessionCryptoResponseMessage): void => {
      scope.postMessage(msg);
    };
    switch (message.kind) {
      case "init": {
        if (stateRef.current && !stateRef.current.revoked) {
          throw new Error("Session crypto worker is already initialized");
        }
        const privateKeyBytes = await decryptSessionPrivateKeyBytes({
          passwordKey: message.passwordKey,
          encryptedPrivateKey: message.encryptedPrivateKey
        });
        verifySessionKeyPair({
          publicKeyHex: message.publicKeyHex,
          privateKeyBytes
        });
        stateRef.current = {
          sessionId: message.sessionId,
          publicKeyHex: message.publicKeyHex,
          passwordKey: message.passwordKey,
          privateKeyBytes,
          label: message.label,
          capabilities: message.capabilities,
          createdAt: message.createdAt,
          revoked: false
        };
        post({
          requestId: message.requestId,
          ok: true,
          result: {
            sessionId: message.sessionId,
            publicKeyHex: message.publicKeyHex,
            label: message.label,
            capabilities: message.capabilities,
            createdAt: message.createdAt
          }
        });
        return;
      }
      case "signDigest": {
        const s = ensureState(stateRef);
        if (message.publicKeyHex !== s.publicKeyHex) {
          throw new Error("session_key_mismatch");
        }
        post({
          requestId: message.requestId,
          ok: true,
          result: {
            publicKeyHex: s.publicKeyHex,
            signature: new Uint8Array(
              await signDigestBytes(s.privateKeyBytes, new Uint8Array(message.digest))
            ).buffer
          }
        });
        return;
      }
      case "deriveP2pkhAddress": {
        const s = ensureState(stateRef);
        if (message.publicKeyHex !== s.publicKeyHex) {
          throw new Error("session_key_mismatch");
        }
        post({
          requestId: message.requestId,
          ok: true,
          result: {
            publicKeyHex: s.publicKeyHex,
            address: deriveP2pkhAddress(s.publicKeyHex, message.network)
          }
        });
        return;
      }
      case "sealSendInput": {
        const s = ensureState(stateRef);
        if (message.input.sender.senderPublicKeyHex !== s.publicKeyHex) {
          post({
            requestId: message.requestId,
            ok: true,
            result: { error: "session_key_mismatch" }
          });
          return;
        }
        try {
          const sealed = sealAppMessageLocalBytes({
            senderPrivateKeyBytes: s.privateKeyBytes,
            senderPublicKeyBytes: hexToBytes(message.input.sender.senderPublicKeyHex),
            recipientPublicKeyBytes: hexToBytes(message.input.recipient.recipientPublicKeyHex),
            senderEndpoint: {
              kind: message.input.sender.senderOrigin ? "origin" : "plugin",
              id: message.input.sender.senderOrigin ?? message.input.sender.senderAppId ?? ""
            },
            recipientEndpoint: {
              kind: message.input.recipient.recipientOrigin ? "origin" : "plugin",
              id:
                message.input.recipient.recipientOrigin ??
                message.input.recipient.recipientAppId ??
                ""
            },
            contentType: message.input.contentType,
            body: message.input.body,
            clientMessageId: message.input.clientMessageId,
            createdAtMs: message.input.createdAtMs
          });
          post({
            requestId: message.requestId,
            ok: true,
            result: {
              record: {
                messageId: "",
                senderPublicKeyHex: s.publicKeyHex,
                senderEndpointId: message.input.sender.senderOrigin ?? message.input.sender.senderAppId ?? "",
                senderEndpointKind: message.input.sender.senderOrigin ? "origin" : "plugin",
                recipientPublicKeyHex: message.input.recipient.recipientPublicKeyHex,
                recipientEndpointId:
                  message.input.recipient.recipientOrigin ??
                  message.input.recipient.recipientAppId ??
                  "",
                recipientEndpointKind: message.input.recipient.recipientOrigin ? "origin" : "plugin",
                clientMessageId: message.input.clientMessageId,
                createdAtMs: message.input.createdAtMs,
                insertedAtMs: message.input.createdAtMs,
                envelope: {
                  envelopeBytes: sealed.envelope,
                  signatureBytes: sealed.signatureBytes
                }
              }
            }
          });
        } catch (err) {
          post({
            requestId: message.requestId,
            ok: true,
            result: { error: err instanceof Error ? err.message : String(err) }
          });
        }
        return;
      }
      case "openSealed": {
        const s = ensureState(stateRef);
        try {
          const opened = openAppMessageLocalBytes({
            signed: message.rec.envelope,
            recipientPrivateKeyBytes: s.privateKeyBytes,
            recipientPublicKeyBytes: hexToBytes(message.rec.recipientPublicKeyHex)
          });
          const bodyStr = new TextDecoder("utf-8", { fatal: true }).decode(opened.bodyUtf8);
          post({
            requestId: message.requestId,
            ok: true,
            result: {
              messageId: message.rec.messageId,
              clientMessageId: opened.clientMessageId,
              senderPublicKeyHex: opened.senderPublicKeyHex,
              recipientPublicKeyHex: opened.recipientPublicKeyHex,
              contentType: opened.contentType,
              body: bodyStr,
              createdAtMs: opened.createdAtMs,
              insertedAtMs: message.rec.insertedAtMs,
              senderEndpointKind: opened.senderEndpointKind,
              senderEndpointId: opened.senderEndpointId,
              recipientEndpointKind: opened.recipientEndpointKind,
              recipientEndpointId: opened.recipientEndpointId
            }
          });
        } catch {
          post({
            requestId: message.requestId,
            ok: true,
            result: null
          });
        }
        return;
      }
      case "encryptVaultKeyMaterial": {
        const s = ensureState(stateRef);
        const encrypted = await coordinatorEncryptVaultKeyMaterial(
          s.passwordKey,
          message.publicKeyHex,
          message.material
        );
        post({
          requestId: message.requestId,
          ok: true,
          result: encrypted
        });
        return;
      }
      case "dispose": {
        if (stateRef.current) {
          stateRef.current.privateKeyBytes.fill(0);
          stateRef.current.revoked = true;
        }
        stateRef.current = null;
        post({ requestId: message.requestId, ok: true, result: null });
        closeWorkerScope();
        return;
      }
    }
  };
}

const handleRequest = createSessionCryptoRequestHandler(singletonStateRef);

export async function __testHandleSessionCryptoRequest(
  message: SessionCryptoRequestMessage
): Promise<SessionCryptoResponseMessage[]> {
  const posted: SessionCryptoResponseMessage[] = [];
  try {
    await handleRequest(message, {
      postMessage(msg) {
        posted.push(msg);
      }
    });
  } catch (err) {
    const requestId = (message as { requestId?: string } | undefined)?.requestId ?? "unknown";
    posted.push({
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return posted;
}

export function __testCreateSessionCryptoRequestHandler() {
  const stateRef: WorkerStateRef = { current: null };
  const handle = createSessionCryptoRequestHandler(stateRef);
  return async function handleTestRequest(
    message: Record<string, unknown>
  ): Promise<SessionCryptoResponseMessage[]> {
    const typedMessage = message as unknown as SessionCryptoRequestMessage;
    const posted: SessionCryptoResponseMessage[] = [];
    try {
      await handle(typedMessage, {
        postMessage(msg) {
          posted.push(msg);
        }
      });
    } catch (err) {
      const requestId = (typedMessage as { requestId?: string } | undefined)?.requestId ?? "unknown";
      posted.push({
        requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return posted;
  };
}

if (typeof workerScope.addEventListener === "function") {
  workerScope.addEventListener("message", (event: MessageEvent<SessionCryptoRequestMessage>) => {
    void handleRequest(event.data).catch((err) => {
      const requestId = (event.data as { requestId?: string } | undefined)?.requestId ?? "unknown";
      reply({
        requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  });
}
