import { describe, expect, it } from "vitest";
import { createInMemoryKeyValueStore } from "./storage/inMemoryKeyValueStore.js";
import { createPluginConfigStore, PluginConfigIncompatibleError } from "./pluginConfigStore.js";

describe("plugin config store", () => {
  it("reads and persists the versioned platform K-V record", async () => {
    const storage = createInMemoryKeyValueStore({
      scope: "platform",
      applicationStorageId: "settings",
      schemaVersion: 1,
      bucketId: "test",
      bucketGeneration: 1
    });
    const store = createPluginConfigStore({ storage, initial: { optional: false } });
    store.setRequiredPluginIds(["vault"]);
    store.setEnabled("optional", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const record = await storage.get<{ version: number; enabled: Record<string, boolean> }>("plugins", { partition: "settings" });
    expect(record?.value).toEqual({ version: 2, enabled: { optional: true, vault: true } });
  });

  it("normalizes required plugins without a browser persistence API", () => {
    const store = createPluginConfigStore({ initial: { vault: false, optional: false } });
    expect(store.normalize(["vault"])).toEqual({ vault: true, optional: false });
    expect(store.read()).toEqual({ vault: true, optional: false });
  });

  it("keeps optional settings and reports K-V write failures", async () => {
    const storage = createInMemoryKeyValueStore({
      scope: "platform",
      applicationStorageId: "settings",
      schemaVersion: 1,
      bucketId: "test",
      bucketGeneration: 1
    });
    storage.put = async () => { throw new Error("unavailable"); };
    const store = createPluginConfigStore({ storage, initial: {} });
    store.setEnabled("optional", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.read()).toEqual({ optional: false });
    expect(store.diagnostics().some((d) => d.kind === "write-failed")).toBe(true);
  });

  it("does not write before remote settings have been hydrated", async () => {
    const storage = createInMemoryKeyValueStore({
      scope: "platform",
      applicationStorageId: "settings",
      schemaVersion: 1,
      bucketId: "test",
      bucketGeneration: 1
    });
    await storage.put("plugins", { version: 2, enabled: { remote: true } }, { partition: "settings" });
    const originalPut = storage.put.bind(storage);
    let putCount = 0;
    storage.put = async (...args) => { putCount += 1; return originalPut(...args); };
    const store = createPluginConfigStore({ storage });
    store.setEnabled("local", false);
    expect(putCount).toBe(0);
    await store.hydrate();
    expect(store.read()).toEqual({ remote: true });
    store.setRequiredPluginIds(["required"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(putCount).toBe(1);
  });

  it("rejects v1 config without migrating or overwriting the remote record", async () => {
    const storage = createInMemoryKeyValueStore({
      scope: "platform",
      applicationStorageId: "settings",
      schemaVersion: 1,
      bucketId: "test",
      bucketGeneration: 1
    });
    await storage.put("plugins", { version: 1, value: { legacy: true } }, { partition: "settings" });
    const originalPut = storage.put.bind(storage);
    let putCount = 0;
    storage.put = async (...args) => { putCount += 1; return originalPut(...args); };
    const store = createPluginConfigStore({ storage });

    await expect(store.hydrate()).rejects.toBeInstanceOf(PluginConfigIncompatibleError);
    expect(store.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "incompatible" })
    ]));
    expect(store.schemaVersion()).toBe(1);
    expect(putCount).toBe(0);
    store.setEnabled("local", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(putCount).toBe(0);
    expect((await storage.get("plugins", { partition: "settings" }))?.value).toEqual({ version: 1, value: { legacy: true } });
  });
});
