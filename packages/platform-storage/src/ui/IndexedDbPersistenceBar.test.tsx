import { createFixtureHost as createPluginHost } from "@keymaster/runtime/test-support";
// @vitest-environment jsdom
//
// IndexedDB 永久存储授权条契约：
//   - 无 StorageManager 或已授权时不渲染；
//   - 未授权时显示在 shell 顶部，点击授权后仍拒绝时保持显示；
//   - 授权成功后才消失。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import { PluginConsumerProvider } from "webloom-framework/react";
import { I18N_SERVICE_CAPABILITY, defineRuntimeUnitDependencies, type PluginContext } from "@keymaster/contracts";
import { SHELL_TEST_RESOURCES as SHELL_RESOURCES } from "@keymaster/runtime/test-support";
import { IndexedDbPersistenceBar } from "./IndexedDbPersistenceBar.js";

interface PersistenceManagerStub {
  persisted: () => Promise<boolean>;
  persist: () => Promise<boolean>;
}

function installStorage(manager: PersistenceManagerStub | undefined): () => void {
  const target = globalThis.navigator as Navigator & { storage?: unknown };
  const original = Object.getOwnPropertyDescriptor(target, "storage");
  Object.defineProperty(target, "storage", { configurable: true, value: manager });
  return () => {
    if (original) Object.defineProperty(target, "storage", original);
    else delete (target as { storage?: unknown }).storage;
  };
}

async function renderBar() {
  let context!: PluginContext;
  const host = createPluginHost({ runtime: "window-main", initialI18nResources: [SHELL_RESOURCES],
    runtimeUnitImplementationRegistry: { get: () => ctx => { context = ctx; } },
  });
  await host.register({ id: "storage-fixture", name: "Storage UI fixture", units: [{ id: "storage-fixture.window", runtime: "window-main", scopeKind: "root", dependencies: defineRuntimeUnitDependencies([{ capability: I18N_SERVICE_CAPABILITY }]) }] });
  return render(
    <PluginHostProvider host={host}>
      <PluginConsumerProvider consumer={context.consumer}><IndexedDbPersistenceBar /></PluginConsumerProvider>
    </PluginHostProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe("IndexedDbPersistenceBar", () => {
  it("renders nothing without a StorageManager", async () => {
    const restore = installStorage(undefined);
    try {
      await renderBar();
      await waitFor(() => expect(screen.queryByTestId("indexeddb-persistence-bar")).toBeNull());
    } finally {
      restore();
    }
  });

  it("renders nothing when storage is already persistent", async () => {
    const restore = installStorage({ persisted: async () => true, persist: async () => true });
    try {
      await renderBar();
      await waitFor(() => expect(screen.queryByTestId("indexeddb-persistence-bar")).toBeNull());
    } finally {
      restore();
    }
  });

  it("stays visible when the browser refuses persistence", async () => {
    const restore = installStorage({ persisted: async () => false, persist: async () => false });
    try {
      await renderBar();
      const bar = await screen.findByTestId("indexeddb-persistence-bar");
      expect(bar).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Allow persistent storage|授权永久存储/u }));
      await waitFor(() => {
        expect(screen.getByTestId("indexeddb-persistence-bar")).toBeTruthy();
        expect(bar.textContent).toMatch(/not granted|未获授权/u);
      });
    } finally {
      restore();
    }
  });

  it("hides after the browser grants persistence", async () => {
    let persisted = false;
    const restore = installStorage({
      persisted: async () => persisted,
      persist: async () => {
        persisted = true;
        return true;
      },
    });
    try {
      await renderBar();
      await screen.findByTestId("indexeddb-persistence-bar");
      fireEvent.click(screen.getByRole("button", { name: /Allow persistent storage|授权永久存储/u }));
      await waitFor(() => expect(screen.queryByTestId("indexeddb-persistence-bar")).toBeNull());
    } finally {
      restore();
    }
  });
});
