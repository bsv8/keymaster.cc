// packages/plugin-settings/src/manifest.ts
// 设置页：注册 /settings 页面、菜单 + 系统级插件管理页 /settings/plugins。

import type {
  BreadcrumbRegistry,
  I18nPluginResources,
  MenuItem,
  MenuRegistry,
  PluginManifest,
  RouteRegistry,
  SettingsRegistry
} from "@keymaster/contracts";
import { PluginManagerPage } from "./PluginManagerPage.js";
import { SettingsPage } from "./SettingsPage.js";

/** 设置 i18n 资源。设计缘由：route / menu / 设置项 label 全部走 I18nText，
 * 同时在 resources 中提供 settings.language.* 给语言设置区复用。
 * 硬切换 001：新增 pluginManager.* 文案供 PluginManagerPage 复用。 */
const settingsResources: I18nPluginResources = {
  namespace: "settings",
  resources: {
    en: {
      "settings.route.label": "Settings",
      "settings.menu.label": "Settings",
      "settings.page.title": "Settings",
      "settings.page.description": "Items from settings.registry.",
      "settings.field.boolean.yes": "Yes",
      "settings.field.boolean.no": "No",
      "settings.field.saved": "Saved",
      "settings.language.title": "Language",
      "settings.language.description": "Choose display language. Affects all UI text; switch is instant.",
      "settings.language.option.en": "English",
      "settings.language.option.zh-CN": "Simplified Chinese",
      // 硬切换 001：插件管理页
      "settings.route.plugins": "Plugins",
      "settings.menu.plugins": "Plugins",
      "settings.crumb.plugins": "Plugins",
      "pluginManager.title": "Plugins",
      "pluginManager.description":
        "System-level plugin management. Changes take effect immediately. Disabled plugins are unloaded from the host.",
      "pluginManager.error": "Error",
      "pluginManager.meta.id": "Id",
      "pluginManager.meta.provides": "Provides",
      "pluginManager.meta.depends": "Depends on",
      "pluginManager.meta.reverse": "Used by",
      "pluginManager.meta.none": "—",
      "pluginManager.meta.blockers": "Blocking dependents",
      "pluginManager.meta.blockersHint":
        "Disable these first (or use other tooling) to disable this plugin.",
      "pluginManager.action.enable": "Enable",
      "pluginManager.action.disable": "Disable",
      "pluginManager.action.cannotDisable": "Cannot disable",
      "pluginManager.group.core": "Core",
      "pluginManager.group.platform": "Platform",
      "pluginManager.group.business": "Business",
      "pluginManager.group.import": "Import",
      "pluginManager.group.experimental": "Experimental",
      "pluginManager.group.other": "Other",
      "pluginManager.dep.title": "Dependencies",
      "pluginManager.dep.dependsOn": "Depends on",
      "pluginManager.dep.usedBy": "Used by",
      "pluginManager.dep.missing": "Missing dependencies: {{list}}"
    },
    "zh-CN": {
      "settings.route.label": "设置",
      "settings.menu.label": "设置",
      "settings.page.title": "设置",
      "settings.page.description": "来自 settings.registry 的设置项。",
      "settings.field.boolean.yes": "是",
      "settings.field.boolean.no": "否",
      "settings.field.saved": "已保存",
      "settings.language.title": "语言",
      "settings.language.description": "选择界面显示语言，影响所有 UI 文案；切换立即生效。",
      "settings.language.option.en": "English",
      "settings.language.option.zh-CN": "简体中文",
      // 硬切换 001：插件管理页
      "settings.route.plugins": "插件",
      "settings.menu.plugins": "插件",
      "settings.crumb.plugins": "插件",
      "pluginManager.title": "插件管理",
      "pluginManager.description": "系统级插件管理。变更立即生效；被禁用的插件会从宿主运行时中实际卸载。",
      "pluginManager.error": "错误",
      "pluginManager.meta.id": "Id",
      "pluginManager.meta.provides": "提供",
      "pluginManager.meta.depends": "依赖",
      "pluginManager.meta.reverse": "被谁依赖",
      "pluginManager.meta.none": "—",
      "pluginManager.meta.blockers": "阻塞的反向依赖",
      "pluginManager.meta.blockersHint": "请先禁用这些（用其它方式处理），再禁用本插件。",
      "pluginManager.action.enable": "启用",
      "pluginManager.action.disable": "禁用",
      "pluginManager.action.cannotDisable": "不可禁用",
      "pluginManager.group.core": "核心",
      "pluginManager.group.platform": "平台",
      "pluginManager.group.business": "业务",
      "pluginManager.group.import": "导入",
      "pluginManager.group.experimental": "实验",
      "pluginManager.group.other": "其它",
      "pluginManager.dep.title": "依赖",
      "pluginManager.dep.dependsOn": "依赖",
      "pluginManager.dep.usedBy": "被谁依赖",
      "pluginManager.dep.missing": "缺少依赖：{{list}}"
    }
  }
};

