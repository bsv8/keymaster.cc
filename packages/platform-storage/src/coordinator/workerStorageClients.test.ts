import { expect, it, vi } from "vitest";
import type { KeyValueStore, PluginStorageDeclaration } from "@keymaster/contracts";
import type { StoragePrivateRootStore } from "../storage-access/platform-root/platformRootStore.js";
import { createWorkerStorageClients } from "./workerStorageClients.js";

it("shares an open, closes late stores after revocation and fences results from an invalidated binding", async () => {
  const declaration: PluginStorageDeclaration = { moduleId: "contacts", purposeId: "state", authority: "built-in-module", model: "kv", schemaVersion: 1 };
  let binding = { walletGeneration: "wallet", sessionEpoch: "session", runGeneration: "run" };
  let opened!: (store: KeyValueStore) => void;
  const root = { openKeyValueStore: vi.fn(() => new Promise<KeyValueStore>(resolve => { opened = resolve; })) } as unknown as StoragePrivateRootStore;
  const release = vi.fn();
  const clients = createWorkerStorageClients({
    root: () => root, binding: () => binding, sameBinding: (a, b) => a === b,
    declaration: () => declaration, assertAvailable: () => {},
    assertLive: expected => { if (expected !== binding) throw new Error("stale"); },
    beginRequest: () => release, unavailable: message => new Error(message),
    withIoLease: (_operation, _model, execute) => execute(), onFailure: () => {},
    onInvalidate: () => {}, registerMaintenance: () => {}, unregisterMaintenance: () => {},
  });
  const handle = clients.keyValue("contacts", "state");
  const first = handle.get("first");
  const second = handle.get("second");
  const rejected = Promise.all([expect(first).rejects.toThrow("stale"), expect(second).rejects.toThrow("stale")]);
  expect(root.openKeyValueStore).toHaveBeenCalledTimes(1);
  clients.invalidateAll();
  binding = { ...binding, sessionEpoch: "next" };
  const staleStore = { close: vi.fn(), get: vi.fn() } as unknown as KeyValueStore;
  opened(staleStore);
  await rejected;
  expect(staleStore.close).toHaveBeenCalledTimes(1);
  expect(staleStore.get).not.toHaveBeenCalled();

  let finish!: (value: undefined) => void;
  const store = { close: vi.fn(), get: vi.fn(() => new Promise<undefined>(resolve => { finish = resolve; })) } as unknown as KeyValueStore;
  const read = handle.get("third");
  const refused = expect(read).rejects.toThrow("stale");
  opened(store);
  await vi.waitFor(() => expect(store.get).toHaveBeenCalledTimes(1));
  handle.close();
  finish(undefined);
  await refused;
  expect(release).toHaveBeenCalledTimes(1);
  expect(store.close).toHaveBeenCalledTimes(1);
  await expect(handle.get("after-close")).rejects.toThrow("closed");
});
