// @vitest-environment jsdom
//
// IndexedDB 永久存储授权条契约：
//   - 无 StorageManager 或已授权时不渲染；
//   - 未授权时显示在 shell 顶部，点击授权后仍拒绝时保持显示；
//   - 授权成功后才消失。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createKeymasterPluginHost as createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import { SHELL_RESOURCES } from "../i18n/resources.js";
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

function renderBar() {
  const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [SHELL_RESOURCES] });
  return render(
    <PluginHostProvider host={host}>
      <IndexedDbPersistenceBar />
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
      renderBar();
      await waitFor(() => expect(screen.queryByTestId("indexeddb-persistence-bar")).toBeNull());
    } finally {
      restore();
    }
  });

  it("renders nothing when storage is already persistent", async () => {
    const restore = installStorage({ persisted: async () => true, persist: async () => true });
    try {
      renderBar();
      await waitFor(() => expect(screen.queryByTestId("indexeddb-persistence-bar")).toBeNull());
    } finally {
      restore();
    }
  });

  it("stays visible when the browser refuses persistence", async () => {
    const restore = installStorage({ persisted: async () => false, persist: async () => false });
    try {
      renderBar();
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
      renderBar();
      await screen.findByTestId("indexeddb-persistence-bar");
      fireEvent.click(screen.getByRole("button", { name: /Allow persistent storage|授权永久存储/u }));
      await waitFor(() => expect(screen.queryByTestId("indexeddb-persistence-bar")).toBeNull());
    } finally {
      restore();
    }
  });
});
