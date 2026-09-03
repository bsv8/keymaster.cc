// Window P2P 基础系统插件的唯一 Host、executor lease 和 TypedSigner bridge。
//
// MSFile、SatSubscription 等业务只注册 lane；本文件不保存业务状态，也不
// 暴露私钥或通用签名入口。

import { webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { createHost } from "bitcoin-libp2p/libp2p";
import type {
  SessionCoordinatorClient,
  WindowP2pExecutorError,
  WindowP2pExecutorLaneRegistry,
} from "@keymaster/contracts";
import { SAT_SUBSCRIPTION_RESOURCE_LIMITS } from "@keymaster/contracts";
import {
  validateWindowP2pExecutorConcurrencyConfig,
  type WindowP2pExecutorConcurrencyConfig,
  type WindowP2pExecutorOperation,
} from "./executorTransport.js";
import { KeymasterWindowP2pIdentitySigner } from "./identitySigner.js";

type Host = Awaited<ReturnType<typeof createHost>>;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 256);
  return String(error).slice(0, 256);
}

/** 只白名单化固定错误字段，禁止把 cause、私钥或业务明文带过 bridge。 */
function serializeExecutorError(error: unknown): WindowP2pExecutorError {
  if (error && typeof error === "object") {
    const value = error as { domain?: unknown; code?: unknown; message?: unknown; sentBoundary?: unknown };
    const domain = value.domain === "window-p2p" || value.domain === "sat-transport" || value.domain === "msfile-transport"
      ? value.domain
      : undefined;
    const sentBoundary = value.sentBoundary === "not-sent" || value.sentBoundary === "unknown" ? value.sentBoundary : undefined;
    if (domain && typeof value.code === "string" && value.code.length > 0 && typeof value.message === "string") {
      return { domain, code: value.code.slice(0, 96), message: value.message.slice(0, 256), ...(sentBoundary ? { sentBoundary } : {}) };
    }
  }
  return { domain: "window-p2p", code: "ERR_EXECUTOR_OPERATION", message: errorText(error) };
}

function executorError(code: string, message: string, sentBoundary?: "not-sent" | "unknown"): Error & WindowP2pExecutorError {
  const error = new Error(message) as Error & WindowP2pExecutorError;
  error.domain = "window-p2p";
  error.code = code;
  if (sentBoundary) error.sentBoundary = sentBoundary;
  return error;
}

interface ExecutorBridgeRequest {
  type: "request" | "cancel";
  leaseId: string;
  requestId: string;
  operation: WindowP2pExecutorOperation;
}

interface ExecutorConfigMessage {
  type: "config";
  leaseId: string;
  config: WindowP2pExecutorConcurrencyConfig;
}

interface ExecutorConfigAck {
  type: "config-ack";
  leaseId: string;
  version: number;
  ok: boolean;
  errorMessage?: string;
}

interface ExecutorBridgeResponse {
  type: "response";
  leaseId: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: WindowP2pExecutorError;
}

interface ExecutorEventReleaseMessage {
  type: "event-release";
  leaseId: string;
  eventId: string;
}

interface ExecutorEventCancelMessage {
  type: "event-cancel";
  leaseId: string;
  eventId: string;
  /** 连接实例编号；防止同一 eventId 被错误地作用到另一条连接。 */
  connectionId: string;
}

interface ExecutorEventRejectMessage {
  type: "event-reject";
  leaseId: string;
  laneId: string;
  event: unknown;
  error: WindowP2pExecutorError;
}

interface InboundEventReservation {
  /** 真实连接实例编号；取消时与 eventId 一起做精确匹配。 */
  connectionId: string;
  reservedBytes: number;
  reservedItems: number;
  /** 已经 postMessage 的事件取消时，通知 Worker 丢弃迟到事件。 */
  sent: boolean;
}

