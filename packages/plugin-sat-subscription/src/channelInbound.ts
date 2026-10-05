import type { ChannelPrivateMessageEvent, JSONValue, SatIncomingPublish } from "@keymaster/contracts";
import { inboxChannel, parsePublicKey, parseInboxChannel } from "bsv8-channel-protocol";
import { dedupKey as privateDedupKey, validatePongRelation, reviewOfferForHashRequest, validateWebRTCRelation, type VerifiedPrivateMessage } from "bsv8-channel-protocol/inbox";
import { APP_MESSAGE_PROTOCOL } from "bsv8-channel-protocol/app-message";
import { PING_PROTOCOL, parseBodyValue as parsePingBodyValue, newPong } from "bsv8-channel-protocol/ping";
import { WEBRTC_SIGNAL_PROTOCOL, parseBodyValue as parseWebrtcBodyValue, type WebRTCSignalV1Body } from "bsv8-channel-protocol/webrtc-signal";
import { HASH_REQUEST_CHANNEL, parseAndVerify as parseHashRequest, type VerifiedHashRequest } from "bsv8-channel-protocol/hash-request";
import { parseAndVerify as parsePublicMessage, dedupKey as publicDedupKey } from "bsv8-channel-protocol/public-message";
import { monotonicNow, type ChannelPublicationPort } from "./channelPublications.js";
import type { ChannelOperationDependencies } from "./channelOperationExecutor.js";
import type { createChannelProtocolRelations } from "./channelProtocolRelations.js";

export interface ChannelInboundDependencies<R extends ChannelPublicationPort> {
  session(): { sessionEpoch: string; activePublicKeyHex?: string; vaultStatus: string };
  runtime(): R | undefined;
  relations: ReturnType<typeof createChannelProtocolRelations>;
  openPrivate(event: SatIncomingPublish, owner: string, epoch: string): Promise<VerifiedPrivateMessage>;
  publishPrivate: ChannelOperationDependencies<R>["publishPrivate"];
  recordPong(input: { contactPublicKeyHex: string; receivedAtMs: number }): void;
  emitPrivate(event: Omit<ChannelPrivateMessageEvent, "type" | "sessionEpoch">): void;
  emitPublic(event: { channel: string; publisherPublicKeyHex: string; messageId: string; content: JSONValue }): void;
  routeSignal(body: WebRTCSignalV1Body, opened: VerifiedPrivateMessage, seedHashHex?: string): Promise<void>;
  hashRequestSeen(request: VerifiedHashRequest): Promise<void>;
}
export function seenMessageKey(kind: "private" | "public" | "hash-request", ...parts: readonly string[]): string { return `${kind}\u0000${parts.join("\u0000")}`; }
export function channelErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return error instanceof Error && error.message === "UNSUPPORTED_PROTOCOL" ? error.message : undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return error instanceof Error && error.message === "UNSUPPORTED_PROTOCOL" ? error.message : undefined;
}
export function isUnknownChannelPublishFailure(error: unknown): boolean { return channelErrorCode(error) === "unknown_result" || (error instanceof Error && /unknown[_ ]result/i.test(error.message)); }

