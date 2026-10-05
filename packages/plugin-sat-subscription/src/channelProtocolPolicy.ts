import type { CoordinatorChannelOperation, SessionEpoch } from "@keymaster/contracts";
import { inboxChannel, parsePublicKey, parseMessageID } from "bsv8-channel-protocol";
import { APP_MESSAGE_PROTOCOL, newAck, newDeliver } from "bsv8-channel-protocol/app-message";
import { PING_PROTOCOL, parseBodyValue as parsePingBodyValue } from "bsv8-channel-protocol/ping";
import { WEBRTC_SIGNAL_PROTOCOL, parseBodyValue as parseWebrtcBodyValue } from "bsv8-channel-protocol/webrtc-signal";
export type ChannelPrivateProtocol = typeof APP_MESSAGE_PROTOCOL | typeof WEBRTC_SIGNAL_PROTOCOL | typeof PING_PROTOCOL;
export type ChannelCaller = Extract<CoordinatorChannelOperation, { type: "subscription-set" }>['caller'];
export type ChannelOperationCaller = Extract<CoordinatorChannelOperation, { type: "private-publish" }>['caller'];
const CHANNEL_PROTOCOLS = new Set([APP_MESSAGE_PROTOCOL, WEBRTC_SIGNAL_PROTOCOL, PING_PROTOCOL]);
const TRUSTED_CHANNEL_PLUGIN_IDS = new Set(["bsv-price", "message", "webrtc", "msfile"]);
const TRUSTED_CHANNEL_SYSTEM_IDS = new Set(["owner-inbox", "contacts-presence"]);
export function isPingRequestBody(
  body: import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage["body"]
): body is import("bsv8-channel-protocol/ping").PingBody {
  return body !== null
    && typeof body === "object"
    && !Array.isArray(body)
    && "type" in body
    && body.type === "ping";
}

export function privateProtocol(protocol: string): ChannelPrivateProtocol {
  if (CHANNEL_PROTOCOLS.has(protocol as ChannelPrivateProtocol)) return protocol as ChannelPrivateProtocol;
  throw new Error("Unsupported private Channel protocol");
}

export function validatePrivateProtocolCaller(caller: ChannelOperationCaller, protocol: ChannelPrivateProtocol): void {
  if (caller.kind === "connect") throw new Error("Connect caller cannot publish private inbox messages");
  if (caller.kind === "plugin") {
    if (caller.pluginId === "message" && protocol === APP_MESSAGE_PROTOCOL) return;
    // WebRTC 通话控制仍走 app-message；BitFS 文件需求走公开 Hash channel；
    // SDP/ICE 统一走 WEBRTC_SIGNAL_PROTOCOL。
    if (caller.pluginId === "webrtc" && (protocol === WEBRTC_SIGNAL_PROTOCOL || protocol === APP_MESSAGE_PROTOCOL)) return;
    if (caller.pluginId === "msfile" && protocol === WEBRTC_SIGNAL_PROTOCOL) return;
    throw new Error("Channel plugin is not allowed to publish this private protocol");
  }
  if (caller.systemId === "contacts-presence" && protocol === PING_PROTOCOL) return;
  throw new Error("Channel system is not allowed to publish this private protocol");
}

/** 把已验证历史信封转换成给消息插件的业务 JSON；不投递、不产生副作用。 */
export function privateHistoryContent(opened: import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage): import("@keymaster/contracts").JSONValue {
  if (opened.protocol === APP_MESSAGE_PROTOCOL) {
    const body = opened.body as import("bsv8-channel-protocol/app-message").MessageV1Body;
    return body.type === "deliver"
      ? body.content as import("@keymaster/contracts").JSONValue
      : { type: "ack", acknowledged_message_id: body.acknowledged_message_id };
  }
  if (opened.protocol === PING_PROTOCOL) {
    return parsePingBodyValue(opened.body as unknown as import("bsv8-channel-protocol").JSONValue) as unknown as import("@keymaster/contracts").JSONValue;
  }
  if (opened.protocol === WEBRTC_SIGNAL_PROTOCOL) {
    return parseWebrtcBodyValue(opened.body as unknown as import("bsv8-channel-protocol").JSONValue) as unknown as import("@keymaster/contracts").JSONValue;
  }
  throw new Error("UNSUPPORTED_PROTOCOL");
}

