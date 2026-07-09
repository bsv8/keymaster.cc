// packages/plugin-bsv-price/src/bsvPriceService.ts
// BSV 价格广播业务 service（施工单 2026-07-08 001）。
//
// 设计缘由：
//   - 直接消费 `BroadcastCore`，**不**经 `appmsg` 中转；
//   - publisherPublicKeyHex 由 manifest 注入；空串 = "未配置" →
//     service 不挂任何订阅，页面持续空态；
//   - 校验 `protocolId === "pricecast.bsv_price.v1"`；否则忽略；
//   - 解析失败 / 非法字段：忽略本条 + 保留上一份合法快照（**不**抛）；
//   - 只接受 `createdAtMs >= currentSnapshot.receivedAtMs` 的快照；
//     更老的快照丢弃；
//   - **不**接触 provider handle / wire；
//   - **不**持久化当前快照（不建本地 DB）；
//   - 订阅 / 取消订阅由 service 内部代管；调用方用 `subscribe(handler)`
//     拿到 unsubscribe。

import type { BroadcastCore, BroadcastMessage } from "@keymaster/contracts";
import { PRICECAST_PROTOCOL_ID } from "./constants.js";
import { buildPriceChannelId } from "./constants.js";
import {
  decodePriceBody,
  type BsvPriceSnapshot
} from "./bsvPriceProtocol.js";

/** service 对外状态。 */
export type BsvPriceServiceStatus =
  | "idle"
  | "ready"
  | "offline"
  | "no_publisher_key"
  | "not_configured";

/** service 对外快照。 */
export interface BsvPriceServiceSnapshot {
  /** 本插件订阅的具体频道名（来自配置）；未配置时为 "(not configured)"。 */
  channelId: string;
  /**
   * 当前广播 core 状态。
   *
   * - `"connected"` = core 已 bound；
   * - `"connecting"` = 正在连；
   * - `"disconnected"` = 远端断开；
   * - `"not_ready"` = idle / 无 active provider / 无 owner。
   */
  coreState: string;
  /** service 自身状态。 */
  status: BsvPriceServiceStatus;
  /** 最近一次收到的合法快照；尚未收到时为 null。 */
  snapshot: BsvPriceSnapshot | null;
  /** 最近一次 body parse 错误 message；正常状态下为 null。 */
  lastError: string | null;
  /** publisher 公钥 hex 是否被显式提供（false = 空配置）。 */
  configured: boolean;
}

/** service 接口。 */
export interface BsvPriceService {
  /** 当前 service 快照。 */
  snapshot(): BsvPriceServiceSnapshot;
  /** 订阅 service 状态变化（snapshot 任意字段变化时触发）。 */
  subscribe(handler: () => void): () => void;
  /** 直接看当前快照里的报价列表（同步）。 */
  currentQuotes(): readonly { exchange: string; price: string }[];
}

/**
 * 创建 service。
 *
 * @param core 已就绪的 BroadcastCore。
 * @param publisherPublicKeyHex PriceCast publisher 公钥 hex。空串表示
 *   "未配置"——本 service 不在 core 上挂任何订阅，页面持续空态。
 *
 * 关键约束（施工单 §4.1.1 + §8.六）：
 *   - **不**接触 provider handle / wire 细节；
 *   - **不**自己发起 IO；只订阅 core 推送；
 *   - core 未就绪时返回的 snapshot.status = "idle"；handler 不被调；
 *   - core 远端断开 / reconnect：service 自己退到对应态；UI 可继续看到
 *     上次快照（如果之前有过）；
 *   - 空配置（publisherHex.length === 0）：
 *       - 不在 core 上调用 subscribe；
 *       - 页面 status = "not_configured"，提示部署侧未配置；
 *       - channelId 显示为 "(not configured)"。
 */
export function createBsvPriceService(
  core: BroadcastCore,
  publisherPublicKeyHex: string
): BsvPriceService {
  const channelId =
    publisherPublicKeyHex.length > 0
      ? buildPriceChannelId(publisherPublicKeyHex)
      : "";

  const localState: InternalState = {
    channelId: channelId || NOT_CONFIGURED_LABEL,
    snapshot: null,
    lastError: null,
    status: channelId
      ? deriveStatusFromCore(core)
      : "not_configured",
    coreState: core.inspect().state,
    configured: channelId.length > 0
  };
  const subscribers = new Set<() => void>();

  function emit(): void {
    for (const h of subscribers) {
      try {
        h();
      } catch {
        // ignore
      }
    }
  }

  // 配置缺失分支：不挂任何 core 订阅。空 channelId 不会再被错误使用。
  if (!channelId) {
    return {
      snapshot: () => ({ ...localState }),
      subscribe: (handler) => {
        subscribers.add(handler);
        return () => subscribers.delete(handler);
      },
      currentQuotes: () => []
    };
  }

  // 1) 订阅 core 推送：把 verify 过的广播 → 解析 → 更新 snapshot。
  const offMessage = core.subscribe({
    channelIds: [channelId],
    handler: (msg: BroadcastMessage) => handleIncoming(msg)
  });

  // 2) 订阅 core 状态变化：让 UI 拿到 connection 状态 / subscribed
  // union 变化。
  const offCoreState = core.onStateChange(() => {
    const i = core.inspect();
    localState.coreState = i.state;
    localState.status = deriveStatusFromCore(core);
    emit();
  });

  function handleIncoming(msg: BroadcastMessage): void {
    if (msg.protocolId !== PRICECAST_PROTOCOL_ID) return;
    if (msg.channelId !== channelId) return;
    const decoded = decodePriceBody(msg.bodyBytes, msg.createdAtMs);
    if (!decoded) {
      localState.lastError = "invalid_body";
      emit();
      return;
    }
    // 只接受新或同时间的快照
    if (
      localState.snapshot !== null &&
      decoded.receivedAtMs < localState.snapshot.receivedAtMs
    ) {
      return;
    }
    localState.snapshot = decoded;
    localState.lastError = null;
    emit();
  }

  const service: BsvPriceService = {
    snapshot: () => ({ ...localState }),
    subscribe: (handler) => {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    currentQuotes: () => localState.snapshot?.quotes ?? []
  };

  // cleanup 不内嵌（service 生命周期 = 浏览器 tab 生命周期）
  void offMessage;
  void offCoreState;

  return service;
}

const NOT_CONFIGURED_LABEL = "(not configured)";

interface InternalState {
  channelId: string;
  snapshot: BsvPriceSnapshot | null;
  lastError: string | null;
  status: BsvPriceServiceStatus;
  coreState: string;
  configured: boolean;
}

function deriveStatusFromCore(core: BroadcastCore): BsvPriceServiceStatus {
  const i = core.inspect();
  if (i.state === "bound") return "ready";
  if (i.state === "connecting") return "ready"; // 视作积极重建
  if (i.lastError === "no_active_provider") return "no_publisher_key";
  if (i.state === "closed") return "offline";
  return "idle";
}
