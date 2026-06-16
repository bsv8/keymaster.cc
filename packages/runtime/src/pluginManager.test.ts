// packages/runtime/src/pluginManager.test.ts
// 硬切换 001 补：插件管理 UI / 依赖图真值 / 热卸载语义的回归测试。
//
// runtime 包不能 import plugin-*（边界规则）；本测试在 runtime 包内构造
// 最小可验证的 fake plugin manifest，覆盖三个关键 bug：
//   1. UI 应当按 capability key 检查"依赖是否满足"，**不能**用
//      getManifest(pluginId) 误判。否则 poker / p2pkh 等依赖 builtin capability
//      的插件会被永久置灰。
//   2. plugin manifest 必须把"setup 内实际使用的 capability"全部声明到
//      dependencies，否则依赖图真值缺失。
//   3. plugin service / provider 必须在 disable 时取消 keyspace.onActiveChange /
//      vault.onStatusChange 等句柄，否则旧 service 仍被外部持续回调，
//      破坏热卸载语义。
//
// 硬切换 003：plugin-settings 不再注册 /settings 聚合页；它通过
// settings.registry 注册 /settings/language 与 /settings/plugins 两个
// 详情页；不再需要 menu.registry 的"设置"分组入口。

import { describe, expect, it } from "vitest";
import { createPluginHost, type PluginHost } from "./createPluginHost.js";
import type { PluginContext, PluginManifest } from "@keymaster/contracts";
import type { RouteRegistry } from "./registries/routeRegistry.js";
import type { SettingsRegistry } from "./registries/settingsRegistry.js";

const ROUTE_S = "settings.plugins.route";
const ROUTE_BIZ = "biz.route";
const CAP_BIZ = "biz.service";

/** 模拟"settings-like" 插件，setup 内部用了 4 个 capability，但只声明了 1 个。 */
function makeBadSettings(): PluginManifest {
  return {
    id: "settings",
    name: "Settings",
    meta: { kind: "core", defaultEnabled: true, canDisable: false },
    // 注意：故意漏掉 route / settings registry —— 这就是"测试空白"被
    // 制造出来的版本。下面的 `makeGoodSettings` 才是"真值正确"的版本。
    dependencies: [{ capability: "settings.registry" }],
    setup(ctx: PluginContext) {
      ctx.get<RouteRegistry>("route.registry").register({
        id: ROUTE_S,
        path: "/settings/plugins",
        label: "Plugins",
        component: () => null
      });
      ctx.get<SettingsRegistry>("settings.registry").register({
        id: "settings.plugins",
        path: "/settings/plugins",
        label: "Plugins",
        order: 990,
        component: () => null
      });
    }
  };
}

function makeGoodSettings(): PluginManifest {
  return {
    id: "settings",
    name: "Settings",
    meta: { kind: "core", defaultEnabled: true, canDisable: false },
    dependencies: [
      { capability: "settings.registry" },
      { capability: "route.registry" }
    ],
    setup(ctx: PluginContext) {
      ctx.get<RouteRegistry>("route.registry").register({
        id: ROUTE_S,
        path: "/settings/plugins",
        label: "Plugins",
        component: () => null
      });
      ctx.get<SettingsRegistry>("settings.registry").register({
        id: "settings.plugins",
        path: "/settings/plugins",
        label: "Plugins",
        order: 990,
        component: () => null
      });
    }
  };
}

/** 一个依赖 builtin capability 的"业务"插件，模拟 poker / p2pkh 的形态。 */
function makeBiz(): PluginManifest {
  return {
    id: "biz",
    name: "Biz",
    meta: { kind: "business", defaultEnabled: true, canDisable: true, providesCapabilities: [CAP_BIZ] },
    dependencies: [
      { capability: "settings.registry" },
      { capability: "route.registry" }
    ],
    setup(ctx: PluginContext) {
      ctx.get<RouteRegistry>("route.registry").register({
        id: ROUTE_BIZ,
        path: "/biz",
        label: "Biz",
        component: () => null
      });
      ctx.provide(CAP_BIZ, { ok: true });
    }
  };
}

function newHost(): PluginHost {
  return createPluginHost({ disableConfigPersistence: true });
}

