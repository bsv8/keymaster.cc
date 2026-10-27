// WebRTC 信令适配层。
//
// 内部复用 ChannelProtocol 的严格信令类型与 parser：
// `{ request_message_id, session_id, signal }`。
// 联系人通信在线上使用 bsv8.message.v1 的 keymaster.webrtc.signal 内容，
// 将 request_message_id 映射为原私信邀请的 request_id，不依赖公开 Hash 请求。
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
} from "bsv8-channel-protocol";

export { WEBRTC_SIGNAL_PROTOCOL } from "bsv8-channel-protocol/webrtc-signal";
export type { MessageID, SessionID } from "bsv8-channel-protocol";
export type { ICECandidate, Signal, WebRTCSignalV1Body };

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

/** 内部 WebRTC body；联系人 APP 信令在服务边界映射邀请编号。 */
export type WebrtcSignal = WebRTCSignalV1Body;

/** offer body 的精确类型。 */
export type WebrtcInviteSignal = WebRTCSignalV1Body & { signal: OfferSignal };

/** answer body 的精确类型。 */
export type WebrtcAnswerSignal = WebRTCSignalV1Body & { signal: AnswerSignal };

/** ICE body 的精确类型。 */
export type WebrtcIceSignal = WebRTCSignalV1Body & { signal: Extract<Signal, { type: "ice-candidate" }> };

/** end-of-candidates body 的精确类型。 */
export type WebrtcEndOfCandidatesSignal = WebRTCSignalV1Body & { signal: EndOfCandidatesSignal };

/** 解析结果；失败时调用方应直接丢弃。 */
export type ParseSignalResult =
  | { ok: true; signal: WebrtcSignal }
  | { ok: false; reason: string };

/** 把精确 body 序列化为 JSON，结果可直接交给 ChannelProtocol parser。 */
export function serializeSignal(signal: WebrtcSignal): string {
  protocolValidateBody(signal);
  return JSON.stringify(signal);
}

/** 将 JSON 文本或 Channel content 交给同一真实 ChannelProtocol parser。 */
export function parseSignal(value: unknown): ParseSignalResult {
  try {
    const signal = typeof value === "string" ? protocolParseBody(value) : protocolParseBodyValue(value as Parameters<typeof protocolParseBodyValue>[0]);
    return { ok: true, signal };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
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
