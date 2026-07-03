// packages/plugin-message/src/messageService.ts
// 系统消息应用服务层：纯函数化壳，对 plugin-appmsg 单例做 facade。

import type {
  AppMsgCore,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgOnlineResult,
  AppMsgOnlineStatus,
  AppMsgTargetSyncState
} from "@keymaster/contracts";

/**
 * 系统消息应用对外 service。
 *
 * 设计缘由（施工单 §4.5 / §5.4）：
 *   - 这是「查看 / 管理本地消息」的 service 层；UI 通过它读本地消息、
 *     同步状态、在线状态；
 *   - **不**走远端 HubMsg 数量统计；
 *   - 写动作只有 triggerSync（手动刷新），其它写都走 `appmsg.core`
 *     内部（推送 / 增量同步）。
 */
export interface MessageService {
  /** 当前 owner 的本地消息库状态。 */
  getLocalDbSnapshot(): AppMsgLocalDbSnapshot;
  /** 列本地消息（同步当前 owner 的所有消息；过滤生效要看 core 实现）。 */
  listLocalMessages(input?: { limit?: number; afterMessageId?: string }): Promise<AppMsgMessage[]>;
  /** 单条取本地消息。 */
  getLocalMessage(messageId: string): Promise<AppMsgMessage | null>;
  /** 列出本地目标同步状态。 */
  listTargetSyncStates(): Promise<AppMsgTargetSyncState[]>;
  /** 触发一次手动同步（best-effort）。 */
  triggerSync(): Promise<void>;
  /** 批量查在线状态。失败整体回退 `unknown`。 */
  checkOnline(publicKeyHexes: string[]): Promise<AppMsgOnlineResult>;
}

/**
 * 构造系统消息应用 service。
 */
export function createMessageService(core: AppMsgCore): MessageService {
  return {
    getLocalDbSnapshot: () => core.inspectLocalDb(),
    listLocalMessages: async (input) => {
      const res = await core.listLocalMessages(input);
      return res.items;
    },
    getLocalMessage: async (messageId) => core.getLocalMessage({ messageId }),
    listTargetSyncStates: () => core.listTargetSyncStates(),
    triggerSync: () => core.triggerSync(),
    checkOnline: (hexes) => core.checkOnline(hexes)
  };
}

/** 系统消息应用 appId（固定字符串）。 */
export const SYSTEM_MESSAGE_APP_ID = "keymaster.message";

/** 当查询失败时给所有候选 key 回退状态。 */
export function onlineFallback(hexes: string[]): AppMsgOnlineResult {
  const out: AppMsgOnlineResult = {};
  for (const h of hexes) {
    out[h] = "unknown";
  }
  return out;
}

/** 在线状态展示用文案（系统消息应用 UI 使用）。 */
export function onlineStatusLabel(s: AppMsgOnlineStatus): "online" | "offline" | "unknown" {
  return s;
}

// 防止 IDE 报 unused
void 0;
