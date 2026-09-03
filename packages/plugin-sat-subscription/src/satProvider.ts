// SatSubscription 的 SSP/SPI 传输实现。
//
// 本模块只负责 Supplier 连接、SSP action 和原始入站 Publish。Channel
// 的签名、加密、解密和固定 inbox 路由全部由 Coordinator runtime 负责。

import type {
  SatIncomingPublish,
  SatSubscriptionService,
  SatSubscriptionAdminService,
  SatSubscriptionSettingsSnapshot,
  SatActionResult,
  SatErrorCode,
  SatSupplierConfigV1,
  SatIncomingPublishHandler
} from "@keymaster/contracts";
import {
  SAT_SUBSCRIPTION_RESOURCE_LIMITS
} from "@keymaster/contracts";
import {
  newPublish,
  newActionResult,
  newSubscribe,
  newUnsubscribe,
  newSubscriptionsRequest,
  parseActionResult,
  parsePublish,
  parseSubscriptionsResponse,
  newRequestId
} from "sat-subscription-protocol/client";
import { parseRequestEnvelope } from "sat-subscription-protocol/wire";
import { MAX_WIRE_BYTES, validateAmount, validateRequestId } from "sat-subscription-protocol/protocol";
import {
  assertCanonicalAmount,
  assertCompressedPublicKeyHex,
  assertExactChannel,
  copyValidatedJson,
  bytesToHex,
  equalBytes,
  normalizeSupplierConfig
} from "./satValidation.js";
import type { SatSubscriptionStateStore } from "./satState.js";

/** 连接边界的错误；sentBoundary 用来禁止不安全自动重试。 */
export class SatTransportError extends Error {
  readonly domain = "sat-transport" as const;
  readonly code = "ERR_SAT_TRANSPORT" as const;
  readonly sentBoundary: "not-sent" | "unknown";
  constructor(message: string, input: { sentBoundary?: "not-sent" | "unknown" } = {}) {
    super(message);
    this.name = "SatTransportError";
    this.sentBoundary = input.sentBoundary ?? "unknown";
  }
}

/** Supplier 断线重连的退避上限；重连本身不重放未知结果的收费动作。 */
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** 订阅真值收敛的独立退避；不能复用连接重试状态。 */
const SUBSCRIPTION_RECONCILE_BASE_DELAY_MS = 500;
const SUBSCRIPTION_RECONCILE_MAX_DELAY_MS = 30_000;

