// 会话时间线合并纯函数（纯文本消息，无 WebRTC/附件历史）。
import type { MessageRecord } from "@keymaster/contracts";

export type MessageTimelineItem = {
  kind: "text_message";
  sortAtMs: number;
  message: MessageRecord;
};

export function buildMessageTimeline(input: {
  messages: readonly MessageRecord[];
  ownerPublicKeyHex: string;
  peerPublicKeyHex: string;
}): MessageTimelineItem[] {
  const merged: MessageTimelineItem[] = [];
  for (const message of input.messages) {
    const peer = message.senderPublicKeyHex === input.ownerPublicKeyHex
      ? message.recipientPublicKeyHex
      : message.senderPublicKeyHex;
    if (peer !== input.peerPublicKeyHex) continue;
    merged.push({
      kind: "text_message",
      sortAtMs: message.insertedAtMs,
      message
    });
  }
  return merged.sort((a, b) => b.sortAtMs - a.sortAtMs);
}
