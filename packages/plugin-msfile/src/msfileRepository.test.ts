// packages/plugin-msfile/src/msfileRepository.test.ts
// KeymasterFormats 文件 Repository：`msfiles/setting.json` 与
// `app.<publisher>/settings.json` 的解析、严格校验和整文件读-改-写。

import { describe, expect, it } from "vitest";
import { openMsFileRepository, sanitizeAppOverride } from "./storage/msfileRepository.js";
import {
  createInMemoryMsFileRepositoryStores,
  IN_MEMORY_OWNER_PUBKEY,
} from "./storage/inMemoryOwnerFileStore.testutil.js";
import { SUPPLIER_PUBKEY } from "./supplierConfig.test.js";

const PUBLISHER = SUPPLIER_PUBKEY;
const SUPPLIER_ADDRESS = `/ip4/127.0.0.1/udp/4001/webrtc-direct/certhash/uEiDu8SJ7IdK9W_PfRJfV0clhOP6mG0zNXcZQ8bBhC9ipwg/p2p/16Uiu2HAmPGLn8pLWrSTqidMuq5P1rQBo9UhRwdAUjNVyjSwurtvH`;

function freshRepository() {
  const stores = createInMemoryMsFileRepositoryStores();
  return { stores, open: () => openMsFileRepository(stores) };
}

