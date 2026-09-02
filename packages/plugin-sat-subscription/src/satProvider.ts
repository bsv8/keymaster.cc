// SatSubscription 聚合 MessageProvider。
//
// provider 只接收 AppMsg sealed envelope，不接触 App 明文或私钥。Channel
// 的 seal/open 通过 `SatChannelCrypto` 注入；生产实现由 SharedWorker crypto
// capability 提供。Supplier 连接由 transport 注入，便于把 libp2p host 限制
// 在 Window executor，并且不在本文件复制 Noise/PeerId 实现。

import type {
  MessageProvider,
  MessageProviderHandle,
  MessageProviderOperations,
  MessageProviderHealth,
  ProviderOnlineInput,
  ProviderOnlineResult,
  ProviderDeliveryAckClaim,
  ProviderSealedMessageRecord,
  ProviderSendInput,
  ProviderSendResult,
  ProviderListInput,
  ProviderListResult,
  ProviderGetInput,
  ProviderSigner,
  SatIncomingPublish,
  SatSubscriptionService,
  SatSubscriptionAdminService,
  SatSubscriptionSettingsSnapshot,
  SatActionResult,
  SatErrorCode,
  SatSupplierConfigV1,
} from "@keymaster/contracts";
import {
  BSV8_INBOX_CHANNEL_PREFIX,
  BSV8_MESSAGE_PROTOCOL,
  SAT_SUBSCRIPTION_RESOURCE_LIMITS,
  SAT_SUBSCRIPTION_PROVIDER_ID,
  readAppMsgEnvelopeMetadata
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
import { base64urlEncode } from "bsv8-channel-protocol";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  assertCanonicalAmount,
  assertCompressedPublicKeyHex,
  assertExactChannel,
  copyValidatedJson,
  bytesToHex,
  equalBytes,
  isCompressedPublicKeyHex,
  normalizeSupplierConfig
} from "./satValidation.js";
import type { SatSubscriptionStateStore } from "./satState.js";

/** Channel seal/open 受控边界；实现不得把私钥放进 provider。 */
export interface SatChannelCrypto {
  /** 使用当前 owner 私钥创建新的 Channel Deliver。 */
  sealDeliver(input: {
    recipientPublicKeyHex: string;
    contentJson: Uint8Array;
    issuedAtMs: number;
    expiresAtMs: number;
  }): Promise<SatChannelSealResult>;
  /** 使用当前 owner 私钥创建 ACK。 */
  sealAck(input: {
    recipientPublicKeyHex: string;
    acknowledgedMessageIdBase64Url: string;
    issuedAtMs: number;
    expiresAtMs: number;
  }): Promise<SatChannelSealResult>;
  /** 在 SharedWorker 内解密、验签、检查有效期并严格分派。 */
  open(input: {
    channel: string;
    envelopeJson: Uint8Array;
    nowMs: number;
  }): Promise<SatChannelOpenResult>;
}

/** Channel seal 结果；只包含可传输的密文 envelope。 */
export interface SatChannelSealResult {
  /** 目标 inbox channel。 */
  channel: string;
  /** 32-byte 随机 message_id 的 canonical base64url。 */
  messageIdBase64Url: string;
  /** Channel 加密 envelope JSON。 */
  envelopeJson: Uint8Array;
  /** 发送方 owner 公钥。 */
  fromPublicKeyHex: string;
  /** 过期时间。 */
  expiresAtMs: number;
}

/** Channel open 结果；正文仍保持为 AppMsg sealed wrapper 字节。 */
export interface SatChannelOpenResult {
  /** 精确 ingress channel。 */
  channel: string;
  /** authenticated/Channel envelope sender 公钥。 */
  fromPublicKeyHex: string;
  /** inbox 后缀目标公钥。 */
  toPublicKeyHex: string;
  /** Channel message_id。 */
  messageIdBase64Url: string;
  /** Channel 已验签消息的逻辑摘要；重加密同一 Deliver 时保持不变。 */
  signedDigestHex: string;
  /** Channel protocol。 */
  protocol: string;
  /** deliver 或 ack；ack 不进入 AppMsg provider。 */
  bodyType: "deliver" | "ack";
  /** Deliver 的 content JSON；ACK 时省略。 */
  contentJson?: Uint8Array;
  /** ACK 关联的原始 Deliver message_id。 */
  acknowledgedMessageIdBase64Url?: string;
  /** Channel issued_at_ms。 */
  issuedAtMs: number;
  /** Channel expires_at_ms。 */
  expiresAtMs: number;
}

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
  /** SharedWorker 提供的 Channel crypto boundary。 */
  channelCrypto: SatChannelCrypto;
  /** Window executor/正式 SSP adapter。缺省时 provider 保持 unavailable。 */
  transport?: SatSubscriptionTransport;
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

function unknownOnline(input: ProviderOnlineInput): ProviderOnlineResult {
  return Object.fromEntries(input.publicKeyHexes.map((value) => [value, "unknown"]));
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

function parseBase64Url(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new SatSubscriptionError("protocol", `${field} is not base64url`);
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try { binary = atob(padded); } catch { throw new SatSubscriptionError("protocol", `${field} cannot be decoded`); }
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  if (base64urlEncode(out) !== value) throw new SatSubscriptionError("protocol", `${field} is not canonical base64url`);
  return out;
}

function encodeKeymasterContent(record: ProviderSealedMessageRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 1,
    envelopeBase64Url: base64urlEncode(record.envelope.envelopeBytes),
    signatureBase64Url: base64urlEncode(record.envelope.signatureBytes)
  }));
}

