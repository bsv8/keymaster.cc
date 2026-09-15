import { describe, expect, it } from "vitest";
import type { StorageBucketProvider } from "@keymaster/contracts";
import { createDeviceBootstrapRepository } from "./deviceBootstrapRepository.js";
import { connectExistingRemoteStorage, createRemoteStorage } from "./remoteStorageLifecycle.js";
import { createHmacRemoteRootAuthenticator, encodeRemoteRootManifest, physicalLocationFingerprint, sealRemoteRootManifest } from "./remoteRootProtocol.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function provider(options: { etags?: boolean } = {}): StorageBucketProvider & { writes: string[]; objects: Map<string, Uint8Array> } {
  const etags = options.etags ?? true;
  const objects = new Map<string, Uint8Array>();
  const writes: string[] = [];
  return {
    provider: "s3",
    bucketId: "remote-test",
    objects,
    writes,
    async probe() { return { ok: true, conditionalWrites: "native", latencyMs: 0 }; },
    async get(path) {
      const bytes = objects.get(path);
      return bytes ? { path, bytes: bytes.slice(), size: bytes.byteLength, ...(etags ? { etag: `etag-${path}` } : {}) } : undefined;
    },
    async list() { return { objects: [] }; },
    async put(path, bytes, condition = {}) {
      if (condition.ifNoneMatch === "*" && objects.has(path)) throw Object.assign(new Error("exists"), { code: "storage_conflict" });
      if (condition.ifMatch !== undefined && (!objects.has(path) || (etags && condition.ifMatch !== `etag-${path}`))) throw Object.assign(new Error("etag mismatch"), { code: "storage_conflict" });
      writes.push(path);
      objects.set(path, bytes.slice());
      return etags ? { etag: `etag-${path}` } : {};
    },
    async delete(path) { writes.push(`delete:${path}`); objects.delete(path); },
    dispose() {},
  };
}

const rootInput = {
  remoteStorageId: "remote-life-1",
  namespaceVersion: 1 as const,
  createdAt: 1,
  keyDerivation: { algorithm: "pbkdf2-hmac-sha-256" as const, passwordEncoding: "utf-8" as const, iterations: 100_000, outputLengthBits: 256 as const, saltB64Url: "0123456789ab" },
  rootHead: { path: ".keymaster/hold/v1", revision: 1 },
  system: { schemaPath: ".keymaster/schema", holdHeadPath: ".keymaster/hold/v1" },
  initializationTransactionId: "operation-1",
};

const connectionLocation = { providerId: "s3" as const, endpoint: "https://objects.example.test", region: "auto", bucket: "keymaster-bucket" };
const connection = {
  remoteStorageId: "remote-life-1",
  displayName: "云端",
  providerId: "s3" as const,
  location: connectionLocation,
  physicalLocationFingerprint: physicalLocationFingerprint(connectionLocation),
  encryptedConfig: { cipher: { algorithm: "aes-gcm" as const, keyLengthBits: 256 as const, ivB64Url: "0123456789ab", tagLengthBits: 128 as const, ciphertextAndTagB64Url: "YWJjZA" } },
  keyDerivation: { algorithm: "pbkdf2-hmac-sha-256" as const, passwordEncoding: "utf-8" as const, iterations: 100_000, outputLengthBits: 256 as const, saltB64Url: "0123456789ab" },
  source: "created" as const,
  createdAt: 1,
  updatedAt: 1,
};

const locks = { request: async <T>(_name: string, callback: () => Promise<T>) => callback() };

