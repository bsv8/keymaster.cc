import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
import { afterEach, expect, it, vi } from "vitest";
import { STORAGE_FILE_CLIENTS_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY, CENTRAL_STORAGE_DECLARATIONS, type PluginContext, type PluginManifest } from "@keymaster/contracts";

import { createInMemoryModuleFileStore } from "./storage/inMemoryModuleFileStore.js";
import { createInMemoryKeyValueStore, withTestStorageBinding } from "./storage/inMemoryKeyValueStore.js";
const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.dispose())); });
async function fixture(kind: "files" | "kv", deferred = false) {
  let ctx!: PluginContext;
  let release!: () => void;
  const gate = deferred ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  let generation = "test-wallet";
  let liveGeneration: string | undefined;
  const stores: Array<{ close(): void; list(): Promise<unknown> }> = [];
  const openFiles = vi.fn(async () => { const requestedGeneration = generation; await gate; const store = createInMemoryModuleFileStore({ walletGeneration: requestedGeneration }); stores.push(store); return store; });
  const openKv = vi.fn(async () => { const requestedGeneration = generation; await gate; const store = createInMemoryKeyValueStore({ ...withTestStorageBinding(CENTRAL_STORAGE_DECLARATIONS.bsvPrice), walletGeneration: requestedGeneration }); stores.push(store); return store; });
  const id = kind === "files" ? "contacts" : "bsv-price";
  const manifest: PluginManifest = { id, name: id, units: [{ id: `${id}.window`, runtime: "window-main", scopeKind: "root",
    dependencies: [{ capability: kind === "files" ? STORAGE_FILE_CLIENTS_CAPABILITY : STORAGE_KV_CLIENTS_CAPABILITY, sourceRuntime: "window-main" }],
    storage: kind === "files" ? CENTRAL_STORAGE_DECLARATIONS.contactsAddressBook : CENTRAL_STORAGE_DECLARATIONS.bsvPrice,
  }] };
  const host = createKeymasterPluginHost({ runtime: "window-main",
    storageBindingAuthority: { getWalletGeneration: () => liveGeneration, openOwnerFileStore: openFiles, openOwnerAppStore: openKv,
      openPlatformStore: async () => { throw new Error("unused"); }, clearStorageRoot: async () => {},
    }, runtimeUnitImplementationRegistry: { get: () => context => { ctx = context; } },
  });
  hosts.push(host);
  await host.register(manifest);
  const read = kind === "files" ? () => ctx.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, "address-book").list() : () => ctx.capability(STORAGE_KV_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, "settings").list();
  return { host, id, read, open: kind === "files" ? openFiles : openKv, stores, setGeneration: (next: string) => { liveGeneration = next; generation = next; }, release: () => release() };
}
for (const kind of ["files", "kv"] as const) {
  it(`shares the opening ${kind} binding between simultaneous resource reads`, async () => {
    const { read, open, release } = await fixture(kind, true);
    const operations = [read(), read(), read()];
    expect(open).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all(operations)).resolves.toHaveLength(3);
    await read();
    expect(open).toHaveBeenCalledTimes(1);
  });
  it(`closes a late ${kind} binding on revoke without entering its handler`, async () => {
    const { host, id, read, release, stores } = await fixture(kind, true);
    const operation = read();
    const rejected = expect(operation).rejects.toThrow();
    await host.revoke(id, "session ended during binding");
    release();
    await rejected;
    const store = stores[0]!;
    await expect(store.list()).rejects.toThrow(/closed/);
  });
  it(`closes a stale ${kind} opening and permits a fresh binding after wallet generation changes`, async () => {
    const { read, open, release, stores, setGeneration } = await fixture(kind, true);
    const operation = read();
    const rejected = expect(operation).rejects.toThrow(/wallet generation changed/);
    setGeneration("next-wallet");
    release();
    await rejected;
    await expect(stores[0]!.list()).rejects.toThrow(/closed/);
    await expect(read()).resolves.toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
  });
  it(`permits retry after the ${kind} opening fails`, async () => {
    const { read, open } = await fixture(kind);
    open.mockRejectedValueOnce(new Error("binding unavailable"));
    await expect(read()).rejects.toThrow("binding unavailable");
    await expect(read()).resolves.toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
  });

}
