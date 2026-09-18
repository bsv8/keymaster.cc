// packages/plugin-webrtc/src/storage/p2pSettingFileFormats.test.ts
// `p2p/setting.json` 编解码单测（KeymasterFormats《桶/<owner>/p2p/setting.json》）。

import { describe, expect, it } from "vitest";
import { DEFAULT_STUN_SERVERS } from "../webrtcConfig.js";
import {
  P2P_SETTING_FORMAT,
  P2P_SETTING_MAX_BYTES,
  P2P_SETTING_VERSION,
  parseP2pSettingFile,
  serializeP2pSettingFile,
} from "./p2pSettingFileFormats.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("parseP2pSettingFile", () => {
  it("parses a valid file and dedupes STUN entries", () => {
    const parsed = parseP2pSettingFile(encode(JSON.stringify({
      format: P2P_SETTING_FORMAT,
      version: P2P_SETTING_VERSION,
      stunServers: ["stun:a.example.com:3478", "stun:a.example.com:3478", "stun:b.example.com"],
    })));
    expect(parsed?.stunServers).toEqual(["stun:a.example.com:3478", "stun:b.example.com"]);
  });

  it("accepts a file without stunServers", () => {
    const parsed = parseP2pSettingFile(encode(JSON.stringify({ format: P2P_SETTING_FORMAT, version: P2P_SETTING_VERSION })));
    expect(parsed).toEqual({ format: P2P_SETTING_FORMAT, version: P2P_SETTING_VERSION });
  });

  it("rejects unknown fields", () => {
    expect(parseP2pSettingFile(encode(JSON.stringify({
      format: P2P_SETTING_FORMAT,
      version: P2P_SETTING_VERSION,
      savedAtMs: 1,
    })))).toBeUndefined();
  });

  it("rejects wrong format or version", () => {
    expect(parseP2pSettingFile(encode(JSON.stringify({ format: "keymaster.webrtc-setting", version: 1 })))).toBeUndefined();
    expect(parseP2pSettingFile(encode(JSON.stringify({ format: P2P_SETTING_FORMAT, version: 2 })))).toBeUndefined();
  });

  it("rejects TURN entries", () => {
    expect(parseP2pSettingFile(encode(JSON.stringify({
      format: P2P_SETTING_FORMAT,
      version: P2P_SETTING_VERSION,
      stunServers: ["turn:relay.example.com:3478"],
    })))).toBeUndefined();
  });

  it("rejects empty and oversized files", () => {
    expect(parseP2pSettingFile(new Uint8Array(0))).toBeUndefined();
    expect(parseP2pSettingFile(new Uint8Array(P2P_SETTING_MAX_BYTES + 1))).toBeUndefined();
  });
});

describe("serializeP2pSettingFile", () => {
  it("writes normalized JSON with a trailing newline", () => {
    const bytes = serializeP2pSettingFile({ stunServers: ["stun:a.example.com:3478", "stun:a.example.com:3478"] });
    expect(new TextDecoder().decode(bytes).endsWith("\n")).toBe(true);
    expect(parseP2pSettingFile(bytes)?.stunServers).toEqual(["stun:a.example.com:3478"]);
  });

  it("falls back to default servers for an empty list", () => {
    const bytes = serializeP2pSettingFile({ stunServers: [] });
    expect(parseP2pSettingFile(bytes)?.stunServers).toEqual([...DEFAULT_STUN_SERVERS]);
  });

  it("throws for invalid STUN entries", () => {
    expect(() => serializeP2pSettingFile({ stunServers: ["turn:relay.example.com"] })).toThrow();
  });
});
