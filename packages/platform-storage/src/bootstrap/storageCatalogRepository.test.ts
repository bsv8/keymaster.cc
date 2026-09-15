import { describe, expect, it } from "vitest";
import { deviceRemoteStorageLocationFingerprint, type StorageBucketCatalogEntryV2, type StorageRecordV1 } from "@keymaster/contracts";
import { createDeviceBootstrapRepository } from "./deviceBootstrapRepository.js";
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

function bucketInput(label: string, backend: "local" | "s3" = "local") {
  return {
    label,
    backend,
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

async function authenticateConnection(storage: MemoryStorage, entry: StorageBucketCatalogEntryV2, select = true): Promise<void> {
  const location = entry.backend === "local"
    ? { providerId: "local" as const, namespace: entry.bucketId }
    : { providerId: "s3" as const, endpoint: "https://objects.example.test", region: "us-east-1", bucket: `${entry.bucketId}-objects` };
  await createDeviceBootstrapRepository({ storage, locks, generateId: () => "catalog-repository-profile" }).upsertConnection({
    remoteStorageId: entry.bucketId,
    displayName: entry.label,
    providerId: entry.backend,
    location,
    physicalLocationFingerprint: deviceRemoteStorageLocationFingerprint(location),
    encryptedConfig: entry.encryptedConfig,
    keyDerivation: entry.keyDerivation,
    source: "created",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }, select);
}

describe("Storage catalog repository", () => {
  it("rejects an update based on a stale entry without overwriting the latest entry", async () => {
    const storage = new MemoryStorage();
    const catalog = createStorageCatalogRepository({ storage, locks, generateId: () => "bucket-1", now: () => 100 });
    const candidate = catalog.createBucketEntry(bucketInput("原名称"));
    await authenticateConnection(storage, candidate);
    const original = await catalog.commitBucket(candidate);

    const latest = await catalog.updateBucket(original.bucketId, { label: "最新名称" }, original);
    await expect(catalog.updateBucket(original.bucketId, { label: "过时名称" }, original)).rejects.toMatchObject({ code: "storage_conflict" });
    await expect(catalog.removeBucket(original.bucketId, original)).rejects.toMatchObject({ code: "storage_conflict" });

    expect(catalog.read().buckets[0]).toMatchObject({ bucketId: latest.bucketId, label: latest.label, configRevision: 0, snapshotRevision: 0 });
  });

  it("allows an unconditional update for callers that own the lock boundary", async () => {
    const storage = new MemoryStorage();
    const catalog = createStorageCatalogRepository({ storage, locks, generateId: () => "bucket-2", now: () => 200 });
    const candidate = catalog.createBucketEntry(bucketInput("原名称"));
    await authenticateConnection(storage, candidate);
    const original: StorageBucketCatalogEntryV2 = await catalog.commitBucket(candidate);

    await expect(catalog.updateBucket(original.bucketId, { label: "更新名称" })).resolves.toMatchObject({ label: "更新名称" });
  });

  it("rejects removing the selected bucket but removes a non-current connection", async () => {
    const storage = new MemoryStorage();
    let id = 0;
    const catalog = createStorageCatalogRepository({ storage, locks, generateId: () => `bucket-${++id}`, now: () => 300 });
    const currentCandidate = catalog.createBucketEntry(bucketInput("当前桶"));
    await authenticateConnection(storage, currentCandidate);
    const current = await catalog.commitBucket(currentCandidate);
    // Local is one physical browser target, so a second logical connection
    // must use a distinct physical location to exercise non-current removal.
    const otherCandidate = catalog.createBucketEntry(bucketInput("备用桶", "s3"));
    await authenticateConnection(storage, otherCandidate, false);
    const other = await catalog.commitBucket(otherCandidate);

    await expect(catalog.removeBucket(current.bucketId, current)).rejects.toMatchObject({ code: "storage_forbidden" });
    await expect(catalog.removeBucket(other.bucketId, other)).resolves.toBeTruthy();
    expect(catalog.read()).toMatchObject({ selectedBucketId: current.bucketId, buckets: [{ bucketId: current.bucketId, label: current.label }] });
  });
});
