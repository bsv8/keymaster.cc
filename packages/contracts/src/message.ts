// 消息业务契约。
//
// Message 只描述当前 owner 的本地历史记录；远端历史、在线查询和传输层字段
// 不属于本契约。实际收发由 plugin-message 通过 Channel 私信完成。

import { defineCapability } from "webloom-framework";

/** 消息正文类型。 */
export type MessageContentType = "text/plain" | "text/markdown";

/** 当前 owner 本地保存的一条消息。 */
export interface MessageRecord {
  /** ChannelProtocol 私信的 message_id。 */
  messageId: string;
  /** 发送方业务幂等键。 */
  clientMessageId: string;
  /** 发送方压缩公钥 hex。 */
  senderPublicKeyHex: string;
  /** 接收方压缩公钥 hex。 */
  recipientPublicKeyHex: string;
  /** 正文类型。 */
  contentType: MessageContentType;
  /** 文本正文。 */
  body: string;
  /** 发送方声明的创建时间。 */
  createdAtMs: number;
  /** 本地写入时间。 */
  insertedAtMs: number;
  /**
   * 时间索引存在但对应的 raw 文件缺失时为 true。
   * 界面只能显示"原始数据缺失"，不得伪造正文。
   */
  rawMissing?: boolean;
}

/** 消息私信协议标识。 */
export const MESSAGE_PRIVATE_PROTOCOL = "bsv8.message.v1";

/** 消息插件对 UI 暴露的本地 service 契约。 */
export interface MessageService {
  /** 当前 owner 已解锁且 Channel runtime 可用。 */
  isReady(): boolean;
  /** 读取当前 owner 的本地消息历史。 */
  listMessages(input?: { limit?: number; afterMessageId?: string }): Promise<MessageRecord[]>;
  /** 读取当前 owner 的本地单条消息。 */
  getMessage(messageId: string): Promise<MessageRecord | null>;
  /** 发送一条文本私信，并在本地落库。 */
  sendTextMessage(input: {
    recipientPublicKeyHex: string;
    body: string;
    contentType?: MessageContentType;
    clientMessageId?: string;
  }): Promise<void>;
  /** 订阅收到或发送成功的本地消息。 */
  subscribeMessages(handler: (message: MessageRecord) => void): () => void;
  /** 订阅本地历史变化。 */
  subscribeChanges(handler: () => void): () => void;
  /** 释放 Channel 订阅。 */
  dispose?(): void;
}

/** 消息服务的唯一 typed capability 身份。 */
export const MESSAGE_SERVICE_CAPABILITY = defineCapability<MessageService>({
  kind: "local",
  id: "message.service",
  version: "1",
});
