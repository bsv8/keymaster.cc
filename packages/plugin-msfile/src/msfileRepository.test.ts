// packages/plugin-msfile/src/msfileRepository.test.ts
// `keymaster.msfile` schema：全局设置 / 供应商 / App 策略 / App 使用摘要。

import { afterEach, describe, expect, it } from "vitest";
import { openMsFileRepository, sanitizeAppOverride } from "./storage/msfileRepository.js";
import { OWNER_PUBKEY, SUPPLIER_PUBKEY } from "./supplierConfig.test.js";

const PUBLISHER = OWNER_PUBKEY;

async function freshRepository() {
  return openMsFileRepository();
}

afterEach(async () => {
  await Promise.resolve();
});

describe("global settings", () => {
  it("starts unconfigured and persists explicit saves", async () => {
    const db = await freshRepository();
    expect(await db.getGlobalSettings()).toBeNull();
    await db.putGlobalSettings({ seedMaxPriceSatoshis: "5000", blockMaxPriceSatoshis: "0" }, 1234);
    expect(await db.getGlobalSettings()).toEqual({
      settings: { seedMaxPriceSatoshis: "5000", blockMaxPriceSatoshis: "0" },
      mediaPlaybackPrefetchBlocks: 5,
      mediaBlockReadConcurrency: 2,
      globalSeedReadConcurrency: 4,
      globalBlockReadConcurrency: 8,
      globalStatConcurrency: 4,
      updatedAt: 1234,
    });
    db.close();
  });

  it("updates the media policy independently and preserves price settings", async () => {
    const db = await freshRepository();
    await db.putGlobalSettings({ seedMaxPriceSatoshis: "5000", blockMaxPriceSatoshis: "1000" }, 10);
    await db.putMediaPlaybackPrefetchBlocks!({ mediaPlaybackPrefetchBlocks: 64 }, 20);
    expect(await db.getGlobalSettings()).toEqual({
      settings: { seedMaxPriceSatoshis: "5000", blockMaxPriceSatoshis: "1000" },
      mediaPlaybackPrefetchBlocks: 64,
      mediaBlockReadConcurrency: 2,
      globalSeedReadConcurrency: 4,
      globalBlockReadConcurrency: 8,
      globalStatConcurrency: 4,
      updatedAt: 20,
    });
    await expect(db.putMediaPlaybackPrefetchBlocks!({ mediaPlaybackPrefetchBlocks: 1 }, 30)).rejects.toThrow();
    db.close();
  });

  it("atomically persists the four read concurrency values and preserves prices", async () => {
    const db = await freshRepository();
    await db.putGlobalSettings({ seedMaxPriceSatoshis: "5000", blockMaxPriceSatoshis: "1000" }, 10);
    await db.putReadConcurrencySettings({
      mediaBlockReadConcurrency: 4,
      globalSeedReadConcurrency: 6,
      globalBlockReadConcurrency: 12,
      globalStatConcurrency: 7,
    }, 20);
    expect(await db.getGlobalSettings()).toMatchObject({
      settings: { seedMaxPriceSatoshis: "5000", blockMaxPriceSatoshis: "1000" },
      mediaBlockReadConcurrency: 4,
      globalSeedReadConcurrency: 6,
      globalBlockReadConcurrency: 12,
      globalStatConcurrency: 7,
      updatedAt: 20,
    });
    await expect(db.putReadConcurrencySettings({
      mediaBlockReadConcurrency: 13,
      globalSeedReadConcurrency: 1,
      globalBlockReadConcurrency: 8,
      globalStatConcurrency: 1,
    }, 30)).rejects.toThrow();
    expect((await db.getGlobalSettings())?.mediaBlockReadConcurrency).toBe(4);
    db.close();
  });
});

describe("suppliers", () => {
  it("roundtrips configs keyed by public key", async () => {
    const db = await freshRepository();
    const config = { name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: ["/dns4/n/tcp/443/tls/ws/p2p/x"], enabled: true };
    await db.upsertSupplier(config);
    expect((await db.listSuppliers()).length).toBe(1);
    expect(await db.getSupplier(SUPPLIER_PUBKEY)).toMatchObject({ name: "nas" });
    await db.deleteSupplier(SUPPLIER_PUBKEY);
    expect(await db.getSupplier(SUPPLIER_PUBKEY)).toBeNull();
    db.close();
  });
});

describe("app policies and usage", () => {
  it("stores override rows per stable app key", async () => {
    const db = await freshRepository();
    const key = { ownerPublicKeyHex: OWNER_PUBKEY, publisherPublicKeyHex: PUBLISHER, appId: "player.example" };
    await db.putAppPolicy({
      policyKey: `${OWNER_PUBKEY}|${PUBLISHER}|player.example`,
      key,
      override: { seedMaxPriceSatoshis: "100" },
      updatedAt: 42,
    });
    const loaded = await db.getAppPolicy(key);
    expect(loaded?.override).toEqual({ seedMaxPriceSatoshis: "100" });
    expect((await db.listAppPolicies()).length).toBe(1);
    await db.deleteAppPolicy(key);
    expect(await db.getAppPolicy(key)).toBeNull();
    db.close();
  });

  it("touchAppUsage preserves firstSeenAt and updates lastSeenAt", async () => {
    const db = await freshRepository();
    const key = { ownerPublicKeyHex: OWNER_PUBKEY, publisherPublicKeyHex: PUBLISHER, appId: "app" };
    await db.touchAppUsage(key, "App", 10);
    await db.touchAppUsage(key, "App v2", 20);
    const usages = await db.listAppUsages();
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ appName: "App v2", firstSeenAt: 10, lastSeenAt: 20 });
    db.close();
  });
});

describe("sanitizeAppOverride", () => {
  it("accepts canonical partial overrides only", () => {
    expect(sanitizeAppOverride({ seedMaxPriceSatoshis: "0" })).toEqual({ seedMaxPriceSatoshis: "0" });
    expect(sanitizeAppOverride({})).toBeUndefined();
    expect(sanitizeAppOverride({ seedMaxPriceSatoshis: "" })).toBeUndefined();
    expect(sanitizeAppOverride({ blockMaxPriceSatoshis: "01" })).toBeUndefined();
    expect(sanitizeAppOverride({ blockMaxPriceSatoshis: "18446744073709551616" })).toBeUndefined();
    expect(sanitizeAppOverride(null)).toBeUndefined();
  });
});
