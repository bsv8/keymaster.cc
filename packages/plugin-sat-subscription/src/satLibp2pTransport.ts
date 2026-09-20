// SatSubscription 的内部 libp2p 传输适配器。
//
// SSP 核心只负责 deterministic Wire；本模块负责 /ssp/1.0.0 的 Noise 已认证
// Connection、长驻双向 Stream、单 writer 和 SDK uvarint framing。它只接收
// plugin-window-p2p 已创建的唯一 Host，不创建第二个 Host，也不对外发布 SDK。

import type { Connection, Libp2p, Stream } from "@libp2p/interface";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import { authenticateConnection } from "bitcoin-libp2p/libp2p";
import { bytesToHex, hexToBytes, peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import {
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_BUFFERED_FRAMES,
  DEFAULT_MAX_INBOUND_FRAME_BYTES,
  encodeUvarintFrame,
  readStreamToEnd,
  readUvarintFrames,
  writeUvarintFrame
} from "bitcoin-libp2p/stream";
import {
  parseActionResult,
  parseBillingResponse,
  parsePublish,
  parseSubscriptionsResponse
} from "sat-subscription-protocol/client";
import { parseRequestEnvelope } from "sat-subscription-protocol/wire";
import { MAX_WIRE_BYTES } from "sat-subscription-protocol/protocol";

/** SSP V1 固定 libp2p 协议名。 */
export const SSP_PROTOCOL = "/ssp/1.0.0" as const;
/** SPI V1 当前是一问一答、无 SSP frame 的 Stream。 */
export const SPI_PROTOCOL = "/spi/1.0.0" as const;

export type SatTransportSentBoundary = "not-sent" | "unknown";

/** 传输错误的稳定领域；只把这些字段跨 Window/Worker 边界传播。 */
export type SatTransportErrorDomain = "sat-transport";

/** 传输错误只暴露稳定分类和是否可能已经发送，供上层决定 unknown_result。 */
export class SatTransportError extends Error {
  readonly domain = "sat-transport" as const;
  readonly code: string;
  readonly sentBoundary: SatTransportSentBoundary;

  constructor(message: string, input: { sentBoundary: SatTransportSentBoundary; code?: string; cause?: unknown }) {
    super(message);
    this.name = "SatTransportError";
    this.code = input.code ?? "ERR_SAT_TRANSPORT";
    this.sentBoundary = input.sentBoundary;
    // cause 只留在本地 Error 实例上，不会由 executor 序列化。
    if (input.cause !== undefined) Object.defineProperty(this, "cause", { value: input.cause, enumerable: false });
  }
}

/** 浏览器传输层集中资源上限；每个已认证 Supplier 连接各自执行。 */
export interface SatTransportResourceLimits {
  /** 每供应商等待响应的 SSP 请求数。 */
  maxPendingSspPerSupplier: number;
  /** 每供应商等待响应的 SPI 请求数。 */
  maxPendingSpiPerSupplier: number;
  /** 单 writer 等待写入的 Frame 数。 */
  maxWriterQueuedFrames: number;
  /** 单 writer 排队的 framing 后总字节。 */
  maxWriterQueuedBytes: number;
  /** 每供应商并发入站 Publish handler 数。 */
  maxInboundHandlersPerSupplier: number;
  /** 连接交给业务 handler 前的入站排队数。 */
  maxPendingIncomingPerLane: number;
  /** SDK framing reader 的内部未消费字节上限。 */
  maxBufferedBytes: number;
  /** SDK framing reader 的内部未消费 Frame 数上限。 */
  maxBufferedFrames: number;
}

/** 集中默认值；业务代码不得再散落同类 magic number。 */
export const DEFAULT_SAT_TRANSPORT_RESOURCE_LIMITS: Readonly<SatTransportResourceLimits> = Object.freeze({
  maxPendingSspPerSupplier: 64,
  maxPendingSpiPerSupplier: 16,
  maxWriterQueuedFrames: 128,
  maxWriterQueuedBytes: 2 * 1024 * 1024,
  maxInboundHandlersPerSupplier: 32,
  maxPendingIncomingPerLane: 64,
  maxBufferedBytes: DEFAULT_MAX_BUFFERED_BYTES,
  maxBufferedFrames: DEFAULT_MAX_BUFFERED_FRAMES
});

export interface SatLibp2pTransportOptions {
  /** 已由 Window executor 创建并持有的 bitcoin-libp2p 0.3 Host。 */
  host: Libp2p;
  /** 单个 SSP Wire 的最大长度，不得超过 SSP 协议上限和 SDK 安全上限。 */
  maxWireBytes?: number;
  /** 单个请求/Stream 的超时时间。 */
  requestTimeoutMs?: number;
  /** 浏览器传输层资源硬上限。 */
  resourceLimits?: Partial<SatTransportResourceLimits>;
  /**
   * 空闲保活间隔毫秒；默认 30_000。空闲（无任何 SSP/SPI 收发）达到该
   * 间隔时打一次标准 libp2p Ping（`/ipfs/ping/1.0.0`），产生双向流量
   * 防止 Cloudflare / nginx 杀掉空闲 WSS 长连接；不动 SSP 协议。
   * 小于等于 0 表示关闭保活。
   */
  keepaliveIntervalMs?: number;
  /** 单次 Ping 超时毫秒；默认 10_000。 */
  keepaliveTimeoutMs?: number;
}

/** 标准 libp2p Ping 协议；服务端只需启用 ping service，无需 SSP 改动。 */
export const SAT_PING_PROTOCOL = "/ipfs/ping/1.0.0";
const PING_PAYLOAD_BYTES = 32;
/** 默认空闲保活间隔：小于 Cloudflare 100s 与常见 nginx 60s 空闲超时。 */
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 10_000;
/** 连续失败几次后判定传输已死并走 degraded 重连；单次抖动不杀连接。 */
const KEEPALIVE_MAX_CONSECUTIVE_FAILURES = 2;

export interface SatLibp2pConnectInput {
  /** 供应商固定的压缩公钥 hex；不会信任远端 payload 自报身份。 */
  supplierPublicKeyHex: string;
  /** 按顺序尝试的完整 libp2p multiaddr。 */
  multiaddrs: string[];
  /** 取消本次拨号。 */
  signal?: AbortSignal;
}

export interface SatLibp2pTransport {
  connect(input: SatLibp2pConnectInput): Promise<SatLibp2pConnection>;
}

interface PendingResponse {
  resolve: (wire: Uint8Array) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 清理调用方 AbortSignal listener，避免 pending 结束后保留连接。 */
  cleanup: () => void;
  /** response 必须来自创建它的同一条 SSP stream。 */
  stream?: Stream;
}

interface QueuedIncoming {
  /** connect/start 尚未把业务 handler 挂上时收到的 Publish。 */
  wire: Uint8Array;
  /** 该 Publish 所属的 stream；重置后不得投递到新 stream。 */
  stream: Stream;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function validatePositiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} 必须是正安全整数`);
  return value;
}

function normalizeOptions(options: SatLibp2pTransportOptions): {
  host: Libp2p;
  maxWireBytes: number;
  requestTimeoutMs: number;
  resourceLimits: SatTransportResourceLimits;
  keepaliveIntervalMs: number;
  keepaliveTimeoutMs: number;
} {
  const maxWireBytes = options.maxWireBytes ?? MAX_WIRE_BYTES;
  if (!Number.isSafeInteger(maxWireBytes) || maxWireBytes < 1 || maxWireBytes > MAX_WIRE_BYTES || maxWireBytes > DEFAULT_MAX_INBOUND_FRAME_BYTES) {
    throw new RangeError(`maxWireBytes 必须是 1..${Math.min(MAX_WIRE_BYTES, DEFAULT_MAX_INBOUND_FRAME_BYTES)} 的安全整数`);
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new RangeError("requestTimeoutMs 必须是正数");
  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  if (!Number.isFinite(keepaliveIntervalMs)) throw new RangeError("keepaliveIntervalMs 必须是有限数（<=0 关闭保活）");
  const keepaliveTimeoutMs = options.keepaliveTimeoutMs ?? DEFAULT_KEEPALIVE_TIMEOUT_MS;
  if (!Number.isFinite(keepaliveTimeoutMs) || keepaliveTimeoutMs <= 0) throw new RangeError("keepaliveTimeoutMs 必须是正数");
  const resourceLimits = {
    ...DEFAULT_SAT_TRANSPORT_RESOURCE_LIMITS,
    ...(options.resourceLimits ?? {})
  };
  for (const [name, value] of Object.entries(resourceLimits)) validatePositiveLimit(value as number, name);
  if (resourceLimits.maxWriterQueuedBytes < maxWireBytes) throw new RangeError("maxWriterQueuedBytes 不能小于 maxWireBytes");
  return { host: options.host, maxWireBytes, requestTimeoutMs, resourceLimits, keepaliveIntervalMs, keepaliveTimeoutMs };
}

function operationSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new SatTransportError("libp2p operation timed out", { sentBoundary: "unknown" })), timeoutMs);
  const onAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(parent?.reason ?? new DOMException("The operation was aborted", "AbortError"));
  };
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) onAbort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
  };
}

function transportFailure(error: unknown, sentBoundary: SatTransportSentBoundary): SatTransportError {
  // 调用方掌握实际发送边界。adapter 内部 timeout signal 可能先创建了一个
  // `unknown` 错误，但若 SPI 尚未调用 send，仍必须按 not-sent 结算。
  if (error instanceof SatTransportError && error.sentBoundary === "not-sent") return error;
  return new SatTransportError(error instanceof Error ? error.message : "libp2p transport failed", { sentBoundary, cause: error });
}

function validateWire(wire: Uint8Array, maxWireBytes: number): Uint8Array {
  if (!(wire instanceof Uint8Array) || wire.byteLength < 1 || wire.byteLength > maxWireBytes) {
    throw new SatTransportError(`SSP Wire 必须是 1..${maxWireBytes} 字节`, { sentBoundary: "not-sent" });
  }
  return new Uint8Array(wire);
}

/** 已完成 Noise 认证、并固定远端 Supplier 公钥的 SSP 连接。 */
export class SatLibp2pConnection {
  readonly supplierPublicKeyHex: string;
  readonly authenticatedPublicKeyHex: string;

  private readonly maxWireBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly limits: SatTransportResourceLimits;
  private readonly keepaliveIntervalMs: number;
  private readonly keepaliveTimeoutMs: number;
  private readonly connection: Connection;
  /** 最近一次业务收发时间；保活只在真正空闲时打 Ping，避免多余流量。 */
  private lastActivityAt = Date.now();
  private keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  private keepaliveRunning = false;
  /** 远端不支持 Ping 协议时永久关闭本连接保活（旧网关兼容，不算失败）。 */
  private keepaliveUnsupported = false;
  private keepaliveFailures = 0;
  private readonly pending = new Map<string, PendingResponse>();
  private readonly incomingHandlers = new Set<(wire: Uint8Array) => Promise<Uint8Array>>();
  /** adapter connect 返回前已经到达的 Publish；避免注册 handler 的窗口丢消息。 */
  private readonly queuedIncoming = new Array<QueuedIncoming>();
  private incomingInFlight = 0;
  /** SPI 是一请求一 Stream，不进入 SSP pending map，单独计数避免 reset 误删占用。 */
  private spiInFlight = 0;
  private writerQueuedFrames = 0;
  private writerQueuedBytes = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private sspStream: Stream | undefined;
  private openingSsp: Promise<Stream> | undefined;
  private readerPromise: Promise<void> | undefined;
  private closed = false;
  private connectionState: "online" | "degraded" | "closed" = "online";
  private readonly stateListeners = new Set<(state: "online" | "degraded" | "closed") => void>();

  constructor(input: {
    connection: Connection;
    supplierPublicKeyHex: string;
    maxWireBytes: number;
    requestTimeoutMs: number;
    resourceLimits?: Partial<SatTransportResourceLimits>;
    keepaliveIntervalMs?: number;
    keepaliveTimeoutMs?: number;
  }) {
    this.connection = input.connection;
    this.supplierPublicKeyHex = input.supplierPublicKeyHex;
    this.authenticatedPublicKeyHex = input.supplierPublicKeyHex;
    this.maxWireBytes = input.maxWireBytes;
    this.requestTimeoutMs = input.requestTimeoutMs;
    this.limits = { ...DEFAULT_SAT_TRANSPORT_RESOURCE_LIMITS, ...(input.resourceLimits ?? {}) };
    this.keepaliveIntervalMs = input.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.keepaliveTimeoutMs = input.keepaliveTimeoutMs ?? DEFAULT_KEEPALIVE_TIMEOUT_MS;
  }

  /** 预先打开 SSP 长 Stream，确保入站 Publish 在 provider 注册后可接收。 */
  async start(signal?: AbortSignal): Promise<void> {
    await this.ensureSspStream(signal);
    this.setConnectionState("online");
    this.noteActivity();
    this.scheduleKeepalive();
  }

  /** 监听 SSP 长流/连接状态；Provider 用它触发无配置变化的重连。 */
  onStateChange(handler: (state: "online" | "degraded" | "closed") => void): () => void {
    this.stateListeners.add(handler);
    return () => this.stateListeners.delete(handler);
  }

  async requestSsp(wire: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertOpen();
    if (signal?.aborted) throw new SatTransportError("SSP request was aborted", { sentBoundary: "not-sent", cause: signal.reason });
    const request = validateWire(wire, this.maxWireBytes);
    let requestId: Uint8Array;
    try {
      requestId = parseRequestEnvelope(request).requestId;
    } catch (error) {
      throw new SatTransportError("SSP request Wire is invalid", { sentBoundary: "not-sent", cause: error });
    }
    const requestIdHex = bytesToHex(requestId);
    if (this.pending.has(requestIdHex)) throw new SatTransportError("duplicate SSP request_id is already in flight", { sentBoundary: "not-sent" });
    if (this.pendingCount() >= this.limits.maxPendingSspPerSupplier) throw new SatTransportError("SSP pending request limit reached", { sentBoundary: "not-sent" });
    const stream = await this.ensureSspStream(signal);
    return await new Promise<Uint8Array>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestIdHex);
        if (!pending) return;
        this.pending.delete(requestIdHex);
        pending.cleanup();
        const failure = new SatTransportError("SSP response timed out", { sentBoundary: "unknown" });
        pending.reject(failure);
        this.resetSspStream(failure, stream);
      }, this.requestTimeoutMs);
      onAbort = (): void => {
        const pending = this.pending.get(requestIdHex);
        if (!pending) return;
        this.pending.delete(requestIdHex);
        pending.cleanup();
        const failure = new SatTransportError("SSP request was aborted", { sentBoundary: "unknown", cause: signal?.reason });
        pending.reject(failure);
        this.resetSspStream(failure, stream);
      };
      this.pending.set(requestIdHex, { resolve, reject, timer, cleanup, stream });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void this.sendFrame(stream, request).catch((error: unknown) => {
        const pending = this.pending.get(requestIdHex);
        if (!pending) return;
        this.pending.delete(requestIdHex);
        pending.cleanup();
        const failure = transportFailure(error, "unknown");
        pending.reject(failure);
        this.resetSspStream(failure, stream);
      });
    });
  }

  /** SPI V1 仍沿用一请求一 Stream 的无 frame 传输，和 SPI Go/TS adapter 对齐。 */
  async requestSpi(wire: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertOpen();
    const request = validateWire(wire, this.maxWireBytes);
    if (this.spiInFlight >= this.limits.maxPendingSpiPerSupplier) throw new SatTransportError("SPI pending request limit reached", { sentBoundary: "not-sent" });
    const operation = operationSignal(this.requestTimeoutMs, signal);
    this.spiInFlight += 1;
    let stream: Stream | undefined;
    let sendStarted = false;
    try {
      stream = await this.connection.newStream(SPI_PROTOCOL, { signal: operation.signal }) as Stream;
      const responsePromise = readStreamToEnd(stream, { maxBytes: this.maxWireBytes, timeoutMs: this.requestTimeoutMs, signal: operation.signal });
      await this.sendUnframed(stream, request, operation.signal, () => { sendStarted = true; });
      const response = await responsePromise;
      this.noteActivity();
      return response;
    } catch (error) {
      try { stream?.abort(error instanceof Error ? error : new Error("SPI stream failed")); } catch { /* stream 已经关闭 */ }
      throw transportFailure(error, sendStarted ? "unknown" : "not-sent");
    } finally {
      this.spiInFlight = Math.max(0, this.spiInFlight - 1);
      operation.dispose();
      try { await stream?.close(); } catch { /* best effort */ }
    }
  }

  /** 注册入站 Publish handler；所有返回 Wire 经过同一个 writer。 */
  subscribeSspRequests(handler: (wire: Uint8Array) => Promise<Uint8Array>): () => void {
    this.assertOpen();
    if (this.incomingHandlers.size >= 1) throw new SatTransportError("only one SSP request handler is allowed", { sentBoundary: "not-sent" });
    this.incomingHandlers.add(handler);
    const queued = this.queuedIncoming.splice(0);
    for (const item of queued) {
      void this.handleSspFrame(item.wire, item.stream).catch((error: unknown) => {
        if (!this.closed) this.resetSspStream(transportFailure(error, "unknown"), item.stream);
      });
    }
    return () => this.incomingHandlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepalive();
    this.setConnectionState("closed");
    const failure = new SatTransportError("SSP connection closed", { sentBoundary: "unknown" });
    for (const [requestId, pending] of this.pending) {
      pending.cleanup();
      clearTimeout(pending.timer);
      pending.reject(failure);
      this.pending.delete(requestId);
    }
    const stream = this.sspStream;
    this.sspStream = undefined;
    this.queuedIncoming.length = 0;
    try { stream?.abort(failure); } catch { /* ignore */ }
    void stream?.close().catch(() => undefined);
    void this.connection.close().catch(() => undefined);
  }

  private assertOpen(): void {
    if (this.closed) throw new SatTransportError("SSP connection is closed", { sentBoundary: "not-sent" });
  }

  private pendingCount(): number {
    return this.pending.size;
  }

  private async ensureSspStream(signal?: AbortSignal): Promise<Stream> {
    this.assertOpen();
    if (this.sspStream) return this.sspStream;
    if (this.openingSsp) return await this.openingSsp;
    this.openingSsp = (async () => {
      let stream: Stream | undefined;
      try {
        stream = await this.connection.newStream(SSP_PROTOCOL, { signal }) as Stream;
        this.sspStream = stream;
        this.readerPromise = this.readSsp(stream);
        return stream;
      } catch (error) {
        try { stream?.abort(error instanceof Error ? error : new Error("SSP stream open failed")); } catch { /* ignore */ }
        throw transportFailure(error, "not-sent");
      } finally {
        this.openingSsp = undefined;
      }
    })();
    return await this.openingSsp;
  }

  private async sendFrame(stream: Stream, payload: Uint8Array): Promise<void> {
    const frameBytes = encodeUvarintFrame(payload).byteLength;
    if (this.writerQueuedFrames >= this.limits.maxWriterQueuedFrames || this.writerQueuedBytes > this.limits.maxWriterQueuedBytes - frameBytes) throw new SatTransportError("SSP writer queue limit reached", { sentBoundary: "not-sent" });
    this.writerQueuedFrames += 1;
    this.writerQueuedBytes += frameBytes;
    const write = this.writeTail.then(async () => {
      if (this.closed || this.sspStream !== stream) throw new SatTransportError("SSP stream is not active", { sentBoundary: "not-sent" });
      // 真正的 wire 写入只能通过 bitcoin-libp2p 0.3.0 SDK。
      if (!writeUvarintFrame(stream, payload)) await this.waitDrain(stream);
      this.noteActivity();
    }).finally(() => {
      this.writerQueuedFrames = Math.max(0, this.writerQueuedFrames - 1);
      this.writerQueuedBytes = Math.max(0, this.writerQueuedBytes - frameBytes);
    });
    this.writeTail = write.then(() => undefined, () => undefined);
    await write;
  }

  private async waitDrain(stream: Stream): Promise<void> {
    if (!stream.writableNeedsDrain) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => { cleanup(); resolve(); };
      const onClose = (event: Event): void => { cleanup(); reject((event as Event & { error?: unknown }).error ?? new Error("stream closed while draining")); };
      const cleanup = (): void => {
        stream.removeEventListener("drain", onDrain);
        stream.removeEventListener("close", onClose);
      };
      stream.addEventListener("drain", onDrain, { once: true });
      stream.addEventListener("close", onClose, { once: true });
      if (!stream.writableNeedsDrain) onDrain();
    });
  }

  private async sendUnframed(stream: Stream, payload: Uint8Array, signal: AbortSignal, onSend: () => void): Promise<void> {
    const write = this.writeTail.then(async () => {
      if (this.closed) throw new SatTransportError("connection is closed", { sentBoundary: "not-sent" });
      try {
        onSend();
        if (!stream.send(payload)) await this.waitDrain(stream);
        await stream.close({ signal });
      } catch (error) {
        throw transportFailure(error, "unknown");
      }
    });
    this.writeTail = write.then(() => undefined, () => undefined);
    await write;
  }

  private async readSsp(stream: Stream): Promise<void> {
    const frames = readUvarintFrames(stream, {
      maxInboundFrameBytes: this.maxWireBytes,
      maxBufferedBytes: this.limits.maxBufferedBytes,
      maxBufferedFrames: this.limits.maxBufferedFrames
    });
    try {
      for await (const wire of frames) {
        void this.handleSspFrame(wire, stream).catch((error: unknown) => {
          if (!this.closed && this.sspStream === stream) this.resetSspStream(transportFailure(error, "unknown"), stream);
        });
      }
      if (!this.closed && this.sspStream === stream) this.resetSspStream(new SatTransportError("SSP stream closed", { sentBoundary: "unknown" }), stream);
    } catch (error) {
      if (!this.closed && this.sspStream === stream) this.resetSspStream(transportFailure(error, "unknown"), stream);
    }
  }

  private async handleSspFrame(wire: Uint8Array, stream: Stream): Promise<void> {
    try {
      const action = parseActionResult(wire);
      this.resolvePending(action.requestId, wire, stream);
      return;
    } catch { /* 继续尝试其它 SSP Kind */ }
    try {
      const subscriptions = parseSubscriptionsResponse(wire);
      this.resolvePending(subscriptions.requestId, wire, stream);
      return;
    } catch { /* 继续尝试 BillingResponse */ }
    try {
      const billing = parseBillingResponse(wire);
      this.resolvePending(billing.requestId, wire, stream);
      return;
    } catch { /* 继续尝试入站 Publish */ }
    let publishRequestId: Uint8Array;
    try {
      publishRequestId = parsePublish(wire).requestId;
    } catch (error) {
      throw new SatTransportError("SSP frame is neither a response nor Publish", { sentBoundary: "unknown", cause: error });
    }
    this.noteActivity();
    const handler = this.incomingHandlers.values().next().value as ((wire: Uint8Array) => Promise<Uint8Array>) | undefined;
    if (!handler) {
      if (this.queuedIncoming.length >= this.limits.maxPendingIncomingPerLane) throw new SatTransportError("SSP inbound Publish queue is full", { sentBoundary: "unknown" });
      this.queuedIncoming.push({ wire: wire.slice(), stream });
      return;
    }
    if (this.incomingInFlight >= this.limits.maxInboundHandlersPerSupplier) throw new SatTransportError("SSP inbound handler limit reached", { sentBoundary: "unknown" });
    this.incomingInFlight += 1;
    try {
      const response = await handler(wire.slice());
      if (!(response instanceof Uint8Array)) throw new SatTransportError("SSP request handler returned invalid response", { sentBoundary: "unknown" });
      let responseAction;
      try { responseAction = parseActionResult(response); } catch (error) { throw new SatTransportError("SSP request handler did not return ActionResult", { sentBoundary: "unknown", cause: error }); }
      if (!equalBytes(responseAction.requestId, publishRequestId)) throw new SatTransportError("SSP response request_id does not match Publish", { sentBoundary: "unknown" });
      if (this.sspStream !== stream) throw new SatTransportError("SSP stream changed before response", { sentBoundary: "unknown" });
      await this.sendFrame(stream, response);
    } finally {
      this.incomingInFlight = Math.max(0, this.incomingInFlight - 1);
    }
  }

  private resolvePending(requestId: Uint8Array, wire: Uint8Array, stream: Stream): void {
    const key = bytesToHex(requestId);
    const pending = this.pending.get(key);
    if (!pending) throw new SatTransportError("SSP response request_id is not pending", { sentBoundary: "unknown" });
    if (pending.stream !== stream) throw new SatTransportError("SSP response arrived on a stale stream", { sentBoundary: "unknown" });
    this.pending.delete(key);
    pending.cleanup();
    clearTimeout(pending.timer);
    this.noteActivity();
    pending.resolve(wire.slice());
  }

  private resetSspStream(error: SatTransportError, expectedStream?: Stream): void {
    const stream = this.sspStream;
    // 旧 reader/handler 的迟到错误不能 reset 已经建立的新 stream。
    if (expectedStream !== undefined && stream !== expectedStream) return;
    if (!this.closed) this.setConnectionState("degraded");
    this.sspStream = undefined;
    this.queuedIncoming.length = 0;
    for (const [requestId, pending] of this.pending) {
      pending.cleanup();
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
    if (stream) {
      try { stream.abort(error); } catch { /* ignore */ }
      void stream.close().catch(() => undefined);
    }
  }

  private setConnectionState(next: "online" | "degraded" | "closed"): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    for (const listener of this.stateListeners) {
      try { listener(next); } catch { /* 单个状态监听器不能打断连接清理。 */ }
    }
  }

  /** 业务收发打点；保活只在真正空闲时才发 Ping。 */
  private noteActivity(): void {
    this.lastActivityAt = Date.now();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== undefined) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  private scheduleKeepalive(): void {
    this.stopKeepalive();
    if (this.closed || this.keepaliveUnsupported || !(this.keepaliveIntervalMs > 0)) return;
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = undefined;
      void this.runKeepalive();
    }, this.keepaliveIntervalMs);
  }

  private async runKeepalive(): Promise<void> {
    if (this.closed || this.keepaliveUnsupported || this.keepaliveRunning) {
      this.scheduleKeepalive();
      return;
    }
    // 非 online（degraded 重连中）不打扰，provider 会重建连接；近期有
    // 业务流量时链路本身就是活的，跳过本次。
    if (this.connectionState !== "online" || Date.now() - this.lastActivityAt < this.keepaliveIntervalMs) {
      this.scheduleKeepalive();
      return;
    }
    this.keepaliveRunning = true;
    try {
      await this.pingOnce();
      this.keepaliveFailures = 0;
      this.noteActivity();
    } catch (error) {
      if (isUnsupportedPingProtocol(error)) {
        // 旧网关没有 Ping 服务：永久关闭本连接保活，回到原有行为。
        this.keepaliveUnsupported = true;
        this.stopKeepalive();
        return;
      }
      this.keepaliveFailures += 1;
      if (this.keepaliveFailures >= KEEPALIVE_MAX_CONSECUTIVE_FAILURES && !this.closed) {
        this.resetSspStream(transportFailure(error, "unknown"));
      }
    } finally {
      this.keepaliveRunning = false;
      this.scheduleKeepalive();
    }
  }

  /**
   * 标准 libp2p Ping：发 32 随机字节，收 32 回显并比对。
   * 发收本身就是双向流量，正好重置中间代理的空闲计时。
   */
  private async pingOnce(): Promise<void> {
    this.assertOpen();
    const operation = operationSignal(this.keepaliveTimeoutMs);
    let stream: Stream | undefined;
    try {
      stream = await this.connection.newStream(SAT_PING_PROTOCOL, { signal: operation.signal }) as Stream;
      const payload = new Uint8Array(PING_PAYLOAD_BYTES);
      crypto.getRandomValues(payload);
      if (!stream.send(payload)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = (): void => { cleanup(); resolve(); };
          const onClose = (event: Event): void => { cleanup(); reject((event as Event & { error?: unknown }).error ?? new Error("ping stream closed while draining")); };
          const cleanup = (): void => {
            stream?.removeEventListener("drain", onDrain);
            stream?.removeEventListener("close", onClose);
          };
          stream?.addEventListener("drain", onDrain, { once: true });
          stream?.addEventListener("close", onClose, { once: true });
        });
      }
      const echo = await readExactBytes(stream, PING_PAYLOAD_BYTES, operation.signal, this.keepaliveTimeoutMs);
      if (!equalBytes(echo, payload)) throw new SatTransportError("Ping echo mismatch", { sentBoundary: "unknown" });
    } finally {
      operation.dispose();
      try { await stream?.close(); } catch { /* best effort */ }
    }
  }
}

/** 远端没有 Ping 协议 handler（旧网关）：开流即被拒，不能算传输故障。 */
function isUnsupportedPingProtocol(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === "ERR_UNSUPPORTED_PROTOCOL") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported protocol|no handler|protocol not supported/i.test(message);
}

/** 从 message 事件精确读满 n 字节；Ping 回显用，不等远端关流。 */
function readExactBytes(stream: Stream, count: number, signal: AbortSignal, timeoutMs: number): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => fail("Ping read timed out"), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      stream.removeEventListener("message", onMessage);
      stream.removeEventListener("close", onClose);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const output = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(output.subarray(0, count));
    };
    const fail = (message: string, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SatTransportError(message, { sentBoundary: "unknown", cause }));
    };
    const onMessage = (event: Event): void => {
      if (settled) return;
      const data = (event as MessageEvent).data as Uint8Array | ArrayLike<number> | undefined;
      let chunk: Uint8Array;
      try {
        if (data instanceof Uint8Array) chunk = data;
        else if (data != null && Number.isSafeInteger(data.length)) chunk = Uint8Array.from(data);
        else throw new Error("unsupported ping chunk shape");
      } catch (error) {
        fail("Ping stream emitted an invalid chunk", error);
        return;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total >= count) succeed();
    };
    const onClose = (event: Event): void => {
      const error = (event as Event & { error?: unknown }).error;
      if (error != null) fail("Ping stream closed with an error", error);
      else if (total < count) fail("Ping stream closed before echo arrived");
      // 已收满时 close 属于正常结束，忽略。
    };
    const onAbort = (): void => fail("Ping was aborted", signal.reason);
    if (signal.aborted) {
      fail("Ping was aborted", signal.reason);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    stream.addEventListener("message", onMessage);
    stream.addEventListener("close", onClose);
  });
}

/** 在调用方拥有的 Host 上建立一个固定 pinned Supplier 连接。 */
export function createSatLibp2pTransport(options: SatLibp2pTransportOptions): SatLibp2pTransport {
  const normalized = normalizeOptions(options);
  if (normalized.host == null) throw new TypeError("host is required");
  return {
    connect: async (input) => {
      const expectedPublicKey = hexToBytes(input.supplierPublicKeyHex);
      const expectedPeerId = peerIdFromPublicKeyBytes(expectedPublicKey);
      if (!Array.isArray(input.multiaddrs) || input.multiaddrs.length === 0) throw new SatTransportError("Supplier multiaddrs are empty", { sentBoundary: "not-sent" });
      let lastError: unknown;
      for (const value of input.multiaddrs) {
        let address: Multiaddr;
        try { address = multiaddr(value); } catch (error) { lastError = error; continue; }
        let connection: Connection | undefined;
        try {
          connection = await normalized.host.dial(address, { signal: input.signal });
        } catch (error) {
          // 地址解析成功但纯拨号失败，可以继续尝试下一个地址。
          lastError = error;
          continue;
        }
        try {
          let authenticated;
          try {
            authenticated = authenticateConnection(connection, { publicKey: expectedPublicKey, peerId: expectedPeerId });
            if (!authenticated
              || !(authenticated.publicKey instanceof Uint8Array)
              || !equalBytes(authenticated.publicKey, expectedPublicKey)
              || !authenticated.peerId.equals(expectedPeerId)) {
              throw new Error("authenticated Supplier identity does not match the configured pin");
            }
          } catch (error) {
            // 连接已经建立；此时身份 pin/PeerId 认证失败是安全配置错误，
            // 不能把同一个供应商继续 fallback 到第二个地址。
            try { await connection.close(); } catch { /* best effort */ }
            throw new SatTransportError("Supplier identity pin authentication failed", {
              sentBoundary: "unknown",
              code: "ERR_SAT_IDENTITY_PIN",
              cause: error
            });
          }
          const result = new SatLibp2pConnection({
            connection,
            supplierPublicKeyHex: bytesToHex(authenticated.publicKey),
            maxWireBytes: normalized.maxWireBytes,
            requestTimeoutMs: normalized.requestTimeoutMs,
            resourceLimits: normalized.resourceLimits,
            keepaliveIntervalMs: normalized.keepaliveIntervalMs,
            keepaliveTimeoutMs: normalized.keepaliveTimeoutMs
          });
          await result.start(input.signal);
          return result;
        } catch (error) {
          if (error instanceof SatTransportError && error.code === "ERR_SAT_IDENTITY_PIN") throw error;
          lastError = error;
          try { await connection?.close(); } catch { /* 尝试下一个地址 */ }
        }
      }
      throw transportFailure(lastError ?? new Error("Supplier dial failed"), "not-sent");
    }
  };
}
