// packages/plugin-webrtc/src/webrtcConfig.test.ts
// STUN 配置校验 / owner K-V 持久化 / 内存 store 单测。

import { describe, expect, it, vi } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import type { BorrowedKeyValueStore } from "@keymaster/contracts";
import {
  DEFAULT_STUN_SERVERS,
  WEBRTC_CONFIG_STORAGE_KEY,
  coerceWebrtcConfig,
  createKeyValueWebrtcConfigStore,
  createMemoryWebrtcConfigStore,
  validateStunServers,
  validateStunUrl
} from "./webrtcConfig.js";

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

describe("createKeyValueWebrtcConfigStore", () => {
  function createTestStore() {
    const storage = createInMemoryKeyValueStore({
      ...CENTRAL_STORAGE_DECLARATIONS.webrtcSettings,
      ownerPublicKeyHex: "a".repeat(64),
      bucketId: "test-memory",
      bucketGeneration: 1
    });
    return { storage, store: createKeyValueWebrtcConfigStore(storage) };
  }

  it("loads default when storage is empty", () => {
    const { store: s } = createTestStore();
    const c = s.load();
    expect(c.stunServers).toEqual([...DEFAULT_STUN_SERVERS]);
  });

  it("blur-save persists and notifies subscribers", async () => {
    const { store: s } = createTestStore();
    const seen: string[][] = [];
    const off = s.subscribe((c) => seen.push(c.stunServers));
    await s.save({ stunServers: ["stun:a.example.com:3478"] });
    expect(seen).toEqual([["stun:a.example.com:3478"]]);
    off();
  });

  it("rollback on save-failure: throws and does not update memory", async () => {
    const { storage } = createTestStore();
    let fail = true;
    const failingStorage: BorrowedKeyValueStore = {
      ...storage,
      async put<T>(...args: Parameters<BorrowedKeyValueStore["put"]>): ReturnType<BorrowedKeyValueStore["put"]> {
        if (fail) throw new Error("injected WebRTC storage failure");
        return storage.put<T>(...args);
      }
    } as BorrowedKeyValueStore;
    const s = createKeyValueWebrtcConfigStore(failingStorage);
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
    await s.save({ stunServers: ["stun:a.example.com:3478"] });
    const before = s.snapshot();
    expect(() =>
      s.save({ stunServers: ["turn:bad"] })
    ).toThrow();
    expect(s.snapshot()).toEqual(before);
  });

  it("save notify does not include save calls themselves twice", async () => {
    const { store: s } = createTestStore();
    let count = 0;
    s.subscribe(() => count++);
    count = 0;
    await s.save({ stunServers: ["stun:abc.example.com:19302"] });
    expect(count).toBe(1);
  });

  it("uses WEBRTC_CONFIG_STORAGE_KEY in the owner K-V namespace", async () => {
    const { storage, store: s } = createTestStore();
    await s.save({ stunServers: ["stun:abc.example.com:19302"] });
    const entry = await storage.get<{ stunServers: string[] }>(WEBRTC_CONFIG_STORAGE_KEY, { partition: "settings" });
    expect(entry?.value.stunServers).toEqual(["stun:abc.example.com:19302"]);
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