interface InboundEventWaiter {
  eventId: string;
  connectionId: string;
  reservedBytes: number;
  reservedItems: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface WindowP2pExecutorOptions {
  coordinator: SessionCoordinatorClient;
  /** 其它插件注册到唯一 Window Host 的受限 lane。 */
  laneRegistry?: WindowP2pExecutorLaneRegistry;
}

/**
 * 启动一个 Window executor。启动失败不会把错误传播到页面主树；Worker
 * 会继续保持 unavailable，下一次 session.state 或另一 tab 可以重新选举。
 */
export class WindowP2pExecutor {
  private channel: MessageChannel;
  private readonly coordinator: SessionCoordinatorClient;
  private readonly laneRegistry?: WindowP2pExecutorLaneRegistry;
  private lease?: import("@keymaster/contracts").WindowP2pExecutorLease;
  private signer?: KeymasterWindowP2pIdentitySigner;
  private host?: Host;
  private readonly pending = new Map<string, AbortController>();
  /** 已从 Window 发出的 SSP 入站 Wire；Worker 完成/拒绝后显式释放。 */
  private readonly inboundEventReservations = new Map<string, InboundEventReservation>();
  /** bridge 字节不足时暂存的入站事件预占请求；队列本身也有 item 上限。 */
  private readonly inboundEventWaiters: InboundEventWaiter[] = [];
  private inboundEventInFlightBytes = 0;
  private inboundEventInFlightItems = 0;
  private bridgeMaxInFlightBytes: number = SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes;
  private bridgeMaxPendingItems: number = SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgePendingItems;
  /** libp2p Host.stop() 的幂等保护；start/stop 竞态不能重复关闭同一 Host。 */
  private readonly stoppedHosts = new WeakSet<object>();
  private disposed = false;
  private starting?: Promise<boolean>;
  private lifecycleToken = 0;

  constructor(options: WindowP2pExecutorOptions) {
    this.coordinator = options.coordinator;
    this.laneRegistry = options.laneRegistry;
    this.channel = new MessageChannel();
    this.bindChannel();
  }

  private bindChannel(): void {
    this.channel.port1.onmessage = (event: MessageEvent<ExecutorBridgeRequest | ExecutorConfigMessage | ExecutorEventReleaseMessage | ExecutorEventCancelMessage | ExecutorEventRejectMessage | { type: "shutdown" } | { type: "revoked"; leaseId: string }>) => {
      if (event.data && event.data.type === "config") {
        void this.handleConfig(event.data);
        return;
      }
      if (event.data && event.data.type === "revoked") {
        // Worker 会先推进 epoch/session.state，再把旧 lease 的 revoked 投递到
        // MessagePort。若只 stop，前面的 unlocked 事件可能已经误判 start()
        // 成功，之后再没有事件触发重建，active-key switch 会永久 unavailable。
        // 同时按 leaseId 过滤迟到 revoke，不能误杀已经重建的新 host。
        if (this.lease?.leaseId !== event.data.leaseId) return;
        void this.stop().then(() => {
          const snapshot = this.coordinator.getBootstrapSnapshot();
          if (!this.disposed && snapshot.vaultStatus === "unlocked" && snapshot.activePublicKeyHex) {
            void this.start();
          }
        });
        return;
      }
      if (event.data && event.data.type === "event-release") {
        if (this.lease?.leaseId === event.data.leaseId) this.releaseInboundEvent(event.data.eventId, false);
        return;
      }
      if (event.data && event.data.type === "event-cancel") {
        if (this.lease?.leaseId === event.data.leaseId) this.releaseInboundEvent(event.data.eventId);
        return;
      }
      if (event.data && event.data.type === "event-reject") {
        if (this.lease?.leaseId !== event.data.leaseId) return;
        const eventId = event.data.event && typeof event.data.event === "object"
          ? (event.data.event as { eventId?: unknown }).eventId
          : undefined;
        void Promise.resolve(this.laneRegistry?.rejectEvent?.(event.data.laneId, event.data.event, event.data.error))
          .catch(() => undefined)
          .finally(() => {
            if (typeof eventId === "string") this.releaseInboundEvent(eventId, false);
          });
        return;
      }
      if (event.data && event.data.type === "request") void this.handleRequest(event.data);
      if (event.data && event.data.type === "cancel" && typeof event.data.requestId === "string") {
        this.pending.get(event.data.requestId)?.abort();
      }
    };
    this.channel.port1.start();
  }

  async start(): Promise<boolean> {
    if (this.disposed || this.lease) return Boolean(this.lease);
    if (this.starting) return this.starting;
    const run = this.startImpl();
    this.starting = run;
    try {
      return await run;
    } finally {
      if (this.starting === run) this.starting = undefined;
    }
  }

