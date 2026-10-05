import type { JSONValue, SatSubscriptionService } from "@keymaster/contracts";
import { inboxChannel, parsePublicKey, newMessageID, parseSHA256Hash } from "bsv8-channel-protocol";
import { sign as signPublic, marshal as marshalPublicMessage, PUBLIC_MESSAGE_MAX_LIFETIME_MS } from "bsv8-channel-protocol/public-message";
import { sign as signHash, marshal as marshalHashRequest, parseAndVerify as parseHashRequest, HASH_REQUEST_CHANNEL, newWebRTCSDPLocator } from "bsv8-channel-protocol/hash-request";
import { marshalEnvelope, marshalPrivateMessage, verifySignedPrivateMessage, reviewOfferForHashRequest, validateWebRTCRelation, PING_PRIVATE_MESSAGE_MAX_LIFETIME_MS, type SignedPrivateMessage, type UnsignedPrivateMessage, sealSigned } from "bsv8-channel-protocol/inbox";
import { PING_PROTOCOL } from "bsv8-channel-protocol/ping";
import { WEBRTC_SIGNAL_PROTOCOL } from "bsv8-channel-protocol/webrtc-signal";
import { validateExactChannel } from "./channelSubscriptionMux.js";
import { privateProtocol, isPingRequestBody, type ChannelPrivateProtocol } from "./channelProtocolPolicy.js";
import type { createChannelProtocolRelations } from "./channelProtocolRelations.js";

export interface ChannelPublicationPort { ownerPublicKeyHex: string; service: Pick<SatSubscriptionService, "publish"> }
interface ChannelPublicationSigner {
  signHash(input: Omit<Parameters<typeof signHash>[0], "from_public_key">): ReturnType<typeof signHash>;
  signPublic(input: Omit<Parameters<typeof signPublic>[0], "from_public_key">): ReturnType<typeof signPublic>;
  signPrivate(input: { recipientPublicKeyHex: string; protocol: UnsignedPrivateMessage["protocol"]; body: UnsignedPrivateMessage["body"]; messageId: string; nowMs: number }): SignedPrivateMessage;
  seal(message: SignedPrivateMessage): ReturnType<typeof sealSigned>;
}
export interface ChannelPublicationDependencies {
  session(): { sessionEpoch: string; activePublicKeyHex?: string; vaultStatus: string };
  signer: ChannelPublicationSigner;
  relations: ReturnType<typeof createChannelProtocolRelations>;
  unknownPublishFailure(error: unknown): boolean;
}
export function publicMessageTimes(now: () => number = Date.now) {
  const issuedAtMs = now();
  return { issuedAtMs, expiresAtMs: issuedAtMs + PUBLIC_MESSAGE_MAX_LIFETIME_MS };
}
export function monotonicNow(): number { return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now(); }

