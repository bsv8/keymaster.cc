// packages/plugin-webrtc/src/webrtcConfig.test.ts
// STUN 配置校验 / owner 文件持久化 / 内存 store 单测。

import { describe, expect, it, vi } from "vitest";
import type { BorrowedOwnerFileStore } from "@keymaster/contracts";
import {
  DEFAULT_STUN_SERVERS,
  coerceWebrtcConfig,
  createMemoryWebrtcConfigStore,
  validateStunServers,
  validateStunUrl
} from "./webrtcConfig.js";
import { createFileWebrtcConfigStore } from "./storage/p2pSettingFileRepository.js";
import { P2P_SETTING_FORMAT } from "./storage/p2pSettingFileFormats.js";
import { createMemoryOwnerFileStore } from "./storage/testSupport/memoryOwnerFileStore.js";

describe("validateStunUrl", () => {
  it("accepts plain stun URL", () => {
    const r = validateStunUrl("stun:stun.l.google.com:19302");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("stun:stun.l.google.com:19302");
  });

  it("trims surrounding whitespace before checking", () => {
    const r = validateStunUrl("   stun:host:3478 ");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("stun:host:3478");
  });

  it("rejects empty", () => {
    expect(validateStunUrl("").ok).toBe(false);
    expect(validateStunUrl("   ").ok).toBe(false);
  });

  it("rejects non-stun schemes", () => {
    expect(validateStunUrl("turn:host:3478").ok).toBe(false);
    expect(validateStunUrl("turns:host:3478").ok).toBe(false);
    expect(validateStunUrl("http://host:3478").ok).toBe(false);
  });

  it("rejects whitespace inside the URL", () => {
    expect(validateStunUrl("stun:stun host:3478").ok).toBe(false);
  });

  it("rejects control chars", () => {
    expect(validateStunUrl("stun:host\n:3478").ok).toBe(false);
  });

  it("rejects overlong URL", () => {
    const longUrl = "stun:" + "a".repeat(300) + ":19302";
    expect(validateStunUrl(longUrl).ok).toBe(false);
  });
});

