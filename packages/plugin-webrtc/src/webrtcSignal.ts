// packages/plugin-webrtc/src/webrtcSignal.ts
// WebRTC 信令协议编码 / 解码 / 校验（施工单 2026-07-04 002 硬切换）。
//
// 设计缘由：
//   - 信令统一走 `contentType = "text/plain"` + `body = JSON.stringify(envelope)`，
//     **不**扩张 appmsg 的 `contentType` 契约；
//   - 公共 envelope 至少带 `schema / type / sessionId / createdAtMs / expiresAtMs`
//     四要素（schema + expiresAtMs 用于"非法 / 过期"fail-closed 过滤）；
//   - 解码失败**不**抛错，返回结构化解析结果（`ok: false, reason`）；
//     调用方在订阅回调里直接判断并丢弃。
//
// 失败语义：
//   - `parseSignalBody(body)`：body 不是 string / JSON 不合法 / 字段缺失或类型错
//     → `{ ok: false, reason: "<具体原因>" }`；
//   - `isSignalExpired(env, now)`：true → 调用方丢弃且**不**回包；
//   - `isAcceptableRemoteSessionId(env, localSessionId)`：用于"陌生 sessionId 的
//     answer/ice/hangup 必须 fail-closed"边界；
//   - `ice` 同时服务通话会话和 transfer 会话，是否路由到哪类活动会话由
//     service 按当前 active / activeTransfer 真值决定。

import type { AppMsgMessage } from "@keymaster/contracts";

/** 信令 schema 版本；版本变化时整体走 fail-closed。 */
export const WEBRTC_SIGNAL_SCHEMA = "keymaster.webrtc.v1";

/** 信令默认过期时长（发起者写入到 `expiresAtMs`）。 */
export const DEFAULT_SIGNAL_TTL_MS = 60_000;

/** 信令类型。 */
export type WebrtcSignalType =
  | "invite"
  | "answer"
  | "ice"
  | "reject"
  | "busy"
  | "hangup"
  | "fallback_required"
  | "transfer_invite"
  | "transfer_answer"
  | "transfer_reject";

/** 信令拒绝原因。 */
export type WebrtcRejectReason =
  | "audio_unavailable"
  | "declined"
  | "expired"
  | "invalid_state";

/** 信令挂断原因。 */
export type WebrtcHangupReason = "hangup" | "ice_disconnected" | "page_unload";

/** 传输拒绝原因。 */
export type WebrtcTransferRejectReason = "busy" | "invalid_state" | "file_too_large";

/** 信令模式（业务层与本协议层语义相同）。 */
export type WebrtcMode = "audio" | "video";

/** 信令建议回退模式：当前 v1 仅支持 `audio`。 */
export type WebrtcSuggestedMode = WebrtcMode;

