// packages/runtime/src/createPluginHost.test.ts
// 硬切换 001：runtime 生命周期核心测试。
//   - register / enable / disable / unregister
//   - owner 回收（route / menu / capability / settings page）
//   - 反向依赖阻止 disable
//   - canDisable=false 阻止 disable
//   - version + subscribe
//   - graph / state
//   - bootstrap 路径：config store override + defaultEnabled 决定初始 enabled

import { describe, expect, it, beforeEach, vi } from "vitest";
import { createPluginHost, type PluginHost } from "./createPluginHost.js";
import type { PluginContext, PluginManifest } from "@keymaster/contracts";
import type { RouteRegistry } from "./registries/routeRegistry.js";
import type { MenuRegistry } from "./registries/menuRegistry.js";
import type { SettingsRegistry } from "./registries/settingsRegistry.js";

interface RegistryViews {
  routes: { ids: string[] };
  menus: { ids: string[] };
  settingsRoutes: { ids: string[] };
  capabilities: { keys: string[] };
}

function view(host: PluginHost): RegistryViews {
  return {
    routes: { ids: host.routes._ids() },
    menus: { ids: host.menus._ids() },
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
    meta: { kind: "platform", defaultEnabled: true, canDisable: true, providesCapabilities: [CAP_A] },
    setup(ctx: PluginContext) {
      const r = ctx.get<RouteRegistry>("route.registry");
      r.register({
        id: ROUTE_A,
        path: "/a",
        label: "A",
        component: () => null
      });
      const m = ctx.get<MenuRegistry>("menu.registry");
      m.register({
        id: "menu.a",
        label: "A",
        group: "g",
        order: 1
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
    meta: { kind: "business", defaultEnabled: true, canDisable: true, providesCapabilities: [CAP_B] },
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
    meta: { kind: "core", defaultEnabled: true, canDisable: false, providesCapabilities: [CAP_C] },
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

beforeEach(() => {
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});

describe("createPluginHost - lifecycle", () => {
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
      meta: { kind: "business", defaultEnabled: false, canDisable: true, providesCapabilities: [CAP_B] }
    };
    await host.registerAll([a, off]);
    expect(host.installed()).toEqual(expect.arrayContaining(["a"]));
    expect(host.installed()).not.toContain("b");
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
    expect(after.menus.ids).not.toContain("menu.a");
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
    // 仍然 enabled
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
    const teardown = vi.fn();
    const plugin: PluginManifest = {
      id: "td",
      name: "TD",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      setup() {
        return teardown;
      }
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([plugin]);
    expect(host.state("td").kind).toBe("enabled");
    await host.disable("td");
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("setup throwing causes error-disabled state and removes owner", async () => {
    const plugin: PluginManifest = {
      id: "bad",
      name: "Bad",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
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
    // b depends on a; don't register a.
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

/* ============== 2026-07-01/003 appMessageEndpoint 注入测试 ============== */

import { APPMESSAGE_CORE_CAPABILITY, type AppMsgPluginClient } from "@keymaster/contracts";

describe("createPluginHost - manifest.appMessageEndpoint", () => {
  function makeAppmsgCoreProvider(id: string): PluginManifest {
    // 提供 appmsg.core 平台单例的 mock plugin。
    return {
      id,
      name: "AppmsgProvider",
      description: "provides appmsg.core (mock)",
      meta: { kind: "platform", defaultEnabled: true, canDisable: false },
      setup(ctx: PluginContext) {
        // 提供一个空的 mock core；host 不会真调用它（scoped 注入只
        // 验证 capability 是否挂上 + 类型是否符合 AppMsgPluginClient）。
        const core = {
          connectForOwner: async () => undefined,
          disconnect: async () => undefined,
          list: async () => ({ items: [], hasMore: false }),
          get: async () => null,
          send: async () => ({ messageId: "0", createdAtMs: 0 }),
          subscribeInboxDirty: () => () => undefined,
          subscribeMessageReceived: () => () => undefined,
          createPluginScopedClient: (endpointId: string): AppMsgPluginClient => ({
            endpointId,
            list: async () => ({ items: [], hasMore: false }),
            get: async () => null,
            send: async () => ({ messageId: "0", createdAtMs: 0 }),
            subscribeInboxDirty: () => () => undefined
          })
        };
        ctx.provide(APPMESSAGE_CORE_CAPABILITY, core);
      }
    };
  }

  function makeEndpointPlugin(id: string, endpointId: string): PluginManifest {
    return {
      id,
      name: `EndpointPlugin ${id}`,
      description: "declares appMessageEndpoint",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      appMessageEndpoint: { endpointId },
      dependencies: [{ capability: APPMESSAGE_CORE_CAPABILITY }],
      setup() {
        // 不主动 get scoped client（避免破坏"host 在 setup 后才注入"的契约）。
      }
    };
  }

  it("rejects endpointId with invalid shape", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(makeAppmsgCoreProvider("appmsg-core"));
    const plugin: PluginManifest = {
      id: "bad-shape",
      name: "Bad",
      description: "bad shape",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      appMessageEndpoint: { endpointId: "Keymaster.Message" }, // 大写、不符合 shape
      setup() {
        // 不会跑到这里（enable 阶段就 fail-closed）
      }
    };
    await host.register(plugin);
    // register 不重新抛错，但 state 应为 blocked / error-disabled
    expect(["blocked", "error-disabled"]).toContain(host.state("bad-shape").kind);
    expect(String(host.state("bad-shape").error ?? "")).toMatch(
      /appMessageEndpoint/
    );
    expect(String(host.state("bad-shape").error ?? "")).toMatch(
      /pluginEndpointId|shape/
    );
  });

  it("injects scoped client into <pluginId>.appmsg.client on enable", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(makeAppmsgCoreProvider("appmsg-core"));
    await host.register(makeEndpointPlugin("p1", "keymaster.message"));

    const capKey = "p1.appmsg.client";
    const client = host.capabilities.get<AppMsgPluginClient>(capKey);
    expect(client).toBeTruthy();
    expect(client.endpointId).toBe("keymaster.message");
  });

  it("does NOT inject scoped client if appmsg.core missing", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    // 不注册 appmsg.core provider
    await host.register(makeEndpointPlugin("p1", "keymaster.orphan"));
    expect(host.capabilities.has("p1.appmsg.client")).toBe(false);
  });

  it("releases endpointId on disable; another plugin can re-register it", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(makeAppmsgCoreProvider("appmsg-core"));
    await host.register(makeEndpointPlugin("p1", "keymaster.message"));
    expect(host.capabilities.has("p1.appmsg.client")).toBe(true);

    await host.disable("p1");
    expect(host.capabilities.has("p1.appmsg.client")).toBe(false);

    // 复用同一 endpointId 注册新插件：应该通过
    await host.register(makeEndpointPlugin("p2", "keymaster.message"));
    expect(host.capabilities.has("p2.appmsg.client")).toBe(true);
  });
});
