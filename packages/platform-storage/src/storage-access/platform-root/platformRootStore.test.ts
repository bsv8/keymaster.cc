import { describe, expect, it } from "vitest";
import type { StorageBucketProvider, StorageBucketRef } from "@keymaster/contracts";
import { StorageRuntimeError } from "../../runtime/storageRuntimeError.js";
import { createOwnerLifecycleGuardedProvider, createPlatformRootStore } from "./platformRootStore.js";

interface TestObject {
  bytes: Uint8Array;
  etag: string;
  lastModified: string;
}

interface OwnerListBarrier {
  owner: string;
  reached: Promise<void>;
  resolveReached(): void;
  release(): void;
  released: Promise<void>;
  triggered: boolean;
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
  ownerListBarrier?: OwnerListBarrier;
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
    provider: "opfs",
    bucketId: "schema-test",
    async probe() { return { ok: true, conditionalWrites: "native", latencyMs: 0 }; },
    async get(path, input = {}) {
      const object = state.objects.get(path);
      if (object && input.ifMatch !== undefined && object.etag !== input.ifMatch) throw new StorageRuntimeError("storage_conflict");
      return object ? { path, bytes: object.bytes.slice(), etag: object.etag, lastModified: object.lastModified } : undefined;
    },
    async list(input = {}) {
      const prefix = input.prefix ?? "";
      const barrier = state.ownerListBarrier;
      if (barrier && !barrier.triggered && prefix === `${barrier.owner}/`) {
        barrier.triggered = true;
        barrier.resolveReached();
        await barrier.released;
      }
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

function armOwnerListBarrier(state: ProviderState, owner: string): OwnerListBarrier {
  let resolveReached!: () => void;
  let resolveReleased!: () => void;
  const reached = new Promise<void>((resolve) => { resolveReached = resolve; });
  const released = new Promise<void>((resolve) => { resolveReleased = resolve; });
  const barrier: OwnerListBarrier = {
    owner,
    reached,
    resolveReached,
    release: resolveReleased,
    released,
    triggered: false
  };
  state.ownerListBarrier = barrier;
  return barrier;
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

const bucket: StorageBucketRef = { bucketId: "schema-test", bucketGeneration: 1, provider: "opfs" };

describe("PlatformRoot bucket schema", () => {
  it("persists namespace versions and rejects opening the same directory with another version", async () => {
    const provider = makeProvider();
    const root = createPlatformRootStore({ provider, bucket });
    await root.openPlatformStore({ applicationStorageId: "settings", schemaVersion: 1 });
    expect((await provider.get(".keymaster/schema"))?.bytes.byteLength).toBeGreaterThan(0);

    await expect(root.openPlatformStore({ applicationStorageId: "settings", schemaVersion: 2 })).rejects.toMatchObject({
      code: "storage_provider_error"
    });
  });

  it("keeps key namespaces independent while still locking each owner directory version", async () => {
    const provider = makeProvider();
    const root = createPlatformRootStore({ provider, bucket });
    const ownerPublicKeyHex = `02${"11".repeat(32)}`;
    await root.openKeyValueStore({ ownerPublicKeyHex, applicationStorageId: "Contacts", schemaVersion: 1 });
    await expect(root.openKeyValueStore({ ownerPublicKeyHex, applicationStorageId: "Contacts", schemaVersion: 2 })).rejects.toMatchObject({
      code: "storage_provider_error"
    });
    await expect(root.openKeyValueStore({ ownerPublicKeyHex: `03${"22".repeat(32)}`, applicationStorageId: "Contacts", schemaVersion: 2 })).resolves.toBeDefined();
  });

  it("fences shared-provider deletion, removes owner schema records, and creates a new generation on reactivation", async () => {
    const state: ProviderState = { objects: new Map(), sequence: 0 };
    const firstRoot = createPlatformRootStore({ provider: makeProvider(state), bucket });
    const secondRoot = createPlatformRootStore({ provider: makeProvider(state), bucket });
    const ownerPublicKeyHex = `02${"33".repeat(32)}`;
    const oldStore = await secondRoot.openKeyValueStore({ ownerPublicKeyHex, applicationStorageId: "Contacts", schemaVersion: 1 });
    await oldStore.put("before-delete", "value");

    const barrier = armOwnerListBarrier(state, ownerPublicKeyHex);
    const deleting = Promise.all([
      firstRoot.deleteOwnerStorage({ ownerPublicKeyHex }),
      secondRoot.deleteOwnerStorage({ ownerPublicKeyHex })
    ]);
    await barrier.reached;
    await expect(secondRoot.openKeyValueStore({ ownerPublicKeyHex, applicationStorageId: "Contacts", schemaVersion: 1 })).rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(oldStore.put("late", "must-fail")).rejects.toMatchObject({ code: "storage_unavailable" });
    barrier.release();
    await deleting;

    const schemaObject = state.objects.get(".keymaster/schema");
    expect(schemaObject).toBeDefined();
    const schema = JSON.parse(new TextDecoder().decode(schemaObject!.bytes)) as { namespaces: Record<string, number> };
    expect(Object.keys(schema.namespaces).some((key) => key.startsWith(`key|${ownerPublicKeyHex}|`))).toBe(false);
    const lifecycle = JSON.parse(new TextDecoder().decode(state.objects.get(`.keymaster/owners/${ownerPublicKeyHex}`)!.bytes)) as { status: string; generation: number };
    expect(lifecycle).toMatchObject({ status: "deleted", generation: 1 });
    await expect(createOwnerLifecycleGuardedProvider(makeProvider(state)).put(`${ownerPublicKeyHex}/Contacts/file.txt`, new Uint8Array([1]))).rejects.toMatchObject({ code: "storage_unavailable" });

    await expect(secondRoot.openKeyValueStore({ ownerPublicKeyHex, applicationStorageId: "Contacts", schemaVersion: 2 })).rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(secondRoot.activateOwnerStorage({ ownerPublicKeyHex })).resolves.toEqual({ generation: 2 });
    const freshStore = await secondRoot.openKeyValueStore({ ownerPublicKeyHex, applicationStorageId: "Contacts", schemaVersion: 2 });
    await expect(oldStore.put("old-generation", "must-fail")).rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(freshStore.put("new-generation", "works")).resolves.toMatchObject({ key: "new-generation" });
  });

  it("waits for an already-started remote owner operation before finalizing deletion", async () => {
    const state: ProviderState = { objects: new Map(), sequence: 0 };
    const root = createPlatformRootStore({ provider: makeProvider(state), bucket });
    const ownerPublicKeyHex = `03${"44".repeat(32)}`;
    const store = await root.openKeyValueStore({ ownerPublicKeyHex, applicationStorageId: "Contacts", schemaVersion: 1 });
    const barrier = armOwnerPutBarrier(state, ownerPublicKeyHex);
    const inflight = store.put("inflight", "late");
    await barrier.reached;

    const deleting = root.deleteOwnerStorage({ ownerPublicKeyHex });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const lifecycle = JSON.parse(new TextDecoder().decode(state.objects.get(`.keymaster/owners/${ownerPublicKeyHex}`)!.bytes)) as { status: string };
      if (lifecycle.status === "deleting") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    let deletionSettled = false;
    void deleting.then(() => { deletionSettled = true; }, () => { deletionSettled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(deletionSettled).toBe(false);

    barrier.release();
    await expect(inflight).rejects.toMatchObject({ code: "storage_unavailable" });
    await deleting;
    expect([...state.objects.keys()].some((path) => path.startsWith(`${ownerPublicKeyHex}/`))).toBe(false);
  });
});
