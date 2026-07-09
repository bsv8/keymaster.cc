// packages/plugin-bsv-price/src/bsvPriceService.ts
// BSV Price 业务 service（施工单 2026-07-08 002 硬切换）。
//
// 设计缘由：
//   - service 自己持有本地设置真值，不再把 manifest.config 当长期真值；
//   - 首次启动按 localStorage -> seed 的顺序决定运行时真值；
//   - 保存成功后立即重建订阅，避免页面和实际订阅不同步；
//   - 空配置是合法状态，意味着取消订阅并进入 not_configured；
//   - 只消费 `BroadcastCore`，不接触 provider / wire。

import type {
  BroadcastCore,
  BroadcastMessage,
  BroadcastUnsubscribe
} from "@keymaster/contracts";
import { PRICECAST_PROTOCOL_ID, buildPriceChannelId } from "./constants.js";
import { decodePriceBody, type BsvPriceSnapshot } from "./bsvPriceProtocol.js";
import {
  createLocalStorageBsvPriceSettingsStore,
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
  /** 当前订阅频道；未配置时为 "(not configured)"。 */
  channelId: string;
  /** 当前 core 状态。 */
  coreState: string;
  /** service 自身状态。 */
  status: BsvPriceServiceStatus;
  /** 最近一次收到的合法快照；尚未收到时为 null。 */
  snapshot: BsvPriceSnapshot | null;
  /** 最近一次 body parse 错误 message；正常状态下为 null。 */
  lastError: string | null;
  /** 当前是否已经有有效配置。 */
  configured: boolean;
}

/** service 接口。 */
export interface BsvPriceService {
  /** 当前 service 快照。 */
  snapshot(): BsvPriceServiceSnapshot;
  /** 订阅 service 状态变化。 */
  subscribe(handler: () => void): () => void;
  /** 直接看当前快照里的报价列表（同步）。 */
  currentQuotes(): readonly { exchange: string; price: string }[];
  /** 读取当前 publisher 公钥 hex；空串代表未配置。 */
  getPublisherPublicKeyHex(): string;
  /** 当前是否有有效配置。 */
  configured(): boolean;
  /** 保存新的 publisher 公钥 hex。空串表示清空配置。 */
  savePublisherPublicKeyHex(input: string): void;
  /** 释放 service 监听。 */
  dispose(): void;
}

export interface CreateBsvPriceServiceOptions {
  /** 运行时 seed；仅在本地配置不存在时使用。 */
  seedPublisherPublicKeyHex?: string;
  /** 注入 localStorage；测试可传 fake。 */
  localStorage?: Storage | null;
  /** 写入时间戳；测试可注入固定值。 */
  now?: () => number;
}

/**
 * 创建 BSV Price 业务 service。
 *
 * 设计缘由：
 *   - runtime 真值由 localStorage 承担；`seedPublisherPublicKeyHex` 只在首次
 *     启动、且本地没有配置时兜底一次；
 *   - 保存流程先写本地配置，再重建订阅，再通知 UI；
 *   - service 生命周期跟随浏览器 tab，不做复杂重试和后台任务。
 */
