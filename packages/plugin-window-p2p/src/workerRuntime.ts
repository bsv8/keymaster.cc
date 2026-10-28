import { defineWorkerRequestRoute } from "@keymaster/contracts";
import {
  MSFILE_MAX_BLOCK_BYTES, MSFILE_MAX_SEED_BYTES, SAT_SUBSCRIPTION_RESOURCE_LIMITS, type CoordinatorClientRequest, type CoordinatorResponse,
  type WindowP2pExecutorLease, type WindowP2pExecutorError, type WindowP2pIdentitySignResult,
  type SatWindowLaneOperation, type SatWindowLaneSspRequestEvent, type SessionEpoch,
} from "@keymaster/contracts";
import type { WindowP2pExecutorOperation, WindowP2pExecutorConcurrencyConfig } from "@keymaster/contracts/window-p2p";
import { noiseSigningPayload, peerIdFromPublicKeyBytes, parsePeerId, peerRecordUnsigned, sha256Bytes } from "bitcoin-libp2p/identity";
import { MAX_WIRE_BYTES } from "sat-subscription-protocol/protocol";
import { createWorkerBridgeBudget } from "./workerBridgeBudget.js";
declare const __KEYMASTER_MSFILE_SPIKE__: boolean;

export interface WindowP2pExecutorLeaseState extends WindowP2pExecutorLease {
  clientId: string;
  ownerPublicKeyHex: string;
  acquiredAt: number;
  lastPeerRecordSequence?: bigint;
  /** 生产 Window executor 的专用数据面通道；Spike lease 没有此字段。 */
  transportPort?: MessagePort;
  transportReady: boolean;
  /** Window 已应用的读取配置版本；未 ACK 时为 -1。 */
  transportConfigVersion: number;
}

interface WindowP2pExecutorBridgePending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  leaseId: string;
  cleanup?: () => void;
  reservedBytes: number;
  /** bridge 在途操作项数；小 Wire 也必须占用一个 item 配额。 */
  reservedItems: number;
}

interface WindowP2pExecutorInboundBridgePending {
  leaseId: string;
  supplierId: string;
  connectionId: string;
  ownerSessionEpoch: string;
  supplierGeneration: number;
  eventId: string;
  reservedBytes: number;
  reservedItems: number;
}

export interface ActiveSatInboundHandler {
  /** Window executor 租约编号。 */
  leaseId: string;
  /** 本次入站事件编号。 */
  eventId: string;
  /** Supplier 配置编号。 */
  supplierId: string;
  /** 真实连接实例编号。 */
  connectionId: string;
  /** 当前 owner 会话代际。 */
  ownerSessionEpoch: string;
  /** Supplier 配置代际。 */
  supplierGeneration: number;
  /** 传给支持取消的内部操作。 */
  controller: AbortController;
  /** 是否已经收到 event-cancel 或 lease/owner revoke。 */
  canceled: boolean;
  /** 入站 Wire 的 bridge 字节是否已经释放。 */
  bridgeBytesReleased: boolean;
}

export type WindowP2pExecutorRequest = Extract<CoordinatorClientRequest, { kind: "window-p2p.executor.acquire" | "window-p2p.executor.release" | "window-p2p.executor.spike.transfer" | "window-p2p.executor.identity.sign-noise" | "window-p2p.executor.identity.sign-peer-record" }>;
type ConnectionFence = { supplierId: string; ownerSessionEpoch: string; supplierGeneration: number };
export interface WindowP2pWorkerPorts {
  session(): { vaultStatus: string; sessionEpoch: string; activePublicKeyHex?: string };
  configuration(): WindowP2pExecutorConcurrencyConfig;
  admission: { disconnected(peerId: string): boolean; response(requestId: string): CoordinatorResponse };
  lifecycle: { activate(): void; stop(): void };
  signing: {
    publicKey(): Uint8Array;
    sign(request: Extract<CoordinatorClientRequest, { kind: "window-p2p.executor.identity.sign-noise" | "window-p2p.executor.identity.sign-peer-record" }>, digest: Uint8Array, owner: string, signal: AbortSignal): Promise<Uint8Array>;
  };
  inbound: {
    request(connectionId: string): (ConnectionFence & { handler(wire: Uint8Array): Promise<Uint8Array> }) | undefined;
    state(connectionId: string): (ConnectionFence & { handler(state: "online" | "degraded" | "closed"): void }) | undefined;
    clearStates(): void;
  };
  events: {
    changed(): void; ready(): void; revoked(): void;
    sellerEvent(event: object, lease: WindowP2pExecutorLeaseState): void;
  };
}

