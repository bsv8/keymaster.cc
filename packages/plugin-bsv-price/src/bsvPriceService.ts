// BSV 价格业务 service。
//
// 价格订阅是普通 Channel 公共消息：插件只知道精确频道和自己的业务内容，
// 不接触 Supplier、SSP Wire、签名壳或远端历史。
//
// 设计缘由：
//   - 设置里可以登记多个价格发布服务器，但只订阅「当前激活服务器」的频道；
//   - 激活交易对只改变展示选择，不触发重新订阅；
//   - 对外价格语义只有金额 + 单位；未就绪时金额恒为 "0.00"；
//   - `get` 是一次获取，`subscribe` 变化推送；订阅出错只记录在 snapshot 里，
//     展示侧不需要错误分支。

import type {
  BorrowedKeyValueStore,
  BsvPriceReader,
  ChannelRuntime,
  ChannelSubscriptionErrorCode,
  ChannelSubscriptionStatus,
  PriceValue
} from "@keymaster/contracts";
import { parsePublicKey } from "bsv8-channel-protocol";
import { bsvPriceChannel } from "bsv8-channel-protocol/bsv-price";
import {
  decodePriceContent,
  formatPriceAmount,
  PRICE_DISPLAY_ZERO,
  selectMarketPrice,
  type BsvPriceSnapshot
} from "./bsvPriceProtocol.js";
import {
  createDefaultBsvPriceConfig,
  createKeyValueBsvPriceSettingsStore,
  deriveUnitFromPair,
  normalizeMarketIdentifier,
  normalizePublisherPublicKeyHex,
  normalizeServerName,
  type BsvPriceActiveOption,
  type BsvPriceGlobalConfig,
  type BsvPriceServerConfig,
  type BsvPriceSettingsStore
} from "./bsvPriceSettings.js";
import {
  DEFAULT_PRICE_MARKET,
  DEFAULT_PRICE_PAIR,
  DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX
} from "./constants.js";

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

/**
 * service 对外快照。
 *
 * 设计缘由：`/bsv-price` 与设置页需要看到订阅的全部信息；首页和资产页
 * 只需要 `price`。
 */
export interface BsvPriceServiceSnapshot {
  /** 当前精确订阅频道；无激活服务器时为占位文字。 */
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
  /** 当前是否有有效激活服务器配置。 */
  configured: boolean;
  /** 已登记的候选服务器列表。 */
  servers: BsvPriceServerConfig[];
  /** 当前激活的供应商-交易所-交易对。 */
  active: BsvPriceActiveOption;
  /** 展示价格（金额 + 单位）；未就绪时 amount "0.00"。 */
  price: PriceValue;
}

/**
 * service 接口。
 *
 * 继承 `BsvPriceReader`：同一实例同时以 `bsv-price.reader` 提供给
 * 首页 / 资产页 / Connect 读取展示价，以 `bsv-price.service` 提供给
 * 本插件的设置页与业务页。
 */
export interface BsvPriceService extends BsvPriceReader {
  /** 完整订阅信息快照。 */
  snapshot(): BsvPriceServiceSnapshot;
  /** 当前设置的副本。 */
  getConfig(): BsvPriceGlobalConfig;
  /** 追加一个价格发布服务器；公钥重复时抛 `server_exists`。 */
  addServer(input: { name: string; publisherPublicKeyHex: string }): Promise<BsvPriceGlobalConfig>;
  /** 删除一个服务器；默认服务器或最后一个服务器不允许删除。 */
  removeServer(publisherPublicKeyHex: string): Promise<BsvPriceGlobalConfig>;
  /** 切换激活的供应商-交易所-交易对。 */
  setActiveOption(input: BsvPriceActiveOption): Promise<BsvPriceGlobalConfig>;
  /** 恢复原始设置：唯一默认 bsv8 服务器 + 默认交易对。 */
  restoreOriginalSettings(): Promise<BsvPriceGlobalConfig>;
  dispose(): void;
}

export interface CreateBsvPriceServicePersistentOptions {
  /** 首次启动时使用的配置种子公钥。 */
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
  const now = options.now ?? (() => Date.now());
  const store = "settingsStore" in options
    ? options.settingsStore
    : createKeyValueBsvPriceSettingsStore(options.storage, options.now);
  const isExplicitMemoryStore = "settingsStore" in options;
  const listeners = new Set<(price: PriceValue) => void>();
  let offMessage: (() => void) | null = null;
  let offSubscriptionStatus: (() => void) | null = null;
  let subscriptionGeneration = 0;
  let bound = false;
  const seed = normalizePublisherPublicKeyHex(options.seedPublisherPublicKeyHex ?? "");
  const seedPublisherPublicKeyHex =
    seed.ok && seed.value ? seed.value : DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX;
  let currentConfig: BsvPriceGlobalConfig =
    store.load() ?? createDefaultBsvPriceConfig(seedPublisherPublicKeyHex, now);

