import { expect, it, vi } from "vitest";
import { OWNED_RESOURCE_ACCESS_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, type OwnedResourceReader } from "@keymaster/contracts";
import { createKeymasterPluginHost } from "./keymasterHostAdapter.js";
it("rebinds identity-scoped resource observers after runtime records are refreshed", async () => {
  let reader!: OwnedResourceReader;
  let value = "first";
  const host = createKeymasterPluginHost({ runtime: "window-main", runtimeUnitImplementationRegistry: { get: () => context => {
    context.capability(RESOURCE_REGISTRY_CAPABILITY).register({ id: "view.state", scope: "active-key", key: () => ["view.state"], load: async () => ({ value }), equals: (a, b) => a!.value === b!.value, invalidation: "immediate" });
    reader = context.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(context.consumer, context.scope);
  } } });
  try {
    await host.register({ id: "view", name: "View", units: [{ id: "view.window", runtime: "window-main", scopeKind: "root", dependencies: [{ capability: RESOURCE_REGISTRY_CAPABILITY, sourceRuntime: "window-main" }, { capability: OWNED_RESOURCE_ACCESS_CAPABILITY, sourceRuntime: "window-main" }] }] });
    const changed = vi.fn();
    const off = reader.subscribe("view.state", [], changed);
    reader.ensure("view.state", []);
    await vi.waitFor(() => expect(reader.ensure<{ value: string }>("view.state", []).data?.value).toBe(value));
    changed.mockClear(); value = "second";
    host.resourceStore.refreshRuntimeBindings();
    reader.ensure("view.state", []);
    await vi.waitFor(() => expect(reader.ensure<{ value: string }>("view.state", []).data?.value).toBe(value));
    expect(changed).toHaveBeenCalled();
    expect(reader.ensure<{ value: string }>("view.state", []).data?.value).toBe("second");
    off();
    await host.revoke("view", "test");
    expect(() => reader.ensure("view.state", [])).toThrow();
  } finally { await host.dispose(); }
});

it("loads global identity-dependent projections after replacement owner contributions commit", async () => {
  let reader!: OwnedResourceReader;
  let contribution = "none";
  let instance = 0;
  const host = createKeymasterPluginHost({ runtime: "window-main", runtimeUnitImplementationRegistry: { get: id => ctx => {
    if (id === "view") {
      ctx.capability(RESOURCE_REGISTRY_CAPABILITY).register({ id: "view.global", scope: "global", key: () => ["global"], load: async () => contribution, invalidation: "immediate" });
      reader = ctx.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(ctx.consumer, ctx.scope);
    } else { contribution = `owner-${++instance}`; }
  } } });
  try {
    await host.registerAll([
      { id: "view", name: "View", units: [{ id: "view.window", runtime: "window-main", scopeKind: "root", dependencies: [{ capability: RESOURCE_REGISTRY_CAPABILITY, sourceRuntime: "window-main" }, { capability: OWNED_RESOURCE_ACCESS_CAPABILITY, sourceRuntime: "window-main" }] }] },
      { id: "owner", name: "Owner", units: [{ id: "owner.window", runtime: "window-main", scopeKind: "owner-session" }] }
    ]);
    const off = reader.subscribe("view.global", [], () => { reader.ensure("view.global", []); });
    reader.ensure("view.global", []);
    await vi.waitFor(() => expect(reader.ensure<string>("view.global", []).data).toBe("none"));
    await host.transitionRuntimeIdentity({ vaultStatus: "unlocked", ownerPublicKeyHex: "02" + "ab".repeat(32), sessionEpoch: "one", walletGeneration: "wallet", runGeneration: "run" });
    await vi.waitFor(() => expect(reader.ensure<string>("view.global", []).data).toBe("owner-1"));
    await host.transitionRuntimeIdentity({ vaultStatus: "unlocked", ownerPublicKeyHex: "02" + "ab".repeat(32), sessionEpoch: "two", walletGeneration: "wallet", runGeneration: "run" });
    await vi.waitFor(() => expect(reader.ensure<string>("view.global", []).data).toBe("owner-2"));
    off();
  } finally { await host.dispose(); }
});
