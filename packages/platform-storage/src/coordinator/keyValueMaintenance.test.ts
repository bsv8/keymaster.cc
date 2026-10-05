import { describe, expect, it, vi } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS, type KeyValueStore } from "@keymaster/contracts";
import type { StoragePrivateRootStore } from "../storage-access/platform-root/platformRootStore.js";
import { createKeyValueMaintenance } from "./keyValueMaintenance.js";

describe("storage K-V maintenance", () => {
  it("does not open namespaces on a retired root after an in-flight collection finishes", async () => {
    let finish!: () => void;
    const openPlatformStore = vi.fn();
    const openKeyValueStore = vi.fn();
    let root: StoragePrivateRootStore | undefined = { walletGeneration: "wallet", openPlatformStore, openKeyValueStore } as unknown as StoragePrivateRootStore;
    const token = {};
    const maintenance = createKeyValueMaintenance({ root: () => root, rootToken: () => root ? token : undefined, isReady: () => !!root, ownerGrants: () => [] });
    const store = { ...CENTRAL_STORAGE_DECLARATIONS.bsvPrice, walletGeneration: "wallet", collectGarbage: () => new Promise(resolve => { finish = () => resolve({ scanned: 0, candidates: 0, deleted: 0, failed: 0 }); }) } as unknown as KeyValueStore;
    maintenance.register(store);
    const pending = maintenance.collectNow();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    root = undefined;
    finish();
    await pending;
    expect(openPlatformStore).not.toHaveBeenCalled();
    expect(openKeyValueStore).not.toHaveBeenCalled();
    maintenance.clear();
  });
});
