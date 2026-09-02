// SatSubscription 的 Window P2P lane。
//
// 这里只有公共 P2P Host 和 SSP/SPI stream；owner 私钥、Sat DB 和业务状态都
// 在 SharedWorker。每个连接操作/事件都携带 supplier、connection、owner epoch
// 和 supplier generation 四元组，防止旧连接的迟到结果污染新连接。

import type {
  SatWindowConnectionFence,
  SatWindowLaneOperation,
  SatWindowLaneSspRequestEvent,
  WindowP2pExecutorError,
  WindowP2pExecutorLane,
  WindowP2pExecutorLaneContext
} from "@keymaster/contracts";
import { SAT_SUBSCRIPTION_RESOURCE_LIMITS } from "@keymaster/contracts";
import { createSatLibp2pTransport, type SatLibp2pConnection } from "./satLibp2pTransport.js";
import { MAX_WIRE_BYTES } from "sat-subscription-protocol/protocol";
import type { Libp2p } from "@libp2p/interface";

export const SAT_LANE_ID = "sat-subscription";
const INCOMING_RESPONSE_TIMEOUT_MS = 30_000;

interface PendingIncoming extends SatWindowConnectionFence {
  /** 该 eventId 所属的实际连接；回写时必须原路匹配。 */
  eventId: string;
  resolve: (wire: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Window executor 为该 eventId 预占的 bridge 额度释放函数。 */
  releaseEvent?: (eventId: string) => void;
}

interface ActiveConnection extends SatWindowConnectionFence {
  connection: SatLibp2pConnection;
  offIncoming: () => void;
}

function laneError(code: string, message: string): Error & WindowP2pExecutorError {
  const error = new Error(message) as Error & WindowP2pExecutorError;
  error.domain = "window-p2p";
  error.code = code;
  return error;
}

function asOperation(value: unknown): SatWindowLaneOperation {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") throw laneError("ERR_INVALID_OPERATION", "Sat Window lane operation is invalid");
  const operation = value as Partial<SatWindowLaneOperation>;
  const supplierGeneration = operation.supplierGeneration;
  if (typeof operation.supplierId !== "string" || operation.supplierId.length === 0
    || typeof operation.connectionId !== "string" || operation.connectionId.length === 0
    || typeof operation.ownerSessionEpoch !== "string" || operation.ownerSessionEpoch.length === 0
    || typeof supplierGeneration !== "number" || !Number.isSafeInteger(supplierGeneration) || supplierGeneration < 1) {
    throw laneError("ERR_INVALID_CONNECTION", "Sat operation connection fence is invalid");
  }
  return operation as SatWindowLaneOperation;
}

function asWire(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_WIRE_BYTES) throw laneError("ERR_INVALID_WIRE", `${field} must be a non-empty SSP Wire`);
  return value.slice();
}

function sameFence(left: SatWindowConnectionFence, right: SatWindowConnectionFence): boolean {
  return left.supplierId === right.supplierId
    && left.connectionId === right.connectionId
    && left.ownerSessionEpoch === right.ownerSessionEpoch
    && left.supplierGeneration === right.supplierGeneration;
}

/** 唯一 Host 上的 Sat SSP/SPI 网络 lane。 */
export class SatWindowP2pLane implements WindowP2pExecutorLane {
  readonly laneId = SAT_LANE_ID;
  private context?: WindowP2pExecutorLaneContext;
  private host?: Libp2p;
  private readonly connections = new Map<string, ActiveConnection>();
  private readonly pendingIncoming = new Map<string, PendingIncoming>();
  /** 防止旧 lease/旧拨号结果迟到覆盖新的连接。 */
  private lifecycleEpoch = 0;
  private readonly supplierConnectEpoch = new Map<string, number>();

  start(context: WindowP2pExecutorLaneContext): void {
    if (this.context === context && this.host) return;
    this.lifecycleEpoch += 1;
    this.rejectPending(laneError("ERR_CONTEXT_REPLACED", "Sat Window lane context was replaced"));
    for (const active of this.connections.values()) {
      try { active.offIncoming(); } catch { /* 已注销 */ }
      active.connection.close();
    }
    this.connections.clear();
    this.context = context;
    this.host = context.host as Libp2p;
  }

  async stop(): Promise<void> {
    this.lifecycleEpoch += 1;
    this.rejectPending(laneError("ERR_LANE_STOPPED", "Sat Window lane stopped"));
    for (const active of this.connections.values()) {
      try { active.offIncoming(); } catch { /* 已注销 */ }
      active.connection.close();
    }
    this.connections.clear();
    this.supplierConnectEpoch.clear();
    this.host = undefined;
    this.context = undefined;
  }

