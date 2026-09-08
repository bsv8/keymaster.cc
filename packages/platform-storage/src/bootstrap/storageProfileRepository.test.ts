import { describe, expect, it } from "vitest";
import { readLegacyStorageBootstrap, readStorageBootstrap, STORAGE_BOOTSTRAP_KEY } from "./storageProfileRepository.js";
import { STORAGE_CATALOG_KEY } from "./storageCatalogRepository.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

describe("storage bootstrap catalog precedence", () => {
  it("does not fall back to legacy bootstrap when the new catalog is malformed", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_CATALOG_KEY, "{broken");
    storage.setItem(STORAGE_BOOTSTRAP_KEY, JSON.stringify({ selectedBackend: "opfs", selectedProfileId: "opfs" }));

    expect(() => readStorageBootstrap(storage as unknown as Storage)).toThrow(/catalog/i);
  });

  it("does not resurrect legacy storage after a valid new catalog is present", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_CATALOG_KEY, JSON.stringify({ format: "keymaster.storage.catalog", version: 2, buckets: [] }));
    storage.setItem(STORAGE_BOOTSTRAP_KEY, JSON.stringify({ selectedBackend: "opfs", selectedProfileId: "opfs" }));

    expect(readStorageBootstrap(storage as unknown as Storage)).toBeNull();
  });

  it("exposes legacy OPFS explicitly for migration without changing bootstrap precedence", () => {
    const storage = new MemoryStorage();
    const legacy = { selectedBackend: "opfs", selectedProfileId: "opfs" };
    storage.setItem(STORAGE_CATALOG_KEY, JSON.stringify({ format: "keymaster.storage.catalog", version: 2, buckets: [] }));
    storage.setItem(STORAGE_BOOTSTRAP_KEY, JSON.stringify(legacy));

    expect(readStorageBootstrap(storage as unknown as Storage)).toBeNull();
    expect(readLegacyStorageBootstrap(storage as unknown as Storage)).toEqual(legacy);
  });

  it("exposes an old encrypted Storage Profile for an explicit export path", () => {
    const storage = new MemoryStorage();
    const legacy = {
      selectedBackend: "s3",
      selectedProfileId: "legacy-profile",
      encryptedStorageProfileEnvelope: {
        format: "keymaster.storage-profile",
        version: 1,
        kdf: "pbkdf2-sha256",
        iterations: 210_000,
        saltHex: "00".repeat(16),
        nonceHex: "00".repeat(12),
        ciphertextHex: "00"
      }
    };
    storage.setItem(STORAGE_BOOTSTRAP_KEY, JSON.stringify(legacy));

    expect(readLegacyStorageBootstrap(storage as unknown as Storage)).toEqual(legacy);
  });
});
