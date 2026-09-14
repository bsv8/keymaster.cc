import { describe, expect, it } from "vitest";
import type {
  StorageBucketListPage,
  StorageBucketObject,
  StorageBucketProbeResult,
  StorageBucketProvider,
  StorageBucketWriteCondition
} from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { StorageRuntimeError } from "../runtime/storageError.js";
import { createKeyValueStore } from "./partitionedKvEngine.js";

const OWNER = `02${"11".repeat(32)}`;

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value?: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((next) => { resolve = (value?: T) => next(value as T); });
  return { promise, resolve };
}

/**
 * 只模拟抽象桶的 CAS 与分页语义。测试故意不使用 in-memory K-V 夹具，
 * 否则无法验证 full-head/value 两层对象的原子发布与迟到结果栅栏。
 */
class FakeBucketProvider implements StorageBucketProvider {
  readonly provider = "local" as const;
  readonly bucketId = "kv-engine-test";
  listCalls = 0;
  private readonly objects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: string }>();
  private etagNumber = 0;
  constructor(private readonly serverNow: () => number = () => Date.now()) {}
  private headReadBarrier?: { arrivals: number; released: Deferred };
  private valueReadBarrier?: { reached: Deferred; released: Deferred };
  private headPutBarrier?: { published: Deferred; released: Deferred; onPublished?: () => void };
  private deleteBarrier?: { matches: (path: string) => boolean; reached: Deferred; released: Deferred };
  onValuePut?: () => void;

  async probe(): Promise<StorageBucketProbeResult> {
    return { ok: true, conditionalWrites: "native", latencyMs: 0 };
  }

  async get(path: string): Promise<StorageBucketObject | undefined> {
    if (path.includes("/.keymaster/heads/") && this.headReadBarrier) {
      const barrier = this.headReadBarrier;
      barrier.arrivals += 1;
      if (barrier.arrivals >= 2) {
        this.headReadBarrier = undefined;
        barrier.released.resolve();
      }
      await barrier.released.promise;
    }
    if (path.includes("/.keymaster/values/") && this.valueReadBarrier) {
      const barrier = this.valueReadBarrier;
      this.valueReadBarrier = undefined;
      barrier.reached.resolve();
      await barrier.released.promise;
    }
    const object = this.objects.get(path);
    return object
      ? { path, bytes: new Uint8Array(object.bytes), etag: object.etag, lastModified: object.lastModified, size: object.bytes.byteLength }
      : undefined;
  }

  async list(input: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<StorageBucketListPage> {
    this.listCalls += 1;
    const prefix = input.prefix ?? "";
    const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    const limit = input.limit ?? 1000;
    const paths = [...this.objects.keys()].filter((path) => path.startsWith(prefix)).sort();
    const selected = paths.slice(offset, offset + limit).map((path) => {
      const object = this.objects.get(path)!;
      return { path, bytes: new Uint8Array(object.bytes), etag: object.etag, lastModified: object.lastModified, size: object.bytes.byteLength };
    });
    return { objects: selected, nextCursor: offset + selected.length < paths.length ? String(offset + selected.length) : undefined };
  }

  async put(path: string, bytes: Uint8Array, condition: StorageBucketWriteCondition = {}): Promise<{ etag: string; lastModified: string }> {
    const current = this.objects.get(path);
    if (condition.ifNoneMatch === "*" && current) throw new StorageRuntimeError("storage_conflict", "already exists");
    if (condition.ifMatch !== undefined && (!current || current.etag !== condition.ifMatch)) {
      throw new StorageRuntimeError("storage_conflict", "etag changed");
    }
    const entry = {
      bytes: new Uint8Array(bytes),
      etag: `etag-${++this.etagNumber}`,
      lastModified: new Date(this.serverNow()).toISOString()
    };
    this.objects.set(path, entry);
    if (path.includes("/.keymaster/values/")) this.onValuePut?.();
    if (path.includes("/.keymaster/heads/") && this.headPutBarrier) {
      const barrier = this.headPutBarrier;
      this.headPutBarrier = undefined;
      barrier.onPublished?.();
      barrier.published.resolve();
      await barrier.released.promise;
    }
    return { etag: entry.etag, lastModified: entry.lastModified };
  }

  async delete(path: string, options: { ifMatch?: string } = {}): Promise<void> {
    const current = this.objects.get(path);
    if (options.ifMatch !== undefined && (!current || current.etag !== options.ifMatch)) {
      throw new StorageRuntimeError("storage_conflict", "etag changed");
    }
    const barrier = this.deleteBarrier && this.deleteBarrier.matches(path) ? this.deleteBarrier : undefined;
    if (barrier) {
      this.deleteBarrier = undefined;
      barrier.reached.resolve();
      await barrier.released.promise;
    }
    this.objects.delete(path);
  }

  dispose(): void { /* test provider */ }

  armHeadReadBarrier(): void {
    this.headReadBarrier = { arrivals: 0, released: deferred() };
  }

  armValueReadBarrier(): { reached: Promise<void>; release(): void } {
    const reached = deferred();
    const released = deferred();
    this.valueReadBarrier = { reached, released };
    return { reached: reached.promise, release: () => released.resolve() };
  }

  armHeadPutBarrier(onPublished?: () => void): { published: Promise<void>; release(): void } {
    const published = deferred();
    const released = deferred();
    this.headPutBarrier = { published, released, onPublished };
    return { published: published.promise, release: () => released.resolve() };
  }

  armDeleteBarrier(matches: (path: string) => boolean): { reached: Promise<void>; release(): void } {
    const reached = deferred();
    const released = deferred();
    this.deleteBarrier = { matches, reached, released };
    return { reached: reached.promise, release: () => released.resolve() };
  }

  seed(path: string, bytes: Uint8Array, lastModified = new Date(0).toISOString()): void {
    this.objects.set(path, { bytes: new Uint8Array(bytes), etag: `etag-${++this.etagNumber}`, lastModified });
  }

  corrupt(path: string, bytes: Uint8Array): void {
    const object = this.objects.get(path);
    if (!object) throw new Error(`missing test object: ${path}`);
    object.bytes = new Uint8Array(bytes);
  }

  paths(): string[] {
    return [...this.objects.keys()];
  }
}

