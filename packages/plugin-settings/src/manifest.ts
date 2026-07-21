// packages/plugin-settings/src/manifest.ts
// 设置页（硬切换 003）：
//   - 不再有 /settings 聚合页。
//   - plugin-settings 通过 business.registry 提供「设置」业务域。
//   - 系统设置、应用设置、插件设置和系统状态各自拥有明确的新导航入口。
//   - 不再向 breadcrumb.registry 注册指向 /settings 的可点击父级。
//
// 设计缘由：
//   - business.registry 是唯一的用户可见菜单来源；设置的子页面仍各自维护
//     独立 route，避免把多个配置面重新塞回聚合页。
//   - PluginManagerPage 是系统级独立工作台，必须能直接通过 /settings/plugins
//     访问，不能再被某个聚合页的可见性策略遮蔽。

import type {
  BreadcrumbRegistry,
  I18nPluginResources,
  PluginManifest,
  SystemSettingsRegistry
} from "@keymaster/contracts";
import { LOG_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { PluginManagerPage } from "./PluginManagerPage.js";
import { LanguageSection } from "./LanguageSection.js";
import { LogConfigurationSettings, LogSettingsPage } from "./LogSettingsPage.js";
import { SystemSettingsPage } from "./SystemSettingsPage.js";
import { SystemStatusPage } from "./SystemStatusPage.js";
import { ApplicationSettingsPage } from "./ApplicationSettingsPage.js";

/** 设置 i18n 资源。设计缘由：route / menu / 设置项 label 全部走 I18nText。 */
const settingsResources: I18nPluginResources = {
  // 这批 key 的调用方长期使用 `t("settings.*") / t("pluginManager.*") /
  // t("logSettings.*")`，并不把 `settings` 当 namespace 前缀来传。
  // 因此资源必须挂在 common namespace，才能让这些 flat key 直接命中。
  namespace: "common",
  resources: {
    en: {
      "settings.route.language": "Language",
      "settings.route.plugins": "Plugins",
      "settings.route.logs": "System logs",
      "settings.business.domain": "Settings",
      "settings.system.title": "System",
      "settings.system.description": "Changes take effect immediately.",
      "settings.system.group.language": "Language",
      "settings.business.plugins": "Plugin settings",
      "settings.applicationSettings.title": "Application settings",
      "settings.applicationSettings.description": "Choose an application to configure.",
      "settings.applicationSettings.directory": "Configured applications",
      "settings.applicationSettings.count": "{{count}} apps",
      "settings.applicationSettings.open": "Open {{name}} settings",
      "settings.applicationSettings.empty.title": "No application settings",
      "settings.applicationSettings.empty.description": "Enabled applications with settings will appear here.",
      "settings.systemStatus.title": "System status",
      "settings.systemStatus.description": "Live status for always-on system modules.",
      "settings.systemStatus.empty": "No system status modules are available.",
      "settings.menu.language": "Language",
      "settings.menu.plugins": "Plugins",
      "settings.menu.logs": "System logs",
      "settings.crumb.settings": "Settings",
      "settings.crumb.language": "Language",
      "settings.crumb.plugins": "Plugins",
      "settings.crumb.logs": "System logs",
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
      "pluginManager.state.registered": "Registered",
      // 硬切换 002：统一日志页文案
      "logSettings.title": "System logs",
      "logSettings.description":
        "Inspect the unified system log. Plugins record their activity via ctx.logger; entries are stored in a single global IndexedDB.",
      "logSettings.config.description": "Configure retention and debug collection for the unified system log.",
      "logSettings.config.title": "Configuration",
      "logSettings.config.retentionHint":
        "Retention applies to all entries. Decreasing the value prunes the oldest entries immediately (best-effort).",
      "logSettings.config.debug": "Enable debug logs",
      "logSettings.config.debugHint":
        "Debug is off by default. When off, logger.debug() does not write to storage. Turning it on affects future entries only — past debug entries are not back-filled.",
      "logSettings.config.retention": "Retention (days)",
      "logSettings.config.save": "Save",
      "logSettings.config.pruneNow": "Prune now",
      "logSettings.filter.title": "Filters",
      "logSettings.filter.pluginId": "Plugin id",
      "logSettings.filter.pluginIdPh": "e.g. woc, p2pkh, runtime",
      "logSettings.filter.level": "Level",
      "logSettings.filter.levelAll": "All",
      "logSettings.filter.keyword": "Keyword",
      "logSettings.filter.keywordPh": "Match message / event / scope",
      "logSettings.filter.needOne": "Set a plugin id or level first",
      "logSettings.actions.clearFiltered": "Clear filtered",
      "logSettings.actions.clearAll": "Clear all",
      "logSettings.actions.clearAllConfirm": "Clear ALL log entries? This cannot be undone.",
      "logSettings.list.title": "Entries",
      "logSettings.list.empty": "No entries match the current filters.",
      "logSettings.entry.details": "Details",
      "logSettings.entry.hide": "Hide",
      "logSettings.entry.data": "data",
      "logSettings.entry.error": "error",
      "logSettings.cleared": "Cleared ${removed} entries",
      "logSettings.pruned": "Pruned ${removed} expired entries"
    },
    "zh-CN": {
      "settings.route.language": "语言",
      "settings.route.plugins": "插件",
      "settings.route.logs": "系统日志",
      "settings.business.domain": "设置",
      "settings.system.title": "系统",
      "settings.system.description": "修改会立即生效。",
      "settings.system.group.language": "语言",
      "settings.business.plugins": "插件设置",
      "settings.applicationSettings.title": "应用设置",
      "settings.applicationSettings.description": "选择要配置的应用。",
      "settings.applicationSettings.directory": "已配置的应用",
      "settings.applicationSettings.count": "{{count}} 个应用",
      "settings.applicationSettings.open": "打开 {{name}} 设置",
      "settings.applicationSettings.empty.title": "暂无应用设置",
      "settings.applicationSettings.empty.description": "已启用且提供设置的应用会显示在这里。",
      "settings.systemStatus.title": "系统状态",
      "settings.systemStatus.description": "查看常驻系统模块的实时状态。",
      "settings.systemStatus.empty": "当前没有可用的系统状态模块。",
      "settings.menu.language": "语言",
      "settings.menu.plugins": "插件",
      "settings.menu.logs": "系统日志",
      "settings.crumb.language": "语言",
      "settings.crumb.settings": "设置",
      "settings.crumb.plugins": "插件",
      "settings.crumb.logs": "系统日志",
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
      "pluginManager.state.registered": "已注册",
      // 硬切换 002：统一日志页文案
      "logSettings.title": "系统日志",
      "logSettings.description":
        "查看统一系统日志。插件通过 ctx.logger 记录行为，entry 存储在唯一的全局 IndexedDB 中。",
      "logSettings.config.description": "配置统一系统日志的保留策略与 debug 采集。",
      "logSettings.config.title": "配置",
      "logSettings.config.retentionHint":
        "保留策略对所有 entry 生效。调小后立即触发 best-effort 清理。",
      "logSettings.config.debug": "开启 debug 日志",
      "logSettings.config.debugHint":
        "debug 默认关闭。关闭时 logger.debug() 不写入存储；开启后只对未来产生的 entry 生效，**不**补历史。",
      "logSettings.config.retention": "保留天数",
      "logSettings.config.save": "保存",
      "logSettings.config.pruneNow": "立即清理过期",
      "logSettings.filter.title": "过滤",
      "logSettings.filter.pluginId": "插件 id",
      "logSettings.filter.pluginIdPh": "例如 woc, p2pkh, runtime",
      "logSettings.filter.level": "级别",
      "logSettings.filter.levelAll": "全部",
      "logSettings.filter.keyword": "关键字",
      "logSettings.filter.keywordPh": "匹配 message / event / scope",
      "logSettings.filter.needOne": "请先设置 plugin id 或 level",
      "logSettings.actions.clearFiltered": "按过滤清理",
      "logSettings.actions.clearAll": "清空全部",
      "logSettings.actions.clearAllConfirm": "确定清空所有日志 entry？此操作不可撤销。",
      "logSettings.list.title": "Entry 列表",
      "logSettings.list.empty": "没有匹配当前过滤的 entry。",
      "logSettings.entry.details": "详情",
      "logSettings.entry.hide": "收起",
      "logSettings.entry.data": "data",
      "logSettings.entry.error": "error",
      "logSettings.cleared": "已清理 ${removed} 条 entry",
      "logSettings.pruned": "已清理 ${removed} 条过期 entry"
    }
  }
};

export const settingsPlugin: PluginManifest = {
  id: "settings",
  name: "Settings",
  description: "系统级设置页：语言、插件管理。",
  meta: {
    kind: "core",
    startup: "optional",
    defaultEnabled: true,
    canDisable: false,
    displayGroup: "core"
  },
  i18n: settingsResources,
  dependencies: [
    { capability: "system-settings.registry", reason: "注册系统语言设置" },
    { capability: "application-settings.registry", reason: "展示应用设置目录" },
    { capability: "breadcrumb.registry", reason: "为设置详情页提供面包屑" },
    { capability: LOG_SERVICE_CAPABILITY, reason: "统一日志页依赖 log.service" }
  ],
  business: {
    domains: [{
      id: "settings",
      label: { key: "settings.business.domain", fallback: "Settings" },
      order: 900,
      features: [{
        id: "settings.system",
        label: { key: "settings.system.title", fallback: "System" },
        order: 10,
        icon: "Settings",
        entry: { path: "/settings/system", component: SystemSettingsPage }
      }, {
        id: "settings.application-settings",
        label: { key: "settings.applicationSettings.title", fallback: "Application settings" },
        order: 20,
        icon: "PanelsTopLeft",
        entry: {
          path: "/settings/apps",
          component: ApplicationSettingsPage,
          activeWhen: (path) => path.startsWith("/settings/apps/")
        }
      }, {
        id: "settings.plugins",
        label: { key: "settings.business.plugins", fallback: "Plugin settings" },
        order: 30,
        icon: "Puzzle",
        entry: { path: "/settings/plugins", component: PluginManagerPage }
      }, {
        id: "settings.logs",
        label: { key: "settings.route.logs", fallback: "System logs" },
        order: 40,
        icon: "ScrollText",
        entry: { path: "/settings/logs", component: LogSettingsPage }
      }, {
        id: "settings.system-status",
        label: { key: "settings.systemStatus.title", fallback: "System status" },
        order: 50,
        icon: "Activity",
        entry: { path: "/settings/system-status", component: SystemStatusPage }
      }]
    }]
  },
  setup(ctx) {
    const systemSettings = ctx.get<SystemSettingsRegistry>("system-settings.registry");
    systemSettings.register({
      id: "settings.system.language",
      group: {
        id: "language",
        label: { key: "settings.system.group.language", fallback: "Language" },
        order: 10
      },
      label: { key: "settings.language.title", fallback: "Language" },
      description: { key: "settings.language.description", fallback: "Choose display language. Switch is instant." },
      component: LanguageSection,
      order: 10,
      replacesSettingsRouteId: "settings.language",
      visibleWhen: () => true
    });
    systemSettings.register({
      id: "settings.system.log-config",
      group: {
        id: "system-logs",
        label: { key: "logSettings.title", fallback: "System logs" },
        order: 60
      },
      label: { key: "logSettings.config.title", fallback: "Configuration" },
      description: { key: "logSettings.config.description", fallback: "Configure retention and debug collection for the unified system log." },
      component: LogConfigurationSettings,
      order: 10,
      replacesSettingsRouteId: "settings.logs",
      visibleWhen: () => true
    });

    // 面包屑：当前路径匹配时第一段固定为不可点击的"设置"分类节点。
    // 这样 plugin 的 settings breadcrumb 不再回指不存在的 /settings，
    // 同时与 /settings/apps/poker 等其它设置详情页保持一致的第一段样式。
    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    breadcrumbs.register({
      id: "settings.application-settings.crumbs",
      order: 5,
      match: (path) => path === "/settings/apps",
      resolve: () => [
        { label: { key: "settings.crumb.settings", fallback: "Settings" } },
        { label: { key: "settings.applicationSettings.title", fallback: "Application settings" } }
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
    breadcrumbs.register({
      id: "settings.logs.crumbs",
      order: 5,
      match: (path) => path === "/settings/logs",
      resolve: () => [
        { label: { key: "settings.crumb.settings", fallback: "Settings" } },
        { label: { key: "settings.crumb.logs", fallback: "System logs" } }
      ]
    });

    // core 插件；teardown 走空实现。
    return () => {
      // no-op
    };
  }
};
