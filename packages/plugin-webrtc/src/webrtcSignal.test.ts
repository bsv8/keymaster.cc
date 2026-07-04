// packages/plugin-webrtc/src/webrtcSignal.test.ts
// 信令协议编解码 / 校验 / 过期 / sessionId 一致性单测。

import { describe, expect, it } from "vitest";
import {
  WEBRTC_SIGNAL_SCHEMA,
  buildEnvelopeBase,
  isAcceptableRemoteSessionId,
  isSignalExpired,
  parseSignalBody,
  serializeSignal,
  tryParseSignal,
  type WebrtcInviteSignal
} from "./webrtcSignal.js";
import type { AppMsgMessage } from "@keymaster/contracts";

function makeEnvelope(overrides: Partial<{
  sessionId: string;
  createdAtMs: number;
  expiresAtMs: number;
}> = {}): {
  schema: typeof WEBRTC_SIGNAL_SCHEMA;
  sessionId: string;
  createdAtMs: number;
  expiresAtMs: number;
} {
  return {
    schema: WEBRTC_SIGNAL_SCHEMA,
    sessionId: "sess-1",
    createdAtMs: 1000,
    expiresAtMs: 2000,
    ...overrides
  } as {
    schema: typeof WEBRTC_SIGNAL_SCHEMA;
    sessionId: string;
    createdAtMs: number;
    expiresAtMs: number;
  };
}

describe("parseSignalBody", () => {
  it("rejects non-string body", () => {
    const res = parseSignalBody(123 as unknown as string);
    expect(res.ok).toBe(false);
  });

  it("rejects invalid JSON body", () => {
    const res = parseSignalBody("not json");
    expect(res.ok).toBe(false);
  });

  it("rejects unknown schema", () => {
    const body = JSON.stringify({
      schema: "other.v1",
      type: "invite",
      sessionId: "x",
      createdAtMs: 1,
      expiresAtMs: 2,
      mode: "audio",
      sdp: "v=0"
    });
    const res = parseSignalBody(body);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("schema_mismatch");
  });

  it("rejects missing sessionId", () => {
    const body = JSON.stringify({
      schema: WEBRTC_SIGNAL_SCHEMA,
      type: "invite",
      createdAtMs: 1,
      expiresAtMs: 2,
      mode: "audio",
      sdp: "v=0"
    });
    const res = parseSignalBody(body);
    expect(res.ok).toBe(false);
  });

  it("rejects unknown type", () => {
    const body = JSON.stringify({
      schema: WEBRTC_SIGNAL_SCHEMA,
      type: "magic",
      sessionId: "x",
      createdAtMs: 1,
      expiresAtMs: 2
    });
    const res = parseSignalBody(body);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown_type");
  });

  it("parses invite with audio mode", () => {
    const res = parseSignalBody(
      JSON.stringify({
        ...makeEnvelope({ expiresAtMs: 9999 }),
        type: "invite",
        mode: "audio",
        sdp: "v=0"
      })
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.signal.type).toBe("invite");
      if (res.signal.type === "invite") {
        expect(res.signal.mode).toBe("audio");
        expect(res.signal.sdp).toBe("v=0");
      }
    }
  });

  it("rejects invite with missing mode", () => {
    const body = JSON.stringify({
      ...makeEnvelope(),
      type: "invite",
      sdp: "v=0"
    });
    const res = parseSignalBody(body);
    expect(res.ok).toBe(false);
  });

  it("parses answer and reject signals with required reasons", () => {
    const ans = parseSignalBody(
      JSON.stringify({
        ...makeEnvelope(),
        type: "answer",
        mode: "video",
        sdp: "v=0"
      })
    );
    expect(ans.ok).toBe(true);

    const rej = parseSignalBody(
      JSON.stringify({
        ...makeEnvelope(),
        type: "reject",
        reason: "audio_unavailable"
      })
    );
    expect(rej.ok).toBe(true);

    const badRej = parseSignalBody(
      JSON.stringify({
        ...makeEnvelope(),
        type: "reject",
        reason: "lol"
      })
    );
    expect(badRej.ok).toBe(false);
  });

  it("parses ice signal with candidate payload", () => {
    const res = parseSignalBody(
      JSON.stringify({
        ...makeEnvelope(),
        type: "ice",
        candidate: {
          candidate: "candidate:1 1 udp 1 1.2.3.4 1234 typ srflx",
          sdpMid: "0",
          sdpMLineIndex: 0
        }
      })
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.signal.type).toBe("ice");
    }
  });

  it("parses fallback_required and hangup with allowed reasons", () => {
    const fb = parseSignalBody(
      JSON.stringify({
        ...makeEnvelope(),
        type: "fallback_required",
        reason: "video_unavailable",
        suggestedMode: "audio"
      })
    );
    expect(fb.ok).toBe(true);

    const hu = parseSignalBody(
      JSON.stringify({
        ...makeEnvelope(),
        type: "hangup",
        reason: "ice_disconnected"
      })
    );
    expect(hu.ok).toBe(true);

    const badHu = parseSignalBody(
      JSON.stringify({
        ...makeEnvelope(),
        type: "hangup",
        reason: "weird"
      })
    );
    expect(badHu.ok).toBe(false);
  });
});

