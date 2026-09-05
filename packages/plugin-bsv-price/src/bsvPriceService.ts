// BSV 价格业务 service。
//
// 价格订阅是普通 Channel 公共消息：插件只知道精确频道和自己的业务内容，
// 不接触 Supplier、SSP Wire、签名壳或远端历史。

import type { ChannelRuntime, KeyValueStore } from "@keymaster/contracts";
import { buildPriceChannelId } from "./constants.js";
import { decodePriceContent, type BsvPriceSnapshot } from "./bsvPriceProtocol.js";
import {
  createKeyValueBsvPriceSettingsStore,
  normalizePublisherPublicKeyHex,
  type BsvPriceGlobalConfig
} from "./bsvPriceSettings.js";

/** service 对外状态。 */
export type BsvPriceServiceStatus =
  | "idle"
  | "ready"
  | "offline"
  | "no_publisher_key"
  | "not_configured";

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
  /** 当前是否有有效 publisher 配置。 */
  configured: boolean;
}

/** service 接口。 */
export interface BsvPriceService {
  snapshot(): BsvPriceServiceSnapshot;
  subscribe(handler: () => void): () => void;
  currentQuotes(): readonly { exchange: string; price: string }[];
  getPublisherPublicKeyHex(): string;
  configured(): boolean;
  savePublisherPublicKeyHex(input: string): void;
  dispose(): void;
}

export interface CreateBsvPriceServiceOptions {
  /** 首次启动时使用的配置种子。 */
  seedPublisherPublicKeyHex?: string;
  /** Host 绑定的 BSV Price owner/App K-V 句柄。 */
  storage?: KeyValueStore;
  /** 测试可注入时钟。 */
  now?: () => number;
}

export function createBsvPriceService(
  channel: ChannelRuntime,
  options: CreateBsvPriceServiceOptions = {}
): BsvPriceService & { ready(): Promise<void> } {
  const store = createKeyValueBsvPriceSettingsStore(options.storage, options.now);
  const listeners = new Set<() => void>();
  let offMessage: (() => void) | null = null;
  let subscriptionGeneration = 0;
  let currentConfig = store.load();
  if (!currentConfig && !options.storage) {
    const seed = normalizePublisherPublicKeyHex(options.seedPublisherPublicKeyHex ?? "");
    if (seed.ok && seed.value) currentConfig = store.bootstrapPublisherPublicKeyHex(seed.value);
  }
  currentConfig ??= { pricePublisherPublicKeyHex: "", savedAtMs: 0 };

  const state: InternalState = {
    channelId: currentConfig.pricePublisherPublicKeyHex
      ? buildPriceChannelId(currentConfig.pricePublisherPublicKeyHex)
      : NOT_CONFIGURED_LABEL,
    coreState: channel.isReady() ? "ready" : "offline",
    status: deriveStatus(channel, currentConfig.pricePublisherPublicKeyHex),
    snapshot: null,
    lastError: null,
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
    state.status = deriveStatus(channel, state.configured ? state.configHex : "");
  }

  function unbind(): void {
    offMessage?.();
    offMessage = null;
    subscriptionGeneration++;
  }

  function bind(): void {
    unbind();
    if (!state.configured) {
      state.channelId = NOT_CONFIGURED_LABEL;
      state.status = "not_configured";
      state.snapshot = null;
      state.lastError = null;
      emit();
      return;
    }
    state.channelId = buildPriceChannelId(state.configHex);
    state.snapshot = null;
    state.lastError = null;
    updateRuntimeState();
    const generation = subscriptionGeneration;
    // 每个插件 caller 只有一套虚拟订阅；实际 SSP 订阅由 Coordinator mux 合并。
    void channel.subscriptionSet([state.channelId]).catch((error: unknown) => {
      if (generation !== subscriptionGeneration) return;
      state.status = "offline";
      state.lastError = error instanceof Error ? error.message : String(error);
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
      if (state.snapshot && decoded.receivedAtMs < state.snapshot.receivedAtMs) return;
      state.snapshot = decoded;
      state.lastError = null;
      state.status = "ready";
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

  bind();

  const ready = store.ready().then(() => {
    currentConfig = store.load();
    if (!currentConfig) {
      const seed = normalizePublisherPublicKeyHex(options.seedPublisherPublicKeyHex ?? "");
      if (seed.ok && seed.value) currentConfig = store.bootstrapPublisherPublicKeyHex(seed.value);
    }
    currentConfig ??= { pricePublisherPublicKeyHex: "", savedAtMs: 0 };
    applyConfig(currentConfig);
  });

  return {
    ready: () => ready,
    snapshot: () => ({
      channelId: state.channelId,
      coreState: state.coreState,
      status: state.status,
      snapshot: cloneSnapshot(state.snapshot),
      lastError: state.lastError,
      configured: state.configured
    }),
    subscribe(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    currentQuotes: () => state.snapshot?.quotes.map((quote) => ({ ...quote })) ?? [],
    getPublisherPublicKeyHex: () => state.configHex,
    configured: () => state.configured,
    savePublisherPublicKeyHex(input) {
      const normalized = normalizePublisherPublicKeyHex(input);
      if (!normalized.ok || normalized.value === undefined) {
        throw new Error(normalized.error ?? "invalid_publisher_public_key_hex");
      }
      applyConfig(store.savePublisherPublicKeyHex(normalized.value));
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
  configured: boolean;
  configHex: string;
}

function deriveStatus(channel: ChannelRuntime, configHex: string): BsvPriceServiceStatus {
  if (!configHex) return "not_configured";
  return channel.isReady() ? "ready" : "offline";
}

function cloneSnapshot(input: BsvPriceSnapshot | null): BsvPriceSnapshot | null {
  return input
    ? { receivedAtMs: input.receivedAtMs, quotes: input.quotes.map((quote) => ({ ...quote })) }
    : null;
}
