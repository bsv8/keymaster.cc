// apps/web/src/keymasterSessionCoordinatorClient.ts
// Keymaster Session Coordinator Client Transport
//
// 设计缘由（施工单 002）：
//   - 固定名称与 URL、port 生命周期、hello 重连
//   - requestId pending map、epoch cache、subscription event 分发
//   - port 断开仅拒绝本 tab pending request，不发全局 lock

import type {
  SessionEpoch,
  CoordinatorVaultStatus,
  CoordinatorClientRequest,
  CoordinatorResponse,
  CoordinatorEvent,
  CoordinatorSnapshot,
  CoordinatorTopic,
  CoordinatorCommandAck,
  CoordinatorCryptoOperation,
  CoordinatorCryptoResult,
  CoordinatorBackgroundSyncSettings,
  CoordinatorTaskSnapshot,
  CoordinatorVaultOperation,
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

export interface CoordinatorClientState {
  sessionEpoch: SessionEpoch;
  vaultStatus: CoordinatorVaultStatus;
  activePublicKeyHex?: string;
  keyspaceGeneration: number;
  taskSnapshots: CoordinatorTaskSnapshot[];
  scheduleSettings: CoordinatorBackgroundSyncSettings;
}

type EventListener<T> = (event: T) => void;

// ============================================================
// 2. Coordinator Client
// ============================================================

export class KeymasterSessionCoordinatorClient {
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private clientId: string;
  private workerName: string;
  private requestTimeoutMs: number;
  private reconnectIntervalMs: number;

  private state: CoordinatorClientState = {
    sessionEpoch: "boot",
    vaultStatus: "booting",
    keyspaceGeneration: 0,
    taskSnapshots: [],
    scheduleSettings: { assetHoldingsIntervalMs: 900_000 },
  };

  private pendingRequests = new Map<
    string,
    {
      resolve: (response: CoordinatorResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  private eventListeners = new Map<string, Set<EventListener<CoordinatorEvent>>>();
  private stateListeners = new Set<EventListener<CoordinatorClientState>>();

  private isConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CoordinatorClientOptions = {}) {
    this.workerName = options.workerName ?? "keymaster.session-coordinator.v1";
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
      this.worker = new SharedWorker(new URL("./keymasterSessionCoordinator.worker.ts", import.meta.url), {
        name: this.workerName,
        type: "module",
      });

      this.port = this.worker.port;
      this.port.onmessage = this.handleMessage.bind(this);
      this.port.onmessageerror = this.handleMessageError.bind(this);
      this.port.start();

      this.isConnected = true;
      await this.sendHello();
      await this.subscribe(["vault", "keyspace", "background", "data-changed"]);

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

    if (data && typeof data === "object" && "requestId" in data) {
      const response = data as CoordinatorResponse;
      this.handleResponse(response);
      return;
    }

    if (data && typeof data === "object" && "type" in data) {
      const event = data as CoordinatorEvent;
      this.handleEvent(event);
      return;
    }
  }

  private handleResponse(response: CoordinatorResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.requestId);

    this.state.sessionEpoch = response.sessionEpoch;
    if (response.operationResult && typeof response.operationResult === "object" && "vaultStatus" in response.operationResult) {
      const snapshot = response.operationResult as CoordinatorSnapshot;
      this.state = { ...this.state, ...snapshot, taskSnapshots: [...snapshot.taskSnapshots] };
      this.notifyStateListeners();
    }
    pending.resolve(response);
  }

  private handleEvent(event: CoordinatorEvent): void {
    switch (event.type) {
      case "vault.status-changed":
        this.state.vaultStatus = event.status;
        this.state.activePublicKeyHex = event.activePublicKeyHex;
        this.state.sessionEpoch = event.sessionEpoch;
        break;

      case "keyspace.active-changed":
        this.state.activePublicKeyHex = event.publicKeyHex ?? undefined;
        this.state.keyspaceGeneration = event.generation;
        this.state.sessionEpoch = event.sessionEpoch;
        break;

      case "background.snapshot-updated":
        this.state.taskSnapshots = event.snapshots;
        this.state.sessionEpoch = event.sessionEpoch;
        break;
    }

    this.notifyStateListeners();
    this.notifyEventListeners(event);
  }

  private handleMessageError(): void {
    this.isConnected = false;
    this.resetDisconnectedState();
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Coordinator transport error"));
      this.pendingRequests.delete(requestId);
    }
    this.scheduleReconnect();
  }

  private resetDisconnectedState(): void {
    this.state = { sessionEpoch: "boot", vaultStatus: "booting", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 900_000 } };
    this.notifyStateListeners();
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
    await this.sendRequest(request);
  }

  private async subscribe(topics: CoordinatorTopic[]): Promise<void> {
    const request: CoordinatorClientRequest = {
      kind: "subscribe",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      topics,
    };
    await this.sendRequest(request);
  }

  async unlock(password: string, publicKeyHex?: string): Promise<CoordinatorCommandAck> {
    const request: CoordinatorClientRequest = {
      kind: "unlock",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      password,
      publicKeyHex,
      expectedSessionEpoch: this.state.sessionEpoch,
    };
    const response = await this.sendRequest(request);
    return response.ack;
  }

  async lock(): Promise<CoordinatorCommandAck> {
    const request: CoordinatorClientRequest = {
      kind: "lock",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      expectedSessionEpoch: this.state.sessionEpoch,
    };
    const response = await this.sendRequest(request);
    return response.ack;
  }

  async activateKey(password: string, publicKeyHex: string): Promise<CoordinatorCommandAck> {
    const request: CoordinatorClientRequest = {
      kind: "activate-key",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      password,
      publicKeyHex,
      expectedSessionEpoch: this.state.sessionEpoch,
    };
    const response = await this.sendRequest(request);
    return response.ack;
  }

  async vaultOperation(operation: CoordinatorVaultOperation | string, input?: unknown): Promise<unknown> {
    const normalized = typeof operation === "string" ? ({ type: operation, ...(input as object ?? {}) } as unknown as CoordinatorVaultOperation) : operation;
    const response = await this.sendRequest({ kind: "vault.operation", clientId: this.clientId, requestId: this.generateRequestId(), operation: normalized, expectedSessionEpoch: this.state.sessionEpoch });
    if (response.ack.status !== "ok" && response.ack.status !== "accepted") throw new Error(response.ack.status === "error" ? response.ack.message : `Vault operation failed: ${response.ack.status}`);
    return response.operationResult;
  }

  async crypto(operation: CoordinatorCryptoOperation): Promise<{
    ack: CoordinatorCommandAck;
    result?: CoordinatorCryptoResult;
  }> {
    const request: CoordinatorClientRequest = {
      kind: "crypto",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      operation,
      expectedSessionEpoch: this.state.sessionEpoch,
    };
    const response = await this.sendRequest(request);
    return { ack: response.ack, result: response.cryptoResult };
  }

  async backgroundRunNow(taskId: string): Promise<CoordinatorCommandAck> {
    const request: CoordinatorClientRequest = {
      kind: "background.run-now",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      taskId,
      expectedSessionEpoch: this.state.sessionEpoch,
    };
    const response = await this.sendRequest(request);
    return response.ack;
  }

  async backgroundTrigger(taskId: string, reason: string): Promise<CoordinatorCommandAck> {
    const response = await this.sendRequest({ kind: "background.trigger", clientId: this.clientId, requestId: this.generateRequestId(), taskId, reason, expectedSessionEpoch: this.state.sessionEpoch });
    return response.ack;
  }

  async backgroundCancel(taskId: string): Promise<CoordinatorCommandAck> {
    const request: CoordinatorClientRequest = {
      kind: "background.cancel",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      taskId,
      expectedSessionEpoch: this.state.sessionEpoch,
    };
    const response = await this.sendRequest(request);
    return response.ack;
  }

  async backgroundCancelByKey(publicKeyHex: string): Promise<CoordinatorCommandAck> {
    const response = await this.sendRequest({ kind: "background.cancel-by-key", clientId: this.clientId, requestId: this.generateRequestId(), publicKeyHex, expectedSessionEpoch: this.state.sessionEpoch });
    return response.ack;
  }

  async backgroundSettingsUpdate(settings: CoordinatorBackgroundSyncSettings): Promise<CoordinatorCommandAck> {
    const request: CoordinatorClientRequest = {
      kind: "background.settings.update",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      settings,
      expectedSessionEpoch: this.state.sessionEpoch,
    };
    const response = await this.sendRequest(request);
    return response.ack;
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

  private async sendRequest(request: CoordinatorClientRequest): Promise<CoordinatorResponse> {
    if (!this.isConnected || !this.port) {
      throw new Error("Not connected to Coordinator");
    }

    const requestId = "requestId" in request ? request.requestId : this.generateRequestId();

    return new Promise<CoordinatorResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.isConnected = false;
        this.resetDisconnectedState();
        this.scheduleReconnect();
        reject(new Error("Request timeout"));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      try {
        this.port!.postMessage(request);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(err);
      }
    });
  }

  // ============================================================
  // 7. State Access
  // ============================================================

  getState(): CoordinatorClientState {
    return { ...this.state };
  }

  getSessionEpoch(): SessionEpoch {
    return this.state.sessionEpoch;
  }

  getVaultStatus(): CoordinatorVaultStatus {
    return this.state.vaultStatus;
  }

  getActivePublicKeyHex(): string | undefined {
    return this.state.activePublicKeyHex;
  }

  getKeyspaceGeneration(): number {
    return this.state.keyspaceGeneration;
  }

  getTaskSnapshots(): CoordinatorTaskSnapshot[] {
    return [...this.state.taskSnapshots];
  }

  getScheduleSettings(): CoordinatorBackgroundSyncSettings {
    return { ...this.state.scheduleSettings };
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  // ============================================================
  // 8. Event Listeners
  // ============================================================

  onStateChange(listener: EventListener<CoordinatorClientState>): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => { this.stateListeners.delete(listener); };
  }

  onEvent(eventType: CoordinatorEvent["type"], listener: EventListener<CoordinatorEvent>): () => void {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, new Set());
    }
    this.eventListeners.get(eventType)!.add(listener);
    return () => { this.eventListeners.get(eventType)?.delete(listener); };
  }

  onAnyEvent(listener: EventListener<CoordinatorEvent>): () => void {
    return this.onEvent("*" as CoordinatorEvent["type"], listener);
  }

  private notifyStateListeners(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) {
      try { listener(state); } catch { /* noop */ }
    }
  }

  private notifyEventListeners(event: CoordinatorEvent): void {
    const listeners = this.eventListeners.get(event.type);
    if (listeners) {
      for (const listener of listeners) {
        try { listener(event); } catch { /* noop */ }
      }
    }

    const wildcardListeners = this.eventListeners.get("*" as CoordinatorEvent["type"]);
    if (wildcardListeners) {
      for (const listener of wildcardListeners) {
        try { listener(event); } catch { /* noop */ }
      }
    }
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
