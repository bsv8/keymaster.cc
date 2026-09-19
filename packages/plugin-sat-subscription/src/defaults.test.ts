import { describe, expect, it } from "vitest";
import {
  applyDefaultSatSupplier,
  createDefaultSatSupplierConfig,
  SAT_DEFAULT_SUPPLIER_ID,
  SAT_DEFAULT_SUPPLIER_MULTIADDRS,
  SAT_DEFAULT_SUPPLIER_PUBLIC_KEY_HEX
} from "./defaults.js";
import { createSatSubscriptionState, type SatSubscriptionStateSnapshot } from "./satState.js";

const OWNER = `02${"11".repeat(32)}`;

function emptySnapshot(overrides: Partial<SatSubscriptionStateSnapshot> = {}): SatSubscriptionStateSnapshot {
  return {
    ownerPublicKeyHex: OWNER,
    supplierGeneration: 1,
    suppliers: [],
    ownerSettings: null,
    subscriptions: [],
    feeAudit: [],
    channelDedup: [],
    spiInformation: [],
    collectResults: [],
    ...overrides
  };
}

describe("SatSubscription default supplier", () => {
  it("uses the matching gateway per network", () => {
    expect(createDefaultSatSupplierConfig("mainnet")).toEqual({
      supplierId: SAT_DEFAULT_SUPPLIER_ID,
      name: "bsv8",
      supplierPublicKeyHex: SAT_DEFAULT_SUPPLIER_PUBLIC_KEY_HEX,
      multiaddrs: [...SAT_DEFAULT_SUPPLIER_MULTIADDRS.mainnet],
      enabled: true
    });
    expect(createDefaultSatSupplierConfig("testnet").multiaddrs).toEqual([
      ...SAT_DEFAULT_SUPPLIER_MULTIADDRS.testnet
    ]);
    expect(SAT_DEFAULT_SUPPLIER_MULTIADDRS.mainnet[0]).toContain("us-gateway.bsv8.com");
    expect(SAT_DEFAULT_SUPPLIER_MULTIADDRS.testnet[0]).toContain("ustest-gateway.bsv8.com");
  });

  it("seeds an empty owner with a default publish exit and receive ingress", () => {
    const seeded = applyDefaultSatSupplier(emptySnapshot(), "mainnet");
    expect(seeded.suppliers).toEqual([createDefaultSatSupplierConfig("mainnet")]);
    expect(seeded.ownerSettings).toEqual({
      ownerPublicKeyHex: OWNER,
      defaultPublishSupplierId: SAT_DEFAULT_SUPPLIER_ID,
      receiveSupplierIds: [SAT_DEFAULT_SUPPLIER_ID]
    });
    // 种子必须能通过状态机归一化，不能把非法配置写进运行时。
    const state = createSatSubscriptionState({ ownerPublicKeyHex: OWNER, initial: seeded });
    expect(state.listSuppliers()).toEqual([createDefaultSatSupplierConfig("mainnet")]);
    expect(state.getOwnerSettings()).toEqual(seeded.ownerSettings);
  });

  it("keeps user suppliers and only fills missing owner settings", () => {
    const userSupplier = {
      supplierId: "custom",
      name: "Custom",
      supplierPublicKeyHex: SAT_DEFAULT_SUPPLIER_PUBLIC_KEY_HEX,
      multiaddrs: ["/ip4/127.0.0.1/tcp/1/ws"],
      enabled: false
    };
    const snapshot = emptySnapshot({ suppliers: [userSupplier] });
    const next = applyDefaultSatSupplier(snapshot, "testnet");
    expect(next.suppliers).toEqual([userSupplier]);
    expect(next.ownerSettings).toEqual({
      ownerPublicKeyHex: OWNER,
      defaultPublishSupplierId: null,
      receiveSupplierIds: []
    });

    const withSettings = emptySnapshot({
      suppliers: [userSupplier],
      ownerSettings: {
        ownerPublicKeyHex: OWNER,
        defaultPublishSupplierId: "custom",
        receiveSupplierIds: ["custom"]
      }
    });
    expect(applyDefaultSatSupplier(withSettings, "testnet")).toEqual(withSettings);
  });

  it("does not seed before an owner is bound", () => {
    const snapshot = emptySnapshot({ ownerPublicKeyHex: "" });
    expect(applyDefaultSatSupplier(snapshot, "mainnet")).toEqual(snapshot);
  });
});
