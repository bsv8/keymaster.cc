import { expect, it } from "vitest";
import { defineCapability } from "webloom-framework";
import { defineRuntimeUnitDependencies, type PluginContext, type PluginManifest } from "@keymaster/contracts";
import { createFixtureHost } from "./testSupport/createFixtureHost.js";
import { observeOptionalCapability } from "./observeOptionalCapability.js";

it("binds a late optional provider, cleans before replacement, and stops observing after owner revoke", async () => {
  const capability = defineCapability<object>({ kind: "local", id: "fixture.optional.uri", version: "1" });
  const events: string[] = [];
  let generation = 0;
  let ownerContext!: PluginContext;
  const provider: PluginManifest = { id: "provider", name: "Provider", units: [{ id: "provider.window", runtime: "window-main", scopeKind: "root", provides: [capability] }] };
  const owner: PluginManifest = { id: "owner", name: "Owner", units: [{ id: "owner.window", runtime: "window-main", scopeKind: "root", dependencies: defineRuntimeUnitDependencies([{ capability, optional: true }]) }] };
  const host = createFixtureHost({ runtime: "window-main", runtimeUnitImplementationRegistry: { get: id => ctx => {
    if (id === "provider") { generation++; ctx.provide(capability, { generation }); }
    if (id === "owner") {
      ownerContext = ctx;
      observeOptionalCapability(ctx, capability, service => {
        const version = (service as { generation: number }).generation;
        events.push(`mount ${version}`);
        return () => { events.push(`unmount ${version}`); };
      });
    }
  } } });
  try {
    await host.registerAll([owner]);
    expect(host.state("owner").kind).toBe("enabled"); expect(events).toEqual([]);
    await host.registerAll([provider]);
    expect(events).toEqual(["mount 1"]);
    const first = ownerContext.consumer.optionalCapability(capability);
    await host.revoke("provider", "provider withdrawn");
    expect(events).toEqual(["mount 1", "unmount 1"]);
    expect(host.state("owner").kind).toBe("enabled");
    await host.retry("provider");
    expect(ownerContext.consumer.optionalCapability(capability)).not.toBe(first);
    expect(events).toEqual(["mount 1", "unmount 1", "mount 2"]);
    await host.revoke("owner", "owner removed");
    expect(events).toEqual(["mount 1", "unmount 1", "mount 2", "unmount 2"]);
    await host.revoke("provider", "provider removed again"); await host.retry("provider");
    expect(events).toHaveLength(4);
  } finally { await host.dispose(); }
});