  const state: InternalState = {
    channelId: NOT_CONFIGURED_LABEL,
    coreState: channel.isReady() ? "ready" : "offline",
    status: "not_configured",
    snapshot: null,
    lastError: null,
    subscriptionErrorCode: null,
    subscriptionErrorMessage: null,
    configured: false,
    config: currentConfig
  };
  refreshStateFromConfig();

  function emit(): void {
    const price = currentPrice();
    for (const listener of listeners) {
      try { listener(price); } catch { /* 一个 UI 订阅者不能影响业务真值。 */ }
    }
  }

  function activeServer(): BsvPriceServerConfig | null {
    return findServer(state.config, state.config.active.publisherPublicKeyHex);
  }

  function refreshStateFromConfig(): void {
    const server = activeServer();
    state.configured = server !== null;
    state.channelId = server
      ? bsvPriceChannel(parsePublicKey(server.publisherPublicKeyHex))
      : NOT_CONFIGURED_LABEL;
    state.status = deriveInitialStatus(channel, server);
  }

  function updateRuntimeState(): void {
    state.coreState = channel.isReady() ? "ready" : "offline";
    if (!state.configured) state.status = "not_configured";
    else if (!channel.isReady()) state.status = "offline";
    else if (state.status === "offline" || state.status === "not_configured") {
      state.status = "sat_connecting";
    }
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
    const server = activeServer();
    state.configured = server !== null;
    state.channelId = server
      ? bsvPriceChannel(parsePublicKey(server.publisherPublicKeyHex))
      : NOT_CONFIGURED_LABEL;
    if (!state.configured) {
      state.snapshot = null;
      state.lastError = null;
      state.subscriptionErrorCode = null;
      state.subscriptionErrorMessage = null;
      state.status = "not_configured";
      void channel.subscriptionSet([]).catch(() => undefined);
      emit();
      return;
    }
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
      // 价格服务只接受激活服务器 pin 的 publisher，防止同频道伪价格覆盖快照。
      const server = activeServer();
      if (!server) return;
      if (message.publisherPublicKeyHex.trim().toLowerCase() !== server.publisherPublicKeyHex) return;
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
    const previous = activeServer();
    currentConfig = next;
    state.config = next;
    const server = activeServer();
    state.configured = server !== null;
    if (!bound || previous?.publisherPublicKeyHex !== server?.publisherPublicKeyHex) {
      bind();
      return;
    }
    // 同一个服务器只换交易对：不重订阅，快照继续有效。
    updateRuntimeState();
    emit();
  }

  function currentPrice(): PriceValue {
    const server = activeServer();
    const unit = deriveUnitFromPair(state.config.active.pair);
    if (!server || !state.snapshot) return { amount: PRICE_DISPLAY_ZERO, unit, updatedAtMs: 0 };
    const raw = selectMarketPrice(state.snapshot, state.config.active.market, state.config.active.pair);
    if (raw === null) return { amount: PRICE_DISPLAY_ZERO, unit, updatedAtMs: 0 };
    return {
      amount: formatPriceAmount(raw),
      unit,
      updatedAtMs: state.snapshot.snapshotAtMs
    };
  }

  async function save(next: BsvPriceGlobalConfig): Promise<BsvPriceGlobalConfig> {
    await ready;
    const saved = await store.saveConfig(next);
    applyConfig(saved);
    return cloneConfig(saved);
  }

  function candidate(overrides: Partial<BsvPriceGlobalConfig>): BsvPriceGlobalConfig {
    return {
      servers: overrides.servers ?? currentConfig.servers.map((server) => ({ ...server })),
      active: overrides.active ?? { ...currentConfig.active },
      savedAtMs: 0
    };
  }

  // A persistent store has not loaded its central truth before ready(). Do not
  // briefly subscribe using a deployment seed that a stored value may replace.
  // The explicit memory store is synchronous and can bind immediately.
  if (isExplicitMemoryStore) bind();

