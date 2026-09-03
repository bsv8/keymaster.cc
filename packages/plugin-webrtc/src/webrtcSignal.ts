// WebRTC 信令适配层。
//
// 线上 body 必须完全采用 ChannelProtocol 的
// `bsv8.webrtc.signal.v1` 结构：
// `{ request_message_id, session_id, signal }`。
//
// ChannelProtocol V1 只定义 offer / answer / ice-candidate /
// end-of-candidates 四个分支。reject、busy、hangup 属于本地会话控制；文件
// 传输的元数据和分片属于已经建立的 WebRTC DataChannel，不能塞进这个协议。

import {
  newAnswer as protocolNewAnswer,
  newEndOfCandidates as protocolNewEndOfCandidates,
  newICECandidate as protocolNewICECandidate,
  newOffer as protocolNewOffer,
  parseBody as protocolParseBody,
  parseBodyValue as protocolParseBodyValue,
  validateBody as protocolValidateBody,
  type AnswerSignal,
  type EndOfCandidatesSignal,
  type ICECandidate,
  type OfferSignal,
  type Signal,
  type WebRTCSignalV1Body
} from "bsv8-channel-protocol/webrtc-signal";
import {
  parseMessageID,
  parseSessionID,
  type MessageID,
  type SessionID
} from "bsv8-channel-protocol";

export { WEBRTC_SIGNAL_PROTOCOL } from "bsv8-channel-protocol/webrtc-signal";
export type { ICECandidate, MessageID, SessionID, Signal, WebRTCSignalV1Body };

/** ChannelProtocol WebRTC 协议标识；保留旧常量名仅用于源码兼容，不会写入 body。 */
export const WEBRTC_SIGNAL_SCHEMA = "bsv8.webrtc.signal.v1" as const;

/** ChannelProtocol WebRTC body 的最长有效期。实际时间校验由 Coordinator 完成。 */
export const DEFAULT_SIGNAL_TTL_MS = 2 * 60 * 1000;

/** WebRTC signal.type。 */
export type WebrtcSignalType = Signal["type"];

/** 业务层媒体模式；模式由 SDP 的 media section 表达，不是线上 body 字段。 */
export type WebrtcMode = "audio" | "video";

/** 本地拒绝原因，不属于 ChannelProtocol WebRTC wire。 */
export type WebrtcRejectReason = "audio_unavailable" | "declined" | "expired" | "invalid_state";

/** 本地挂断原因，不属于 ChannelProtocol WebRTC wire。 */
export type WebrtcHangupReason = "hangup" | "ice_disconnected" | "page_unload";

/** DataChannel 传输拒绝原因，不属于 ChannelProtocol WebRTC wire。 */
export type WebrtcTransferRejectReason = "busy" | "invalid_state" | "file_too_large";

/** 本地回退建议；V1 不通过信令发送。 */
export type WebrtcSuggestedMode = WebrtcMode;

/** Keymaster 使用的 WebRTC body。字段与 ChannelProtocol 完全一致。 */
export type WebrtcSignal = WebRTCSignalV1Body;

/** offer body 的精确类型。 */
export type WebrtcInviteSignal = WebRTCSignalV1Body & { signal: OfferSignal };

/** answer body 的精确类型。 */
export type WebrtcAnswerSignal = WebRTCSignalV1Body & { signal: AnswerSignal };

/** ICE body 的精确类型。 */
export type WebrtcIceSignal = WebRTCSignalV1Body & { signal: Extract<Signal, { type: "ice-candidate" }> };

/** end-of-candidates body 的精确类型。 */
export type WebrtcEndOfCandidatesSignal = WebRTCSignalV1Body & { signal: EndOfCandidatesSignal };

/** 兼容旧调用方的 envelope 类型；新代码不应构造或发送该类型。 */
export type WebrtcSignalEnvelope = WebrtcSignal;

/** 旧控制类型不再是 WebRTC wire 分支，保留类型别名以便业务 API 编译。 */
export type WebrtcRejectSignal = never;
export type WebrtcBusySignal = never;
export type WebrtcHangupSignal = never;
export type WebrtcFallbackRequiredSignal = never;
export type WebrtcTransferInviteSignal = never;
export type WebrtcTransferAnswerSignal = never;
export type WebrtcTransferRejectSignal = never;

