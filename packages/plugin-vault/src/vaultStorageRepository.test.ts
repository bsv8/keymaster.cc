import { describe, expect, it, vi } from "vitest";
import type { VaultCatalogHoldAdapter, VaultStorageRepository } from "./coordinator.js";
import {
  createVaultStorageRepository,
  disposeVaultStorageRepository,
  configureVaultStorageRepository,
  getVaultStorageRepository
} from "./storage/vaultStorageRepository.js";

function makeHold(): VaultCatalogHoldAdapter {
  return {
    readCommitted: vi.fn(),
    readEncryptedSnapshot: vi.fn(),
    encryptPrivateKey: vi.fn(),
    decryptPrivateKey: vi.fn(),
    publish: vi.fn()
  };
}

function makeRepository(hold: VaultCatalogHoldAdapter = makeHold()): VaultStorageRepository {
  return createVaultStorageRepository({ hold });
}

describe("Vault 存储边界（Hold-only）", () => {
  it("直接把 Hold 适配器暴露给调用方,没有钱包级 K-V", () => {
    const hold = makeHold();
    const repository = makeRepository(hold);
    expect(repository.hold).toBe(hold);
    expect(Object.keys(repository)).toEqual(["hold"]);
  });

  it("configure/get/dispose 生命周期", () => {
    const hold = makeHold();
    configureVaultStorageRepository({ hold });
    expect(getVaultStorageRepository().hold).toBe(hold);
    disposeVaultStorageRepository();
    expect(() => getVaultStorageRepository()).toThrow(/not configured/u);
  });
});