  private async startImpl(): Promise<boolean> {
    if (this.disposed || this.lease) return Boolean(this.lease);
    const lifecycleToken = this.lifecycleToken;
    // MessagePort transferred to the Worker cannot be transferred a second
    // time. Recreate the pair after lock, release, or a failed host start.
    try { this.channel.port1.close(); } catch { /* initial channel */ }
    this.channel = new MessageChannel();
    this.bindChannel();
    const snapshot = this.coordinator.getBootstrapSnapshot();
    if (snapshot.vaultStatus !== "unlocked" || !snapshot.activePublicKeyHex) return false;
    const acquired = await this.coordinator.windowP2pExecutorAcquire(snapshot.activePublicKeyHex, this.channel.port2);
    if (acquired.status !== "ok") return false;
    const leaseId = acquired.value.leaseId;
    if (this.disposed || lifecycleToken !== this.lifecycleToken) {
      await this.coordinator.windowP2pExecutorRelease(acquired.value.leaseId).catch(() => undefined);
      return false;
    }
    this.lease = acquired.value;
    try {
      this.signer = new KeymasterWindowP2pIdentitySigner({ ...acquired.value, rpc: this.coordinator });
      const host = await createHost({
        signer: this.signer,
        transports: [webRTCDirect(), webSockets()],
        listenAddrs: [],
        // Supplier 地址由受信任设置页保存并经过 public-key/PeerId/certhash
        // 校验。MSFile 的主要部署形态包含 loopback/LAN NAS，因此不能沿用
        // 浏览器 libp2p 对私网 multiaddr 的默认拒绝策略；身份安全仍由拨号后
        // authenticateConnection 的 PeerId + 压缩公钥 pin 保证。
        connectionGater: { denyDialMultiaddr: async () => false },
        start: true,
      });
      if (this.disposed || lifecycleToken !== this.lifecycleToken) {
        await this.discardStaleStart(host, this.signer, leaseId);
        return false;
      }
      this.host = host;
      await this.laneRegistry?.attach({
        host,
        ownerSessionEpoch: this.lease.sessionEpoch,
        emit: (event, transfer) => this.emitLaneEvent(event, transfer),
        releaseEvent: (eventId) => this.releaseInboundEvent(eventId)
      });
      // stop() 可能在 lane.attach() 等待期间撤销了 lease；attach 完成后再
      // 检查一次，避免旧 host/lane 在锁定或接管后发送 ready 或继续持有连接。
      if (this.disposed || lifecycleToken !== this.lifecycleToken || this.lease?.leaseId !== leaseId || this.host !== host) {
        await this.laneRegistry?.detach().catch(() => undefined);
        await this.discardStaleStart(host, this.signer, leaseId, true);
        return false;
      }
      this.channel.port1.postMessage({ type: "ready", leaseId: this.lease.leaseId, ok: true });
      return true;
    } catch (error) {
      const leaseId = this.lease?.leaseId;
      if (leaseId) this.channel.port1.postMessage({ type: "ready", leaseId, ok: false, errorMessage: errorText(error) });
      await this.stop();
      return false;
    }
  }