/** 解析结果；失败时调用方应直接丢弃。 */
export type ParseSignalResult =
  | { ok: true; signal: WebrtcSignal }
  | { ok: false; reason: string };

/** 把精确 body 序列化为 JSON，结果可直接交给 ChannelProtocol parser。 */
export function serializeSignal(signal: WebrtcSignal): string {
  protocolValidateBody(signal);
  return JSON.stringify(signal);
}

/** 将 JSON 文本交给真实 ChannelProtocol parser。 */
export function parseSignalBody(body: string): ParseSignalResult {
  if (typeof body !== "string") return { ok: false, reason: "body_not_string" };
  try {
    return { ok: true, signal: protocolParseBody(body) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 将 Channel content 交给真实 ChannelProtocol parser。 */
export function parseSignalValue(value: unknown): ParseSignalResult {
  try {
    return { ok: true, signal: protocolParseBodyValue(value as Parameters<typeof protocolParseBodyValue>[0]) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 接收旧测试/边界调用的统一解析入口；不再接受旧 Keymaster envelope。 */
export function tryParseSignal(value: unknown): WebrtcSignal | null {
  const result = typeof value === "string" ? parseSignalBody(value) : parseSignalValue(value);
  return result.ok ? result.signal : null;
}

/** 创建 offer body。 */
export function newOfferSignal(requestMessageId: string, sessionId: string, sdp: string): WebrtcInviteSignal {
  return protocolNewOffer(parseMessageID(requestMessageId), parseSessionID(sessionId), sdp) as WebrtcInviteSignal;
}

/** 创建 answer body。 */
export function newAnswerSignal(requestMessageId: string, sessionId: string, sdp: string): WebrtcAnswerSignal {
  return protocolNewAnswer(parseMessageID(requestMessageId), parseSessionID(sessionId), sdp) as WebrtcAnswerSignal;
}

/** 创建 ICE body。 */
export function newIceSignal(
  requestMessageId: string,
  sessionId: string,
  candidate: ICECandidate
): WebrtcIceSignal {
  return protocolNewICECandidate(parseMessageID(requestMessageId), parseSessionID(sessionId), candidate) as WebrtcIceSignal;
}

/** 创建候选发送结束 body。 */
export function newEndOfCandidatesSignal(requestMessageId: string, sessionId: string): WebrtcEndOfCandidatesSignal {
  return protocolNewEndOfCandidates(parseMessageID(requestMessageId), parseSessionID(sessionId)) as WebrtcEndOfCandidatesSignal;
}

/** 读取 signal 分支类型。 */
export function signalType(signal: WebrtcSignal): WebrtcSignalType {
  return signal.signal.type;
}

/** 非 offer 必须附着在本地已知的 request/session 二元组上。 */
export function isAcceptableRemoteSession(
  signal: WebrtcSignal,
  local: { requestMessageId: string; sessionId: string } | null
): boolean {
  if (signal.signal.type === "offer") return true;
  return local !== null
    && signal.request_message_id === local.requestMessageId
    && signal.session_id === local.sessionId;
}

/**
 * 兼容旧 API 名称：现在只校验 request/session，不再按旧 envelope 的 type 判断。
 */
export function isAcceptableRemoteSessionId(
  signal: WebrtcSignal,
  localSessionId: string | null,
  localRequestMessageId?: string
): boolean {
  if (signal.signal.type === "offer") return true;
  return localSessionId !== null
    && localRequestMessageId !== undefined
    && signal.session_id === localSessionId
    && signal.request_message_id === localRequestMessageId;
}

/** 时间字段由 ChannelProtocol inbox.open 校验；插件层不维护第二套 envelope。 */
export function isSignalExpired(_signal: WebrtcSignal, _nowMs: number): boolean {
  return false;
}

/** 仅供需要显式标注 branded ID 的调用方使用。 */
export function asMessageId(value: string): MessageID {
  return parseMessageID(value);
}

/** 仅供需要显式标注 branded ID 的调用方使用。 */
export function asSessionId(value: string): SessionID {
  return parseSessionID(value);
}
