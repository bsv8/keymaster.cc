import type { CoordinatorClientRequest, CoordinatorResponse, JSONValue } from "@keymaster/contracts";
import type { VerifiedPrivateMessage, UnsignedPrivateMessage } from "bsv8-channel-protocol/inbox";
import { validateExactChannel, type ChannelSubscriptionMux } from "./channelSubscriptionMux.js";
import { privateProtocol, validatePrivateProtocolCaller, privateBodyForPublish, privateHistoryContent, type ChannelPrivateProtocol, type ChannelCaller } from "./channelProtocolPolicy.js";
import type { ChannelPublicationPort } from "./channelPublications.js";

export interface ChannelOperationDependencies<R extends ChannelPublicationPort> {
  session(): { sessionEpoch: string; activePublicKeyHex?: string; vaultStatus: string };
  publishHash(runtime: R, input: { hash: string; locator: "webrtc-sdp" }, signal?: AbortSignal): Promise<{ messageId: string }>;
  publishPublic(runtime: R, channel: string, content: JSONValue, signal?: AbortSignal): Promise<{ messageId: string }>;
  publishPrivate(input: { runtime: R; recipientPublicKeyHex: string; protocol: ChannelPrivateProtocol; body: UnsignedPrivateMessage["body"]; signal?: AbortSignal }): Promise<{ messageId: string; signedMessage: Uint8Array }>;
  openPrivate(owner: string, envelope: Uint8Array, signal?: AbortSignal): Promise<VerifiedPrivateMessage>;
  connectSession(id: string): Promise<{ origin: string; ownerPublicKeyHex: string; revokedAt: number | null } | null>;
  disconnected(clientId: string): boolean;
  disconnectedResponse(requestId: string): CoordinatorResponse;
  allowedInbox(caller: ChannelCaller, channel: string): boolean;
  callers: Map<string, Set<string>>;
}

