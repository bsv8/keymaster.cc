// Session Crypto capability client。
//
// 主页面使用 Coordinator RPC；appView 使用当前 Session Window 的专用 Worker。
// 私钥不会回到页面，消息加密/解密由 Coordinator 内的 ChannelProtocol 完成。

import type {
  ActiveKeyCryptoIdentity,
  ActiveKeyCryptoSignDigestResult,
  CoordinatorClientRequest,
  CoordinatorCryptoOperation,
  CoordinatorCryptoResult,
  CoordinatorResponse,
  EcdsaSignatureFormat,
  SessionEpoch
} from "@keymaster/contracts";
import { ActiveKeySessionRevokedError } from "@keymaster/contracts";
import {
  deriveP2pkhAddress,
  hexToBytes,
  signEcdsaDigest,
  verifySessionKeyPair
} from "./sessionCryptoCore.js";
import type {
  SessionCryptoBootstrapInput,
  SessionCryptoResponseMessage
} from "./sessionCryptoProtocol.js";

export interface SessionCryptoEngine {
  getIdentity(): ActiveKeyCryptoIdentity;
  signDigest(input: { publicKeyHex: string; digest: ArrayBuffer; format: EcdsaSignatureFormat }): Promise<ActiveKeyCryptoSignDigestResult>;
  deriveP2pkhAddress(input: { publicKeyHex: string; network: "main" | "test" }): Promise<{ publicKeyHex: string; address: string }>;
  dispose(reason?: string): void;
}

export interface SessionCryptoClientOptions {
  engineFactory?: (input: SessionCryptoBootstrapInput) => Promise<SessionCryptoEngine>;
  allowLocalEngineForTests?: boolean;
  /** 浏览器宿主提供的 Dedicated Worker 工厂；Vite 等构建器需在应用入口编译 Worker。 */
  workerFactory?: () => Worker;
  /** 主页面 Coordinator SharedWorker 连接。 */
  coordinatorPort?: MessagePort;
  sessionEpoch?: SessionEpoch;
  mode?: "keymaster" | "appview";
}

function randomId(): string {
  return crypto.randomUUID();
}

async function requestCoordinatorCrypto(
  port: MessagePort,
  operation: CoordinatorCryptoOperation,
  sessionEpoch: SessionEpoch
): Promise<CoordinatorCryptoResult> {
  const requestId = randomId();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      port.removeEventListener("message", handler);
      reject(new Error("Coordinator crypto request timeout"));
    }, 30000);
    const handler = (event: MessageEvent<CoordinatorResponse>): void => {
      if (event.data.requestId !== requestId) return;
      clearTimeout(timeout);
      port.removeEventListener("message", handler);
      const response = event.data;
      if (response.ack.status === "ok" && response.cryptoResult) {
        resolve(response.cryptoResult);
      } else {
        reject(new Error(
          response.ack.status === "error"
            ? response.ack.message
            : response.ack.status === "blocked"
              ? typeof response.ack.reason === "string" ? response.ack.reason : response.ack.reason.fallback
              : `Crypto operation failed: ${response.ack.status}`
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
  input: SessionCryptoBootstrapInput,
  options: SessionCryptoClientOptions = {}
): Promise<SessionCryptoEngine> {
  if (options.engineFactory) return options.engineFactory(input);
  if (options.coordinatorPort) {
    return createCoordinatorBackedEngine(input, options.coordinatorPort, options.sessionEpoch ?? "boot");
  }
  if (options.mode !== "appview") throw new Error("Keymaster session crypto requires the Session Coordinator");
  if (typeof Worker !== "undefined") return createWorkerBackedEngine(input, options.workerFactory);
  if (options.allowLocalEngineForTests) return createLocalEngine(input);
  throw new Error("Session crypto worker is unavailable");
}

async function createWorkerBackedEngine(
  input: SessionCryptoBootstrapInput,
  workerFactory?: () => Worker,
): Promise<SessionCryptoEngine> {
  const WorkerConstructor = (globalThis as { Worker?: typeof Worker }).Worker ?? Worker;
  // 包源码默认路径适用于直接由包构建器编译的宿主；Vite workspace 应通过
  // workerFactory 注入应用内 Worker 入口，避免把源码 .ts 当作静态资源发送。
  const worker = workerFactory?.() ?? new WorkerConstructor(new URL("./sessionCryptoWorker.ts", import.meta.url), { type: "module" });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();
  // revoked 表示对调用方立即失效；cleanedUp 表示底层 Worker 已经终止。
  // 两者不能共用一个状态，否则 dispose 先标记后会跳过真正的资源清理。
  let revoked = false;
  let cleanedUp = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (reason?: string): void => {
    if (cleanedUp) return;
    revoked = true;
    cleanedUp = true;
    if (cleanupTimer) clearTimeout(cleanupTimer);
    for (const entry of pending.values()) entry.reject(new Error(reason ?? "Session crypto worker disposed"));
    pending.clear();
    try { worker.terminate(); } catch { /* noop */ }
  };
  worker.onmessage = (event: MessageEvent<SessionCryptoResponseMessage<unknown>>): void => {
    const entry = pending.get(event.data.requestId);
    if (!entry) return;
    pending.delete(event.data.requestId);
    if (event.data.ok) entry.resolve(event.data.result);
    else entry.reject(new Error(event.data.error));
  };
  worker.onerror = (event) => cleanup(event.message || "Session crypto worker error");
  worker.onmessageerror = () => cleanup("Session crypto worker message error");

  const request = <T>(
    kind: string,
    payload: Record<string, unknown>,
    transfer: Transferable[] = [],
    allowRevoked = false,
  ): Promise<T> => {
    if (revoked && !allowRevoked) return Promise.reject(new ActiveKeySessionRevokedError());
    const requestId = randomId();
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ kind, requestId, ...payload }, transfer);
    });
  };

  let identity: ActiveKeyCryptoIdentity;
  try {
    // appView 只把私钥 buffer 转移给 Dedicated Worker，不保留页面侧的
    // structured-clone 副本；初始化失败也必须立即终止这个 Worker。
    identity = await request<ActiveKeyCryptoIdentity>("init", {
      sessionId: input.sessionId,
      publicKeyHex: input.publicKeyHex,
      privateKeyBytes: input.privateKeyBytes,
      label: input.label,
      capabilities: input.capabilities,
      createdAt: input.createdAt
    }, [input.privateKeyBytes.buffer as ArrayBuffer]);
  } catch (error) {
    cleanup(error instanceof Error ? error.message : "Session crypto worker initialization failed");
    throw error;
  }
  const guard = (): void => {
    if (revoked) throw new ActiveKeySessionRevokedError();
  };
  return {
    getIdentity: () => { guard(); return identity; },
    async signDigest(signInput) {
      guard();
      const result = await request<ActiveKeyCryptoSignDigestResult>("signDigest", {
        publicKeyHex: signInput.publicKeyHex,
        digest: signInput.digest,
        format: signInput.format
    }, [signInput.digest]);
      if (result.format !== signInput.format) throw new Error("signDigest format mismatch");
      return result;
    },
    async deriveP2pkhAddress(deriveInput) {
      guard();
      return request<{ publicKeyHex: string; address: string }>("deriveP2pkhAddress", deriveInput);
    },
    dispose(reason = "dispose") {
      if (revoked) return;
      // 先撤销公开能力，再允许一次内部 dispose 请求完成 Worker 侧擦除。
      // request 的调用会同步完成 postMessage，因此此处标记不会丢失销毁消息。
      void request("dispose", { reason }, [], true).finally(() => cleanup(reason));
      revoked = true;
      cleanupTimer = setTimeout(() => cleanup(reason), 50);
    }
  };
}

