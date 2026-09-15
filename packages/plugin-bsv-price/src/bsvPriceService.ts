// BSV 价格业务 service。
//
// 价格订阅是普通 Channel 公共消息：插件只知道精确频道和自己的业务内容，
// 不接触 Supplier、SSP Wire、签名壳或远端历史。

import type {
  BorrowedKeyValueStore,
  ChannelRuntime,
  ChannelSubscriptionErrorCode,
  ChannelSubscriptionStatus,
} from "@keymaster/contracts";
import { parsePublicKey } from "bsv8-channel-protocol";
import { bsvPriceChannel } from "bsv8-channel-protocol/bsv-price";
import { decodePriceContent, type BsvPriceSnapshot } from "./bsvPriceProtocol.js";
import {
  createKeyValueBsvPriceSettingsStore,
  type BsvPriceSettingsStore,
  normalizePublisherPublicKeyHex,
  type BsvPriceGlobalConfig
} from "./bsvPriceSettings.js";

/** service 对外状态。 */
export type BsvPriceServiceStatus =
  | "idle"
  | "offline"
  | "not_configured"
  | "sat_not_configured"
  | "sat_connecting"
  | "sat_balance_required"
  | "sat_identity_error"
  | "sat_subscription_error"
  | "subscription_unknown"
  | "waiting_snapshot"
  | "receiving";

/** service 对外快照。 */
export interface BsvPriceServiceSnapshot {
  /** 当前精确订阅频道；未配置时为占位文字。 */
  channelId: string;
  /** 当前 Channel runtime 状态。 */
  coreState: string;
  /** service 自身状态。 */
  status: BsvPriceServiceStatus;
  /** 最近一次收到的合法快照；尚未收到时为 null。 */
  snapshot: BsvPriceSnapshot | null;
  /** 最近一次业务内容解析错误。 */
  lastError: string | null;
  /** 最近一次物理订阅业务错误码。 */
  subscriptionErrorCode: ChannelSubscriptionErrorCode | null;
  /** 最近一次物理订阅业务错误消息（已由 Channel runtime 限长）。 */
  subscriptionErrorMessage: string | null;
  /** 当前是否有有效 publisher 配置。 */
  configured: boolean;
}

/** service 接口。 */
export interface BsvPriceService {
  snapshot(): BsvPriceServiceSnapshot;
  subscribe(handler: () => void): () => void;
  currentMarkets(): Readonly<Record<string, Readonly<Record<string, string>>>>;
  getPublisherPublicKeyHex(): string;
  configured(): boolean;
  savePublisherPublicKeyHex(input: string): Promise<void>;
  dispose(): void;
}

export interface CreateBsvPriceServicePersistentOptions {
  /** 首次启动时使用的配置种子。 */
  seedPublisherPublicKeyHex?: string;
  /** Host 绑定的 BSV Price bucket K-V 句柄。 */
  storage: BorrowedKeyValueStore;
  /** 测试可注入时钟。 */
  now?: () => number;
}

/** 显式内存实现，仅供测试注入；生产构造必须使用持久化 storage。 */
export interface CreateBsvPriceServiceMemoryOptions {
  seedPublisherPublicKeyHex?: string;
  settingsStore: BsvPriceSettingsStore;
  storage?: never;
  now?: () => number;
}

export type CreateBsvPriceServiceOptions =
  | CreateBsvPriceServicePersistentOptions
  | CreateBsvPriceServiceMemoryOptions;

