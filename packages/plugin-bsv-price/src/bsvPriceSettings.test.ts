// packages/plugin-bsv-price/src/bsvPriceSettings.test.ts
// BSV Price 运行时设置存储测试。
//
// 关键不变量：
//   - 合法公钥 hex 会被 trim + lowerCase；
//   - 空串合法，表示清空配置；
//   - 坏 JSON / 坏 schema 视作“没有本地配置”；
//   - localStorage 写失败时，显式保存必须抛错且不改内存真值。

import { beforeEach, describe, expect, it } from "vitest";
import {
  BSV_PRICE_SETTINGS_STORAGE_KEY,
  coerceBsvPriceGlobalConfig,
  createLocalStorageBsvPriceSettingsStore,
  normalizePublisherPublicKeyHex,
  readBsvPriceGlobalConfig,
  writeBsvPriceGlobalConfig
} from "./bsvPriceSettings.js";

class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

class ThrowingStorage extends FakeStorage {
  override setItem(): void {
    throw new Error("quota exceeded");
  }
}

beforeEach(() => {
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});

describe("normalizePublisherPublicKeyHex", () => {
  it("trims, lowercases and accepts compressed public key hex", () => {
    const r = normalizePublisherPublicKeyHex(
      "  02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA  "
    );
    expect(r.ok).toBe(true);
    expect(r.value).toBe(
      "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("allows empty string as clear config", () => {
    const r = normalizePublisherPublicKeyHex("   ");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("");
  });

  it("rejects bad length / prefix / hex", () => {
    expect(normalizePublisherPublicKeyHex("04" + "a".repeat(64)).ok).toBe(false);
    expect(normalizePublisherPublicKeyHex("02" + "g".repeat(64)).ok).toBe(false);
    expect(normalizePublisherPublicKeyHex("02" + "a".repeat(63)).ok).toBe(false);
  });
});

describe("bsvPriceSettings storage helpers", () => {
  it("coerce returns null for malformed raw input", () => {
    expect(coerceBsvPriceGlobalConfig(null)).toBeNull();
    expect(coerceBsvPriceGlobalConfig({})).toBeNull();
    expect(
      coerceBsvPriceGlobalConfig({
        pricePublisherPublicKeyHex: "bad",
        savedAtMs: 1
      })
    ).toBeNull();
  });

  it("read returns null for bad JSON and missing storage", () => {
    expect(readBsvPriceGlobalConfig(null)).toBeNull();

    const ls = new FakeStorage();
    ls.setItem(BSV_PRICE_SETTINGS_STORAGE_KEY, "{not-json");
    expect(readBsvPriceGlobalConfig(ls)).toBeNull();
  });

  it("write round-trips normalized config", () => {
    const ls = new FakeStorage();
    const written = writeBsvPriceGlobalConfig(ls, {
      pricePublisherPublicKeyHex:
        " 02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ",
      savedAtMs: 123
    });
    expect(written.pricePublisherPublicKeyHex).toBe(
      "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    expect(JSON.parse(ls.getItem(BSV_PRICE_SETTINGS_STORAGE_KEY) ?? "{}")).toEqual(
      written
    );
  });

  it("store bootstrap persists first seed and save updates current value", () => {
    const ls = new FakeStorage();
    const store = createLocalStorageBsvPriceSettingsStore(ls, () => 111);
    const bootstrap = store.bootstrapPublisherPublicKeyHex(
      "02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    );
    expect(bootstrap.savedAtMs).toBe(111);
    expect(store.load()?.pricePublisherPublicKeyHex).toBe(
      "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    const saved = store.savePublisherPublicKeyHex("");
    expect(saved.pricePublisherPublicKeyHex).toBe("");
    expect(store.snapshot()?.pricePublisherPublicKeyHex).toBe("");
  });

  it("save failure throws and keeps current snapshot unchanged", () => {
    const store = createLocalStorageBsvPriceSettingsStore(new ThrowingStorage(), () => 222);
    store.bootstrapPublisherPublicKeyHex(
      "02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    );
    const before = store.snapshot();
    expect(() =>
      store.savePublisherPublicKeyHex("03AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    ).toThrow("quota exceeded");
    expect(store.snapshot()).toEqual(before);
  });

  it("explicit save without localStorage throws and keeps current snapshot unchanged", () => {
    const store = createLocalStorageBsvPriceSettingsStore(null, () => 333);
    const before = store.snapshot();
    expect(() =>
      store.savePublisherPublicKeyHex(
        "02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      )
    ).toThrow("local_storage_unavailable");
    expect(store.snapshot()).toEqual(before);
  });
});