  async handle(rawOperation: unknown, signal: AbortSignal): Promise<unknown> {
    const operation = asOperation(rawOperation);
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    switch (operation.type) {
      case "connect": return this.connect(operation, signal);
      case "requestSsp": return this.getConnection(operation).requestSsp(asWire(operation.wire, "requestSsp.wire"), signal);
      case "requestSpi": return this.getConnection(operation).requestSpi(asWire(operation.wire, "requestSpi.wire"), signal);
      case "respondSsp": return this.respond(operation);
      case "close": this.closeSupplier(operation); return null;
      default: throw laneError("ERR_INVALID_OPERATION", "Sat Window lane operation type is unsupported");
    }
  }

  async rejectEvent(rawEvent: unknown, error: WindowP2pExecutorError): Promise<void> {
    if (!rawEvent || typeof rawEvent !== "object" || (rawEvent as { type?: unknown }).type !== "ssp.request") return;
    const event = rawEvent as Partial<SatWindowLaneSspRequestEvent>;
    if (typeof event.eventId !== "string"
      || typeof event.supplierId !== "string"
      || typeof event.connectionId !== "string"
      || typeof event.ownerSessionEpoch !== "string"
      || !Number.isSafeInteger(event.supplierGeneration)) return;
    const pending = this.pendingIncoming.get(event.eventId);
    if (!pending || !sameFence(pending, event as SatWindowConnectionFence)) return;
    const rejected = laneError(error.code || "ERR_INCOMING_REJECTED", error.message || "Sat inbound Publish was rejected");
    if (error.sentBoundary) rejected.sentBoundary = error.sentBoundary;
    this.rejectPendingEvent(pending, rejected);
  }

  private async connect(
    operation: Extract<SatWindowLaneOperation, { type: "connect" }>,
    signal: AbortSignal
  ): Promise<SatWindowConnectionFence & { authenticatedPublicKeyHex: string }> {
    const host = this.host;
    const lifecycleEpoch = this.lifecycleEpoch;
    const ownerSessionEpoch = this.context?.ownerSessionEpoch;
    if (!host || !ownerSessionEpoch) throw laneError("ERR_LANE_UNAVAILABLE", "Sat Window lane is not attached to a current owner Host");
    if (operation.ownerSessionEpoch !== ownerSessionEpoch) throw laneError("ERR_STALE_OWNER_EPOCH", "Sat connection owner session epoch is stale");
    // connect 是有意替换同 supplier 的当前连接；close 操作本身则必须带旧实例 fence。
    this.replaceSupplier(operation.supplierId);
    const supplierConnectEpoch = (this.supplierConnectEpoch.get(operation.supplierId) ?? 0) + 1;
    this.supplierConnectEpoch.set(operation.supplierId, supplierConnectEpoch);
    const transport = createSatLibp2pTransport({
      host,
      ...(operation.requestTimeoutMs ? { requestTimeoutMs: operation.requestTimeoutMs } : {})
    });
    const connection = await transport.connect({
      supplierPublicKeyHex: operation.supplierPublicKeyHex,
      multiaddrs: [...operation.multiaddrs],
      signal
    });
    const fence: SatWindowConnectionFence = {
      supplierId: operation.supplierId,
      connectionId: operation.connectionId,
      ownerSessionEpoch: operation.ownerSessionEpoch,
      supplierGeneration: operation.supplierGeneration
    };
    if (lifecycleEpoch !== this.lifecycleEpoch || this.host !== host || this.supplierConnectEpoch.get(operation.supplierId) !== supplierConnectEpoch || this.context?.ownerSessionEpoch !== ownerSessionEpoch) {
      connection.close();
      throw laneError("ERR_STALE_CONNECTION", "Sat Window lane connection became stale");
    }
    if (!fence.connectionId) {
      connection.close();
      throw laneError("ERR_INVALID_CONNECTION", "Sat connectionId is required");
    }
    const active: ActiveConnection = { ...fence, connection, offIncoming: () => undefined };
    // 必须先放入当前连接表，再让 adapter flush connect/start 阶段缓存的
    // Publish；否则 handler 同步启动时会把这条首消息误判为 stale。
    this.connections.set(operation.supplierId, active);
    try {
      active.offIncoming = connection.subscribeSspRequests((wire) => this.handleIncoming(active, wire));
    } catch (error) {
      this.connections.delete(operation.supplierId);
      connection.close();
      throw error;
    }
    return { ...fence, authenticatedPublicKeyHex: connection.authenticatedPublicKeyHex };
  }