  const ready = store.ready().then(() => {
    const loaded = store.load();
    const nextConfig = loaded ?? store.bootstrapConfig(
      createDefaultBsvPriceConfig(seedPublisherPublicKeyHex, now)
    );
    const unchanged =
      currentConfig.servers.length === nextConfig.servers.length &&
      currentConfig.servers.every(
        (server, index) =>
          server.publisherPublicKeyHex === nextConfig.servers[index]?.publisherPublicKeyHex &&
          server.name === nextConfig.servers[index]?.name
      ) &&
      currentConfig.active.publisherPublicKeyHex === nextConfig.active.publisherPublicKeyHex &&
      currentConfig.active.market === nextConfig.active.market &&
      currentConfig.active.pair === nextConfig.active.pair;
    if (unchanged) {
      currentConfig = nextConfig;
      state.config = nextConfig;
      if (bound) updateRuntimeState();
      else bind();
      emit();
    } else {
      applyConfig(nextConfig);
    }
  });

  return {
    ready: () => ready,
    get: () => currentPrice(),
    subscribe(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    snapshot: () => ({
      channelId: state.channelId,
      coreState: state.coreState,
      status: state.status,
      snapshot: cloneSnapshot(state.snapshot),
      lastError: state.lastError,
      subscriptionErrorCode: state.subscriptionErrorCode,
      subscriptionErrorMessage: state.subscriptionErrorMessage,
      configured: state.configured,
      servers: state.config.servers.map((server) => ({ ...server })),
      active: { ...state.config.active },
      price: currentPrice()
    }),
    getConfig: () => cloneConfig(currentConfig),
    async addServer(input) {
      const name = normalizeServerName(input.name);
      if (!name.ok || name.value === undefined) throw new Error(name.error ?? "invalid_server_name");
      const key = normalizePublisherPublicKeyHex(input.publisherPublicKeyHex);
      if (!key.ok || key.value === undefined) {
        throw new Error(key.error ?? "invalid_publisher_public_key_hex");
      }
      await ready;
      if (currentConfig.servers.some((server) => server.publisherPublicKeyHex === key.value)) {
        throw new Error("server_exists");
      }
      return save(candidate({
        servers: [...currentConfig.servers.map((server) => ({ ...server })), {
          name: name.value,
          publisherPublicKeyHex: key.value
        }]
      }));
    },
    async removeServer(publisherPublicKeyHex) {
      const key = normalizePublisherPublicKeyHex(publisherPublicKeyHex);
      if (!key.ok || key.value === undefined) {
        throw new Error(key.error ?? "invalid_publisher_public_key_hex");
      }
      await ready;
      if (key.value === DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX) {
        throw new Error("default_server_required");
      }
      const servers = currentConfig.servers
        .filter((server) => server.publisherPublicKeyHex !== key.value)
        .map((server) => ({ ...server }));
      if (servers.length === currentConfig.servers.length) throw new Error("server_not_found");
      if (servers.length === 0) throw new Error("last_server_required");
      const active = servers.some(
        (server) => server.publisherPublicKeyHex === currentConfig.active.publisherPublicKeyHex
      )
        ? { ...currentConfig.active }
        : {
            publisherPublicKeyHex: servers[0]!.publisherPublicKeyHex,
            market: DEFAULT_PRICE_MARKET,
            pair: DEFAULT_PRICE_PAIR
          };
      return save({ servers, active, savedAtMs: 0 });
    },
    async setActiveOption(input) {
      const key = normalizePublisherPublicKeyHex(input.publisherPublicKeyHex);
      if (!key.ok || key.value === undefined) {
        throw new Error(key.error ?? "invalid_publisher_public_key_hex");
      }
      const market = normalizeMarketIdentifier(input.market);
      if (!market.ok || market.value === undefined) {
        throw new Error(market.error ?? "invalid_market");
      }
      const pair = normalizeMarketIdentifier(input.pair);
      if (!pair.ok || pair.value === undefined) {
        throw new Error(pair.error ?? "invalid_pair");
      }
      await ready;
      if (!currentConfig.servers.some((server) => server.publisherPublicKeyHex === key.value)) {
        throw new Error("server_not_found");
      }
      return save(candidate({
        active: { publisherPublicKeyHex: key.value, market: market.value, pair: pair.value }
      }));
    },
    async restoreOriginalSettings() {
      await ready;
      return save(createDefaultBsvPriceConfig(DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX, now));
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
  config: BsvPriceGlobalConfig;
}

function findServer(config: BsvPriceGlobalConfig, key: string): BsvPriceServerConfig | null {
  return config.servers.find((server) => server.publisherPublicKeyHex === key) ?? null;
}

function deriveInitialStatus(
  channel: ChannelRuntime,
  server: BsvPriceServerConfig | null
): BsvPriceServiceStatus {
  if (!server) return "not_configured";
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

function cloneConfig(input: BsvPriceGlobalConfig): BsvPriceGlobalConfig {
  return {
    servers: input.servers.map((server) => ({ ...server })),
    active: { ...input.active },
    savedAtMs: input.savedAtMs
  };
}