/** Owns inbound protocol validation, replay filtering and verified event routing. */
export function createChannelInbound<R extends ChannelPublicationPort>(deps: ChannelInboundDependencies<R>) {
  const channelPendingPings = deps.relations.pendingPings;
  const channelHashRequests = deps.relations.hashRequests;
  const channelWebrtcOffers = deps.relations.webrtcOffers;
  const pruneChannelPendingPings = deps.relations.prunePendingPings;
  const pruneChannelProtocolRelations = deps.relations.prune;
  const rememberChannelMessage = deps.relations.rememberMessage;
  const allowAutomaticPong = deps.relations.allowAutomaticPong;
  const channelHashRequestKey = deps.relations.hashRequestKey;
  const channelHashRequestByMessageId = deps.relations.hashRequestByMessageId;
  const findChannelWebrtcOffer = deps.relations.findWebrtcOffer;
async function handleIncomingChannelPublish(event: SatIncomingPublish): Promise<void> {
  const initialSession = deps.session();
  if (initialSession.vaultStatus !== "unlocked" || !initialSession.activePublicKeyHex) return;
  pruneChannelPendingPings();
  pruneChannelProtocolRelations();
  try {
    const owner = initialSession.activePublicKeyHex;
    const ownerSessionEpoch = initialSession.sessionEpoch;
    const ownerInbox = inboxChannel(parsePublicKey(owner));
    if (event.channel === ownerInbox) {
      const opened = await deps.openPrivate(event, owner, ownerSessionEpoch);
      // 解密本身可能让出事件循环；锁定、切换 owner 或重建 session 后，
      // 旧事件不得进入新 owner 的业务处理器。
      if (deps.session().vaultStatus !== "unlocked"
        || deps.session().sessionEpoch !== ownerSessionEpoch
        || deps.session().activePublicKeyHex !== owner) {
        return;
      }
      const dedup = privateDedupKey(opened);
      const key = seenMessageKey("private", dedup.protocol, dedup.from_public_key, dedup.message_id);
      if (!rememberChannelMessage(key)) return;
      switch (opened.protocol) {
        case PING_PROTOCOL: {
          const pingBody = parsePingBodyValue(opened.body as unknown as import("bsv8-channel-protocol").JSONValue);
          if (pingBody.type === "ping") {
            const runtime = deps.runtime();
            if (runtime && runtime.ownerPublicKeyHex === owner && allowAutomaticPong(opened.from_public_key)) {
              try {
                await deps.publishPrivate({ runtime, recipientPublicKeyHex: opened.from_public_key, protocol: PING_PROTOCOL, body: newPong(opened.message_id) });
              } catch (error) {
                console.warn("[channel] automatic Pong failed", error instanceof Error ? error.message : String(error));
              }
            }
            return;
          }
          const pending = channelPendingPings.get(pingBody.ping_message_id);
          if (!pending
            || pending.ownerSessionEpoch !== deps.session().sessionEpoch
            || pending.ownerPublicKeyHex !== owner
            || pending.contactPublicKeyHex !== opened.from_public_key
            || pending.expiresAtMs <= Date.now()) {
            return;
          }
          try {
            validatePongRelation(pending.pingMessage, opened);
          } catch {
            return;
          }
          channelPendingPings.delete(pingBody.ping_message_id);
          // RTT 仅作为诊断值，不进入 Contact 实体或公开资源。
          void Math.max(0, monotonicNow() - pending.startedAtMonotonicMs);
          deps.recordPong({
            contactPublicKeyHex: opened.from_public_key,
            receivedAtMs: Date.now()
          });
          deps.emitPrivate({ channel: opened.channel, publisherPublicKeyHex: opened.from_public_key, messageId: opened.message_id, protocol: opened.protocol, content: pingBody as unknown as import("@keymaster/contracts").JSONValue, rawEnvelope: event.contentJson.slice() });
          return;
        }
        case APP_MESSAGE_PROTOCOL: {
          const appBody = opened.body as import("bsv8-channel-protocol/app-message").MessageV1Body;
          const content: import("@keymaster/contracts").JSONValue = appBody.type === "deliver"
            ? appBody.content as import("@keymaster/contracts").JSONValue
            : { type: "ack", acknowledged_message_id: appBody.acknowledged_message_id };
          deps.emitPrivate({ channel: opened.channel, publisherPublicKeyHex: opened.from_public_key, messageId: opened.message_id, protocol: opened.protocol, content, rawEnvelope: event.contentJson.slice() });
          return;
        }
        case WEBRTC_SIGNAL_PROTOCOL: {
          const webrtcBody = parseWebrtcBodyValue(opened.body as unknown as import("bsv8-channel-protocol").JSONValue);
          if (webrtcBody.signal.type === "offer") {
            const hashRequest = channelHashRequestByMessageId(webrtcBody.request_message_id, owner);
            if (!hashRequest) throw new Error("WebRTC offer references an unknown or expired Hash request");
            const relation = reviewOfferForHashRequest(hashRequest, opened);
            channelWebrtcOffers.set(relation.key, opened);
            pruneChannelProtocolRelations();
            await deps.routeSignal(webrtcBody, opened, hashRequest.body.hash);
          } else {
            const offer = findChannelWebrtcOffer(webrtcBody, opened);
            if (!offer) throw new Error("WebRTC signal has no verified offer relation");
            validateWebRTCRelation(offer, opened);
            await deps.routeSignal(webrtcBody, opened);
          }
          const current = deps.session();
          if (current.vaultStatus !== "unlocked" || current.sessionEpoch !== ownerSessionEpoch || current.activePublicKeyHex !== owner) return;
          deps.emitPrivate({ channel: opened.channel, publisherPublicKeyHex: opened.from_public_key, messageId: opened.message_id, protocol: opened.protocol, content: webrtcBody as unknown as import("@keymaster/contracts").JSONValue, rawEnvelope: event.contentJson.slice() });
          return;
        }
        default:
          throw new Error("UNSUPPORTED_PROTOCOL");
      }
    }
    // bsv8.inbox.* is a private namespace. A message arriving at another
    // owner's inbox is never reinterpreted as a public application message.
    if (event.channel.startsWith("bsv8.inbox.")) {
      try { parseInboxChannel(event.channel); } catch { /* malformed private namespace is rejected below */ }
      return;
    }
    if (event.channel === HASH_REQUEST_CHANNEL) {
      const hashRequest = parseHashRequest(event.channel, event.contentJson);
      const relationKey = channelHashRequestKey(hashRequest.message_id, hashRequest.from_public_key);
      const seenKey = seenMessageKey("hash-request", relationKey);
      if (!rememberChannelMessage(seenKey)) return;
      channelHashRequests.set(relationKey, hashRequest);
      pruneChannelProtocolRelations();
      deps.emitPublic({
        channel: event.channel,
        publisherPublicKeyHex: hashRequest.from_public_key,
        messageId: hashRequest.message_id,
        content: {
          hash: hashRequest.body.hash,
          locators: hashRequest.body.locators.map((locator) => locator.kind === "multiaddr"
            ? { kind: locator.kind, address: locator.address }
            : { kind: locator.kind })
        } as unknown as import("@keymaster/contracts").JSONValue
      });
      // BitFS 卖方匹配：命中完整 Seed 且 locator 兼容时才建立销售会话；
      // 未命中或端口未就绪时保持静默，不泄露库存。
      void deps.hashRequestSeen(hashRequest);
      return;
    }
    const publicMessage = parsePublicMessage(event.channel, event.contentJson);
    const publicDedup = publicDedupKey(publicMessage);
    const key = seenMessageKey("public", publicDedup.channel, publicDedup.from_public_key, publicDedup.message_id);
    if (!rememberChannelMessage(key)) return;
    deps.emitPublic({ channel: publicMessage.channel, publisherPublicKeyHex: publicMessage.from_public_key, messageId: publicMessage.message_id, content: publicMessage.body });
  } catch (error) {
    // 无效、过期、未知协议或非 owner inbox 的私密消息全部丢弃；不向 SSP
    // 暴露本地 crypto 错误，也不猜测业务协议。
    console.warn("[channel] inbound message rejected", error instanceof Error ? error.message : String(error));
    if (channelErrorCode(error) === "UNSUPPORTED_PROTOCOL") {
      const rejection = new Error("UNSUPPORTED_PROTOCOL") as Error & { domain?: string; code?: string };
      rejection.domain = "channel-inbound";
      rejection.code = "UNSUPPORTED_PROTOCOL";
      throw rejection;
    }
  }
}

  return handleIncomingChannelPublish;
}