/** Owns Channel protocol dispatch and reconciliation; the host authenticates the caller and supplies leased I/O. */
export function createChannelOperationExecutor<R extends ChannelPublicationPort>(deps: ChannelOperationDependencies<R>) {
  const CHANNEL_MAX_SUBSCRIPTIONS_PER_CALLER = 64;
  return async function execute(request: Extract<CoordinatorClientRequest, { kind: "channel.operation" }>, actualClientId: string, runtime: R, mux: ChannelSubscriptionMux, callerId: string, requestSignal?: AbortSignal): Promise<CoordinatorResponse> {
    const operation = request.operation;
    switch (operation.type) {
      case "hash-request-publish": {
        if (operation.caller.kind !== "plugin" || (operation.caller.pluginId !== "webrtc" && operation.caller.pluginId !== "msfile")) {
          throw new Error("Only trusted WebRTC and MSFile plugins may publish Hash requests");
        }
        if (operation.locator !== "webrtc-sdp") throw new Error("Unsupported Hash request locator");
        const published = await deps.publishHash(runtime, operation, requestSignal);
        if (request.expectedSessionEpoch !== deps.session().sessionEpoch
          || deps.session().vaultStatus !== "unlocked"
          || deps.session().activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Hash request publish became stale after network completion");
        }
        return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "ok" }, operationResult: published };
      }
      case "publish": {
        const published = await deps.publishPublic(runtime, operation.channel, operation.content, requestSignal);
        if (request.expectedSessionEpoch !== deps.session().sessionEpoch
          || deps.session().vaultStatus !== "unlocked"
          || deps.session().activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Channel publish became stale after network completion");
        }
        if (operation.caller.kind === "connect") {
          const session = await deps.connectSession(operation.caller.connectSessionId);
          if (!session || session.revokedAt !== null || session.origin !== operation.caller.origin || session.ownerPublicKeyHex !== operation.ownerPublicKeyHex) {
            throw new Error("Channel Connect session was revoked during publish");
          }
        }
        return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "ok" }, operationResult: published };
      }
      case "private-publish": {
        const protocol = privateProtocol(operation.protocol);
        validatePrivateProtocolCaller(operation.caller, protocol);
        const published = await deps.publishPrivate({ runtime, recipientPublicKeyHex: operation.recipientPublicKeyHex, protocol, body: privateBodyForPublish(protocol, operation.content), signal: requestSignal });
        if (request.expectedSessionEpoch !== deps.session().sessionEpoch
          || deps.session().vaultStatus !== "unlocked"
          || deps.session().activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Private Channel publish became stale after network completion");
        }
        return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "ok" }, operationResult: { messageId: published.messageId, signedMessage: published.signedMessage } };
      }
      case "open-private-envelope": {
        // 只有受信任消息插件能按需解密历史信封；Connect App 和公共频道不可用。
        if (operation.caller.kind !== "plugin" || operation.caller.pluginId !== "message") {
          throw new Error("Only the trusted message plugin may open private envelopes");
        }
        if (deps.session().vaultStatus !== "unlocked"
          || !deps.session().activePublicKeyHex
          || deps.session().activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Private envelope history open requires the current unlocked owner");
        }
        const expectedEpoch = deps.session().sessionEpoch;
        const opened = await deps.openPrivate(operation.ownerPublicKeyHex, operation.envelope, requestSignal);
        if (request.expectedSessionEpoch !== deps.session().sessionEpoch
          || deps.session().vaultStatus !== "unlocked"
          || deps.session().activePublicKeyHex !== operation.ownerPublicKeyHex
          || expectedEpoch !== deps.session().sessionEpoch) {
          throw new Error("Private Channel history open became stale after decrypt");
        }
        return {
          requestId: request.requestId,
          sessionEpoch: deps.session().sessionEpoch,
          ack: { status: "ok" },
          operationResult: {
            channel: opened.channel,
            protocol: opened.protocol,
            messageId: opened.message_id,
            publisherPublicKeyHex: opened.from_public_key,
            issuedAtMs: opened.issued_at_ms,
            expiresAtMs: opened.expires_at_ms,
            content: privateHistoryContent(opened)
          }
        };
      }
      case "subscription-set": {
        if (operation.channels.length > CHANNEL_MAX_SUBSCRIPTIONS_PER_CALLER) throw new Error("Too many Channel subscriptions");
        for (const channel of operation.channels) {
          validateExactChannel(channel);
          if (channel.startsWith("bsv8.inbox.")) {
            if (!deps.allowedInbox(operation.caller, channel)) {
              throw new Error("bsv8.inbox.* is reserved for the current owner inbox router");
            }
          }
        }
        const channels = await mux.set(callerId, operation.channels, requestSignal);
        if (requestSignal?.aborted || deps.disconnected(actualClientId)) {
          return deps.disconnectedResponse(request.requestId);
        }
        if (request.expectedSessionEpoch !== deps.session().sessionEpoch
          || deps.session().vaultStatus !== "unlocked"
          || deps.session().activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Channel subscription became stale after reconciliation");
        }
        if (operation.caller.kind === "connect") {
          const session = await deps.connectSession(operation.caller.connectSessionId);
          if (!session || session.revokedAt !== null || session.origin !== operation.caller.origin || session.ownerPublicKeyHex !== operation.ownerPublicKeyHex) {
            throw new Error("Channel Connect session was revoked during subscription reconciliation");
          }
        }
        return {
          requestId: request.requestId,
          sessionEpoch: deps.session().sessionEpoch,
          ack: { status: "ok" },
          operationResult: {
            channels,
            // Return the authoritative state observed by this Mux after the
            // logical set. This also covers a caller joining an already
            // physically subscribed channel.
            statuses: channels.map((channel) => mux.subscriptionStatus(channel)),
          }
        };
      }
      case "release":
        await mux.release(callerId, requestSignal);
        deps.callers.get(actualClientId)?.delete(callerId);
        return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "ok" }, operationResult: null };
    }
    throw new Error("Unsupported Channel operation");
  };
}
