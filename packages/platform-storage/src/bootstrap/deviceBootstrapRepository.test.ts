import { describe, expect, it } from "vitest";
import type { DeviceRemoteConnectionV1 } from "@keymaster/contracts";
import { deviceRemoteStorageLocationFingerprint } from "@keymaster/contracts";
import { createDeviceBootstrapRepository, readDeviceBootstrap } from "./deviceBootstrapRepository.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const locks = { request: async <T>(_name: string, callback: () => Promise<T>) => callback() };

const location = {
  providerId: "s3" as const,
  endpoint: "https://objects.example.test",
  region: "auto",
  bucket: "keymaster-bucket",
  prefix: "team-a",
  forcePathStyle: false,
};

function connection(remoteStorageId: string, fingerprint = deviceRemoteStorageLocationFingerprint(location), updatedAt = 1, targetLocation = location): DeviceRemoteConnectionV1 {
  return {
    remoteStorageId,
    displayName: "工作区",
    providerId: "s3",
    location: targetLocation,
    physicalLocationFingerprint: fingerprint,
    encryptedConfig: {
      cipher: {
        algorithm: "aes-gcm",
        keyLengthBits: 256,
        ivB64Url: "0123456789ab",
        tagLengthBits: 128,
        ciphertextAndTagB64Url: "YWJjZA",
      },
    },
    keyDerivation: {
      algorithm: "pbkdf2-hmac-sha-256",
      passwordEncoding: "utf-8",
      iterations: 100_000,
      outputLengthBits: 256,
      saltB64Url: "0123456789ab",
    },
    source: "connected",
    createdAt: 1,
    updatedAt,
  };
}

function localConnection(remoteStorageId: string, namespace = remoteStorageId): DeviceRemoteConnectionV1 {
  const localLocation = { providerId: "local" as const, namespace };
  return {
    ...connection(remoteStorageId),
    providerId: "local",
    location: localLocation,
    physicalLocationFingerprint: deviceRemoteStorageLocationFingerprint(localLocation),
  };
}

describe("device bootstrap repository", () => {
  it("creates a bounded empty catalog and deduplicates a remote connection", async () => {
    const storage = new MemoryStorage();
    const repository = createDeviceBootstrapRepository({ storage, locks, generateId: () => "device-1" });
    expect(repository.read()).toBeNull();
    await expect(repository.ensure()).resolves.toMatchObject({ workerProfileId: "profile-device-1", connections: [], recoveries: [] });

    await repository.upsertConnection(connection("remote-1"));
    await repository.upsertConnection({ ...connection("remote-1", undefined, 2), displayName: "改名" });
    expect(repository.read()?.connections).toHaveLength(1);
    expect(repository.read()?.connections[0]).toMatchObject({ remoteStorageId: "remote-1", displayName: "改名", source: "connected", createdAt: 1, updatedAt: 2 });
  });

  it("rejects unknown fields and a remote ID reused for another physical location", async () => {
    const storage = new MemoryStorage();
    const repository = createDeviceBootstrapRepository({ storage, locks, generateId: () => "device-2" });
    await repository.upsertConnection(connection("remote-2"));
    const alternateLocation = { ...location, prefix: "team-b" };
    await expect(repository.upsertConnection(connection("remote-2", deviceRemoteStorageLocationFingerprint(alternateLocation), 1, alternateLocation))).rejects.toMatchObject({ code: "storage_remote_location_mismatch" });

    await expect(repository.upsertConnection(connection("remote-3"))).rejects.toMatchObject({ code: "storage_remote_location_mismatch" });

    storage.setItem("keymaster.device-bootstrap.v1", JSON.stringify({
      format: "keymaster.device-bootstrap",
      version: 1,
      connections: [{ ...connection("remote-3"), businessData: "forbidden" }],
      recoveries: [],
      workerProfileId: "profile-device-2",
    }));
    expect(() => readDeviceBootstrap(storage)).toThrow(/invalid/i);
  });

  it("keeps recovery pointers separate from connections", async () => {
    const storage = new MemoryStorage();
    const repository = createDeviceBootstrapRepository({ storage, locks, generateId: () => "device-3" });
    await repository.upsertRecovery({ operationId: "operation-1", mode: "create", physicalLocationFingerprint: "c".repeat(64), status: "unknown", errorClass: "network", updatedAt: 1 });
    expect(repository.read()).toMatchObject({ connections: [], recoveries: [{ operationId: "operation-1", status: "unknown" }] });
    await repository.removeRecovery("operation-1");
    expect(repository.read()?.recoveries).toEqual([]);
  });

  it("removes the selected connection without leaving an invalid selection", async () => {
    const storage = new MemoryStorage();
    const repository = createDeviceBootstrapRepository({ storage, locks, generateId: () => "device-4" });
    await repository.upsertConnection(connection("remote-4"));
    await expect(repository.removeConnection("remote-4")).resolves.toMatchObject({ connections: [] });
    expect(repository.read()).toMatchObject({ connections: [] });
    expect(repository.read()).not.toHaveProperty("selectedRemoteStorageId");
  });

  it("rejects a fingerprint that does not match the stored physical location", async () => {
    const storage = new MemoryStorage();
    const repository = createDeviceBootstrapRepository({ storage, locks, generateId: () => "device-5" });
    await expect(repository.upsertConnection(connection("remote-5", "a".repeat(64)))).rejects.toMatchObject({ code: "storage_remote_location_mismatch" });
  });

  it("distinguishes browser-local bucket namespaces while still rejecting duplicate physical targets", async () => {
    const storage = new MemoryStorage();
    const repository = createDeviceBootstrapRepository({ storage, locks, generateId: () => "device-local" });
    await repository.upsertConnection(localConnection("local-remote-1"));
    await repository.upsertConnection(localConnection("local-remote-2"), false);
    expect(repository.read()?.connections).toHaveLength(2);
    await expect(repository.upsertConnection(localConnection("local-remote-3", "local-remote-2"), false)).rejects.toMatchObject({ code: "storage_remote_location_mismatch" });
  });
});