/** Window P2P 拥有唯一 executor、桥接额度、入站任务和签名排队；只读取会话快照。 */
export function createWindowP2pWorkerRuntime(ports: WindowP2pWorkerPorts) {
  const windowP2pExecutorIdentityRequests = new Map<string, { controller: AbortController; clientId: string; leaseId: string }>();
  const windowP2pExecutorIdentityRequestKey = (clientId: string, requestId: string): string => `${clientId}\u0000${requestId}`;
  let windowP2pExecutorLease: WindowP2pExecutorLeaseState | undefined;

  const windowP2pExecutorBridgePending = new Map<string, WindowP2pExecutorBridgePending>();

  const windowP2pExecutorInboundBridgePending = new Map<string, WindowP2pExecutorInboundBridgePending>();

  const activeSatInboundHandlers = new Map<string, ActiveSatInboundHandler>();

  let testSatInboundResponseDispatcher: ((operation: SatWindowLaneOperation, signal: AbortSignal) => Promise<unknown>) | undefined;

  const WINDOW_P2P_EXECUTOR_LEASE_TTL_MS = 5 * 60 * 1000;

  const WINDOW_P2P_EXECUTOR_PRE_SIGN_YIELD_MS = typeof __KEYMASTER_MSFILE_SPIKE__ !== "undefined" && __KEYMASTER_MSFILE_SPIKE__
    ? 250
    : 25;

  const WINDOW_P2P_EXECUTOR_TRANSFER_MAX_ITEMS = 5;

  const WINDOW_P2P_EXECUTOR_TRANSFER_MAX_BYTES = 17 * 1024 * 1024;

  const WINDOW_P2P_EXECUTOR_TRANSFER_MAX_ITEM_BYTES = 16 * 1024 * 1024;

  const UINT64_MAX = (1n << 64n) - 1n;

  let windowP2pExecutorLeaseTimer: ReturnType<typeof setTimeout> | undefined;

  let windowP2pExecutorIdentityTail: Promise<void> = Promise.resolve();

  let windowP2pExecutorTransferPendingItems = 0;

  let windowP2pExecutorTransferPendingBytes = 0;

  let windowP2pExecutorTransferPeakBytes = 0;

  function rejectWindowP2pExecutorBridgePending(error: Error): void {
    windowP2pBridgeBudget.reset(error);
    for (const [requestId, pending] of windowP2pExecutorBridgePending) {
      windowP2pExecutorBridgePending.delete(requestId);
      windowP2pBridgeBudget.drop(pending.reservedBytes, pending.reservedItems);
      pending.cleanup?.();
      pending.reject(error);
    }
    cancelSatInboundHandlers(undefined, error.message);
    windowP2pExecutorInboundBridgePending.clear();

  }

  const windowP2pBridgeBudget = createWorkerBridgeBudget({ configuration: ports.configuration, error: windowP2pError });

  const pumpWindowP2pExecutorBridgeBudget = windowP2pBridgeBudget.pump;

  const reserveWindowP2pExecutorBridgeBytes = windowP2pBridgeBudget.reserve;

  const releaseWindowP2pExecutorBridgeBytes = windowP2pBridgeBudget.release;

  function inboundBridgeEventKey(connectionId: string, eventId: string): string {
    return connectionId + "\u0000" + eventId;
  }

  function reserveWindowP2pExecutorInboundEvent(event: SatWindowLaneSspRequestEvent, lease: WindowP2pExecutorLeaseState): boolean {
    const reservedBytes = event.wire.byteLength;
    const maxBytes = Math.min(ports.configuration().bridgeMaxInFlightBytes, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes);
    const maxItems = Math.min(ports.configuration().bridgeMaxPendingItems, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgePendingItems);
    const key = inboundBridgeEventKey(event.connectionId, event.eventId);
    if (reservedBytes < 1 || reservedBytes > maxBytes || windowP2pExecutorInboundBridgePending.has(key)) return false;
    if (!windowP2pBridgeBudget.reserveInbound(reservedBytes)) return false;
    windowP2pExecutorInboundBridgePending.set(key, {
      leaseId: lease.leaseId,
      supplierId: event.supplierId,
      connectionId: event.connectionId,
      ownerSessionEpoch: event.ownerSessionEpoch,
      supplierGeneration: event.supplierGeneration,
      eventId: event.eventId,
      reservedBytes,
      reservedItems: 1,
    });
    return true;
  }

  function releaseWindowP2pExecutorInboundEvent(event: Pick<SatWindowLaneSspRequestEvent, "connectionId" | "eventId">, leaseId: string): void {
    const key = inboundBridgeEventKey(event.connectionId, event.eventId);
    const pending = windowP2pExecutorInboundBridgePending.get(key);
    if (!pending || pending.leaseId !== leaseId) return;
    windowP2pExecutorInboundBridgePending.delete(key);
    releaseWindowP2pExecutorBridgeBytes(pending.reservedBytes, pending.reservedItems);
  }

  function activeSatInboundHandlerKey(task: Pick<ActiveSatInboundHandler, "leaseId" | "connectionId" | "eventId">): string {
    return task.leaseId + "\u0000" + task.connectionId + "\u0000" + task.eventId;
  }

  function releaseSatInboundHandlerBridge(task: ActiveSatInboundHandler): void {
    if (task.bridgeBytesReleased) return;
    task.bridgeBytesReleased = true;
    releaseWindowP2pExecutorInboundEvent({ connectionId: task.connectionId, eventId: task.eventId }, task.leaseId);
  }

  function cancelSatInboundHandler(task: ActiveSatInboundHandler, reason = "Sat inbound handler was canceled"): void {
    if (!task.canceled) {
      task.canceled = true;
      try { task.controller.abort(new DOMException(reason, "AbortError")); } catch { /* AbortController 已结束 */ }
    }
    // 取消可以立即释放 bridge 中的 Wire，但 active handler slot 要等真实
    // Promise settle 后才由 finishSatInboundHandler 释放。
    releaseSatInboundHandlerBridge(task);
  }

  function cancelSatInboundHandlers(leaseId?: string, reason = "Sat inbound handler was canceled"): void {
    for (const task of activeSatInboundHandlers.values()) {
      if (leaseId !== undefined && task.leaseId !== leaseId) continue;
      cancelSatInboundHandler(task, reason);
    }
  }

  function cancelSatInboundHandlersForConnection(connectionId: string, reason = "Sat connection was closed"): void {
    for (const task of activeSatInboundHandlers.values()) {
      if (task.connectionId === connectionId) cancelSatInboundHandler(task, reason);
    }
  }

  function beginSatInboundHandler(event: SatWindowLaneSspRequestEvent, lease: WindowP2pExecutorLeaseState): ActiveSatInboundHandler | undefined {
    if (activeSatInboundHandlers.size >= SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxActiveWorkerInboundHandlers) return undefined;
    const task: ActiveSatInboundHandler = {
      leaseId: lease.leaseId,
      eventId: event.eventId,
      supplierId: event.supplierId,
      connectionId: event.connectionId,
      ownerSessionEpoch: event.ownerSessionEpoch,
      supplierGeneration: event.supplierGeneration,
      controller: new AbortController(),
      canceled: false,
      bridgeBytesReleased: false,
    };
    const key = activeSatInboundHandlerKey(task);
    if (activeSatInboundHandlers.has(key)) return undefined;
    activeSatInboundHandlers.set(key, task);
    return task;
  }

  function isCurrentSatInboundHandler(task: ActiveSatInboundHandler): boolean {
    return activeSatInboundHandlers.get(activeSatInboundHandlerKey(task)) === task
      && !task.canceled
      && windowP2pExecutorLease?.leaseId === task.leaseId
      && ports.session().sessionEpoch === task.ownerSessionEpoch
      && ports.session().vaultStatus === "unlocked"
      && ports.inbound.request(task.connectionId)?.supplierId === task.supplierId
      && ports.inbound.request(task.connectionId)?.ownerSessionEpoch === task.ownerSessionEpoch
      && ports.inbound.request(task.connectionId)?.supplierGeneration === task.supplierGeneration;
  }

  function finishSatInboundHandler(task: ActiveSatInboundHandler): void {
    const key = activeSatInboundHandlerKey(task);
    if (activeSatInboundHandlers.get(key) !== task) return;
    activeSatInboundHandlers.delete(key);
    releaseSatInboundHandlerBridge(task);
  }

  function windowP2pError(code: string, message: string, sentBoundary?: "not-sent" | "unknown"): Error & WindowP2pExecutorError {
    const error = new Error(message) as Error & WindowP2pExecutorError;
    error.domain = "window-p2p";
    error.code = code;
    if (sentBoundary) error.sentBoundary = sentBoundary;
    return error;
  }

  function handleWindowP2pExecutorPortMessage(event: MessageEvent): void {
    const data = event.data as {
      type?: string;
      leaseId?: string;
      requestId?: string;
      ok?: boolean;
      result?: unknown;
      error?: WindowP2pExecutorError;
      version?: number;
      event?: unknown;
      laneId?: string;
      eventId?: string;
      connectionId?: string;
    } | undefined;
    if (!data || data.type === undefined) return;
    const lease = windowP2pExecutorLease;
    if (!lease || data.leaseId !== lease.leaseId) return;
    if (data.type === "ready") {
      lease.transportReady = data.ok === true;
      lease.transportConfigVersion = -1;
      if (!lease.transportReady) {
        clearWindowP2pExecutorLeaseLocked();
      } else {
        // 新 Host 就绪后卖方 stream 通道恢复；若卖方仍启用则回到 ready/selling。
        ports.events.ready();
        void syncWindowP2pExecutorConfig().catch(() => {
          if (windowP2pExecutorLease?.leaseId === lease.leaseId) clearWindowP2pExecutorLeaseLocked();
        });
      }
      ports.events.changed();
      return;
    }
    if (data.type === "config-ack" && typeof data.version === "number") {
      if (!data.ok || data.version !== ports.configuration().version) {
        if (!data.ok && windowP2pExecutorLease?.leaseId === lease.leaseId) clearWindowP2pExecutorLeaseLocked();
        return;
      }
      lease.transportConfigVersion = data.version;
      windowP2pExecutorConfigSync?.resolve();
      windowP2pExecutorConfigSync = undefined;
      pumpWindowP2pExecutorBridgeBudget();
      ports.events.changed();
      return;
    }
    if (data.type === "event-cancel" && typeof data.eventId === "string" && data.eventId.length > 0) {
      // event 与 cancel 使用同一 MessagePort，正常情况下 event 先到这里。
      // 取消状态保存在权威 active handler 表；不能用独立 Set 代替任务 slot。
      const task = [...activeSatInboundHandlers.values()].find((item) => item.leaseId === lease.leaseId
        && item.eventId === data.eventId
        && (data.connectionId === undefined || item.connectionId === data.connectionId));
      if (task) {
        cancelSatInboundHandler(task, "Sat inbound event was canceled by Window");
        return;
      }
      // 极窄的 event 已准入但尚未创建业务 task 的窗口仍然释放 bridge；
      // MessagePort 顺序保证它不会在取消后重新进入 handler。
      const pending = [...windowP2pExecutorInboundBridgePending.values()].find((item) => item.leaseId === lease.leaseId
        && item.eventId === data.eventId
        && (data.connectionId === undefined || item.connectionId === data.connectionId));
      if (pending) releaseWindowP2pExecutorInboundEvent({ connectionId: pending.connectionId, eventId: pending.eventId }, lease.leaseId);
      return;
    }
    if (data.type === "event") {
      const eventValue = data.event;
      if (eventValue && typeof eventValue === "object" && (eventValue as { type?: unknown }).type === "ssp.state") {
        const stateEvent = eventValue as {
          type: "ssp.state";
          supplierId?: unknown;
          connectionId?: unknown;
          ownerSessionEpoch?: unknown;
          supplierGeneration?: unknown;
          state?: unknown;
        };
        const registration = typeof stateEvent.connectionId === "string"
          ? ports.inbound.state(stateEvent.connectionId)
          : undefined;
        if (registration
          && registration.supplierId === stateEvent.supplierId
          && registration.ownerSessionEpoch === stateEvent.ownerSessionEpoch
          && registration.supplierGeneration === stateEvent.supplierGeneration
          && (stateEvent.state === "online" || stateEvent.state === "degraded" || stateEvent.state === "closed")) {
          registration.handler(stateEvent.state);
        }
        return;
      }
      if (eventValue && typeof eventValue === "object"
        && ((eventValue as { type?: unknown }).type === "bitfs-seller-frame"
          || (eventValue as { type?: unknown }).type === "bitfs-seller-session-closed"
          || (eventValue as { type?: unknown }).type === "bitfs-webrtc-frame"
          || (eventValue as { type?: unknown }).type === "bitfs-webrtc-quote-sent"
          || (eventValue as { type?: unknown }).type === "bitfs-webrtc-signal-outbound"
          || (eventValue as { type?: unknown }).type === "bitfs-webrtc-runtime-error"
          || (eventValue as { type?: unknown }).type === "bitfs-webrtc-session-closed")) {
        // BitFS 卖方会话事件：只允许路由到当前唯一会话管理器；无 bridge 额度。
        ports.events.sellerEvent(eventValue, lease);
        return;
      }
      if (!eventValue || typeof eventValue !== "object" || (eventValue as { type?: unknown }).type !== "ssp.request") {
        // Window 在发送前已经为每个 SSP eventId 预占额度；即使事件形状
        // 损坏，也必须走 reject 闭环，不能让 Window reservation 永久泄漏。
        sendSatWindowEventReject(lease, eventValue, windowP2pError("ERR_INVALID_INBOUND_EVENT", "Window P2P inbound SSP event is invalid", "not-sent"));
        return;
      }
      const event = eventValue as SatWindowLaneSspRequestEvent;
      if (typeof event.supplierId !== "string" || typeof event.connectionId !== "string"
        || event.supplierId.length === 0 || event.connectionId.length === 0
        || typeof event.ownerSessionEpoch !== "string" || event.ownerSessionEpoch.length === 0
        || !Number.isSafeInteger(event.supplierGeneration) || event.supplierGeneration < 1
        || typeof event.eventId !== "string" || event.eventId.length === 0 || !(event.wire instanceof Uint8Array)) {
        sendSatWindowEventReject(lease, eventValue, windowP2pError("ERR_INVALID_INBOUND_EVENT", "Window P2P inbound SSP event is invalid", "not-sent"));
        return;
      }
      // Window 已在发送前做过一次预占；Worker 仍必须重新核算，不能信任
      // 任意 Tab 传来的 event size，且请求/响应/入站事件共用总预算。
      if (!reserveWindowP2pExecutorInboundEvent(event, lease)) {
        sendSatWindowEventReject(lease, event, windowP2pError("ERR_BRIDGE_BYTES_LIMIT", "Window P2P inbound SSP bridge budget is full", "not-sent"));
        return;
      }
      const task = beginSatInboundHandler(event, lease);
      if (!task) {
        releaseWindowP2pExecutorInboundEvent(event, lease.leaseId);
        sendSatWindowEventReject(lease, event, windowP2pError("ERR_INBOUND_HANDLER_LIMIT", "Sat inbound Worker handler limit reached", "not-sent"));
        return;
      }
      void handleSatWindowEvent(event, lease, task);
      return;
    }
    if (data.type !== "response" || typeof data.requestId !== "string") return;
    const pending = windowP2pExecutorBridgePending.get(data.requestId);
    if (!pending || pending.leaseId !== lease.leaseId) return;
    windowP2pExecutorBridgePending.delete(data.requestId);
    releaseWindowP2pExecutorBridgeBytes(pending.reservedBytes, pending.reservedItems);
    pending.cleanup?.();
    if (data.ok === true) pending.resolve(data.result);
    else pending.reject(restoreWindowP2pError(data.error));
  }

  function restoreWindowP2pError(value: unknown): Error & WindowP2pExecutorError {
    if (value && typeof value === "object") {
      const item = value as Partial<WindowP2pExecutorError>;
      if ((item.domain === "window-p2p" || item.domain === "sat-transport" || item.domain === "msfile-transport")
        && typeof item.code === "string" && item.code.length > 0 && typeof item.message === "string"
        && (item.sentBoundary === undefined || item.sentBoundary === "not-sent" || item.sentBoundary === "unknown")) {
        const error = new Error(item.message) as Error & WindowP2pExecutorError;
        error.domain = item.domain;
        error.code = item.code;
        if (item.sentBoundary) error.sentBoundary = item.sentBoundary;
        return error;
      }
    }
    return windowP2pError("ERR_BRIDGE_RESPONSE", "Window P2P bridge returned an invalid error");
  }

  function attachWindowP2pExecutorPort(port: MessagePort, clientId: string, leaseId: string): void {
    if (!port || typeof port.postMessage !== "function" || typeof port.start !== "function") {
      throw new Error("invalid Window P2P executor port");
    }
    const lease = windowP2pExecutorLease;
    if (!lease || lease.clientId !== clientId || lease.leaseId !== leaseId) {
      try { port.close(); } catch { /* already closed */ }
      return;
    }
    lease.transportPort = port;
    lease.transportReady = false;
    lease.transportConfigVersion = -1;
    port.onmessage = handleWindowP2pExecutorPortMessage;
    port.onmessageerror = () => {
      if (windowP2pExecutorLease?.leaseId === leaseId) clearWindowP2pExecutorLeaseLocked();
    };
    port.start();
  }

  let windowP2pExecutorConfigSync: {
    leaseId: string;
    version: number;
    resolve: () => void;
    reject: (error: Error) => void;
    promise: Promise<void>;
  } | undefined;

  function syncWindowP2pExecutorConfig(): Promise<void> {
    const lease = windowP2pExecutorLease;
    if (!lease?.transportPort || !lease.transportReady || lease.sessionEpoch !== ports.session().sessionEpoch) {
      return Promise.reject(windowP2pError("ERR_EXECUTOR_UNAVAILABLE", "Window P2P executor is unavailable"));
    }
    if (lease.transportConfigVersion === ports.configuration().version) return Promise.resolve();
    if (windowP2pExecutorConfigSync?.leaseId === lease.leaseId && windowP2pExecutorConfigSync.version === ports.configuration().version) {
      return windowP2pExecutorConfigSync.promise;
    }
    windowP2pExecutorConfigSync?.reject(windowP2pError("ERR_CONFIG_SUPERSEDED", "Window P2P executor concurrency config was superseded"));
    let resolveFn!: () => void;
    let rejectFn!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    windowP2pExecutorConfigSync = {
      leaseId: lease.leaseId,
      version: ports.configuration().version,
      resolve: resolveFn,
      reject: rejectFn,
      promise,
    };
    try {
      lease.transportPort.postMessage({ type: "config", leaseId: lease.leaseId, config: ports.configuration() });
    } catch (error) {
      windowP2pExecutorConfigSync = undefined;
      rejectFn(windowP2pError("ERR_BRIDGE_POST", "Window P2P executor config could not be sent", "not-sent"));
    }
    return promise;
  }

  function awaitWindowP2pExecutorConfig(signal?: AbortSignal): Promise<void> {
    const promise = syncWindowP2pExecutorConfig();
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  async function requestWindowP2pExecutorOperation(operation: WindowP2pExecutorOperation, signal?: AbortSignal): Promise<unknown> {
    const lease = windowP2pExecutorLease;
    if (!lease || !lease.transportPort || !lease.transportReady || lease.sessionEpoch !== ports.session().sessionEpoch) {
      throw windowP2pError("ERR_EXECUTOR_UNAVAILABLE", "Window P2P executor is unavailable");
    }
    await awaitWindowP2pExecutorConfig(signal);
    const currentLease = windowP2pExecutorLease;
    if (!currentLease || !currentLease.transportPort || !currentLease.transportReady || currentLease.sessionEpoch !== ports.session().sessionEpoch) {
      throw windowP2pError("ERR_EXECUTOR_REVOKED", "Window P2P executor lease is no longer current");
    }
    const dispatchOperation = cloneWindowP2pOperationWire(operation);
    const requestId = "window-p2p-exec-data-" + crypto.randomUUID();
    const request = { type: "request", leaseId: currentLease.leaseId, requestId, operation: dispatchOperation };
    const laneOperation = dispatchOperation.type === "lane" && dispatchOperation.operation && typeof dispatchOperation.operation === "object"
      ? dispatchOperation.operation as { type?: unknown; kind?: unknown; wire?: unknown; frame?: unknown }
      : undefined;
    const reservedBytes = windowP2pExecutorBridgeBytesForOperation(dispatchOperation);
    await reserveWindowP2pExecutorBridgeBytes(reservedBytes, signal);
    if (signal?.aborted) {
      releaseWindowP2pExecutorBridgeBytes(reservedBytes);
      throw new DOMException("The operation was aborted", "AbortError");
    }
    // reserve 会让出事件循环；期间可能发生 lock、key switch 或 takeover。
    // 不能把已占用的 bridge 预算继续投递到旧 MessagePort。
    const afterReserveLease = windowP2pExecutorLease;
    if (afterReserveLease?.leaseId !== currentLease.leaseId || afterReserveLease.transportPort !== currentLease.transportPort || afterReserveLease.sessionEpoch !== ports.session().sessionEpoch) {
      releaseWindowP2pExecutorBridgeBytes(reservedBytes);
      throw windowP2pError("ERR_EXECUTOR_REVOKED", "Window P2P executor lease changed before dispatch");
    }
    return new Promise<unknown>((resolve, reject) => {
      const pending: WindowP2pExecutorBridgePending = { resolve, reject, leaseId: currentLease.leaseId, reservedBytes, reservedItems: 1 };
      windowP2pExecutorBridgePending.set(requestId, pending);
      const onAbort = () => {
        if (!windowP2pExecutorBridgePending.delete(requestId)) return;
        releaseWindowP2pExecutorBridgeBytes(pending.reservedBytes);
        try { currentLease.transportPort?.postMessage({ type: "cancel", leaseId: currentLease.leaseId, requestId }); } catch { /* executor may be gone */ }
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      try {
        const transfer: Transferable[] = laneOperation?.wire instanceof Uint8Array
          ? [laneOperation.wire.buffer]
          : laneOperation?.frame instanceof Uint8Array
            ? [laneOperation.frame.buffer]
            : [];
        currentLease.transportPort!.postMessage(request, transfer);
      } catch (error) {
        if (windowP2pExecutorBridgePending.delete(requestId)) {
          releaseWindowP2pExecutorBridgeBytes(pending.reservedBytes);
          pending.cleanup?.();
          reject(windowP2pError("ERR_BRIDGE_POST", "Window P2P executor operation could not be sent", "not-sent"));
        }
      }
    });
  }

  function cloneWindowP2pOperationWire(operation: WindowP2pExecutorOperation): WindowP2pExecutorOperation {
    if (operation.type !== "lane" || !operation.operation || typeof operation.operation !== "object") return operation;
    const laneOperation = operation.operation as { wire?: unknown; frame?: unknown };
    const binaryKey = laneOperation.wire instanceof Uint8Array
      ? "wire"
      : laneOperation.frame instanceof Uint8Array
        ? "frame"
        : undefined;
    if (!binaryKey) return operation;
    const binary = binaryKey === "wire" ? laneOperation.wire : laneOperation.frame;
    return {
      ...operation,
      operation: {
        ...(operation.operation as Record<string, unknown>),
        [binaryKey]: binary instanceof Uint8Array ? binary.slice() : undefined,
      },
    };
  }

  function windowP2pExecutorBridgeBytesForOperation(operation: WindowP2pExecutorOperation): number {
    if (operation.type !== "lane" || !operation.operation || typeof operation.operation !== "object") return 0;
    const laneOperation = operation.operation as { type?: unknown; kind?: unknown; wire?: unknown; frame?: unknown; requestBytesHex?: unknown };
    if ((laneOperation.type === "requestSsp" || laneOperation.type === "requestSpi") && laneOperation.wire instanceof Uint8Array) {
      return laneOperation.wire.byteLength + MAX_WIRE_BYTES;
    }
    if (laneOperation.wire instanceof Uint8Array) return laneOperation.wire.byteLength;
    if (laneOperation.frame instanceof Uint8Array) return laneOperation.frame.byteLength;
    if (laneOperation.type === "read") return laneOperation.kind === "block" ? MSFILE_MAX_BLOCK_BYTES : MSFILE_MAX_SEED_BYTES;
    return 0;
  }

  function satWindowLaneOperation(operation: SatWindowLaneOperation, signal?: AbortSignal): Promise<unknown> {
    return requestWindowP2pExecutorOperation({ type: "lane", laneId: "sat-subscription", operation }, signal);
  }

  function asSatWire(value: unknown, label: string): Uint8Array {
    if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error(`${label} returned an invalid Wire`);
    return value.slice();
  }

  function satWindowEventReference(rawEvent: unknown): Record<string, unknown> {
    if (!rawEvent || typeof rawEvent !== "object") return { type: "ssp.request" };
    const value = rawEvent as Partial<SatWindowLaneSspRequestEvent>;
    return {
      type: "ssp.request",
      ...(typeof value.eventId === "string" ? { eventId: value.eventId } : {}),
      ...(typeof value.supplierId === "string" ? { supplierId: value.supplierId } : {}),
      ...(typeof value.connectionId === "string" ? { connectionId: value.connectionId } : {}),
      ...(typeof value.ownerSessionEpoch === "string" ? { ownerSessionEpoch: value.ownerSessionEpoch } : {}),
      ...(Number.isSafeInteger(value.supplierGeneration) ? { supplierGeneration: value.supplierGeneration } : {}),
    };
  }

  function sendSatWindowEventReject(
    lease: WindowP2pExecutorLeaseState,
    rawEvent: unknown,
    error: WindowP2pExecutorError,
  ): void {
    const reference = satWindowEventReference(rawEvent);
    if (typeof reference.eventId !== "string") return;
    try {
      lease.transportPort?.postMessage({
        type: "event-reject",
        leaseId: lease.leaseId,
        laneId: "sat-subscription",
        event: reference,
        error,
      });
    } catch {
      // Window 不可达时 lease revoke 会清理本地 pending 和 bridge 额度。
    }
  }

  function sendSatWindowEventRelease(lease: WindowP2pExecutorLeaseState, event: SatWindowLaneSspRequestEvent): void {
    try {
      lease.transportPort?.postMessage({ type: "event-release", leaseId: lease.leaseId, eventId: event.eventId });
    } catch {
      // Window 不可达时本地 stop/revoke 会清理 reservation。
    }
  }

  async function handleSatWindowEvent(
    rawEvent: unknown,
    lease: WindowP2pExecutorLeaseState,
    task: ActiveSatInboundHandler,
  ): Promise<void> {
    const event = rawEvent as SatWindowLaneSspRequestEvent;
    try {
      if (!rawEvent || typeof rawEvent !== "object" || (rawEvent as { type?: unknown }).type !== "ssp.request"
        || typeof event.supplierId !== "string" || typeof event.connectionId !== "string"
        || typeof event.ownerSessionEpoch !== "string" || !Number.isSafeInteger(event.supplierGeneration)
        || typeof event.eventId !== "string" || !(event.wire instanceof Uint8Array)) return;
      if (task.canceled) return;
      const registration = ports.inbound.request(event.connectionId);
      if (!registration || registration.supplierId !== event.supplierId || registration.ownerSessionEpoch !== event.ownerSessionEpoch || registration.supplierGeneration !== event.supplierGeneration) {
        sendSatWindowEventReject(lease, event, windowP2pError("ERR_STALE_CONNECTION", "Sat inbound Publish belongs to a stale connection", "not-sent"));
        return;
      }
      // 先移交唯一 Wire 引用，再把 event 对象中的引用清空。取消时即使
      // handler 仍不支持 AbortSignal，Worker 也不会继续保留 bridge event buffer。
      const handlerWire = event.wire;
      event.wire = new Uint8Array();
      let response: Uint8Array;
      try {
        response = await registration.handler(handlerWire);
      } catch (error) {
        // Provider 已在可解析 request_id 的异常路径返回 ActionResult；若连
        // request_id 都无法取得，直接拒绝 lane pending，不能让 30 秒超时
        // 长期占用 Window/Worker 双向额度。
        if (!task.canceled && isCurrentSatInboundHandler(task)) {
          sendSatWindowEventReject(lease, event, windowP2pError("ERR_INCOMING_HANDLER", error instanceof Error ? error.message : "Sat inbound handler failed", "not-sent"));
        }
        return;
      }
      if (!isCurrentSatInboundHandler(task)) return;
      // 输入 Wire 已经被 handler 消费；先释放 Worker 入站额度，再为回写
      // ActionResult 预占出站额度。否则 32MiB 入站预算被占满时，handler 都
      // 会等待 response 额度，而 response 又只能在 handler finally 后释放，
      // 形成自锁。Window 侧 reservation 仍保持到 lane 收到 response/reject。
      releaseSatInboundHandlerBridge(task);
      try {
        const respond = testSatInboundResponseDispatcher ?? satWindowLaneOperation;
        await respond({ type: "respondSsp", supplierId: task.supplierId, connectionId: task.connectionId, ownerSessionEpoch: task.ownerSessionEpoch, supplierGeneration: task.supplierGeneration, eventId: task.eventId, wire: asSatWire(response, "Sat inbound response") }, task.controller.signal);
      } catch (error) {
        if (!task.canceled) {
          sendSatWindowEventReject(lease, event, windowP2pError("ERR_INCOMING_RESPONSE", error instanceof Error ? error.message : "Sat inbound response could not be written", "unknown"));
        }
      }
    } finally {
      finishSatInboundHandler(task);
      if (rawEvent && typeof rawEvent === "object" && (rawEvent as { type?: unknown }).type === "ssp.request") {
        sendSatWindowEventRelease(lease, event);
      }
    }
  }

  function clearWindowP2pExecutorLeaseTimer(): void {
    if (windowP2pExecutorLeaseTimer !== undefined) clearTimeout(windowP2pExecutorLeaseTimer);
    windowP2pExecutorLeaseTimer = undefined;
  }

  function scheduleWindowP2pExecutorLeaseExpiry(leaseId: string, acquiredAt: number): void {
    clearWindowP2pExecutorLeaseTimer();
    const remaining = Math.max(0, WINDOW_P2P_EXECUTOR_LEASE_TTL_MS - (Date.now() - acquiredAt));
    windowP2pExecutorLeaseTimer = setTimeout(() => {
      windowP2pExecutorLeaseTimer = undefined;
      if (windowP2pExecutorLease?.leaseId === leaseId && Date.now() - windowP2pExecutorLease.acquiredAt >= WINDOW_P2P_EXECUTOR_LEASE_TTL_MS) {
        clearWindowP2pExecutorLeaseLocked();
        ports.events.changed();
      }
    }, remaining);
  }

  function clearWindowP2pExecutorLeaseLocked(): void {
    clearWindowP2pExecutorLeaseTimer();
    if (windowP2pExecutorLease === undefined) {
      // Sat connection state callbacks are capability-bound too; do not leave
      // them behind merely because the Window lease was already cleared.
      ports.inbound.clearStates();
      return;
    }
    const oldLease = windowP2pExecutorLease;
    const revokedError = windowP2pError("ERR_EXECUTOR_REVOKED", "Window P2P executor lease was revoked");
    windowP2pExecutorConfigSync?.reject(revokedError);
    windowP2pExecutorConfigSync = undefined;
    rejectWindowP2pExecutorBridgePending(revokedError);
    try { oldLease.transportPort?.postMessage({ type: "revoked", leaseId: oldLease.leaseId }); } catch { /* executor may be gone */ }
    try { oldLease.transportPort?.close(); } catch { /* already closed */ }
    for (const [requestId, pending] of windowP2pExecutorIdentityRequests) {
      if (pending.leaseId === oldLease.leaseId) {
        pending.controller.abort();
        windowP2pExecutorIdentityRequests.delete(requestId);
      }
    }
    ports.lifecycle.stop();
    ports.inbound.clearStates();
    windowP2pExecutorLease = undefined;
    // 唯一 Window Host 消失后所有 BitFS 销售连接已不可用：立即清空会话并
    // 回到 degraded，不能停留在 selling。
    ports.events.revoked();
  }

  function acquireWindowP2pExecutorLease(input: {
    clientId: string;
    ownerPublicKeyHex: string;
  }): { ok: true; lease: WindowP2pExecutorLease } | { ok: false; reason: "locked" | "stale-epoch" | "owner-mismatch" | "busy" } {
    if (ports.session().vaultStatus !== "unlocked") return { ok: false, reason: "locked" };
    if (!ports.session().activePublicKeyHex || input.ownerPublicKeyHex !== ports.session().activePublicKeyHex) {
      return { ok: false, reason: "owner-mismatch" };
    }
    if (windowP2pExecutorLease !== undefined) {
      // 同 port 幂等续租；跨 port / 跨 owner 冲突一律拒绝。
      if (windowP2pExecutorLease.clientId === input.clientId && windowP2pExecutorLease.ownerPublicKeyHex === input.ownerPublicKeyHex) {
        windowP2pExecutorLease.acquiredAt = Date.now();
        scheduleWindowP2pExecutorLeaseExpiry(windowP2pExecutorLease.leaseId, windowP2pExecutorLease.acquiredAt);
        return { ok: true, lease: { leaseId: windowP2pExecutorLease.leaseId, sessionEpoch: windowP2pExecutorLease.sessionEpoch, activePublicKeyHex: windowP2pExecutorLease.ownerPublicKeyHex } };
      }
      // 有界 TTL：超过租期视为旧 executor 已死，允许接管。
      if (Date.now() - windowP2pExecutorLease.acquiredAt < WINDOW_P2P_EXECUTOR_LEASE_TTL_MS) {
        return { ok: false, reason: "busy" };
      }
      clearWindowP2pExecutorLeaseLocked();
    }
    const leaseId = `window-p2p-exec-lease-${crypto.randomUUID()}`;
    ports.lifecycle.activate();
    windowP2pExecutorLease = {
      leaseId,
      clientId: input.clientId,
      ownerPublicKeyHex: input.ownerPublicKeyHex,
      sessionEpoch: ports.session().sessionEpoch,
      activePublicKeyHex: input.ownerPublicKeyHex,
      acquiredAt: Date.now(),
      transportReady: false,
      transportConfigVersion: -1,
    };
    scheduleWindowP2pExecutorLeaseExpiry(leaseId, windowP2pExecutorLease.acquiredAt);
    return { ok: true, lease: { leaseId, sessionEpoch: windowP2pExecutorLease.sessionEpoch, activePublicKeyHex: input.ownerPublicKeyHex } };
  }

  function executorIdentityError(requestId: string, message: string, status: "error" | "validation-error" = "error"): CoordinatorResponse {
    return { requestId, sessionEpoch: ports.session().sessionEpoch, ack: status === "error" ? { status, message, code: "window_p2p_unavailable" } : { status, message } };
  }

  function parseUint64Decimal(value: string): bigint {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Peer Record sequence must be canonical uint64 decimal");
    const sequence = BigInt(value);
    if (sequence > UINT64_MAX) throw new Error("Peer Record sequence exceeds uint64");
    return sequence;
  }

  function currentExecutorPublicKey(): Uint8Array { return ports.signing.publicKey(); }

  function executorLeaseIsCurrent(leaseId: string, actualClientId: string, expectedSessionEpoch: SessionEpoch): WindowP2pExecutorLeaseState {
    const lease = windowP2pExecutorLease;
    if (
      lease === undefined ||
      lease.leaseId !== leaseId ||
      lease.clientId !== actualClientId ||
      lease.sessionEpoch !== expectedSessionEpoch ||
      lease.sessionEpoch !== ports.session().sessionEpoch ||
      lease.ownerPublicKeyHex !== ports.session().activePublicKeyHex ||
      lease.activePublicKeyHex !== ports.session().activePublicKeyHex ||
      ports.session().vaultStatus !== "unlocked"
    ) throw new Error("Window P2P executor lease is not valid");
    if (Date.now() - lease.acquiredAt >= WINDOW_P2P_EXECUTOR_LEASE_TTL_MS) {
      clearWindowP2pExecutorLeaseLocked();
      throw new Error("Window P2P executor lease expired");
    }
    return lease;
  }

  function assertExecutorIdentityStillCurrent(lease: WindowP2pExecutorLeaseState, actualClientId: string, expectedSessionEpoch: SessionEpoch, publicKeyHex: string): void {
    const fresh = executorLeaseIsCurrent(lease.leaseId, actualClientId, expectedSessionEpoch);
    if (fresh !== lease || fresh.ownerPublicKeyHex !== publicKeyHex || ports.session().activePublicKeyHex !== publicKeyHex) {
      throw new Error("Window P2P executor identity changed during signing");
    }
  }

  async function executeWindowP2pExecutorIdentitySign(
    request: Extract<CoordinatorClientRequest, { kind: "window-p2p.executor.identity.sign-noise" | "window-p2p.executor.identity.sign-peer-record" }>,
    actualClientId: string,
    signal: AbortSignal
  ): Promise<CoordinatorResponse> {
    const lease = executorLeaseIsCurrent(request.leaseId, actualClientId, request.expectedSessionEpoch);
    const publicKeyHex = ports.session().activePublicKeyHex!;
    const publicKey = currentExecutorPublicKey();
    if (signal.aborted) throw new Error("Window P2P identity signing was cancelled");

    let digest: Uint8Array;
    let peerRecordSequence: bigint | undefined;
    if (request.kind === "window-p2p.executor.identity.sign-noise") {
      const staticKey = new Uint8Array(request.noiseStaticPublicKey);
      if (staticKey.byteLength !== 32) throw new Error("Noise static public key must be exactly 32 bytes");
      digest = sha256Bytes(noiseSigningPayload(staticKey));
    } else {
      if (!Array.isArray(request.addresses) || request.addresses.length !== 0) {
        throw new Error("Signed Peer Record addresses must be empty in the Window P2P executor spike");
      }
      const sequence = parseUint64Decimal(request.sequence);
      const expectedPeerId = peerIdFromPublicKeyBytes(publicKey);
      const peerId = parsePeerId(request.peerId);
      if (peerId.toString() !== expectedPeerId.toString()) throw new Error("Peer Record PeerId does not match the active public key");
      if (lease.lastPeerRecordSequence !== undefined && sequence < lease.lastPeerRecordSequence) {
        throw new Error("Peer Record sequence must be monotonic per lease");
      }
      const unsigned = peerRecordUnsigned({ peerId, addresses: [], sequence }, expectedPeerId);
      digest = sha256Bytes(unsigned);
      // The sequence is reserved only after a successful, current-key signature.
      peerRecordSequence = sequence;
    }

    // 给已经排队的 lock / key-switch / port-lifecycle 事件一次抢占机会。
    // 本地 secp256k1 很快，若不跨 task，让步前后的二次 lease/epoch 栅栏
    // 在真实浏览器中无法被触发，也就不能证明“等待中的签名”会 fail closed。
    await new Promise<void>((resolve) => setTimeout(resolve, WINDOW_P2P_EXECUTOR_PRE_SIGN_YIELD_MS));
    if (signal.aborted) throw new Error("Window P2P identity signing was cancelled");
    assertExecutorIdentityStillCurrent(lease, actualClientId, request.expectedSessionEpoch, publicKeyHex);

    const signature = await ports.signing.sign(request, digest, publicKeyHex, signal);
    assertExecutorIdentityStillCurrent(lease, actualClientId, request.expectedSessionEpoch, publicKeyHex);
    if (signal.aborted) throw new Error("Window P2P identity signing was cancelled");
    if (request.kind === "window-p2p.executor.identity.sign-peer-record") {
      if (peerRecordSequence === undefined) throw new Error("Peer Record sequence was not retained");
      lease.lastPeerRecordSequence = peerRecordSequence;
    }
    lease.acquiredAt = Date.now();
    scheduleWindowP2pExecutorLeaseExpiry(lease.leaseId, lease.acquiredAt);
    return {
      requestId: request.requestId,
      sessionEpoch: ports.session().sessionEpoch,
      ack: { status: "ok" },
      operationResult: { signatureDer: signature.slice().buffer as ArrayBuffer } satisfies WindowP2pIdentitySignResult
    };
  }

  function enqueueWindowP2pExecutorIdentitySign(
    request: Extract<CoordinatorClientRequest, { kind: "window-p2p.executor.identity.sign-noise" | "window-p2p.executor.identity.sign-peer-record" }>,
    actualClientId: string,
    signal: AbortSignal
  ): Promise<CoordinatorResponse> {
    const run = windowP2pExecutorIdentityTail.then(
      () => executeWindowP2pExecutorIdentitySign(request, actualClientId, signal),
      () => executeWindowP2pExecutorIdentitySign(request, actualClientId, signal)
    );
    windowP2pExecutorIdentityTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function executeWindowP2pExecutorRequest(request: WindowP2pExecutorRequest, actualClientId: string): Promise<CoordinatorResponse> {
    if (ports.admission.disconnected(actualClientId)) return ports.admission.response(request.requestId);
    if (request.kind === "window-p2p.executor.acquire") {
      if (request.expectedSessionEpoch !== ports.session().sessionEpoch) {
        return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "stale-epoch" } };
      }
      if (request.executorPort && (typeof request.executorPort.postMessage !== "function" || typeof request.executorPort.start !== "function")) {
        try { request.executorPort.close(); } catch { /* malformed transferred value */ }
        return executorIdentityError(request.requestId, "invalid Window P2P executor port", "validation-error");
      }
      const result = acquireWindowP2pExecutorLease({ clientId: actualClientId, ownerPublicKeyHex: request.ownerPublicKeyHex });
      if (!result.ok) {
        try { request.executorPort?.close(); } catch { /* already detached */ }
        return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: `Window P2P executor lease rejected: ${result.reason}`, code: "window_p2p_unavailable" } };
      }
      if (request.executorPort) {
        try {
          attachWindowP2pExecutorPort(request.executorPort, actualClientId, result.lease.leaseId);
        } catch (error) {
          clearWindowP2pExecutorLeaseLocked();
          return executorIdentityError(request.requestId, error instanceof Error ? error.message : "invalid Window P2P executor port", "validation-error");
        }
      }
      ports.events.changed();
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" }, operationResult: result.lease };
    }
    if (request.kind === "window-p2p.executor.release") {
      if (windowP2pExecutorLease !== undefined && windowP2pExecutorLease.leaseId === request.leaseId && windowP2pExecutorLease.clientId === actualClientId) {
        clearWindowP2pExecutorLeaseLocked();
      }
      ports.events.changed();
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" } };
    }
    if (request.kind === "window-p2p.executor.spike.transfer") {
      executorLeaseIsCurrent(request.leaseId, actualClientId, request.expectedSessionEpoch);
      if (!(request.bytes instanceof ArrayBuffer)) return executorIdentityError(request.requestId, "Window P2P executor transfer requires an ArrayBuffer", "validation-error");
      if (request.bytes.byteLength > WINDOW_P2P_EXECUTOR_TRANSFER_MAX_ITEM_BYTES) return executorIdentityError(request.requestId, "Window P2P executor transfer item exceeds the byte limit", "validation-error");
      if (windowP2pExecutorTransferPendingItems === 0) windowP2pExecutorTransferPeakBytes = 0;
      if (windowP2pExecutorTransferPendingItems + 1 > WINDOW_P2P_EXECUTOR_TRANSFER_MAX_ITEMS) return executorIdentityError(request.requestId, "Window P2P executor transfer queue reached the item limit", "validation-error");
      if (windowP2pExecutorTransferPendingBytes + request.bytes.byteLength > WINDOW_P2P_EXECUTOR_TRANSFER_MAX_BYTES) return executorIdentityError(request.requestId, "Window P2P executor transfer queue reached the byte limit", "validation-error");
      windowP2pExecutorTransferPendingItems += 1;
      windowP2pExecutorTransferPendingBytes += request.bytes.byteLength;
      windowP2pExecutorTransferPeakBytes = Math.max(windowP2pExecutorTransferPeakBytes, windowP2pExecutorTransferPendingBytes);
      const acceptedPendingBytes = windowP2pExecutorTransferPendingBytes;
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, WINDOW_P2P_EXECUTOR_PRE_SIGN_YIELD_MS));
        executorLeaseIsCurrent(request.leaseId, actualClientId, request.expectedSessionEpoch);
        return {
          requestId: request.requestId,
          sessionEpoch: ports.session().sessionEpoch,
          ack: { status: "ok" },
          operationResult: { bytes: request.bytes, acceptedPendingBytes, peakPendingBytes: windowP2pExecutorTransferPeakBytes }
        };
      } finally {
        windowP2pExecutorTransferPendingItems = Math.max(0, windowP2pExecutorTransferPendingItems - 1);
        windowP2pExecutorTransferPendingBytes = Math.max(0, windowP2pExecutorTransferPendingBytes - request.bytes.byteLength);
      }
    }
    const controller = new AbortController();
    const key = windowP2pExecutorIdentityRequestKey(actualClientId, request.requestId);
    windowP2pExecutorIdentityRequests.set(key, { controller, clientId: actualClientId, leaseId: request.leaseId });
    try {
      return await enqueueWindowP2pExecutorIdentitySign(request, actualClientId, controller.signal);
    } catch (error) {
      return executorIdentityError(request.requestId, error instanceof Error ? error.message : String(error));
    } finally {
      windowP2pExecutorIdentityRequests.delete(key);
    }
  }
  function cancelIdentityClient(peerId: string) {
    for (const [key, pending] of windowP2pExecutorIdentityRequests) {
      if (pending.clientId === peerId) { pending.controller.abort(); windowP2pExecutorIdentityRequests.delete(key); }
    }
  }
  function cancelIdentityRequest(peerId: string, requestId: string) {
    const pending = windowP2pExecutorIdentityRequests.get(windowP2pExecutorIdentityRequestKey(peerId, requestId));
    if (pending?.clientId === peerId) pending.controller.abort();
  }
  const route = defineWorkerRequestRoute<WindowP2pExecutorRequest>({
    kinds: ["window-p2p.executor.acquire", "window-p2p.executor.release", "window-p2p.executor.spike.transfer", "window-p2p.executor.identity.sign-noise", "window-p2p.executor.identity.sign-peer-record"],
    policy: request => ({ scheduling: "parallel", validateEpoch: false, cleanupOnly: request.kind === "window-p2p.executor.release" }),
    execute: (request, call) => executeWindowP2pExecutorRequest(request, call.peerId),
  });
  return {
    route,
    cancelIdentityClient, cancelIdentityRequest,
    windowP2pExecutorIdentityRequests, windowP2pExecutorIdentityRequestKey,
    get windowP2pExecutorLease() { return windowP2pExecutorLease; }, set windowP2pExecutorLease(value: typeof windowP2pExecutorLease) { windowP2pExecutorLease = value; },
    activeSatInboundHandlers,
    get testSatInboundResponseDispatcher() { return testSatInboundResponseDispatcher; }, set testSatInboundResponseDispatcher(value: typeof testSatInboundResponseDispatcher) { testSatInboundResponseDispatcher = value; },
    get windowP2pExecutorIdentityTail() { return windowP2pExecutorIdentityTail; }, set windowP2pExecutorIdentityTail(value: typeof windowP2pExecutorIdentityTail) { windowP2pExecutorIdentityTail = value; },
    rejectWindowP2pExecutorBridgePending,
    windowP2pBridgeBudget,
    reserveWindowP2pExecutorBridgeBytes,
    releaseWindowP2pExecutorBridgeBytes,
    reserveWindowP2pExecutorInboundEvent,
    releaseWindowP2pExecutorInboundEvent,
    cancelSatInboundHandler,
    cancelSatInboundHandlers,
    cancelSatInboundHandlersForConnection,
    beginSatInboundHandler,
    windowP2pError,
    get windowP2pExecutorConfigSync() { return windowP2pExecutorConfigSync; }, set windowP2pExecutorConfigSync(value: typeof windowP2pExecutorConfigSync) { windowP2pExecutorConfigSync = value; },
    syncWindowP2pExecutorConfig,
    requestWindowP2pExecutorOperation,
    windowP2pExecutorBridgeBytesForOperation,
    satWindowLaneOperation,
    handleSatWindowEvent,
    clearWindowP2pExecutorLeaseLocked,
    executeWindowP2pExecutorRequest,
  };
}
