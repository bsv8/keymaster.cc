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
  CoordinatorAuthorityRecovery,
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
  CoordinatorSatOperation,
  CoordinatorChannelOperation,
  ContactPresenceMap,
  CoordinatorWorkerUnitStateEvent,
  StorageBootstrapState,
} from "@keymaster/contracts";
import { COORDINATOR_SERVICE_PROTOCOL_VERSION } from "@keymaster/contracts";
import type {
  CoordinatorOwnerStorageData,
  CoordinatorPlatformStorageData,
  StorageBindingCoordinatorClient,
  StorageOwnerGrant,
  StoragePlatformGrant
} from "@keymaster/contracts/storage-internal";
import { readStorageBootstrap } from "@keymaster/platform-storage/coordinator/bootstrap";
import {
  createMessagePortServiceTransport,
  createServiceBridge,
  type RemoteServiceBridge,
  type RemoteServiceHandshake,
  type RemoteServiceSnapshot,
  type PluginIntentCommand,
  type PluginIntentSnapshot,
  type PluginIntentSubmissionResult,
} from "webloom-framework";
import { keymasterRemoteServiceMessageCodec } from "@keymaster/runtime";

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

export class KeymasterSessionCoordinatorClient implements SessionCoordinatorClient, StorageBindingCoordinatorClient {
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  /** 与 Coordinator 主 RPC 分离的服务桥端口；避免业务事件污染服务协议。 */
  private servicePort: MessagePort | null = null;
  private serviceTransport: ReturnType<typeof createMessagePortServiceTransport> | null = null;
  private serviceBridge: RemoteServiceBridge | undefined;
  private clientId: string;
  private workerName?: string;
  private workerUrl?: string;
  private requestTimeoutMs: number;
  private reconnectIntervalMs: number;

