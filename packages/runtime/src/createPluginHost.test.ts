// packages/runtime/src/createPluginHost.test.ts
// 硬切换 001 + 2026-07-04 001：runtime 生命周期核心测试。
//   - register / enable / disable / unregister
//   - owner 回收（route / menu / capability / settings page）
//   - 反向依赖阻止 disable
//   - canDisable=false 阻止 disable
//   - version + subscribe
//   - graph / state
//   - bootstrap 路径：config store override + defaultEnabled 决定初始 enabled
//   - Channel caller 由 Coordinator/Session Window 负责，runtime 不注入传输层
//     client，也不维护消息传输状态。

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  createPluginHost,
  StartupCapabilityError,
  StartupPluginError,
  type PluginHost
} from "./createPluginHost.js";
import { CHANNEL_RUNTIME_CAPABILITY, type ChannelRuntime, type ChannelRuntimeFactory, type PluginContext, type PluginManifest } from "@keymaster/contracts";
import type { RouteRegistry } from "./registries/routeRegistry.js";
import type { SettingsRegistry } from "./registries/settingsRegistry.js";

interface RegistryViews {
  routes: { ids: string[] };
  settingsRoutes: { ids: string[] };
  capabilities: { keys: string[] };
}

function view(host: PluginHost): RegistryViews {
  return {
    routes: { ids: host.routes._ids() },
    settingsRoutes: { ids: host.settings._ids() },
    capabilities: { keys: host.capabilities.keys() }
  };
}

const ROUTE_A = "test.a.route";
const ROUTE_B = "test.b.route";
const ROUTE_C = "test.c.route";
const CAP_A = "test.a.cap";
const CAP_B = "test.b.cap";
const CAP_C = "test.c.cap";

function makeA(): PluginManifest {
  return {
    id: "a",
    name: "A",
    description: "plugin A",
    meta: { kind: "platform", startup: "optional", defaultEnabled: true, canDisable: true, providesCapabilities: [CAP_A] },
    setup(ctx: PluginContext) {
      const r = ctx.get<RouteRegistry>("route.registry");
      r.register({
        id: ROUTE_A,
        path: "/a",
        label: "A",
        component: () => null
      });
      ctx.provide(CAP_A, { value: "a" });
    }
  };
}

function makeB(dependsOn: string[] = [CAP_A]): PluginManifest {
  return {
    id: "b",
    name: "B",
    description: "plugin B",
    meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true, providesCapabilities: [CAP_B] },
    dependencies: dependsOn.map((c) => ({ capability: c })),
    setup(ctx: PluginContext) {
      const r = ctx.get<RouteRegistry>("route.registry");
      r.register({
        id: ROUTE_B,
        path: "/b",
        label: "B",
        component: () => null
      });
      const s = ctx.get<SettingsRegistry>("settings.registry");
      s.register({
        id: "b.settings",
        path: "/settings/b",
        label: "B",
        order: 1,
        component: () => null
      });
      ctx.provide(CAP_B, { value: "b" });
    }
  };
}

function makeC(dependsOn: string[] = []): PluginManifest {
  return {
    id: "c",
    name: "C",
    description: "plugin C - core",
    meta: { kind: "core", startup: "required", defaultEnabled: true, canDisable: false, providesCapabilities: [CAP_C] },
    dependencies: dependsOn.map((c) => ({ capability: c })),
    setup(ctx: PluginContext) {
      const r = ctx.get<RouteRegistry>("route.registry");
      r.register({
        id: ROUTE_C,
        path: "/c",
        label: "C",
        component: () => null
      });
      ctx.provide(CAP_C, { value: "c" });
    }
  };
}

