import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "./inMemoryKeyValueStore.js";

function createStore(now?: () => number) {
  return createInMemoryKeyValueStore({
    ...CENTRAL_STORAGE_DECLARATIONS.protocolSessions,
    bucketId: "in-memory-test",
    bucketGeneration: 1,
  }, { ...(now ? { now } : {}), generateId: () => "test-commit" });
}

describe("in-memory K-V fixture", () => {
  it("returns persisted timestamps for semantic put and net-zero commit no-ops", async () => {
    let clock = 10;
    const store = createStore(() => clock);
    const first = await store.put("value", { b: 2, a: 1 }, { partition: "state" });
    expect(first).toEqual({ key: "value", revision: 1, updatedAt: 10 });

    clock = 15;
    await expect(store.put("other", true, { partition: "state" })).resolves.toEqual({ key: "other", revision: 2, updatedAt: 15 });

    clock = 20;
    await expect(store.put("value", { a: 1, b: 2 }, { partition: "state" })).resolves.toEqual({ key: "value", revision: 2, updatedAt: 10 });
    await expect(store.get("value", { partition: "state" })).resolves.toMatchObject({ revision: 2, updatedAt: 10 });

    clock = 30;
    await expect(store.commit({ partition: "state", operations: [
      { type: "put", key: "value", value: "temporary" },
      { type: "put", key: "value", value: { b: 2, a: 1 } },
    ] })).resolves.toEqual({ revision: 2, commitId: "", committedAt: 15 });
    await expect(store.commit({ partition: "empty", operations: [] })).resolves.toEqual({ revision: 0, commitId: "", committedAt: 0 });
  });

  it("uses final semantic state to decide whether a commit changed", async () => {
    const store = createStore();
    await store.put("existing", { b: 2, a: 1 }, { partition: "state" });
    const result = await store.commit({ partition: "state", operations: [
      { type: "put", key: "existing", value: { temporary: true } },
      { type: "put", key: "existing", value: { a: 1, b: 2 } },
      { type: "put", key: "missing", value: new Uint8Array([1, 2]) },
      { type: "delete", key: "missing" },
      { type: "delete", key: "also-missing" },
    ] });
    expect(result).toMatchObject({ revision: 1, commitId: "" });
    await expect(store.get("existing", { partition: "state" })).resolves.toMatchObject({ value: { b: 2, a: 1 }, revision: 1 });
  });

  it("treats equal Uint8Array values as no-ops", async () => {
    const store = createStore();
    await store.put("bytes", new Uint8Array([1, 2, 3]));
    await expect(store.put("bytes", new Uint8Array([1, 2, 3]))).resolves.toMatchObject({ revision: 1 });
    await expect(store.list()).resolves.toMatchObject({ revision: 1 });
  });

  it("reports optimistic conflicts with the stable code", async () => {
    const store = createStore();
    await store.put("value", 1);
    await expect(store.put("value", 2, { ifRevision: 0 })).rejects.toMatchObject({ code: "storage_conflict" });
  });
});
