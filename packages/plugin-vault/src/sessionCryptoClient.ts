// packages/plugin-vault/src/sessionCryptoClient.ts
// Session Crypto capability client。
//
// 设计缘由（施工单 002 硬切换）：
//   - 所有 Keymaster 主页面 tab 共享同一个 SharedWorker 中的 Vault 会话
//   - 私钥只在 Worker 内存中，永不离开
//   - 删除每 tab 独立 Dedicated Worker 的旧路径
//   - 本地实现只允许通过显式测试开关注入，生产路径 fail closed
//
// 施工单 001：signDigest 必须显式传递 format 参数

import type {
  ActiveKeyCryptoIdentity,
  ActiveKeyCryptoSealSendInputResult,
  ActiveKeyCryptoSignDigestResult,
  AppMsgMessage,
  EcdsaSignatureFormat,
  ProviderSealedMessageRecord
} from "@keymaster/contracts";
import { ActiveKeySessionRevokedError } from "@keymaster/contracts";
import type { ActiveKeyCrypto } from "@keymaster/contracts";
import type {
  CoordinatorClientRequest,
  CoordinatorResponse,
  CoordinatorCryptoOperation,
  CoordinatorCryptoResult,
  SessionEpoch
} from "@keymaster/contracts";
import {
  deriveP2pkhAddress,
  hexToBytes,
  openAppMessageLocalBytes,
  sealAppMessageLocalBytes,
  signEcdsaDigest,
  verifySessionKeyPair
} from "./sessionCryptoCore.js";
import type {
  SessionCryptoBootstrapInput,
  SessionCryptoResponseMessage
} from "./sessionCryptoProtocol.js";

interface SessionCryptoEngineInput extends SessionCryptoBootstrapInput {}

interface SessionCryptoEngine {
  getIdentity(): ActiveKeyCryptoIdentity;
  signDigest(input: { publicKeyHex: string; digest: ArrayBuffer; format: EcdsaSignatureFormat }): Promise<ActiveKeyCryptoSignDigestResult>;
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
  }): Promise<ActiveKeyCryptoSealSendInputResult | { error: string }> | ActiveKeyCryptoSealSendInputResult | { error: string };
  openSealed(rec: ProviderSealedMessageRecord): Promise<AppMsgMessage | null>;
  dispose(reason?: string): void;
}

export interface SessionCryptoClientOptions {
  engineFactory?: (input: SessionCryptoEngineInput) => Promise<SessionCryptoEngine>;
  allowLocalEngineForTests?: boolean;
  /** Coordinator SharedWorker 连接（施工单 002） */
  coordinatorPort?: MessagePort;
  sessionEpoch?: SessionEpoch;
  mode?: "keymaster" | "appview";
}

function randomId(): string {
  return crypto.randomUUID();
}

/**
 * 通过 Coordinator SharedWorker 执行 crypto 操作。
 * 设计缘由（施工单 002）：所有 tab 共享同一个 Worker，私钥永不离开 Worker。
 */
async function requestCoordinatorCrypto(
  port: MessagePort,
  operation: CoordinatorCryptoOperation,
  sessionEpoch: SessionEpoch
): Promise<CoordinatorCryptoResult> {
  const requestId = randomId();
  return new Promise<CoordinatorCryptoResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      port.removeEventListener("message", handler);
      reject(new Error("Coordinator crypto request timeout"));
    }, 30000);

    const handler = (event: MessageEvent<CoordinatorResponse>) => {
      const msg = event.data;
      if (msg.requestId !== requestId) return;
      clearTimeout(timeout);
      port.removeEventListener("message", handler);

      if (msg.ack.status === "ok" && msg.cryptoResult) {
        resolve(msg.cryptoResult);
      } else {
        reject(new Error(
          msg.ack.status === "error" ? msg.ack.message :
          msg.ack.status === "blocked" ? (typeof msg.ack.reason === "string" ? msg.ack.reason : msg.ack.reason.fallback) :
          `Crypto operation failed: ${msg.ack.status}`
        ));
      }
    };

    port.addEventListener("message", handler);
    port.start();

    const request: CoordinatorClientRequest = {
      kind: "crypto",
      clientId: "session-crypto-client",
      requestId,
      operation,
      expectedSessionEpoch: sessionEpoch
    };
    port.postMessage(request);
  });
}

