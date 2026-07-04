// packages/plugin-appmsg/src/hubmsgService.ts
// HubMsg 管理页 service（施工单 2026-07-03 002 硬切换）。
//
// 设计缘由：
//   - HubMsg 管理页直接消费 `appmsg.core` 的平台 internal 能力——
//     `inspectLocalDb` / `listUnfilteredMessages` /
//     `subscribeUnfilteredMessages` / `triggerSync` / `listTargetSyncStates` /
//     `checkOnline`；这些方法在 contracts 上明确标记为"**仅** plugin-appmsg
//     管理面内部消费"，**不**被任何 plugin facade 包装；
//   - 本文件把上述能力聚合成"管理页 service"，让 UI 只关心业务事件。
//   - 真值以**本地消息库**为准，远端数量 / origin 汇总不进本页面。
//   - 不为管理页扩张分页 / 协议 / 重试策略——见施工单 §6.6。

import type {
  AppMsgCore,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgOnlineInput,
  AppMsgOnlineResult,
  AppMsgTargetSyncState
} from "@keymaster/contracts";

/**
 * HubMsg 管理页 service：组织连接态 / 同步态 / 全库 / 在线查询四个
 * 区块所需的真值。
 */
export interface HubMsgService {
  /** 拉取当前连接快照（来自 `appmsg.core.inspectLocalDb()`）。 */
  inspectLocalDb(): AppMsgLocalDbSnapshot;
  /** 拉取全库本地消息（admin 全库读；**仅** HubMsg 管理面使用）。 */
  listAllLocalMessages(input?: { limit?: number; afterMessageId?: string }): Promise<AppMsgMessage[]>;
  /** 拉取每个本地收件目标的同步状态。 */
  listTargetSyncStates(): Promise<AppMsgTargetSyncState[]>;
  /**
   * 触发一次手动同步。失败时**透出**错误，让 UI 的 `.catch(...)` 真正
   * 能进入"失败反馈"分支；service 不再吞错。
   */
  triggerSync(): Promise<void>;
  /** 批量查询在线状态。失败回退 `unknown`。 */
  checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult>;
}

/**
 * 构造 HubMsg 管理页 service。
 *
 * 失败语义：
 *   - `listTargetSyncStates` / `checkOnline` 失败时静默降级（空态 /
 *     `unknown`），管理页不展示失败原因；
 *   - `triggerSync` **透出**错误——手动同步是用户主动点击的动作，失败
 *     必须能被 UI 看见，否则用户点完毫无反馈（修复 issue 003）。
 */
export function createHubMsgService(core: AppMsgCore): HubMsgService {
  return {
    inspectLocalDb: () => core.inspectLocalDb(),
    listAllLocalMessages: async (input) => {
      const res = await core.listUnfilteredMessages(input);
      return res.items;
    },
    listTargetSyncStates: async () => {
      try {
        return await core.listTargetSyncStates();
      } catch {
        return [];
      }
    },
    triggerSync: () => core.triggerSync(),
    checkOnline: async (input) => {
      try {
        return await core.checkOnline(input);
      } catch {
        const out: AppMsgOnlineResult = {};
        for (const h of input) out[h] = "unknown";
        return out;
      }
    }
  };
}