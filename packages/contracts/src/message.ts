// 消息业务契约。
//
// Message 只描述当前 owner 的本地历史记录；远端历史、在线查询和传输层字段
// 不属于本契约。实际收发由 plugin-message 通过 Channel 私信完成。

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
}

/** 消息私信协议标识。 */
export const MESSAGE_PRIVATE_PROTOCOL = "bsv8.message.v1";

