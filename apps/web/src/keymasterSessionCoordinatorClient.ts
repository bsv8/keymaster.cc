// apps/web/src/keymasterSessionCoordinatorClient.ts
// Keymaster Session Coordinator Client Transport
//
// 设计缘由（施工单 002）：
//   - 版本化 URL、port 生命周期、hello 重连
//   - requestId pending map、epoch cache、subscription event 分发
//   - port 断开仅拒绝本 tab pending request，不发全局 lock

import type {
  SessionEpoch,
  CoordinatorVaultStatus,
  CoordinatorClientRequest,
  CoordinatorResponse,
  CoordinatorTopicEvent,
  CoordinatorBootstrapSnapshot,
  CoordinatorTopic,
  CoordinatorCommandResult,
  CoordinatorValueResult,
  CoordinatorTransportFailure,
  CoordinatorCryptoOperation,
  CoordinatorCryptoResult,
  CoordinatorBackgroundSyncSettings,
  CoordinatorTaskSnapshot,
  CoordinatorVaultOperation,
  CoordinatorSubscribeTopicsResult,
  SessionCoordinatorClient,
  CoordinatorStorageControl,
  CoordinatorStorageData,
  P2pkhProviderRegistrySnapshot,
  P2pkhNetworkProviderSelection,
} from "@keymaster/contracts";

// ============================================================
// 1. Client Types
// ============================================================

export interface CoordinatorClientOptions {
  workerName?: string;
  workerUrl?: string;
  clientId?: string;
  requestTimeoutMs?: number;
  reconnectIntervalMs?: number;
}

export interface RecoverableCoordinatorDiagnostic {
  kind: string;
  status: string;
  message: string;
  sessionEpoch: SessionEpoch;
  connected: boolean;
}

type EventListener<T> = (event: T) => void;

type CoordinatorDispatchStatus = "not-dispatched" | "unknown";
type CoordinatorSendError = Error & { dispatchStatus?: CoordinatorDispatchStatus };

function coordinatorSendError(message: string, dispatchStatus: CoordinatorDispatchStatus): CoordinatorSendError {
  const error = new Error(message) as CoordinatorSendError;
  error.dispatchStatus = dispatchStatus;
  return error;
}

// ============================================================
// 2. Coordinator Client
// ============================================================

export class KeymasterSessionCoordinatorClient implements SessionCoordinatorClient {
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private clientId: string;
  private workerName?: string;
  private workerUrl?: string;
  private requestTimeoutMs: number;
  private reconnectIntervalMs: number;

  private bootstrapSnapshotCache: CoordinatorBootstrapSnapshot = {
    sessionEpoch: "boot",
    vaultStatus: "booting",
    keyspaceGeneration: 0,
    taskSnapshots: [],
    scheduleSettings: { assetHoldingsIntervalMs: 900_000 },
    p2pkhProviders: undefined,
  };

