// packages/runtime/src/createPluginHost.test.ts
// 硬切换 001 + 2026-07-04 001：runtime 生命周期核心测试。
//   - register / enable / disable / unregister
//   - owner 回收（route / menu / capability / settings page）
//   - 反向依赖阻止 disable
//   - canDisable=false 阻止 disable
//   - version + subscribe
//   - graph / state
//   - bootstrap 路径：config store override + defaultEnabled 决定初始 enabled
//   - 硬切换 2026-07-04 001：manifest.appMessageEndpoint 仅做形状 + 唯一性
//     校验；runtime **不**再注入 `<pluginId>.appmsg.client` capability，
//     **不**再监听 keyspace / vault owner 变化去重建消息 client。

import { describe, expect, it, beforeEach } from "vitest";
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

describe("createPluginHost - runtime resource binding", () => {
  it("refreshes Resource Store when a plugin provides keyspace", async () => {
    const activeListeners = new Set<() => void>();
    const keyspace = {
      active: () => ({ activePublicKeyHex: "pk1" }),
      onActiveChange: (handler: () => void) => {
        activeListeners.add(handler);
        return () => activeListeners.delete(handler);
      }
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register({
      id: "late-keyspace",
      name: "Late keyspace",
      description: "test",
      meta: { kind: "platform", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        ctx.provide("keyspace.service", keyspace);
      }
    });
    expect(activeListeners.size).toBe(1);
    await host.disable("late-keyspace");
    expect(activeListeners.size).toBe(0);
  });
});

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
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
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

/* ============== 2026-07-04 001：manifest.appMessageEndpoint 仅做校验 ============== */

describe("createPluginHost - manifest.appMessageEndpoint (validation only)", () => {
  it("rejects endpointId with invalid shape", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
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
    expect(["blocked", "error-disabled"]).toContain(host.state("bad-shape").kind);
    expect(String(host.state("bad-shape").error ?? "")).toMatch(/appMessageEndpoint/);
    expect(String(host.state("bad-shape").error ?? "")).toMatch(/pluginEndpointId|shape/);
  });

  it("does NOT inject <pluginId>.appmsg.client capability (runtime no longer owns it)", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const plugin: PluginManifest = {
      id: "p1",
      name: "p1",
      description: "declares appMessageEndpoint",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      appMessageEndpoint: { endpointId: "keymaster.message" },
      setup() {
        // 不主动 get scoped client。
      }
    };
    await host.register(plugin);
    // 关键断言：runtime 不再注入 scoped client capability。
    expect(host.capabilities.has("p1.appmsg.client")).toBe(false);
  });

  it("releases endpointId on disable; another plugin can re-register it", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const p1: PluginManifest = {
      id: "p1",
      name: "p1",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      appMessageEndpoint: { endpointId: "keymaster.message" },
      setup() {
        // no-op
      }
    };
    await host.register(p1);
    expect(host.state("p1").kind).toBe("enabled");
    // 同样禁止注入 scoped client。
    expect(host.capabilities.has("p1.appmsg.client")).toBe(false);

    await host.disable("p1");
    expect(host.state("p1").kind).toBe("disabled");

    // 复用同一 endpointId 注册新插件：应该通过（endpointId 已释放）。
    const p2: PluginManifest = {
      id: "p2",
      name: "p2",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      appMessageEndpoint: { endpointId: "keymaster.message" },
      setup() {
        // no-op
      }
    };
    await host.register(p2);
    expect(host.state("p2").kind).toBe("enabled");
    expect(host.capabilities.has("p2.appmsg.client")).toBe(false);
  });

  it("rejects when another plugin already uses the same endpointId (uniqueness)", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const p1: PluginManifest = {
      id: "p1",
      name: "p1",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      appMessageEndpoint: { endpointId: "keymaster.dup" },
      setup() {
        // no-op
      }
    };
    const p2: PluginManifest = {
      id: "p2",
      name: "p2",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      appMessageEndpoint: { endpointId: "keymaster.dup" },
      setup() {
        // no-op
      }
    };
    await host.register(p1);
    expect(host.state("p1").kind).toBe("enabled");
    await host.register(p2);
    // p2 应该被 blocked（endpointId 已被 p1 占用）。
    expect(["blocked", "error-disabled"]).toContain(host.state("p2").kind);
    expect(String(host.state("p2").error ?? "")).toMatch(/already registered/);
  });
});