  private async discardStaleStart(host: Host, signer: KeymasterWindowP2pIdentitySigner | undefined, leaseId: string, hostWasAssigned = false): Promise<void> {
    // 若 stop() 已经撤销并停止了已挂载 host，则 this.host 已被清空；只有
    // 仍指向当前 host 时才再次停止，避免并发 lock 产生重复 teardown。
    if (!hostWasAssigned || this.host === host) await this.stopHostOnce(host);
    if (this.host === host) this.host = undefined;
    if (this.signer === signer) {
      signer?.close();
      this.signer = undefined;
    }
    if (this.lease?.leaseId === leaseId) {
      this.lease = undefined;
      await this.coordinator.windowP2pExecutorRelease(leaseId).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.lifecycleToken += 1;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
    this.rejectInboundEventBudget(new Error("Window P2P executor stopped"));
    await this.laneRegistry?.detach().catch(() => undefined);
    const host = this.host;
    this.host = undefined;
    if (host) await this.stopHostOnce(host);
    this.signer?.close();
    this.signer = undefined;
    const lease = this.lease;
    this.lease = undefined;
    if (lease) await this.coordinator.windowP2pExecutorRelease(lease.leaseId).catch(() => undefined);
  }

  private async stopHostOnce(host: Host): Promise<void> {
    const key = host as unknown as object;
    if (this.stoppedHosts.has(key)) return;
    this.stoppedHosts.add(key);
    await Promise.resolve(host.stop()).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop();
    this.channel.port1.close();
    this.channel.port2.close();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 对齐 Worker session 真值；active key/epoch 改变时不能复用旧 lease。 */
  async reconcileSession(snapshot = this.coordinator.getBootstrapSnapshot()): Promise<boolean> {
    if (snapshot.vaultStatus !== "unlocked" || !snapshot.activePublicKeyHex) {
      await this.stop();
      return false;
    }
    if (this.lease && (
      this.lease.sessionEpoch !== snapshot.sessionEpoch
      || this.lease.activePublicKeyHex !== snapshot.activePublicKeyHex
    )) {
      await this.stop();
    }
    return this.start();
  }

  private async handleRequest(request: ExecutorBridgeRequest): Promise<void> {
    const lease = this.lease;
    if (!lease || request.leaseId !== lease.leaseId) return;
    const controller = new AbortController();
    this.pending.set(request.requestId, controller);
    try {
      const operation = request.operation;
      if (operation.type !== "lane" || !this.laneRegistry) throw new Error("Window P2P lane registry is unavailable");
      const result = await this.laneRegistry.dispatch(operation.laneId, operation.operation, controller.signal);
      // Sat lane 的 requestSsp/requestSpi 返回裸 Uint8Array；必须先复制成
      // 精确长度的 buffer 再 transfer，不能让 structured clone 复制大底层
      // ArrayBuffer，也不能把调用方的窄视图连同无关尾部带过 bridge。
      if (result instanceof Uint8Array) {
        const content = result.slice();
        this.postResponse(request, content, content.buffer);
      } else if (result && typeof result === "object" && (result as { type?: unknown }).type === "ok" && (result as { content?: unknown }).content instanceof Uint8Array) {
        const content = (result as { content: Uint8Array }).content.slice();
        this.postResponse(request, { ...(result as object), content }, content.buffer);
      } else {
        this.postResponse(request, result);
      }
    } catch (error) {
      this.postResponse(request, undefined, undefined, serializeExecutorError(error));
    } finally {
      this.pending.delete(request.requestId);
    }
  }

  private async handleConfig(message: ExecutorConfigMessage): Promise<void> {
    const lease = this.lease;
    if (!lease || lease.leaseId !== message.leaseId) return;
    if (!this.laneRegistry) {
      this.channel.port1.postMessage({
        type: "config-ack",
        leaseId: lease.leaseId,
        version: message.config.version,
        ok: false,
        errorMessage: "Window P2P lane registry is not ready",
      } satisfies ExecutorConfigAck);
      return;
    }
    try {
      // Worker 与 Window 共用 builder 校验派生值；Window 只有在完整配置
      // 生效后才回 ACK，Worker 随后才允许发送新请求。
      const checked = validateWindowP2pExecutorConcurrencyConfig(message.config);
      this.bridgeMaxInFlightBytes = Math.min(checked.bridgeMaxInFlightBytes, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes);
      this.bridgeMaxPendingItems = Math.min(checked.bridgeMaxPendingItems, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgePendingItems);
      this.laneRegistry.configure?.(checked);
      this.channel.port1.postMessage({ type: "config-ack", leaseId: lease.leaseId, version: checked.version, ok: true } satisfies ExecutorConfigAck);
    } catch (error) {
      this.channel.port1.postMessage({ type: "config-ack", leaseId: lease.leaseId, version: message.config.version, ok: false, errorMessage: errorText(error) } satisfies ExecutorConfigAck);
    }
  }

  private inboundBridgeCanAdmit(reservedBytes: number, reservedItems: number): boolean {
    return this.inboundEventInFlightBytes + reservedBytes <= this.bridgeMaxInFlightBytes
      && this.inboundEventInFlightItems + reservedItems <= this.bridgeMaxPendingItems;
  }

  private pumpInboundEventBudget(): void {
    while (this.inboundEventWaiters.length > 0) {
      const waiter = this.inboundEventWaiters[0]!;
      if (!this.inboundBridgeCanAdmit(waiter.reservedBytes, waiter.reservedItems)) break;
      this.inboundEventWaiters.shift();
      this.inboundEventInFlightBytes += waiter.reservedBytes;
      this.inboundEventInFlightItems += waiter.reservedItems;
      this.inboundEventReservations.set(waiter.eventId, {
        connectionId: waiter.connectionId,
        reservedBytes: waiter.reservedBytes,
        reservedItems: waiter.reservedItems,
        sent: false,
      });
      waiter.resolve();
    }
  }

  private reserveInboundEvent(eventId: string, connectionId: string, reservedBytes: number): Promise<void> {
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 1 || reservedBytes > this.bridgeMaxInFlightBytes) {
      return Promise.reject(executorError("ERR_BRIDGE_BYTES_LIMIT", "Window P2P inbound event exceeds the bridge byte limit", "not-sent"));
    }
    if (this.inboundEventReservations.has(eventId) || this.inboundEventWaiters.some((item) => item.eventId === eventId)) {
      return Promise.reject(executorError("ERR_BRIDGE_PENDING_LIMIT", "Window P2P inbound eventId is already pending", "not-sent"));
    }
    if (this.inboundEventReservations.size + this.inboundEventWaiters.length >= this.bridgeMaxPendingItems) {
      return Promise.reject(executorError("ERR_BRIDGE_PENDING_LIMIT", "Window P2P inbound event item limit reached", "not-sent"));
    }
    if (this.inboundBridgeCanAdmit(reservedBytes, 1)) {
      this.inboundEventInFlightBytes += reservedBytes;
      this.inboundEventInFlightItems += 1;
      this.inboundEventReservations.set(eventId, { connectionId, reservedBytes, reservedItems: 1, sent: false });
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.inboundEventWaiters.push({ eventId, connectionId, reservedBytes, reservedItems: 1, resolve, reject });
    });
  }

