// packages/plugin-settings/src/manifest.ts
// 设置页（硬切换 003）：
//   - 不再有 /settings 聚合页，也不再有 /settings/apps 应用设置目录。
//   - plugin-settings 通过 business.registry 提供「设置」业务域。
//   - 插件设置、广播网关及其他配置各自拥有明确的新导航入口；
//     bsv-price / poker 等业务插件的设置页直接挂到「设置」域下。
//   - 不再向 breadcrumb.registry 注册指向 /settings 的可点击父级。
//
// 设计缘由：
//   - business.registry 是唯一的用户可见菜单来源；设置的子页面仍各自维护
//     独立 route，避免把多个配置面重新塞回聚合页。
//   - PluginManagerPage 是系统级独立工作台，必须能直接通过 /settings/plugins
//     访问，不能再被某个聚合页的可见性策略遮蔽。

import type {
  I18nPluginResources,
  PluginManifest,
  PluginSetup,
} from "@keymaster/contracts";
import {
  BREADCRUMB_REGISTRY_CAPABILITY,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import { PluginManagerPage } from "./PluginManagerPage.js";
import { SystemStatusPage } from "./SystemStatusPage.js";

/** 设置 i18n 资源。设计缘由：route / menu / 设置项 label 全部走 I18nText。 */
const settingsResources: I18nPluginResources = {
  // 这批 key 的调用方长期使用 `t("settings.*") / t("pluginManager.*")`，
  // 并不把 `settings` 当 namespace 前缀来传。
  // 因此资源必须挂在 common namespace，才能让这些 flat key 直接命中。
  namespace: "common",
  resources: {
    en: {
      "settings.route.plugins": "Plugins",
      "settings.business.domain": "Settings",
      "settings.business.plugins": "Plugin settings",
      "settings.systemStatus.title": "Broadcast gateway",
      "settings.systemStatus.description": "Manage broadcast gateway suppliers and service status.",
      "settings.systemStatus.empty": "No broadcast gateway modules are available.",
      "settings.menu.plugins": "Plugins",
      "settings.crumb.settings": "Settings",
      "settings.crumb.plugins": "Plugins",
      "settings.language.title": "Language",
      "settings.language.description": "Choose display language. Affects all UI text; switch is instant.",
      "settings.language.option.en": "English",
      "settings.language.option.zh-CN": "Simplified Chinese",
      // 硬切换 001：插件管理页
      "pluginManager.title": "Plugins",
      "pluginManager.description":
        "Manage enabled optional plugins. System modules are always available and are not listed here.",
      "pluginManager.error": "Error",
      "pluginManager.meta.id": "Id",
      "pluginManager.meta.provides": "Provides",
      "pluginManager.meta.depends": "Depends on",
      "pluginManager.meta.reverse": "Used by",
      "pluginManager.meta.none": "—",
      "pluginManager.meta.blockers": "Blocking dependents",
      "pluginManager.meta.blockersHint":
        "These dependents will stop automatically and keep their enable intent.",
      "pluginManager.meta.cascade": "Will stop dependents",
      "pluginManager.meta.cascadeHint":
        "Disabling this plugin will stop the listed dependents; their enable intent is preserved.",
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
      "pluginManager.state.starting": "Starting",
      "pluginManager.state.stopping": "Stopping",
      "pluginManager.state.disabled": "Disabled",
      "pluginManager.state.blocked": "Blocked (missing dependency)",
      "pluginManager.state.errorDisabled": "Error-disabled",
      "pluginManager.state.cleanupPending": "Cleanup pending",
      "pluginManager.state.intentPending": "Enable intent is pending runtime state",
      "pluginManager.state.registered": "Registered",
    },
    "zh-CN": {
      "settings.route.plugins": "插件",
      "settings.business.domain": "设置",
      "settings.business.plugins": "插件设置",
      "settings.systemStatus.title": "广播网关",
      "settings.systemStatus.description": "管理广播网关供应商与服务状态。",
      "settings.systemStatus.empty": "当前没有可用的广播网关模块。",
      "settings.menu.plugins": "插件",
      "settings.crumb.settings": "设置",
      "settings.crumb.plugins": "插件",
      "settings.language.title": "语言",
      "settings.language.description": "选择界面显示语言，影响所有 UI 文案；切换立即生效。",
      "settings.language.option.en": "English",
      "settings.language.option.zh-CN": "简体中文",
      // 硬切换 001：插件管理页
      "pluginManager.title": "插件管理",
      "pluginManager.description": "管理已启用的外围插件。系统级功能模块始终可用，不在此列表中显示。",
      "pluginManager.error": "错误",
      "pluginManager.meta.id": "Id",
      "pluginManager.meta.provides": "提供",
      "pluginManager.meta.depends": "依赖",
      "pluginManager.meta.reverse": "被谁依赖",
      "pluginManager.meta.none": "—",
      "pluginManager.meta.blockers": "阻塞的反向依赖",
      "pluginManager.meta.blockersHint": "这些依赖插件会自动停止，但会保留自己的启用意图。",
      "pluginManager.meta.cascade": "将自动停止依赖插件",
      "pluginManager.meta.cascadeHint": "禁用本插件会自动停止列表中的依赖插件，但不会改写它们的启用意图。",
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
      "pluginManager.state.starting": "启动中",
      "pluginManager.state.stopping": "停止中",
      "pluginManager.state.disabled": "已禁用",
      "pluginManager.state.blocked": "被阻塞（依赖缺失）",
      "pluginManager.state.errorDisabled": "错误已禁用",
      "pluginManager.state.cleanupPending": "清理未完成",
      "pluginManager.state.intentPending": "启用意图正在等待运行状态收敛",
      "pluginManager.state.registered": "已注册",
    }
  }
};

const settingsPluginDefinition = {
  id: "settings",
  name: "Settings",
  description: "插件管理、广播网关及其他独立设置入口。",
  kind: "core",
  startup: "optional",
  bootstrapStage: "vault-selection",
  defaultEnabled: true,
  canDisable: false,
  displayGroup: "core",
  units: [{
    id: "settings.window",
    runtime: "window-main",
    scopeKind: "root",
    dependencies: defineRuntimeUnitDependencies([
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, reason: "为设置详情页提供面包屑" },
    ]),
    business: {
      domains: [{
        id: "settings",
        label: { key: "settings.business.domain", fallback: "Settings" },
        order: 900,
        features: [{
          id: "settings.plugins",
          label: { key: "settings.business.plugins", fallback: "Plugin settings" },
          order: 40,
          icon: "Puzzle",
          entry: { path: "/settings/plugins", component: PluginManagerPage }
        }, {
          id: "settings.system-status",
          label: { key: "settings.systemStatus.title", fallback: "Broadcast gateway" },
          order: 50,
          icon: "Activity",
          entry: { path: "/settings/system-status", component: SystemStatusPage }
        }]
      }]
    },
  }],
  i18n: settingsResources,
  setup(ctx) {
    // 面包屑：当前路径匹配时第一段固定为不可点击的"设置"分类节点。
    // 这样 plugin 的 settings breadcrumb 不再回指不存在的 /settings，
    // 同时与 /settings/poker 等其它设置详情页保持一致的第一段样式。
    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
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
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: settingsSetup, ...settingsPlugin } = settingsPluginDefinition;
export { settingsSetup, settingsPlugin };