/** Owns protocol serialization, outbound relation evidence and publication reconciliation. */
export function createChannelPublications(deps: ChannelPublicationDependencies) {
  const channelPendingPings = deps.relations.pendingPings;
  const channelHashRequests = deps.relations.hashRequests;
  const channelWebrtcOffers = deps.relations.webrtcOffers;
  const pruneChannelProtocolRelations = deps.relations.prune;
  const channelHashRequestKey = deps.relations.hashRequestKey;
  const channelHashRequestByMessageId = deps.relations.hashRequestByMessageId;
  const channelWebrtcOfferKey = deps.relations.webrtcOfferKey;
  const findChannelWebrtcOffer = deps.relations.findWebrtcOffer;
  const pruneChannelPendingPings = deps.relations.prunePendingPings;
  const scheduleChannelPendingPingCleanup = deps.relations.schedulePendingPingCleanup;
  const CHANNEL_PENDING_PING_TTL_MS = PING_PRIVATE_MESSAGE_MAX_LIFETIME_MS;
  function assertOwner(runtime: ChannelPublicationPort, epoch: string = deps.session().sessionEpoch): void {
    const session = deps.session();
    if (session.vaultStatus !== "unlocked" || session.activePublicKeyHex !== runtime.ownerPublicKeyHex || session.sessionEpoch !== epoch) throw new Error("Channel owner changed before publish");
  }
async function publishChannelHashRequestUnsafe(
  runtime: ChannelPublicationPort,
  input: { hash: string; locator: "webrtc-sdp" },
  signal?: AbortSignal,
  onPrepared?: (messageId: string) => void,
): Promise<{ messageId: string }> {
  assertOwner(runtime);
  const hash = parseSHA256Hash(input.hash);
  const ownerSessionEpoch = deps.session().sessionEpoch;
  const issuedAtMs = Date.now();
  const signed = deps.signer.signHash({
    message_id: newMessageID(),
    issued_at_ms: issuedAtMs,
    expires_at_ms: issuedAtMs + 10 * 60 * 1000,
    body: { hash, locators: [newWebRTCSDPLocator()] }
  });
  const contentJson = marshalHashRequest(signed);
  // Supplier 通常不会把本 owner 的 Publish 回送给自己；本地仍必须保存
  // 这条 SDK 生成的 VerifiedHashRequest，才能审查远端随后发来的 offer。
  const verified = parseHashRequest(HASH_REQUEST_CHANNEL, contentJson);
  const relationKey = channelHashRequestKey(verified.message_id, verified.from_public_key);
  channelHashRequests.set(relationKey, verified);
  pruneChannelProtocolRelations();
  // BitFS 买方先在本地注册 request_id，再将 exact Hash request 发到网络；
  // 极快的卖方答复也不会落在注册空窗内。
  onPrepared?.(verified.message_id);
  try {
    assertOwner(runtime, ownerSessionEpoch);
    await runtime.service.publish({ channel: HASH_REQUEST_CHANNEL, contentJson }, signal);
  } catch (error) {
    const stillFresh = deps.session().vaultStatus === "unlocked"
      && deps.session().sessionEpoch === ownerSessionEpoch
      && deps.session().activePublicKeyHex === runtime.ownerPublicKeyHex;
    // unknown_result 表示消息可能已经到达远端，保留关系等待过期；明确
    // 失败或 owner 已切换时不能留下本地伪 Hash 请求证据。
    if (!stillFresh || !deps.unknownPublishFailure(error)) channelHashRequests.delete(relationKey);
    throw error;
  }
  if (deps.session().vaultStatus !== "unlocked"
    || deps.session().sessionEpoch !== ownerSessionEpoch
    || deps.session().activePublicKeyHex !== runtime.ownerPublicKeyHex) {
    channelHashRequests.delete(relationKey);
    throw new Error("Channel owner changed while publishing Hash request");
  }
  return { messageId: signed.message_id };
}

async function publishPublic(runtime: ChannelPublicationPort, channel: string, content: JSONValue, signal?: AbortSignal): Promise<{ messageId: string }> {
  validateExactChannel(channel);
  if (channel.startsWith("bsv8.inbox.")) throw new Error("bsv8.inbox.* is a reserved private channel");
  if (channel === HASH_REQUEST_CHANNEL) throw new Error("bsv8.hash.request.v1 is reserved for the trusted WebRTC Hash request publisher");
    assertOwner(runtime);
    const ownerSessionEpoch = deps.session().sessionEpoch;
      const { issuedAtMs, expiresAtMs } = publicMessageTimes();
    const signed = deps.signer.signPublic({
      channel,
        message_id: newMessageID(),
      issued_at_ms: issuedAtMs,
      expires_at_ms: expiresAtMs,
      body: content,
    });
    assertOwner(runtime, ownerSessionEpoch);
    await runtime.service.publish({ channel, contentJson: marshalPublicMessage(signed) }, signal);
    if (deps.session().vaultStatus !== "unlocked"
      || deps.session().sessionEpoch !== ownerSessionEpoch
      || deps.session().activePublicKeyHex !== runtime.ownerPublicKeyHex) {
      throw new Error("Channel owner changed while publishing");
    }
    return { messageId: signed.message_id };
}
async function publishPrivateEnvelopeUnsafe(input: {
  runtime: ChannelPublicationPort;
  recipientPublicKeyHex: string;
  protocol: ChannelPrivateProtocol;
  body: import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage["body"];
  signal?: AbortSignal;
}): Promise<{ messageId: string; signedMessage: Uint8Array }> {
  privateProtocol(input.protocol);
  const recipient = parsePublicKey(input.recipientPublicKeyHex);
  const channel = inboxChannel(recipient);
  const ownerSessionEpoch = deps.session().sessionEpoch;
  if (input.runtime.ownerPublicKeyHex !== deps.session().activePublicKeyHex) {
    throw new Error("Channel owner changed before private publish");
  }
  const messageId = newMessageID();
  const now = Date.now();
  const startedAtMonotonicMs = input.protocol === PING_PROTOCOL && isPingRequestBody(input.body)
    ? monotonicNow()
    : undefined;
  // 过期时间必须由 ChannelProtocol 的子协议上限决定：Ping 60 秒，
  // WebRTC 120 秒，其它私密消息最多 24 小时。签名构造集中在同一个
  // helper，测试可以直接走与 Coordinator 相同的真实签名入口。
  const signed = deps.signer.signPrivate({
    recipientPublicKeyHex: recipient,
    protocol: input.protocol,
    body: input.body,
    messageId,
    nowMs: now
  });
  let verifiedWebrtc: import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage | undefined;
  if (input.protocol === WEBRTC_SIGNAL_PROTOCOL) {
    verifiedWebrtc = verifySignedPrivateMessage(signed);
    const webrtcBody = verifiedWebrtc.body as import("bsv8-channel-protocol/webrtc-signal").WebRTCSignalV1Body;
    if (webrtcBody.signal.type === "offer") {
      const hashRequest = channelHashRequestByMessageId(webrtcBody.request_message_id, recipient);
      if (!hashRequest) throw new Error("WebRTC offer must reference a live public Hash request");
      reviewOfferForHashRequest(hashRequest, verifiedWebrtc);
    } else {
      const offer = findChannelWebrtcOffer(webrtcBody, verifiedWebrtc);
      if (!offer) throw new Error("WebRTC signal has no verified offer relation");
      validateWebRTCRelation(offer, verifiedWebrtc);
    }
  }
  const pingMessage = input.protocol === PING_PROTOCOL && isPingRequestBody(input.body)
    ? verifySignedPrivateMessage(signed)
    : undefined;
  const verifiedWebrtcBody = verifiedWebrtc?.body as import("bsv8-channel-protocol/webrtc-signal").WebRTCSignalV1Body | undefined;
  const webrtcOfferKey = verifiedWebrtc && verifiedWebrtcBody?.signal.type === "offer"
    ? channelWebrtcOfferKey(
      verifiedWebrtcBody.request_message_id,
      verifiedWebrtc.from_public_key,
      verifiedWebrtcBody.session_id
    )
    : undefined;
  if (verifiedWebrtc && webrtcOfferKey) {
    // Offer 关系必须在发送边界前登记。Publish 返回 unknown_result 时，
    // 远端可能已经收到 offer 并立即回 answer；提前登记才能通过后续关系
    // 审查。明确失败时下面会删除这条本地证据。
    channelWebrtcOffers.set(webrtcOfferKey, verifiedWebrtc);
    pruneChannelProtocolRelations();
  }
  let envelope: Awaited<ReturnType<typeof sealSigned>>;
  try {
    envelope = await deps.signer.seal(signed);
    assertOwner(input.runtime, ownerSessionEpoch);
  } catch (error) {
    if (webrtcOfferKey) channelWebrtcOffers.delete(webrtcOfferKey);
    throw error;
  }
  if (input.protocol === PING_PROTOCOL && isPingRequestBody(input.body)) {
    pruneChannelPendingPings(now);
    // 必须在网络 Publish 前登记；Pong 可能在 publish Promise settle 前
    // 经另一个入站 handler 到达。unknown_result 时保留到 TTL，禁止重复发送。
    channelPendingPings.set({
      messageId,
      ownerSessionEpoch,
      ownerPublicKeyHex: input.runtime.ownerPublicKeyHex,
      contactPublicKeyHex: recipient,
      startedAtMonotonicMs: startedAtMonotonicMs!,
      expiresAtMs: now + CHANNEL_PENDING_PING_TTL_MS,
      pingMessage: pingMessage!
    });
    scheduleChannelPendingPingCleanup();
  }
  try {
    await input.runtime.service.publish({ channel, contentJson: marshalEnvelope(envelope) }, input.signal);
  } catch (error) {
    const stillFresh = deps.session().vaultStatus === "unlocked"
      && deps.session().sessionEpoch === ownerSessionEpoch
      && deps.session().activePublicKeyHex === input.runtime.ownerPublicKeyHex;
    if (!deps.unknownPublishFailure(error) || !stillFresh) {
      channelPendingPings.delete(messageId);
      if (webrtcOfferKey) channelWebrtcOffers.delete(webrtcOfferKey);
    }
    throw error;
  }
  if (deps.session().vaultStatus !== "unlocked"
    || deps.session().sessionEpoch !== ownerSessionEpoch
    || deps.session().activePublicKeyHex !== input.runtime.ownerPublicKeyHex) {
    channelPendingPings.delete(messageId);
    if (webrtcOfferKey) channelWebrtcOffers.delete(webrtcOfferKey);
    throw new Error("Channel owner changed while publishing");
  }
  // 出站签名明文由调用方作为本地证据原样保存；不重新序列化，不包含密文。
  return { messageId, signedMessage: marshalPrivateMessage(signed) };
}


  return { hash: publishChannelHashRequestUnsafe, public: publishPublic, private: publishPrivateEnvelopeUnsafe };
}