export async function createSessionCryptoEngine(
  input: SessionCryptoEngineInput,
  options: SessionCryptoClientOptions = {}
): Promise<SessionCryptoEngine> {
  if (options.engineFactory) {
    return options.engineFactory(input);
  }

  // 施工单 002：优先使用 Coordinator SharedWorker（Keymaster 主页面）
  if (options.coordinatorPort) {
    return createCoordinatorBackedEngine(input, options.coordinatorPort, options.sessionEpoch ?? "boot");
  }

  if (options.mode !== "appview") {
    throw new Error("Keymaster session crypto requires the Session Coordinator");
  }

  // appView session：显式授权后才使用独立 Worker
  // 施工单 002：appView session 仍按其专属、显式授权的会话 Worker 运行，
  // 不连接主 Coordinator，不继承主页面的全局解锁态。
  const canUseWorker = typeof Worker !== "undefined";
  if (canUseWorker) {
    return createWorkerBackedEngine(input);
  }

  // 无 Worker 环境：仅测试显式允许本地 engine
  if (options.allowLocalEngineForTests) {
    return createLocalEngine(input);
  }
  throw new Error("Session crypto worker is unavailable");
}

/**
 * 通过独立 Worker 创建 crypto engine（用于 appView session）。
 * 设计缘由（施工单 002）：appView session 仍按其专属、显式授权的会话 Worker 运行。
 */