function decodeSetting(stores: ReturnType<typeof createInMemoryMsFileRepositoryStores>): Record<string, unknown> {
  const bytes = stores.settings.objects.get("setting.json");
  if (!bytes) throw new Error("setting.json is missing");
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function writeRawSetting(stores: ReturnType<typeof createInMemoryMsFileRepositoryStores>, value: unknown): void {
  stores.settings.objects.set("setting.json", new TextEncoder().encode(JSON.stringify(value)));
}

describe("global settings（msfiles/setting.json）", () => {
  it("requires explicit file bindings with a valid owner", async () => {
    await expect(openMsFileRepository(undefined as never)).rejects.toThrow("MSFile file storage bindings are required");
    const stores = createInMemoryMsFileRepositoryStores();
    await expect(openMsFileRepository({ ...stores, ownerPublicKeyHex: "not-a-key" })).rejects.toThrow("owner public key is invalid");
  });

  it("starts unconfigured and persists price limits in the documented format", async () => {
    const { stores, open } = freshRepository();
    const db = await open();
    expect(await db.getGlobalSettings()).toBeNull();

    await db.putGlobalSettings({ seedMaxPriceSatoshis: "5000", blockMaxPriceSatoshis: "0" }, 1234);
    expect(await db.getGlobalSettings()).toEqual({
      settings: { seedMaxPriceSatoshis: "5000", blockMaxPriceSatoshis: "0" },
      mediaBlockReadConcurrency: 2,
      globalSeedReadConcurrency: 4,
      globalBlockReadConcurrency: 8,
      globalStatConcurrency: 4,
      sellerSettings: { sellerEnabled: false, seedPriceSatoshis: "0", fullBlockPriceSatoshis: "0", quoteLifetimeSeconds: 300, maxConcurrentSales: 1, supportedArbiterPublicKeys: [] },
      updatedAt: null,
    });
    const file = decodeSetting(stores);
    expect(file).toMatchObject({
      format: "keymaster.msfiles-setting",
      version: 2,
      priceLimits: { seedMaxPriceSatoshis: "5000", blockMaxPriceSatoshis: "0" },
    });
    expect(file.suppliers).toBeUndefined();
    db.close();
  });

  it("读取 v1 时卖方默认关闭，首次保存卖方设置后升级为 v2", async () => {
    const { stores, open } = freshRepository();
    writeRawSetting(stores, {
      format: "keymaster.msfiles-setting",
      version: 1,
      priceLimits: { seedMaxPriceSatoshis: "5", blockMaxPriceSatoshis: "6" },
    });
    const db = await open();
    await expect(db.getGlobalSettings()).resolves.toMatchObject({ sellerSettings: { sellerEnabled: false } });
    await db.putSellerSettings({ sellerEnabled: true, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 60, maxConcurrentSales: 2, supportedArbiterPublicKeys: [SUPPLIER_PUBKEY] }, 20);
    expect(decodeSetting(stores)).toMatchObject({
      version: 2,
      seller: { sellerEnabled: true, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 60, maxConcurrentSales: 2, supportedArbiterPublicKeys: [SUPPLIER_PUBKEY] },
    });
    db.close();
  });

  it("persists concurrency atomically and preserves price limits", async () => {
    const { open } = freshRepository();
    const db = await open();
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

  it("rejects unknown top-level fields and invalid amounts instead of guessing", async () => {
    const { stores, open } = freshRepository();
    const db = await open();
    writeRawSetting(stores, {
      format: "keymaster.msfiles-setting",
      version: 1,
      priceLimits: { seedMaxPriceSatoshis: "5000", blockMaxPriceSatoshis: "1000" },
      extra: true,
    });
    await expect(db.getGlobalSettings()).rejects.toThrow(/unknown field/);
    writeRawSetting(stores, {
      format: "keymaster.msfiles-setting",
      version: 1,
      priceLimits: { seedMaxPriceSatoshis: "01", blockMaxPriceSatoshis: "1000" },
    });
    await expect(db.getGlobalSettings()).rejects.toThrow(/priceLimits/);
    db.close();
  });
});

describe("suppliers（msfiles/setting.json suppliers[]）", () => {
  it("roundtrips user suppliers and keeps them out of the builtin identity", async () => {
    const { stores, open } = freshRepository();
    const db = await open();
    const config = { name: "nas", supplierPublicKeyHex: PUBLISHER, addresses: [SUPPLIER_ADDRESS], enabled: true };
    await db.upsertSupplier(config);
    expect(await db.listSuppliers()).toEqual([config]);
    expect(await db.getSupplier(PUBLISHER)).toEqual(config);
    expect(decodeSetting(stores).suppliers).toEqual([
      { name: "nas", publicKeyHex: PUBLISHER, addresses: [SUPPLIER_ADDRESS], enabled: true },
    ]);
    await db.deleteSupplier(PUBLISHER);
    expect(await db.getSupplier(PUBLISHER)).toBeNull();
    db.close();
  });

  it("rejects duplicate supplier public keys in a persisted file", async () => {
    const { stores, open } = freshRepository();
    const db = await open();
    writeRawSetting(stores, {
      format: "keymaster.msfiles-setting",
      version: 1,
      suppliers: [
        { name: "a", publicKeyHex: PUBLISHER, addresses: [SUPPLIER_ADDRESS], enabled: true },
        { name: "b", publicKeyHex: PUBLISHER, addresses: [SUPPLIER_ADDRESS], enabled: true },
      ],
    });
    await expect(db.listSuppliers()).rejects.toThrow(/duplicate/);
    db.close();
  });
});

describe("app settings（app.<publisher>/settings.json）", () => {
  const key = { ownerPublicKeyHex: IN_MEMORY_OWNER_PUBKEY, publisherPublicKeyHex: PUBLISHER, appId: "player.example" };

  it("stores override rows per stable app key and lists usages from the same file", async () => {
    const { stores, open } = freshRepository();
    const db = await open();
    await db.touchAppUsage(key, "Player", 10);
    await db.putAppPolicy({ policyKey: `${IN_MEMORY_OWNER_PUBKEY}|${PUBLISHER}|player.example`, key, override: { seedMaxPriceSatoshis: "100" }, updatedAt: 42 });

    expect((await db.getAppPolicy(key))?.override).toEqual({ seedMaxPriceSatoshis: "100" });
    expect((await db.listAppPolicies()).map((row) => row.key)).toEqual([key]);
    const usages = await db.listAppUsages();
    expect(usages).toHaveLength(1);
    // putAppPolicy 只补缺失字段，不改写已有观察时间。
    expect(usages[0]).toMatchObject({ appName: "Player", firstSeenAt: 10, lastSeenAt: 10 });

    const file = JSON.parse(new TextDecoder().decode(stores.appSettings(PUBLISHER).objects.get("settings.json"))) as Record<string, unknown>;
    expect(file).toMatchObject({
      format: "keymaster.app-settings",
      version: 1,
      publisherPublicKeyHex: PUBLISHER,
      apps: { "player.example": { name: "Player", msfiles: { seedMaxPriceSatoshis: "100" } } },
    });

    await db.deleteAppPolicy(key);
    expect(await db.getAppPolicy(key)).toBeNull();
    expect(await db.listAppUsages()).toHaveLength(1);
    db.close();
  });

  it("touchAppUsage preserves firstSeenAt and updates lastSeenAt", async () => {
    const { open } = freshRepository();
    const db = await open();
    const usageKey = { ownerPublicKeyHex: IN_MEMORY_OWNER_PUBKEY, publisherPublicKeyHex: PUBLISHER, appId: "app" };
    await db.touchAppUsage(usageKey, "App", 10);
    await db.touchAppUsage(usageKey, "App v2", 20);
    const usages = await db.listAppUsages();
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ appName: "App v2", firstSeenAt: 10, lastSeenAt: 20 });
    db.close();
  });

  it("preserves unknown module sections when writing known fields", async () => {
    const { stores, open } = freshRepository();
    const db = await open();
    const appStore = stores.appSettings(PUBLISHER);
    appStore.objects.set("settings.json", new TextEncoder().encode(JSON.stringify({
      format: "keymaster.app-settings",
      version: 1,
      publisherPublicKeyHex: PUBLISHER,
      apps: {
        "player.example": {
          name: "Player",
          firstSeenAt: "2026-09-19T00:00:00.000Z",
          lastSeenAt: "2026-09-19T00:00:00.000Z",
          otherModule: { keep: true },
        },
      },
    })));

    await db.putAppPolicy({ policyKey: `${IN_MEMORY_OWNER_PUBKEY}|${PUBLISHER}|player.example`, key, override: { blockMaxPriceSatoshis: "60" }, updatedAt: 1 });
    const raw = JSON.parse(new TextDecoder().decode(appStore.objects.get("settings.json"))) as {
      apps: Record<string, Record<string, unknown>>;
    };
    expect(raw.apps["player.example"]).toMatchObject({
      otherModule: { keep: true },
      msfiles: { blockMaxPriceSatoshis: "60" },
    });
    db.close();
  });

  it("rejects publisher mismatch and invalid app ids", async () => {
    const { stores, open } = freshRepository();
    const db = await open();
    const appStore = stores.appSettings(PUBLISHER);
    appStore.objects.set("settings.json", new TextEncoder().encode(JSON.stringify({
      format: "keymaster.app-settings",
      version: 1,
      publisherPublicKeyHex: IN_MEMORY_OWNER_PUBKEY,
      apps: {},
    })));
    await expect(db.listAppUsages()).rejects.toThrow(/publisher/);

    appStore.objects.set("settings.json", new TextEncoder().encode(JSON.stringify({
      format: "keymaster.app-settings",
      version: 1,
      publisherPublicKeyHex: PUBLISHER,
      apps: { "Bad App": { name: "x", firstSeenAt: "2026-09-19T00:00:00.000Z", lastSeenAt: "2026-09-19T00:00:00.000Z" } },
    })));
    await expect(db.listAppUsages()).rejects.toThrow(/appId/);
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
