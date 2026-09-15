import { describe, expect, it } from "vitest";
import { deviceRemoteStorageLocationFingerprint, type StorageBucketCatalogEntryV2 } from "@keymaster/contracts";
import { readStorageBootstrap } from "./storageProfileRepository.js";
import { DEVICE_BOOTSTRAP_KEY } from "./deviceBootstrapRepository.js";

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
  it("fails closed when the device bootstrap is malformed", () => {
    const storage = new MemoryStorage();
    storage.setItem(DEVICE_BOOTSTRAP_KEY, "{broken");
    expect(() => readStorageBootstrap(storage as unknown as Storage)).toThrow(/bootstrap/i);
  });

  it("projects only the selected authenticated device connection", () => {
    const storage = new MemoryStorage();
    const location = { providerId: "local" as const, namespace: bucket.bucketId };
    storage.setItem(DEVICE_BOOTSTRAP_KEY, JSON.stringify({
      format: "keymaster.device-bootstrap",
      version: 1,
      selectedRemoteStorageId: bucket.bucketId,
      connections: [{
        remoteStorageId: bucket.bucketId,
        displayName: bucket.label,
        providerId: "local",
        location,
        physicalLocationFingerprint: deviceRemoteStorageLocationFingerprint(location),
        encryptedConfig: bucket.encryptedConfig,
        keyDerivation: bucket.keyDerivation,
        source: "connected",
        createdAt: bucket.createdAt,
        updatedAt: bucket.updatedAt,
      }],
      recoveries: [],
      workerProfileId: "profile-storage-bootstrap-test",
    }));
    expect(readStorageBootstrap(storage as unknown as Storage)).toMatchObject({
      selectedBackend: "local",
      selectedProfileId: bucket.bucketId,
      selectedBucket: { bucketId: bucket.bucketId, configRevision: 0, snapshotRevision: 0 },
    });
  });

  it("does not inspect unrelated localStorage records", () => {
    const storage = new MemoryStorage();
    storage.setItem("keymaster.storage.bootstrap.v1", JSON.stringify({ selectedBackend: "opfs" }));
    expect(readStorageBootstrap(storage as unknown as Storage)).toBeNull();
  });
});
