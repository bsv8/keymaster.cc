// packages/plugin-home/src/manifest.ts
// 首页插件：注册 / 路由和菜单入口。

import type {
  I18nPluginResources,
  MenuItem,
  MenuRegistry,
  PluginManifest,
  RouteRegistry
} from "@keymaster/contracts";
import { HomePage } from "./HomePage.js";

/** 首页 i18n 资源。设计缘由：route / menu label 走 I18nText，
 * 资源在 plugin setup 之前由 runtime 注入（plugin.i18n）。 */
const homeResources: I18nPluginResources = {
  namespace: "home",
  resources: {
    en: {
      "home.route.label": "Home",
      "home.menu.label": "Home",
      "home.page.title": "Home",
      "home.page.description": "Panels registered by plugins.",
      "home.page.empty.title": "No widgets yet",
      "home.page.empty.description": "After installing a business plugin, its panels will appear here."
    },
    "zh-CN": {
      "home.route.label": "首页",
      "home.menu.label": "首页",
      "home.page.title": "首页",
      "home.page.description": "按插件注册的资源面板。",
      "home.page.empty.title": "还没有 widget",
      "home.page.empty.description": "安装业务插件后这里会显示资源面板。"
    }
  }
};

export const homePlugin: PluginManifest = {
  id: "home",
  name: "Home",
  description: "首页容器。",
  meta: {
    kind: "core",
    defaultEnabled: true,
    canDisable: false,
    displayGroup: "core"
  },
  i18n: homeResources,
  dependencies: [
    { capability: "home.registry", reason: "需要从注册表读取 widget" },
    { capability: "route.registry", reason: "注册首页路由" },
    { capability: "menu.registry", reason: "注册首页菜单入口" }
  ],
  setup(ctx) {
    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "home.page",
      path: "/",
      label: { key: "home.route.label", fallback: "Home" },
      component: HomePage,
      inMenu: true,
      menuGroup: "home",
      order: 0,
      icon: "Home"
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const item: MenuItem = {
      id: "menu.home",
      label: { key: "home.menu.label", fallback: "Home" },
      routeId: "home.page",
      group: "home",
      order: 0,
      icon: "Home"
    };
    menus.register(item);

    // 硬切换 001：home 是 core 插件；teardown 走空实现（route/menu 由 host owner 回收）。
    return () => {
      // no-op
    };
  }
};