/** 公共 envelope 字段。 */
export interface WebrtcSignalEnvelope {
  schema: typeof WEBRTC_SIGNAL_SCHEMA;
  type: WebrtcSignalType;
  sessionId: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/** `invite` 信令。 */
export interface WebrtcInviteSignal extends WebrtcSignalEnvelope {
  type: "invite";
  mode: "audio" | "video";
  sdp: string;
}

/** `answer` 信令。 */
export interface WebrtcAnswerSignal extends WebrtcSignalEnvelope {
  type: "answer";
  mode: "audio" | "video";
  sdp: string;
}

/** `ice` 信令。 */
export interface WebrtcIceSignal extends WebrtcSignalEnvelope {
  type: "ice";
  candidate: RTCIceCandidateInit;
}

/** `reject` 信令。 */
export interface WebrtcRejectSignal extends WebrtcSignalEnvelope {
  type: "reject";
  reason: WebrtcRejectReason;
}

/** `busy` 信令。 */
export interface WebrtcBusySignal extends WebrtcSignalEnvelope {
  type: "busy";
  reason: "busy";
}

/** `hangup` 信令。 */
export interface WebrtcHangupSignal extends WebrtcSignalEnvelope {
  type: "hangup";
  reason: WebrtcHangupReason;
}

/** `fallback_required` 信令。 */
export interface WebrtcFallbackRequiredSignal extends WebrtcSignalEnvelope {
  type: "fallback_required";
  reason: "video_unavailable";
  suggestedMode: WebrtcSuggestedMode;
}

/** `transfer_invite` 信令。 */
export interface WebrtcTransferInviteSignal extends WebrtcSignalEnvelope {
  type: "transfer_invite";
  kind: "image" | "file";
  fileName?: string;
  mimeType?: string;
  byteLength: number;
  sdp: string;
}

/** `transfer_answer` 信令。 */
export interface WebrtcTransferAnswerSignal extends WebrtcSignalEnvelope {
  type: "transfer_answer";
  sdp: string;
}

/** `transfer_reject` 信令。 */
export interface WebrtcTransferRejectSignal extends WebrtcSignalEnvelope {
  type: "transfer_reject";
  reason: WebrtcTransferRejectReason;
}

/** 所有信令 union。 */
export type WebrtcSignal =
  | WebrtcInviteSignal
  | WebrtcAnswerSignal
  | WebrtcIceSignal
  | WebrtcRejectSignal
  | WebrtcBusySignal
  | WebrtcHangupSignal
  | WebrtcFallbackRequiredSignal
  | WebrtcTransferInviteSignal
  | WebrtcTransferAnswerSignal
  | WebrtcTransferRejectSignal;

/** 信令解析结果。失败原因只用于诊断，**不**展示到 UI。 */
export type ParseSignalResult =
  | { ok: true; signal: WebrtcSignal }
  | { ok: false; reason: string };

/**
 * 把信令对象序列化成 appmsg body。
 *
 * 不做"美化"、不做"去掉 undefined"——序列化产物自身是稳定可重新解析的
 * 字符串即可；解码侧的形状校验才是稳定性边界。
 */
export function serializeSignal(signal: WebrtcSignal): string {
  return JSON.stringify(signal);
}

/**
 * 解码 appmsg body 成信令对象。
 *
 * 失败语义：
 *   - body 不是 string / 不是合法 JSON → `ok: false`；
 *   - 字段缺失 / 类型错 / schema 不一致 / type 不识别 → `ok: false`；
 *   - **不**抛错；调用方拿到失败结果丢弃即可。
 */
export function parseSignalBody(body: string): ParseSignalResult {
  if (typeof body !== "string") {
    return { ok: false, reason: "body_not_string" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isObject(raw)) {
    return { ok: false, reason: "not_object" };
  }
  const env = raw as Record<string, unknown>;

  if (env.schema !== WEBRTC_SIGNAL_SCHEMA) {
    return { ok: false, reason: "schema_mismatch" };
  }
  if (!isString(env.sessionId) || env.sessionId.length === 0) {
    return { ok: false, reason: "missing_session_id" };
  }
  if (!isNumber(env.createdAtMs) || env.createdAtMs <= 0) {
    return { ok: false, reason: "missing_created_at" };
  }
  if (!isNumber(env.expiresAtMs) || env.expiresAtMs <= 0) {
    return { ok: false, reason: "missing_expires_at" };
  }
  const type = env.type;
  if (!isString(type)) {
    return { ok: false, reason: "missing_type" };
  }

  const base = {
    schema: WEBRTC_SIGNAL_SCHEMA as typeof WEBRTC_SIGNAL_SCHEMA,
    sessionId: env.sessionId,
    createdAtMs: env.createdAtMs,
    expiresAtMs: env.expiresAtMs
  };

  switch (type) {
    case "invite": {
      if (!isString(env.sdp)) return { ok: false, reason: "invite_missing_sdp" };
      const mode = env.mode;
      if (mode !== "audio" && mode !== "video") {
        return { ok: false, reason: "invite_missing_mode" };
      }
      return { ok: true, signal: { ...base, type, mode, sdp: env.sdp } };
    }
    case "answer": {
      if (!isString(env.sdp)) return { ok: false, reason: "answer_missing_sdp" };
      const mode = env.mode;
      if (mode !== "audio" && mode !== "video") {
        return { ok: false, reason: "answer_missing_mode" };
      }
      return { ok: true, signal: { ...base, type, mode, sdp: env.sdp } };
    }
    case "ice": {
      if (!isObject(env.candidate)) {
        return { ok: false, reason: "ice_missing_candidate" };
      }
      const cand = env.candidate as Record<string, unknown>;
      const out: RTCIceCandidateInit = {};
      if (typeof cand.candidate === "string") out.candidate = cand.candidate;
      if (typeof cand.sdpMid === "string") out.sdpMid = cand.sdpMid;
      if (typeof cand.sdpMLineIndex === "number") out.sdpMLineIndex = cand.sdpMLineIndex;
      if (typeof cand.usernameFragment === "string") {
        out.usernameFragment = cand.usernameFragment;
      }
      return { ok: true, signal: { ...base, type, candidate: out } };
    }
    case "reject": {
      const reason = env.reason;
      const allowed: WebrtcRejectReason[] = [
        "audio_unavailable",
        "declined",
        "expired",
        "invalid_state"
      ];
      if (typeof reason !== "string" || !allowed.includes(reason as WebrtcRejectReason)) {
        return { ok: false, reason: "reject_missing_reason" };
      }
      return {
        ok: true,
        signal: { ...base, type, reason: reason as WebrtcRejectReason }
      };
    }
    case "busy": {
      return { ok: true, signal: { ...base, type, reason: "busy" } };
    }
    case "hangup": {
      const reason = env.reason;
      const allowed: WebrtcHangupReason[] = [
        "hangup",
        "ice_disconnected",
        "page_unload"
      ];
      if (typeof reason !== "string" || !allowed.includes(reason as WebrtcHangupReason)) {
        return { ok: false, reason: "hangup_missing_reason" };
      }
      return {
        ok: true,
        signal: { ...base, type, reason: reason as WebrtcHangupReason }
      };
    }
    case "fallback_required": {
      const reason = env.reason;
      const suggestedMode = env.suggestedMode;
      if (reason !== "video_unavailable") {
        return { ok: false, reason: "fallback_required_bad_reason" };
      }
      if (suggestedMode !== "audio") {
        return { ok: false, reason: "fallback_required_bad_suggested" };
      }
      return { ok: true, signal: { ...base, type, reason, suggestedMode } };
    }
    case "transfer_invite": {
      if (env.kind !== "image" && env.kind !== "file") {
        return { ok: false, reason: "transfer_invite_missing_kind" };
      }
      if (!isString(env.sdp)) {
        return { ok: false, reason: "transfer_invite_missing_sdp" };
      }
      if (!isNumber(env.byteLength) || env.byteLength < 0) {
        return { ok: false, reason: "transfer_invite_missing_byte_length" };
      }
      const out: WebrtcTransferInviteSignal = {
        ...base,
        type,
        kind: env.kind,
        sdp: env.sdp,
        byteLength: env.byteLength
      };
      if (isString(env.fileName)) out.fileName = env.fileName;
      if (isString(env.mimeType)) out.mimeType = env.mimeType;
      return { ok: true, signal: out };
    }
    case "transfer_answer": {
      if (!isString(env.sdp)) {
        return { ok: false, reason: "transfer_answer_missing_sdp" };
      }
      return { ok: true, signal: { ...base, type, sdp: env.sdp } };
    }
    case "transfer_reject": {
      const reason = env.reason;
      const allowed: WebrtcTransferRejectReason[] = ["busy", "invalid_state", "file_too_large"];
      if (typeof reason !== "string" || !allowed.includes(reason as WebrtcTransferRejectReason)) {
        return { ok: false, reason: "transfer_reject_missing_reason" };
      }
      return {
        ok: true,
        signal: { ...base, type, reason: reason as WebrtcTransferRejectReason }
      };
    }
    default:
      return { ok: false, reason: "unknown_type" };
  }
}

/** 信令是否已过期。`nowMs` 缺省按 `Date.now()`。 */
export function isSignalExpired(env: WebrtcSignalEnvelope, nowMs = Date.now()): boolean {
  return env.expiresAtMs <= nowMs;
}

/**
 * 检查一条非 `invite` 信令的 sessionId 是否与"当前已存在会话的 sessionId"
 * 一致。**不**一致 → 视为非法包，丢弃。
 *
 * 设计缘由：施工单 §7.6——"只允许 `invite` / `transfer_invite` 开新会话；其它信令必须附着在
 * 已存在会话上"。
 *
 * `invite` / `transfer_invite` 信令**始终**允许通过（接收方在收到 invite 时建立新会话），调用方
 * 应在"已存在会话"判定为 false 时先 try-create 会话。
 */
export function isAcceptableRemoteSessionId(
  env: WebrtcSignalEnvelope,
  localSessionId: string | null
): boolean {
  if (env.type === "invite" || env.type === "transfer_invite") return true;
  if (localSessionId === null) return false;
  return env.sessionId === localSessionId;
}

/** 给一条入站 appmsg 消息尝试解析 webrtc 信令（只接受 text/plain 且 envelope）。 */
export function tryParseSignal(msg: AppMsgMessage): WebrtcSignal | null {
  if (msg.contentType !== "text/plain") return null;
  const parsed = parseSignalBody(msg.body);
  if (!parsed.ok) return null;
  return parsed.signal;
}

/** `Object` 类型守卫。 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `string` 类型守卫。 */
function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** 正数 `number` 类型守卫。 */
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 构造一个 envelope 公共字段对象。
 *
 * 只在 webrtcService 内部使用；公共入口是 service.startCall / 收到入站
 * 信令的回调。
 */
export function buildEnvelopeBase(input: {
  sessionId: string;
  ttlMs?: number;
  nowMs?: number;
}): Pick<WebrtcSignalEnvelope, "schema" | "sessionId" | "createdAtMs" | "expiresAtMs"> {
  const now = input.nowMs ?? Date.now();
  const ttl = input.ttlMs ?? DEFAULT_SIGNAL_TTL_MS;
  return {
    schema: WEBRTC_SIGNAL_SCHEMA,
    sessionId: input.sessionId,
    createdAtMs: now,
    expiresAtMs: now + ttl
  };
}
