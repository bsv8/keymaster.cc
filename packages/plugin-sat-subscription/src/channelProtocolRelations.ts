import type { SessionEpoch } from "@keymaster/contracts";
export interface ChannelProtocolRelationsDependencies {
  sessionEpoch(): SessionEpoch;
  ownerPublicKeyHex(): string | undefined;
  pruneRelated?(now: number): void;
}
/** Sat owns bounded replay state and verified relations. */
export function createChannelProtocolRelations(deps: ChannelProtocolRelationsDependencies) {
  /** 入站消息去重只保留有限数量；锁屏、切换 key、重启都会清空。 */
  const channelSeenMessages = new Set<string>();
  const CHANNEL_SEEN_LIMIT = 4096;
  /** 已验签的公开 Hash 请求；只作为 WebRTC offer 关系审查证据。 */
  const channelHashRequests = new Map<string, import("bsv8-channel-protocol/hash-request").VerifiedHashRequest>();
  const CHANNEL_HASH_REQUEST_LIMIT = 1024;
  /** 已验签的 WebRTC offer；后续 answer/ICE 必须引用同一会话。 */
  const channelWebrtcOffers = new Map<string, import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage>();
  const CHANNEL_WEBRTC_OFFER_LIMIT = 512;

  function pruneChannelProtocolRelations(now = Date.now()): void {
    deps.pruneRelated?.(now);
    for (const [key, request] of channelHashRequests) {
      if (request.expires_at_ms <= now) channelHashRequests.delete(key);
    }
    for (const [key, offer] of channelWebrtcOffers) {
      if (offer.expires_at_ms <= now) channelWebrtcOffers.delete(key);
    }
    while (channelHashRequests.size > CHANNEL_HASH_REQUEST_LIMIT) {
      const first = channelHashRequests.keys().next().value as string | undefined;
      if (first === undefined) break;
      channelHashRequests.delete(first);
    }
    while (channelWebrtcOffers.size > CHANNEL_WEBRTC_OFFER_LIMIT) {
      const first = channelWebrtcOffers.keys().next().value as string | undefined;
      if (first === undefined) break;
      channelWebrtcOffers.delete(first);
    }
  }

  function channelHashRequestKey(messageId: string, publisherPublicKeyHex: string): string {
    return `${publisherPublicKeyHex.trim().toLowerCase()}\u0000${messageId}`;
  }

  function channelHashRequestByMessageId(
    messageId: string,
    publisherPublicKeyHex: string
  ): import("bsv8-channel-protocol/hash-request").VerifiedHashRequest | undefined {
    pruneChannelProtocolRelations();
    return channelHashRequests.get(channelHashRequestKey(messageId, publisherPublicKeyHex));
  }

  function channelWebrtcOfferKey(requestMessageId: string, offererPublicKeyHex: string, sessionId: string): string {
    return `${requestMessageId}\u0000${offererPublicKeyHex}\u0000${sessionId}`;
  }

  function findChannelWebrtcOffer(
    body: import("bsv8-channel-protocol/webrtc-signal").WebRTCSignalV1Body,
    message: import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage
  ): import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage | undefined {
    pruneChannelProtocolRelations();
    // answer 的 offerer 必须是 answer 的接收者；ICE 双向都可能发送，
    // 但只能在双方公钥对应的完整三元组中找到唯一一条 offer。
    const candidates = body.signal.type === "answer"
      ? [message.to_public_key]
      : [message.from_public_key, message.to_public_key];
    const matches = new Map<string, import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage>();
    for (const offerer of candidates) {
      const key = channelWebrtcOfferKey(body.request_message_id, offerer, body.session_id);
      const offer = channelWebrtcOffers.get(key);
      if (offer) matches.set(key, offer);
    }
    return matches.size === 1 ? matches.values().next().value : undefined;
  }

  function rememberChannelMessage(key: string): boolean {
    if (channelSeenMessages.has(key)) return false;
    channelSeenMessages.add(key);
    while (channelSeenMessages.size > CHANNEL_SEEN_LIMIT) {
      const first = channelSeenMessages.values().next().value as string | undefined;
      if (first === undefined) break;
      channelSeenMessages.delete(first);
    }
    return true;
  }

  return {
    hashRequests: channelHashRequests,
    webrtcOffers: channelWebrtcOffers,
    prune: pruneChannelProtocolRelations,
    hashRequestKey: channelHashRequestKey,
    hashRequestByMessageId: channelHashRequestByMessageId,
    webrtcOfferKey: channelWebrtcOfferKey,
    findWebrtcOffer: findChannelWebrtcOffer,
    rememberMessage: rememberChannelMessage,
    clear() {
      channelHashRequests.clear();
      channelWebrtcOffers.clear();
      channelSeenMessages.clear();
    },
  };
}