function makeStore(provider: FakeBucketProvider, isCurrent: () => boolean = () => true, now?: () => number, generateValueId?: () => string) {
  return createKeyValueStore({
    provider,
    binding: {
      moduleId: "kv-test",
      purposeId: "state",
      scope: "owner",
      authority: "built-in-module",
      model: "kv",
      schemaVersion: 1,
      bucketId: provider.bucketId,
      bucketGeneration: 1,
      ownerPublicKeyHex: OWNER
    },
    isCurrent,
    ...(now ? { now } : {}),
    ...(generateValueId ? { generateValueId } : {}),
  });
}

function orphanValueObject(valueId: string, value: unknown, createdAt: number, partition = "default"): Uint8Array {
  const payload = new TextEncoder().encode(`keymaster-kv-v1:json\n${JSON.stringify(value)}`);
  const valueHash = Array.from(sha256(payload), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const header = new TextEncoder().encode(`keymaster-kv-value-v1:${JSON.stringify({ format: "keymaster.kv-value", version: 1, valueId, partition, valueHash, createdAt })}\n`);
  const result = new Uint8Array(header.byteLength + payload.byteLength);
  result.set(header);
  result.set(payload, header.byteLength);
  return result;
}

describe("partitioned K-V engine", () => {
  it("returns persisted timestamps for semantic put and net-zero commit no-ops", async () => {
    const provider = new FakeBucketProvider();
    let clock = 100;
    const store = makeStore(provider, () => true, () => clock);
    const first = await store.put("existing", { b: 2, a: 1 }, { partition: "state" });
    expect(first).toEqual({ key: "existing", revision: 1, updatedAt: 100 });

    clock = 150;
    await expect(store.put("other", true, { partition: "state" })).resolves.toEqual({ key: "other", revision: 2, updatedAt: 150 });

    clock = 200;
    const same = await store.put("existing", { a: 1, b: 2 }, { partition: "state" });
    expect(same).toEqual({ key: "existing", revision: 2, updatedAt: 100 });
    await expect(store.get("existing", { partition: "state" })).resolves.toMatchObject({ revision: 2, updatedAt: 100 });

    clock = 300;
    await expect(store.commit({ partition: "state", operations: [
      { type: "put", key: "existing", value: "temporary" },
      { type: "put", key: "existing", value: { b: 2, a: 1 } },
    ] })).resolves.toEqual({ revision: 2, commitId: "", committedAt: 150 });
    await expect(store.commit({ partition: "empty", operations: [] })).resolves.toEqual({ revision: 0, commitId: "", committedAt: 0 });
  });

  it("publishes only a final net change and never writes intermediate values", async () => {
    const provider = new FakeBucketProvider();
    const store = makeStore(provider);
    await store.put("existing", "B", { partition: "state" });
    const pathsBefore = provider.paths().sort();

    await expect(store.commit({
      partition: "state",
      operations: [
        { type: "put", key: "existing", value: "A" },
        { type: "put", key: "existing", value: "B" },
        { type: "put", key: "missing", value: "A" },
        { type: "delete", key: "missing" },
      ],
    })).resolves.toMatchObject({ revision: 1, commitId: "" });
    expect(provider.paths().sort()).toEqual(pathsBefore);
  });

  it("treats canonical JSON and byte copies as semantic no-ops", async () => {
    const provider = new FakeBucketProvider();
    const store = makeStore(provider);
    await store.put("json", { b: 2, a: 1 }, { partition: "state" });
    await store.put("bytes", new Uint8Array([1, 2, 3]), { partition: "state" });
    const pathsBefore = provider.paths().sort();
    const revision = (await store.list({ partition: "state" })).revision;

    await expect(store.commit({ partition: "state", operations: [
      { type: "put", key: "json", value: { a: 1, b: 2 } },
      { type: "put", key: "bytes", value: new Uint8Array([1, 2, 3]) },
    ] })).resolves.toMatchObject({ revision, commitId: "" });
    expect(provider.paths().sort()).toEqual(pathsBefore);
  });

  it("uses head CAS and never exposes a partial losing commit", async () => {
    const provider = new FakeBucketProvider();
    const first = makeStore(provider);
    const second = makeStore(provider);
    await first.put("base", "base", { partition: "state" });

    provider.armHeadReadBarrier();
    const results = await Promise.allSettled([
      first.commit({ partition: "state", ifRevision: 1, operations: [{ type: "put", key: "first", value: 1 }] }),
      second.commit({ partition: "state", ifRevision: 1, operations: [{ type: "put", key: "second", value: 2 }] })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({ reason: { code: "storage_conflict" } });
    const snapshot = await first.snapshot("state");
    expect(snapshot.entries.map((entry) => entry.key)).toContain("base");
    expect(snapshot.entries.some((entry) => entry.key === "first")).not.toBe(snapshot.entries.some((entry) => entry.key === "second"));
  });

  it("retries an unconditional commit after another handle publishes the head", async () => {
    const provider = new FakeBucketProvider();
    const first = makeStore(provider);
    const second = makeStore(provider);
    await first.put("base", "base", { partition: "state" });

    provider.armHeadReadBarrier();
    await expect(Promise.all([
      first.put("first", 1, { partition: "state" }),
      second.put("second", 2, { partition: "state" }),
    ])).resolves.toHaveLength(2);

    const snapshot = await first.snapshot("state");
    expect(snapshot.entries.map((entry) => entry.key)).toEqual(["base", "first", "second"]);
  });

  it("keeps cursor pages on one immutable revision", async () => {
    const provider = new FakeBucketProvider();
    const store = makeStore(provider);
    await store.put("items/1", 1, { partition: "state" });
    await store.put("items/2", 2, { partition: "state" });
    await store.put("items/3", 3, { partition: "state" });

    const firstPage = await store.list({ partition: "state", prefix: "items/", limit: 2 });
    expect(firstPage.entries.map((entry) => entry.key)).toEqual(["items/1", "items/2"]);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await store.list({ partition: "state", prefix: "items/", limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.entries.map((entry) => entry.key)).toEqual(["items/3"]);
    expect(secondPage.revision).toBe(firstPage.revision);

    await store.put("items/4", 4, { partition: "state" });
    await expect(store.list({ partition: "state", prefix: "items/", limit: 2, cursor: firstPage.nextCursor }))
      .rejects.toMatchObject({ code: "storage_conflict" });
  });

  it("rejects a read that crosses a replaced binding", async () => {
    const provider = new FakeBucketProvider();
    let current = true;
    const store = makeStore(provider, () => current);
    await store.put("late", { value: "old" });
    const gate = provider.armValueReadBarrier();
    const pending = store.get("late");
    await gate.reached;
    current = false;
    gate.release();
    await expect(pending).rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("does not publish a head after the binding becomes stale during immutable writes", async () => {
    const provider = new FakeBucketProvider();
    let current = true;
    const store = makeStore(provider, () => current);
    provider.onValuePut = () => { current = false; };

    await expect(store.put("late-write", "old")).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(provider.paths().some((path) => path.includes("/.keymaster/heads/"))).toBe(false);
  });

  it("fails closed on a corrupted unique value object", async () => {
    const provider = new FakeBucketProvider();
    const store = makeStore(provider);
    await store.put("corrupt", { ok: true });
    const valuePath = provider.paths().find((path) => path.includes("/.keymaster/values/"));
    expect(valuePath).toBeTruthy();
    provider.corrupt(valuePath!, new Uint8Array([1, 2, 3]));
    await expect(store.get("corrupt")).rejects.toMatchObject({ code: "storage_provider_error" });
  });

  it("does not list during writes", async () => {
    const provider = new FakeBucketProvider();
    const store = makeStore(provider);
    await expect(store.put("write-only", "value", { partition: "state" })).resolves.toMatchObject({ key: "write-only" });
    await expect(store.commit({ partition: "state", operations: [{ type: "put", key: "second-write", value: 2 }] })).resolves.toMatchObject({ revision: 2 });
    expect(provider.listCalls).toBe(0);
  });

  it("keeps an old-head reader safe through the grace window", async () => {
    let clock = 1_000;
    const provider = new FakeBucketProvider(() => clock);
    const writer = makeStore(provider, () => true, () => clock);
    const reader = makeStore(provider, () => true, () => clock);
    await writer.put("item", "old", { partition: "state" });
    const oldValuePath = provider.paths().find((path) => path.includes("/.keymaster/values/"));
    expect(oldValuePath).toBeTruthy();

    const gate = provider.armValueReadBarrier();
    const pendingRead = reader.get("item", { partition: "state" });
    await gate.reached;
    clock = 1_100;
    await writer.put("item", "new", { partition: "state" });
    await expect(writer.inspectGarbageCandidates({ minAgeMs: 500 })).resolves.toMatchObject({ candidates: 0 });

    gate.release();
    await expect(pendingRead).resolves.toMatchObject({ value: "old" });
    clock = 1_700;
    await expect(writer.inspectGarbageCandidates({ minAgeMs: 500 })).resolves.toMatchObject({ candidates: 1 });
    await expect(writer.collectGarbage({ minAgeMs: 500 })).resolves.toMatchObject({ candidates: 1, deleted: 1, failed: 0 });
    expect(provider.paths()).not.toContain(oldValuePath);
  });

  it("collects a no-head crash orphan using the object timestamp", async () => {
    let clock = 100;
    const provider = new FakeBucketProvider(() => clock);
    const gcStore = makeStore(provider, () => true, () => clock);
    const orphanPath = `${OWNER}/.keymaster/modules/kv-test/state/.keymaster/values/no-head-orphan`;
    provider.seed(orphanPath, orphanValueObject("no-head-orphan", "crashed", 0), new Date(0).toISOString());
    await expect(gcStore.inspectGarbageCandidates({ minAgeMs: 0 })).resolves.toMatchObject({ scanned: 1, candidates: 1 });
    await expect(gcStore.collectGarbage({ minAgeMs: 0 })).resolves.toMatchObject({ scanned: 1, candidates: 1, deleted: 1, failed: 0 });
    gcStore.close();
  });

  it("collects crash orphans by unique value ID without hash-addressed paths", async () => {
    const provider = new FakeBucketProvider(() => clock);
    let clock = 100;
    let valueId = 0;
    const writer = makeStore(provider, () => true, () => clock, () => `value-${++valueId}`);
    const gcStore = makeStore(provider, () => true, () => clock);
    await writer.put("live", "v1");
    const firstValuePath = provider.paths().find((path) => path.includes("/.keymaster/values/"));
    expect(firstValuePath).toBeTruthy();
    expect(firstValuePath).not.toContain(Array.from(sha256(new TextEncoder().encode("keymaster-kv-v1:json\n\"v1\"")), (byte) => byte.toString(16).padStart(2, "0")).join(""));

    const orphanPath = `${OWNER}/.keymaster/modules/kv-test/state/.keymaster/values/orphan-value`;
    provider.seed(orphanPath, orphanValueObject("orphan-value", "crashed", 0), new Date(clock).toISOString());
    await expect(gcStore.inspectGarbageCandidates({ minAgeMs: 0 })).resolves.toMatchObject({ scanned: 2, candidates: 1 });
    await expect(gcStore.collectGarbage({ minAgeMs: 0 })).resolves.toMatchObject({ scanned: 2, candidates: 1, deleted: 1, failed: 0 });
    expect(provider.paths()).not.toContain(orphanPath);

    clock = 200;
    await expect(writer.put("live", "v2")).resolves.toMatchObject({ key: "live" });
    await expect(writer.get("live")).resolves.toMatchObject({ value: "v2" });
    expect(provider.paths().filter((path) => path.includes("/.keymaster/values/")).length).toBe(2);
    expect(provider.paths().some((path) => path.split("/").includes("commits"))).toBe(false);
  });
});
