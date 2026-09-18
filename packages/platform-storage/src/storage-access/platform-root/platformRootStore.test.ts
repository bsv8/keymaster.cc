import { describe, expect, it, vi } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import type { StorageBucketProvider, StorageBucketRef } from "@keymaster/contracts";
import { StorageRuntimeError } from "../../runtime/storageError.js";
import { createPlatformRootStore } from "./platformRootStore.js";

interface TestObject {
  bytes: Uint8Array;
  etag: string;
  lastModified: string;
}

interface OwnerPutBarrier {
  owner: string;
  reached: Promise<void>;
  resolveReached(): void;
  release(): void;
  released: Promise<void>;
  triggered: boolean;
}

interface ProviderState {
  objects: Map<string, TestObject>;
  sequence: number;
  ownerPutBarrier?: OwnerPutBarrier;
}

function makeProvider(state: ProviderState = { objects: new Map(), sequence: 0 }): StorageBucketProvider {
  const nextObject = (path: string, bytes: Uint8Array): TestObject => {
    state.sequence += 1;
    return {
      bytes: bytes.slice(),
      etag: `${path}:${state.sequence}`,
      lastModified: new Date(state.sequence * 1000).toISOString()
    };
  };
  return {
    provider: "local",
    bucketId: "schema-test",
    async probe() { return { ok: true, conditionalWrites: "native", latencyMs: 0 }; },
    async get(path, input = {}) {
      const object = state.objects.get(path);
      if (object && input.ifMatch !== undefined && object.etag !== input.ifMatch) throw new StorageRuntimeError("storage_conflict");
      return object ? { path, bytes: object.bytes.slice(), etag: object.etag, lastModified: object.lastModified } : undefined;
    },
    async list(input = {}) {
      const prefix = input.prefix ?? "";
      const paths = [...state.objects.keys()].filter((path) => path.startsWith(prefix)).sort();
      const start = input.cursor ? Number(input.cursor) : 0;
      const limit = input.limit ?? 1000;
      const objects = paths.slice(start, start + limit).map((path) => {
        const object = state.objects.get(path)!;
        return { path, bytes: new Uint8Array(0), size: object.bytes.byteLength, etag: object.etag, lastModified: object.lastModified };
      });
      const nextCursor = start + objects.length < paths.length ? String(start + objects.length) : undefined;
      return { objects, nextCursor };
    },
    async put(path, bytes, condition) {
      const putBarrier = state.ownerPutBarrier;
      if (putBarrier && !putBarrier.triggered && path.startsWith(`${putBarrier.owner}/`)) {
        putBarrier.triggered = true;
        putBarrier.resolveReached();
        await putBarrier.released;
      }
      const current = state.objects.get(path);
      if (condition?.ifNoneMatch === "*" && current) throw new StorageRuntimeError("storage_conflict");
      if (condition?.ifMatch !== undefined && (!current || current.etag !== condition.ifMatch)) throw new StorageRuntimeError("storage_conflict");
      const next = nextObject(path, bytes);
      state.objects.set(path, next);
      return { etag: next.etag, lastModified: next.lastModified };
    },
    async delete(path, input = {}) {
      const current = state.objects.get(path);
      if (!current) return;
      if (input.ifMatch !== undefined && current.etag !== input.ifMatch) throw new StorageRuntimeError("storage_conflict");
      state.objects.delete(path);
    },
    dispose() { /* test provider */ }
  };
}

function armOwnerPutBarrier(state: ProviderState, owner: string): OwnerPutBarrier {
  let resolveReached!: () => void;
  let resolveReleased!: () => void;
  const reached = new Promise<void>((resolve) => { resolveReached = resolve; });
  const released = new Promise<void>((resolve) => { resolveReleased = resolve; });
  const barrier: OwnerPutBarrier = {
    owner,
    reached,
    resolveReached,
    release: resolveReleased,
    released,
    triggered: false
  };
  state.ownerPutBarrier = barrier;
  return barrier;
}

const bucket: StorageBucketRef = { bucketId: "schema-test", bucketGeneration: 1, provider: "local" };