function parseKeymasterContent(contentJson: Uint8Array): { envelopeBytes: Uint8Array; signatureBytes: Uint8Array } {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contentJson)); } catch { throw new SatSubscriptionError("protocol", "Channel Deliver content is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SatSubscriptionError("protocol", "Channel Deliver content must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || record.version !== 1 || typeof record.envelopeBase64Url !== "string" || typeof record.signatureBase64Url !== "string") {
    throw new SatSubscriptionError("protocol", "Channel Deliver content has an invalid shape");
  }
  const envelopeBytes = parseBase64Url(record.envelopeBase64Url, "envelopeBase64Url");
  const signatureBytes = parseBase64Url(record.signatureBase64Url, "signatureBase64Url");
  if (signatureBytes.byteLength !== 64) throw new SatSubscriptionError("protocol", "AppMsg signature must be 64 bytes");
  return { envelopeBytes, signatureBytes };
}

function appMsgRecordFromChannel(input: {
  opened: SatChannelOpenResult;
  contentJson: Uint8Array;
  ingressSupplierId: string;
  insertedAtMs: number;
}): ProviderSealedMessageRecord {
  if (!isCompressedPublicKeyHex(input.opened.fromPublicKeyHex) || !isCompressedPublicKeyHex(input.opened.toPublicKeyHex)) throw new SatSubscriptionError("protocol", "Channel identity is not a compressed public key");
  const content = parseKeymasterContent(input.contentJson);
  const metadata = readAppMsgEnvelopeMetadata(content.envelopeBytes);
  if (metadata.senderPublicKeyHex !== input.opened.fromPublicKeyHex) throw new SatSubscriptionError("identity", "Channel sender and AppMsg sender differ");
  if (metadata.recipientPublicKeyHex !== input.opened.toPublicKeyHex) throw new SatSubscriptionError("identity", "Channel recipient and AppMsg recipient differ");
  return {
    messageId: input.opened.messageIdBase64Url,
    senderPublicKeyHex: metadata.senderPublicKeyHex,
    senderEndpointId: metadata.senderEndpointId,
    senderEndpointKind: metadata.senderEndpointKind,
    recipientPublicKeyHex: metadata.recipientPublicKeyHex,
    recipientEndpointId: metadata.recipientEndpointId,
    recipientEndpointKind: metadata.recipientEndpointKind,
    clientMessageId: metadata.clientMessageId,
    createdAtMs: metadata.createdAtMs,
    insertedAtMs: input.insertedAtMs,
    envelope: { envelopeBytes: content.envelopeBytes, signatureBytes: content.signatureBytes },
    ingressSupplierId: input.ingressSupplierId
  };
}

function dedupKey(protocol: string, fromPublicKeyHex: string, messageId: string): string {
  return `${protocol}\u0000${fromPublicKeyHex}\u0000${messageId}`;
}

function deliveryAckKey(deliveryId: string, supplierId: string): string {
  return deliveryId + "\u0000" + supplierId;
}

type DeliveryAckState = "pending" | "claimed" | "ack_sending" | "acknowledged" | "unknown";

interface DeliveryAckEntry {
  /** Worker 生成的实际入站投递编号。 */
  supplierId: string;
  claimToken: string;
  /** 下面四项是 ACK 的唯一权威字段，不能从页面 record 读取。 */
  senderPublicKeyHex: string;
  messageId: string;
  dedupKey: string;
  supplierGeneration: number;
  state: DeliveryAckState;
  inFlight?: Promise<void>;
}

interface DeliveryAckTombstone {
  claimToken: string;
  state: "acknowledged" | "unknown";
}

function claimFromInput(input: ProviderSealedMessageRecord | ProviderDeliveryAckClaim): ProviderDeliveryAckClaim {
  if (!input || typeof input !== "object") return { deliveryId: "", supplierId: "", ackClaimToken: "" };
  const value = input as Partial<ProviderSealedMessageRecord & ProviderDeliveryAckClaim>;
  return {
    deliveryId: typeof value.deliveryId === "string" ? value.deliveryId : "",
    supplierId: typeof value.supplierId === "string"
      ? value.supplierId
      : typeof value.ingressSupplierId === "string" ? value.ingressSupplierId : "",
    ackClaimToken: typeof value.ackClaimToken === "string" ? value.ackClaimToken : "",
  };
}

function isFullDeliveryRecord(input: ProviderSealedMessageRecord | ProviderDeliveryAckClaim): input is ProviderSealedMessageRecord {
  return "messageId" in input || "senderPublicKeyHex" in input || "envelope" in input;
}

