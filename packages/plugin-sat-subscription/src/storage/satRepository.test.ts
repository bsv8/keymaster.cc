import { describe, expect, it } from "vitest";
import type { BorrowedOwnerFileStore } from "@keymaster/contracts";
import {
  createSatSubscriptionRepository,
  emptySatSubscriptionSnapshot,
  parseSatSubscriptionSettingFile,
  SAT_SUBSCRIPTION_SETTING_FILE,
} from "./satRepository.js";
import {
  createDefaultSatSupplierConfig,
  SAT_DEFAULT_SUPPLIER_ID,
  SAT_DEFAULT_SUPPLIER_PUBLIC_KEY_HEX,
} from "../defaults.js";

const OWNER = `02${"11".repeat(32)}`;
const CUSTOM = {
  supplierId: "backup",
  name: "备用供应商",
  supplierPublicKeyHex: `03${"22".repeat(32)}`,
  multiaddrs: ["/dns4/backup.example.com/tcp/443/tls/ws/p2p/16Uiu2HAmPGLn8pLWrSTqidMuq5P1rQBo9UhRwdAUjNVyjSwurtvH"],
  enabled: true,
};

function memoryFiles(seed?: string): BorrowedOwnerFileStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  if (seed !== undefined) files.set(SAT_SUBSCRIPTION_SETTING_FILE, new TextEncoder().encode(seed));
  return {
    files,
    list: async () => ({ files: [...files.keys()].map((path) => ({ path })) }),
    get: async (path) => files.has(path) ? { path, bytes: new Uint8Array(files.get(path)!) } : undefined,
    put: async (path, bytes) => { files.set(path, new Uint8Array(bytes)); return {}; },
    delete: async (path) => { files.delete(path); },
  };
}

function snapshotWithRuntimeDefaults() {
  return {
    ...emptySatSubscriptionSnapshot(OWNER),
    suppliers: [createDefaultSatSupplierConfig("mainnet"), CUSTOM],
    ownerSettings: {
      ownerPublicKeyHex: OWNER,
      defaultPublishSupplierId: CUSTOM.supplierId,
      receiveSupplierIds: [SAT_DEFAULT_SUPPLIER_ID, CUSTOM.supplierId],
    },
    feeAudit: [{
      auditId: "fee-1",
      action: "publish" as const,
      supplierId: CUSTOM.supplierId,
      channel: "topic",
      requestIdHex: "11".repeat(32),
      chargedAmount: "1",
      result: "ok" as const,
      createdAtMs: 1,
    }],
  };
}

describe("SatSubscription setting.json repository", () => {
  it("missing file loads an empty snapshot and does not create a default file", async () => {
    const files = memoryFiles();
    const repository = createSatSubscriptionRepository(files, OWNER);
    const loaded = await repository.load();
    expect(loaded.suppliers).toEqual([]);
    expect(loaded.ownerSettings).toBeNull();
    expect(files.files.has(SAT_SUBSCRIPTION_SETTING_FILE)).toBe(false);
  });

  it("writes only custom suppliers and active custom values", async () => {
    const files = memoryFiles();
    const repository = createSatSubscriptionRepository(files, OWNER);
    await repository.save(snapshotWithRuntimeDefaults());
    const text = new TextDecoder().decode(files.files.get(SAT_SUBSCRIPTION_SETTING_FILE));
    expect(text).not.toContain("feeAudit");
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain(SAT_DEFAULT_SUPPLIER_ID);
    expect(parseSatSubscriptionSettingFile(files.files.get(SAT_SUBSCRIPTION_SETTING_FILE)!)).toEqual({
      suppliers: [CUSTOM],
      defaultPublishSupplierId: "backup",
      receiveSupplierIds: ["backup"],
    });
    await expect(repository.load()).resolves.toMatchObject({ suppliers: [CUSTOM] });
  });

  it("deletes the file when only the built-in default remains", async () => {
    const files = memoryFiles();
    const repository = createSatSubscriptionRepository(files, OWNER);
    await repository.save(snapshotWithRuntimeDefaults());
    await repository.save({
      ...emptySatSubscriptionSnapshot(OWNER),
      suppliers: [createDefaultSatSupplierConfig("mainnet")],
      ownerSettings: { ownerPublicKeyHex: OWNER, defaultPublishSupplierId: SAT_DEFAULT_SUPPLIER_ID, receiveSupplierIds: [SAT_DEFAULT_SUPPLIER_ID] },
    });
    expect(files.files.has(SAT_SUBSCRIPTION_SETTING_FILE)).toBe(false);
  });

  it("rejects the built-in supplier in a file and falls back without repairing it", async () => {
    const invalid = JSON.stringify({
      format: "keymaster.sat-subscription-setting",
      version: 1,
      suppliers: [{ ...CUSTOM, supplierId: SAT_DEFAULT_SUPPLIER_ID, supplierPublicKeyHex: SAT_DEFAULT_SUPPLIER_PUBLIC_KEY_HEX }],
    });
    const files = memoryFiles(invalid);
    const repository = createSatSubscriptionRepository(files, OWNER);
    await expect(repository.load()).resolves.toMatchObject({ suppliers: [], ownerSettings: null });
    expect(new TextDecoder().decode(files.files.get(SAT_SUBSCRIPTION_SETTING_FILE))).toBe(invalid);
  });

  it("rejects unknown fields and invalid active references", async () => {
    const unknown = memoryFiles(JSON.stringify({ format: "keymaster.sat-subscription-setting", version: 1, extra: true }));
    await expect(createSatSubscriptionRepository(unknown, OWNER).load()).resolves.toMatchObject({ suppliers: [] });
    const invalidReference = memoryFiles(JSON.stringify({
      format: "keymaster.sat-subscription-setting",
      version: 1,
      suppliers: [CUSTOM],
      defaultPublishSupplierId: "missing",
    }));
    await expect(createSatSubscriptionRepository(invalidReference, OWNER).load()).resolves.toMatchObject({ suppliers: [] });
  });
});
