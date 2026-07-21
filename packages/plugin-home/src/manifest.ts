// packages/plugin-home/src/manifest.ts
// 首页插件：注册 / 路由和菜单入口。

import type {
  I18nPluginResources,
  PluginManifest
} from "@keymaster/contracts";
import { HomePage } from "./HomePage.js";

/** 首页 i18n 资源。设计缘由：route / menu label 走 I18nText，
 * 资源在 plugin setup 之前由 runtime 注入（plugin.i18n）。 */
const homeResources: I18nPluginResources = {
  namespace: "home",
  resources: {
    en: {
      "home.domain.label": "Overview",
      "home.route.label": "Home",
      "home.menu.label": "Home",
      "home.page.title": "Home",
      "home.page.description": "Panels registered by plugins.",
      "home.page.empty.title": "No widgets yet",
      "home.page.empty.description": "After installing a business plugin, its panels will appear here."
    },
    "zh-CN": {
      "home.domain.label": "概览",
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
    startup: "optional",
    defaultEnabled: true,
    canDisable: false,
    displayGroup: "core"
  },
  i18n: homeResources,
  dependencies: [
    { capability: "home.registry", reason: "需要读取 legacy 首页卡片" },
    { capability: "business.registry", reason: "需要读取业务首页投影" }
  ],
  business: {
    domains: [{
      id: "home",
      label: { key: "home.domain.label", fallback: "Overview" },
      order: 0,
      features: [{
        id: "home.overview",
        label: { key: "home.menu.label", fallback: "Home" },
        order: 0,
        icon: "Home",
        entry: { path: "/", component: HomePage }
      }]
    }]
  },
  setup() {}
};
