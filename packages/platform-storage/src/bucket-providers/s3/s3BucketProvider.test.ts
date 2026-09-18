import { describe, expect, it, vi } from "vitest";
import type { NormalizedStorageProviderConfig } from "@keymaster/contracts";
import type { BucketObjectStore } from "../bucketObjectStore.js";
import { createS3BucketProvider } from "./s3BucketProvider.js";
import { createBucketObjectStoreCapabilityState } from "../bucketObjectStore.js";
import { StorageRuntimeError } from "../../runtime/storageError.js";

const config: NormalizedStorageProviderConfig = {
  version: 1,
  providerId: "s3-compatible",
  connection: {
    endpoint: "https://objects.example.test",
    region: "auto",
    bucket: "bucket-name",
    prefix: "tenant-a/",
    sessionToken: "session-token",
    forcePathStyle: true
  },
  credentials: { kind: "access-key", accessKeyId: "access-key", secretAccessKey: "secret-key" }
};

function storeFixture(): BucketObjectStore {
  return {
    probe: vi.fn(async () => undefined),
    list: vi.fn(async () => ({
      objects: [{ key: "tenant-a/docs/readme.txt", size: 3, etag: "etag" }],
      commonPrefixes: []
    })),
    put: vi.fn(async () => ({ etag: "etag" })),
    head: vi.fn(async () => true),
    get: vi.fn(async () => ({ bytes: new TextEncoder().encode("yes"), etag: "etag" })),
    delete: vi.fn(async () => undefined),
    createMultipart: vi.fn(async () => "upload"),
    uploadPart: vi.fn(async () => "part"),
    completeMultipart: vi.fn(async () => ({ etag: "etag" })),
    abortMultipart: vi.fn(async () => undefined),
    dispose: vi.fn()
  };
}

describe("S3 bucket provider physical prefix", () => {
  it("keeps public paths relative while pinning every operation to the configured prefix", async () => {
    const store = storeFixture();
    const provider = createS3BucketProvider(config, { store, bucketId: "catalog-bucket" });
    await expect(provider.get("docs/readme.txt")).resolves.toMatchObject({ path: "docs/readme.txt" });
    await provider.put("docs/write.txt", new Uint8Array([1]), { ifNoneMatch: "*" });
    await provider.delete("docs/remove.txt");
    await expect(provider.list({ prefix: "docs" })).resolves.toMatchObject({ objects: [{ path: "docs/readme.txt" }] });

    expect(store.get).toHaveBeenCalledWith(expect.objectContaining({ namespaceRoot: "tenant-a/", key: "tenant-a/docs/readme.txt" }));
    expect(store.put).toHaveBeenCalledWith(expect.objectContaining({ namespaceRoot: "tenant-a/", key: "tenant-a/docs/write.txt" }));
    expect(store.delete).toHaveBeenCalledWith(expect.objectContaining({ namespaceRoot: "tenant-a/", key: "tenant-a/docs/remove.txt" }));
    expect(store.list).toHaveBeenCalledWith(expect.objectContaining({ namespaceRoot: "tenant-a/", prefix: "tenant-a/docs" }));
    provider.dispose();
  });

  it("does not add the logical bucket ID to the documented physical prefix", async () => {
    const store = storeFixture();
    const provider = createS3BucketProvider(config, { store, bucketId: "bucket-one" });
    await provider.put("keymaster/keys.json", new Uint8Array([1]));
    expect(store.put).toHaveBeenCalledWith(expect.objectContaining({
      namespaceRoot: "tenant-a/",
      key: "tenant-a/keymaster/keys.json"
    }));
    provider.dispose();
  });

  it("probes native conditional writes and records the capability", async () => {
    const store = storeFixture();
    (store.get as ReturnType<typeof vi.fn>).mockResolvedValue({ bytes: new TextEncoder().encode("keymaster-s3-probe"), etag: "etag" });
    (store.put as ReturnType<typeof vi.fn>).mockImplementation(async (input: { ifMatch?: string }) => {
      if (input.ifMatch !== undefined) throw new StorageRuntimeError("storage_conflict", "Storage object already exists or changed");
      return { etag: "etag" };
    });
    const capabilityState = createBucketObjectStoreCapabilityState();
    const provider = createS3BucketProvider(config, { store, capabilityState, bucketId: "probe-native" });
    await expect(provider.probe()).resolves.toMatchObject({ ok: true, conditionalWrites: "native" });
    expect(capabilityState.put.mode).toBe("native");
    provider.dispose();
  });

  it("falls back to best-effort when the provider ignores If-Match", async () => {
    const store = storeFixture();
    (store.get as ReturnType<typeof vi.fn>).mockResolvedValue({ bytes: new TextEncoder().encode("keymaster-s3-probe"), etag: "etag" });
    // put 对错误 ETag 也返回成功 = 服务忽略 If-Match。
    (store.put as ReturnType<typeof vi.fn>).mockResolvedValue({ etag: "etag" });
    const capabilityState = createBucketObjectStoreCapabilityState();
    const provider = createS3BucketProvider(config, { store, capabilityState, bucketId: "probe-best-effort" });
    await expect(provider.probe()).resolves.toMatchObject({ ok: true, conditionalWrites: "best-effort" });
    expect(capabilityState.put.mode).toBe("best-effort");
    // 探针对象必须清理。
    expect(store.delete).toHaveBeenCalled();
    provider.dispose();
  });

  it("rejects a prefix that could escape the physical namespace", () => {
    expect(() => createS3BucketProvider({
      ...config,
      connection: { ...config.connection, prefix: "../outside/" }
    }, { store: storeFixture(), bucketId: "unsafe" })).toThrow();
  });

  it("rejects a bucket ID that could escape the physical namespace", () => {
    expect(() => createS3BucketProvider(config, { store: storeFixture(), bucketId: "../outside" })).toThrow();
  });
});