export const settingsPlugin: PluginManifest = {
  id: "settings",
  name: "Settings",
  description: "设置页容器。",
  meta: {
    kind: "core",
    defaultEnabled: true,
    canDisable: false,
    displayGroup: "core"
  },
  i18n: settingsResources,
  dependencies: [
    { capability: "settings.registry", reason: "需要从注册表读取设置项" },
    { capability: "route.registry", reason: "需要注册 /settings 与 /settings/plugins 路由" },
    { capability: "menu.registry", reason: "需要注册设置与插件管理菜单入口" },
    { capability: "breadcrumb.registry", reason: "需要注册 /settings/plugins 面包屑" }
  ],
  setup(ctx) {
    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "settings.page",
      path: "/settings",
      label: { key: "settings.route.label", fallback: "Settings" },
      component: SettingsPage,
      inMenu: true,
      menuGroup: "settings",
      order: 999,
      icon: "Settings"
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const item: MenuItem = {
      id: "menu.settings",
      label: { key: "settings.menu.label", fallback: "Settings" },
      routeId: "settings.page",
      group: "settings",
      order: 999,
      icon: "Settings",
      visibleWhen: ({ unlocked }) => unlocked
    };
    menus.register(item);

    // 硬切换 001：注册系统级插件管理页 /settings/plugins。
    routes.register({
      id: "settings.plugins",
      path: "/settings/plugins",
      label: { key: "settings.route.plugins", fallback: "Plugins" },
      component: PluginManagerPage,
      inMenu: true,
      menuGroup: "settings",
      order: 990,
      icon: "Puzzle"
    });
    menus.register({
      id: "menu.settings.plugins",
      label: { key: "settings.menu.plugins", fallback: "Plugins" },
      routeId: "settings.plugins",
      group: "settings",
      order: 990,
      icon: "Puzzle",
      visibleWhen: ({ unlocked }) => unlocked
    });
    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    breadcrumbs.register({
      id: "settings.plugins.crumbs",
      order: 10,
      match: (path) => path === "/settings/plugins",
      resolve: () => [
        { label: { key: "settings.crumb.settings", fallback: "Settings" }, path: "/settings" },
        { label: { key: "settings.crumb.plugins", fallback: "Plugins" } }
      ]
    });
    // settings registry 多注册一个"插件管理"页（label i18n），保持 settings 页
    // 出现一条入口（与 /settings/plugins 路由互为补充：菜单 / 路由 / 设置页
    // 三处都有入口）。
    const settingsReg = ctx.get<SettingsRegistry>("settings.registry");
    settingsReg.registerPage({
      id: "settings.plugins",
      label: { key: "settings.route.plugins", fallback: "Plugins" },
      description: { key: "pluginManager.description", fallback: "System-level plugin management." },
      fields: [],
      order: 5,
      component: PluginManagerPage
    });

    // 硬切换 001：core 插件；teardown 走空实现。
    return () => {
      // no-op
    };
  }
};
