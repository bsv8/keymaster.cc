import { describe, expect, it } from "vitest";
import type {
  StorageBucketListPage,
  StorageBucketObject,
  StorageBucketProbeResult,
  StorageBucketProvider,
  StorageBucketWriteCondition
} from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { StorageRuntimeError } from "../runtime/storageRuntimeError.js";
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
 * 否则无法验证 head/commit/value 三层对象的原子发布与迟到结果栅栏。
 */
class FakeBucketProvider implements StorageBucketProvider {
  readonly provider = "opfs" as const;
  readonly bucketId = "kv-engine-test";
  private readonly objects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: string }>();
  private etagNumber = 0;
  private headReadBarrier?: { arrivals: number; released: Deferred };
  private valueReadBarrier?: { reached: Deferred; released: Deferred };
  private headPutBarrier?: { published: Deferred; released: Deferred; onPublished?: () => void };
  private deleteBarrier?: { matches: (path: string) => boolean; reached: Deferred; released: Deferred };
  private commitReadBarrier?: { reached: Deferred; released: Deferred };
  onCommitPut?: () => void;

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
    const delayedObject = path.includes("/.keymaster/commits/") && this.commitReadBarrier
      ? this.objects.get(path)
      : undefined;
    if (delayedObject) {
      const barrier = this.commitReadBarrier!;
      this.commitReadBarrier = undefined;
      barrier.reached.resolve();
      await barrier.released.promise;
    }
    const object = delayedObject ?? this.objects.get(path);
    return object
      ? { path, bytes: new Uint8Array(object.bytes), etag: object.etag, lastModified: object.lastModified, size: object.bytes.byteLength }
      : undefined;
  }

  async list(input: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<StorageBucketListPage> {
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
      lastModified: new Date().toISOString()
    };
    this.objects.set(path, entry);
    if (path.includes("/.keymaster/commits/")) this.onCommitPut?.();
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

  armCommitReadBarrier(): { reached: Promise<void>; release(): void } {
    const reached = deferred();
    const released = deferred();
    this.commitReadBarrier = { reached, released };
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

function makeStore(provider: FakeBucketProvider, isCurrent: () => boolean = () => true) {
  return createKeyValueStore({
    provider,
    binding: {
      scope: "key",
      applicationStorageId: "KvTest",
      schemaVersion: 1,
      bucketId: provider.bucketId,
      bucketGeneration: 1,
      ownerPublicKeyHex: OWNER
    },
    isCurrent
  });
}

describe("partitioned K-V engine", () => {
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
    provider.onCommitPut = () => { current = false; };

    await expect(store.put("late-write", "old")).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(provider.paths().some((path) => path.includes("/.keymaster/heads/"))).toBe(false);
  });

  it("fails closed on a corrupted content-addressed value", async () => {
    const provider = new FakeBucketProvider();
    const store = makeStore(provider);
    await store.put("corrupt", { ok: true });
    const valuePath = provider.paths().find((path) => path.includes("/.keymaster/values/"));
    expect(valuePath).toBeTruthy();
    provider.corrupt(valuePath!, new Uint8Array([1, 2, 3]));
    await expect(store.get("corrupt")).rejects.toMatchObject({ code: "storage_provider_error" });
  });

  it("does not let concurrent GC delete a value re-referenced by a newer head", async () => {
    const provider = new FakeBucketProvider();
    const gcStore = makeStore(provider);
    const writer = makeStore(provider);
    await gcStore.put("live", "v1");
    const valueBytes = new TextEncoder().encode("keymaster-kv-v1:json\n\"v2\"");
    const valueHash = Array.from(sha256(valueBytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const orphanPath = `${OWNER}/KvTest/.keymaster/values/${valueHash}`;
    provider.seed(orphanPath, valueBytes);
    const orphanCommitPath = `${OWNER}/KvTest/.keymaster/commits/default/999-orphan`;
    provider.seed(orphanCommitPath, new TextEncoder().encode(JSON.stringify({
      version: 1,
      partition: "default",
      revision: 999,
      commitId: "orphan",
      committedAt: 0,
      entries: []
    })));
    // 在 GC 读到旧 commit 后暂停；writer 随后发布引用同一个 hash 的新
    // head。旧实现此时会把 orphan value 当作不可达对象删除。
    const gate = provider.armCommitReadBarrier();

    const gc = gcStore.inspectGarbageCandidates({ minAgeMs: 0 });
    await gate.reached;
    const write = writer.put("live", "v2");
    gate.release();
    await expect(write).resolves.toMatchObject({ key: "live" });
    await expect(gc).resolves.toMatchObject({ candidates: 2 });
    await expect(writer.get("live")).resolves.toMatchObject({ value: "v2" });
    expect(provider.paths()).toContain(orphanPath);
    expect(provider.paths()).toContain(orphanCommitPath);
  });
});
