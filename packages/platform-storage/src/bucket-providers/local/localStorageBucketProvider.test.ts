import { describe, expect, it } from "vitest";
import { createLocalStorageBucketProvider, type LocalStorageLike } from "./localStorageBucketProvider.js";

class MemoryStorage implements LocalStorageLike {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const locks = { request: async <T>(_name: string, callback: () => Promise<T>) => callback() };

describe("localStorage bucket provider", () => {
  it("isolates bucket namespaces and supports native CAS", async () => {
    const storage = new MemoryStorage();
    const first = createLocalStorageBucketProvider({ storage, locks, bucketId: "bucket-a" });
    const second = createLocalStorageBucketProvider({ storage, locks, bucketId: "bucket-b" });
    const bytes = new TextEncoder().encode("encrypted");

    await expect(first.probe()).resolves.toMatchObject({ ok: true, conditionalWrites: "native" });
    const written = await first.put("keys/key-1", bytes, { ifNoneMatch: "*" });
    await expect(first.put("keys/key-1", bytes, { ifNoneMatch: "*" })).rejects.toMatchObject({ code: "storage_conflict" });
    await expect(first.put("keys/key-1", bytes, { ifMatch: "wrong" })).rejects.toMatchObject({ code: "storage_conflict" });
    await expect(first.put("keys/key-1", bytes, { ifMatch: written.etag })).resolves.toBeTruthy();
    await expect(second.get("keys/key-1")).resolves.toBeUndefined();
    await expect(first.list({ prefix: "keys" })).resolves.toMatchObject({ objects: [{ path: "keys/key-1" }] });
    await expect(first.list({ prefix: "" })).resolves.toMatchObject({ objects: [{ path: "keys/key-1" }] });
    first.dispose();
    second.dispose();
  });

  it("fails closed when Web Locks are unavailable", async () => {
    const provider = createLocalStorageBucketProvider({ storage: new MemoryStorage(), bucketId: "no-lock" });
    await expect(provider.put("config", new Uint8Array([1]))).rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(provider.probe()).rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("uses the bridge instead of touching localStorage", async () => {
    const requests: string[] = [];
    const provider = createLocalStorageBucketProvider({
      bucketId: "bridge-bucket",
      locks,
      bridge: async (request) => {
        requests.push(request.type);
        if (request.type === "put") return { type: "write", etag: "etag" };
        if (request.type === "get") return { type: "object", object: { path: request.path, bytes: new TextEncoder().encode("encrypted"), etag: "etag" } };
        if (request.type === "delete") return { type: "void" };
        return { type: "list", objects: [] };
      }
    });
    await expect(provider.get("keys/key")).resolves.toMatchObject({ etag: "etag" });
    await provider.put("keys/key", new Uint8Array([1]));
    expect(requests).toEqual(["get", "put"]);
  });
});
