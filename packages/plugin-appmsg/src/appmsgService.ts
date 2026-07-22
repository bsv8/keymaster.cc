// packages/plugin-appmsg/src/appmsgService.ts
// AppMsg 管理页 service（施工单 2026-07-04 001 硬切换）。
//
// 设计缘由：
//   - AppMsg 管理页（`/system/appmsg`）直接消费 `appmsg.core` 的平台
//     internal 能力——`inspectLocalDb` / `listUnfilteredMessages` /
//     `subscribeUnfilteredMessages` / `triggerSync` / `listTargetSyncStates`
//     / `checkOnline`；这些方法在 contracts 上明确标记为"**仅** plugin-appmsg
//     管理面内部消费"，**不**被任何 plugin facade 包装；
//   - 本文件把上述能力聚合到 `createAppMsgService(core)`，让 UI 只关心
//     业务事件，不直接接触 capability key；
//   - 管理页还要展示当前 active provider（`providers().activeSnapshot()`）
//     + provider 列表（`providers().list()`）+ 切换 active provider
//     （`providers().setActive(...)`）——这些**仅**出现在管理页，**不**
//     影响业务页；
//   - 真值以**本地消息库**为准，远端数量 / origin 汇总不进本页面；
//   - 不为管理页扩张分页 / 协议 / 重试策略——见施工单 §6.6。

import type {
  ActiveMessageProviderSnapshot,
  AppMsgCore,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgOnlineInput,
  AppMsgOnlineResult,
  AppMsgTargetSyncState,
  MessageProvider,
  MessageProviderHealth,
  MessageProviderRegistry
} from "@keymaster/contracts";

/**
 * 管理页专用的 provider 原始健康快照。
 *
 * 这份数据不参与连接决策，只让排障页可以并排比较 core 的绑定状态和
 * provider 自己报告的连接状态。
 */
export interface AppMsgProviderDiagnostic {
  id: string;
  displayName: string;
  isActive: boolean;
  isHealthy: boolean;
  lastError: string | null;
  lastConnectedAtMs: number;
  healthProbeError: string | null;
}

/**
 * AppMsg 管理页 service：组织连接态 / 同步态 / 全库 / 在线查询 / 当前
 * active provider 五个区块所需的真值。
 */
export interface AppMsgService {
  /** 当前 active provider 快照。 */
  activeProviderSnapshot(): ActiveMessageProviderSnapshot;
  /** 已注册 provider 列表。 */
  listProviders(): readonly MessageProvider[];
  /** 读取每个已注册 provider 的原始健康快照；不发起网络请求。 */
  providerDiagnostics(): readonly AppMsgProviderDiagnostic[];
  /** 切换 active provider（用户主动选择）。 */
  setActiveProvider(providerId: string | null): Promise<void>;
  /** 拉取当前连接快照（来自 `appmsg.core.inspectLocalDb()`）。 */
  inspectLocalDb(): AppMsgLocalDbSnapshot;
  /** 拉取全库本地消息（admin 全库读；**仅** AppMsg 管理面使用）。 */
  listAllLocalMessages(input?: { limit?: number; afterMessageId?: string }): Promise<AppMsgMessage[]>;
  /** 拉取每个本地收件目标的同步状态。 */
  listTargetSyncStates(): Promise<AppMsgTargetSyncState[]>;
  /**
   * 触发一次手动同步。失败时**透出**错误，让 UI 的 `.catch(...)` 真正
   * 能进入"失败反馈"分支；service 不再吞错。
   */
  triggerSync(): Promise<void>;
  /** 批量查询在线状态。失败语义交给上层处理，不在此处额外吞错。 */
  checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult>;
}

/**
 * 构造 AppMsg 管理页 service。
 *
 * 失败语义：
 *   - `listTargetSyncStates` 失败时静默降级为空态；
 *   - `checkOnline` 只做薄转发，不在这里额外吞错；
 *   - `triggerSync` **透出**错误——手动同步是用户主动点击的动作，失败
 *     必须能被 UI 看见，否则用户点完毫无反馈（修复 issue 003）；
 *   - `setActiveProvider` 透出错误——provider 不存在 / 切换失败必须展示。
 */
export function createAppMsgService(core: AppMsgCore): AppMsgService {
  const providers = (): MessageProviderRegistry => core.providers();
  return {
    activeProviderSnapshot: () => core.activeProviderSnapshot(),
    listProviders: () => providers().list(),
    providerDiagnostics: () => {
      const activeId = providers().active()?.id ?? null;
      return providers().list().map((provider) => {
        let health: MessageProviderHealth;
        let healthProbeError: string | null = null;
        try {
          health = provider.health();
        } catch (err) {
          healthProbeError = err instanceof Error ? err.message : String(err);
          health = {
            isHealthy: false,
            lastError: "health probe failed",
            lastConnectedAtMs: 0
          };
        }
        return {
          id: provider.id,
          displayName: provider.displayName,
          isActive: provider.id === activeId,
          isHealthy: health.isHealthy,
          lastError: health.lastError,
          lastConnectedAtMs: health.lastConnectedAtMs,
          healthProbeError
        };
      });
    },
    setActiveProvider: async (id) => {
      await providers().setActive(id);
    },
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
    checkOnline: (input) => core.checkOnline(input)
  };
}
