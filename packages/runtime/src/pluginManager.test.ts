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

import { describe, expect, it } from "vitest";
import { createPluginHost, type PluginHost } from "./createPluginHost.js";
import type { PluginContext, PluginManifest } from "@keymaster/contracts";
import type { RouteRegistry } from "./registries/routeRegistry.js";
import type { MenuRegistry } from "./registries/menuRegistry.js";
import type { BreadcrumbRegistry } from "./registries/breadcrumbRegistry.js";

const ROUTE_S = "settings.page";
const ROUTE_BIZ = "biz.route";
const CAP_BIZ = "biz.service";

/** 模拟"settings-like" 插件，setup 内部用了 4 个 capability，但只声明了 1 个。 */
function makeBadSettings(): PluginManifest {
  return {
    id: "settings",
    name: "Settings",
    meta: { kind: "core", defaultEnabled: true, canDisable: false },
    // 注意：故意漏掉 route / menu / breadcrumb registry —— 这就是"测试空白"被
    // 制造出来的版本。下面的 `makeGoodSettings` 才是"真值正确"的版本。
    dependencies: [{ capability: "settings.registry" }],
    setup(ctx: PluginContext) {
      ctx.get<RouteRegistry>("route.registry").register({
        id: ROUTE_S,
        path: "/settings",
        label: "Settings",
        component: () => null
      });
      ctx.get<MenuRegistry>("menu.registry").register({
        id: "menu.settings",
        label: "Settings",
        group: "settings",
        order: 999
      });
      ctx.get<BreadcrumbRegistry>("breadcrumb.registry").register({
        id: "settings.crumbs",
        order: 0,
        match: () => false,
        resolve: () => []
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
      { capability: "route.registry" },
      { capability: "menu.registry" },
      { capability: "breadcrumb.registry" }
    ],
    setup(ctx: PluginContext) {
      ctx.get<RouteRegistry>("route.registry").register({
        id: ROUTE_S,
        path: "/settings",
        label: "Settings",
        component: () => null
      });
      ctx.get<MenuRegistry>("menu.registry").register({
        id: "menu.settings",
        label: "Settings",
        group: "settings",
        order: 999
      });
      ctx.get<BreadcrumbRegistry>("breadcrumb.registry").register({
        id: "settings.crumbs",
        order: 0,
        match: () => false,
        resolve: () => []
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
      { capability: "route.registry" },
      { capability: "menu.registry" }
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
  it("settings manifest 漏掉 route / menu / breadcrumb 依赖时，graph 真值缺失", async () => {
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
        "route.registry",
        "menu.registry",
        "breadcrumb.registry"
      ])
    );
    expect(g.dependencies.settings).toHaveLength(4);
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
