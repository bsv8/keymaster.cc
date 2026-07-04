// packages/plugin-message/src/messageService.ts
// 消息业务插件 service 层（施工单 2026-07-03 002 硬切换）。
//
// 设计缘由：
//   - `plugin-message` 是一个**普通 scoped 消息插件**，appId =
//     `keymaster.message`；service 只封装 scoped client 的业务动作；
//   - sender 投影由 runtime 在 enable 阶段固化到注入的 scoped client
//     里；这里**不**再关心 sender / owner / endpoint；
//   - 不接触 `appmsg.core` 全库接口、不走 `createSystemMessageClient`
//     特权旁路；
//   - 管理 / 诊断方法（triggerSync / listTargetSyncStates /
//     checkOnline / getLocalDbSnapshot）**全部删除**——这些由
//     `plugin-appmsg` 的 HubMsg 管理页消费 `appmsg.core` 展示。

import type {
  AppMsgContentType,
  AppMsgMessage,
  AppMsgSimpleClient
} from "@keymaster/contracts";
import { KEYMASTER_MESSAGE_APP_ID } from "@keymaster/contracts";

/**
 * 消息业务插件对外 service。
 *
 * 最小职责：4 个方法，全部走 scoped client。
 *   - `listMessages`：列自己 scope 内的本地消息；
 *   - `getMessage`：读单条；scope 外返回 null；
 *   - `sendTextMessage`：发一条文本消息到 `recipientAppId =
 *     keymaster.message` 的对方；
 *   - `subscribeMessages`：订阅自己 scope 内的事件。
 *
 * 搜索**不**作为 service 暴露——UI 在拿到 list 后做本地字符串过滤。
 * 这是显式选择：不为"消息搜索"扩张 contract。
 */
export interface MessageService {
  /** scoped client 是否可用（runtime 注入 + 当前 vault 状态）。 */
  isReady(): boolean;
  /** 列本地消息（scoped）。 */
  listMessages(input?: { limit?: number; afterMessageId?: string }): Promise<AppMsgMessage[]>;
  /** 单条取本地消息；scope 外返回 null。 */
  getMessage(messageId: string): Promise<AppMsgMessage | null>;
  /**
   * 发一条 `recipientAppId = keymaster.message` 的文本消息。
   * `recipientAppId` 固定为 `keymaster.message`——这是 `plugin-message`
   * 的业务语义：对方也是这个 app 的用户。
   */
  sendTextMessage(input: {
    recipientPublicKeyHex: string;
    body: string;
    contentType?: AppMsgContentType;
    clientMessageId?: string;
  }): Promise<void>;
  /** 订阅自己 scope 内的完整消息事件。返回取消订阅函数。 */
  subscribeMessages(handler: (msg: AppMsgMessage) => void): () => void;
}

/**
 * 构造消息业务 service。
 *
 * 入参 `getClient`：每次调用时再解析 scoped client；返回 `null` 表示
 * scoped client 当前不可用（runtime 没注入 / sender 不存在）。
 *
 * 这样设计的好处：
 *   - vault 解锁 → owner 切换 → runtime 重新注入 scoped client，
 *     service **不**需要重新构造；
 *   - 当前未就绪时（vault locked / 无 owner）所有方法静默走降级：
 *     list/get 返回空态；send 抛 `not_ready`；subscribe 返回 noop 取消函数。
 */
export function createMessageService(
  getClient: () => AppMsgSimpleClient | null
): MessageService {
  return {
    isReady: () => getClient() !== null,
    listMessages: async (input) => {
      const cli = getClient();
      if (!cli) return [];
      const res = await cli.listMessages(input);
      return res.items;
    },
    getMessage: async (messageId) => {
      const cli = getClient();
      if (!cli) return null;
      return cli.getMessage({ messageId });
    },
    sendTextMessage: async (input) => {
      const cli = getClient();
      if (!cli) throw new Error("message.service: scoped appmsg.client not ready");
      await cli.sendMessage({
        recipientPublicKeyHex: input.recipientPublicKeyHex,
        recipientAppId: KEYMASTER_MESSAGE_APP_ID,
        contentType: input.contentType ?? "text/plain",
        body: input.body,
        clientMessageId: input.clientMessageId ?? makeClientMessageId(),
        createdAtMs: Date.now()
      });
    },
    subscribeMessages: (handler) => {
      const cli = getClient();
      if (!cli) return () => undefined;
      return cli.subscribeMessages(handler);
    }
  };
}

/** 生成客户端幂等键。 */
function makeClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `km-msg-${crypto.randomUUID()}`;
  }
  return `km-msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}