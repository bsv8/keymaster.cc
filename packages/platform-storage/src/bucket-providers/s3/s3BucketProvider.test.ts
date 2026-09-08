import { describe, expect, it, vi } from "vitest";
import type { NormalizedStorageProviderConfig } from "@keymaster/contracts";
import type { BucketObjectStore } from "../bucketObjectStore.js";
import { createS3BucketProvider } from "./s3BucketProvider.js";

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
      objects: [{ key: "tenant-a/.keymaster/buckets/catalog-bucket/docs/readme.txt", size: 3, etag: "etag" }],
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

    expect(store.get).toHaveBeenCalledWith(expect.objectContaining({ namespaceRoot: "tenant-a/.keymaster/buckets/catalog-bucket/", key: "tenant-a/.keymaster/buckets/catalog-bucket/docs/readme.txt" }));
    expect(store.put).toHaveBeenCalledWith(expect.objectContaining({ namespaceRoot: "tenant-a/.keymaster/buckets/catalog-bucket/", key: "tenant-a/.keymaster/buckets/catalog-bucket/docs/write.txt" }));
    expect(store.delete).toHaveBeenCalledWith(expect.objectContaining({ namespaceRoot: "tenant-a/.keymaster/buckets/catalog-bucket/", key: "tenant-a/.keymaster/buckets/catalog-bucket/docs/remove.txt" }));
    expect(store.list).toHaveBeenCalledWith(expect.objectContaining({ namespaceRoot: "tenant-a/.keymaster/buckets/catalog-bucket/", prefix: "tenant-a/.keymaster/buckets/catalog-bucket/docs" }));
    provider.dispose();
  });

  it("isolates two logical buckets that share the same S3 bucket and user prefix", async () => {
    const firstStore = storeFixture();
    const secondStore = storeFixture();
    const first = createS3BucketProvider(config, { store: firstStore, bucketId: "bucket-one" });
    const second = createS3BucketProvider(config, { store: secondStore, bucketId: "bucket-two" });

    await first.put(".keymaster-test", new Uint8Array([1]));
    await second.put(".keymaster-test", new Uint8Array([2]));

    expect(firstStore.put).toHaveBeenCalledWith(expect.objectContaining({
      namespaceRoot: "tenant-a/.keymaster/buckets/bucket-one/",
      key: "tenant-a/.keymaster/buckets/bucket-one/.keymaster-test"
    }));
    expect(secondStore.put).toHaveBeenCalledWith(expect.objectContaining({
      namespaceRoot: "tenant-a/.keymaster/buckets/bucket-two/",
      key: "tenant-a/.keymaster/buckets/bucket-two/.keymaster-test"
    }));
    first.dispose();
    second.dispose();
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