function digestHex(value: Uint8Array): string {
  return bytesToHex(sha256(value));
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

class SatSubscriptionHandle implements MessageProviderOperations {
  private currentState: "connecting" | "bound" | "closed" = "connecting";
  private readonly connections = new Map<string, SatSupplierConnection>();
  private readonly connectionErrors = new Map<string, string>();
  private readonly offPublish = new Map<string, () => void>();
  private readonly subscribers = new Set<(record: ProviderSealedMessageRecord) => void>();
  private readonly incomingSubscribers = new Set<(event: SatIncomingPublish) => void>();
  /**
   * 权威入站投递队列；一条 delivery 同时包含 AppMsg record 和 sat event，
   * 不再用两个独立队列分别计数，避免一侧满而另一侧静默丢失。
   */
  private readonly pendingDeliveries: Array<{
    record: ProviderSealedMessageRecord;
    event: SatIncomingPublish;
    recordDelivered: boolean;
    eventDelivered: boolean;
  }> = [];
  /** 已进入 handleIncomingWire、但尚未完成投影的 delivery 也占用一个队列项。 */
  private deliveryAdmissionReservations = 0;
  /** 同一 deliveryId + supplierId 的 ACK 单写者状态；只保存有限数量的 active claim。 */
  private readonly deliveryAcks = new Map<string, DeliveryAckEntry>();
  /** 终态 tombstone 只保留有限数量，防止未知结果被自动重发。 */
  private readonly deliveryAckTombstones = new Map<string, DeliveryAckTombstone>();
  /** 并发入站在真正写入 claim 表前也要占用一个 active slot。 */
  private deliveryAckAdmissionReservations = 0;
  private readonly ownerPublicKeyHex: string;
  private readonly stateStore: SatSubscriptionStateStore;
  /** Supplier catalog 代际；配置变更会使所有旧请求/连接失效。 */
  private generation: number;
  /** 串行化 supplier 配置变更，避免两个设置操作交叉关闭/重连。 */
  private configMutationTail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly cfg: SatSubscriptionProviderConfig;
  private readonly setProviderHealth: (healthy: boolean, error: string | null) => void;

  constructor(input: {
    ownerPublicKeyHex: string;
    stateStore: SatSubscriptionStateStore;
    generation: number;
    cfg: SatSubscriptionProviderConfig;
    setProviderHealth: (healthy: boolean, error: string | null) => void;
  }) {
    this.ownerPublicKeyHex = input.ownerPublicKeyHex;
    this.stateStore = input.stateStore;
    this.generation = input.generation;
    this.cfg = input.cfg;
    this.now = input.cfg.now ?? Date.now;
    this.setProviderHealth = input.setProviderHealth;
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
    if (!this.cfg.transport) {
      if (this.currentState === "closed") return;
      this.currentState = "bound";
      this.setProviderHealth(false, "SatSubscription transport is unavailable");
      return;
    }
    let observedGeneration = this.generation;
    // 配置可能在初次连接期间变更；只在当前 generation 的连接全部完成后
    // 才进入 bound，旧配置的连接结果会被 connectSupplier 丢弃。
    for (;;) {
      const suppliers = this.stateStore.listSuppliers().filter((item) => item.enabled);
      await Promise.all(suppliers.map((supplier) => this.connectSupplier(supplier, observedGeneration)));
      if (this.currentState === "closed") return;
      if (observedGeneration === this.generation) break;
      observedGeneration = this.generation;
    }
    if (this.state() === "closed") return;
    this.currentState = "bound";
    if (this.connections.size > 0) this.setProviderHealth(true, null);
    else this.setProviderHealth(false, this.connectionErrors.values().next().value ?? "No SatSubscription supplier is connected");
  }

  private async connectSupplier(supplier: SatSupplierConfigV1, generation = this.generation): Promise<void> {
    if (!this.cfg.transport || !supplier.enabled || this.currentState === "closed") return;
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
      const activeConnection = await this.cfg.transport.connect({ supplier, ownerPublicKeyHex: this.ownerPublicKeyHex, ownerSessionEpoch, supplierGeneration: generation, onSspRequest: requestHandler });
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
      if (generation !== this.generation || this.state() === "closed") {
        unsubscribe();
        this.offPublish.delete(supplier.supplierId);
        if (this.connections.get(supplier.supplierId) === activeConnection) this.connections.delete(supplier.supplierId);
        activeConnection.close();
        return;
      }
    } catch (error) {
      try { unsubscribe?.(); } catch { /* subscribe 失败时无须再传播 */ }
      if (connection && this.connections.get(supplier.supplierId) === connection) {
        this.connections.delete(supplier.supplierId);
      }
      try { connection?.close(); } catch { /* connection 可能已关闭 */ }
      if (generation !== this.generation || this.state() === "closed") return;
      this.connectionErrors.set(supplier.supplierId, error instanceof Error ? error.message : String(error));
    }
  }

  close(): void {
    if (this.currentState === "closed") return;
    this.generation += 1;
    this.currentState = "closed";
    for (const off of this.offPublish.values()) { try { off(); } catch { /* ignore */ } }
    this.offPublish.clear();
    for (const connection of this.connections.values()) { try { connection.close(); } catch { /* ignore */ } }
    this.connections.clear();
    this.subscribers.clear();
    this.incomingSubscribers.clear();
    this.pendingDeliveries.length = 0;
    this.deliveryAdmissionReservations = 0;
    this.deliveryAcks.clear();
    this.deliveryAckTombstones.clear();
    this.deliveryAckAdmissionReservations = 0;
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

  private async requestAction(input: {
    action: "subscribe" | "unsubscribe";
    supplierId: string;
    channel: string;
  }): Promise<SatActionResult> {
    this.assertOpen();
    this.assertChannel(input.channel, true);
    const requestId = validateRequestId(newRequestId());
    let response: Uint8Array;
    let feeRecorded = false;
    let requestGeneration = this.generation;
    try {
      const connection = this.connectionFor(input.supplierId);
      requestGeneration = this.generation;
      await this.stateStore.setDesiredSubscription({ supplierId: input.supplierId, channel: input.channel, state: input.action === "subscribe" ? "subscribing" : "unsubscribing", errorCode: null });
      const wire = input.action === "subscribe" ? newSubscribe(requestId, input.channel) : newUnsubscribe(requestId, input.channel);
      response = await connection.requestSsp(wire);
      this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
    } catch (error) {
      const code = stableErrorCode(error);
      const unknown = code === "unknown_result";
      if (this.isCurrentSupplierGeneration(input.supplierId, requestGeneration)) {
        try {
          await this.stateStore.setDesiredSubscription({ supplierId: input.supplierId, channel: input.channel, state: unknown ? "unknown_result" : "unknown", errorCode: code });
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
        await this.stateStore.setDesiredSubscription({ supplierId: input.supplierId, channel: input.channel, state: "unknown", errorCode: code });
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
      await this.recordFee({ action: input.action, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: result.chargedAmount, result: "ok" });
      feeRecorded = true;
      return { ok: true, supplierId: input.supplierId, channel: input.channel, requestIdHex: bytesToHex(requestId), chargedAmount: result.chargedAmount };
    } catch (error) {
      const code = stableErrorCode(error);
      if (this.isCurrentSupplierGeneration(input.supplierId, requestGeneration)) {
        try {
          await this.stateStore.setDesiredSubscription({ supplierId: input.supplierId, channel: input.channel, state: "unknown_result", errorCode: code });
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
    try {
      response = await this.connectionFor(input.supplierId).requestSsp(newPublish(requestId, input.channel, contentJson));
      this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
    } catch (error) {
      const code = stableErrorCode(error);
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

  async sendMessage(input: ProviderSendInput): Promise<ProviderSendResult> {
    this.assertOpen();
    if (this.currentState !== "bound") throw new SatSubscriptionError("connect", "SatSubscription provider is not bound");
    const record = input.record;
    assertCompressedPublicKeyHex(record.recipientPublicKeyHex, "recipientPublicKeyHex");
    const route = readAppMsgEnvelopeMetadata(record.envelope.envelopeBytes);
    if (route.senderPublicKeyHex !== this.ownerPublicKeyHex || route.recipientPublicKeyHex !== record.recipientPublicKeyHex) throw new SatSubscriptionError("identity", "AppMsg sealed route does not match the current owner/recipient");
    const supplierId = this.defaultSupplierId();
    const now = this.now();
    const sealed = await this.cfg.channelCrypto.sealDeliver({
      recipientPublicKeyHex: record.recipientPublicKeyHex,
      contentJson: encodeKeymasterContent(record),
      issuedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000
    });
    if (sealed.channel !== `${BSV8_INBOX_CHANNEL_PREFIX}${record.recipientPublicKeyHex}`) throw new SatSubscriptionError("identity", "Channel seal returned an unexpected inbox");
    if (sealed.fromPublicKeyHex !== this.ownerPublicKeyHex) throw new SatSubscriptionError("identity", "Channel seal returned an unexpected sender");
    await this.publishRaw({ supplierId, channel: sealed.channel, contentJson: sealed.envelopeJson, action: "publish" });
    await this.stateStore.rememberChannel({
      dedupKey: dedupKey(BSV8_MESSAGE_PROTOCOL, this.ownerPublicKeyHex, sealed.messageIdBase64Url),
      direction: "outbound",
      contentDigestHex: digestHex(sealed.envelopeJson),
      fromPublicKeyHex: this.ownerPublicKeyHex,
      recipientPublicKeyHex: record.recipientPublicKeyHex,
      messageIdBase64Url: sealed.messageIdBase64Url,
      ingressSupplierId: supplierId
    });
    return { messageId: sealed.messageIdBase64Url, insertedAtMs: now };
  }

  async listMessages(_input: ProviderListInput): Promise<ProviderListResult> {
    this.assertOpen();
    throw new SatSubscriptionError("unavailable", "SatSubscription provider has no remote history");
  }

  async getMessage(_input: ProviderGetInput): Promise<ProviderSealedMessageRecord | null> {
    this.assertOpen();
    throw new SatSubscriptionError("unavailable", "SatSubscription provider has no remote history");
  }

  subscribeMessages(handler: (record: ProviderSealedMessageRecord) => void): () => void {
    this.assertOpen();
    this.subscribers.add(handler);
    this.flushPendingDeliveries();
    return () => this.subscribers.delete(handler);
  }

  subscribeIncoming(handler: (event: SatIncomingPublish) => void): () => void {
    this.assertOpen();
    this.incomingSubscribers.add(handler);
    this.flushPendingDeliveries();
    return () => this.incomingSubscribers.delete(handler);
  }

  private reserveDeliveryAdmission(): void {
    if (this.pendingDeliveries.length + this.deliveryAdmissionReservations >= SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxPendingIncomingPerLane) {
      throw new SatSubscriptionError("unavailable", "Sat inbound delivery queue is full");
    }
    this.deliveryAdmissionReservations += 1;
  }

  private releaseDeliveryAdmission(): void {
    this.deliveryAdmissionReservations = Math.max(0, this.deliveryAdmissionReservations - 1);
  }

  private reserveDeliveryAck(): void {
    if (this.deliveryAcks.size + this.deliveryAckAdmissionReservations >= SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxActiveDeliveryAcks) {
      throw new SatSubscriptionError("unavailable", "Sat delivery ACK claim table is full");
    }
    this.deliveryAckAdmissionReservations += 1;
  }

  private releaseDeliveryAckAdmission(): void {
    this.deliveryAckAdmissionReservations = Math.max(0, this.deliveryAckAdmissionReservations - 1);
  }

  private rememberDeliveryAckTombstone(key: string, entry: DeliveryAckEntry, state: "acknowledged" | "unknown"): void {
    this.deliveryAckTombstones.delete(key);
    this.deliveryAckTombstones.set(key, { claimToken: entry.claimToken, state });
    while (this.deliveryAckTombstones.size > SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxDeliveryAckTombstones) {
      const oldest = this.deliveryAckTombstones.keys().next().value;
      if (typeof oldest !== "string") break;
      this.deliveryAckTombstones.delete(oldest);
    }
  }

  private finalizeDeliveryAck(key: string, entry: DeliveryAckEntry, state: "acknowledged" | "unknown"): void {
    if (this.deliveryAcks.get(key) !== entry) return;
    this.deliveryAcks.delete(key);
    this.rememberDeliveryAckTombstone(key, entry, state);
  }

  private dispatchDeliveryPart(delivery: {
    record: ProviderSealedMessageRecord;
    event: SatIncomingPublish;
    recordDelivered: boolean;
    eventDelivered: boolean;
  }): void {
    if (!delivery.recordDelivered && this.subscribers.size > 0) {
      for (const handler of this.subscribers) {
        try { handler(delivery.record); } catch { /* 单个 Tab handler 失败不能阻断其它 Tab。 */ }
      }
      delivery.recordDelivered = true;
    }
    if (!delivery.eventDelivered && this.incomingSubscribers.size > 0) {
      for (const handler of this.incomingSubscribers) {
        try { handler({ ...delivery.event, contentJson: delivery.event.contentJson.slice() }); } catch { /* ignore */ }
      }
      delivery.eventDelivered = true;
    }
  }

  private flushPendingDeliveries(): void {
    for (const delivery of [...this.pendingDeliveries]) {
      this.dispatchDeliveryPart(delivery);
      if (delivery.recordDelivered && delivery.eventDelivered) {
        const index = this.pendingDeliveries.indexOf(delivery);
        if (index >= 0) this.pendingDeliveries.splice(index, 1);
      }
    }
  }

  private emitDelivery(record: ProviderSealedMessageRecord, event: SatIncomingPublish): void {
    const delivery = { record, event, recordDelivered: false, eventDelivered: false };
    this.dispatchDeliveryPart(delivery);
    if (!delivery.recordDelivered || !delivery.eventDelivered) this.pendingDeliveries.push(delivery);
  }

  async checkOnline(input: ProviderOnlineInput): Promise<ProviderOnlineResult> {
    this.assertOpen();
    return unknownOnline(input);
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

  async refreshSubscriptions(input: { supplierId: string }): Promise<{ channels: string[]; chargedAmount: string }> {
    this.assertOpen();
    const requestId = validateRequestId(newRequestId());
    let response: Uint8Array;
    const requestGeneration = this.generation;
    try {
      response = await this.connectionFor(input.supplierId).requestSsp(newSubscriptionsRequest(requestId));
      this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
    } catch (error) {
      const code = stableErrorCode(error);
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
      const previouslyObserved = new Set(
        this.stateStore.listSubscriptions(input.supplierId)
          .filter((item) => item.observed === "subscribed")
          .map((item) => item.channel)
      );
      for (const channel of channels) {
        this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
        assertExactChannel(channel, true);
        previouslyObserved.delete(channel);
        await this.stateStore.setObservedSubscription({ supplierId: input.supplierId, channel, state: "subscribed", source: "refresh" });
      }
      for (const channel of previouslyObserved) {
        this.assertCurrentSupplierGeneration(input.supplierId, requestGeneration);
        await this.stateStore.setObservedSubscription({ supplierId: input.supplierId, channel, state: "unsubscribed", source: "refresh" });
      }
      await this.recordFee({ action: "subscriptions", supplierId: input.supplierId, channel: "", requestIdHex: bytesToHex(requestId), chargedAmount: result.chargedAmount, result: "ok" });
      feeRecorded = true;
      return { channels, chargedAmount: result.chargedAmount };
    } catch (error) {
      const code = stableErrorCode(error);
      if (!feeRecorded) await this.recordFee({ action: "subscriptions", supplierId: input.supplierId, channel: "", requestIdHex: bytesToHex(requestId), chargedAmount: "", result: code === "unknown_result" ? "unknown_result" : "error", errorCode: code });
      if (error instanceof SatSubscriptionError) throw error;
      throw new SatSubscriptionError(code, error instanceof Error ? error.message : String(error));
    }
  }

  async ackMessage(input: ProviderSealedMessageRecord | ProviderDeliveryAckClaim): Promise<void> {
    this.assertOpen();
    const claim = claimFromInput(input);
    const deliveryId = claim.deliveryId;
    const claimToken = claim.ackClaimToken;
    const supplierId = claim.supplierId;
    if (!deliveryId || !claimToken || !supplierId) {
      // ACK 必须绑定到 Worker 为本次实际 ingress 生成的 claim；旧 record
      // 或页面伪造的 record 不能回退到“最后一次 Supplier”。
      throw new SatSubscriptionError("validation", "Sat delivery ACK claim is missing");
    }
    const key = deliveryAckKey(deliveryId, supplierId);
    const delivery = this.deliveryAcks.get(key);
    const tombstone = this.deliveryAckTombstones.get(key);
    if (!delivery && tombstone?.claimToken === claimToken) {
      if (tombstone.state === "acknowledged") return;
      throw new SatSubscriptionError("unknown_result", "Sat delivery ACK result is unknown; automatic retry is disabled");
    }
    if (!delivery || delivery.claimToken !== claimToken) {
      throw new SatSubscriptionError("conflict", "Sat delivery ACK claim is stale or invalid");
    }
    if (isFullDeliveryRecord(input) && (
      input.ingressSupplierId !== delivery.supplierId
      || input.senderPublicKeyHex !== delivery.senderPublicKeyHex
      || input.messageId !== delivery.messageId
    )) {
      // 兼容 provider 内部直接调用旧 record 形状时也要检测篡改；生产页面
      // RPC 已经只发送 claim 三元组，因此不会把这些可变字段送入 Worker。
      throw new SatSubscriptionError("conflict", "Sat delivery ACK record does not match the Worker claim");
    }
    if (delivery.state === "acknowledged") return;
    if (delivery.state === "unknown") {
      // sentBoundary=unknown 时禁止另一个 Tab 自动重发，避免同一付费
      // Deliver 因响应丢失而再次收费。
      throw new SatSubscriptionError("unknown_result", "Sat delivery ACK result is unknown; automatic retry is disabled");
    }
    if (delivery.inFlight) return delivery.inFlight;
    delivery.state = "claimed";
    const send = this.sendDeliveryAck(key, delivery);
    const wrapped = send.finally(() => {
      if (delivery.inFlight === wrapped) delivery.inFlight = undefined;
    });
    delivery.inFlight = wrapped;
    return delivery.inFlight;
  }

  private async sendDeliveryAck(
    key: string,
    delivery: DeliveryAckEntry,
  ): Promise<void> {
    const senderPublicKey = delivery.senderPublicKeyHex;
    const now = this.now();
    const requestGeneration = delivery.supplierGeneration;
    try {
      delivery.state = "ack_sending";
      // sender/messageId 来自 Worker 保存的权威 claim；这里仍做格式断言，
      // 让损坏的内部状态进入 unknown/审计闭环，而不是留下 claimed。
      assertCompressedPublicKeyHex(senderPublicKey, "senderPublicKeyHex");
      const sealed = await this.cfg.channelCrypto.sealAck({ recipientPublicKeyHex: senderPublicKey, acknowledgedMessageIdBase64Url: delivery.messageId, issuedAtMs: now, expiresAtMs: now + 24 * 60 * 60 * 1000 });
      if (sealed.channel !== `${BSV8_INBOX_CHANNEL_PREFIX}${senderPublicKey}`) throw new SatSubscriptionError("identity", "Channel ACK returned an unexpected inbox");
      this.assertCurrentSupplierGeneration(delivery.supplierId, requestGeneration);
      await this.publishRaw({ supplierId: delivery.supplierId, channel: sealed.channel, contentJson: sealed.envelopeJson, action: "ack" });
      this.assertCurrentSupplierGeneration(delivery.supplierId, requestGeneration);
      await this.stateStore.updateChannelAck({ dedupKey: delivery.dedupKey, supplierId: delivery.supplierId, state: "acknowledged" });
      delivery.state = "acknowledged";
      this.finalizeDeliveryAck(key, delivery, "acknowledged");
    } catch (error) {
      const code = stableErrorCode(error);
      // connect 表示 transport 明确证明 Wire 尚未发送，可保留 pending
      // 供显式的后续调用重新 claim；其它结果一律锁为 unknown。
      const terminal = code !== "connect";
      delivery.state = terminal ? "unknown" : "pending";
      try {
        await this.stateStore.updateChannelAck({ dedupKey: delivery.dedupKey, supplierId: delivery.supplierId, state: "failed", errorCode: code });
      } finally {
        if (terminal) this.finalizeDeliveryAck(key, delivery, "unknown");
      }
      throw error;
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
    const deliveryId = "sat-delivery-" + crypto.randomUUID();
    const ackClaimToken = "sat-ack-claim-" + crypto.randomUUID();
    const event: SatIncomingPublish = { deliveryId, ingressSupplierId: supplierId, channel: "", requestIdHex: bytesToHex(requestId), contentJson: new Uint8Array(), chargedAmount: "0", receivedAtMs: this.now() };
    let deliveryReserved = false;
    let deliveryAckReserved = false;
    try {
      const publish = parsePublish(wire);
      event.channel = publish.channel;
      event.requestIdHex = bytesToHex(publish.requestId);
      event.contentJson = publish.contentJson.slice();
      const ownerInbox = `${BSV8_INBOX_CHANNEL_PREFIX}${this.ownerPublicKeyHex}`;
      if (publish.channel !== ownerInbox) throw new SatSubscriptionError("validation", "SSP Publish channel is not the current owner inbox");
      if (!(this.stateStore.getOwnerSettings()?.receiveSupplierIds ?? []).includes(supplierId)) {
        throw new SatSubscriptionError("config", "Ingress Supplier is not enabled for owner message reception");
      }
      const opened = await this.cfg.channelCrypto.open({ channel: publish.channel, envelopeJson: publish.contentJson, nowMs: event.receivedAtMs });
      if (!this.isCurrentSupplierGeneration(supplierId, generation)) throw new SatSubscriptionError("unknown_result", "Supplier configuration changed while handling inbound request");
      if (opened.channel !== publish.channel || opened.toPublicKeyHex !== this.ownerPublicKeyHex) throw new SatSubscriptionError("identity", "Channel envelope target does not match the owner inbox");
      if (opened.protocol !== BSV8_MESSAGE_PROTOCOL) {
        // 其它 protocol 是 internal 事件，不能被错误地投影为 AppMsg。
        return newActionResult({ requestId: publish.requestId, success: true, chargedAmount: "0", errorCode: "" });
      }
      if (opened.bodyType === "ack") {
        const acknowledgedMessageId = opened.acknowledgedMessageIdBase64Url;
        if (!acknowledgedMessageId) throw new SatSubscriptionError("protocol", "Channel ACK is missing acknowledged_message_id");
        const original = this.stateStore.getChannel(dedupKey(BSV8_MESSAGE_PROTOCOL, this.ownerPublicKeyHex, acknowledgedMessageId));
        if (!original || original.direction !== "outbound" || original.recipientPublicKeyHex !== opened.fromPublicKeyHex) {
          this.cfg.logger?.warn?.("sat.ack.rejected", { supplierId, code: "identity" });
          return newActionResult({ requestId: publish.requestId, success: false, chargedAmount: "0", errorCode: "INVALID_REQUEST" });
        }
        await this.stateStore.updateChannelAck({ dedupKey: original.dedupKey, supplierId, state: "acknowledged" });
        return newActionResult({ requestId: publish.requestId, success: true, chargedAmount: "0", errorCode: "" });
      }
      if (!opened.contentJson) throw new SatSubscriptionError("protocol", "Channel Deliver is missing content");
      // 在任何 await 状态持久化前预占权威投递队列项；并发入站不会
      // 共同看到“尚有空位”而最终把第 65 条静默丢弃。
      this.reserveDeliveryAdmission();
      deliveryReserved = true;
      // claim 表与 pending 投递队列一样是硬上限；先预占再 await，避免
      // 多个入站 handler 同时通过 active claim 数检查。
      this.reserveDeliveryAck();
      deliveryAckReserved = true;
      const record = appMsgRecordFromChannel({ opened, contentJson: opened.contentJson, ingressSupplierId: supplierId, insertedAtMs: event.receivedAtMs });
      record.deliveryId = deliveryId;
      record.ackClaimToken = ackClaimToken;
      const key = dedupKey(opened.protocol, record.senderPublicKeyHex, record.messageId);
      // 去重摘要使用 Channel SDK 验签后返回的 signed digest，而不是外层
      // 随机 salt/nonce 产生的密文摘要；同一 Deliver 重加密仍应被识别为重复，
      // 但 message_id 相同而签名内容变化时会进入 conflict。
      const relation = await this.stateStore.rememberChannel({ dedupKey: key, direction: "inbound", contentDigestHex: opened.signedDigestHex, fromPublicKeyHex: record.senderPublicKeyHex, recipientPublicKeyHex: record.recipientPublicKeyHex, messageIdBase64Url: record.messageId, ingressSupplierId: supplierId });
      if (!this.isCurrentSupplierGeneration(supplierId, generation)) throw new SatSubscriptionError("unknown_result", "Supplier configuration changed while handling inbound request");
      if (relation === "conflict") return newActionResult({ requestId: publish.requestId, success: false, chargedAmount: "0", errorCode: "INVALID_REQUEST" });
      // AppMsg 的本地 put 与 Channel 去重关系都已可靠持久化后，沿用第一条
      // 关系的时间；多 Supplier 重复投递不能覆盖 insertedAtMs。
      record.insertedAtMs = this.stateStore.getChannel(key)?.firstPersistedAtMs ?? record.insertedAtMs;
      // 这是 platform-internal delivery metadata：duplicate 仍需经过
      // plugin-appmsg 的验签、解密、落库和 ACK，但不能再次触发业务事件。
      record.deliveryRelation = relation;
      // 每个实际 ingress 都必须经过 plugin-appmsg 的验签、解密、落库和
      // ACK；多 Supplier 重复 ingress 由 deliveryRelation 标记，
      // plugin-appmsg 只据此抑制第二次业务通知。
      this.deliveryAcks.set(deliveryAckKey(deliveryId, supplierId), {
        supplierId,
        claimToken: ackClaimToken,
        senderPublicKeyHex: record.senderPublicKeyHex,
        messageId: record.messageId,
        dedupKey: key,
        supplierGeneration: generation,
        state: "pending",
      });
      this.emitDelivery(record, event);
      return newActionResult({ requestId: publish.requestId, success: true, chargedAmount: "0", errorCode: "" });
    } catch (error) {
      this.connectionErrors.set(supplierId, error instanceof Error ? error.message : String(error));
      this.cfg.logger?.warn?.("sat.incoming.rejected", { supplierId, code: stableErrorCode(error) });
      const code = error instanceof SatSubscriptionError && error.code === "balance" ? "REJECTED" : "INVALID_REQUEST";
      return newActionResult({ requestId, success: false, chargedAmount: "0", errorCode: code });
    } finally {
      if (deliveryReserved) this.releaseDeliveryAdmission();
      if (deliveryAckReserved) this.releaseDeliveryAckAdmission();
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
    return this.enqueueConfigMutation(async () => {
      const normalized = normalizeSupplierConfig(config);
      const previous = this.stateStore.getSupplier(normalized.supplierId);
      this.generation += 1;
      this.stopSupplier(normalized.supplierId);
      this.connectionErrors.delete(normalized.supplierId);
      try {
        await this.stateStore.upsertSupplier(normalized);
      } catch (error) {
        if (previous?.enabled && this.currentState === "bound") await this.connectSupplier(previous, this.generation);
        this.updateProviderHealth();
        throw error;
      }
      if (normalized.enabled && this.currentState === "bound") await this.connectSupplier(normalized, this.generation);
      this.updateProviderHealth();
    });
  }

  async deleteSupplier(supplierId: string): Promise<void> {
    this.assertOpen();
    return this.enqueueConfigMutation(async () => {
      const previous = this.stateStore.getSupplier(supplierId);
      this.generation += 1;
      this.stopSupplier(supplierId);
      this.connectionErrors.delete(supplierId);
      try {
        await this.stateStore.deleteSupplier(supplierId);
      } catch (error) {
        if (previous?.enabled && this.currentState === "bound") await this.connectSupplier(previous, this.generation);
        this.updateProviderHealth();
        throw error;
      }
      this.updateProviderHealth();
    });
  }

  private enqueueConfigMutation(operation: () => Promise<void>): Promise<void> {
    const run = this.configMutationTail.then(operation);
    this.configMutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private stopSupplier(supplierId: string): void {
    this.offPublish.get(supplierId)?.();
    this.offPublish.delete(supplierId);
    this.connections.get(supplierId)?.close();
    this.connections.delete(supplierId);
  }

  private updateProviderHealth(): void {
    this.setProviderHealth(this.connections.size > 0, this.connections.size > 0 ? null : (this.connectionErrors.values().next().value ?? "No SatSubscription supplier is connected"));
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
    await this.stateStore.setOwnerSettings(settings);
  }
}

/** SatSubscription provider 工厂。 */
export class SatSubscriptionProvider implements MessageProvider {
  readonly id = SAT_SUBSCRIPTION_PROVIDER_ID;
  readonly displayName = "SatSubscription";
  readonly features = { remoteHistory: false, onlineQuery: false, deliveryAck: true } as const;
  private readonly cfg: SatSubscriptionProviderConfig;
  private currentHandle: SatSubscriptionHandle | null = null;
  private currentService: SatSubscriptionService | null = null;
  private currentAdmin: SatSubscriptionAdminService | null = null;
  private lastError: string | null = null;
  private lastConnectedAtMs = 0;

  constructor(cfg: SatSubscriptionProviderConfig) { this.cfg = cfg; }

  async bind(input: { signer: ProviderSigner }): Promise<MessageProviderHandle> {
    this.currentHandle?.close();
    this.currentHandle = null;
    this.currentService = null;
    this.currentAdmin = null;
    assertCompressedPublicKeyHex(input.signer.publicKeyHex, "owner signer publicKeyHex");
    const stateStore = await this.cfg.stateForOwner(input.signer.publicKeyHex);
    const handle = new SatSubscriptionHandle({
      ownerPublicKeyHex: input.signer.publicKeyHex,
      stateStore,
      generation: this.cfg.supplierGeneration ?? stateStore.supplierGeneration(),
      cfg: this.cfg,
      setProviderHealth: (healthy, error) => {
        this.lastError = error;
        if (healthy) this.lastConnectedAtMs = this.cfg.now?.() ?? Date.now();
      }
    });
    this.currentHandle = handle;
    await handle.start();
    this.currentService = {
      publish: (value) => handle.publish(value),
      setSubscription: (value) => handle.setSubscription(value),
      subscribe: (value) => handle.subscribe(value),
      unsubscribe: (value) => handle.unsubscribe(value),
      refreshSubscriptions: (value) => handle.refreshSubscriptions(value),
      subscribeEvents: (handler) => handle.subscribeIncoming(handler)
    };
    this.currentAdmin = {
      ...this.currentService,
      getSettingsSnapshot: () => handle.getSettingsSnapshot(),
      upsertSupplier: (config) => handle.upsertSupplier(config),
      deleteSupplier: (supplierId) => handle.deleteSupplier(supplierId),
      setOwnerSettings: (settings) => handle.setOwnerSettings(settings)
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

  health(): MessageProviderHealth {
    return {
      isHealthy: this.currentHandle?.state() === "bound" && this.lastError === null && this.lastConnectedAtMs > 0,
      lastError: this.lastError,
      lastConnectedAtMs: this.lastConnectedAtMs
    };
  }

  async checkOnline(input: ProviderOnlineInput): Promise<ProviderOnlineResult> {
    return unknownOnline(input);
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