  private async handleIncoming(active: ActiveConnection, wire: Uint8Array): Promise<Uint8Array> {
    const context = this.context;
    const current = this.connections.get(active.supplierId);
    if (!context || current !== active || context.ownerSessionEpoch !== active.ownerSessionEpoch) throw laneError("ERR_STALE_CONNECTION", "Sat inbound Publish belongs to a stale connection");
    if (this.pendingIncoming.size >= SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxPendingIncomingPerLane) throw laneError("ERR_PENDING_INCOMING_LIMIT", "Sat inbound Publish limit reached");
    const eventId = `sat-incoming-${crypto.randomUUID()}`;
    return new Promise<Uint8Array>((resolve, reject) => {
      const pending = {
        ...active,
        eventId,
        resolve,
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        releaseEvent: context.releaseEvent,
      } satisfies PendingIncoming;
      pending.timer = setTimeout(() => {
        this.rejectPendingEvent(pending, laneError("ERR_INCOMING_TIMEOUT", "Sat inbound Publish response timed out"));
      }, INCOMING_RESPONSE_TIMEOUT_MS);
      this.pendingIncoming.set(eventId, pending);
      const event: SatWindowLaneSspRequestEvent = {
        type: "ssp.request",
        supplierId: active.supplierId,
        connectionId: active.connectionId,
        ownerSessionEpoch: active.ownerSessionEpoch,
        supplierGeneration: active.supplierGeneration,
        eventId,
        wire: wire.slice()
      };
      void Promise.resolve().then(() => context.emit(event, [event.wire.buffer])).catch((error: unknown) => {
        this.rejectPendingEvent(pending, error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private respond(operation: Extract<SatWindowLaneOperation, { type: "respondSsp" }>): null {
    const pending = this.pendingIncoming.get(operation.eventId);
    if (!pending) throw laneError("ERR_INCOMING_NOT_PENDING", "Sat inbound Publish event is no longer pending");
    if (!sameFence(pending, operation)) throw laneError("ERR_STALE_CONNECTION", "Sat inbound response connection fence does not match the request");
    const responseWire = asWire(operation.wire, "respondSsp.wire");
    this.resolvePendingEvent(pending, responseWire);
    return null;
  }

  private getConnection(operation: Extract<SatWindowLaneOperation, { type: "requestSsp" | "requestSpi" }>): SatLibp2pConnection {
    const active = this.connections.get(operation.supplierId);
    if (!active || !sameFence(active, operation) || this.context?.ownerSessionEpoch !== operation.ownerSessionEpoch) throw laneError("ERR_STALE_CONNECTION", `Sat supplier connection is unavailable or stale: ${operation.supplierId}`);
    return active.connection;
  }

  private replaceSupplier(supplierId: string): void {
    this.supplierConnectEpoch.set(supplierId, (this.supplierConnectEpoch.get(supplierId) ?? 0) + 1);
    this.rejectPending(laneError("ERR_CONNECTION_REPLACED", "Sat supplier connection was replaced"), supplierId);
    const active = this.connections.get(supplierId);
    if (!active) return;
    this.connections.delete(supplierId);
    try { active.offIncoming(); } catch { /* 已注销 */ }
    active.connection.close();
  }

  private closeSupplier(operation: Extract<SatWindowLaneOperation, { type: "close" }>): void {
    const active = this.connections.get(operation.supplierId);
    // 迟到的旧 close 必须是 no-op，不能关闭新连接。
    if (!active || !sameFence(active, operation)) return;
    this.replaceSupplier(operation.supplierId);
  }

  private rejectPending(error: Error, supplierId?: string): void {
    for (const [eventId, pending] of this.pendingIncoming) {
      if (supplierId !== undefined && pending.supplierId !== supplierId) continue;
      this.rejectPendingEvent(pending, error);
    }
  }

  private resolvePendingEvent(pending: PendingIncoming, wire: Uint8Array): void {
    if (this.pendingIncoming.get(pending.eventId) !== pending) return;
    this.pendingIncoming.delete(pending.eventId);
    clearTimeout(pending.timer);
    pending.releaseEvent?.(pending.eventId);
    pending.resolve(wire);
  }

  private rejectPendingEvent(pending: PendingIncoming, error: Error): void {
    if (this.pendingIncoming.get(pending.eventId) !== pending) return;
    this.pendingIncoming.delete(pending.eventId);
    clearTimeout(pending.timer);
    pending.releaseEvent?.(pending.eventId);
    pending.reject(error);
  }
}
