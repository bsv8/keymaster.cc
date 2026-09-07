import { describe, expect, it, vi } from "vitest";
import { createRouteRegistry } from "../registries/routeRegistry.js";
import { createBusinessFeatureRegistry } from "../registries/businessFeatureRegistry.js";
import { createLifecycleScope } from "./resourceScope.js";
import { createScopedRegistryFacade } from "./scopedRegistry.js";

describe("scoped registry facade", () => {
  it("removes registrations synchronously on revoke before teardown", async () => {
    const registry = createRouteRegistry();
    const scope = createLifecycleScope({
      kind: "plugin-instance",
      metadata: { pluginId: "routes-plugin" },
    });
    const routes = createScopedRegistryFacade(registry, scope, { name: "route.registry" });
    const events: string[] = [];

    routes.register({
      id: "late.route",
      path: "/late",
      label: "Late",
      component: () => null,
    });
    scope.onDispose(() => {
      events.push(routes.byId("late.route") ? "dispose:present" : "dispose:missing");
    });

    await scope.dispose({
      teardown: () => {
        events.push(routes.byId("late.route") ? "teardown:present" : "teardown:missing");
      },
    });

    expect(events).toEqual(["dispose:missing", "teardown:missing"]);
    expect(registry.byId("late.route")).toBeUndefined();
  });

  it("rejects registrations after revoke and does not call the target", () => {
    const registry = createRouteRegistry();
    const register = vi.spyOn(registry, "register");
    const scope = createLifecycleScope({
      kind: "plugin-instance",
      metadata: { pluginId: "late-plugin" },
    });
    const routes = createScopedRegistryFacade(registry, scope, { name: "route.registry" });

    scope.revoke("plugin disabled");
    expect(() => routes.register({
      id: "late.route",
      path: "/late",
      label: "Late",
      component: () => null,
    })).toThrow(/revoked|stopping/i);
    expect(register).not.toHaveBeenCalled();
  });

  it("makes returned unsubscribe functions idempotent", async () => {
    let unsubscribeCalls = 0;
    const target = {
      register: () => () => {
        unsubscribeCalls += 1;
      },
    };
    const scope = createLifecycleScope({ kind: "plugin-instance" });
    const facade = createScopedRegistryFacade(target, scope, { name: "lane.registry" });
    const off = facade.register();

    off();
    off();
    await scope.dispose();

    expect(unsubscribeCalls).toBe(1);
  });

  it("binds business owner arguments to the current plugin", async () => {
    const registry = createBusinessFeatureRegistry();
    const scope = createLifecycleScope({
      kind: "plugin-instance",
      metadata: { pluginId: "owner-plugin" },
    });
    const facade = createScopedRegistryFacade(registry, scope, {
      name: "business.registry",
      registrations: [{
        method: "register",
        idArgument: 1,
        unregisterMethod: "unregisterDomain",
        unregisterArgument: 0,
        bindPluginIdArgument: 0,
      }],
    });
    const domain = {
      id: "owner-plugin.domain",
      label: { key: "domain", fallback: "Domain" },
      order: 1,
      features: [],
    };

    expect(() => facade.register("other-plugin", domain)).toThrow(/owner/i);
    facade.register("owner-plugin", domain);
    const cleanup = await scope.dispose();

    expect(cleanup).toMatchObject({ attempted: 1, released: 1, pending: [] });
    expect(registry._ids()).toEqual({ domains: [], features: [], projections: [] });
  });
});