  private releaseInboundEvent(eventId: string, cancelSent = true): void {
    const waiterIndex = this.inboundEventWaiters.findIndex((item) => item.eventId === eventId);
    if (waiterIndex >= 0) {
      const [waiter] = this.inboundEventWaiters.splice(waiterIndex, 1);
      waiter?.reject(executorError("ERR_INBOUND_EVENT_RELEASED", "Window P2P inbound event was released before bridge admission", "not-sent"));
      this.pumpInboundEventBudget();
      return;
    }
    const reservation = this.inboundEventReservations.get(eventId);
    if (!reservation) return;
    this.inboundEventReservations.delete(eventId);
    this.inboundEventInFlightBytes = Math.max(0, this.inboundEventInFlightBytes - reservation.reservedBytes);
    this.inboundEventInFlightItems = Math.max(0, this.inboundEventInFlightItems - reservation.reservedItems);
    if (cancelSent && reservation.sent) {
      // lane timeout/stop 可能发生在 postMessage 之后；同一 MessagePort 上的
      // cancel 保证 Worker 在尚未进入业务 handler 时丢弃这条旧事件。
      try { this.channel.port1.postMessage({ type: "event-cancel", leaseId: this.lease?.leaseId, eventId, connectionId: reservation.connectionId }); } catch { /* Worker 已不可达 */ }
    }
    this.pumpInboundEventBudget();
  }

  private rejectInboundEventBudget(error: Error): void {
    for (const [eventId, reservation] of this.inboundEventReservations) {
      if (reservation.sent) {
        try { this.channel.port1.postMessage({ type: "event-cancel", leaseId: this.lease?.leaseId, eventId, connectionId: reservation.connectionId }); } catch { /* Worker 已不可达 */ }
      }
    }
    this.inboundEventReservations.clear();
    this.inboundEventInFlightBytes = 0;
    this.inboundEventInFlightItems = 0;
    for (const waiter of this.inboundEventWaiters.splice(0)) {
      waiter.reject(error);
    }
  }