async function createWorkerBackedEngine(
  input: SessionCryptoEngineInput
): Promise<SessionCryptoEngine> {
  // 使用 globalThis.Worker 以便测试可以 stub
  const WorkerConstructor = (globalThis as { Worker?: typeof Worker }).Worker ?? Worker;
  const worker = new WorkerConstructor(new URL("./sessionCryptoWorker.ts", import.meta.url), {
    type: "module"
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending = new Map<string, { resolve: (value: any) => void; reject: (reason?: unknown) => void }>();
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
        privateKeyBytes: input.privateKeyBytes,
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
          digest: signInput.digest,
          format: signInput.format
        },
        [signInput.digest]
      )) as ActiveKeyCryptoSignDigestResult;
      // P0: 回包 format 必须与请求一致，防止 Worker 返回错误格式的签名
      if (result.format !== signInput.format) {
        throw new Error(
          `signDigest format mismatch: requested "${signInput.format}", got "${result.format}"`
        );
      }
      return result;
    },
    async deriveP2pkhAddress(deriveInput) {
      guard();
      return (await request("deriveP2pkhAddress", deriveInput)) as {
        publicKeyHex: string;
        address: string;
      };
    },
    async sealSendInput(sealInput) {
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

/**
 * 通过 Coordinator SharedWorker 创建 crypto engine。
 * 设计缘由（施工单 002）：所有 tab 共享同一个 Worker，私钥永不离开 Worker。
 */
async function createCoordinatorBackedEngine(
  input: SessionCryptoEngineInput,
  port: MessagePort,
  sessionEpoch: SessionEpoch
): Promise<SessionCryptoEngine> {
  let disposed = false;

  const identity: ActiveKeyCryptoIdentity = {
    sessionId: input.sessionId,
    publicKeyHex: input.publicKeyHex,
    label: input.label,
    capabilities: input.capabilities,
    createdAt: input.createdAt
  };

  const guard = (): void => {
    if (disposed) {
      throw new ActiveKeySessionRevokedError();
    }
  };

  const cryptoRequest = async (operation: CoordinatorCryptoOperation): Promise<CoordinatorCryptoResult> => {
    guard();
    return requestCoordinatorCrypto(port, operation, sessionEpoch);
  };

  return {
    getIdentity() {
      guard();
      return identity;
    },
    async signDigest(signInput): Promise<ActiveKeyCryptoSignDigestResult> {
      // 将 ArrayBuffer 转为 hex 字符串
      const digestBytes = new Uint8Array(signInput.digest);
      const digestHex = Array.from(digestBytes).map(b => b.toString(16).padStart(2, "0")).join("");
      const result = await cryptoRequest({
        type: "signDigest",
        digestHex,
        format: signInput.format
      });
      if (result.type !== "signDigest") throw new Error("Unexpected result type");
      // P0: 校验 Coordinator 回包 format 为合法值且与请求一致
      if (result.format !== "der" && result.format !== "compact") {
        throw new Error(`signDigest: unexpected format "${result.format}" from Coordinator`);
      }
      if (result.format !== signInput.format) {
        throw new Error(
          `signDigest format mismatch: requested "${signInput.format}", got "${result.format}"`
        );
      }
      return {
        publicKeyHex: input.publicKeyHex,
        format: result.format,
        signature: hexToBytes(result.signatureHex).buffer as ArrayBuffer
      };
    },
    async deriveP2pkhAddress(deriveInput) {
      const result = await cryptoRequest({
        type: "deriveP2pkhAddress",
        network: deriveInput.network
      });
      if (result.type !== "deriveP2pkhAddress") throw new Error("Unexpected result type");
      return {
        publicKeyHex: input.publicKeyHex,
        address: result.address
      };
    },
    async sealSendInput(sealInput) {
      const result = await cryptoRequest({ type: "sealSendInput", input: sealInput });
      if (result.type !== "sealSendInput") return { error: "Unexpected result type" };
      return { record: { messageId: "", senderPublicKeyHex: sealInput.sender.senderPublicKeyHex, senderEndpointId: sealInput.sender.senderOrigin ?? sealInput.sender.senderAppId ?? "", senderEndpointKind: sealInput.sender.senderOrigin ? "origin" : "plugin", recipientPublicKeyHex: sealInput.recipient.recipientPublicKeyHex, recipientEndpointId: sealInput.recipient.recipientOrigin ?? sealInput.recipient.recipientAppId ?? "", recipientEndpointKind: sealInput.recipient.recipientOrigin ? "origin" : "plugin", clientMessageId: sealInput.clientMessageId, createdAtMs: sealInput.createdAtMs, insertedAtMs: Date.now(), envelope: { envelopeBytes: result.envelope, signatureBytes: result.signature } } } as unknown as ActiveKeyCryptoSealSendInputResult;
    },
    async openSealed(rec): Promise<AppMsgMessage | null> {
      try {
        const result = await cryptoRequest({
          type: "openSealed",
          record: rec
        });
        if (result.type !== "openSealed") return null;
        return JSON.parse(new TextDecoder().decode(result.plaintext)) as AppMsgMessage;
      } catch {
        return null;
      }
    },
    dispose(reason = "dispose") {
      if (disposed) return;
      disposed = true;
      // Coordinator port 不需要 terminate，由 Coordinator 管理生命周期
    }
  };
}

/**
 * 本地测试用 engine。
 * 设计缘由：仅允许通过显式测试开关注入，生产路径 fail closed。
 * 施工单 002：生产代码不得使用此路径。
 */
async function createLocalEngine(input: SessionCryptoEngineInput): Promise<SessionCryptoEngine> {
  const privateKeyBytes = input.privateKeyBytes;
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
      const sig = await signEcdsaDigest({
        privateKeyBytes,
        digest: new Uint8Array(signInput.digest),
        format: signInput.format
      });
      return { publicKeyHex: input.publicKeyHex, format: signInput.format, signature: new Uint8Array(sig).buffer as ArrayBuffer };
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
    async sealSendInput(sealInput) {
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
    dispose() {
      privateKeyBytes.fill(0);
      revoked = true;
    }
  };
}
