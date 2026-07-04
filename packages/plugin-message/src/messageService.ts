// packages/plugin-message/src/messageService.ts
// 系统消息应用服务层：通过 `createSystemMessageClient(...)` 获取对系统消息
// 应用可见的 facade，对 plugin-appmsg 单例做 facade。

import type {
  AppMsgCore,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgOnlineResult,
  AppMsgOnlineStatus,
  AppMsgSimpleClient,
  AppMsgTargetSyncState
} from "@keymaster/contracts";

/**
 * 系统消息应用对外 service。
 *
 * 设计缘由（施工单 §4.5 / §5.4 + 反馈 §"必须修改"）：
 *   - 这是「查看 / 管理本地消息」的 service 层；UI 通过它读本地消息、
 *     同步状态、在线状态；
 *   - 走系统消息应用 facade（`keymaster.message`），**不**走 scoped
 *     facade；只能由 `AppMsgCore.createSystemMessageClient(...)` 产出；
 *   - **不**走远端 HubMsg 数量统计；
 *   - 写动作只有 triggerSync（手动刷新），其它写都走 `appmsg.core`
 *     内部（推送 / 增量同步）。
 */
export interface MessageService {
  /** 当前 owner 的本地消息库状态。 */
  getLocalDbSnapshot(): AppMsgLocalDbSnapshot;
  /** 列本地消息（系统消息应用可见的所有消息）。 */
  listLocalMessages(input?: {
    limit?: number;
    afterMessageId?: string;
  }): Promise<AppMsgMessage[]>;
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
 *
 * caller 通常是 plugin-message.setup(): 它已经在自身 manifest 上声明
 * `appMessageEndpoint.endpointId === "keymaster.message"`，经由
 * `AppMsgCore.createSystemMessageClient(...)` 校验通过后才允许产出
 * 这个 service。
 */
export function createMessageService(core: AppMsgCore): MessageService {
  // 关键：以"系统消息应用"身份构造 facade——sender 固定为当前 owner +
  // appId=keymaster.message；系统消息应用可以读全库。
  // 这里我们**不**传 owner，让 core 用自己的 owner；事实上
  // createSystemMessageClient 会在 owner 不匹配时抛错。
  const sysCli = createSystemClientForCurrentOwner(core);
  return {
    getLocalDbSnapshot: () => core.inspectLocalDb(),
    listLocalMessages: async (input) => {
      const res = await sysCli.listMessages(input);
      return res.items;
    },
    getLocalMessage: async (messageId) => sysCli.getMessage({ messageId }),
    listTargetSyncStates: () => core.listTargetSyncStates(),
    triggerSync: () => core.triggerSync(),
    checkOnline: (hexes) => core.checkOnline(hexes)
  };
}

/**
 * 构造系统消息应用 facade。
 *
 * 当前 owner 取自 `core.inspectLocalDb()`——caller 已经把 owner 绑好
 * 后再调用本工厂。如果 owner 尚未绑定，本工厂**不**主动 connect，由
 * caller 自行确保 `connectForOwner(...)` 已完成。
 */
function createSystemClientForCurrentOwner(core: AppMsgCore): AppMsgSimpleClient {
  // 关键：currentBoundOwner 已经是 caller 真实 owner；从 inspect 派生
  // 即可。
  const snap = core.inspectLocalDb();
  const owner = snap.ownerPublicKeyHex;
  if (!owner) {
    throw new Error(
      "MessageService: appmsg.core 当前未绑定 owner（vault 锁定或无 active key）"
    );
  }
  return core.createSystemMessageClient({ ownerPublicKeyHex: owner });
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
void ({} as AppMsgMessage);
void ({} as AppMsgTargetSyncState);