  private async emitLaneEvent(event: unknown, transfer?: Transferable[]): Promise<void> {
    const leaseId = this.lease?.leaseId;
    if (!leaseId) throw executorError("ERR_EXECUTOR_REVOKED", "Window P2P executor lease is unavailable", "not-sent");
    if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "ssp.request") {
      try {
        this.channel.port1.postMessage({ type: "event", leaseId, event }, transfer ?? []);
      } catch (error) {
        throw executorError("ERR_BRIDGE_POST", errorText(error), "not-sent");
      }
      return;
    }
    const source = event as { eventId?: unknown; wire?: unknown };
    if (typeof source.eventId !== "string" || !(source.wire instanceof Uint8Array)) {
      throw executorError("ERR_BRIDGE_PENDING_LIMIT", "Window P2P inbound event is missing eventId or Wire", "not-sent");
    }
    // lane 已经给出独立 slice；再次 slice 只作为中性 executor 的安全边界，
    // 确保 transfer 不会把调用方持有的更大底层 ArrayBuffer 一并转移。
    const wire = source.wire.slice();
    const connectionId = typeof (event as { connectionId?: unknown }).connectionId === "string"
      ? (event as { connectionId: string }).connectionId
      : "";
    await this.reserveInboundEvent(source.eventId, connectionId, wire.byteLength);
    if (this.lease?.leaseId !== leaseId || this.disposed || !this.inboundEventReservations.has(source.eventId)) {
      this.releaseInboundEvent(source.eventId, false);
      throw executorError("ERR_EXECUTOR_REVOKED", "Window P2P executor lease changed before inbound dispatch", "not-sent");
    }
    try {
      this.channel.port1.postMessage({ type: "event", leaseId, event: { ...source, ...(event as object), wire } }, [wire.buffer]);
      const reservation = this.inboundEventReservations.get(source.eventId);
      if (reservation) reservation.sent = true;
    } catch (error) {
      this.releaseInboundEvent(source.eventId, false);
      throw executorError("ERR_BRIDGE_POST", errorText(error), "not-sent");
    }
  }

  private postResponse(request: ExecutorBridgeRequest, result?: unknown, transfer?: ArrayBuffer, error?: WindowP2pExecutorError): void {
    const response: ExecutorBridgeResponse = { type: "response", leaseId: request.leaseId, requestId: request.requestId, ok: error === undefined, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) };
    try {
      this.channel.port1.postMessage(response, transfer ? [transfer] : []);
    } catch {
      // Worker 端会在超时/lease 失效时释放 pending；不把页面错误扩散到 React。
    }
  }
}

let installedExecutor: WindowP2pExecutor | undefined;
let installedUnsubscribe: (() => void) | undefined;
let installRetryTimer: ReturnType<typeof setTimeout> | undefined;

/** 页面只调用一次；多个 tab 各自竞争 Worker lease，失败者保持轻量重试。 */
export function installWindowP2pExecutor(coordinator: SessionCoordinatorClient, laneRegistry?: WindowP2pExecutorLaneRegistry): () => void {
  if (installedExecutor) return () => { void installedExecutor?.dispose(); };
  const executor = new WindowP2pExecutor({ coordinator, laneRegistry });
  installedExecutor = executor;
  const attempt = (snapshot?: import("@keymaster/contracts").CoordinatorBootstrapSnapshot): void => {
    if (executor.isDisposed) return;
    void executor.reconcileSession(snapshot).then((started) => {
      // 没有 unlocked owner 时等待下一条 session.state 即可；不要在锁定态
      // 或无 active key 时建立永不结束的页面重试计时器。只有 Worker 已经
      // 暴露出可执行 owner、但本次 lease/Host 竞争失败时才做轻量重试。
      const current = coordinator.getBootstrapSnapshot();
      if (!started && current.vaultStatus === "unlocked" && current.activePublicKeyHex && !installRetryTimer) {
        installRetryTimer = setTimeout(() => { installRetryTimer = undefined; attempt(); }, 2_000);
      }
    }).catch(() => undefined);
  };
  installedUnsubscribe = coordinator.subscribeTopic("session.state", (event: { vaultStatus?: string }) => {
    if (event.vaultStatus === "unlocked") attempt(event as import("@keymaster/contracts").CoordinatorBootstrapSnapshot);
    else if (event.vaultStatus === "locked" || event.vaultStatus === "fatal") void executor.stop();
  });
  const pagehideHandler = () => { void executor.dispose(); };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", pagehideHandler, { once: true });
  }
  attempt();
  return () => {
    if (installRetryTimer) clearTimeout(installRetryTimer);
    installRetryTimer = undefined;
    installedUnsubscribe?.();
    installedUnsubscribe = undefined;
    if (typeof window !== "undefined") window.removeEventListener("pagehide", pagehideHandler);
    installedExecutor = undefined;
    void executor.dispose();
  };
}