describe("plugin graph 依赖真值", () => {
  it("settings manifest 漏掉 route / settings registry 依赖时，graph 真值缺失", async () => {
    const host = newHost();
    await host.registerAll([makeBadSettings()]);
    const g = host.graph();
    expect(g.dependencies.settings).toEqual(["settings.registry"]);
  });

  it("settings manifest 补齐所有依赖后，graph 真值完整", async () => {
    const host = newHost();
    await host.registerAll([makeGoodSettings()]);
    const g = host.graph();
    expect(g.dependencies.settings).toEqual(
      expect.arrayContaining([
        "settings.registry",
        "route.registry"
      ])
    );
    expect(g.dependencies.settings).toHaveLength(2);
  });

  it("任何 plugin 的所有 declared dep 都必须命中 host.capabilities（不依赖 UI 误判）", async () => {
    const host = newHost();
    await host.registerAll([makeGoodSettings(), makeBiz()]);
    const ids = host.manifests();
    for (const id of ids) {
      const g = host.graph();
      const deps = g.dependencies[id] ?? [];
      for (const cap of deps) {
        expect(host.capabilities.has(cap), `capability ${cap} missing for ${id}`).toBe(true);
        expect(host.getManifest(cap), `${id} dep ${cap} is not a plugin id`).toBeUndefined();
      }
    }
  });

  it("biz 插件依赖 builtin capability（修复后 UI 不会永久置灰）", async () => {
    const host = newHost();
    await host.registerAll([makeGoodSettings(), makeBiz()]);
    const g = host.graph();
    const deps = g.dependencies.biz ?? [];
    for (const cap of deps) {
      const lookedUpAsPluginId = host.getManifest(cap);
      const lookedUpAsCap = host.capabilities.has(cap);
      expect(lookedUpAsPluginId, `biz dep ${cap} should NOT be a plugin id`).toBeUndefined();
      expect(lookedUpAsCap, `biz dep ${cap} must be provided`).toBe(true);
    }
  });
});

describe("plugin-manager UI 依赖判定（capability key vs plugin id）", () => {
  it("旧错误判定（getManifest 当 pluginId）会把所有 builtin dep 判成缺失", async () => {
    const host = newHost();
    await host.registerAll([makeGoodSettings(), makeBiz()]);
    const g = host.graph();
    const deps = g.dependencies.biz ?? [];
    // 旧 bug 路径：把 capability 当 pluginId 看待 → 永远 undefined。
    const oldMissing = deps.filter(
      (c) => !host.getManifest(c) && !(g.provides.biz ?? []).includes(c)
    );
    expect(oldMissing.length).toBe(deps.length);
    // 正确路径：用 host.capabilities.has 判断
    const newMissing = deps.filter((c) => !host.capabilities.has(c));
    expect(newMissing).toEqual([]);
  });
});

describe("plugin teardown 句柄必须被 host 记录", () => {
  /**
   * 模拟"p2pkh-like" 行为：
   *   - setup 阶段可能通过 ctx.get<service>().onActiveChange() 订阅外部事件；
   *   - 正确的实现是保存 unsub 句柄并在 teardown 中调用。
   *
   * 本测试断言：host.disable() 必须把 setup 返回的 teardown 函数至少调用一次。
   * 这一断言是 host 行为层面的硬不变量。
   */
  it("host.disable() 必须调用 setup 返回的 teardown 函数", async () => {
    const host = newHost();
    let teardownCount = 0;
    const plugin: PluginManifest = {
      id: "td",
      name: "TD",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      setup() {
        return () => {
          teardownCount += 1;
        };
      }
    };
    await host.registerAll([plugin]);
    expect(teardownCount).toBe(0);
    await host.disable("td");
    expect(teardownCount).toBe(1);
    // 幂等：再 disable 一次不应该再调 teardown（因为已 disabled）
    await host.disable("td");
    expect(teardownCount).toBe(1);
  });

  it("host 必须保留 manifest meta 信息供 UI 查询", async () => {
    const host = newHost();
    const plugin: PluginManifest = {
      id: "meta",
      name: "M",
      meta: { kind: "business", defaultEnabled: true, canDisable: false, providesCapabilities: ["x"] },
      setup() {
        // no-op
      }
    };
    await host.registerAll([plugin]);
    const m = host.getManifest("meta");
    expect(m?.meta?.canDisable).toBe(false);
    expect(m?.meta?.providesCapabilities).toEqual(["x"]);
  });
});

