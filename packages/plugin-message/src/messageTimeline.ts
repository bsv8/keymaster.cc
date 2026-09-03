// 会话时间线合并纯函数。
//
// 设计缘由：
//   - 文本消息通过 Channel 私信；
//   - WebRTC 历史单独来自 webrtc service；
//   - UI 只消费统一时间线项，不关心底层真值源。

import type { MessageRecord, WebrtcHistoryItem } from "@keymaster/contracts";

export type MessageTimelineItem =
  | {
      kind: "text_message";
      sortAtMs: number;
      message: MessageRecord;
    }
  | {
      kind: "webrtc_call_record";
      sortAtMs: number;
      record: Extract<WebrtcHistoryItem, { itemType: "call" }>;
    }
  | {
      kind: "webrtc_image_record";
      sortAtMs: number;
      record: Extract<WebrtcHistoryItem, { itemType: "transfer" }>;
    }
  | {
      kind: "webrtc_file_record";
      sortAtMs: number;
      record: Extract<WebrtcHistoryItem, { itemType: "transfer" }>;
    };

export function buildMessageTimeline(input: {
  messages: readonly MessageRecord[];
  history: readonly WebrtcHistoryItem[];
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
  for (const item of input.history) {
    if (item.peerPublicKeyHex !== input.peerPublicKeyHex) continue;
    if (item.itemType === "call") {
      const call = item as Extract<WebrtcHistoryItem, { itemType: "call" }>;
      merged.push({
        kind: "webrtc_call_record",
        sortAtMs: call.endedAtMs ?? call.startedAtMs,
        record: call
      });
      continue;
    }
    const transfer = item as Extract<WebrtcHistoryItem, { itemType: "transfer" }>;
    if (transfer.kind === "image") {
      merged.push({
        kind: "webrtc_image_record",
        sortAtMs: transfer.endedAtMs ?? transfer.startedAtMs,
        record: transfer
      });
      continue;
    }
    merged.push({
      kind: "webrtc_file_record",
      sortAtMs: transfer.endedAtMs ?? transfer.startedAtMs,
      record: transfer
    });
  }
  return merged.sort((a, b) => b.sortAtMs - a.sortAtMs);
}
