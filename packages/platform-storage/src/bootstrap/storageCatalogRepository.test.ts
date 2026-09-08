import { describe, expect, it } from "vitest";
import type { StorageBucketCatalogEntryV2, StorageRecordV1 } from "@keymaster/contracts";
import { createStorageCatalogRepository } from "./storageCatalogRepository.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const locks = { request: async <T>(_name: string, callback: () => Promise<T>) => callback() };

const encryptedConfig: StorageRecordV1 = {
  cipher: {
    algorithm: "aes-gcm",
    keyLengthBits: 256,
    ivB64Url: "0123456789ab",
    tagLengthBits: 128,
    ciphertextAndTagB64Url: "encrypted-config"
  }
};

function bucketInput(label: string) {
  return {
    label,
    backend: "local" as const,
    keyDerivation: {
      algorithm: "pbkdf2-hmac-sha-256" as const,
      passwordEncoding: "utf-8" as const,
      iterations: 100_000,
      outputLengthBits: 256 as const,
      saltB64Url: "0123456789ab"
    },
    encryptedConfig
  };
}

describe("Storage catalog repository", () => {
  it("rejects an update based on a stale entry without overwriting the latest entry", async () => {
    const storage = new MemoryStorage();
    const catalog = createStorageCatalogRepository({ storage, locks, generateId: () => "bucket-1", now: () => 100 });
    const original = await catalog.createBucket(bucketInput("原名称"));

    const latest = await catalog.updateBucket(original.bucketId, { label: "最新名称" }, original);
    await expect(catalog.updateBucket(original.bucketId, { label: "过时名称" }, original)).rejects.toMatchObject({ code: "storage_conflict" });
    await expect(catalog.removeBucket(original.bucketId, original)).rejects.toMatchObject({ code: "storage_conflict" });

    expect(catalog.read().buckets[0]).toEqual(latest);
  });

  it("keeps the legacy unconditional update form for callers that already hold the lock boundary", async () => {
    const storage = new MemoryStorage();
    const catalog = createStorageCatalogRepository({ storage, locks, generateId: () => "bucket-2", now: () => 200 });
    const original: StorageBucketCatalogEntryV2 = await catalog.createBucket(bucketInput("原名称"));

    await expect(catalog.updateBucket(original.bucketId, { label: "更新名称" })).resolves.toMatchObject({ label: "更新名称" });
  });

  it("rejects removing the selected bucket but removes a non-current connection", async () => {
    const storage = new MemoryStorage();
    let id = 0;
    const catalog = createStorageCatalogRepository({ storage, locks, generateId: () => `bucket-${++id}`, now: () => 300 });
    const current = await catalog.createBucket(bucketInput("当前桶"));
    const other = await catalog.createBucket(bucketInput("备用桶"));

    await expect(catalog.removeBucket(current.bucketId, current)).rejects.toMatchObject({ code: "storage_forbidden" });
    await expect(catalog.removeBucket(other.bucketId, other)).resolves.toBeTruthy();
    expect(catalog.read()).toMatchObject({ selectedBucketId: current.bucketId, buckets: [current] });
  });
});
