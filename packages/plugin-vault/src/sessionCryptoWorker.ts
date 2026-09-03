// appView Session Window 的专用密码学 Worker。
// 私钥只存在 worker 状态中；Channel 消息格式由 Coordinator 使用 ChannelProtocol
// 处理，本 Worker 不实现消息信封。

import {
  deriveP2pkhAddress,
  signEcdsaDigest,
  verifySessionKeyPair
} from "./sessionCryptoCore.js";
import type {
  SessionCryptoRequestMessage,
  SessionCryptoResponseMessage
} from "./sessionCryptoProtocol.js";

interface WorkerState {
  sessionId: string;
  publicKeyHex: string;
  privateKeyBytes: Uint8Array;
  label: string;
  capabilities: string[];
  createdAt: string;
}

interface WorkerStateRef { current: WorkerState | null; }
const singletonStateRef: WorkerStateRef = { current: null };
const workerScope = globalThis as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<SessionCryptoRequestMessage>) => void) => void;
  postMessage: (message: SessionCryptoResponseMessage) => void;
};

function ensureState(ref: WorkerStateRef): WorkerState {
  if (!ref.current) throw new Error("Active key session has been revoked");
  return ref.current;
}

function closeWorker(): void {
  const close = (globalThis as { close?: () => void }).close;
  try { close?.(); } catch { /* noop */ }
}

function createHandler(ref: WorkerStateRef) {
  return async function handle(
    message: SessionCryptoRequestMessage,
    scope: { postMessage: (message: SessionCryptoResponseMessage) => void } = workerScope
  ): Promise<void> {
    const post = (response: SessionCryptoResponseMessage): void => scope.postMessage(response);
    try {
      switch (message.kind) {
        case "init": {
          if (ref.current) throw new Error("Session crypto worker is already initialized");
          verifySessionKeyPair({ publicKeyHex: message.publicKeyHex, privateKeyBytes: message.privateKeyBytes });
          ref.current = {
            sessionId: message.sessionId,
            publicKeyHex: message.publicKeyHex,
            privateKeyBytes: message.privateKeyBytes,
            label: message.label,
            capabilities: [...message.capabilities],
            createdAt: message.createdAt
          };
          post({ requestId: message.requestId, ok: true, result: {
            sessionId: message.sessionId,
            publicKeyHex: message.publicKeyHex,
            label: message.label,
            capabilities: [...message.capabilities],
            createdAt: message.createdAt
          } });
          return;
        }
        case "signDigest": {
          const state = ensureState(ref);
          if (message.publicKeyHex !== state.publicKeyHex) throw new Error("session_key_mismatch");
          const signature = await signEcdsaDigest({
            privateKeyBytes: state.privateKeyBytes,
            digest: new Uint8Array(message.digest),
            format: message.format
          });
          post({ requestId: message.requestId, ok: true, result: {
            publicKeyHex: state.publicKeyHex,
            format: message.format,
            signature: signature.buffer
          } });
          return;
        }
        case "deriveP2pkhAddress": {
          const state = ensureState(ref);
          if (message.publicKeyHex !== state.publicKeyHex) throw new Error("session_key_mismatch");
          post({ requestId: message.requestId, ok: true, result: {
            publicKeyHex: state.publicKeyHex,
            address: deriveP2pkhAddress(state.publicKeyHex, message.network)
          } });
          return;
        }
        case "dispose":
          ref.current?.privateKeyBytes.fill(0);
          ref.current = null;
          post({ requestId: message.requestId, ok: true, result: null });
          closeWorker();
          return;
      }
    } catch (error) {
      post({ requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

const handleRequest = createHandler(singletonStateRef);
if (typeof workerScope.addEventListener === "function") {
  workerScope.addEventListener("message", (event) => { void handleRequest(event.data); });
}

/** 测试接缝：直接运行一次 Worker 请求并返回回包。 */
export async function __testHandleSessionCryptoRequest(
  message: SessionCryptoRequestMessage
): Promise<SessionCryptoResponseMessage[]> {
  const posted: SessionCryptoResponseMessage[] = [];
  await handleRequest(message, { postMessage: (response) => posted.push(response) });
  return posted;
}

/** 测试接缝：创建隔离的 session crypto worker 状态，模拟多个 app session。 */
export function __testCreateSessionCryptoRequestHandler():
  (message: SessionCryptoRequestMessage) => Promise<SessionCryptoResponseMessage[]> {
  const ref: WorkerStateRef = { current: null };
  const isolatedHandle = createHandler(ref);
  return async (message) => {
    const posted: SessionCryptoResponseMessage[] = [];
    await isolatedHandle(message, { postMessage: (response) => posted.push(response) });
    return posted;
  };
}
