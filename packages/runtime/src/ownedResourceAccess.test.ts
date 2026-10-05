import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PluginConsumer } from "webloom-framework";
import { OWNED_RESOURCE_ACCESS_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, defineRuntimeUnitDependencies, type OwnedResourceReader, type PluginContext, type PluginManifest } from "@keymaster/contracts";

const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.dispose())); });
async function fixture() {
  const contexts = new Map<string, PluginContext>();
  const host = createKeymasterPluginHost({ runtime: "window-main", runtimeUnitImplementationRegistry: {
    get: id => ctx => {
      contexts.set(id, ctx);
      ctx.capability(RESOURCE_REGISTRY_CAPABILITY).register({ id: `${id}.snapshot`, scope: "global", key: () => [`${id}.snapshot`], load: async () => id, invalidation: "immediate" });
    },
  } });
  hosts.push(host);
  const manifest = (id: string): PluginManifest => ({ id, name: id, units: [{ id: `${id}.window`, runtime: "window-main", scopeKind: "root", dependencies: defineRuntimeUnitDependencies([{ capability: RESOURCE_REGISTRY_CAPABILITY }, ...(id === "outsider" ? [] : [{ capability: OWNED_RESOURCE_ACCESS_CAPABILITY }])]) }] });
  await host.registerAll([manifest("first"), manifest("second"), manifest("outsider")]);
  const bind = (id: string) => { const ctx = contexts.get(id)!; return ctx.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(ctx.consumer, ctx.scope); };
  return { host, contexts, bind };
}
describe("owned resource access production adapter", () => {
  it("rejects forged consumers, mismatched scopes and reads or writes of another instance's resources", async () => {
    const { contexts, bind } = await fixture();
    const first = contexts.get("first")!, second = contexts.get("second")!;
    const access = first.capability(OWNED_RESOURCE_ACCESS_CAPABILITY);
    expect(() => access.bind({ ...first.consumer } as PluginConsumer, first.scope)).toThrow();
    expect(() => access.bind(first.consumer, second.scope)).toThrow();
    const outsider = contexts.get("outsider")!;
    expect(() => access.bind(outsider.consumer, outsider.scope)).toThrow();
    const reader = bind("first");
    expect(reader.ensure("first.snapshot", []).key).toEqual(["first.snapshot"]);
    expect(() => reader.ensure("second.snapshot", [])).toThrow();
    expect(() => reader.read("second.snapshot", [])).toThrow();
    expect(() => reader.subscribe("second.snapshot", [], () => {})).toThrow();
    expect(() => reader.invalidate("second.snapshot", [])).toThrow();
    expect((reader as unknown as { disposeOwner?: unknown }).disposeOwner).toBeUndefined();
  });
  it("revokes old resource handles and subscriptions while the other instance remains usable", async () => {
    const { host, contexts, bind } = await fixture();
    const first: OwnedResourceReader = bind("first"), second = bind("second");
    const listener = vi.fn();
    first.ensure("first.snapshot", []);
    const off = first.subscribe("first.snapshot", [], listener);
    await vi.waitFor(() => expect(first.read<string>("first.snapshot", [])?.data).toBe("first"));
    await host.revoke("first", "session removed");
    const calls = listener.mock.calls.length;
    expect(() => first.ensure("first.snapshot", [])).toThrow();
    expect(() => first.subscribe("first.snapshot", [], listener)).toThrow();
    expect(() => bind("first")).toThrow();
    expect(() => off()).not.toThrow();
    second.ensure("second.snapshot", []);
    await vi.waitFor(() => expect(second.read<string>("second.snapshot", [])?.data).toBe("second"));
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(contexts.get("second")!.consumer.status).toBe("active");
  });
});