describe("settings registry 与 owner 回收", () => {
  it("禁用 plugin 后，对应的 settings 详情页应从 settings.registry 消失", async () => {
    const host = newHost();
    const plugin: PluginManifest = {
      id: "p",
      name: "P",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      setup(ctx: PluginContext) {
        ctx.get<SettingsRegistry>("settings.registry").register({
          id: "p.settings",
          path: "/settings/p",
          label: "P",
          order: 100,
          component: () => null
        });
      }
    };
    await host.registerAll([plugin]);
    expect(host.settings.byId("p.settings")).toBeDefined();
    expect(host.settings.byPath("/settings/p")).toBeDefined();
    await host.disable("p");
    expect(host.settings.byId("p.settings")).toBeUndefined();
    expect(host.settings.byPath("/settings/p")).toBeUndefined();
  });

  it("跨 registry 冲突：settings.register 与 route.registry 占用同一 path 时必须抛错", async () => {
    // 硬切换 003：每个 path 只能有一处真值。host 在装配阶段会把 route.registry
    // 的 path 探测函数注入到 settings.registry，register 时检测到冲突抛错。
    // host.register 会把 setup 抛错吞掉并把 plugin 置为 error-disabled；这里
    // 通过 state.error 来断言碰撞真被检测到。
    const host = newHost();
    const plugin: PluginManifest = {
      id: "p",
      name: "P",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      setup(ctx: PluginContext) {
        ctx.get<RouteRegistry>("route.registry").register({
          id: "p.route",
          path: "/settings/p",
          label: "P",
          component: () => null
        });
        ctx.get<SettingsRegistry>("settings.registry").register({
          id: "p.settings",
          path: "/settings/p",
          label: "P",
          order: 100,
          component: () => null
        });
      }
    };
    await host.register(plugin);
    const s = host.state("p");
    expect(s.kind).toBe("error-disabled");
    expect(s.error ?? "").toMatch(/collides with an existing route\.registry/);
    // settings 详情页注册被拒。
    expect(host.settings.byId("p.settings")).toBeUndefined();
  });

  it("用户在 /settings/<plugin> 时禁用该 plugin，宿主必须先调用 history.pushState 跳到 safePath", async () => {
    // 硬切换 003：currentRoutePlugin 必须识别 settings 详情页属于哪个插件，
    // 否则 safeNavigateAway 会失效、卸载后留下渲染崩溃的页面。
    //
    // 测试方法：装一个最小 window shim，记录 pushState 调用；verify safePath 被
    // 推入 history；restore 后不影响其它测试。
    const safePath = "/__safe__";
    const originalWindow = (globalThis as Record<string, unknown>).window;
    const originalPopStateEvent = (globalThis as Record<string, unknown>).PopStateEvent;
    const pushCalls: string[] = [];
    (globalThis as Record<string, unknown>).window = {
      location: {
        pathname: "/settings/p",
        hash: "",
        href: "http://localhost/settings/p",
        origin: "http://localhost",
        host: "localhost",
        hostname: "localhost",
        port: "",
        protocol: "http:",
        search: "",
        assign: () => undefined,
        replace: () => undefined,
        reload: () => undefined
      } as unknown as Location,
      history: {
        pushState: (_state: unknown, _title: string, url?: string | URL | null) => {
          pushCalls.push(String(url ?? ""));
        },
        replaceState: () => undefined,
        go: () => undefined,
        back: () => undefined,
        forward: () => undefined,
        length: 0,
        scrollRestoration: "auto" as const,
        state: null
      } as unknown as History,
      dispatchEvent: () => true
    } as unknown as Window & typeof globalThis;
    try {
      // node 没有原生 PopStateEvent；safeNavigateAway 会 `new PopStateEvent(...)`，
      // 这里装一个 no-op class 让该行不抛 ReferenceError。
      (globalThis as Record<string, unknown>).PopStateEvent = class {
        type = "popstate";
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        constructor(_type: string, _init?: EventInit) {}
      };
      const host = createPluginHost({ disableConfigPersistence: true, safePath });
      const plugin: PluginManifest = {
        id: "p",
        name: "P",
        meta: { kind: "business", defaultEnabled: true, canDisable: true },
        setup(ctx: PluginContext) {
          ctx.get<SettingsRegistry>("settings.registry").register({
            id: "p.settings",
            path: "/settings/p",
            label: "P",
            order: 100,
            component: () => null
          });
        }
      };
      await host.registerAll([plugin]);
      const r = await host.disable("p");
      expect(r).toEqual({ ok: true });
      // 验证：safeNavigateAway 调用了 history.pushState，把路径换到 safePath。
      expect(pushCalls).toContain(safePath);
    } finally {
      (globalThis as Record<string, unknown>).window = originalWindow;
      (globalThis as Record<string, unknown>).PopStateEvent = originalPopStateEvent;
    }
  });
});