export function createBsvPriceService(
  core: BroadcastCore,
  options: CreateBsvPriceServiceOptions = {}
): BsvPriceService {
  const store = createLocalStorageBsvPriceSettingsStore(
    options.localStorage ?? getDefaultLocalStorage(),
    options.now
  );
  const subscribers = new Set<() => void>();
  let offMessage: BroadcastUnsubscribe | null = null;
  let offCoreState: BroadcastUnsubscribe | null = core.onStateChange(() => {
    updateCoreState();
    emit();
  });
  let subscriptionGeneration = 0;

  let currentConfig = store.load();
  if (!currentConfig) {
    const seed = normalizePublisherPublicKeyHex(options.seedPublisherPublicKeyHex ?? "");
    if (seed.ok && seed.value !== undefined && seed.value.length > 0) {
      currentConfig = store.bootstrapPublisherPublicKeyHex(seed.value);
    }
  }
  if (!currentConfig) {
    currentConfig = {
      pricePublisherPublicKeyHex: "",
      savedAtMs: 0
    };
  }

  const localState: InternalState = {
    channelId: currentConfig.pricePublisherPublicKeyHex
      ? buildPriceChannelId(currentConfig.pricePublisherPublicKeyHex)
      : NOT_CONFIGURED_LABEL,
    coreState: core.inspect().state,
    status: deriveStatusFromCore(core, currentConfig.pricePublisherPublicKeyHex),
    snapshot: null,
    lastError: null,
    configured: currentConfig.pricePublisherPublicKeyHex.length > 0,
    configHex: currentConfig.pricePublisherPublicKeyHex
  };

  function emit(): void {
    for (const handler of subscribers) {
      try {
        handler();
      } catch {
        // 订阅者异常不应影响 service 真值。
      }
    }
  }

  function updateCoreState(): void {
    localState.coreState = core.inspect().state;
    localState.status = deriveStatusFromCore(core, localState.configured ? localState.configHex : "");
  }

  function clearSnapshot(): void {
    localState.snapshot = null;
    localState.lastError = null;
  }

  function unbindCurrentSubscription(): void {
    if (offMessage) {
      offMessage();
      offMessage = null;
    }
  }

  function bindForCurrentConfig(): void {
    unbindCurrentSubscription();
    const generation = ++subscriptionGeneration;
    if (!localState.configured) {
      localState.channelId = NOT_CONFIGURED_LABEL;
      localState.status = "not_configured";
      clearSnapshot();
      updateCoreState();
      emit();
      return;
    }

    localState.channelId = buildPriceChannelId(localState.configHex);
    clearSnapshot();
    localState.status = deriveStatusFromCore(core, localState.configHex);

    offMessage = core.subscribe({
      channelIds: [localState.channelId],
      handler: (msg: BroadcastMessage) => {
        if (generation !== subscriptionGeneration) return;
        handleIncoming(msg);
      }
    });
    updateCoreState();
    emit();
  }

  function applyConfig(next: BsvPriceGlobalConfig): void {
    currentConfig = {
      pricePublisherPublicKeyHex: next.pricePublisherPublicKeyHex,
      savedAtMs: next.savedAtMs
    };
    localState.configHex = next.pricePublisherPublicKeyHex;
    localState.configured = next.pricePublisherPublicKeyHex.length > 0;
    localState.status = localState.configured
      ? deriveStatusFromCore(core, localState.configHex)
      : "not_configured";
    bindForCurrentConfig();
  }

  function handleIncoming(msg: BroadcastMessage): void {
    if (msg.protocolId !== PRICECAST_PROTOCOL_ID) return;
    if (msg.channelId !== localState.channelId) return;
    const decoded = decodePriceBody(msg.bodyBytes, msg.createdAtMs);
    if (!decoded) {
      localState.lastError = "invalid_body";
      emit();
      return;
    }
    if (
      localState.snapshot !== null &&
      decoded.receivedAtMs < localState.snapshot.receivedAtMs
    ) {
      return;
    }
    localState.snapshot = cloneSnapshot(decoded);
    localState.lastError = null;
    emit();
  }

  function savePublisherPublicKeyHex(input: string): void {
    const normalized = normalizePublisherPublicKeyHex(input);
    if (!normalized.ok || normalized.value === undefined) {
      throw new Error(normalized.error ?? "invalid_publisher_public_key_hex");
    }
    const saved = store.savePublisherPublicKeyHex(normalized.value);
    applyConfig(saved);
  }

  function getPublisherPublicKeyHex(): string {
    return localState.configHex;
  }

  function configured(): boolean {
    return localState.configured;
  }

  function snapshot(): BsvPriceServiceSnapshot {
    return {
      channelId: localState.channelId,
      coreState: localState.coreState,
      status: localState.status,
      snapshot: cloneSnapshot(localState.snapshot),
      lastError: localState.lastError,
      configured: localState.configured
    };
  }

  function currentQuotes(): readonly { exchange: string; price: string }[] {
    return localState.snapshot?.quotes.map((q) => ({
      exchange: q.exchange,
      price: q.price
    })) ?? [];
  }

  function dispose(): void {
    unbindCurrentSubscription();
    if (offCoreState) {
      offCoreState();
      offCoreState = null;
    }
    subscribers.clear();
  }

  // 进入 service 生命周期后立刻建立首轮订阅。
  bindForCurrentConfig();

  return {
    snapshot,
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    currentQuotes,
    getPublisherPublicKeyHex,
    configured,
    savePublisherPublicKeyHex,
    dispose
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

function deriveStatusFromCore(
  core: BroadcastCore,
  configHex: string
): BsvPriceServiceStatus {
  if (configHex.length === 0) return "not_configured";
  const snap = core.inspect();
  if (snap.state === "bound") return "ready";
  if (snap.state === "connecting") return "ready";
  if (snap.state === "closed") return "offline";
  if (snap.lastError === "no_active_provider") return "no_publisher_key";
  return "idle";
}

function cloneSnapshot(input: BsvPriceSnapshot | null): BsvPriceSnapshot | null {
  if (!input) return null;
  return {
    receivedAtMs: input.receivedAtMs,
    quotes: input.quotes.map((q) => ({
      exchange: q.exchange,
      price: q.price
    }))
  };
}

function getDefaultLocalStorage(): Storage | null {
  if (typeof globalThis === "undefined") return null;
  const g = globalThis as { localStorage?: Storage };
  return typeof g.localStorage === "undefined" ? null : g.localStorage;
}
