import { describe, expect, it } from "vitest";
import { createPluginConfigStore } from "./pluginConfigStore.js";

describe("plugin config projection", () => {
  it("keeps the projection in memory and normalizes required plugins", () => {
    const store = createPluginConfigStore({ initial: { optional: false } });
    store.setRequiredPluginIds(["required"]);
    expect(store.read()).toEqual({ optional: false, required: true });
    expect(store.schemaVersion()).toBe(0);
    expect(store.diagnostics()).toEqual([]);
  });

  it("resolves manifest defaults without persisting them", () => {
    const store = createPluginConfigStore({ initial: { disabled: false } });
    expect(store.resolveEnabled(["disabled", "defaulted", "missing"], (id) => id === "defaulted")).toEqual({
      enabled: new Set(["defaulted"]),
      ignored: [],
    });
    store.setEnabled("missing", true);
    expect(store.read()).toEqual({ disabled: false, missing: true });
  });

  it("closes cleanly without leaving a persistence queue", async () => {
    const store = createPluginConfigStore();
    store.setEnabled("optional", true);
    await store.hydrate();
    await store.flush();
    store.close();
    expect(store.read()).toEqual({ optional: true });
  });
});
