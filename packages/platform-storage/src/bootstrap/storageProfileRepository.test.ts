import { describe, expect, it } from "vitest";
import type { StorageBucketCatalogEntryV2 } from "@keymaster/contracts";
import { readStorageBootstrap } from "./storageProfileRepository.js";
import { STORAGE_CATALOG_KEY } from "./storageCatalogRepository.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const bucket: StorageBucketCatalogEntryV2 = {
  bucketId: "bucket-a", label: "Local", backend: "local", configRevision: 1,
  keyDerivation: { algorithm: "pbkdf2-hmac-sha-256", passwordEncoding: "utf-8", iterations: 100_000, outputLengthBits: 256, saltB64Url: "0123456789ab" },
  encryptedConfig: { cipher: { algorithm: "aes-gcm", keyLengthBits: 256, ivB64Url: "0123456789ab", tagLengthBits: 128, ciphertextAndTagB64Url: "encrypted" } },
  snapshotRevision: 1, createdAt: 1, updatedAt: 1,
};

describe("V1 storage bootstrap", () => {
  it("fails closed when the catalog is malformed", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_CATALOG_KEY, "{broken");
    expect(() => readStorageBootstrap(storage as unknown as Storage)).toThrow(/catalog/i);
  });

  it("returns only the selected Local/S3 catalog entry", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_CATALOG_KEY, JSON.stringify({ format: "keymaster.storage.catalog", version: 2, selectedBucketId: bucket.bucketId, buckets: [bucket] }));
    expect(readStorageBootstrap(storage as unknown as Storage)).toEqual({ selectedBackend: "local", selectedProfileId: bucket.bucketId, selectedBucket: bucket });
  });

  it("does not inspect unrelated localStorage records", () => {
    const storage = new MemoryStorage();
    storage.setItem("keymaster.storage.bootstrap.v1", JSON.stringify({ selectedBackend: "opfs" }));
    expect(readStorageBootstrap(storage as unknown as Storage)).toBeNull();
  });
});
