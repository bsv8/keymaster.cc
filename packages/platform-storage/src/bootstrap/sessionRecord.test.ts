import { describe, expect, it } from "vitest";
import { KEYMASTER_SESSION_KEY } from "@keymaster/contracts";
import { clearSession, ensureSessionId, readSession, setActiveBucket, setActiveKey, setSessionKeyDerivation, updateSession } from "./sessionRecord.js";
import type { DeviceLocalStorage } from "./deviceStorage.js";

class MemoryStorage implements DeviceLocalStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
}

describe("session record", () => {
  it("首次生成 sessionId 并持久化，后续保持不变", () => {
    const storage = new MemoryStorage();
    const first = ensureSessionId(storage);
    expect(first).toMatch(/^[0-9a-f]{32}$/u);
    expect(ensureSessionId(storage)).toBe(first);
    expect(readSession(storage)?.sessionId).toBe(first);
  });

  it("切换 active 桶时清除 activeKey；先选桶才能选 Key", () => {
    const storage = new MemoryStorage();
    ensureSessionId(storage);
    setActiveBucket("rs_s3_9f1c", storage);
    setActiveKey("02" + "a".repeat(64), storage);
    expect(readSession(storage)).toMatchObject({ activeBucketId: "rs_s3_9f1c", activeKey: "02" + "a".repeat(64) });
    setActiveBucket("rs_local_7a01", storage);
    expect(readSession(storage)?.activeKey).toBeUndefined();
  });

  it("坏记录按新浏览器处理；非法 activeBucketId 只丢弃该字段", () => {
    const storage = new MemoryStorage();
    storage.setItem(KEYMASTER_SESSION_KEY, "not-json");
    expect(readSession(storage)).toBeUndefined();
    storage.setItem(KEYMASTER_SESSION_KEY, JSON.stringify({ format: "keymaster.session", version: 1, sessionId: "a".repeat(32), activeBucketId: "bad id", activeKey: "02" + "a".repeat(64) }));
    const session = readSession(storage);
    expect(session?.activeBucketId).toBeUndefined();
    expect(session?.activeKey).toBeUndefined();
  });

  it("写入启动密码 KDF 参数并可清除", () => {
    const storage = new MemoryStorage();
    ensureSessionId(storage);
    const keyDerivation = { algorithm: "pbkdf2-hmac-sha-256" as const, passwordEncoding: "utf-8" as const, iterations: 1000, outputLengthBits: 256 as const, saltB64Url: "AAECAwQFBgcICQoLDA0ODw" };
    setSessionKeyDerivation(keyDerivation, storage);
    expect(readSession(storage)?.keyDerivation).toEqual(keyDerivation);
    setSessionKeyDerivation(undefined, storage);
    expect(readSession(storage)?.keyDerivation).toBeUndefined();
  });

  it("清除后视为新浏览器", () => {
    const storage = new MemoryStorage();
    ensureSessionId(storage);
    clearSession(storage);
    expect(readSession(storage)).toBeUndefined();
  });

  it("updateSession 不允许产出非法记录", () => {
    const storage = new MemoryStorage();
    ensureSessionId(storage);
    expect(() => updateSession((current) => ({ ...current, sessionId: "BAD" }), storage)).toThrow();
  });
});
