// packages/plugin-message/src/messageService.ts
// 消息业务插件 service 层（施工单 2026-07-04 001 硬切换）。
//
// 设计缘由：
//   - `plugin-message` 是一个**极薄业务插件**，appId =
//     `keymaster.message`；
//   - service 直接消费由 plugin-appmsg 通过 `appmsg.endpoint.registry` 给
//     出的稳定长寿 `AppMsgEndpointService`——它内部已经自动处理 owner
//     真值 / active provider 切换；
//   - **不**订阅 keyspace / vault / provider；
//   - **不**暴露 `subscriptionSource()` 之类"subscription token"——
//     endpoint service 内部自动迁移订阅；
//   - 当前未就绪时（vault locked / 无 active key / 无 active provider）
//     走降级：list/get 返回空态；send 抛 `not_ready`；subscribe 返回
//     noop 取消函数；
//   - 不接触 `appmsg.core` 全库接口；走 endpoint service 的稳定 5 方法。

import type {
  AppMsgContentType,
  AppMsgEndpointService,
  AppMsgMessage
} from "@keymaster/contracts";
import { KEYMASTER_MESSAGE_APP_ID } from "@keymaster/contracts";

/**
 * 消息业务插件对外 service。
 *
 * 最小职责：消息读写、实时消息订阅与本地历史变化订阅，全部走稳定长寿 endpoint service。
 *   - `listMessages`：列自己 scope 内的本地消息；
 *   - `getMessage`：读单条；scope 外返回 null；
 *   - `sendTextMessage`：发一条文本消息到 `recipientAppId =
 *     keymaster.message` 的对方；
 *   - `subscribeMessages`：订阅自己 scope 内的事件；endpoint service
 *     内部已自动迁移订阅——上层 React effect **不需要**重新订阅；
 *   - `subscribeChanges`：覆盖发送落库、在线推送与离线补拉，供资源层失效重读；
 *   - `isReady`：当前 endpoint service 是否可用。
 *
 * 搜索**不**作为 service 暴露——UI 在拿到 list 后做本地字符串过滤。
 */
export interface MessageService {
  /** endpoint service 是否可用。 */
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
  /** 订阅本地历史变化（含发送落库和离线补拉），供资源层失效重读。 */
  subscribeChanges(handler: () => void): () => void;
}

/**
 * 构造消息业务 service。
 *
 * 入参 `endpointService`：plugin-appmsg 提供的稳定长寿 service。service
 * 内部已处理 owner / provider 切换，本层只读不写。
 *
 * 这样设计的好处：
 *   - vault 解锁 / 切 key / 切换 active provider 时，endpoint service
 *     **内部**自动迁移订阅 / 更新 sender 投影——本 service **不需要**
 *     重建也不需要重新构造；
 *   - 当前未就绪时所有方法静默走降级：list/get 返回空态；send 抛
 *     `not_ready`；subscribe 返回 noop 取消函数。
 *   - 业务页只关心 `isReady()` 返回值；owner / provider 切换完全由
 *     plugin-appmsg 透明处理。
 */
export function createMessageService(
  endpointService: AppMsgEndpointService
): MessageService {
  return {
    isReady: () => endpointService.isReady(),
    listMessages: async (input) => {
      const res = await endpointService.listMessages(input);
      return res.items;
    },
    getMessage: async (messageId) => {
      return endpointService.getMessage({ messageId });
    },
    sendTextMessage: async (input) => {
      const recipientPublicKeyHex = input.recipientPublicKeyHex.trim().toLowerCase();
      if (!/^(02|03)[0-9a-f]{64}$/.test(recipientPublicKeyHex)) {
        throw new Error("invalid_target");
      }
      await endpointService.sendMessage({
        recipientPublicKeyHex,
        recipientAppId: KEYMASTER_MESSAGE_APP_ID,
        contentType: input.contentType ?? "text/plain",
        body: input.body,
        clientMessageId: input.clientMessageId ?? makeClientMessageId(),
        createdAtMs: Date.now()
      });
    },
    subscribeMessages: (handler) => {
      return endpointService.subscribeMessages(handler);
    },
    subscribeChanges: (handler) => {
      return endpointService.subscribeLocalChanges?.(handler) ?? endpointService.subscribeMessages(handler);
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