  private bootstrapSnapshotCache: CoordinatorBootstrapSnapshot = {
    authorityInstanceId: "authority:boot",
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
  private satRevisionCache = -1;
  private channelRevisionCache = -1;
  private contactsPresenceRevisionCache = -1;
  private pluginIntentRevisionCache = -1;
  private pluginIntentAuthorityInstanceId = "authority:boot";
  /**
   * Worker 单元事件可能先于同一 session.state 到达；先按 sessionEpoch
   * 暂存，避免为了丢弃旧世代而误丢当前世代的合法快照。集合有界，
   * 不把断线期间的事件变成长期缓存。
   */
  private pendingWorkerUnitEvents = new Map<SessionEpoch, CoordinatorWorkerUnitStateEvent>();
  private contactsPresenceOwnerPublicKeyHex: string | null = null;
  private contactsPresenceSnapshotCache: ContactPresenceMap = {};

  private isConnected = false;
  /** 页面生命周期结束后，连接尝试和自动重连都不得再次复活。 */
  private shutdownRequested = false;
  /** 使 disconnect() 能取消尚未完成的 connect/hello/subscription 链。 */
  private connectionAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** disconnect 发送后给 SharedWorker 留出接收/排空控制消息的短窗口。 */
  private disconnectCloseTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (this.shutdownRequested) throw new Error("Coordinator client is shut down");
    if (this.isConnected) return;
    const attempt = ++this.connectionAttempt;

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

      const port = this.worker.port;
      this.port = port;
      // disconnect() 会给旧端口一个很短的投递窗口；旧端口在窗口内到达
      // 的迟到事件不能污染随后建立的新连接缓存。
      port.onmessage = (event) => {
        if (this.port !== port) return;
        this.handleMessage(event);
      };
      port.onmessageerror = (event) => {
        if (this.port !== port) return;
        void event;
        this.handleMessageError();
      };
      port.start();

      const servicePortForHello = this.openServiceBridge();
      this.isConnected = true;
      await this.sendHello(servicePortForHello);
      await this.subscribeTopicsAndReadBaselines(["session.state", "background.snapshot", "asset.data-changed", "storage.state", "p2pkh.providers", "msfile.state", "sat.events", "channel.events", "contacts.presence", "plugin.intent", "worker.units"]);

      if (this.shutdownRequested || attempt !== this.connectionAttempt || this.port !== port) {
        throw new Error("Coordinator connection attempt was cancelled");
      }

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    } catch (err) {
      // 没有创建 Worker（例如浏览器不支持 SharedWorker）时 port 和
      // worker 都为空，不能把当前尝试误判成“已经被取消”而 resolve。
      // 只有明确出现新 attempt 才吞掉旧连接错误。
      if (attempt !== this.connectionAttempt) return;
      if (this.port && this.worker && this.port !== this.worker.port) return;
      this.isConnected = false;
      this.disposeServiceBridge("Coordinator connection attempt failed");
      if (!this.shutdownRequested) this.scheduleReconnect();
      throw err;
    }
  }

  private disconnectInternal(closePortAfterMs: number | undefined): void {
    this.connectionAttempt += 1;
    this.disposeServiceBridge("Coordinator client disconnected");
    const port = this.port;
    this.port = null;
    if (port) {
      // MessagePort.close() 会使尚未投递的 outbound message 丢失。先发
      // 明确的断开协议，再延后一小段时间关闭本地端口，确保 SharedWorker
      // 能执行 handlePortDisconnect，从而 abort 未完成请求并释放窗口租约。
      try {
        port.postMessage({ kind: "disconnect", clientId: this.clientId, requestId: this.generateRequestId() });
      } catch {
        /* messageerror/close fallback */
      }
      // 页面 unload 期间不能再依赖一个定时器：浏览器可能在定时器
      // 执行前冻结文档。永久 shutdown 保留端口，让已排队的 disconnect
      // 尽可能先到达 SharedWorker；文档销毁时浏览器会自动解除端口。
      if (closePortAfterMs !== undefined) {
        if (this.disconnectCloseTimer) clearTimeout(this.disconnectCloseTimer);
        this.disconnectCloseTimer = setTimeout(() => {
          this.disconnectCloseTimer = null;
          try { port.close(); } catch { /* already closed */ }
        }, closePortAfterMs);
      }
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

  disconnect(): void {
    this.disconnectInternal(100);
  }

  /** 页面/Worker 永久销毁边界；与可重用的业务 disconnect 区分。 */
  shutdown(): void {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    // 这是页面/Worker 的永久生命周期边界，不是可重用的业务断线。
    // 不在这里定时 close 端口，给 unload 场景中的 disconnect 控制消息
    // 留出浏览器实现允许的投递机会。
    this.disconnectInternal(undefined);
  }

  private scheduleReconnect(): void {
    if (this.shutdownRequested) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shutdownRequested) return;
      void this.connect().catch(() => {
        if (!this.shutdownRequested) this.scheduleReconnect();
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
      if (typeof snapshot.authorityInstanceId === "string" && snapshot.authorityInstanceId.length > 0) {
        this.adoptPluginIntentAuthority(snapshot.authorityInstanceId);
      }
      this.bootstrapSnapshotCache = {
        ...this.bootstrapSnapshotCache,
        ...snapshot,
        taskSnapshots: [...snapshot.taskSnapshots],
        ...(snapshot.coordinatorWorkerUnits
          ? { coordinatorWorkerUnits: snapshot.coordinatorWorkerUnits.map((unit) => ({ ...unit, serviceIds: [...unit.serviceIds], taskIds: [...unit.taskIds] })) }
          : {}),
      };
      if (snapshot.pluginIntent) this.cachePluginIntentSnapshot(snapshot.pluginIntent, snapshot.authorityInstanceId);
    }
    pending.resolve(response);
  }

  private adoptPluginIntentAuthority(authorityInstanceId: string): void {
    if (!authorityInstanceId || authorityInstanceId === this.pluginIntentAuthorityInstanceId) return;
    this.pluginIntentAuthorityInstanceId = authorityInstanceId;
    this.pluginIntentRevisionCache = -1;
  }

  private cachePluginIntentSnapshot(snapshot: PluginIntentSnapshot, authorityInstanceId = this.pluginIntentAuthorityInstanceId): void {
    if (
      !snapshot
      || !Number.isSafeInteger(snapshot.revision)
      || snapshot.revision < 0
      || !snapshot.desiredEnabled
      || typeof snapshot.desiredEnabled !== "object"
      || Array.isArray(snapshot.desiredEnabled)
      || !snapshot.desiredRevision
      || typeof snapshot.desiredRevision !== "object"
      || Array.isArray(snapshot.desiredRevision)
    ) return;
    if (authorityInstanceId !== this.pluginIntentAuthorityInstanceId) return;
    if (snapshot.revision < this.pluginIntentRevisionCache) return;
    this.pluginIntentRevisionCache = snapshot.revision;
    this.bootstrapSnapshotCache = {
      ...this.bootstrapSnapshotCache,
      pluginIntent: {
        revision: snapshot.revision,
        desiredEnabled: { ...snapshot.desiredEnabled },
        desiredRevision: { ...snapshot.desiredRevision },
      },
    };
  }

  private handleEvent(event: CoordinatorTopicEvent): void {
    this.applyTopicEvent(event);
  }

  private deferWorkerUnitEvent(event: CoordinatorWorkerUnitStateEvent): void {
    const previous = this.pendingWorkerUnitEvents.get(event.sessionEpoch);
    if (!previous || event.workerUnitRevision > previous.workerUnitRevision) {
      this.pendingWorkerUnitEvents.set(event.sessionEpoch, event);
    }
    // 只保留极少数候选世代，防止失联或恶意乱序事件在页面内累积。
    while (this.pendingWorkerUnitEvents.size > 4) {
      const oldest = this.pendingWorkerUnitEvents.keys().next().value as SessionEpoch | undefined;
      if (oldest === undefined) break;
      this.pendingWorkerUnitEvents.delete(oldest);
    }
  }

  private handleMessageError(): void {
    this.handleWorkerError("Coordinator transport error");
  }

  private handleWorkerError(message: string): void {
    this.isConnected = false;
    this.disposeServiceBridge(message);
    this.resetDisconnectedState();
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pendingRequests.delete(requestId);
    }
    if (!this.shutdownRequested) this.scheduleReconnect();
  }

  private resetDisconnectedState(): void {
    this.bootstrapSnapshotCache = { authorityInstanceId: "authority:boot", sessionEpoch: "boot", vaultStatus: "booting", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 900_000 }, coordinatorWorkerUnits: [], coordinatorWorkerUnitSnapshotRevision: 0 };
    this.topicCaches.clear();
    this.sessionRevisionCache = -1;
    this.backgroundSnapshotRevisionCache = -1;
    this.assetDataRevisionCache = -1;
    this.storageRevisionCache = -1;
    this.msfileRevisionCache = -1;
    this.p2pkhProviderRevisionCache = -1;
    this.satRevisionCache = -1;
    this.channelRevisionCache = -1;
    this.contactsPresenceRevisionCache = -1;
    this.pluginIntentRevisionCache = -1;
    this.pluginIntentAuthorityInstanceId = "authority:boot";
    this.pendingWorkerUnitEvents.clear();
    this.contactsPresenceOwnerPublicKeyHex = null;
    this.contactsPresenceSnapshotCache = {};
  }

  // ============================================================
  // 5. RPC Methods
  // ============================================================

  private openServiceBridge(): MessagePort {
    if (typeof MessageChannel === "undefined") {
      throw new Error("Coordinator service bridge requires MessageChannel support");
    }
    this.disposeServiceBridge("Coordinator service bridge replaced");
    const channel = new MessageChannel();
    const servicePort = channel.port1;
    const transport = createMessagePortServiceTransport({
      port: servicePort,
      codec: keymasterRemoteServiceMessageCodec,
    });
    const bridge = createServiceBridge({
      protocolVersion: COORDINATOR_SERVICE_PROTOCOL_VERSION,
      transport,
    });
    servicePort.addEventListener("message", this.handleServiceBridgeMessage);
    servicePort.start();
    this.servicePort = servicePort;
    this.serviceTransport = transport;
    // WebLoom 的通用 Reference 将 Keymaster 的 owner/session 字段收进
    // attributes；这里保留旧 wire 对象原样传输，不增加字段、不改变协议。
    this.serviceBridge = bridge;
    // port2 只在 hello 中转移给 Coordinator；页面永远不再直接持有 Provider 端口。
    return channel.port2;
  }

  private readonly handleServiceBridgeMessage = (event: MessageEvent): void => {
    const data = keymasterRemoteServiceMessageCodec.decode(event.data);
    if (!data) return;
    if (data.type === keymasterRemoteServiceMessageCodec.type("handshake") && data.handshake) {
      this.serviceBridge?.handshake(data.handshake as RemoteServiceHandshake);
      return;
    }
    if (data.type === keymasterRemoteServiceMessageCodec.type("snapshot") && data.snapshot) {
      this.serviceBridge?.applySnapshot(data.snapshot as RemoteServiceSnapshot);
      return;
    }
    if (data.type === keymasterRemoteServiceMessageCodec.type("invalidate")) {
      this.serviceBridge?.invalidate("reason" in data && typeof data.reason === "string" ? data.reason : undefined);
      return;
    }
    if (data.type === keymasterRemoteServiceMessageCodec.type("disconnect")) {
      this.serviceBridge?.disconnect("reason" in data && typeof data.reason === "string" ? data.reason : undefined);
    }
  };

  private disposeServiceBridge(reason: string): void {
    const bridge = this.serviceBridge;
    this.serviceBridge = undefined;
    if (bridge) bridge.disconnect(reason);
    if (this.servicePort) {
      this.servicePort.removeEventListener("message", this.handleServiceBridgeMessage);
      try { this.servicePort.close(); } catch { /* already closed */ }
      this.servicePort = null;
    }
    this.serviceTransport?.dispose();
    this.serviceTransport = null;
  }

  /** 当前物理连接的服务桥；重连后返回新的桥，旧桥永不复用。 */
  getServiceBridge(): RemoteServiceBridge | undefined {
    return this.serviceBridge;
  }

  private async sendHello(servicePort?: MessagePort): Promise<void> {
    const request: CoordinatorClientRequest = {
      kind: "hello",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      ...(servicePort ? { servicePort } : {}),
      ...(() => {
        const state = readStorageBootstrap();
        return state ? { storageBootstrapState: state as StorageBootstrapState } : {};
      })()
    };
    const response = await this.sendRequest(request, servicePort ? [servicePort] : []);
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
      const transfer: Transferable[] = [];
      const response = await this.sendRequest(request, transfer);
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

  async storageGrant(context: import("@keymaster/contracts").OwnerAppStorageGrant): Promise<import("@keymaster/contracts").CoordinatorValueResult<string>> {
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

  async storageBindOwner(input: { pluginId: string; declaration: import("@keymaster/contracts").PluginStorageDeclaration }): Promise<import("@keymaster/contracts").CoordinatorValueResult<StorageOwnerGrant>> {
    const request = { kind: "storage.owner.bind" as const, clientId: this.clientId, requestId: this.generateRequestId(), ...input, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as StorageOwnerGrant, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async storageBindPlatform(input: { pluginId: string; declaration: import("@keymaster/contracts").PluginStorageDeclaration }): Promise<import("@keymaster/contracts").CoordinatorValueResult<StoragePlatformGrant>> {
    const request = { kind: "storage.platform.bind" as const, clientId: this.clientId, requestId: this.generateRequestId(), ...input, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as StoragePlatformGrant, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async storageOwnerData(data: CoordinatorOwnerStorageData, transfer: ArrayBuffer[] = [], signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    return this.sendInternalStorageData("storage.owner.data", data, transfer, signal);
  }

  async storagePlatformData(data: CoordinatorPlatformStorageData): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "storage.platform.data" as const, clientId: this.clientId, requestId: this.generateRequestId(), data, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async storageDeleteOwner(ownerPublicKeyHex: string): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "storage.owner.delete" as const, clientId: this.clientId, requestId: this.generateRequestId(), ownerPublicKeyHex, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  private async sendInternalStorageData<K extends "storage.owner.data" | "storage.platform.data">(kind: K, data: K extends "storage.owner.data" ? CoordinatorOwnerStorageData : CoordinatorPlatformStorageData, transfer: ArrayBuffer[] = [], signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const requestId = this.generateRequestId();
    const request = { kind, clientId: this.clientId, requestId, data, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch } as CoordinatorClientRequest;
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Storage request cancelled", retryable: false };
      onAbort = () => { void this.storageCancel(requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request, transfer);
      if (signal?.aborted) return { status: "transport-error", message: "Storage request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  async msfileControl(control: import("@keymaster/contracts").CoordinatorMsFileControl): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "msfile.control" as const, clientId: this.clientId, requestId: this.generateRequestId(), control, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  /** SatSubscription 所有页面调用都经过 Coordinator，避免每个 Tab 各自开 K-V/连接。 */
  async satOperation(operation: CoordinatorSatOperation, signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "sat.operation" as const, clientId: this.clientId, requestId: this.generateRequestId(), operation, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "SatSubscription request cancelled", retryable: false };
      // 这里不尝试把业务 Wire 作为 transfer 发送。Uint8Array 的 structured
      // clone 会保留调用方 buffer，适合 retryCollect 的“原 Wire 不可变”语义。
      // Sat SPI/SSP 请求本身由 Window adapter 管理超时；这里的 signal 只
      // 防止调用方在回包后继续使用结果，不能用另一条 Sat RPC 冒充取消。
      onAbort = () => undefined;
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request);
      if (signal?.aborted) return { status: "transport-error", message: "SatSubscription request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  /** 所有 Channel publish/订阅请求的唯一 Coordinator RPC。 */
  async channelOperation(operation: CoordinatorChannelOperation, signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "channel.operation" as const, clientId: this.clientId, requestId: this.generateRequestId(), operation, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Channel request cancelled", retryable: false };
      // 取消不能只在页面侧丢弃结果：Coordinator 需要看到取消，才能中止
      // 尚未越过供应商边界的物理操作，并让旧 caller 的清理继续排在后面。
      // 若底层已经越过不可逆边界，Worker 仍会等待真实 Promise settle，
      // 不会把“本地取消”误当成远端写入已结束。
      onAbort = () => { void this.channelCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request);
      if (signal?.aborted) return { status: "transport-error", message: "Channel request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  /** 只供 Channel 请求的 AbortSignal 使用；调用方不能指定其它端口。 */
  private async channelCancel(targetRequestId: string): Promise<CoordinatorCommandResult> {
    try {
      return await this.requestCommand({
        kind: "channel.cancel",
        clientId: this.clientId,
        requestId: this.generateRequestId(),
        targetRequestId
      });
    } catch {
      // 取消是最佳努力通知。原请求的最终结果仍按真实 I/O 边界处理，
      // 不能因为取消通知自身断线就伪造“已清理”。
      return { status: "error", message: "Channel cancellation transport failed" };
    }
  }

  /** 联系人 presence 的读取面只查询 Coordinator 内存/本地 K-V，不启动探测。 */
  async contactsPresenceSnapshot(): Promise<import("@keymaster/contracts").CoordinatorValueResult<ContactPresenceMap>> {
    const request = { kind: "contacts.presence.snapshot" as const, clientId: this.clientId, requestId: this.generateRequestId(), expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: (response.operationResult ?? {}) as ContactPresenceMap, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  /** 读取 SharedWorker 唯一插件启停意图；这里的 snapshot 不等于运行实例状态。 */
  async pluginIntentSnapshot(): Promise<CoordinatorValueResult<PluginIntentSnapshot>> {
    const request = {
      kind: "plugin.intent.snapshot" as const,
      clientId: this.clientId,
      requestId: this.generateRequestId(),
    };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      const snapshot = response.operationResult as PluginIntentSnapshot;
      this.cachePluginIntentSnapshot(snapshot);
      return { status: "ok", value: snapshot, sessionEpoch: response.sessionEpoch };
    } catch (cause) {
      return this.normalizeTransportFailure(request.kind, cause);
    }
  }

  /** 提交绝对启停意图；accepted/duplicate 只表示 Worker 已持久化。 */
  async pluginIntentSubmit(command: PluginIntentCommand): Promise<PluginIntentSubmissionResult> {
    const request: CoordinatorClientRequest = {
      kind: "plugin.intent.submit",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      command,
    };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") {
        return {
          status: "transport-error",
          message: "message" in response.ack && typeof response.ack.message === "string"
            ? response.ack.message
            : `Coordinator rejected ${request.kind}`,
          retryable: response.ack.status !== "validation-error",
        };
      }
      const result = response.operationResult as PluginIntentSubmissionResult;
      if ("snapshot" in result && result.snapshot) this.cachePluginIntentSnapshot(result.snapshot);
      return result;
    } catch (cause) {
      return this.normalizeTransportFailure(request.kind, cause);
    }
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

  /** 申请公共 Window P2P executor lease（同一 epoch 仅一个）。 */
  async windowP2pExecutorAcquire(ownerPublicKeyHex: string, executorPort?: MessagePort): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").WindowP2pExecutorLease>> {
    const request = { kind: "window-p2p.executor.acquire" as const, clientId: this.clientId, requestId: this.generateRequestId(), ownerPublicKeyHex, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch, ...(executorPort ? { executorPort } : {}) };
    try {
      const response = await this.sendRequest(request, executorPort ? [executorPort] : []);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as import("@keymaster/contracts").WindowP2pExecutorLease, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async windowP2pExecutorRelease(leaseId: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "window-p2p.executor.release", clientId: this.clientId, requestId: this.generateRequestId(), leaseId });
  }

  /** 公共 P2P bridge 的 transferable 资源测试入口。 */
  async windowP2pExecutorSpikeTransfer(leaseId: string, expectedSessionEpoch: import("@keymaster/contracts").SessionEpoch, bytes: ArrayBuffer): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").WindowP2pExecutorTransferResult>> {
    const request = { kind: "window-p2p.executor.spike.transfer" as const, clientId: this.clientId, requestId: this.generateRequestId(), leaseId, expectedSessionEpoch, bytes };
    try {
      const response = await this.sendRequest(request, [bytes]);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as import("@keymaster/contracts").WindowP2pExecutorTransferResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  /** Window bridge RPC 1：由 Coordinator 构造标准 Noise 签名负载。 */
  async windowP2pExecutorSignNoiseStaticKey(input: Omit<import("@keymaster/contracts").WindowP2pNoiseSignRequest, "expectedSessionEpoch"> & { expectedSessionEpoch?: import("@keymaster/contracts").SessionEpoch }, signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").WindowP2pIdentitySignResult>> {
    const noiseStaticPublicKey = input.noiseStaticPublicKey;
    const request = { kind: "window-p2p.executor.identity.sign-noise" as const, clientId: this.clientId, requestId: this.generateRequestId(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? this.bootstrapSnapshotCache.sessionEpoch, noiseStaticPublicKey };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Noise signer request cancelled", retryable: false };
      onAbort = () => { void this.msfileCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request, [noiseStaticPublicKey]);
      if (signal?.aborted) return { status: "transport-error", message: "Noise signer request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as import("@keymaster/contracts").WindowP2pIdentitySignResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  /** Window bridge RPC 2：由 Coordinator 构造标准 Signed Peer Record 负载。 */
  async windowP2pExecutorSignPeerRecord(input: Omit<import("@keymaster/contracts").WindowP2pPeerRecordSignRequest, "expectedSessionEpoch"> & { expectedSessionEpoch?: import("@keymaster/contracts").SessionEpoch }, signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").WindowP2pIdentitySignResult>> {
    const request = { kind: "window-p2p.executor.identity.sign-peer-record" as const, clientId: this.clientId, requestId: this.generateRequestId(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? this.bootstrapSnapshotCache.sessionEpoch, peerId: input.peerId, addresses: input.addresses, sequence: input.sequence };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Peer Record signer request cancelled", retryable: false };
      onAbort = () => { void this.msfileCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request);
      if (signal?.aborted) return { status: "transport-error", message: "Peer Record signer request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult as import("@keymaster/contracts").WindowP2pIdentitySignResult, sessionEpoch: response.sessionEpoch };
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
    this.disposeServiceBridge(`Coordinator request failed: ${kind}`);
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

  private async sendRequest(request: CoordinatorClientRequest, transfer: Transferable[] = []): Promise<CoordinatorResponse> {
    if (!this.isConnected || !this.port) {
      throw coordinatorSendError("Not connected to Coordinator", "not-dispatched");
    }

    const requestId = "requestId" in request ? request.requestId : this.generateRequestId();

    return new Promise<CoordinatorResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.isConnected = false;
        this.disposeServiceBridge("Coordinator request timed out");
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

  /** 返回当前客户端缓存的 presence 快照副本，调用方不能修改 Coordinator 状态。 */
  getContactsPresenceSnapshot(): ContactPresenceMap {
    return Object.fromEntries(Object.entries(this.contactsPresenceSnapshotCache).map(([key, value]) => [key, { ...value }])) as ContactPresenceMap;
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
      if (event && typeof event === "object" && "topic" in event && event.topic === "session.state") {
        this.resetDisconnectedState();
      }
      this.reportRecoverableCoordinatorFailure("invalid-topic-event", new Error("Invalid Coordinator topic payload"));
      return;
    }
    if (event.topic === "worker.units" && event.sessionEpoch !== this.bootstrapSnapshotCache.sessionEpoch) {
      // Worker 的运行单元变更和 session.state 通过不同消息发送，不能假设
      // postMessage 到达顺序。暂存未来世代，等 session.state 先确认世代；
      // 旧世代随后不会再被应用到当前产品状态。
      this.deferWorkerUnitEvent(event);
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
      const previousSessionEpoch = this.bootstrapSnapshotCache.sessionEpoch;
      const sessionChanged = previousSessionEpoch !== event.sessionEpoch;
      // Session fields are committed as one replacement before any listener observes them.
      this.bootstrapSnapshotCache = {
        ...this.bootstrapSnapshotCache,
        sessionEpoch: event.sessionEpoch,
        vaultStatus: event.vaultStatus,
        activePublicKeyHex: event.activePublicKeyHex ?? undefined,
        selectedPublicKeyHex: event.selectedPublicKeyHex ?? undefined,
        keyspaceGeneration: event.keyspaceGeneration,
        authorityRecovery: event.authorityRecovery,
      };
      if (sessionChanged) {
        // 运行单元属于 session 世代；切换世代时先撤下旧快照，避免旧
        // Worker 实例在新 owner 页面上短暂显示为仍然 ready。
        this.topicCaches.delete("worker.units");
        this.bootstrapSnapshotCache = {
          ...this.bootstrapSnapshotCache,
          coordinatorWorkerUnits: [],
          coordinatorWorkerUnitSnapshotRevision: undefined,
        };
        for (const epoch of this.pendingWorkerUnitEvents.keys()) {
          if (epoch !== event.sessionEpoch) this.pendingWorkerUnitEvents.delete(epoch);
        }
        const pendingWorkerUnits = this.pendingWorkerUnitEvents.get(event.sessionEpoch);
        if (pendingWorkerUnits) {
          this.pendingWorkerUnitEvents.delete(event.sessionEpoch);
          // 递归调用只会处理已经验证过且 epoch 已切换到当前值的事件。
          this.applyTopicEvent(pendingWorkerUnits);
        }
      }
      const nextOwner = event.vaultStatus === "unlocked" ? event.activePublicKeyHex : null;
      if (nextOwner !== this.contactsPresenceOwnerPublicKeyHex) {
        this.contactsPresenceOwnerPublicKeyHex = nextOwner;
        this.contactsPresenceSnapshotCache = {};
      }
    } else if (event.type === "background.snapshot.changed") {
      // Background is a separate domain and must not advance Session identity.
      this.bootstrapSnapshotCache = { ...this.bootstrapSnapshotCache, taskSnapshots: [...event.snapshots] };
    } else if (event.type === "p2pkh.providers.changed") {
      this.bootstrapSnapshotCache = { ...this.bootstrapSnapshotCache, p2pkhProviders: event.snapshot };
    } else if (event.type === "coordinator.worker-units.changed") {
      this.bootstrapSnapshotCache = {
        ...this.bootstrapSnapshotCache,
        coordinatorWorkerUnits: event.units.map((unit) => ({ ...unit, serviceIds: [...unit.serviceIds], taskIds: [...unit.taskIds] })),
        coordinatorWorkerUnitSnapshotRevision: event.workerUnitRevision,
      };
    } else if (event.topic === "plugin.intent") {
      this.cachePluginIntentSnapshot(event.snapshot, event.authorityInstanceId);
    } else if (event.topic === "contacts.presence") {
      this.contactsPresenceOwnerPublicKeyHex = event.activePublicKeyHex;
      this.contactsPresenceSnapshotCache = Object.fromEntries(Object.entries(event.presence).map(([key, value]) => [key, { ...value }])) as ContactPresenceMap;
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
    if (topic === "sat.events") return this.satRevisionCache;
    if (topic === "channel.events") return this.channelRevisionCache;
    if (topic === "contacts.presence") return this.contactsPresenceRevisionCache;
    if (topic === "plugin.intent") return this.pluginIntentRevisionCache;
    if (topic === "worker.units") return this.bootstrapSnapshotCache.coordinatorWorkerUnitSnapshotRevision ?? -1;
    return this.assetDataRevisionCache;
  }

  private getEventRevision(event: CoordinatorTopicEvent): number | undefined {
    if (event.topic === "session.state") return event.sessionRevision;
    if (event.topic === "background.snapshot") return event.backgroundSnapshotRevision;
    if (event.topic === "storage.state") return event.storageRevision;
    if (event.topic === "p2pkh.providers") return event.providerRevision;
    if (event.topic === "msfile.state") return event.msfileRevision;
    if (event.topic === "sat.events") return event.satRevision;
    if (event.topic === "channel.events") return event.channelRevision;
    if (event.topic === "contacts.presence") return event.presenceRevision;
    if (event.topic === "plugin.intent") return event.pluginIntentRevision;
    if (event.topic === "worker.units") return event.workerUnitRevision;
    return event.assetDataRevision;
  }

  private setTopicRevision(event: CoordinatorTopicEvent): void {
    if (event.topic === "session.state") this.sessionRevisionCache = event.sessionRevision;
    else if (event.topic === "background.snapshot") this.backgroundSnapshotRevisionCache = event.backgroundSnapshotRevision;
    else if (event.topic === "storage.state") this.storageRevisionCache = event.storageRevision;
    else if (event.topic === "p2pkh.providers") this.p2pkhProviderRevisionCache = event.providerRevision;
    else if (event.topic === "msfile.state") this.msfileRevisionCache = event.msfileRevision;
    else if (event.topic === "sat.events") this.satRevisionCache = event.satRevision;
    else if (event.topic === "channel.events") this.channelRevisionCache = event.channelRevision;
    else if (event.topic === "contacts.presence") this.contactsPresenceRevisionCache = event.presenceRevision;
    else if (event.topic === "plugin.intent") this.pluginIntentRevisionCache = event.pluginIntentRevision;
    else if (event.topic === "worker.units") this.bootstrapSnapshotCache.coordinatorWorkerUnitSnapshotRevision = event.workerUnitRevision;
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
        && (event.vaultStatus === "unlocked" || event.activePublicKeyHex === null)
        && (event.authorityRecovery === undefined || this.isValidAuthorityRecovery(event.authorityRecovery));
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
    if (event.topic === "sat.events") {
      return event.type === "sat.events.changed"
        && Number.isSafeInteger(event.satRevision)
        && event.satRevision >= 0
        && Boolean(event.event);
    }
    if (event.topic === "channel.events") {
      return event.type === "channel.message.received"
        && Number.isSafeInteger(event.channelRevision)
        && event.channelRevision >= 0
        && (!event.publicMessage || typeof event.publicMessage.channel === "string")
        && (!event.privateMessage || typeof event.privateMessage.channel === "string");
    }
    if (event.topic === "contacts.presence") {
      return event.type === "contacts.presence.changed"
        && Number.isSafeInteger(event.presenceRevision)
        && event.presenceRevision >= 0
        && (typeof event.activePublicKeyHex === "string" || event.activePublicKeyHex === null)
        && Boolean(event.presence)
        && !Array.isArray(event.presence);
    }
    if (event.topic === "plugin.intent") {
      return event.type === "plugin.intent.changed"
        && typeof event.authorityInstanceId === "string"
        && event.authorityInstanceId === this.bootstrapSnapshotCache.authorityInstanceId
        && Number.isSafeInteger(event.pluginIntentRevision)
        && event.pluginIntentRevision >= 0
        && Boolean(event.snapshot)
        && event.snapshot.revision === event.pluginIntentRevision
        && !Array.isArray(event.snapshot.desiredEnabled)
        && !Array.isArray(event.snapshot.desiredRevision);
    }
    if (event.topic === "worker.units") {
      const unitKeys = new Set<string>();
      return event.type === "coordinator.worker-units.changed"
        && typeof event.authorityInstanceId === "string"
        && event.authorityInstanceId === this.bootstrapSnapshotCache.authorityInstanceId
        && Number.isSafeInteger(event.workerUnitRevision)
        && event.workerUnitRevision >= 0
        && Array.isArray(event.units)
        && event.units.every((unit) => Boolean(unit)
          && typeof unit.productId === "string"
          && unit.productId.length > 0
          && typeof unit.unitId === "string"
          && unit.unitId.length > 0
          && unit.execution === "coordinator-worker"
          && ["root", "storage", "owner-session", "connect-session"].includes(unit.lifetime)
          && typeof unit.instanceId === "string"
          && unit.instanceId.length > 0
          && ["starting", "ready", "failed"].includes(unit.state)
          && Number.isSafeInteger(unit.snapshotRevision)
          && unit.snapshotRevision >= 0
          && Array.isArray(unit.serviceIds)
          && unit.serviceIds.every((serviceId) => typeof serviceId === "string" && serviceId.length > 0)
          && Array.isArray(unit.taskIds)
          && unit.taskIds.every((taskId) => typeof taskId === "string" && taskId.length > 0)
          && (unit.error === undefined || typeof unit.error === "string")
          && (["owner-session", "connect-session"].includes(unit.lifetime)
            ? typeof unit.ownerPublicKeyHex === "string"
              && unit.ownerPublicKeyHex.length > 0
              && unit.sessionEpoch === event.sessionEpoch
            : unit.ownerPublicKeyHex === undefined && unit.sessionEpoch === undefined)
          && !unitKeys.has(`${unit.productId}\u0000${unit.unitId}`)
          && (unitKeys.add(`${unit.productId}\u0000${unit.unitId}`), true));
    }
    return event.type === "asset.data-changed" && Number.isSafeInteger(event.assetDataRevision);
  }

  /** 校验旧 Worker 仍持有最终 I/O 租约时发布的恢复诊断，避免不可信事件伪造接管状态。 */
  private isValidAuthorityRecovery(value: unknown): value is CoordinatorAuthorityRecovery {
    if (!value || typeof value !== "object") return false;
    const recovery = value as Partial<CoordinatorAuthorityRecovery>;
    const authorityBuildId = recovery.authorityBuildId;
    const activeIoLeaseCount = recovery.activeIoLeaseCount;
    const activeIoOperations = recovery.activeIoOperations;
    const handoverGeneration = recovery.handoverGeneration;
    return recovery.status === "recovery-required"
      && recovery.reason === "active-final-io-leases"
      && typeof authorityBuildId === "string"
      && authorityBuildId.length > 0
      && typeof activeIoLeaseCount === "number"
      && Number.isSafeInteger(activeIoLeaseCount)
      && activeIoLeaseCount > 0
      && Boolean(activeIoOperations)
      && typeof activeIoOperations === "object"
      && Number.isSafeInteger(activeIoOperations.read)
      && activeIoOperations.read >= 0
      && Number.isSafeInteger(activeIoOperations.write)
      && activeIoOperations.write >= 0
      && activeIoOperations.read + activeIoOperations.write === activeIoLeaseCount
      && typeof handoverGeneration === "number"
      && Number.isSafeInteger(handoverGeneration)
      && handoverGeneration >= 0;
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
