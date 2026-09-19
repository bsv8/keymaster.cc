import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexedDbBucketProvider } from "./indexedDbBucketProvider.js";

function uniqueDatabaseName(label: string): string {
  return `keymaster-test-${label}-${crypto.randomUUID()}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("indexedDB bucket provider", () => {
  it("isolates bucket namespaces and supports native CAS", async () => {
    const databaseName = uniqueDatabaseName("cas");
    const first = createIndexedDbBucketProvider({ bucketId: "bucket-a", databaseName });
    const second = createIndexedDbBucketProvider({ bucketId: "bucket-b", databaseName });
    const bytes = new TextEncoder().encode("encrypted");

    try {
      await expect(first.probe()).resolves.toMatchObject({ ok: true, conditionalWrites: "native" });
      const written = await first.put("keys/key-1", bytes, { ifNoneMatch: "*" });
      await expect(first.put("keys/key-1", bytes, { ifNoneMatch: "*" })).rejects.toMatchObject({ code: "storage_conflict" });
      await expect(first.put("keys/key-1", bytes, { ifMatch: "wrong" })).rejects.toMatchObject({ code: "storage_conflict" });
      await expect(first.put("keys/key-1", bytes, { ifMatch: written.etag })).resolves.toBeTruthy();
      await expect(second.get("keys/key-1")).resolves.toBeUndefined();
      await expect(first.list({ prefix: "keys" })).resolves.toMatchObject({ objects: [{ path: "keys/key-1" }] });
      await expect(first.list({ prefix: "" })).resolves.toMatchObject({ objects: [{ path: "keys/key-1" }] });
      await expect(first.get("keys/key-1")).resolves.toMatchObject({ bytes });
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("pages a sorted list and round-trips binary bytes", async () => {
    const databaseName = uniqueDatabaseName("list");
    const provider = createIndexedDbBucketProvider({ bucketId: "bucket-page", databaseName });
    try {
      const bytes = new Uint8Array(1024).fill(7);
      await provider.put("keys/b", bytes);
      await provider.put("keys/a", new Uint8Array([1, 2, 3]));
      await provider.put("other/c", new Uint8Array([9]));
      const page = await provider.list({ prefix: "keys/", limit: 1 });
      expect(page.objects.map((object) => object.path)).toEqual(["keys/a"]);
      expect(page.objects[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
      const next = await provider.list({ prefix: "keys/", cursor: page.nextCursor, limit: 1 });
      expect(next.objects.map((object) => object.path)).toEqual(["keys/b"]);
      expect(next.objects[0]?.bytes).toEqual(bytes);
      expect(next.nextCursor).toBeUndefined();
    } finally {
      provider.dispose();
    }
  });

  it("lists with a bounded key range and returns the stored etag without rehashing", async () => {
    const databaseName = uniqueDatabaseName("range");
    const provider = createIndexedDbBucketProvider({ bucketId: "bucket-range", databaseName });
    try {
      // 大对象放在 sibling 前缀下；列 seeds/ 不应触碰它。
      await provider.put("storage/seed-1/block", new Uint8Array(64 * 1024).fill(3));
      await provider.put("seeds/seed-1.ms", new Uint8Array([1]));
      await provider.put("keys2/not-selected", new Uint8Array([2]));

      const seeds = await provider.list({ prefix: "seeds/" });
      expect(seeds.objects.map((object) => object.path)).toEqual(["seeds/seed-1.ms"]);
      // `keys/` 不能误收 `keys2/...`。
      expect((await provider.list({ prefix: "keys/" })).objects).toEqual([]);

      const written = await provider.put("etag/a", new Uint8Array([5, 6]));
      const listed = await provider.list({ prefix: "etag/" });
      expect(listed.objects[0]?.etag).toBe(written.etag);
    } finally {
      provider.dispose();
    }
  });

  it("deletes with conditions and rejects writes after dispose", async () => {
    const databaseName = uniqueDatabaseName("delete");
    const provider = createIndexedDbBucketProvider({ bucketId: "bucket-delete", databaseName });
    const written = await provider.put("config", new Uint8Array([1]));
    await expect(provider.delete("config", { ifMatch: "wrong" })).rejects.toMatchObject({ code: "storage_conflict" });
    await provider.delete("config", { ifMatch: written.etag });
    await expect(provider.get("config")).resolves.toBeUndefined();
    // 删除不存在的对象是幂等的。
    await expect(provider.delete("config")).resolves.toBeUndefined();
    provider.dispose();
    await expect(provider.put("config", new Uint8Array([1]))).rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("fails closed when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(() => createIndexedDbBucketProvider({ bucketId: "no-idb" })).toThrowError(/IndexedDB is unavailable/u);
  });

  it("rejects invalid paths before touching the database", async () => {
    const provider = createIndexedDbBucketProvider({ bucketId: "bucket-path", databaseName: uniqueDatabaseName("path") });
    try {
      await expect(provider.get("../escape")).rejects.toThrowError(/storage path is invalid/u);
      await expect(provider.put("", new Uint8Array([1]))).rejects.toThrowError(/storage path is invalid/u);
    } finally {
      provider.dispose();
    }
  });
});