  private pendingRequests = new Map<
    string,
    {
      resolve: (response: CoordinatorResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  private eventListeners = new Map<string, Set<EventListener<CoordinatorTopicEvent>>>();
  private topicCaches = new Map<CoordinatorTopic, CoordinatorTopicEvent>();
  private sessionRevisionCache = -1;
  private backgroundSnapshotRevisionCache = -1;
  private assetDataRevisionCache = -1;
  private storageRevisionCache = -1;
  private msfileRevisionCache = -1;
  private p2pkhProviderRevisionCache = -1;

  private isConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private recoverableDiagnostics: RecoverableCoordinatorDiagnostic[] = [];

  constructor(options: CoordinatorClientOptions = {}) {
    // 默认使用 unnamed SharedWorker：浏览器以最终构建后的 hashed URL
    // 作为共享身份，同一发布的多个 tab 仍共享；新发布 URL 变化后不会
    // 错连仍存活的旧协议 Worker。显式 workerName 仅供测试/定制宿主。
    this.workerName = options.workerName;
    this.workerUrl = options.workerUrl;
    this.clientId = options.clientId ?? this.generateClientId();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 5_000;
  }

  // ============================================================
  // 3. Connection Management
  // ============================================================

  async connect(): Promise<void> {
    if (this.isConnected) return;

    try {
      if (typeof SharedWorker === "undefined") {
        throw new Error("Session Coordinator requires SharedWorker support");
      }
      let workerLocationLabel = "bundled versioned module URL";
      if (this.workerUrl) {
        const customWorkerUrl = new URL(
          this.workerUrl,
          typeof globalThis.location?.href === "string"
            ? globalThis.location.href
            : import.meta.url
        );
        workerLocationLabel = customWorkerUrl.pathname;
        this.worker = new SharedWorker(customWorkerUrl, {
          ...(this.workerName ? { name: this.workerName } : {}),
          type: "module"
        });
      } else if (this.workerName) {
        // Vite 要求 new URL(...) 直接出现在 Worker 构造器中，才能把
        // TypeScript worker 编译成带 hash 的 JavaScript 产物。
        this.worker = new SharedWorker(
          new URL("./keymasterSessionCoordinator.worker.ts", import.meta.url),
          { name: this.workerName, type: "module" }
        );
      } else {
        // SharedWorker 的身份由最终 URL 决定。开发服务器下源码 URL 不会像
        // 生产构建一样自动带 content hash，页面刷新可能继续连接仍驻留内存
        // 的旧 worker。开发环境用带 revision 的名称切换实例；生产环境的
        // unnamed worker 仍由最终构建的 hashed URL 做版本隔离。
        const isDevelopment = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
        if (isDevelopment) {
          this.worker = new SharedWorker(
            new URL("./keymasterSessionCoordinator.worker.ts", import.meta.url),
            { name: "keymaster-coordinator-dev-20260818-woc-raw-text", type: "module" }
          );
        } else {
          this.worker = new SharedWorker(
            new URL("./keymasterSessionCoordinator.worker.ts", import.meta.url),
            { type: "module" }
          );
        }
      }
      this.worker.onerror = (event) => {
        const details: string[] = [];
        if ("message" in event && typeof event.message === "string" && event.message) {
          details.push(event.message);
        }
        if ("filename" in event && typeof event.filename === "string" && event.filename) {
          const line = "lineno" in event && typeof event.lineno === "number" ? event.lineno : 0;
          const column = "colno" in event && typeof event.colno === "number" ? event.colno : 0;
          details.push(`${event.filename}:${line}:${column}`);
        }
        if ("error" in event && event.error instanceof Error && event.error.stack) {
          details.push(event.error.stack);
        }
        const message = details.length
          ? `Coordinator worker error: ${details.join(" | ")}`
          : `Coordinator worker error while loading ${workerLocationLabel}`;
        this.handleWorkerError(message);
      };

      this.port = this.worker.port;
      this.port.onmessage = this.handleMessage.bind(this);
      this.port.onmessageerror = this.handleMessageError.bind(this);
      this.port.start();

      this.isConnected = true;
      await this.sendHello();
      await this.subscribeTopicsAndReadBaselines(["session.state", "background.snapshot", "asset.data-changed", "storage.state", "p2pkh.providers", "msfile.state"]);

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    } catch (err) {
      this.isConnected = false;
      this.scheduleReconnect();
      throw err;
    }
  }

  disconnect(): void {
    if (this.port) {
      try { this.port.postMessage({ kind: "disconnect", clientId: this.clientId, requestId: this.generateRequestId() }); } catch { /* messageerror/close fallback */ }
      this.port.close();
      this.port = null;
    }

    this.worker = null;
    this.isConnected = false;
    this.resetDisconnectedState();

    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Client disconnected"));
      this.pendingRequests.delete(requestId);
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, this.reconnectIntervalMs);
  }

  // ============================================================
  // 4. Message Handling
  // ============================================================

  private handleMessage(event: MessageEvent): void {
    const data = event.data;

    // Coordinator 事件不依赖 requestId；先按 type 分流，兼容早期 Worker
    // 曾错误附加 requestId 的状态事件，避免它们被当成 RPC 响应丢弃。
    if (data && typeof data === "object" && "type" in data) {
      if (!("topic" in data)) return;
      const event = data as CoordinatorTopicEvent;
      this.handleEvent(event);
      return;
    }

    if (data && typeof data === "object" && "requestId" in data) {
      const response = data as CoordinatorResponse;
      this.handleResponse(response);
      return;
    }
  }

  private handleResponse(response: CoordinatorResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.requestId);

    this.bootstrapSnapshotCache.sessionEpoch = response.sessionEpoch;
    if (response.operationResult && typeof response.operationResult === "object" && "vaultStatus" in response.operationResult) {
      const snapshot = response.operationResult as CoordinatorBootstrapSnapshot;
      this.bootstrapSnapshotCache = { ...this.bootstrapSnapshotCache, ...snapshot, taskSnapshots: [...snapshot.taskSnapshots] };
    }
    pending.resolve(response);
  }