export function privateBodyForPublish(protocol: string, content: import("@keymaster/contracts").JSONValue): import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage["body"] {
  const supportedProtocol = privateProtocol(protocol);
  if (supportedProtocol === APP_MESSAGE_PROTOCOL) {
    if (content !== null && typeof content === "object" && !Array.isArray(content) && content.type === "ack") {
      const acknowledged = content.acknowledged_message_id;
      if (typeof acknowledged !== "string") throw new Error("Message ACK must contain acknowledged_message_id");
      return newAck(parseMessageID(acknowledged));
    }
    return newDeliver(content as import("bsv8-channel-protocol").JSONValue);
  }
  if (supportedProtocol === WEBRTC_SIGNAL_PROTOCOL) return parseWebrtcBodyValue(content as import("bsv8-channel-protocol").JSONValue);
  if (supportedProtocol === PING_PROTOCOL) return parsePingBodyValue(content as import("bsv8-channel-protocol").JSONValue);
  throw new Error("Unsupported private Channel protocol");
}

export function createChannelCallerPolicy(deps: { sessionEpoch(): SessionEpoch; ownerPublicKeyHex(): string | undefined }) {
function channelCallerId(caller: ChannelCaller, clientId?: string): string {
  const epoch = deps.sessionEpoch();
  // Window Host 是独立运行实例；把 Coordinator 生成的端口身份加入
  // caller key，避免一个页面卸载时释放另一个页面仍在使用的订阅。
  const instanceSuffix = clientId ? `:${clientId}` : "";
  if (caller.kind === "plugin") {
    if (!caller.pluginId || caller.pluginId.length > 128 || !TRUSTED_CHANNEL_PLUGIN_IDS.has(caller.pluginId)) {
      throw new Error("Channel plugin caller id is not trusted");
    }
    return `${epoch}:plugin:${caller.pluginId}${instanceSuffix}`;
  }
  if (caller.kind === "system") {
    if (!caller.systemId || caller.systemId.length > 128 || !TRUSTED_CHANNEL_SYSTEM_IDS.has(caller.systemId)) {
      throw new Error("Channel system caller id is not trusted");
    }
    return `${epoch}:system:${caller.systemId}${instanceSuffix}`;
  }
  if (!caller.connectSessionId || !caller.origin) throw new Error("Channel Connect caller is incomplete");
  return `${epoch}:connect:${caller.connectSessionId}:${caller.origin}${instanceSuffix}`;
}

function isActiveOwnerInboxChannel(channel: string): boolean {
  const owner = deps.ownerPublicKeyHex();
  if (!owner) return false;
  try {
    return channel === inboxChannel(parsePublicKey(owner));
  } catch {
    return false;
  }
}

function isAllowedOwnerInboxSubscription(caller: ChannelCaller, channel: string): boolean {
  if (!isActiveOwnerInboxChannel(channel)) return false;
  // owner-inbox / contacts-presence 是 Coordinator 内部系统路由；message /
  // webrtc 是 Host 绑定身份的内部插件路由。Connect 和其他插件不能订阅
  // 任意 bsv8.inbox.*，避免把私有收件箱暴露成公共事件流。
  if (caller.kind === "system") {
    return caller.systemId === "owner-inbox" || caller.systemId === "contacts-presence";
  }
  return caller.kind === "plugin" && (caller.pluginId === "message" || caller.pluginId === "webrtc" || caller.pluginId === "msfile");
}

  return { callerId: channelCallerId, allowsOwnerInboxSubscription: isAllowedOwnerInboxSubscription };
}
