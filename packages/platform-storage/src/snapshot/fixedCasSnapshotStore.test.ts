import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import type { PluginStorageDeclaration, StorageBucketProvider, StorageNamespaceBinding } from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";
import { createFixedCasSnapshotStore } from "./fixedCasSnapshotStore.js";

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
}

function fixture() {
  const objects = new Map<string, StoredObject>();
  const puts: Array<{ path: string; condition: { ifMatch?: string; ifNoneMatch?: "*" } }> = [];
  let sequence = 0;
  const provider: StorageBucketProvider = {
    provider: "local",
    bucketId: "snapshot-bucket",
    async probe() { return { ok: true, conditionalWrites: "native", latencyMs: 0 }; },
    async get(path) {
      const object = objects.get(path);
      return object ? { path, bytes: object.bytes.slice(), etag: object.etag } : undefined;
    },
    async list() { return { objects: [] }; },
    async put(path, bytes, condition = {}) {
      puts.push({ path, condition: { ...(condition.ifMatch ? { ifMatch: condition.ifMatch } : {}), ...(condition.ifNoneMatch ? { ifNoneMatch: condition.ifNoneMatch } : {}) } });
      const current = objects.get(path);
      if (condition.ifNoneMatch === "*" && current) throw new StorageRuntimeError("storage_conflict", "exists");
      if (condition.ifMatch !== undefined && current?.etag !== condition.ifMatch) throw new StorageRuntimeError("storage_conflict", "changed");
      sequence += 1;
      const next = { bytes: bytes.slice(), etag: `etag-${sequence}` };
      objects.set(path, next);
      return { etag: next.etag };
    },
    async delete(path) { objects.delete(path); },
    dispose() { /* test provider */ },
  };
  return { provider, objects, puts };
}

const declaration = CENTRAL_STORAGE_DECLARATIONS.coordinatorSelection;
const binding: StorageNamespaceBinding = {
  ...declaration,
  bucketId: "snapshot-bucket",
  bucketGeneration: 7,
};
const path = ".keymaster/system/coordinator/selection/current";

function validateRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("payload invalid");
  const record = value as Record<string, unknown>;
  if (Object.values(record).some((item) => typeof item !== "string")) throw new Error("payload invalid");
  return { ...record } as Record<string, string>;
}

function open(storeFixture: ReturnType<typeof fixture>, isCurrent = () => true) {
  return createFixedCasSnapshotStore({ provider: storeFixture.provider, binding, validate: validateRecord, isCurrent });
}

function envelope(value: unknown, overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    format: "keymaster.storage.snapshot",
    version: 1,
    declaration,
    revision: 1,
    value,
    ...overrides,
  }));
}