describe("remote storage lifecycle", () => {
  it("creates a clean namespace and commits device bootstrap only after root verification", async () => {
    const remote = provider();
    const device = createDeviceBootstrapRepository({ storage: new MemoryStorage(), locks, generateId: () => "device-1" });
    const authenticator = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(3));
    const result = await createRemoteStorage({
      provider: remote,
      remoteStorageId: rootInput.remoteStorageId,
      transactionId: rootInput.initializationTransactionId,
      authenticator,
      manifest: rootInput,
      deviceConnection: connection,
      deviceBootstrap: device,
      stageInitialData: async ({ provider: target, stagingPrefix }) => {
        await target.put(`${stagingPrefix}/hold`, new Uint8Array([1]), { ifNoneMatch: "*" });
        await target.put(".keymaster/hold/v1", new Uint8Array([1]), { ifNoneMatch: "*" });
        await target.put(".keymaster/schema", new Uint8Array([1]), { ifNoneMatch: "*" });
      },
      verifyRemoteResult: async () => {},
    });
    expect(result).toMatchObject({ ok: true, deviceBootstrapCommitted: true, manifest: { remoteStorageId: "remote-life-1" } });
    expect(remote.writes).toEqual(expect.arrayContaining([".keymaster/transactions/initialization/operation-1", ".keymaster/staging/operation-1/hold", ".keymaster/root/v1"]));
    expect(device.read()?.selectedRemoteStorageId).toBe("remote-life-1");
    authenticator.dispose?.();
  });

  it("requires the create callbacks and verifies manifest entrypoints", async () => {
    const remote = provider();
    const authenticator = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(33));
    await expect(createRemoteStorage({ provider: remote, remoteStorageId: rootInput.remoteStorageId, transactionId: rootInput.initializationTransactionId, authenticator, manifest: rootInput } as never)).rejects.toMatchObject({ code: "storage_provider_error" });

    await expect(createRemoteStorage({
      provider: remote,
      remoteStorageId: rootInput.remoteStorageId,
      transactionId: rootInput.initializationTransactionId,
      authenticator,
      manifest: rootInput,
      stageInitialData: async () => {},
      verifyRemoteResult: async () => {},
    })).rejects.toMatchObject({ code: "storage_remote_corrupt" });
    expect(remote.writes).toEqual([".keymaster/transactions/initialization/operation-1"]);
    expect(remote.objects.has(".keymaster/root/v1")).toBe(false);
    authenticator.dispose?.();
  });

  it("connects an existing namespace without remote writes", async () => {
    const remote = provider();
    const authenticator = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(4));
    remote.objects.set(".keymaster/root/v1", encodeRemoteRootManifest(await sealRemoteRootManifest(rootInput, authenticator)));
    remote.objects.set(".keymaster/hold/v1", new Uint8Array([1]));
    remote.objects.set(".keymaster/schema", new Uint8Array([1]));
    const before = [...remote.writes];
    const device = createDeviceBootstrapRepository({ storage: new MemoryStorage(), locks, generateId: () => "device-2" });
    const connectConnection = { ...connection, source: "connected" as const };
    await expect(connectExistingRemoteStorage({ provider: remote, authenticator, deviceConnection: connectConnection, deviceBootstrap: device, authenticateHold: async () => {}, loadMinimumRemoteIndex: async () => ({ revision: 1 }) })).resolves.toMatchObject({ ok: true, remoteStorageId: "remote-life-1" });
    expect(remote.writes).toEqual(before);
    authenticator.dispose?.();
  });

  it("retries an already published transaction through the complete success tail", async () => {
    const remote = provider();
    const authenticator = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(43));
    remote.objects.set(".keymaster/root/v1", encodeRemoteRootManifest(await sealRemoteRootManifest(rootInput, authenticator)));
    remote.objects.set(".keymaster/hold/v1", new Uint8Array([1]));
    remote.objects.set(".keymaster/schema", new Uint8Array([1]));
    const device = createDeviceBootstrapRepository({ storage: new MemoryStorage(), locks, generateId: () => "device-retry" });
    await device.upsertRecovery({ operationId: rootInput.initializationTransactionId, mode: "create", remoteStorageId: rootInput.remoteStorageId, physicalLocationFingerprint: connection.physicalLocationFingerprint, status: "unknown", errorClass: "network", updatedAt: 1 });
    let installed = 0;
    await expect(createRemoteStorage({
      provider: remote,
      remoteStorageId: rootInput.remoteStorageId,
      transactionId: rootInput.initializationTransactionId,
      authenticator,
      manifest: rootInput,
      deviceConnection: connection,
      deviceBootstrap: device,
      stageInitialData: async () => {},
      verifyRemoteResult: async () => {},
      installWorkerRuntime: async () => { installed += 1; },
    })).resolves.toMatchObject({ ok: true, deviceBootstrapCommitted: true });
    expect(installed).toBe(1);
    expect(device.read()?.recoveries).toEqual([]);
    authenticator.dispose?.();
  });

  it("passes a write-less provider to connect callbacks and never commits before both checks", async () => {
    const remote = provider();
    const authenticator = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(44));
    remote.objects.set(".keymaster/root/v1", encodeRemoteRootManifest(await sealRemoteRootManifest(rootInput, authenticator)));
    remote.objects.set(".keymaster/hold/v1", new Uint8Array([1]));
    remote.objects.set(".keymaster/schema", new Uint8Array([1]));
    const device = createDeviceBootstrapRepository({ storage: new MemoryStorage(), locks, generateId: () => "device-readonly" });
    let observedProvider: unknown;
    await expect(connectExistingRemoteStorage({
      provider: remote,
      authenticator,
      deviceConnection: { ...connection, source: "connected" as const },
      deviceBootstrap: device,
      authenticateHold: async ({ provider: target }) => {
        observedProvider = target;
        expect((target as unknown as StorageBucketProvider).put).toBeUndefined();
      },
      loadMinimumRemoteIndex: async () => { throw new Error("authentication failed"); },
    })).rejects.toThrow("authentication failed");
    expect(observedProvider).toBeDefined();
    expect(remote.writes).toEqual([]);
    expect(device.read()).toBeNull();
    authenticator.dispose?.();
  });

  it("fails closed when transaction CAS has no version", async () => {
    const remote = provider({ etags: false });
    const authenticator = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(45));
    await expect(createRemoteStorage({
      provider: remote,
      remoteStorageId: rootInput.remoteStorageId,
      transactionId: rootInput.initializationTransactionId,
      authenticator,
      manifest: rootInput,
      stageInitialData: async () => {},
      verifyRemoteResult: async () => {},
    })).rejects.toMatchObject({ code: "storage_provider_error" });
    expect(remote.writes).toEqual([".keymaster/transactions/initialization/operation-1"]);
    authenticator.dispose?.();
  });

  it("never treats forbidden root discovery as an empty namespace", async () => {
    const remote = provider();
    remote.get = async () => { throw Object.assign(new Error("denied"), { code: "storage_forbidden", diagnostic: "forbidden" }); };
    const authenticator = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(5));
    await expect(createRemoteStorage({ provider: remote, remoteStorageId: rootInput.remoteStorageId, transactionId: rootInput.initializationTransactionId, authenticator, manifest: rootInput, stageInitialData: async () => {}, verifyRemoteResult: async () => {} })).rejects.toMatchObject({ code: "storage_forbidden" });
    expect(remote.writes).toEqual([]);
    authenticator.dispose?.();
  });
});
