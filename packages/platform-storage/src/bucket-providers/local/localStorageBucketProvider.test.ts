import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalStorageBucketProvider, type LocalStorageLike, type LocalStorageLocks } from "./localStorageBucketProvider.js";
import { browserStorageLockMode, browserStorageLocks } from "../../runtime/browserLocks.js";

class MemoryStorage implements LocalStorageLike {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const locks: LocalStorageLocks = {
  async request<T>(
    _name: string,
    optionsOrCallback: { signal?: AbortSignal } | (() => Promise<T>),
    callback?: () => Promise<T>
  ): Promise<T> {
    const operation = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    if (!operation) throw new TypeError("Web Locks callback is required");
    return operation();
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {});
    const provider = createLocalStorageBucketProvider({ storage: new MemoryStorage(), bucketId: "no-lock" });
    await expect(provider.put("config", new Uint8Array([1]))).rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(provider.probe()).rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("uses an explicit single-page lock queue for insecure HTTP", async () => {
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("navigator", {});
    expect(browserStorageLockMode()).toBe("single-page-fallback");
    const storage = new MemoryStorage();
    const provider = createLocalStorageBucketProvider({ storage, bucketId: "http-fallback" });
    const lock = browserStorageLocks();
    expect(lock).toBeTruthy();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const first = lock!.request("http-fallback-lock", async () => {
      events.push("first-start");
      markStarted();
      await gate;
      events.push("first-end");
    });
    const second = lock!.request("http-fallback-lock", async () => {
      events.push("second");
    });
    await started;
    expect(events).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
    await provider.put("config", new Uint8Array([1]));
    await expect(provider.get("config")).resolves.toMatchObject({ bytes: new Uint8Array([1]) });
  });

  it("uses the browser Web Locks overloads with and without an AbortSignal", async () => {
    const storage = new MemoryStorage();
    const calls: unknown[][] = [];
    const browserLocks = {
      request: async <T>(...args: unknown[]): Promise<T> => {
        calls.push(args);
        const callback = args.length === 2 ? args[1] : args[2];
        if (typeof callback !== "function") throw new TypeError("Web Locks callback is required");
        return (callback as () => Promise<T>)();
      }
    } as LocalStorageLocks;
    const provider = createLocalStorageBucketProvider({ storage, locks: browserLocks, bucketId: "signal-order" });
    const controller = new AbortController();

    await provider.put("without-signal", new Uint8Array([1]));
    await provider.put("with-signal", new Uint8Array([2]), { signal: controller.signal });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]?.[1]).toBeTypeOf("function");
    expect(calls[1]).toHaveLength(3);
    expect(calls[1]?.[1]).toEqual({ signal: controller.signal });
    expect(calls[1]?.[2]).toBeTypeOf("function");
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

  it("restores storage error codes transported by the Local reverse capability", async () => {
    const provider = createLocalStorageBucketProvider({
      bucketId: "transported-error",
      bridge: async () => {
        throw Object.assign(new Error("Remote capability operation failed"), {
          name: "WebLoomError",
          code: "storage_conflict",
        });
      },
    });

    await expect(provider.put("coordinator/value", new Uint8Array([1]), { ifNoneMatch: "*" }))
      .rejects.toMatchObject({ code: "storage_conflict" });
  });
});
