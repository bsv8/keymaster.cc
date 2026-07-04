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
 *
 * **本文件是 `plugin-message` 的简化 facade**：故意不暴露 `hasMore`
 * 等分页状态——系统消息页不需要翻页。如未来真的要做分页，**不要**在
 * 这里逐步加 `hasMore` 字段，应当一次性升级 MessagePage + service
 * + 同步状态字段；半点改接口会重新把 contract 弄复杂。
 */
export interface MessageService {
  /** 当前 owner 的本地消息库状态。 */
  getLocalDbSnapshot(): AppMsgLocalDbSnapshot;
  /**
   * 列本地消息（系统消息应用可见的所有消息）。**不**返回分页信息——
   * 系统消息页用内部 slice 暂存就够了；如真有分页需求，单独升级此接口。
   */
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
 *
 * 关键约束：
 *   - **不能**在构造期强依赖 owner；web 首屏时 vault 可能尚未解锁，
 *     这属于正常未就绪状态，不应让 plugin setup 失败；
 *   - 因此 owner / system client 都改为"每次调用时再解析"；
 *   - 当前未绑定 owner 时：
 *       * list/get 返回空态；
 *       * triggerSync noop；
 *       * checkOnline 仍委托 core（其内部会回退 `unknown`）。
 */
export function createMessageService(core: AppMsgCore): MessageService {
  return {
    getLocalDbSnapshot: () => core.inspectLocalDb(),
    listLocalMessages: async (input) => {
      const sysCli = createSystemClientForCurrentOwner(core);
      if (!sysCli) return [];
      const res = await sysCli.listMessages(input);
      return res.items;
    },
    getLocalMessage: async (messageId) => {
      const sysCli = createSystemClientForCurrentOwner(core);
      if (!sysCli) return null;
      return sysCli.getMessage({ messageId });
    },
    listTargetSyncStates: async () => {
      if (!hasBoundOwner(core.inspectLocalDb())) return [];
      return core.listTargetSyncStates();
    },
    triggerSync: async () => {
      if (!hasBoundOwner(core.inspectLocalDb())) return;
      await core.triggerSync();
    },
    checkOnline: (hexes) => core.checkOnline(hexes)
  };
}

/**
 * 构造系统消息应用 facade。
 *
 * 当前 owner 取自 `core.inspectLocalDb()`——caller 已经把 owner 绑好
 * 后再调用本工厂。如果 owner 尚未绑定，本工厂返回 `null`：
 * 这是正常未就绪状态，不是 plugin setup 错误。
 */
function createSystemClientForCurrentOwner(core: AppMsgCore): AppMsgSimpleClient | null {
  const snap = core.inspectLocalDb();
  const owner = snap.ownerPublicKeyHex;
  if (!owner) return null;
  try {
    return core.createSystemMessageClient({ ownerPublicKeyHex: owner });
  } catch {
    return null;
  }
}

/** 当前是否已有可用 bound owner。 */
function hasBoundOwner(snap: AppMsgLocalDbSnapshot): boolean {
  return typeof snap.ownerPublicKeyHex === "string" && snap.ownerPublicKeyHex.length > 0;
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