  private handleEvent(event: CoordinatorTopicEvent): void {
    this.applyTopicEvent(event);
  }

  private handleMessageError(): void {
    this.handleWorkerError("Coordinator transport error");
  }

  private handleWorkerError(message: string): void {
    this.isConnected = false;
    this.resetDisconnectedState();
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pendingRequests.delete(requestId);
    }
    this.scheduleReconnect();
  }

  private resetDisconnectedState(): void {
    this.bootstrapSnapshotCache = { sessionEpoch: "boot", vaultStatus: "booting", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 900_000 } };
    this.topicCaches.clear();
    this.sessionRevisionCache = -1;
    this.backgroundSnapshotRevisionCache = -1;
    this.assetDataRevisionCache = -1;
    this.storageRevisionCache = -1;
    this.msfileRevisionCache = -1;
    this.p2pkhProviderRevisionCache = -1;
  }

  // ============================================================
  // 5. RPC Methods
  // ============================================================

  private async sendHello(): Promise<void> {
    const request: CoordinatorClientRequest = {
      kind: "hello",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
    };
    const response = await this.sendRequest(request);
    const result = response.operationResult as CoordinatorSubscribeTopicsResult | undefined;
    for (const baseline of result?.baselines ?? []) this.applyTopicEvent(baseline.snapshot);
  }

  private async subscribeTopicsAndReadBaselines(topics: CoordinatorTopic[]): Promise<void> {
    const request: CoordinatorClientRequest = {
      kind: "subscribe",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      topics,
    };
    const response = await this.sendRequest(request);
    const result = response.operationResult as CoordinatorSubscribeTopicsResult | undefined;
    for (const baseline of result?.baselines ?? []) {
      this.applyTopicEvent(baseline.snapshot);
    }
  }

  async unlock(password: string, publicKeyHex?: string): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "unlock",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      password,
      publicKeyHex,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  async lock(): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "lock",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  async activateKey(password: string, publicKeyHex: string): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "activate-key",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      password,
      publicKeyHex,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  async vaultOperation(operation: CoordinatorVaultOperation | string, input?: unknown): Promise<CoordinatorValueResult<unknown>> {
    const normalized = typeof operation === "string" ? ({ type: operation, ...(input as object ?? {}) } as unknown as CoordinatorVaultOperation) : operation;
    const request = { kind: "vault.operation" as const, clientId: this.clientId, requestId: this.generateRequestId(), operation: normalized, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch } satisfies CoordinatorValueResult<unknown>;
    } catch (cause) {
      return this.normalizeTransportFailure(request.kind, cause);
    }
  }

  async crypto(operation: CoordinatorCryptoOperation): Promise<{
    ack: CoordinatorCommandResult;
    result?: CoordinatorCryptoResult;
  }> {
    const request: CoordinatorClientRequest = {
      kind: "crypto",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      operation,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok" || !response.cryptoResult) return { ack: response.ack };
      return { ack: response.ack, result: response.cryptoResult };
    } catch (cause) {
      return { ack: this.normalizeTransportFailure(request.kind, cause) };
    }
  }

  async backgroundRunNow(taskId: string): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "background.run-now",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      taskId,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  async backgroundTrigger(taskId: string, reason: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "background.trigger", clientId: this.clientId, requestId: this.generateRequestId(), taskId, reason, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async backgroundCancel(taskId: string): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "background.cancel",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      taskId,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  async backgroundCancelByKey(publicKeyHex: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "background.cancel-by-key", clientId: this.clientId, requestId: this.generateRequestId(), publicKeyHex, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async storageControl(control: CoordinatorStorageControl): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "storage.control" as const, clientId: this.clientId, requestId: this.generateRequestId(), control, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async storageGrant(context: import("@keymaster/contracts").StorageAppContext): Promise<import("@keymaster/contracts").CoordinatorValueResult<string>> {
    const request = { kind: "storage.grant" as const, clientId: this.clientId, requestId: this.generateRequestId(), connectSessionId: context.connectSessionId, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as string, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async storageData(data: CoordinatorStorageData, transfer: ArrayBuffer[] = [], signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "storage.data" as const, clientId: this.clientId, requestId: this.generateRequestId(), data, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Storage request cancelled", retryable: false };
      onAbort = () => { void this.storageCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request, transfer);
      if (signal?.aborted) return { status: "transport-error", message: "Storage request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  async storageCancel(targetRequestId: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "storage.cancel", clientId: this.clientId, requestId: this.generateRequestId(), targetRequestId });
  }

  async storageSessionAbort(connectSessionId: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "storage.session.abort", clientId: this.clientId, requestId: this.generateRequestId(), connectSessionId, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async msfileControl(control: import("@keymaster/contracts").CoordinatorMsFileControl): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "msfile.control" as const, clientId: this.clientId, requestId: this.generateRequestId(), control, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async msfileGrant(context: import("@keymaster/contracts").MsFileConnectAppContext): Promise<import("@keymaster/contracts").CoordinatorValueResult<string>> {
    // 审查修复：grant 与其他请求一样携带发起时的 epoch，供 worker 在
    // authoritative session 查询后复核（跨 lock/unlock/key switch 的请求被拒）。
    const request = { kind: "msfile.grant" as const, clientId: this.clientId, requestId: this.generateRequestId(), context, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as string, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async msfileData(data: import("@keymaster/contracts").CoordinatorMsFileData, transfer: ArrayBuffer[] = [], signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "msfile.data" as const, clientId: this.clientId, requestId: this.generateRequestId(), data, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "MSFile request cancelled", retryable: false };
      onAbort = () => { void this.msfileCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request, transfer);
      if (signal?.aborted) return { status: "transport-error", message: "MSFile request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  async msfileCancel(targetRequestId: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "msfile.cancel", clientId: this.clientId, requestId: this.generateRequestId(), targetRequestId });
  }

  async msfileSessionAbort(connectSessionId: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "msfile.session.abort", clientId: this.clientId, requestId: this.generateRequestId(), connectSessionId, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  /** 施工单 001：申请 Window executor lease（同一 epoch 仅一个）。 */
  async msfileExecutorAcquire(ownerPublicKeyHex: string): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").MsFileExecutorLease>> {
    const request = { kind: "msfile.executor.acquire" as const, clientId: this.clientId, requestId: this.generateRequestId(), ownerPublicKeyHex, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as import("@keymaster/contracts").MsFileExecutorLease, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async msfileExecutorRelease(leaseId: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "msfile.executor.release", clientId: this.clientId, requestId: this.generateRequestId(), leaseId });
  }

  /** 001 Spike：真实穿过 SharedWorker 的双向 transferable echo。 */
  async msfileExecutorSpikeTransfer(leaseId: string, expectedSessionEpoch: import("@keymaster/contracts").SessionEpoch, bytes: ArrayBuffer): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").MsFileExecutorTransferResult>> {
    const request = { kind: "msfile.executor.spike.transfer" as const, clientId: this.clientId, requestId: this.generateRequestId(), leaseId, expectedSessionEpoch, bytes };
    try {
      const response = await this.sendRequest(request, [bytes]);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as import("@keymaster/contracts").MsFileExecutorTransferResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  /** Window bridge RPC 1：由 Coordinator 构造标准 Noise 签名负载。 */
  async msfileExecutorSignNoiseStaticKey(input: Omit<import("@keymaster/contracts").MsFileNoiseSignRequest, "expectedSessionEpoch"> & { expectedSessionEpoch?: import("@keymaster/contracts").SessionEpoch }, signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").MsFileIdentitySignResult>> {
    const noiseStaticPublicKey = input.noiseStaticPublicKey;
    const request = { kind: "msfile.executor.identity.sign-noise" as const, clientId: this.clientId, requestId: this.generateRequestId(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? this.bootstrapSnapshotCache.sessionEpoch, noiseStaticPublicKey };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Noise signer request cancelled", retryable: false };
      onAbort = () => { void this.msfileCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request, [noiseStaticPublicKey]);
      if (signal?.aborted) return { status: "transport-error", message: "Noise signer request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as import("@keymaster/contracts").MsFileIdentitySignResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  /** Window bridge RPC 2：由 Coordinator 构造标准 Signed Peer Record 负载。 */
  async msfileExecutorSignPeerRecord(input: Omit<import("@keymaster/contracts").MsFilePeerRecordSignRequest, "expectedSessionEpoch"> & { expectedSessionEpoch?: import("@keymaster/contracts").SessionEpoch }, signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").MsFileIdentitySignResult>> {
    const request = { kind: "msfile.executor.identity.sign-peer-record" as const, clientId: this.clientId, requestId: this.generateRequestId(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? this.bootstrapSnapshotCache.sessionEpoch, peerId: input.peerId, addresses: input.addresses, sequence: input.sequence };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Peer Record signer request cancelled", retryable: false };
      onAbort = () => { void this.msfileCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request);
      if (signal?.aborted) return { status: "transport-error", message: "Peer Record signer request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as import("@keymaster/contracts").MsFileIdentitySignResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  async p2pkhProvidersGet(): Promise<import("@keymaster/contracts").CoordinatorValueResult<P2pkhProviderRegistrySnapshot>> {
    const request = { kind: "p2pkh.providers.get" as const, clientId: this.clientId, requestId: this.generateRequestId(), expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as P2pkhProviderRegistrySnapshot, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async p2pkhProvidersUpdate(network: "main" | "test", selection: P2pkhNetworkProviderSelection, expectedGeneration: number): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "p2pkh.providers.update", clientId: this.clientId, requestId: this.generateRequestId(), network, selection, expectedGeneration, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async p2pkhSettingsUpdate(settings: { includeTestnet: boolean }): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "p2pkh.settings.update", clientId: this.clientId, requestId: this.generateRequestId(), settings, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async p2pkhProviderConfigGet(providerId: string): Promise<import("@keymaster/contracts").CoordinatorValueResult<Record<string, unknown>>> {
    const request = { kind: "p2pkh.provider-config.get" as const, clientId: this.clientId, requestId: this.generateRequestId(), providerId, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: (response.operationResult ?? {}) as Record<string, unknown>, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async p2pkhProviderConfigUpdate(providerId: string, config: Record<string, unknown>): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "p2pkh.provider-config.update", clientId: this.clientId, requestId: this.generateRequestId(), providerId, config, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async p2pkhBroadcast(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number }): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "p2pkh.broadcast" as const, clientId: this.clientId, requestId: this.generateRequestId(), ...input, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status === "stale-epoch") return { status: "ok", value: { status: "not-dispatched", reason: "stale-session-epoch" }, sessionEpoch: response.sessionEpoch };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) {
      const failure = this.normalizeTransportFailure(request.kind, cause);
      return failure.dispatchStatus === "not-dispatched"
        ? { status: "ok", value: { status: "not-dispatched", reason: "coordinator-not-dispatched" }, sessionEpoch: this.bootstrapSnapshotCache.sessionEpoch }
        : failure;
    }
  }

  async p2pkhRebroadcastAncestors(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number }): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "p2pkh.rebroadcast-ancestors" as const, clientId: this.clientId, requestId: this.generateRequestId(), ...input, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status === "stale-epoch") return { status: "ok", value: { status: "not-dispatched", reason: "stale-session-epoch" }, sessionEpoch: response.sessionEpoch };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) {
      const failure = this.normalizeTransportFailure(request.kind, cause);
      return failure.dispatchStatus === "not-dispatched"
        ? { status: "ok", value: { status: "not-dispatched", reason: "coordinator-not-dispatched" }, sessionEpoch: this.bootstrapSnapshotCache.sessionEpoch }
        : failure;
    }
  }

  async backgroundSettingsUpdate(settings: CoordinatorBackgroundSyncSettings): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "background.settings.update",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      settings,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  sendActivity(): void {
    if (!this.isConnected || !this.port) return;

    const request: CoordinatorClientRequest = {
      kind: "activity",
      clientId: this.clientId,
    };

    try {
      this.port.postMessage(request);
    } catch {
      // 端口可能已关闭
    }
  }

  // ============================================================
  // 6. Request Management
  // ============================================================

  private normalizeTransportFailure(kind: CoordinatorClientRequest["kind"], cause: unknown): CoordinatorTransportFailure {
    this.isConnected = false;
    this.resetDisconnectedState();
    this.scheduleReconnect();
    this.reportRecoverableCoordinatorFailure(kind, cause);
    const dispatchStatus = (cause as { dispatchStatus?: CoordinatorDispatchStatus } | undefined)?.dispatchStatus ?? "unknown";
    return { status: "transport-error", message: "Coordinator connection lost", retryable: true, dispatchStatus };
  }

  reportRecoverableCoordinatorFailure(kind: string, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Coordinator command failed";
    this.recoverableDiagnostics.push({ kind, status: "recoverable", message: message.slice(0, 200), sessionEpoch: this.bootstrapSnapshotCache.sessionEpoch, connected: this.isConnected });
    if (this.recoverableDiagnostics.length > 50) this.recoverableDiagnostics.shift();
  }

  getRecoverableDiagnostics(): RecoverableCoordinatorDiagnostic[] {
    return this.recoverableDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  /** The single boundary at which command transport failures become results. */
  private async requestCommand(request: Exclude<CoordinatorClientRequest, { kind: "hello" | "subscribe" | "activity" }>): Promise<CoordinatorCommandResult> {
    try {
      const response = await this.sendRequest(request);
      return response.ack;
    } catch (cause) {
      return this.normalizeTransportFailure(request.kind, cause);
    }
  }

  private async sendRequest(request: CoordinatorClientRequest, transfer: ArrayBuffer[] = []): Promise<CoordinatorResponse> {
    if (!this.isConnected || !this.port) {
      throw coordinatorSendError("Not connected to Coordinator", "not-dispatched");
    }

    const requestId = "requestId" in request ? request.requestId : this.generateRequestId();

    return new Promise<CoordinatorResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.isConnected = false;
        this.resetDisconnectedState();
        this.scheduleReconnect();
        reject(coordinatorSendError("Request timeout", "unknown"));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      try {
        this.port!.postMessage(request, transfer);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        const failure = err instanceof Error ? err as CoordinatorSendError : coordinatorSendError(String(err), "not-dispatched");
        failure.dispatchStatus ??= "not-dispatched";
        reject(failure);
      }
    });
  }

  // ============================================================
  // 7. State Access
  // ============================================================

  getBootstrapSnapshot(): CoordinatorBootstrapSnapshot {
    return { ...this.bootstrapSnapshotCache };
  }

  getSessionEpoch(): SessionEpoch {
    return this.bootstrapSnapshotCache.sessionEpoch;
  }

  getVaultStatus(): CoordinatorVaultStatus {
    return this.bootstrapSnapshotCache.vaultStatus;
  }

  getActivePublicKeyHex(): string | undefined {
    return this.bootstrapSnapshotCache.activePublicKeyHex;
  }

  getKeyspaceGeneration(): number {
    return this.bootstrapSnapshotCache.keyspaceGeneration;
  }

  getTaskSnapshots(): CoordinatorTaskSnapshot[] {
    return [...this.bootstrapSnapshotCache.taskSnapshots];
  }

  getScheduleSettings(): CoordinatorBackgroundSyncSettings {
    return { ...this.bootstrapSnapshotCache.scheduleSettings };
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  // ============================================================
  // 8. Event Listeners
  // ============================================================

  subscribeTopic(topic: CoordinatorTopic, listener: (event: any) => void): () => void {
    const key = topic as string;
    if (!this.eventListeners.has(key)) this.eventListeners.set(key, new Set());
    const listeners = this.eventListeners.get(key)!;
    const typedListener = listener as EventListener<CoordinatorTopicEvent>;
    listeners.add(typedListener);
    const baseline = this.topicCaches.get(topic);
    if (baseline) {
      try { typedListener(baseline); } catch { /* noop */ }
    }
    return () => { listeners.delete(typedListener); };
  }

  private applyTopicEvent(event: CoordinatorTopicEvent): void {
    if (!this.isValidTopicEvent(event)) {
      if (event.topic === "session.state") this.resetDisconnectedState();
      this.reportRecoverableCoordinatorFailure("invalid-topic-event", new Error("Invalid Coordinator topic payload"));
      return;
    }
    const incomingRevision = this.getEventRevision(event);
    if (incomingRevision === undefined) return;
    if (incomingRevision <= this.getCachedTopicRevision(event.topic)) {
      if (event.topic === "session.state") {
        this.reportRecoverableCoordinatorFailure("stale-session-state", new Error("Discarded non-increasing session revision"));
      }
      return;
    }
    this.setTopicRevision(event);
    this.topicCaches.set(event.topic, event);
    if (event.type === "session.state.changed") {
      // Session fields are committed as one replacement before any listener observes them.
      this.bootstrapSnapshotCache = {
        ...this.bootstrapSnapshotCache,
        sessionEpoch: event.sessionEpoch,
        vaultStatus: event.vaultStatus,
        activePublicKeyHex: event.activePublicKeyHex ?? undefined,
        selectedPublicKeyHex: event.selectedPublicKeyHex ?? undefined,
        keyspaceGeneration: event.keyspaceGeneration,
      };
    } else if (event.type === "background.snapshot.changed") {
      // Background is a separate domain and must not advance Session identity.
      this.bootstrapSnapshotCache = { ...this.bootstrapSnapshotCache, taskSnapshots: [...event.snapshots] };
    } else if (event.type === "p2pkh.providers.changed") {
      this.bootstrapSnapshotCache = { ...this.bootstrapSnapshotCache, p2pkhProviders: event.snapshot };
    }
    const listeners = this.eventListeners.get(event.topic);
    if (listeners) {
      for (const listener of listeners) {
        try { listener(event); } catch { /* noop */ }
      }
    }

  }

  private getCachedTopicRevision(topic: CoordinatorTopic): number {
    if (topic === "session.state") return this.sessionRevisionCache;
    if (topic === "background.snapshot") return this.backgroundSnapshotRevisionCache;
    if (topic === "storage.state") return this.storageRevisionCache;
    if (topic === "p2pkh.providers") return this.p2pkhProviderRevisionCache;
    if (topic === "msfile.state") return this.msfileRevisionCache;
    return this.assetDataRevisionCache;
  }

  private getEventRevision(event: CoordinatorTopicEvent): number | undefined {
    if (event.topic === "session.state") return event.sessionRevision;
    if (event.topic === "background.snapshot") return event.backgroundSnapshotRevision;
    if (event.topic === "storage.state") return event.storageRevision;
    if (event.topic === "p2pkh.providers") return event.providerRevision;
    if (event.topic === "msfile.state") return event.msfileRevision;
    return event.assetDataRevision;
  }

  private setTopicRevision(event: CoordinatorTopicEvent): void {
    if (event.topic === "session.state") this.sessionRevisionCache = event.sessionRevision;
    else if (event.topic === "background.snapshot") this.backgroundSnapshotRevisionCache = event.backgroundSnapshotRevision;
    else if (event.topic === "storage.state") this.storageRevisionCache = event.storageRevision;
    else if (event.topic === "p2pkh.providers") this.p2pkhProviderRevisionCache = event.providerRevision;
    else if (event.topic === "msfile.state") this.msfileRevisionCache = event.msfileRevision;
    else this.assetDataRevisionCache = event.assetDataRevision;
  }

  private isValidTopicEvent(event: CoordinatorTopicEvent): boolean {
    if (!event || typeof event !== "object" || typeof event.topic !== "string" || typeof event.type !== "string" || typeof event.sessionEpoch !== "string") return false;
    if (event.topic === "session.state") {
      return event.type === "session.state.changed"
        && Number.isSafeInteger(event.sessionRevision)
        && event.sessionRevision >= 0
        && typeof event.cause === "string"
        && typeof event.vaultStatus === "string"
        && (typeof event.activePublicKeyHex === "string" || event.activePublicKeyHex === null)
        && Number.isSafeInteger(event.keyspaceGeneration)
        && event.keyspaceGeneration >= 0
        && (event.vaultStatus === "unlocked" || event.activePublicKeyHex === null);
    }
    if (event.topic === "background.snapshot") return event.type === "background.snapshot.changed" && Number.isSafeInteger(event.backgroundSnapshotRevision) && Array.isArray(event.snapshots);
    if (event.topic === "storage.state") return event.type === "storage.state.changed" && Number.isSafeInteger(event.storageRevision) && event.storageRevision >= 0 && (event.providerGeneration === null || Number.isSafeInteger(event.providerGeneration));
    if (event.topic === "p2pkh.providers") return event.type === "p2pkh.providers.changed" && Number.isSafeInteger(event.providerRevision) && event.providerRevision >= 0 && Boolean(event.snapshot);
    if (event.topic === "msfile.state") {
      return event.type === "msfile.state.changed"
        && Number.isSafeInteger(event.msfileRevision)
        && event.msfileRevision >= 0
        && Number.isSafeInteger(event.supplierGeneration)
        && Array.isArray(event.pendingApprovals);
    }
    return event.type === "asset.data-changed" && Number.isSafeInteger(event.assetDataRevision);
  }

  // ============================================================
  // 9. Utility Methods
  // ============================================================

  private generateClientId(): string {
    return `client-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

// ============================================================
// 10. Factory Function
// ============================================================

export function createCoordinatorClient(options?: CoordinatorClientOptions): KeymasterSessionCoordinatorClient {
  return new KeymasterSessionCoordinatorClient(options);
}

// ============================================================
// 11. Singleton Instance
// ============================================================

let singletonClient: KeymasterSessionCoordinatorClient | null = null;

export function getCoordinatorClient(): KeymasterSessionCoordinatorClient {
  if (!singletonClient) {
    singletonClient = createCoordinatorClient();
  }
  return singletonClient;
}

export function __testResetCoordinatorClient(): void {
  if (singletonClient) {
    singletonClient.disconnect();
    singletonClient = null;
  }
}
