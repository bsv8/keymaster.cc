// packages/plugin-settings/src/manifest.ts
// 设置页（硬切换 003）：
//   - 不再有 /settings 聚合页。
//   - plugin-settings 通过 settings.registry 注册两个独立详情页：
//       /settings/language：LanguageSettingsPage（语言设置）
//       /settings/plugins：PluginManagerPage（系统级插件管理）
//   - 不再向 menu.registry 注册"设置"总菜单。
//   - 不再向 breadcrumb.registry 注册指向 /settings 的可点击父级。
//
// 设计缘由：
//   - settings.registry 是平台契约（"设置类详情页注册表"），由 shell 直接
//     消费生成 settings 分组菜单 + 路由匹配；plugin-settings 也走它，才能
//     保持"同一路由只有一处真值"。
//   - PluginManagerPage 是系统级独立工作台，必须能直接通过 /settings/plugins
//     访问，不能再被某个聚合页的可见性策略遮蔽。

import type {
  BreadcrumbRegistry,
  I18nPluginResources,
  PluginManifest,
  SettingsRegistry
} from "@keymaster/contracts";
import { PluginManagerPage } from "./PluginManagerPage.js";
import { LanguageSettingsPage } from "./LanguageSettingsPage.js";

/** 设置 i18n 资源。设计缘由：route / menu / 设置项 label 全部走 I18nText。 */
const settingsResources: I18nPluginResources = {
  namespace: "settings",
  resources: {
    en: {
      "settings.route.language": "Language",
      "settings.route.plugins": "Plugins",
      "settings.menu.language": "Language",
      "settings.menu.plugins": "Plugins",
      "settings.crumb.settings": "Settings",
      "settings.crumb.language": "Language",
      "settings.crumb.plugins": "Plugins",
      "settings.language.title": "Language",
      "settings.language.description": "Choose display language. Affects all UI text; switch is instant.",
      "settings.language.option.en": "English",
      "settings.language.option.zh-CN": "Simplified Chinese",
      // 硬切换 001：插件管理页
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
      "pluginManager.dep.missing": "Missing dependencies: {{list}}",
      "pluginManager.details": "Details",
      "pluginManager.details.hide": "Hide details",
      "pluginManager.state.enabled": "Enabled",
      "pluginManager.state.disabled": "Disabled",
      "pluginManager.state.blocked": "Blocked (missing dependency)",
      "pluginManager.state.errorDisabled": "Error-disabled",
      "pluginManager.state.registered": "Registered"
    },
    "zh-CN": {
      "settings.route.language": "语言",
      "settings.route.plugins": "插件",
      "settings.menu.language": "语言",
      "settings.menu.plugins": "插件",
      "settings.crumb.language": "语言",
      "settings.crumb.settings": "设置",
      "settings.crumb.plugins": "插件",
      "settings.language.title": "语言",
      "settings.language.description": "选择界面显示语言，影响所有 UI 文案；切换立即生效。",
      "settings.language.option.en": "English",
      "settings.language.option.zh-CN": "简体中文",
      // 硬切换 001：插件管理页
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
      "pluginManager.dep.missing": "缺少依赖：{{list}}",
      "pluginManager.details": "详情",
      "pluginManager.details.hide": "收起详情",
      "pluginManager.state.enabled": "已启用",
      "pluginManager.state.disabled": "已禁用",
      "pluginManager.state.blocked": "被阻塞（依赖缺失）",
      "pluginManager.state.errorDisabled": "错误已禁用",
      "pluginManager.state.registered": "已注册"
    }
  }
};

export const settingsPlugin: PluginManifest = {
  id: "settings",
  name: "Settings",
  description: "系统级设置页：语言、插件管理。",
  meta: {
    kind: "core",
    defaultEnabled: true,
    canDisable: false,
    displayGroup: "core"
  },
  i18n: settingsResources,
  dependencies: [
    { capability: "settings.registry", reason: "注册 settings 详情页" },
    { capability: "breadcrumb.registry", reason: "为设置详情页提供面包屑" }
  ],
  setup(ctx) {
    // 硬切换 003：settings 分组菜单 + 详情页路由的真值全部由
    // settings.registry 提供，不再向 menu.registry / route.registry 重复注册。
    const settings = ctx.get<SettingsRegistry>("settings.registry");
    settings.register({
      id: "settings.language",
      path: "/settings/language",
      label: { key: "settings.route.language", fallback: "Language" },
      description: { key: "settings.language.description", fallback: "Choose display language." },
      order: 1,
      icon: "Globe",
      visibleWhen: () => true,
      component: LanguageSettingsPage
    });
    settings.register({
      id: "settings.plugins",
      path: "/settings/plugins",
      label: { key: "settings.route.plugins", fallback: "Plugins" },
      description: {
        key: "pluginManager.description",
        fallback: "System-level plugin management."
      },
      order: 2,
      icon: "Puzzle",
      visibleWhen: ({ unlocked }) => unlocked,
      component: PluginManagerPage
    });

    // 面包屑：当前路径匹配时第一段固定为不可点击的"设置"分类节点。
    // 这样 plugin 的 settings breadcrumb 不再回指不存在的 /settings，
    // 同时与 /settings/poker 等其它设置详情页保持一致的第一段样式。
    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    breadcrumbs.register({
      id: "settings.language.crumbs",
      order: 5,
      match: (path) => path === "/settings/language",
      resolve: () => [
        // 第一段：不可点击"设置"分类节点（无 path）。
        { label: { key: "settings.crumb.settings", fallback: "Settings" } },
        { label: { key: "settings.crumb.language", fallback: "Language" } }
      ]
    });
    breadcrumbs.register({
      id: "settings.plugins.crumbs",
      order: 5,
      match: (path) => path === "/settings/plugins",
      resolve: () => [
        // 第一段：不可点击"设置"分类节点（无 path）。
        { label: { key: "settings.crumb.settings", fallback: "Settings" } },
        { label: { key: "settings.crumb.plugins", fallback: "Plugins" } }
      ]
    });

    // core 插件；teardown 走空实现。
    return () => {
      // no-op
    };
  }
};