describe("PlatformRoot 授权与 owner 目录清理", () => {
  it("authorizes every central bucket/platform declaration by default", async () => {
    const root = createPlatformRootStore({ provider: makeProvider(), bucket });
    await expect(root.openPlatformStore({ declaration: CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads })).resolves.toMatchObject({
      moduleId: "storage",
      purposeId: "multipart-uploads",
    });
    await expect(root.openPlatformSnapshot({
      declaration: CENTRAL_STORAGE_DECLARATIONS.coordinatorSettings,
      validate: (value) => value === null ? null : (() => { throw new Error("invalid"); })(),
    })).resolves.toBeDefined();
  });

  it("uses the same custom full-declaration whitelist for K-V and snapshots", async () => {
    const root = createPlatformRootStore({
      provider: makeProvider(),
      bucket,
      platformStorageDeclarations: [CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads],
    });
    await expect(root.openPlatformStore({ declaration: CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads })).resolves.toBeDefined();
    await expect(root.openPlatformSnapshot({
      declaration: CENTRAL_STORAGE_DECLARATIONS.coordinatorSettings,
      validate: (value) => value === null ? null : (() => { throw new Error("invalid"); })(),
    })).rejects.toMatchObject({ code: "storage_forbidden" });
    await expect(root.openPlatformStore({
      declaration: { ...CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads, schemaVersion: 2 },
    })).rejects.toMatchObject({ code: "storage_forbidden" });
  });

  it("keeps key namespaces independent while locking each owner directory version", async () => {
    const provider = makeProvider();
    const root = createPlatformRootStore({ provider, bucket });
    const ownerPublicKeyHex = `02${"11".repeat(32)}`;
    await root.openKeyValueStore({ ownerPublicKeyHex, declaration: CENTRAL_STORAGE_DECLARATIONS.messageHistory });
    await expect(root.openKeyValueStore({ ownerPublicKeyHex, declaration: { ...CENTRAL_STORAGE_DECLARATIONS.messageHistory, schemaVersion: 2 } })).rejects.toMatchObject({
      code: "storage_forbidden"
    });
    await expect(root.openKeyValueStore({ ownerPublicKeyHex: `03${"22".repeat(32)}`, declaration: { ...CENTRAL_STORAGE_DECLARATIONS.messageHistory, schemaVersion: 2 } })).rejects.toMatchObject({ code: "storage_forbidden" });
  });

  it("does not persist any owner lifecycle record while opening owner stores", async () => {
    const state: ProviderState = { objects: new Map(), sequence: 0 };
    const root = createPlatformRootStore({ provider: makeProvider(state), bucket });
    const ownerPublicKeyHex = `02${"55".repeat(32)}`;
    const stores = await Promise.all(
      Array.from({ length: 4 }, () => root.openKeyValueStore({
        ownerPublicKeyHex,
        declaration: CENTRAL_STORAGE_DECLARATIONS.messageHistory
      }))
    );

    // 桶内不再有 `.keymaster/owners/` 生命周期记录；打开只做声明授权。
    await Promise.all(stores.flatMap((store, storeIndex) => [
      store.put(`concurrent-${storeIndex}-a`, storeIndex),
      store.put(`concurrent-${storeIndex}-b`, storeIndex),
      store.get(`concurrent-${storeIndex}-missing`)
    ]));
    stores.forEach((store) => store.close());

    expect([...state.objects.keys()].some((path) => path.startsWith(".keymaster/owners/"))).toBe(false);
  });

  it("deletes the whole owner directory without a bucket-side lifecycle record", async () => {
    const state: ProviderState = { objects: new Map(), sequence: 0 };
    const root = createPlatformRootStore({ provider: makeProvider(state), bucket });
    const ownerPublicKeyHex = `02${"33".repeat(32)}`;
    const store = await root.openKeyValueStore({ ownerPublicKeyHex, declaration: CENTRAL_STORAGE_DECLARATIONS.messageHistory });
    await store.put("before-delete", "value");

    await root.deleteOwnerStorage({ ownerPublicKeyHex });

    // owner 目录下的对象被清理；没有桶内生命周期对象。
    expect([...state.objects.keys()].some((path) => path.startsWith(`${ownerPublicKeyHex}/`))).toBe(false);
    expect([...state.objects.keys()].some((path) => path.startsWith(".keymaster/owners/"))).toBe(false);
  });

  it("sweeps objects written concurrently while deletion is listing", async () => {
    const state: ProviderState = { objects: new Map(), sequence: 0 };
    const root = createPlatformRootStore({ provider: makeProvider(state), bucket });
    const ownerPublicKeyHex = `03${"44".repeat(32)}`;
    const store = await root.openKeyValueStore({ ownerPublicKeyHex, declaration: CENTRAL_STORAGE_DECLARATIONS.messageHistory });
    const barrier = armOwnerPutBarrier(state, ownerPublicKeyHex);
    const inflight = store.put("inflight", "late");
    await barrier.reached;

    const deleting = root.deleteOwnerStorage({ ownerPublicKeyHex });
    barrier.release();
    await expect(inflight).resolves.toMatchObject({ key: "inflight" });
    // 迟到写入会在删除的下一轮扫描里被清掉（删除循环持续到目录为空）。
    await expect(deleting).resolves.toBeUndefined();
    expect([...state.objects.keys()].some((path) => path.startsWith(`${ownerPublicKeyHex}/`))).toBe(false);
  });
});