describe("fixed CAS snapshot store", () => {
  it("keeps Coordinator selection, settings, and plugin intent on independent provider objects", async () => {
    const state = fixture();
    const openCoordinatorObject = (coordinatorDeclaration: PluginStorageDeclaration) => createFixedCasSnapshotStore<Record<string, unknown>>({
      provider: state.provider,
      binding: { ...coordinatorDeclaration, bucketId: state.provider.bucketId, bucketGeneration: 7 },
      validate: (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("payload invalid");
        return structuredClone(value as Record<string, unknown>);
      },
    });
    const selection = openCoordinatorObject(CENTRAL_STORAGE_DECLARATIONS.coordinatorSelection);
    const settings = openCoordinatorObject(CENTRAL_STORAGE_DECLARATIONS.coordinatorSettings);
    const pluginIntent = openCoordinatorObject(CENTRAL_STORAGE_DECLARATIONS.coordinatorPluginIntent);

    await selection.write({ selectedPublicKeyHex: "02" + "11".repeat(32) });
    expect(state.puts.map((put) => put.path)).toEqual([".keymaster/system/coordinator/selection/current"]);
    await Promise.all([selection.read(), settings.read(), pluginIntent.read()]);
    expect(state.puts).toHaveLength(1);

    await settings.write({ scheduleSettings: { assetHoldingsIntervalMs: 60_000 } });
    expect(state.puts.at(-1)?.path).toBe(".keymaster/system/coordinator/settings/current");
    await pluginIntent.write({ revision: 1, desiredEnabled: { background: false }, desiredRevision: { background: 1 } });
    expect(state.puts.at(-1)?.path).toBe(".keymaster/system/coordinator/plugin-intent/current");
    expect([...state.objects.keys()].sort()).toEqual([
      ".keymaster/system/coordinator/plugin-intent/current",
      ".keymaster/system/coordinator/selection/current",
      ".keymaster/system/coordinator/settings/current",
    ]);
  });

  it("uses If-None-Match for the first write at the fixed current path", async () => {
    const state = fixture();
    await expect(open(state).write({ selected: "a" }, { ifRevision: 0 })).resolves.toEqual({ revision: 1, wrote: true });
    expect(state.puts).toEqual([{ path, condition: { ifNoneMatch: "*" } }]);
    expect([...state.objects.keys()]).toEqual([path]);
  });

  it("allows only one of two independent handles to create the snapshot", async () => {
    const state = fixture();
    const first = open(state);
    const second = open(state);
    const results = await Promise.allSettled([
      first.write({ selected: "first" }, { ifRevision: 0 }),
      second.write({ selected: "second" }, { ifRevision: 0 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "storage_conflict" } });
  });

  it("rejects stale ifRevision without writing", async () => {
    const state = fixture();
    const store = open(state);
    await store.write({ selected: "a" });
    await expect(store.write({ selected: "b" }, { ifRevision: 0 })).rejects.toMatchObject({ code: "storage_conflict" });
    expect(state.puts).toHaveLength(1);
  });

  it("treats object key order as the same semantic value", async () => {
    const state = fixture();
    const store = open(state);
    await store.write({ alpha: "a", beta: "b" });
    await expect(store.write({ beta: "b", alpha: "a" }, { ifRevision: 1 })).resolves.toEqual({ revision: 1, wrote: false });
    expect(state.puts).toHaveLength(1);
  });

  it.each([
    ["corrupt JSON", new TextEncoder().encode("{")],
    ["extra envelope field", envelope({}, { extra: true })],
    ["extra declaration field", envelope({}, { declaration: { ...declaration, extra: true } })],
    ["mismatched declaration", envelope({}, { declaration: { ...declaration, purposeId: "settings" } })],
  ])("fails closed for %s", async (_name, bytes) => {
    const state = fixture();
    state.objects.set(path, { bytes, etag: "bad" });
    await expect(open(state).read()).rejects.toMatchObject({ code: "storage_provider_error" });
  });

  it("fails closed when the payload validator rejects persisted or new data", async () => {
    const state = fixture();
    state.objects.set(path, { bytes: envelope({ selected: 1 }), etag: "bad-payload" });
    await expect(open(state).read()).rejects.toMatchObject({ code: "storage_provider_error" });
    state.objects.clear();
    await expect(open(state).write({ selected: 1 } as unknown as Record<string, string>)).rejects.toMatchObject({ code: "storage_provider_error" });
    expect(state.puts).toHaveLength(0);
  });

  it("rejects reads and writes after the Root generation becomes stale", async () => {
    const state = fixture();
    let current = true;
    const store = open(state, () => current);
    await store.write({ selected: "a" });
    current = false;
    await expect(store.read()).rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(store.write({ selected: "b" })).rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("requires a validator and rejects binary snapshot T at compile time", () => {
    const state = fixture();
    // @ts-expect-error validate is mandatory
    createFixedCasSnapshotStore<Record<string, string>>({ provider: state.provider, binding });
    // @ts-expect-error binary values belong to K-V, not JSON snapshot stores
    createFixedCasSnapshotStore<Uint8Array>({ provider: state.provider, binding, validate: (value) => value as Uint8Array });
  });
});