/** 已认证 Supplier 连接；实现不向 provider 暴露私钥。 */
export interface SatSupplierConnection {
  /** 本地供应商编号。 */
  readonly supplierId: string;
  /** 本次真实连接实例编号；不能只用 supplierId 裁决迟到操作。 */
  readonly connectionId: string;
  /** 创建连接时绑定的 owner/Vault 会话代际。 */
  readonly ownerSessionEpoch: string;
  /** 创建连接时绑定的 Supplier 配置代际。 */
  readonly supplierGeneration: number;
  /** authenticated Connection 观察到的远端公钥，必须等于配置 pin。 */
  readonly authenticatedPublicKeyHex: string;
  /** 当前连接是否可用。 */
  readonly state: "online" | "degraded" | "closed";
  /** 连接/长 SSP stream 状态变化；用于无配置变化的自动重连。 */
  onStateChange?(handler: (state: "online" | "degraded" | "closed") => void): () => void;
  /** 在一条 SSP 长 Stream 上发送一个 Wire request。 */
  requestSsp(wire: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
  /** 在独立 SPI Stream 上发送一个 Wire request。 */
  requestSpi(wire: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
  /**
   * 订阅 SSP 长 Stream 上的入站请求，并返回同一 request_id 的响应 Wire。
   * 实现必须让所有响应经过同一个 writer，以保证 frame 不交错。
   */
  subscribeSspRequests(handler: (wire: Uint8Array) => Promise<Uint8Array>): () => void;
  /** 关闭连接和所有 Stream；幂等。 */
  close(): void;
}

/** 生产 transport 由 Window executor 提供；provider 只消费 typed boundary。 */
export interface SatSubscriptionTransport {
  connect(input: {
    supplier: SatSupplierConfigV1;
    ownerPublicKeyHex: string;
    /** 当前 owner/Vault 会话代际。 */
    ownerSessionEpoch: string;
    supplierGeneration: number;
    /**
     * 在网络连接开始前注册入站 handler；用于覆盖 connect 返回前的首条 Publish。
     * 传输实现仍必须返回带 `subscribeSspRequests` 的连接对象，作为连接生命周期
     * 的正式订阅接口。
     */
    onSspRequest?: (wire: Uint8Array) => Promise<Uint8Array>;
    signal?: AbortSignal;
  }): Promise<SatSupplierConnection>;
}

/** SPI 复用当前 provider 连接所需的最小运行时视图。 */
export interface SatSubscriptionSpiRuntime {
  /** 当前已认证 owner 公钥。 */
  readonly ownerPublicKeyHex: string;
  /** 当前 owner 的状态存储。 */
  readonly stateStore: SatSubscriptionStateStore;
  /** 当前 owner 的会话世代；key 切换/锁定后必须变化。 */
  readonly ownerGeneration?: number;
  /** 当前 Supplier catalog 世代；配置变化后必须变化。 */
  readonly supplierGeneration?: number;
  /** 通过当前已认证连接发送一个 SPI request。 */
  requestSpi(supplierId: string, wire: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
}

/** owner 状态加载器；每次 bind 只加载当前 active owner namespace。 */
export type SatStateForOwner = (ownerPublicKeyHex: string) => Promise<SatSubscriptionStateStore>;

export interface SatSubscriptionProviderConfig {
  /** 打开当前 owner 的 key-scoped 状态。 */
  stateForOwner: SatStateForOwner;
  /** Window executor/正式 SSP adapter。缺省时 provider 保持 unavailable。 */
  transport?: SatSubscriptionTransport;
  /** 当前 owner Runtime 的启动取消信号；锁屏/切换 owner 时终止正在拨号的旧世代。 */
  signal?: AbortSignal;
  /** Supplier catalog generation；配置改变时必须递增。 */
  supplierGeneration?: number;
  /** 当前 owner 会话世代；锁定、切换 key 后必须变化。 */
  ownerGeneration?: number;
  /** 当前 Coordinator session epoch；连接实例必须绑定它。 */
  ownerSessionEpoch?: string;
  /** 当前时间，测试可注入。 */
  now?: () => number;
  /** 脱敏日志。 */
  logger?: { info?: (event: string, data?: Record<string, unknown>) => void; warn?: (event: string, data?: Record<string, unknown>) => void };
}

function isWindowP2pExecutorError(error: unknown): error is {
  domain: "window-p2p";
  code: string;
  sentBoundary?: "not-sent" | "unknown";
} {
  if (!error || typeof error !== "object") return false;
  const value = error as { domain?: unknown; code?: unknown; sentBoundary?: unknown };
  return value.domain === "window-p2p"
    && typeof value.code === "string"
    && (value.sentBoundary === undefined || value.sentBoundary === "not-sent" || value.sentBoundary === "unknown");
}

/** 把 Window/adapter 的稳定错误映射成 Sat 业务错误；不读取英文 message。 */
export function satErrorCodeFromFailure(error: unknown): SatErrorCode {
  if (error instanceof SatSubscriptionError) return error.code;
  if (isSatTransportErrorLike(error) && error.code === "ERR_SAT_IDENTITY_PIN") return "identity";
  if (error instanceof SatTransportError || isSatTransportErrorLike(error)) {
    return error.sentBoundary === "not-sent" ? "connect" : "unknown_result";
  }
  if (isWindowP2pExecutorError(error)) {
    switch (error.code) {
      case "ERR_STALE_OWNER_EPOCH":
      case "ERR_STALE_CONNECTION":
      case "ERR_CONNECTION_REPLACED":
      case "ERR_CONTEXT_REPLACED":
        return "conflict";
      case "ERR_INVALID_OPERATION":
      case "ERR_INVALID_CONNECTION":
      case "ERR_INVALID_WIRE":
        return "validation";
      case "ERR_LANE_UNAVAILABLE":
      case "ERR_LANE_STOPPED":
      case "ERR_PENDING_INCOMING_LIMIT":
      case "ERR_INBOUND_HANDLER_LIMIT":
      case "ERR_BRIDGE_PENDING_LIMIT":
      case "ERR_BRIDGE_BYTES_LIMIT":
      case "ERR_EXECUTOR_UNAVAILABLE":
      case "ERR_EXECUTOR_REVOKED":
      case "ERR_BRIDGE_RESPONSE":
      case "ERR_CONFIG_SUPERSEDED":
        return "unavailable";
      case "ERR_BRIDGE_POST":
        // postMessage 在调用前抛出时可以证明没有把 Wire 交给 Window；
        // 只有这一种 bridge 失败允许上层按 connect 语义安全重试。
        return error.sentBoundary === "not-sent" ? "connect" : "unknown_result";
      default:
        // 没有 not-sent 证明时按未知结果处理，禁止把可能已付费的操作当作
        // 普通连接失败自动重发。
        return error.sentBoundary === "not-sent" ? "connect" : "unknown_result";
    }
  }
  return "protocol";
}

function stableErrorCode(error: unknown): SatErrorCode {
  return satErrorCodeFromFailure(error);
}

/**
 * Window lane 内部 transport 与 provider 可能使用不同的 Error 原型；
 * 这里按稳定 code/sentBoundary 识别，避免传输异常被误报成 protocol。
 */
function isSatTransportErrorLike(error: unknown): error is {
  code: string;
  sentBoundary: "not-sent" | "unknown";
} {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; sentBoundary?: unknown };
  return (value.code === "ERR_SAT_TRANSPORT" || value.code === "ERR_SAT_IDENTITY_PIN")
    && (value.sentBoundary === "not-sent" || value.sentBoundary === "unknown");
}

function actionErrorCode(errorCode: string): SatErrorCode {
  if (errorCode === "REJECTED") return "balance";
  if (errorCode === "INVALID_REQUEST") return "validation";
  return "protocol";
}

/** Sat provider 自己的稳定错误类型。 */
export class SatSubscriptionError extends Error {
  readonly code: SatErrorCode;
  constructor(code: SatErrorCode, message: string) {
    super(message);
    this.name = "SatSubscriptionError";
    this.code = code;
  }
}

export class SatSubscriptionHandle {
  private currentState: "connecting" | "bound" | "closed" = "connecting";
  private readonly connections = new Map<string, SatSupplierConnection>();
  private readonly connectionErrors = new Map<string, string>();
  private readonly offPublish = new Map<string, () => void>();
  /** 连接状态监听注销函数；旧连接必须先注销再 close，避免旧回调复活。 */
  private readonly offConnectionState = new Map<string, () => void>();
  /** 同一 Supplier 只允许一个拨号流程；配置代际变化时顺序等待旧拨号结束。 */
  private readonly connectingSuppliers = new Map<string, { generation: number; promise: Promise<void> }>();
  /** 每个 Supplier 独立的重连 timer/尝试次数。 */
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reconnectAttempts = new Map<string, number>();
  /** 连接已在线但订阅刷新/对账失败时的独立重试 timer/尝试次数。 */
  private readonly subscriptionReconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscriptionReconcileAttempts = new Map<string, number>();
  private readonly subscriptionReconcileInFlight = new Set<string>();
  private readonly incomingSubscribers = new Set<SatIncomingPublishHandler>();
  /** Worker 订阅建立前到达的原始 Publish，超过上限直接拒绝。 */
  private readonly pendingIncoming: SatIncomingPublish[] = [];
  private readonly ownerPublicKeyHex: string;
  private readonly stateStore: SatSubscriptionStateStore;
  /** Supplier catalog 代际；配置变更会使所有旧请求/连接失效。 */
  private generation: number;
  /** 当前 Coordinator 逻辑频道并集；不包含 owner，物理状态仍按 Supplier/频道持久化。 */
  private readonly physicalDesiredChannels = new Set<string>();
  /** 正在清理的逻辑频道；失败时保留，下一次 reconcile 继续对账。 */
  private readonly physicalUnsubscribeChannels = new Set<string>();
  /** Worker 重启前遗留的远端订阅证据；不能恢复成当前逻辑 desired。 */
  private readonly historicalCleanupChannels = new Set<string>();
  /** 当前连接代际内的远端订阅查询结果；旧 DB observed 不能直接当真值。 */
  private readonly supplierRefreshStatus = new Map<string, { generation: number; ok: boolean }>();
  /**
   * 所有会改变物理订阅真值的动作共用一条队列。
   *
   * 不能只串行 Mux：设置页的 Supplier 变更和显式 service 调用也可能
   * 与 Mux 同时进入 Provider；若各自读取同一个 observed 状态，会产生两
   * 笔 Subscribe。这里把“查远端/收费动作/落库”作为一个原子顺序。
   */
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly cfg: SatSubscriptionProviderConfig;
  private readonly setRuntimeHealth: (healthy: boolean, error: string | null) => void;

  constructor(input: {
    ownerPublicKeyHex: string;
    stateStore: SatSubscriptionStateStore;
    generation: number;
    cfg: SatSubscriptionProviderConfig;
    setRuntimeHealth: (healthy: boolean, error: string | null) => void;
  }) {
    this.ownerPublicKeyHex = input.ownerPublicKeyHex;
    this.stateStore = input.stateStore;
    this.generation = input.generation;
    this.cfg = input.cfg;
    this.now = input.cfg.now ?? Date.now;
    this.setRuntimeHealth = input.setRuntimeHealth;
    for (const record of this.stateStore.listSubscriptions()) {
      if (record.observed !== "unsubscribed") this.historicalCleanupChannels.add(record.channel);
    }
  }

  state(): "idle" | "connecting" | "bound" | "closed" {
    return this.currentState;
  }

  private assertOpen(): void {
    if (this.currentState === "closed") throw new SatSubscriptionError("connect", "SatSubscription provider handle is closed");
  }

  private assertChannel(value: unknown, allowWildcard: boolean): asserts value is string {
    try {
      assertExactChannel(value, allowWildcard);
    } catch (error) {
      throw new SatSubscriptionError("validation", error instanceof Error ? error.message : String(error));
    }
  }

  async start(): Promise<void> {
    if (this.cfg.signal?.aborted) {
      this.close();
      return;
    }
    if (!this.cfg.transport) {
      if (this.currentState === "closed") return;
      this.currentState = "bound";
      this.setRuntimeHealth(false, "SatSubscription transport is unavailable");
      return;
    }
    let observedGeneration = this.generation;
    // 配置可能在初次连接期间变更；只在当前 generation 的连接全部完成后
    // 才进入 bound，旧配置的连接结果会被 connectSupplier 丢弃。
    for (;;) {
      if (this.cfg.signal?.aborted) {
        this.close();
        return;
      }
      const suppliers = this.stateStore.listSuppliers().filter((item) => item.enabled);
      await Promise.all(suppliers.map((supplier) => this.connectSupplier(supplier, observedGeneration)));
      if (this.currentState === "closed") return;
      if (observedGeneration === this.generation) break;
      observedGeneration = this.generation;
    }
    if (this.state() === "closed" || this.cfg.signal?.aborted) return;
    this.currentState = "bound";
    if (this.connections.size > 0) this.setRuntimeHealth(true, null);
    else this.setRuntimeHealth(false, this.connectionErrors.values().next().value ?? "No SatSubscription supplier is connected");
    // Worker 重启后旧 App 的 desired 只能作为清理证据；物理期望集合为空，
    // 必须等当前 runtime 的第一个 Mux 集合到达后，才执行“当前 union + 旧证据”
    // 的一次性对账。这里不主动恢复历史 App 频道。
    for (const supplier of this.stateStore.listSuppliers().filter((item) => item.enabled)) {
      if (!this.connections.has(supplier.supplierId)) this.scheduleReconnect(supplier.supplierId, this.generation);
    }
  }

  private connectSupplier(supplier: SatSupplierConfigV1, generation = this.generation): Promise<void> {
    const existing = this.connectingSuppliers.get(supplier.supplierId);
    if (existing) {
      if (existing.generation === generation) return existing.promise;
      // 旧 generation 没有可安全复用的连接；等待其 finally 清理后再
      // 拨打新世代，避免两个连接同时向同一 Supplier 建立收费会话。
      return existing.promise.then(
        () => this.connectSupplier(supplier, generation),
        () => this.connectSupplier(supplier, generation)
      );
    }
    const run = this.connectSupplierNow(supplier, generation);
    const tracked = run.finally(() => {
      if (this.connectingSuppliers.get(supplier.supplierId)?.promise === tracked) {
        this.connectingSuppliers.delete(supplier.supplierId);
      }
    });
    this.connectingSuppliers.set(supplier.supplierId, { generation, promise: tracked });
    return tracked;
  }

  private async connectSupplierNow(supplier: SatSupplierConfigV1, generation: number): Promise<void> {
    if (!this.cfg.transport || !supplier.enabled || this.currentState === "closed" || this.cfg.signal?.aborted) return;
    let connection: SatSupplierConnection | undefined;
    let connectionForHandler: SatSupplierConnection | undefined;
    let unsubscribe: (() => void) | undefined;
    const ownerSessionEpoch = this.cfg.ownerSessionEpoch ?? this.ownerPublicKeyHex;
    const requestHandler = (wire: Uint8Array): Promise<Uint8Array> => {
      const current = this.connections.get(supplier.supplierId);
      // transport.connect 返回前，Worker 已经把这个 handler 放入 connectionId
      // 索引；此时 connectionForHandler 尚未赋值，但仍可按本轮 generation 处理。
      if (connectionForHandler === undefined) {
        if (!this.isCurrentSupplierGeneration(supplier.supplierId, generation)) return this.staleIncomingResponse(wire);
        return this.handleIncomingWire(supplier.supplierId, wire, generation);
      }
      if (current == null || current !== connectionForHandler || current.connectionId !== connectionForHandler.connectionId || current.ownerSessionEpoch !== ownerSessionEpoch || current.supplierGeneration !== generation) {
        return this.staleIncomingResponse(wire);
      }
      return this.handleIncomingWire(supplier.supplierId, wire, generation);
    };
    try {
      const activeConnection = await this.cfg.transport.connect({ supplier, ownerPublicKeyHex: this.ownerPublicKeyHex, ownerSessionEpoch, supplierGeneration: generation, onSspRequest: requestHandler, signal: this.cfg.signal });
      connectionForHandler = activeConnection;
      connection = activeConnection;
      const currentSupplier = this.stateStore.getSupplier(supplier.supplierId);
      if (
        this.state() === "closed" ||
        generation !== this.generation ||
        !currentSupplier?.enabled ||
        currentSupplier.supplierPublicKeyHex !== supplier.supplierPublicKeyHex
      ) {
        activeConnection.close();
        return;
      }
      if (activeConnection.authenticatedPublicKeyHex !== supplier.supplierPublicKeyHex) {
        activeConnection.close();
        throw new SatSubscriptionError("identity", "Authenticated Supplier public key does not match the configured pin");
      }
      if (activeConnection.supplierId !== supplier.supplierId || activeConnection.connectionId.length === 0 || activeConnection.ownerSessionEpoch !== ownerSessionEpoch || activeConnection.supplierGeneration !== generation) {
        activeConnection.close();
        throw new SatSubscriptionError("conflict", "Supplier connection fence does not match the current owner or generation");
      }
      this.connectionErrors.delete(supplier.supplierId);
      this.connections.set(supplier.supplierId, activeConnection);
      this.offPublish.get(supplier.supplierId)?.();
      unsubscribe = activeConnection.subscribeSspRequests(requestHandler);
      this.offPublish.set(supplier.supplierId, unsubscribe);
      const offState = activeConnection.onStateChange?.((state) => {
        this.handleConnectionState(supplier.supplierId, activeConnection!, state);
      });
      if (offState) {
        this.offConnectionState.get(supplier.supplierId)?.();
        this.offConnectionState.set(supplier.supplierId, offState);
      }
      // transport.connect 可能在注册监听器前已经发现 SSP 长流退化；
      // 读取当前状态补发一次生命周期事件，避免把已失效连接当成在线而
      // 永远不进入自动重连队列。
      if (activeConnection.state !== "online") {
        this.handleConnectionState(supplier.supplierId, activeConnection, activeConnection.state);
        return;
      }
      this.reconnectAttempts.delete(supplier.supplierId);
      if (generation !== this.generation || this.state() === "closed") {
        unsubscribe();
        this.offConnectionState.get(supplier.supplierId)?.();
        this.offConnectionState.delete(supplier.supplierId);
        this.offPublish.delete(supplier.supplierId);
        if (this.connections.get(supplier.supplierId) === activeConnection) this.connections.delete(supplier.supplierId);
        activeConnection.close();
        return;
      }
    } catch (error) {
      try { unsubscribe?.(); } catch { /* subscribe 失败时无须再传播 */ }
      this.offConnectionState.get(supplier.supplierId)?.();
      this.offConnectionState.delete(supplier.supplierId);
      if (connection && this.connections.get(supplier.supplierId) === connection) {
        this.connections.delete(supplier.supplierId);
      }
      try { connection?.close(); } catch { /* connection 可能已关闭 */ }
      if (generation !== this.generation || this.state() === "closed" || this.cfg.signal?.aborted) return;
      this.connectionErrors.set(supplier.supplierId, error instanceof Error ? error.message : String(error));
      this.scheduleReconnect(supplier.supplierId, generation);
    }
  }

  /** 连接/SSP 长流断开时，立即摘除旧实例并安排有界指数退避重连。 */
  private handleConnectionState(
    supplierId: string,
    connection: SatSupplierConnection,
    state: "online" | "degraded" | "closed"
  ): void {
    if (this.connections.get(supplierId) !== connection || this.currentState === "closed") return;
    if (state === "online") {
      this.connectionErrors.delete(supplierId);
      this.updateRuntimeHealth();
      return;
    }
    this.connectionErrors.set(supplierId, `Supplier connection ${state}`);
    this.stopSupplier(supplierId, false);
    this.scheduleReconnect(supplierId, this.generation);
    this.updateRuntimeHealth();
  }

  private scheduleReconnect(supplierId: string, generation: number): void {
    if (!this.cfg.transport || this.currentState === "closed" || generation !== this.generation || this.cfg.signal?.aborted) return;
    const supplier = this.stateStore.getSupplier(supplierId);
    if (!supplier?.enabled || this.connections.has(supplierId) || this.reconnectTimers.has(supplierId)) return;
    const attempt = this.reconnectAttempts.get(supplierId) ?? 0;
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** Math.min(attempt, 7)));
    this.reconnectAttempts.set(supplierId, attempt + 1);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(supplierId);
      if (this.currentState === "closed" || generation !== this.generation) return;
      const current = this.stateStore.getSupplier(supplierId);
      if (!current?.enabled || this.connections.has(supplierId)) return;
      void this.reconnectSupplier(current, generation);
    }, delay);
    this.reconnectTimers.set(supplierId, timer);
  }

  private async reconnectSupplier(supplier: SatSupplierConfigV1, generation: number): Promise<void> {
    if (this.currentState === "closed" || generation !== this.generation || !this.cfg.transport || this.cfg.signal?.aborted) return;
    await this.connectSupplier(supplier, generation);
    if (this.connections.get(supplier.supplierId)) {
      this.reconnectAttempts.delete(supplier.supplierId);
      // 重连后的第一步必须刷新远端真值，再按当前 Mux union 对账；不能
      // 依据旧 DB observed 直接补发收费 Subscribe/Unsubscribe。
      void this.reconcileAfterReconnect(supplier.supplierId, generation);
      this.updateRuntimeHealth();
      return;
    }
    this.scheduleReconnect(supplier.supplierId, generation);
  }

  /**
   * 在线连接与订阅收敛是两个独立状态机：连接成功不等于 owner inbox
   * 已经在远端生效。刷新或物理对账失败时，只重试收敛，不重复拨号；
   * 每次重试仍先查询远端列表，unknown_result 不会直接重放收费动作。
   */
  private async reconcileAfterReconnect(supplierId: string, generation: number): Promise<void> {
    if (!this.isCurrentSupplierGeneration(supplierId, generation) || this.subscriptionReconcileInFlight.has(supplierId)) return;
    this.subscriptionReconcileInFlight.add(supplierId);
    let failure: unknown;
    try {
      await this.enqueueMutation(async () => {
        if (!this.isCurrentSupplierGeneration(supplierId, generation)) return;
        await this.refreshSubscriptionsNow({ supplierId });
        await this.reconcilePhysicalSubscriptions(false);
      });
    } catch (error) {
      failure = error;
    } finally {
      this.subscriptionReconcileInFlight.delete(supplierId);
    }
    if (!failure) {
      this.subscriptionReconcileAttempts.delete(supplierId);
      this.connectionErrors.delete(supplierId);
      this.updateRuntimeHealth();
      return;
    }
    this.connectionErrors.set(supplierId, failure instanceof Error ? failure.message : String(failure));
    this.cfg.logger?.warn?.("sat.subscription.reconcile_after_reconnect_failed", {
      supplierId,
      error: failure instanceof Error ? failure.message : String(failure)
    });
    this.scheduleSubscriptionReconcile(supplierId, generation);
  }

  private scheduleSubscriptionReconcile(supplierId: string, generation: number): void {
    if (!this.cfg.transport || this.currentState === "closed" || generation !== this.generation || this.cfg.signal?.aborted) return;
    const supplier = this.stateStore.getSupplier(supplierId);
    const connection = this.connections.get(supplierId);
    if (!supplier?.enabled || !connection || connection.state !== "online") return;
    if (this.subscriptionReconcileTimers.has(supplierId) || this.subscriptionReconcileInFlight.has(supplierId)) return;
    const attempt = this.subscriptionReconcileAttempts.get(supplierId) ?? 0;
    const delay = Math.min(SUBSCRIPTION_RECONCILE_MAX_DELAY_MS, SUBSCRIPTION_RECONCILE_BASE_DELAY_MS * (2 ** Math.min(attempt, 7)));
    this.subscriptionReconcileAttempts.set(supplierId, attempt + 1);
    const timer = setTimeout(() => {
      this.subscriptionReconcileTimers.delete(supplierId);
      if (!this.isCurrentSupplierGeneration(supplierId, generation)) return;
      void this.reconcileAfterReconnect(supplierId, generation);
    }, delay);
    this.subscriptionReconcileTimers.set(supplierId, timer);
  }

  private cancelSubscriptionReconcile(supplierId: string): void {
    const timer = this.subscriptionReconcileTimers.get(supplierId);
    if (timer !== undefined) clearTimeout(timer);
    this.subscriptionReconcileTimers.delete(supplierId);
    this.subscriptionReconcileAttempts.delete(supplierId);
  }

  close(): void {
    if (this.currentState === "closed") return;
    this.generation += 1;
    this.currentState = "closed";
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    for (const timer of this.subscriptionReconcileTimers.values()) clearTimeout(timer);
    this.subscriptionReconcileTimers.clear();
    this.subscriptionReconcileAttempts.clear();
    this.subscriptionReconcileInFlight.clear();
    this.connectingSuppliers.clear();
    for (const off of this.offPublish.values()) { try { off(); } catch { /* ignore */ } }
    this.offPublish.clear();
    for (const off of this.offConnectionState.values()) { try { off(); } catch { /* ignore */ } }
    this.offConnectionState.clear();
    for (const connection of this.connections.values()) { try { connection.close(); } catch { /* ignore */ } }
    this.connections.clear();
    this.incomingSubscribers.clear();
    this.pendingIncoming.length = 0;
  }

  private connectionFor(supplierId: string): SatSupplierConnection {
    const supplier = this.stateStore.getSupplier(supplierId);
    if (!supplier || !supplier.enabled) throw new SatSubscriptionError("config", "Supplier is not enabled");
    const connection = this.connections.get(supplierId);
    if (!connection || connection.state === "closed") throw new SatSubscriptionError("connect", "Supplier connection is unavailable");
    return connection;
  }

  /** 给 SPI trusted service 使用；不暴露连接对象或底层 libp2p 能力。 */
  spiRuntime(): SatSubscriptionSpiRuntime {
    return {
      ownerPublicKeyHex: this.ownerPublicKeyHex,
      stateStore: this.stateStore,
      ownerGeneration: this.cfg.ownerGeneration,
      supplierGeneration: this.generation,
      requestSpi: (supplierId, wire, signal) => this.connectionFor(supplierId).requestSpi(wire, signal)
    };
  }

  /** 已知远端真值时返回本地确认，绝不再发一笔 SSP 收费请求。 */
  private observedActionResult(input: {
    action: "subscribe" | "unsubscribe";
    supplierId: string;
    channel: string;
  }): SatActionResult {
    return {
      ok: true,
      supplierId: input.supplierId,
      channel: input.channel,
      requestIdHex: bytesToHex(newRequestId()),
      chargedAmount: "0"
    };
  }

  private async reconcileUnknownSubscription(input: {
    action: "subscribe" | "unsubscribe";
    supplierId: string;
    channel: string;
  }): Promise<SatActionResult | undefined> {
    const target = input.action === "subscribe" ? "subscribed" : "unsubscribed";
    let record = this.stateStore.listSubscriptions(input.supplierId).find((item) => item.channel === input.channel);
    const refreshStatus = this.supplierRefreshStatus.get(input.supplierId);
    if (record?.observed === target && refreshStatus?.generation === this.generation && refreshStatus.ok) {
      return this.observedActionResult(input);
    }
    const targetInProgress = input.action === "subscribe"
      ? record?.desired === "subscribing"
      : record?.desired === "unsubscribing";
    const needsRefresh = !refreshStatus
      || refreshStatus.generation !== this.generation
      || !refreshStatus.ok
      // Worker 重启留下的 observed 只是旧远端证据，即使本轮其它频道的
      // action 成功，也不能把它当成当前连接上的完整远端列表。
      || this.historicalCleanupChannels.has(input.channel)
      || record?.observed === target
      || targetInProgress
      || record?.observed === "unknown"
      || record?.observed === "unknown_result"
      || record?.observed === "subscribing"
      || record?.observed === "unsubscribing";
    if (!record || !needsRefresh) {
      return undefined;
    }

    // unknown_result 表示请求可能已经收费；先查询远端列表，查询失败时保持
    // unknown_result，禁止把一次不确定操作盲目变成第二次收费操作。后续
    // 调用仍可再次查询远端；只有查询成功且明确缺失时才允许重新收费。
    try {
      await this.refreshSubscriptionsNow({ supplierId: input.supplierId });
    } catch (error) {
      const code = stableErrorCode(error);
      return {
        ok: false,
        supplierId: input.supplierId,
        channel: input.channel,
        requestIdHex: bytesToHex(newRequestId()),
        chargedAmount: "",
        errorCode: code === "unknown_result" ? "unknown_result" : "conflict",
        errorMessage: "远端订阅真值查询失败，已阻止重复收费请求"
      };
    }
    record = this.stateStore.listSubscriptions(input.supplierId).find((item) => item.channel === input.channel);
    if (record?.observed === target) {
      // 查询已确认远端目标状态；同时把此前的 subscribing/unsubscribing
      // 意图收敛为稳定目标，后续重试只读本地确认，不再重复收费。
      await this.stateStore.setDesiredSubscription({ supplierId: input.supplierId, channel: input.channel, state: target, errorCode: null });
      return this.observedActionResult(input);
    }
    if (record?.observed === "unknown" || record?.observed === "unknown_result" || record?.observed === "subscribing" || record?.observed === "unsubscribing") {
      return {
        ok: false,
        supplierId: input.supplierId,
        channel: input.channel,
        requestIdHex: bytesToHex(newRequestId()),
        chargedAmount: "",
        errorCode: "unknown_result",
        errorMessage: "远端订阅状态仍不确定，已阻止重复收费请求"
      };
    }
    return undefined;
  }

  private requestAction(input: {
    action: "subscribe" | "unsubscribe";
    supplierId: string;
    channel: string;
  }): Promise<SatActionResult> {
    return this.enqueueMutation(() => this.requestActionNow(input));
  }

  private async requestActionNow(input: {
    action: "subscribe" | "unsubscribe";
    supplierId: string;
    channel: string;
  }): Promise<SatActionResult> {
    this.assertOpen();
    this.assertChannel(input.channel, true);
    const observedResult = await this.reconcileUnknownSubscription(input);
    if (observedResult) return observedResult;
    const requestId = validateRequestId(newRequestId());
    let response: Uint8Array;
    let feeRecorded = false;
    let requestGeneration = this.generation;
    let requestConnection: SatSupplierConnection | undefined;
    try {
      const connection = this.connectionFor(input.supplierId);
      requestConnection = connection;
      requestGeneration = this.generation;
      await this.stateStore.setDesiredSubscription({ supplierId: input.supplierId, channel: input.channel, state: input.action === "subscribe" ? "subscribing" : "unsubscribing", errorCode: null });
      const wire = input.action === "subscribe" ? newSubscribe(requestId, input.channel) : newUnsubscribe(requestId, input.channel);
      response = await connection.requestSsp(wire);
      this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
    } catch (error) {
      const code = stableErrorCode(error);
      if (this.isCurrentSupplierGeneration(input.supplierId, requestGeneration)
        && requestConnection?.state !== "online") {
        this.stopSupplier(input.supplierId, false);
        this.scheduleReconnect(input.supplierId, requestGeneration);
      }
      const unknown = code === "unknown_result";
      if (this.isCurrentSupplierGeneration(input.supplierId, requestGeneration)) {
        try {
          await this.stateStore.setDesiredSubscription({
            supplierId: input.supplierId,
            channel: input.channel,
            // 保留用户/Coordinator 的目标方向；unknown_result 只表示
            // 结果不确定，不能把下一次启动的物理意图抹掉。
            state: input.action === "subscribe" ? "subscribing" : "unsubscribing",
            errorCode: code
          });
        } catch {
          // 配置不存在或本地状态不可写时，网络错误仍按稳定结果返回。
        }
      }
      await this.recordFee({ action: input.action, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: "", result: unknown ? "unknown_result" : "error", errorCode: code });
      feeRecorded = true;
      return { ok: false, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: "", errorCode: code, errorMessage: error instanceof Error ? error.message : String(error) };
    }
    try {
      const result = parseActionResult(response);
      if (!equalBytes(result.requestId, requestId)) throw new SatSubscriptionError("protocol", "SSP ActionResult request_id mismatch");
      validateAmount(result.chargedAmount);
      assertCanonicalAmount(result.chargedAmount);
      if (!result.success) {
        const code = actionErrorCode(result.errorCode);
        this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
        await this.stateStore.setDesiredSubscription({
          supplierId: input.supplierId,
          channel: input.channel,
          state: input.action === "subscribe" ? "subscribing" : "unsubscribing",
          errorCode: code
        });
        await this.stateStore.setObservedSubscription({ supplierId: input.supplierId, channel: input.channel, state: "unknown", source: "action", errorCode: code });
        await this.recordFee({ action: input.action, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: result.chargedAmount, result: "error", errorCode: code });
        feeRecorded = true;
        return { ok: false, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: result.chargedAmount, errorCode: code, errorMessage: result.errorCode };
      }
      const next = input.action === "subscribe" ? "subscribed" : "unsubscribed";
      this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
      await this.stateStore.setDesiredSubscription({ supplierId: input.supplierId, channel: input.channel, state: next, errorCode: null });
      this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
      await this.stateStore.setObservedSubscription({ supplierId: input.supplierId, channel: input.channel, state: next, source: "action", errorCode: null });
      this.supplierRefreshStatus.set(input.supplierId, { generation: requestGeneration, ok: true });
      await this.recordFee({ action: input.action, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: result.chargedAmount, result: "ok" });
      feeRecorded = true;
      return { ok: true, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: result.chargedAmount };
    } catch (error) {
      const code = stableErrorCode(error);
      if (this.isCurrentSupplierGeneration(input.supplierId, requestGeneration)) {
        try {
          await this.stateStore.setDesiredSubscription({
            supplierId: input.supplierId,
            channel: input.channel,
            state: input.action === "subscribe" ? "subscribing" : "unsubscribing",
            errorCode: code
          });
        } catch {
          // 配置已删除或本地状态不可写时，仍返回稳定结果。
        }
      }
      if (!feeRecorded) {
        await this.recordFee({ action: input.action, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: "", result: "error", errorCode: code });
      }
      return { ok: false, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: "", errorCode: code, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  }

  private async recordFee(input: Parameters<SatSubscriptionStateStore["recordFee"]>[0]): Promise<void> {
    try { await this.stateStore.recordFee(input); } catch (error) { this.cfg.logger?.warn?.("sat.state.fee_audit.failed", { error: error instanceof Error ? error.message : String(error) }); }
  }

  async publishRaw(input: { supplierId: string; channel: string; contentJson: Uint8Array; action: "publish" | "ack" }): Promise<{ requestIdHex: string; chargedAmount: string }> {
    this.assertOpen();
    this.assertChannel(input.channel, false);
    let contentJson: Uint8Array;
    try {
      contentJson = copyValidatedJson(input.contentJson);
    } catch (error) {
      throw new SatSubscriptionError("validation", error instanceof Error ? error.message : String(error));
    }
    if (contentJson.byteLength > MAX_WIRE_BYTES) throw new SatSubscriptionError("validation", "contentJson exceeds SSP MaxWireBytes");
    const requestId = validateRequestId(newRequestId());
    let response: Uint8Array;
    const requestGeneration = this.generation;
    let requestConnection: SatSupplierConnection | undefined;
    try {
      requestConnection = this.connectionFor(input.supplierId);
      response = await requestConnection.requestSsp(newPublish(requestId, input.channel, contentJson));
      this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
    } catch (error) {
      const code = stableErrorCode(error);
      if (this.isCurrentSupplierGeneration(input.supplierId, requestGeneration)
        && requestConnection?.state !== "online") {
        this.stopSupplier(input.supplierId, false);
        this.scheduleReconnect(input.supplierId, requestGeneration);
      }
      await this.recordFee({ action: input.action, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: "", result: code === "unknown_result" ? "unknown_result" : "error", errorCode: code });
      throw new SatSubscriptionError(code, error instanceof Error ? error.message : String(error));
    }
    try {
      const result = parseActionResult(response);
      if (!equalBytes(result.requestId, requestId)) throw new SatSubscriptionError("protocol", "SSP Publish request_id mismatch");
      validateAmount(result.chargedAmount);
      assertCanonicalAmount(result.chargedAmount);
      if (!result.success) {
        const code = actionErrorCode(result.errorCode);
        await this.recordFee({ action: input.action, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: result.chargedAmount, result: "error", errorCode: code });
        throw new SatSubscriptionError(code, `SSP Publish rejected: ${result.errorCode}`);
      }
      await this.recordFee({ action: input.action, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: result.chargedAmount, result: "ok" });
      return { requestIdHex: bytesToHex(requestId), chargedAmount: result.chargedAmount };
    } catch (error) {
      if (error instanceof SatSubscriptionError) throw error;
      throw new SatSubscriptionError("protocol", error instanceof Error ? error.message : String(error));
    }
  }

  async publish(input: { channel: string; contentJson: Uint8Array }): Promise<{ requestIdHex: string; chargedAmount: string }> {
    return this.publishRaw({ supplierId: this.defaultSupplierId(), channel: input.channel, contentJson: input.contentJson, action: "publish" });
  }

  private defaultSupplierId(): string {
    const id = this.stateStore.getOwnerSettings()?.defaultPublishSupplierId;
    if (!id) throw new SatSubscriptionError("config", "No default publish Supplier is configured");
    const supplier = this.stateStore.getSupplier(id);
    if (!supplier?.enabled) throw new SatSubscriptionError("config", "Default publish Supplier is disabled");
    return id;
  }

  subscribeIncoming(handler: SatIncomingPublishHandler): () => void {
    this.assertOpen();
    this.incomingSubscribers.add(handler);
    for (const event of this.pendingIncoming.splice(0)) {
      void Promise.resolve()
        .then(() => handler({ ...event, contentJson: event.contentJson.slice() }))
        .catch((error) => this.cfg.logger?.warn?.("sat.incoming.handler_failed", { error: error instanceof Error ? error.message : String(error) }));
    }
    return () => this.incomingSubscribers.delete(handler);
  }

  async setSubscription(input: { supplierId: string; channel: string; subscribed: boolean }): Promise<SatActionResult> {
    return this.requestAction({ action: input.subscribed ? "subscribe" : "unsubscribe", supplierId: input.supplierId, channel: input.channel });
  }

  async subscribe(input: { supplierId: string; channel: string }): Promise<SatActionResult> {
    return this.requestAction({ action: "subscribe", ...input });
  }

  async unsubscribe(input: { supplierId: string; channel: string }): Promise<SatActionResult> {
    return this.requestAction({ action: "unsubscribe", ...input });
  }

  /**
   * 按 owner 的 receiveSupplierIds × 逻辑频道并集逐个对账。
   * 每个 Supplier/频道独立落库和处理；某个 Supplier 失败不会回滚已经成功
   * 的其它 Supplier，也不会让下一次重试再次收费成功项。
   */
  private async reconcilePhysicalSubscriptions(requireReceiver = false): Promise<void> {
    const settings = this.stateStore.getOwnerSettings();
    // Disabled/removed Supplier 只保留在历史审计或已完成清理的记录里，
    // 不能再进入本轮物理 reconcile；否则停用后会对一个已关闭连接再次
    // 发起 unsubscribe，并把本来成功的配置变更错误地报告为失败。
    const receiveSupplierIds = new Set(
      (settings?.receiveSupplierIds ?? []).filter((supplierId) => Boolean(this.stateStore.getSupplier(supplierId)?.enabled))
    );
    const channels = new Set([
      ...this.physicalDesiredChannels,
      ...this.physicalUnsubscribeChannels,
      ...this.historicalCleanupChannels
    ]);
    const failures: Array<{ supplierId: string; channel: string; result: SatActionResult }> = [];

    for (const channel of channels) {
      const records = this.stateStore.listSubscriptions().filter((item) =>
        item.channel === channel && Boolean(this.stateStore.getSupplier(item.supplierId)?.enabled)
      );
      const supplierIds = new Set([
        ...receiveSupplierIds,
        ...records.map((item) => item.supplierId)
      ]);
      if (supplierIds.size === 0) {
        // 初次由 Mux 请求物理订阅时没有 receive Supplier 必须报配置错误；
        // 但 Supplier 删除/停用后，旧连接已经在上游清理完毕，不能因为
        // “没有可操作 Supplier”把删除操作报告成失败。保留
        // physicalDesiredChannels，未来新增接收 Supplier 时继续对账。
        if (requireReceiver && !this.physicalUnsubscribeChannels.has(channel)) {
          failures.push({
            supplierId: "",
            channel,
            result: {
              ok: false,
              supplierId: "",
              channel,
              requestIdHex: bytesToHex(newRequestId()),
              chargedAmount: "",
              errorCode: "config",
              errorMessage: "No receive Supplier is configured"
            }
          });
        }
        continue;
      }

      for (const supplierId of supplierIds) {
        // historicalCleanupChannels 只代表 Worker 重启前的远端证据，不能
        // 把旧 App 频道重新加入当前物理 desired。只有本次 runtime 收到的
        // Mux 集合 physicalDesiredChannels 才允许发起 Subscribe。
        const shouldSubscribe = this.physicalDesiredChannels.has(channel)
          && receiveSupplierIds.has(supplierId)
          && !this.physicalUnsubscribeChannels.has(channel);
        const result = await this.requestActionNow({
          action: shouldSubscribe ? "subscribe" : "unsubscribe",
          supplierId,
          channel
        });
        if (!result.ok) failures.push({ supplierId, channel, result });
      }

      if (this.physicalUnsubscribeChannels.has(channel) || this.historicalCleanupChannels.has(channel)) {
        const current = this.stateStore.listSubscriptions().filter((item) => item.channel === channel);
        const unresolved = current.some((item) => item.observed !== "unsubscribed");
        if (!unresolved && failures.every((item) => item.channel !== channel)) {
          if (this.physicalUnsubscribeChannels.has(channel)) {
            this.physicalUnsubscribeChannels.delete(channel);
            this.physicalDesiredChannels.delete(channel);
          }
          this.historicalCleanupChannels.delete(channel);
        }
      }
    }

    if (failures.length > 0) {
      const first = failures[0]!;
      throw new SatSubscriptionError(
        first.result.errorCode ?? "protocol",
        `Physical subscription reconcile failed for ${first.supplierId || "no-supplier"}/${first.channel}: ${first.result.errorMessage ?? "SSP action failed"}`
      );
    }
  }

  /** 禁用/删除 Supplier 前，在旧连接仍有效时清理其已观察订阅。 */
  private async clearSupplierPhysicalSubscriptions(supplierId: string): Promise<void> {
    const channels = new Set(
      this.stateStore.listSubscriptions(supplierId)
        // unknown/unknown_result/unsubscribing 也必须纳入清理：远端可能仍
        // 保留订阅，不能因为本地 desired 已经转向 unsubscribe 就把它遗留。
        .filter((item) => item.observed !== "unsubscribed")
        .map((item) => item.channel)
    );
    const failures: SatActionResult[] = [];
    for (const channel of channels) {
      const result = await this.requestActionNow({ action: "unsubscribe", supplierId, channel });
      if (!result.ok) failures.push(result);
    }
    const first = failures[0];
    if (first) throw new SatSubscriptionError(first.errorCode ?? "unknown_result", first.errorMessage ?? "Supplier subscription cleanup failed");
  }

  /**
   * Supplier catalog 代际变化会让所有旧连接的 fence 失效；必须整体重建
   * 当前 owner 的 enabled Supplier 连接，不能只重连被编辑的那一个。
   * 否则其它 Supplier 的入站 handler 仍带旧 generation，会被误判为迟到
   * 连接，造成“能发不能收”的半失效状态。
   */
  private async reconnectEnabledSuppliers(): Promise<void> {
    if (this.currentState !== "bound" || !this.cfg.transport) return;
    for (const supplierId of new Set([...this.connections.keys(), ...this.offPublish.keys()])) {
      this.stopSupplier(supplierId);
    }
    const suppliers = this.stateStore.listSuppliers().filter((item) => item.enabled);
    await Promise.all(suppliers.map((supplier) => this.connectSupplier(supplier, this.generation)));
    this.updateRuntimeHealth();
  }

  async subscribePhysical(channel: string): Promise<void> {
    this.assertChannel(channel, false);
    await this.enqueueMutation(async () => {
      this.assertOpen();
      // 第一个新 Mux 集合对该频道拥有新的逻辑生命周期；它可以复用
      // 已知的 owner/Supplier 记录，但不能继承旧 App 的订阅意图。
      this.historicalCleanupChannels.delete(channel);
      this.physicalUnsubscribeChannels.delete(channel);
      this.physicalDesiredChannels.add(channel);
      await this.reconcilePhysicalSubscriptions(true);
    });
  }

  async unsubscribePhysical(channel: string): Promise<void> {
    this.assertChannel(channel, false);
    await this.enqueueMutation(async () => {
      this.assertOpen();
      this.historicalCleanupChannels.delete(channel);
      this.physicalDesiredChannels.add(channel);
      this.physicalUnsubscribeChannels.add(channel);
      await this.reconcilePhysicalSubscriptions(false);
    });
  }

  /**
   * 锁屏前把当前 owner 的全部物理清理意图先写入 owner DB。
   * 网络动作随后可以超时/断开；下次解锁会按该证据先查询远端再继续退订。
   */
  async preparePhysicalCleanup(): Promise<void> {
    this.assertOpen();
    // 这是锁屏安全边界的一部分，不能排在可能永不返回的 SSP mutation
    // 后面。先同步建立本地清理意图，再异步持久化；网络清理失败时下次
    // 解锁仍能依据 owner-scoped DB 继续对账。
    const records = this.stateStore.listSubscriptions();
    const channels = new Set(records.map((item) => item.channel));
    for (const channel of channels) {
      this.physicalDesiredChannels.add(channel);
      this.physicalUnsubscribeChannels.add(channel);
      this.historicalCleanupChannels.delete(channel);
    }
    for (const record of records) {
      await this.stateStore.setDesiredSubscription({
        supplierId: record.supplierId,
        channel: record.channel,
        state: "unsubscribing",
        errorCode: null
      });
    }
  }

  /**
   * 查询远端订阅也必须和 Subscribe/Unsubscribe 共用同一条队列。
   *
   * 否则设置页的“刷新远端订阅”可能在 Mux 已读取旧 observed、但还没
   * 落库的窗口内并发执行，导致两条操作都认为远端缺少频道并重复收费。
   */
  async refreshSubscriptions(input: { supplierId: string }): Promise<{ channels: string[]; chargedAmount: string }> {
    this.assertOpen();
    return this.enqueueMutation(() => this.refreshSubscriptionsNow(input));
  }

  private async refreshSubscriptionsNow(input: { supplierId: string }): Promise<{ channels: string[]; chargedAmount: string }> {
    this.assertOpen();
    const requestId = validateRequestId(newRequestId());
    let response: Uint8Array;
    const requestGeneration = this.generation;
    let requestConnection: SatSupplierConnection | undefined;
    try {
      requestConnection = this.connectionFor(input.supplierId);
      response = await requestConnection.requestSsp(newSubscriptionsRequest(requestId));
      this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
    } catch (error) {
      const code = stableErrorCode(error);
      if (this.isCurrentSupplierGeneration(input.supplierId, requestGeneration)
        && requestConnection?.state !== "online") {
        this.stopSupplier(input.supplierId, false);
        this.scheduleReconnect(input.supplierId, requestGeneration);
      }
      this.supplierRefreshStatus.set(input.supplierId, { generation: requestGeneration, ok: false });
      await this.recordFee({ action: "subscriptions", supplierId: input.supplierId, channel: "", requestIdHex: bytesToHex(requestId), chargedAmount: "", result: code === "unknown_result" ? "unknown_result" : "error", errorCode: code });
      throw new SatSubscriptionError(code, error instanceof Error ? error.message : String(error));
    }
    let feeRecorded = false;
    try {
      const result = parseSubscriptionsResponse(response);
      if (!equalBytes(result.requestId, requestId)) throw new SatSubscriptionError("protocol", "SSP SubscriptionsResponse request_id mismatch");
      validateAmount(result.chargedAmount);
      assertCanonicalAmount(result.chargedAmount);
      const channels = [...result.channels];
      const knownChannels = new Set(
        this.stateStore.listSubscriptions(input.supplierId).map((item) => item.channel)
      );
      for (const channel of channels) {
        this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
        assertExactChannel(channel, true);
        knownChannels.delete(channel);
        await this.stateStore.setObservedSubscription({ supplierId: input.supplierId, channel, state: "subscribed", source: "refresh" });
      }
      for (const channel of knownChannels) {
        this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
        await this.stateStore.setObservedSubscription({ supplierId: input.supplierId, channel, state: "unsubscribed", source: "refresh" });
      }
      this.supplierRefreshStatus.set(input.supplierId, { generation: requestGeneration, ok: true });
      await this.recordFee({ action: "subscriptions", supplierId: input.supplierId, channel: "", requestIdHex: bytesToHex(requestId), chargedAmount: result.chargedAmount, result: "ok" });
      feeRecorded = true;
      return { channels, chargedAmount: result.chargedAmount };
    } catch (error) {
      const code = stableErrorCode(error);
      this.supplierRefreshStatus.set(input.supplierId, { generation: requestGeneration, ok: false });
      if (!feeRecorded) await this.recordFee({ action: "subscriptions", supplierId: input.supplierId, channel: "", requestIdHex: bytesToHex(requestId), chargedAmount: "", result: code === "unknown_result" ? "unknown_result" : "error", errorCode: code });
      if (error instanceof SatSubscriptionError) throw error;
      throw new SatSubscriptionError(code, error instanceof Error ? error.message : String(error));
    }
  }

  /** 旧连接迟到事件只返回同 request_id 的安全拒绝，不进入新连接 handler。 */
  private async staleIncomingResponse(wire: Uint8Array): Promise<Uint8Array> {
    try {
      return newActionResult({ requestId: parsePublish(wire).requestId, success: false, chargedAmount: "0", errorCode: "INVALID_REQUEST" });
    } catch {
      throw new SatSubscriptionError("protocol", "stale inbound SSP request has no valid request_id");
    }
  }

  private async handleIncomingWire(supplierId: string, wire: Uint8Array, generation: number): Promise<Uint8Array> {
    if (!this.isCurrentSupplierGeneration(supplierId, generation)) {
      throw new SatSubscriptionError("unknown_result", "Supplier configuration changed before the inbound request was handled");
    }
    let requestId: Uint8Array;
    try {
      requestId = parseRequestEnvelope(wire).requestId;
    } catch (error) {
      // 无法安全取得 request_id 时不能伪造 response；由 adapter 关闭/重置
      // 该坏 frame。拿得到 request_id 时，下面统一返回 INVALID_REQUEST。
      throw new SatSubscriptionError("protocol", error instanceof Error ? error.message : "SSP request envelope is invalid");
    }
    const event: SatIncomingPublish = {
      deliveryId: "sat-delivery-" + crypto.randomUUID(),
      ingressSupplierId: supplierId,
      channel: "",
      requestIdHex: bytesToHex(requestId),
      contentJson: new Uint8Array(),
      chargedAmount: "0",
      receivedAtMs: this.now()
    };
    try {
      const publish = parsePublish(wire);
      event.channel = publish.channel;
      event.requestIdHex = bytesToHex(publish.requestId);
      event.contentJson = publish.contentJson.slice();
      this.assertChannel(publish.channel, false);
      if (!(this.stateStore.getOwnerSettings()?.receiveSupplierIds ?? []).includes(supplierId)) {
        throw new SatSubscriptionError("config", "Ingress Supplier is not enabled for owner reception");
      }
      if (this.pendingIncoming.length >= SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxPendingIncomingPerLane && this.incomingSubscribers.size === 0) {
        throw new SatSubscriptionError("unavailable", "Sat inbound channel queue is full");
      }
      if (this.incomingSubscribers.size > 0) {
        for (const handler of this.incomingSubscribers) {
          try {
            await handler({ ...event, contentJson: event.contentJson.slice() });
          } catch (error) {
            if (isChannelInboundRejection(error)) {
              throw new SatSubscriptionError("validation", error.code);
            }
            // 单个内部消费者的普通业务异常不影响其它消费者；Coordinator
            // 会将它们记录为本地诊断，只有明确的协议拒绝会回传 SSP。
            this.cfg.logger?.warn?.("sat.incoming.handler_failed", { error: error instanceof Error ? error.message : String(error) });
          }
        }
      } else {
        this.pendingIncoming.push(event);
      }
      return newActionResult({ requestId: publish.requestId, success: true, chargedAmount: "0", errorCode: "" });
    } catch (error) {
      this.connectionErrors.set(supplierId, error instanceof Error ? error.message : String(error));
      this.cfg.logger?.warn?.("sat.incoming.rejected", { supplierId, code: stableErrorCode(error) });
      const code = error instanceof SatSubscriptionError && error.code === "balance" ? "REJECTED" : "INVALID_REQUEST";
      return newActionResult({ requestId, success: false, chargedAmount: "0", errorCode: code });
    }
  }

  async getSettingsSnapshot(): Promise<SatSubscriptionSettingsSnapshot> {
    const snapshot = this.stateStore.snapshot();
    const views = this.stateStore.supplierViews().map((view) => {
      const connection = this.connections.get(view.supplierId);
      const configured = snapshot.suppliers.find((item) => item.supplierId === view.supplierId);
      return {
        ...view,
        connectionState: !configured?.enabled
          ? "disabled" as const
          : connection?.state === "online"
            ? "online" as const
            : connection?.state === "degraded"
              ? "degraded" as const
              : this.currentState === "connecting"
                ? "connecting" as const
                : "disconnected" as const
      };
    });
    return {
      ownerPublicKeyHex: this.ownerPublicKeyHex,
      supplierGeneration: this.stateStore.supplierGeneration(),
      suppliers: snapshot.suppliers.map((item) => ({ ...item, multiaddrs: [...item.multiaddrs] })),
      ownerSettings: snapshot.ownerSettings ? { ...snapshot.ownerSettings, receiveSupplierIds: [...snapshot.ownerSettings.receiveSupplierIds] } : null,
      supplierViews: views,
      feeAudit: snapshot.feeAudit.map((item) => ({ ...item }))
    };
  }

  async upsertSupplier(config: SatSupplierConfigV1): Promise<void> {
    this.assertOpen();
    return this.enqueueMutation(async () => {
      this.assertOpen();
      const normalized = normalizeSupplierConfig(config);
      const previous = this.stateStore.getSupplier(normalized.supplierId);
      const identityChanged = previous?.enabled
        && normalized.enabled
        && previous.supplierPublicKeyHex !== normalized.supplierPublicKeyHex;
      if (previous?.enabled && (!normalized.enabled || identityChanged)) {
        // 必须在关闭旧连接前完成清理；否则切换后的 runtime 无法再以旧
        // Supplier 身份退订，且不应把这笔未知状态交给新 owner。
        await this.clearSupplierPhysicalSubscriptions(normalized.supplierId);
      }
      this.generation += 1;
      this.supplierRefreshStatus.clear();
      // generation 是当前 owner Supplier catalog 的统一 fence；即使只
      // 修改一个 Supplier，也不能让其它连接继续使用旧 fence。
      for (const supplierId of new Set([...this.connections.keys(), ...this.offPublish.keys()])) {
        this.stopSupplier(supplierId);
      }
      this.connectionErrors.delete(normalized.supplierId);
      try {
        await this.stateStore.upsertSupplier(normalized);
      } catch (error) {
        await this.reconnectEnabledSuppliers();
        this.updateRuntimeHealth();
        throw error;
      }
      if (!normalized.enabled) {
        const settings = this.stateStore.getOwnerSettings();
        if (settings?.receiveSupplierIds.includes(normalized.supplierId)) {
          await this.stateStore.setOwnerSettings({
            ...settings,
            defaultPublishSupplierId: settings.defaultPublishSupplierId === normalized.supplierId ? null : settings.defaultPublishSupplierId,
            receiveSupplierIds: settings.receiveSupplierIds.filter((id) => id !== normalized.supplierId)
          });
        }
      }
      await this.reconnectEnabledSuppliers();
      await this.reconcilePhysicalSubscriptions(false);
      this.updateRuntimeHealth();
    });
  }

  async deleteSupplier(supplierId: string): Promise<void> {
    this.assertOpen();
    return this.enqueueMutation(async () => {
      this.assertOpen();
      const previous = this.stateStore.getSupplier(supplierId);
      if (previous?.enabled) await this.clearSupplierPhysicalSubscriptions(supplierId);
      this.generation += 1;
      this.supplierRefreshStatus.clear();
      for (const currentSupplierId of new Set([...this.connections.keys(), ...this.offPublish.keys()])) {
        this.stopSupplier(currentSupplierId);
      }
      this.connectionErrors.delete(supplierId);
      try {
        await this.stateStore.deleteSupplier(supplierId);
      } catch (error) {
        await this.reconnectEnabledSuppliers();
        this.updateRuntimeHealth();
        throw error;
      }
      await this.reconnectEnabledSuppliers();
      await this.reconcilePhysicalSubscriptions(false);
      this.updateRuntimeHealth();
    });
  }

  private stopSupplier(supplierId: string, cancelReconnect = true): void {
    this.cancelSubscriptionReconcile(supplierId);
    if (cancelReconnect) {
      const timer = this.reconnectTimers.get(supplierId);
      if (timer !== undefined) clearTimeout(timer);
      this.reconnectTimers.delete(supplierId);
      this.reconnectAttempts.delete(supplierId);
    }
    this.offConnectionState.get(supplierId)?.();
    this.offConnectionState.delete(supplierId);
    this.offPublish.get(supplierId)?.();
    this.offPublish.delete(supplierId);
    this.connections.get(supplierId)?.close();
    this.connections.delete(supplierId);
  }

  private updateRuntimeHealth(): void {
    this.setRuntimeHealth(this.connections.size > 0, this.connections.size > 0 ? null : (this.connectionErrors.values().next().value ?? "No SatSubscription supplier is connected"));
  }

  private isCurrentSupplierGeneration(supplierId: string, generation: number): boolean {
    const supplier = this.stateStore.getSupplier(supplierId);
    return this.currentState !== "closed" && generation === this.generation && Boolean(supplier?.enabled);
  }

  private assertCurrentSupplierGeneration(supplierId: string, generation: number): void {
    if (!this.isCurrentSupplierGeneration(supplierId, generation)) throw new SatSubscriptionError("unknown_result", "Supplier configuration changed while the request was in flight");
  }

  async setOwnerSettings(settings: import("@keymaster/contracts").SatOwnerSupplierSettingsV1): Promise<void> {
    this.assertOpen();
    if (settings.defaultPublishSupplierId && !this.stateStore.getSupplier(settings.defaultPublishSupplierId)?.enabled) throw new SatSubscriptionError("config", "Default publish Supplier is disabled");
    for (const supplierId of settings.receiveSupplierIds) if (!this.stateStore.getSupplier(supplierId)?.enabled) throw new SatSubscriptionError("config", "Receive Supplier is disabled");
    await this.enqueueMutation(async () => {
      this.assertOpen();
      await this.stateStore.setOwnerSettings(settings);
      await this.reconcilePhysicalSubscriptions(false);
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

/** 只允许 Coordinator 标记的固定协议拒绝穿过入站边界。 */
function isChannelInboundRejection(error: unknown): error is { domain: "channel-inbound"; code: "UNSUPPORTED_PROTOCOL" } {
  if (!error || typeof error !== "object") return false;
  const value = error as { domain?: unknown; code?: unknown };
  return value.domain === "channel-inbound" && value.code === "UNSUPPORTED_PROTOCOL";
}

/** SatSubscription owner runtime 工厂。 */
export class SatSubscriptionProvider {
  private readonly cfg: SatSubscriptionProviderConfig;
  private currentHandle: SatSubscriptionHandle | null = null;
  private currentService: SatSubscriptionService | null = null;
  private currentAdmin: SatSubscriptionAdminService | null = null;
  private lastError: string | null = null;

  constructor(cfg: SatSubscriptionProviderConfig) { this.cfg = cfg; }

  async bind(input: { ownerPublicKeyHex: string }): Promise<SatSubscriptionHandle> {
    this.currentHandle?.close();
    this.currentHandle = null;
    this.currentService = null;
    this.currentAdmin = null;
    assertCompressedPublicKeyHex(input.ownerPublicKeyHex, "owner publicKeyHex");
    const stateStore = await this.cfg.stateForOwner(input.ownerPublicKeyHex);
    const handle = new SatSubscriptionHandle({
      ownerPublicKeyHex: input.ownerPublicKeyHex,
      stateStore,
      generation: this.cfg.supplierGeneration ?? stateStore.supplierGeneration(),
      cfg: this.cfg,
      setRuntimeHealth: (healthy, error) => {
        this.lastError = error;
        if (!healthy && error) this.cfg.logger?.warn?.("sat.runtime.unhealthy", { error });
      }
    });
    this.currentHandle = handle;
    await handle.start();
    this.currentService = {
      publish: (value) => handle.publish(value),
      subscribeEvents: (handler) => handle.subscribeIncoming(handler)
    };
    this.currentAdmin = {
      getSettingsSnapshot: () => handle.getSettingsSnapshot(),
      upsertSupplier: (config) => handle.upsertSupplier(config),
      deleteSupplier: (supplierId) => handle.deleteSupplier(supplierId),
      setOwnerSettings: (settings) => handle.setOwnerSettings(settings),
      refreshSubscriptions: (value) => handle.refreshSubscriptions(value)
    };
    return handle;
  }

  async shutdown(): Promise<void> {
    this.currentHandle?.close();
    this.currentHandle = null;
    this.currentService = null;
    this.currentAdmin = null;
    this.lastError = "shut down";
  }

  /** 当前 owner 的 trusted SSP service；未 bind 时返回 null。 */
  service(): SatSubscriptionService | null { return this.currentService; }

  /** 当前 owner 的 settings/admin service；未 bind 时返回 null。 */
  adminService(): SatSubscriptionAdminService | null { return this.currentAdmin; }

  /** 当前 owner 的 SPI 运行时；未 bind 时返回 null。 */
  spiRuntime(): SatSubscriptionSpiRuntime | null { return this.currentHandle?.spiRuntime() ?? null; }
}

export function createSatSubscriptionProvider(cfg: SatSubscriptionProviderConfig): SatSubscriptionProvider {
  return new SatSubscriptionProvider(cfg);
}
