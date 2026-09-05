import { describe, expect, it } from "vitest";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import {
  coerceBsvPriceGlobalConfig,
  createKeyValueBsvPriceSettingsStore,
  normalizePublisherPublicKeyHex
} from "./bsvPriceSettings.js";

const PUBLISHER_A = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function createStore() {
  return createInMemoryKeyValueStore({
    scope: "key",
    ownerPublicKeyHex: PUBLISHER_A,
    applicationStorageId: "BSVPrice",
    schemaVersion: 1,
    bucketId: "test",
    bucketGeneration: 1
  });
}

describe("normalizePublisherPublicKeyHex", () => {
  it("trims, lowercases and accepts compressed public key hex", () => {
    expect(normalizePublisherPublicKeyHex(`  ${PUBLISHER_A.toUpperCase()}  `)).toEqual({ ok: true, value: PUBLISHER_A });
  });

  it("allows empty string as clear config", () => {
    expect(normalizePublisherPublicKeyHex("   ")).toEqual({ ok: true, value: "" });
  });

  it("rejects bad length, prefix and hex", () => {
    expect(normalizePublisherPublicKeyHex("04" + "a".repeat(64)).ok).toBe(false);
    expect(normalizePublisherPublicKeyHex("02" + "g".repeat(64)).ok).toBe(false);
    expect(normalizePublisherPublicKeyHex("02" + "a".repeat(63)).ok).toBe(false);
  });
});

describe("bsvPriceSettings K-V storage", () => {
  it("coerces only the current configuration shape", () => {
    expect(coerceBsvPriceGlobalConfig(null)).toBeNull();
    expect(coerceBsvPriceGlobalConfig({})).toBeNull();
    expect(coerceBsvPriceGlobalConfig({ pricePublisherPublicKeyHex: PUBLISHER_A, savedAtMs: 1 })).toEqual({
      pricePublisherPublicKeyHex: PUBLISHER_A,
      savedAtMs: 1
    });
  });

  it("loads and updates the owner/App K-V value", async () => {
    const storage = createStore();
    const settings = createKeyValueBsvPriceSettingsStore(storage, () => 111);
    await settings.ready();
    expect(settings.load()).toBeNull();
    expect(settings.bootstrapPublisherPublicKeyHex(PUBLISHER_A)).toMatchObject({ pricePublisherPublicKeyHex: PUBLISHER_A, savedAtMs: 111 });
    expect(settings.savePublisherPublicKeyHex("").pricePublisherPublicKeyHex).toBe("");
    expect(settings.snapshot()?.pricePublisherPublicKeyHex).toBe("");
    storage.close();
  });
});