export function createBsvPriceService(
  channel: ChannelRuntime,
  options: CreateBsvPriceServiceOptions
): BsvPriceService & { ready(): Promise<void> } {
  const store = "settingsStore" in options
    ? options.settingsStore
    : createKeyValueBsvPriceSettingsStore(options.storage, options.now);
  const isExplicitMemoryStore = "settingsStore" in options;
  const listeners = new Set<() => void>();
  let offMessage: (() => void) | null = null;
  let offSubscriptionStatus: (() => void) | null = null;
  let subscriptionGeneration = 0;
  let bound = false;
  let currentConfig = store.load();
  if (!currentConfig) {
    const seed = normalizePublisherPublicKeyHex(options.seedPublisherPublicKeyHex ?? "");
    if (seed.ok && seed.value) currentConfig = store.bootstrapPublisherPublicKeyHex(seed.value);
  }
  currentConfig ??= { pricePublisherPublicKeyHex: "", savedAtMs: 0 };

  const state: InternalState = {
    channelId: currentConfig.pricePublisherPublicKeyHex
      ? bsvPriceChannel(parsePublicKey(currentConfig.pricePublisherPublicKeyHex))
      : NOT_CONFIGURED_LABEL,
    coreState: channel.isReady() ? "ready" : "offline",
    status: deriveInitialStatus(channel, currentConfig.pricePublisherPublicKeyHex),
    snapshot: null,
    lastError: null,
    subscriptionErrorCode: null,
    subscriptionErrorMessage: null,
    configured: currentConfig.pricePublisherPublicKeyHex.length > 0,
    configHex: currentConfig.pricePublisherPublicKeyHex
  };

  function emit(): void {
    for (const listener of listeners) {
      try { listener(); } catch { /* 一个 UI 订阅者不能影响业务真值。 */ }
    }
  }

  function updateRuntimeState(): void {
    state.coreState = channel.isReady() ? "ready" : "offline";
    if (!state.configured) state.status = "not_configured";
    else if (!channel.isReady()) state.status = "offline";
    else if (state.status === "offline") state.status = "sat_connecting";
  }

  function unbind(): void {
    offMessage?.();
    offMessage = null;
    offSubscriptionStatus?.();
    offSubscriptionStatus = null;
    subscriptionGeneration++;
  }

  function applySubscriptionStatus(status: ChannelSubscriptionStatus): void {
    if (!state.configured || status.channel !== state.channelId) return;
    state.subscriptionErrorCode = status.errorCode;
    state.subscriptionErrorMessage = status.errorMessage;
    state.status = deriveServiceStatus(channel, status, state.snapshot !== null);
    emit();
  }

  function bind(): void {
    bound = true;
    unbind();
    if (!state.configured) {
      state.channelId = NOT_CONFIGURED_LABEL;
      state.status = "not_configured";
      state.snapshot = null;
      state.lastError = null;
      state.subscriptionErrorCode = null;
      state.subscriptionErrorMessage = null;
      void channel.subscriptionSet([]).catch(() => undefined);
      emit();
      return;
    }
    state.channelId = bsvPriceChannel(parsePublicKey(state.configHex));
    state.snapshot = null;
    state.lastError = null;
    state.subscriptionErrorCode = null;
    state.subscriptionErrorMessage = null;
    updateRuntimeState();
    const generation = subscriptionGeneration;
    offSubscriptionStatus = channel.subscribeSubscriptionStatus((status) => {
      if (generation !== subscriptionGeneration || status.channel !== state.channelId) return;
      applySubscriptionStatus(status);
    });
    try {
      applySubscriptionStatus(channel.subscriptionStatus(state.channelId));
    } catch {
      if (channel.isReady()) state.status = "sat_connecting";
    }
    // 每个插件 caller 只有一套虚拟订阅；实际 SSP 订阅由 Coordinator mux 合并。
    void channel.subscriptionSet([state.channelId]).catch((error: unknown) => {
      if (generation !== subscriptionGeneration) return;
      const code = errorCodeFrom(error);
      state.subscriptionErrorCode = code;
      state.subscriptionErrorMessage = boundedMessage(error);
      state.status = code === "unavailable" || code === "connect" ? "offline" : "sat_subscription_error";
      emit();
    });
    offMessage = channel.subscribe((message) => {
      if (generation !== subscriptionGeneration || message.channel !== state.channelId) return;
      // ChannelProtocol 已完成签名解析，但“频道正确”不等于“发布者正确”。
      // 价格服务只接受配置 pin 的 publisher，防止同频道伪价格覆盖快照。
      if (message.publisherPublicKeyHex.trim().toLowerCase() !== state.configHex) return;
      const decoded = decodePriceContent(message.content);
      if (!decoded) {
        state.lastError = "invalid_body";
        emit();
        return;
      }
      if (state.snapshot && decoded.snapshotAtMs <= state.snapshot.snapshotAtMs) return;
      state.snapshot = decoded;
      state.lastError = null;
      state.status = "receiving";
      emit();
    });
    emit();
  }

  function applyConfig(next: BsvPriceGlobalConfig): void {
    currentConfig = next;
    state.configHex = next.pricePublisherPublicKeyHex;
    state.configured = state.configHex.length > 0;
    bind();
  }

  // A persistent store has not loaded its central truth before ready(). Do not
  // briefly subscribe using a deployment seed that a stored value may replace.
  // The explicit memory store is synchronous and can bind immediately.
  if (isExplicitMemoryStore) bind();

  const ready = store.ready().then(() => {
    const loaded = store.load();
    let nextConfig = loaded;
    if (!nextConfig) {
      const seed = normalizePublisherPublicKeyHex(options.seedPublisherPublicKeyHex ?? "");
      if (seed.ok && seed.value) nextConfig = store.bootstrapPublisherPublicKeyHex(seed.value);
    }
    nextConfig ??= { pricePublisherPublicKeyHex: "", savedAtMs: 0 };
    const unchanged = currentConfig?.pricePublisherPublicKeyHex === nextConfig.pricePublisherPublicKeyHex
      && currentConfig?.savedAtMs === nextConfig.savedAtMs;
    if (unchanged) {
      currentConfig = nextConfig;
      if (bound) updateRuntimeState();
      else bind();
    } else {
      applyConfig(nextConfig);
    }
  });

  return {
    ready: () => ready,
    snapshot: () => ({
      channelId: state.channelId,
      coreState: state.coreState,
      status: state.status,
      snapshot: cloneSnapshot(state.snapshot),
      lastError: state.lastError,
      subscriptionErrorCode: state.subscriptionErrorCode,
      subscriptionErrorMessage: state.subscriptionErrorMessage,
      configured: state.configured
    }),
    subscribe(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    currentMarkets: () => cloneMarkets(state.snapshot?.markets ?? null),
    getPublisherPublicKeyHex: () => state.configHex,
    configured: () => state.configured,
    async savePublisherPublicKeyHex(input) {
      const normalized = normalizePublisherPublicKeyHex(input);
      if (!normalized.ok || normalized.value === undefined) {
        throw new Error(normalized.error ?? "invalid_publisher_public_key_hex");
      }
      await ready;
      const saved = await store.savePublisherPublicKeyHex(normalized.value);
      applyConfig(saved);
    },
    dispose() {
      unbind();
      void channel.subscriptionSet([]).catch(() => undefined);
      listeners.clear();
    }
  };
}

const NOT_CONFIGURED_LABEL = "(not configured)";

interface InternalState {
  channelId: string;
  coreState: string;
  status: BsvPriceServiceStatus;
  snapshot: BsvPriceSnapshot | null;
  lastError: string | null;
  subscriptionErrorCode: ChannelSubscriptionErrorCode | null;
  subscriptionErrorMessage: string | null;
  configured: boolean;
  configHex: string;
}

function deriveInitialStatus(channel: ChannelRuntime, configHex: string): BsvPriceServiceStatus {
  if (!configHex) return "not_configured";
  return channel.isReady() ? "sat_connecting" : "offline";
}

function deriveServiceStatus(
  channel: ChannelRuntime,
  status: ChannelSubscriptionStatus,
  hasSnapshot: boolean,
): BsvPriceServiceStatus {
  if (!channel.isReady()) return "offline";
  if (status.phase === "blocked") {
    if (status.errorCode === "config") return "sat_not_configured";
    if (status.errorCode === "balance") return "sat_balance_required";
    if (status.errorCode === "identity") return "sat_identity_error";
    return "sat_subscription_error";
  }
  if (status.phase === "retrying") {
    if (status.errorCode === "unknown_result") return "subscription_unknown";
    return "sat_connecting";
  }
  if (status.phase === "subscribing") return "sat_connecting";
  if (status.phase === "subscribed") return hasSnapshot ? "receiving" : "waiting_snapshot";
  return "sat_connecting";
}

function isSubscriptionErrorCode(value: unknown): value is ChannelSubscriptionErrorCode {
  return value === "config" || value === "connect" || value === "identity" ||
    value === "protocol" || value === "balance" || value === "unknown_result" ||
    value === "validation" || value === "unavailable" || value === "conflict";
}

function errorCodeFrom(error: unknown): ChannelSubscriptionErrorCode {
  const value = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return isSubscriptionErrorCode(value) ? value : "unavailable";
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Subscription unavailable";
  const normalized = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized.length > 512 ? normalized.slice(0, 512) : normalized || "Subscription unavailable";
}

function cloneSnapshot(input: BsvPriceSnapshot | null): BsvPriceSnapshot | null {
  return input
    ? {
        protocol: input.protocol,
        snapshotAtMs: input.snapshotAtMs,
        markets: cloneMarkets(input.markets)
      }
    : null;
}

function cloneMarkets(
  input: Readonly<Record<string, Readonly<Record<string, string>>>> | null
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  if (!input) return {};
  const markets: Record<string, Record<string, string>> = {};
  for (const market of Object.keys(input)) {
    const quotes = input[market] ?? {};
    markets[market] = {};
    for (const pair of Object.keys(quotes)) {
      markets[market]![pair] = quotes[pair]!;
    }
  }
  return markets;
}
