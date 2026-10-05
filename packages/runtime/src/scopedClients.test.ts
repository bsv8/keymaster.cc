import { afterEach, expect, it, vi } from "vitest";
import { STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY, type PluginContext, type PluginManifest, type StorageCoordinatorControl } from "@keymaster/contracts";
import { createScopedClientBinding } from "./scopedClientBinding.js";
import { createKeymasterPluginHost } from "./keymasterHostAdapter.js";
const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.dispose())); });
async function fixture(client: object, id = "storage", declared = true) {
  let context!: PluginContext;
  const host = createKeymasterPluginHost({ runtime: "window-main", capabilities: [{ capability: STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY, value: createScopedClientBinding(STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY, "storage", () => client as StorageCoordinatorControl) }],
    runtimeUnitImplementationRegistry: { get: () => ctx => { context = ctx; } },
  });
  hosts.push(host);
  const manifest: PluginManifest = { id, name: id, units: [{ id: `${id}.window`, runtime: "window-main", scopeKind: "root",
    dependencies: declared ? [{ capability: STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY, sourceRuntime: "window-main" }] : [],
  }] };
  await host.register(manifest);
  const bind = () => context.capability(STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY).bind(context.consumer, context.scope);
  return { host, context, bind };
}
it("binds frozen facades without exposing their prototype and preserves own method enumeration", async () => {
  const source = Object.freeze(Object.assign(Object.create(null), { getIsConnected: () => true }));
  const { bind } = await fixture(source);
  const client = bind();
  expect(client.getIsConnected()).toBe(true);
  expect({ ...client }.getIsConnected()).toBe(true);
  expect(Object.keys(client)).toEqual(["getIsConnected"]);
  expect("getIsConnected" in client).toBe(true);
});
it("rejects another plugin's binding and undeclared access before entering the driver", async () => {
  const getIsConnected = vi.fn(() => true);
  const other = await fixture({ getIsConnected }, "outsider");
  expect(other.bind).toThrow(/impersonate/);
  const undeclared = await fixture({ getIsConnected }, "storage", false);
  expect(undeclared.bind).toThrow();
  expect(getIsConnected).not.toHaveBeenCalled();
});
it("releases a subscription once, fences cached methods and callbacks, and discards late results", async () => {
  const off = vi.fn();
  let callback!: () => void;
  let finish!: (value: boolean) => void;
  const source = Object.freeze({ subscribeTopic: (_topic: string, listener: () => void) => { callback = listener; return off; },
    getIsConnected: () => true, connect: () => new Promise<boolean>(resolve => { finish = resolve; }),
  });
  const { bind, host } = await fixture(source);
  const client: StorageCoordinatorControl = bind();
  const listener = vi.fn();
  const close = client.subscribeTopic("storage.state", listener);
  const cached = client.getIsConnected;
  const descriptorMethod = Object.getOwnPropertyDescriptor(client, "getIsConnected")!.value;
  const pending = client.connect();
  const rejection = expect(pending).rejects.toThrow();
  callback(); expect(listener).toHaveBeenCalledOnce();
  await host.revoke("storage", "test ended");
  callback(); expect(listener).toHaveBeenCalledOnce();
  close(); close(); expect(off).toHaveBeenCalledOnce();
  expect(cached).toThrow();
  expect(descriptorMethod).toThrow();
  finish(true); await rejection;
});