async function createCoordinatorBackedEngine(
  input: SessionCryptoBootstrapInput,
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
  const guard = (): void => { if (disposed) throw new ActiveKeySessionRevokedError(); };
  const call = (operation: CoordinatorCryptoOperation): Promise<CoordinatorCryptoResult> => {
    guard();
    return requestCoordinatorCrypto(port, operation, sessionEpoch);
  };
  return {
    getIdentity: () => { guard(); return identity; },
    async signDigest(signInput) {
      const result = await call({
        type: "signDigest",
        digestHex: Array.from(new Uint8Array(signInput.digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        format: signInput.format
      });
      if (result.type !== "signDigest" || result.format !== signInput.format) throw new Error("signDigest response mismatch");
      const signature = hexToBytes(result.signatureHex);
      return { publicKeyHex: input.publicKeyHex, format: result.format, signature: signature.slice().buffer as ArrayBuffer };
    },
    async deriveP2pkhAddress(deriveInput) {
      const result = await call({ type: "deriveP2pkhAddress", network: deriveInput.network });
      if (result.type !== "deriveP2pkhAddress") throw new Error("deriveP2pkhAddress response mismatch");
      return { publicKeyHex: input.publicKeyHex, address: result.address };
    },
    dispose() { disposed = true; }
  };
}

async function createLocalEngine(input: SessionCryptoBootstrapInput): Promise<SessionCryptoEngine> {
  verifySessionKeyPair({ publicKeyHex: input.publicKeyHex, privateKeyBytes: input.privateKeyBytes });
  let disposed = false;
  const identity: ActiveKeyCryptoIdentity = {
    sessionId: input.sessionId,
    publicKeyHex: input.publicKeyHex,
    label: input.label,
    capabilities: input.capabilities,
    createdAt: input.createdAt
  };
  const guard = (): void => { if (disposed) throw new ActiveKeySessionRevokedError(); };
  return {
    getIdentity: () => { guard(); return identity; },
    async signDigest(signInput) {
      guard();
      if (signInput.publicKeyHex !== input.publicKeyHex) throw new Error("session_key_mismatch");
      const signature = await signEcdsaDigest({ privateKeyBytes: input.privateKeyBytes, digest: new Uint8Array(signInput.digest), format: signInput.format });
      return { publicKeyHex: input.publicKeyHex, format: signInput.format, signature: signature.slice().buffer as ArrayBuffer };
    },
    async deriveP2pkhAddress(deriveInput) {
      guard();
      if (deriveInput.publicKeyHex !== input.publicKeyHex) throw new Error("session_key_mismatch");
      return { publicKeyHex: input.publicKeyHex, address: deriveP2pkhAddress(input.publicKeyHex, deriveInput.network) };
    },
    dispose() {
      if (disposed) return;
      input.privateKeyBytes.fill(0);
      disposed = true;
    }
  };
}
