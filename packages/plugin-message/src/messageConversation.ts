// packages/plugin-message/src/messageConversation.ts
// 会话聚合纯函数。
//
// 设计缘由：
//   - /messages 首页和 /messages/:publicKeyHex 详情页共用同一套会话归并规则；
//   - 这里只放纯数据逻辑，不放 React 状态；
//   - peer 身份只认 publicKeyHex。

import type { AppMsgMessage } from "@keymaster/contracts";

export interface ConversationSummary {
  peerPublicKeyHex: string;
  latestMessage: AppMsgMessage;
  latestInsertedAtMs: number;
  messageCount: number;
}

export function getConversationPeerPublicKeyHex(message: AppMsgMessage, ownerPublicKeyHex: string): string {
  return message.senderPublicKeyHex === ownerPublicKeyHex
    ? message.recipientPublicKeyHex
    : message.senderPublicKeyHex;
}

export function buildConversationSummaries(
  messages: readonly AppMsgMessage[],
  ownerPublicKeyHex: string
): ConversationSummary[] {
  const byPeer = new Map<string, ConversationSummary>();
  for (const message of messages) {
    const peerPublicKeyHex = getConversationPeerPublicKeyHex(message, ownerPublicKeyHex);
    const current = byPeer.get(peerPublicKeyHex);
    if (!current) {
      byPeer.set(peerPublicKeyHex, {
        peerPublicKeyHex,
        latestMessage: message,
        latestInsertedAtMs: message.insertedAtMs,
        messageCount: 1
      });
      continue;
    }
    current.messageCount += 1;
    if (message.insertedAtMs >= current.latestInsertedAtMs) {
      current.latestInsertedAtMs = message.insertedAtMs;
      current.latestMessage = message;
    }
  }
  return [...byPeer.values()].sort((a, b) => b.latestInsertedAtMs - a.latestInsertedAtMs);
}

export function listConversationMessages(
  messages: readonly AppMsgMessage[],
  ownerPublicKeyHex: string,
  peerPublicKeyHex: string
): AppMsgMessage[] {
  return messages
    .filter((message) => getConversationPeerPublicKeyHex(message, ownerPublicKeyHex) === peerPublicKeyHex)
    .slice()
    .sort((a, b) => b.insertedAtMs - a.insertedAtMs);
}

export function shortPublicKeyHex(publicKeyHex: string): string {
  if (publicKeyHex.length <= 8) {
    return publicKeyHex;
  }
  return `${publicKeyHex.slice(0, 4)}...${publicKeyHex.slice(-4)}`;
}
