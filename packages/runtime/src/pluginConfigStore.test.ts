import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginConfigStore } from "./pluginConfigStore.js";

const KEY = "keymaster.plugins.runtime";

beforeEach(() => {
  localStorage.clear();
});

describe("plugin config store v2", () => {
  it("migrates a v1 object and writes v2", () => {
    localStorage.setItem(KEY, JSON.stringify({ vault: false, optional: false }));
    const store = createPluginConfigStore();
    expect(store.read()).toEqual({ vault: false, optional: false });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      version: 2,
      enabled: { vault: false, optional: false }
    });
    expect(store.diagnostics().some((d) => d.kind === "migrated-v1")).toBe(true);
  });

  it("normalizes required plugins and preserves optional settings", () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 2, enabled: { vault: false, optional: false } }));
    const store = createPluginConfigStore();
    store.setRequiredPluginIds(["vault"]);
    expect(store.read()).toEqual({ vault: true, optional: false });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      version: 2,
      enabled: { vault: true, optional: false }
    });
  });

  it("recovers from invalid and unknown storage values", () => {
    localStorage.setItem(KEY, "not-json");
    const invalid = createPluginConfigStore();
    expect(invalid.read()).toEqual({});
    expect(invalid.diagnostics().some((d) => d.kind === "invalid-json")).toBe(true);

    localStorage.setItem(KEY, JSON.stringify({ version: 99, enabled: { vault: false } }));
    const unknown = createPluginConfigStore();
    expect(unknown.read()).toEqual({});
    expect(unknown.diagnostics().some((d) => d.kind === "unknown-version")).toBe(true);
  });

  it("records persistence failures without blocking the in-memory snapshot", () => {
    const original = localStorage.setItem;
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const store = createPluginConfigStore();
    store.setEnabled("optional", false);
    expect(store.read()).toEqual({ optional: false });
    expect(store.diagnostics().some((d) => d.kind === "write-failed")).toBe(true);
    vi.spyOn(localStorage, "setItem").mockImplementation(original);
  });

  it("normalizes required=false from a storage event without a write loop", () => {
    let storageListener: ((event: StorageEvent) => void) | undefined;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { addEventListener: (_type: string, listener: (event: StorageEvent) => void) => { storageListener = listener; } }
    });
    try {
      const store = createPluginConfigStore();
      store.setRequiredPluginIds(["vault"]);
      localStorage.setItem(KEY, JSON.stringify({ version: 2, enabled: { vault: false } }));
      storageListener?.({ key: KEY } as StorageEvent);
      expect(store.read().vault).toBe(true);
      expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ version: 2, enabled: { vault: true } });
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