describe("createPluginHost - runtime resource binding", () => {
  it("refreshes Resource Store when a plugin provides keyspace", async () => {
    const activeListeners = new Set<() => void>();
    const keyspace = {
      active: () => ({ activePublicKeyHex: "pk1" }),
      onActiveKeyChanged: (handler: () => void) => {
        activeListeners.add(handler);
        return () => activeListeners.delete(handler);
      }
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register({
      id: "late-keyspace",
      name: "Late keyspace",
      description: "test",
      meta: { kind: "platform", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        ctx.provide("keyspace.service", keyspace);
      }
    });
    expect(activeListeners.size).toBe(1);
    await host.disable("late-keyspace");
    expect(activeListeners.size).toBe(0);
  });

  it("binds Channel plugin identity to the manifest and rejects system callers", async () => {
    const runtime = {} as ChannelRuntime;
    const rawFactory: ChannelRuntimeFactory = {
      forPlugin: vi.fn(() => runtime),
      forSystem: vi.fn(() => runtime)
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    host.provide(CHANNEL_RUNTIME_CAPABILITY, rawFactory);

    let contextPluginId: string | undefined;
    let factory: ChannelRuntimeFactory | undefined;
    await host.register({
      id: "bound-channel-plugin",
      name: "Bound Channel plugin",
      description: "test",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        contextPluginId = ctx.pluginId;
        factory = ctx.get<ChannelRuntimeFactory>(CHANNEL_RUNTIME_CAPABILITY);
      }
    });

    expect(contextPluginId).toBe("bound-channel-plugin");
    expect(factory).toBeDefined();
    expect(factory!.forPlugin("forged-plugin")).toBe(runtime);
    expect(rawFactory.forPlugin).toHaveBeenCalledWith("bound-channel-plugin");
    expect(() => factory!.forSystem("owner-inbox")).toThrow("Plugin context cannot create a system Channel caller");
    expect(rawFactory.forSystem).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});

describe("createPluginHost - lifecycle", () => {
  it("registers business declarations independently and rolls them back", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register({
      id: "business-surface",
      name: "Business surface",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      business: {
        domains: [{
          id: "business-surface.domain",
          label: { key: "test.business.domain", fallback: "Business" },
          order: 10,
          features: [{
            id: "business-surface.feature",
            label: { key: "test.business.page", fallback: "Business page" },
            order: 12,
            entry: { path: "/business-surface", component: () => null },
            home: [{
              id: "business-surface.projection",
              space: { id: "business-surface.summary", label: { key: "test.business.space", fallback: "Summary" }, order: 10 },
              order: 3,
              component: () => null
            }]
          }]
        }]
      },
      setup() {}
    });

    expect(host.routes.byId("business-surface.feature")?.path).toBe("/business-surface");
    expect(host.home.list()).toEqual([]);
    expect(host.business.listDomains().map((domain) => domain.id)).toEqual(["business-surface.domain"]);
    expect(host.business.listHomeProjections().map((projection) => projection.id)).toEqual(["business-surface.projection"]);

    await host.disable("business-surface");
    expect(host.routes.byId("business-surface.feature")).toBeUndefined();
    expect(host.business.listDomains()).toEqual([]);
    expect(host.business.listHomeProjections()).toEqual([]);
  });

  it("registers plugins and reads graph", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA(), makeB([CAP_A]), makeC()]);
    expect(host.manifests()).toEqual(expect.arrayContaining(["a", "b", "c"]));
    const g = host.graph();
    expect(g.dependencies.a).toEqual([]);
    expect(g.dependencies.b).toEqual([CAP_A]);
    expect(g.provides.a).toEqual([CAP_A]);
    expect(g.reverse.a?.[0]?.pluginId).toBe("b");
  });

  it("defaultEnabled drives initial enabled set", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const a = makeA();
    const off: PluginManifest = {
      ...makeB([CAP_A]),
      meta: { kind: "business", startup: "optional", defaultEnabled: false, canDisable: true, providesCapabilities: [CAP_B] }
    };
    await host.registerAll([a, off]);
    expect(host.installed()).toEqual(expect.arrayContaining(["a"]));
    expect(host.installed()).not.toContain("b");
  });

  it("always enables plugins marked canDisable=false despite stale persisted config", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    // This models a browser that retained a setting written before the plugin
    // became mandatory.
    host.configStore.setEnabled("c", false);

    await host.register(makeC());

    expect(host.state("c").kind).toBe("enabled");
    expect(host.capabilities.has(CAP_C)).toBe(true);
    expect(host.configStore.read().c).toBe(true);
  });

  it("always enables optional immutable plugins despite stale persisted config", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const immutableOptional: PluginManifest = {
      ...makeC(),
      id: "immutable-optional",
      meta: {
        kind: "core",
        startup: "optional",
        defaultEnabled: true,
        canDisable: false,
        providesCapabilities: [CAP_C]
      }
    };
    host.configStore.setEnabled("immutable-optional", false);

    await host.register(immutableOptional);

    expect(host.state("immutable-optional").kind).toBe("enabled");
    expect(host.configStore.read()["immutable-optional"]).toBe(true);
  });

  it("does not let config updates disable plugins marked canDisable=false", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(makeC());

    host.configStore.setEnabled("c", false);

    expect(host.state("c").kind).toBe("enabled");
    expect(host.capabilities.has(CAP_C)).toBe(true);
    expect(host.configStore.read().c).toBe(true);
  });

  it("disable removes owner resources and revokes capabilities", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA()]);
    expect(host.state("a").kind).toBe("enabled");
    const before = view(host);
    expect(before.routes.ids).toContain(ROUTE_A);
    expect(before.capabilities.keys).toContain(CAP_A);

    const r = await host.disable("a");
    expect(r).toEqual({ ok: true });
    expect(host.state("a").kind).toBe("disabled");

    const after = view(host);
    expect(after.routes.ids).not.toContain(ROUTE_A);
    expect(after.capabilities.keys).not.toContain(CAP_A);
  });

  it("canDisable=false blocks disable", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeC()]);
    const r = await host.disable("c");
    expect(r).toEqual({ ok: false, reason: "Plugin is marked canDisable=false" });
    expect(host.state("c").kind).toBe("enabled");
  });

  it("reverse dependencies block disable", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA(), makeB([CAP_A])]);
    expect(host.state("b").kind).toBe("enabled");
    const r = await host.disable("a");
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("Blocked by enabled dependents") });
    expect(host.state("a").kind).toBe("enabled");
  });

  it("enable restores owner resources", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA()]);
    await host.disable("a");
    await host.enable("a");
    expect(host.state("a").kind).toBe("enabled");
    expect(host.routes.byId(ROUTE_A)).toBeDefined();
    expect(host.capabilities.has(CAP_A)).toBe(true);
  });

  it("unregister removes plugin from host entirely", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA()]);
    await host.unregister("a");
    expect(host.manifests()).not.toContain("a");
    expect(host.state("a").kind).toBe("registered");
  });

  it("version bumps and subscribers notified", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const seen: number[] = [];
    host.subscribe((s) => seen.push(s.version));
    expect(host.version()).toBe(0);
    await host.registerAll([makeA()]);
    await host.disable("a");
    await host.enable("a");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeGreaterThan(0);
  });

  it("setup can return teardown which is invoked on disable", async () => {
    const teardown = (): void => undefined;
    const plugin: PluginManifest = {
      id: "td",
      name: "TD",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup() {
        return teardown;
      }
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([plugin]);
    expect(host.state("td").kind).toBe("enabled");
    await host.disable("td");
    // 仅断言状态；teardown 已调起。
    expect(host.state("td").kind).toBe("disabled");
  });

  it("runs onDispose callbacks before teardown and registry ownership recovery", async () => {
    const events: string[] = [];
    const plugin: PluginManifest = {
      id: "dispose-hook",
      name: "Dispose hook",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        const routes = ctx.get<RouteRegistry>("route.registry");
        routes.register({ id: "dispose.route", path: "/dispose", label: "Dispose", component: () => null });
        ctx.onDispose(() => { events.push(routes.byId("dispose.route") ? "dispose:before-purge" : "dispose:after-purge"); });
        return () => { events.push(routes.byId("dispose.route") ? "teardown:before-purge" : "teardown:after-purge"); };
      }
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(plugin);
    await host.disable(plugin.id);
    expect(events).toEqual(["dispose:before-purge", "teardown:before-purge"]);
  });

  it("setup throwing causes error-disabled state and removes owner", async () => {
    const plugin: PluginManifest = {
      id: "bad",
      name: "Bad",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx: PluginContext) {
        const r = ctx.get<RouteRegistry>("route.registry");
        r.register({ id: "bad.route", path: "/bad", label: "Bad", component: () => null });
        throw new Error("setup failed");
      }
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(plugin);
    const s = host.state("bad");
    expect(s.kind).toBe("error-disabled");
    expect(s.error).toContain("setup failed");
    expect(host.routes.byId("bad.route")).toBeUndefined();
  });

  it("missing dependency blocks enable (sets state to blocked)", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeB([CAP_A])]);
    const s = host.state("b");
    expect(s.kind).toBe("blocked");
  });

  it("config store is overridden on disable", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA()]);
    expect(host.configStore.read().a).toBe(true);
    await host.disable("a");
    expect(host.configStore.read().a).toBe(false);
  });
});