describe("serializeSignal roundtrip", () => {
  it("serialize + parse yields the same signal", () => {
    const sig: WebrtcInviteSignal = {
      ...buildEnvelopeBase({ sessionId: "abc", nowMs: 100, ttlMs: 1000 }),
      type: "invite",
      mode: "audio",
      sdp: "v=0"
    };
    const body = serializeSignal(sig);
    const res = parseSignalBody(body);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.signal.type).toBe("invite");
      if (res.signal.type === "invite") {
        expect(res.signal.mode).toBe("audio");
        expect(res.signal.sdp).toBe("v=0");
      }
    }
  });
});

describe("isSignalExpired", () => {
  it("true when expiresAtMs <= now", () => {
    const env1: import("./webrtcSignal.js").WebrtcSignalEnvelope = {
      ...makeEnvelope({ expiresAtMs: 100 }),
      type: "invite"
    };
    const env2: import("./webrtcSignal.js").WebrtcSignalEnvelope = {
      ...makeEnvelope({ expiresAtMs: 999 }),
      type: "invite"
    };
    expect(isSignalExpired(env1, 1000)).toBe(true);
    expect(isSignalExpired(env2, 1000)).toBe(true);
  });

  it("false when expiresAtMs > now", () => {
    const env: import("./webrtcSignal.js").WebrtcSignalEnvelope = {
      ...makeEnvelope({ expiresAtMs: 1500 }),
      type: "invite"
    };
    expect(isSignalExpired(env, 1000)).toBe(false);
  });
});

describe("isAcceptableRemoteSessionId", () => {
  it("invite is always acceptable", () => {
    const env: import("./webrtcSignal.js").WebrtcSignalEnvelope = {
      ...makeEnvelope(),
      type: "invite"
    };
    expect(isAcceptableRemoteSessionId(env, null)).toBe(true);
    expect(isAcceptableRemoteSessionId(env, "anything")).toBe(true);
  });

  it("non-invite with matching sessionId is acceptable", () => {
    const env: import("./webrtcSignal.js").WebrtcSignalEnvelope = {
      ...makeEnvelope({ sessionId: "abc" }),
      type: "answer"
    };
    expect(isAcceptableRemoteSessionId(env, "abc")).toBe(true);
    expect(isAcceptableRemoteSessionId(env, "xyz")).toBe(false);
    expect(isAcceptableRemoteSessionId(env, null)).toBe(false);
  });
});

describe("tryParseSignal", () => {
  function makeMsg(body: string, contentType: "text/plain" | "text/markdown" = "text/plain"): AppMsgMessage {
    return {
      messageId: "m-1",
      clientMessageId: "cm-1",
      senderPublicKeyHex: "02aaaa".padEnd(66, "a"),
      recipientPublicKeyHex: "02bbbb".padEnd(66, "b"),
      contentType,
      body,
      createdAtMs: 1,
      insertedAtMs: 1
    };
  }

  it("returns null for non-text-plain content", () => {
    const msg = makeMsg("hi", "text/markdown");
    expect(tryParseSignal(msg)).toBeNull();
  });

  it("returns null for invalid body", () => {
    expect(tryParseSignal(makeMsg("not-json"))).toBeNull();
  });

  it("returns parsed signal for valid envelope", () => {
    const body = JSON.stringify({
      ...makeEnvelope(),
      type: "invite",
      mode: "audio",
      sdp: "v=0"
    });
    const sig = tryParseSignal(makeMsg(body));
    expect(sig).not.toBeNull();
    expect(sig?.type).toBe("invite");
  });
});