describe("validateStunServers", () => {
  it("accepts a valid list and dedupes", () => {
    const r = validateStunServers([
      "stun:a.example.com:3478",
      "stun:a.example.com:3478",
      "stun:b.example.com:3478"
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual([
        "stun:a.example.com:3478",
        "stun:b.example.com:3478"
      ]);
    }
  });

  it("falls back to default when list is empty", () => {
    const r = validateStunServers([]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual([...DEFAULT_STUN_SERVERS]);
    }
  });

  it("rejects if any entry is invalid", () => {
    const r = validateStunServers(["stun:a.example.com:3478", "turn:b"]);
    expect(r.ok).toBe(false);
  });

  it("rejects when list is non-array", () => {
    expect(validateStunServers("not-array" as unknown as string[]).ok).toBe(false);
  });
});

describe("coerceWebrtcConfig", () => {
  it("returns defaults for non-object input", () => {
    const c = coerceWebrtcConfig(null);
    expect(c.stunServers).toEqual([...DEFAULT_STUN_SERVERS]);
  });

  it("returns defaults for malformed stunServers", () => {
    const c = coerceWebrtcConfig({ stunServers: "bad" });
    expect(c.stunServers).toEqual([...DEFAULT_STUN_SERVERS]);
  });

  it("returns validated config for valid input", () => {
    const c = coerceWebrtcConfig({
      stunServers: ["stun:host:3478", "turn:bad"]
    });
    expect(c.stunServers).toEqual([...DEFAULT_STUN_SERVERS]);
  });
});

describe("createFileWebrtcConfigStore", () => {
  function createTestStore(seed?: Iterable<readonly [string, string]>) {
    const files = createMemoryOwnerFileStore(seed);
    return { files, store: createFileWebrtcConfigStore(files) };
  }

  const settingFile = (stunServers: string[]): string => JSON.stringify({
    format: P2P_SETTING_FORMAT,
    version: 1,
    stunServers
  });

  it("loads default when setting.json is missing", async () => {
    const { store: s } = createTestStore();
    await s.ready();
    expect(s.load().stunServers).toEqual([...DEFAULT_STUN_SERVERS]);
  });

  it("ready reads an existing setting.json", async () => {
    const { store: s } = createTestStore([["setting.json", settingFile(["stun:a.example.com:3478"])]]);
    await s.ready();
    expect(s.snapshot().stunServers).toEqual(["stun:a.example.com:3478"]);
  });

  it("falls back to defaults for a corrupt file", async () => {
    const { store: s } = createTestStore([["setting.json", "{ not json"]]);
    await s.ready();
    expect(s.snapshot().stunServers).toEqual([...DEFAULT_STUN_SERVERS]);
  });

  it("falls back to defaults for an unknown field", async () => {
    const { store: s } = createTestStore([["setting.json", JSON.stringify({ format: P2P_SETTING_FORMAT, version: 1, savedAtMs: 1 })]]);
    await s.ready();
    expect(s.snapshot().stunServers).toEqual([...DEFAULT_STUN_SERVERS]);
  });

  it("blur-save writes p2p/setting.json and notifies subscribers", async () => {
    const { files, store: s } = createTestStore();
    await s.ready();
    const seen: string[][] = [];
    const off = s.subscribe((c) => seen.push(c.stunServers));
    await s.save({ stunServers: ["stun:a.example.com:3478"] });
    expect(seen).toEqual([["stun:a.example.com:3478"]]);
    off();
    const written = JSON.parse(new TextDecoder().decode(files.__files.get("setting.json")!)) as { format: string; version: number; stunServers: string[] };
    expect(written.format).toBe(P2P_SETTING_FORMAT);
    expect(written.version).toBe(1);
    expect(written.stunServers).toEqual(["stun:a.example.com:3478"]);
  });

  it("rollback on save-failure: throws and does not update memory", async () => {
    const { files } = createTestStore();
    let fail = true;
    const failingFiles: BorrowedOwnerFileStore = {
      ...files,
      async put(...args: Parameters<BorrowedOwnerFileStore["put"]>): ReturnType<BorrowedOwnerFileStore["put"]> {
        if (fail) throw new Error("injected WebRTC storage failure");
        return files.put(...args);
      }
    };
    const s = createFileWebrtcConfigStore(failingFiles);
    await s.ready();
    const before = s.snapshot();
    const seen: unknown[] = [];
    s.subscribe((c) => seen.push(c));
    await expect(s.save({ stunServers: ["stun:a.example.com:3478"] })).rejects.toThrow("injected WebRTC storage failure");
    expect(s.snapshot()).toEqual(before);
    expect(seen).toEqual([]);
    fail = false;
    await s.save({ stunServers: ["stun:a.example.com:3478"] });
    expect(s.snapshot().stunServers).toEqual(["stun:a.example.com:3478"]);
  });

  it("validation failure does not update memory", async () => {
    const { store: s } = createTestStore();
    await s.ready();
    await s.save({ stunServers: ["stun:a.example.com:3478"] });
    const before = s.snapshot();
    expect(() =>
      s.save({ stunServers: ["turn:bad"] })
    ).toThrow();
    expect(s.snapshot()).toEqual(before);
  });

  it("save notify does not include save calls themselves twice", async () => {
    const { store: s } = createTestStore();
    await s.ready();
    let count = 0;
    s.subscribe(() => count++);
    count = 0;
    await s.save({ stunServers: ["stun:abc.example.com:19302"] });
    expect(count).toBe(1);
  });
});

describe("createMemoryWebrtcConfigStore", () => {
  it("defaults to DEFAULT_STUN_SERVERS", () => {
    const s = createMemoryWebrtcConfigStore();
    expect(s.snapshot().stunServers).toEqual([...DEFAULT_STUN_SERVERS]);
  });

  it("save notifies", async () => {
    const s = createMemoryWebrtcConfigStore();
    const handler = vi.fn();
    s.subscribe(handler);
    await s.save({ stunServers: ["stun:x.example.com:3478"] });
    expect(handler).toHaveBeenCalledOnce();
  });
});