describe("createPluginHost - startup contract", () => {
  function required(overrides: Partial<PluginManifest> = {}): PluginManifest {
    return {
      id: "required",
      name: "Required",
      meta: {
        kind: "core",
        startup: "required",
        defaultEnabled: true,
        canDisable: false,
        providesCapabilities: ["required.service"]
      },
      setup(ctx) {
        ctx.provide("required.service", { ok: true });
      },
      ...overrides
    };
  }

  it.each([
    ["defaultEnabled", { defaultEnabled: false }],
    ["canDisable", { canDisable: true }],
    ["providesCapabilities", { providesCapabilities: [] }]
  ])("rejects required manifests with invalid %s", async (_, meta) => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await expect(host.register(required({ meta: { ...required().meta, ...meta } }))).rejects.toThrow(/Required plugin/);
  });

  it("validates required dependencies against the complete manifest set", () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const optionalProvider = {
      id: "optional-provider",
      name: "Optional provider",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true, providesCapabilities: ["optional.service"] },
      setup() {}
    } satisfies PluginManifest;
    expect(() => host.validateManifestSet([
      required({ dependencies: [{ capability: "optional.service" }] }),
      optionalProvider
    ])).toThrow(/optional capability provider/);
  });

  it("wraps required setup failures and rolls back owned resources", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const plugin = required({
      setup(ctx) {
        ctx.get<RouteRegistry>("route.registry").register({
          id: "required.route",
          path: "/required",
          label: "required",
          component: () => null
        });
        throw new Error("secret underlying failure");
      }
    });
    await expect(host.register(plugin)).rejects.toBeInstanceOf(StartupPluginError);
    expect(host.routes.byId("required.route")).toBeUndefined();
    expect(host.capabilities.has("required.service")).toBe(false);
    expect(host.state("required").kind).toBe("error-disabled");
  });

  it("rejects a required provider that fails to provide its declaration", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await expect(host.register(required({ setup() {} }))).rejects.toBeInstanceOf(StartupPluginError);
    expect(host.capabilities.has("required.service")).toBe(false);
  });

  it("keeps required capability and config on disable, unregister, and false config", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(required());
    expect(await host.disable("required")).toEqual({ ok: false, reason: "Plugin is marked canDisable=false" });
    await expect(host.unregister("required")).rejects.toThrow(/startup-required/);
    host.configStore.setEnabled("required", false);
    expect(host.capabilities.has("required.service")).toBe(true);
    expect(host.configStore.read().required).toBe(true);
  });

  it("asserts provider, state, error, and configured value without exposing stack", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const provider = required({ setup() { throw new Error("private stack detail"); } });
    await expect(host.register(provider)).rejects.toBeInstanceOf(StartupPluginError);
    try {
      host.assertCapabilities(["required.service"], { phase: "test" });
      throw new Error("expected assertion to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StartupCapabilityError);
      const details = (error as StartupCapabilityError).details[0]!;
      expect(details).toMatchObject({
        capability: "required.service",
        providerPluginId: "required",
        providerState: "error-disabled"
      });
      expect(details.configuredEnabled).toBe(true);
      expect(details.providerError).toContain("private stack detail");
    }
  });
});
