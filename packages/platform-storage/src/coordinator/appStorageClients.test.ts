import { afterEach, expect, it, vi } from "vitest";
import { APP_STORAGE_CLIENTS_CAPABILITY, deriveAppStorageName, type AppStorageBinding, type PluginContext, type StorageRuntimeController } from "@keymaster/contracts";
import { createKeymasterPluginHost } from "@keymaster/runtime/assembly";
import { createAppStorageClients } from "./appStorageClients.js";
const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.dispose())); });
const binding: AppStorageBinding = { connectSessionId: "session", transportOrigin: "https://app.example", sessionEpoch: "s1", walletGeneration: "w1", runGeneration: "r1", appIdentity: { version: 1, publisherPublicKeyHex: "02" + "11".repeat(32), appId: "example", appName: "Example", identityDigestHex: "22".repeat(32) } };
async function fixture(list: StorageRuntimeController["list"], id = "protocol") {
  let context!: PluginContext;
  const controller = { list } as StorageRuntimeController;
  const host = createKeymasterPluginHost({ runtime: "window-main", capabilities: [{ capability: APP_STORAGE_CLIENTS_CAPABILITY, value: createAppStorageClients(controller) }], runtimeUnitImplementationRegistry: { get: () => ctx => { context = ctx; } } });
  hosts.push(host);
  await host.register({ id, name: id, units: [{ id: `${id}.window`, runtime: "window-main", scopeKind: "root", dependencies: [{ capability: APP_STORAGE_CLIENTS_CAPABILITY, sourceRuntime: "window-main" }] }] });
  return { host, bind: (facts = binding) => context.capability(APP_STORAGE_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, facts) };
}
it("derives App directories and discards caller supplied namespace and extra fields", async () => {
  const list = vi.fn(async (_grant: Parameters<StorageRuntimeController["list"]>[0], _input: Parameters<StorageRuntimeController["list"]>[1]) => ({ entries: [] }));
  const { bind } = await fixture(list as unknown as StorageRuntimeController["list"]);
  const client = bind({ ...binding, moduleId: "attacker", purposeId: "secrets", arbitrary: "ignored" } as AppStorageBinding);
  await client.list({});
  const grant = list.mock.calls[0]![0];
  expect(grant).toMatchObject({ appStorageName: deriveAppStorageName(binding.appIdentity), purposeId: "files", connectSessionId: "session" });
  expect(grant.moduleId).not.toBe("attacker");
  expect(grant).not.toHaveProperty("arbitrary");
});
it("rejects foreign consumers and incomplete session bindings before I/O", async () => {
  const list = vi.fn();
  const foreign = await fixture(list, "other");
  expect(foreign.bind).toThrow();
  const gateway = await fixture(list);
  expect(() => gateway.bind({ ...binding, sessionEpoch: "" })).toThrow();
  expect(list).not.toHaveBeenCalled();
});
it("rejects cached calls and late results after the gateway instance is revoked", async () => {
  let finish!: (value: never) => void;
  const list = vi.fn(() => new Promise<never>(resolve => { finish = resolve; }));
  const { host, bind } = await fixture(list);
  const cached = bind().list;
  const pending = cached({});
  const rejected = expect(pending).rejects.toThrow();
  await host.revoke("protocol", "test");
  finish({} as never);
  await rejected;
  await expect(cached({})).rejects.toThrow();
  expect(list).toHaveBeenCalledOnce();
});
