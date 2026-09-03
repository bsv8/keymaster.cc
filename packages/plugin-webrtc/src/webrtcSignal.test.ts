// WebRTC 信令必须与真实 ChannelProtocol WebRTC parser 完全兼容。

import { describe, expect, it } from "vitest";
import { newMessageID, newSessionID } from "bsv8-channel-protocol";
import { parseBody as parseProtocolBody } from "bsv8-channel-protocol/webrtc-signal";
import {
  isAcceptableRemoteSession,
  newAnswerSignal,
  newEndOfCandidatesSignal,
  newIceSignal,
  newOfferSignal,
  parseSignalBody,
  parseSignalValue,
  serializeSignal,
  tryParseSignal
} from "./webrtcSignal.js";

function ids(): { requestMessageId: string; sessionId: string } {
  return { requestMessageId: newMessageID(), sessionId: newSessionID() };
}

describe("ChannelProtocol WebRTC body", () => {
  it("uses the exact current protocol shape", () => {
    const { requestMessageId, sessionId } = ids();
    const signal = newOfferSignal(requestMessageId, sessionId, "v=0\\r\\nm=audio 9 RTP/AVP 0");
    const encoded = JSON.parse(serializeSignal(signal)) as Record<string, unknown>;
    expect(Object.keys(encoded).sort()).toEqual(["request_message_id", "session_id", "signal"]);
    expect(encoded).not.toHaveProperty("schema");
    expect(encoded).not.toHaveProperty("sessionId");
    expect(parseProtocolBody(serializeSignal(signal))).toEqual(signal);
  });

  it("rejects the removed Keymaster envelope", () => {
    const result = parseSignalBody(JSON.stringify({
      schema: "keymaster.webrtc.v1",
      type: "invite",
      sessionId: "legacy",
      createdAtMs: 1,
      expiresAtMs: 2,
      mode: "audio",
      sdp: "v=0"
    }));
    expect(result.ok).toBe(false);
  });

  it("round-trips offer, answer, ICE, and end-of-candidates", () => {
    const { requestMessageId, sessionId } = ids();
    const bodies = [
      newOfferSignal(requestMessageId, sessionId, "offer-sdp"),
      newAnswerSignal(requestMessageId, sessionId, "answer-sdp"),
      newIceSignal(requestMessageId, sessionId, {
        candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host",
        sdp_mid: null,
        sdp_m_line_index: 0
      }),
      newEndOfCandidatesSignal(requestMessageId, sessionId)
    ];
    for (const body of bodies) {
      expect(parseSignalBody(serializeSignal(body))).toEqual({ ok: true, signal: body });
      expect(parseSignalValue(body)).toEqual({ ok: true, signal: body });
      expect(tryParseSignal(body)).toEqual(body);
    }
  });

  it("only accepts non-offer signals for the same request/session pair", () => {
    const local = ids();
    const other = ids();
    const answer = newAnswerSignal(local.requestMessageId, local.sessionId, "answer");
    expect(isAcceptableRemoteSession(answer, local)).toBe(true);
    expect(isAcceptableRemoteSession(answer, other)).toBe(false);
    expect(isAcceptableRemoteSession(newOfferSignal(other.requestMessageId, other.sessionId, "offer"), null)).toBe(true);
  });
});
