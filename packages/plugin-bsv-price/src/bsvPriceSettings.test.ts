import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import {
  coerceBsvPriceGlobalConfig,
  createDefaultBsvPriceConfig,
  createKeyValueBsvPriceSettingsStore,
  deriveUnitFromPair,
  normalizeMarketIdentifier,
  normalizePublisherPublicKeyHex,
  normalizeServerName
} from "./bsvPriceSettings.js";
import { DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX } from "./constants.js";

const PUBLISHER_A = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

function createStore() {
  return createInMemoryKeyValueStore({
    ...CENTRAL_STORAGE_DECLARATIONS.bsvPrice,
    ownerPublicKeyHex: PUBLISHER_A,
    bucketId: "test",
    bucketGeneration: 1
  });
}

describe("normalizePublisherPublicKeyHex", () => {
  it("trims, lowercases and accepts compressed public key hex", () => {
    expect(normalizePublisherPublicKeyHex(`  ${PUBLISHER_A.toUpperCase()}  `)).toEqual({ ok: true, value: PUBLISHER_A });
  });

  it("rejects empty string because a default publisher always exists", () => {
    expect(normalizePublisherPublicKeyHex("   ")).toEqual({ ok: false, error: "invalid_empty" });
  });

  it("rejects bad length, prefix and hex", () => {
    expect(normalizePublisherPublicKeyHex("04" + "a".repeat(64)).ok).toBe(false);
    expect(normalizePublisherPublicKeyHex("02" + "g".repeat(64)).ok).toBe(false);
    expect(normalizePublisherPublicKeyHex("02" + "a".repeat(63)).ok).toBe(false);
  });
});

describe("market identifiers and units", () => {
  it("normalizes identifiers like the price protocol", () => {
    expect(normalizeMarketIdentifier("  Gate.USDT_1  ")).toEqual({ ok: true, value: "gate.usdt_1" });
    expect(normalizeMarketIdentifier("-bad").ok).toBe(false);
    expect(normalizeMarketIdentifier("").ok).toBe(false);
  });

  it("derives the display unit from the trading pair", () => {
    expect(deriveUnitFromPair("bsvusdt")).toBe("USDT");
    expect(deriveUnitFromPair("BSVCNY")).toBe("CNY");
    expect(deriveUnitFromPair("ethusdt")).toBe("ETHUSDT");
    expect(deriveUnitFromPair("")).toBe("");
  });

  it("validates server names", () => {
    expect(normalizeServerName("  bsv8  ")).toEqual({ ok: true, value: "bsv8" });
    expect(normalizeServerName("   ").ok).toBe(false);
  });
});

describe("bsvPriceSettings K-V storage", () => {
  it("upgrades the legacy single-publisher shape and falls back to defaults for empty legacy keys", () => {
    expect(coerceBsvPriceGlobalConfig({ pricePublisherPublicKeyHex: PUBLISHER_A, savedAtMs: 1 })).toEqual({
      servers: [{ name: "bsv8", publisherPublicKeyHex: PUBLISHER_A }],
      active: { publisherPublicKeyHex: PUBLISHER_A, market: "gate", pair: "bsvusdt" },
      savedAtMs: 1
    });
    const fallback = coerceBsvPriceGlobalConfig({ pricePublisherPublicKeyHex: "", savedAtMs: 1 });
    expect(fallback?.servers).toEqual([{
      name: "bsv8",
      publisherPublicKeyHex: DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX
    }]);
    expect(coerceBsvPriceGlobalConfig(null)).toBeNull();
    expect(coerceBsvPriceGlobalConfig({})).toBeNull();
  });

  it("coerces the current multi-server shape and rejects inconsistent records", () => {
    const config = {
      servers: [{ name: "bsv8", publisherPublicKeyHex: PUBLISHER_A }],
      active: { publisherPublicKeyHex: PUBLISHER_A, market: "gate", pair: "bsvusdt" },
      savedAtMs: 5
    };
    expect(coerceBsvPriceGlobalConfig(config)).toEqual(config);
    expect(coerceBsvPriceGlobalConfig({
      ...config,
      active: { publisherPublicKeyHex: "02" + "b".repeat(64), market: "gate", pair: "bsvusdt" }
    })).toBeNull();
    expect(coerceBsvPriceGlobalConfig({
      servers: [{ name: "bsv8", publisherPublicKeyHex: PUBLISHER_A }],
      active: { publisherPublicKeyHex: PUBLISHER_A, market: "-bad", pair: "bsvusdt" },
      savedAtMs: 5
    })).toBeNull();
  });

  it("loads and updates the owner/App K-V value", async () => {
    const storage = createStore();
    const settings = createKeyValueBsvPriceSettingsStore(storage, () => 111);
    await settings.ready();
    expect(settings.load()).toBeNull();
    const bootstrapped = settings.bootstrapConfig(createDefaultBsvPriceConfig(PUBLISHER_A, () => 222));
    expect(bootstrapped).toMatchObject({
      servers: [{ name: "bsv8", publisherPublicKeyHex: PUBLISHER_A }],
      active: { publisherPublicKeyHex: PUBLISHER_A, market: "gate", pair: "bsvusdt" },
      savedAtMs: 111
    });
    const saved = await settings.saveConfig({
      servers: [
        { name: "bsv8", publisherPublicKeyHex: PUBLISHER_A },
        { name: "alt", publisherPublicKeyHex: "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5" }
      ],
      active: { publisherPublicKeyHex: PUBLISHER_A, market: "okx", pair: "bsvusdt" },
      savedAtMs: 0
    });
    expect(saved.active.market).toBe("okx");
    expect(saved.savedAtMs).toBe(111);
    expect(settings.snapshot()?.servers).toHaveLength(2);
    storage.close();
  });
});
