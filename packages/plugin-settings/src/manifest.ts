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
import { LOG_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { PluginManagerPage } from "./PluginManagerPage.js";
import { LanguageSettingsPage } from "./LanguageSettingsPage.js";
import { LogSettingsPage } from "./LogSettingsPage.js";
import { StorageSettingsPage } from "./StorageSettingsPage.js";

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
      "settings.route.storage": "Storage",
      "settings.menu.language": "Language",
      "settings.menu.plugins": "Plugins",
      "settings.menu.logs": "System logs",
      "settings.menu.storage": "Storage",
      "settings.crumb.settings": "Settings",
      "settings.crumb.language": "Language",
      "settings.crumb.plugins": "Plugins",
      "settings.crumb.logs": "System logs",
      "settings.crumb.storage": "Storage",
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
      "pluginManager.state.registered": "Registered",
      // 硬切换 002：统一日志页文案
      "logSettings.title": "System logs",
      "logSettings.description":
        "Inspect and configure the unified system log. Plugins record their activity via ctx.logger; entries are stored in a single global IndexedDB.",
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
      "logSettings.pruned": "Pruned ${removed} expired entries",
      // 施工单 2026-06-29 001：storage 设置页文案。
      "storageSettings.title": "Storage",
      "storageSettings.description":
        "Configure an S3-compatible storage provider. Keymaster uses this to store app data (storage.*). The configuration is local-only and never shared with apps.",
      "storageSettings.field.endpoint": "Endpoint",
      "storageSettings.field.region": "Region",
      "storageSettings.field.bucket": "Bucket",
      "storageSettings.field.accessKeyId": "Access key id",
      "storageSettings.field.secretAccessKey": "Secret access key",
      "storageSettings.field.forcePathStyle": "Force path-style addressing (recommended for self-hosted)",
      "storageSettings.action.clear": "Clear"
    },
    "zh-CN": {
      "settings.route.language": "语言",
      "settings.route.plugins": "插件",
      "settings.route.logs": "系统日志",
      "settings.route.storage": "存储",
      "settings.menu.language": "语言",
      "settings.menu.plugins": "插件",
      "settings.menu.logs": "系统日志",
      "settings.menu.storage": "存储",
      "settings.crumb.language": "语言",
      "settings.crumb.settings": "设置",
      "settings.crumb.plugins": "插件",
      "settings.crumb.logs": "系统日志",
      "settings.crumb.storage": "存储",
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
      "pluginManager.state.registered": "已注册",
      // 硬切换 002：统一日志页文案
      "logSettings.title": "系统日志",
      "logSettings.description":
        "查看并配置统一系统日志。插件通过 ctx.logger 记录行为，entry 存储在唯一的全局 IndexedDB 中。",
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
      "logSettings.pruned": "已清理 ${removed} 条过期 entry",
      // 施工单 2026-06-29 001：storage 设置页文案。
      "storageSettings.title": "存储",
      "storageSettings.description":
        "配置 S3-compatible 存储 provider。Keymaster 用它存储 app 数据（storage.*）。配置仅存本地，不会分享给 app。",
      "storageSettings.field.endpoint": "Endpoint",
      "storageSettings.field.region": "Region",
      "storageSettings.field.bucket": "Bucket",
      "storageSettings.field.accessKeyId": "Access key id",
      "storageSettings.field.secretAccessKey": "Secret access key",
      "storageSettings.field.forcePathStyle": "强制 path-style（自部署推荐）",
      "storageSettings.action.clear": "清除"
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
    { capability: "breadcrumb.registry", reason: "为设置详情页提供面包屑" },
    { capability: LOG_SERVICE_CAPABILITY, reason: "统一日志页依赖 log.service" }
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
    // 硬切换 002：/settings/logs 系统级统一日志页。
    settings.register({
      id: "settings.logs",
      path: "/settings/logs",
      label: { key: "settings.route.logs", fallback: "System logs" },
      description: {
        key: "logSettings.description",
        fallback: "Inspect and configure the unified system log."
      },
      order: 3,
      icon: "ScrollText",
      visibleWhen: () => true,
      component: LogSettingsPage
    });
    // 施工单 2026-06-29 001 硬切换：/settings/storage 全局 storage provider
    // 配置页。仅 unlocked 后可见（配置页面进入需要 vault 已解锁，避免未
    // 解锁态下误操作）。依赖 protocol.service（读写 storageProviderConfig）。
    settings.register({
      id: "settings.storage",
      path: "/settings/storage",
      label: { key: "settings.route.storage", fallback: "Storage" },
      description: {
        key: "storageSettings.description",
        fallback:
          "Configure an S3-compatible storage provider. Keymaster uses this to store app data."
      },
      order: 4,
      icon: "Database",
      visibleWhen: ({ unlocked }) => unlocked,
      component: StorageSettingsPage
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
    breadcrumbs.register({
      id: "settings.logs.crumbs",
      order: 5,
      match: (path) => path === "/settings/logs",
      resolve: () => [
        { label: { key: "settings.crumb.settings", fallback: "Settings" } },
        { label: { key: "settings.crumb.logs", fallback: "System logs" } }
      ]
    });
    breadcrumbs.register({
      id: "settings.storage.crumbs",
      order: 5,
      match: (path) => path === "/settings/storage",
      resolve: () => [
        { label: { key: "settings.crumb.settings", fallback: "Settings" } },
        { label: { key: "settings.crumb.storage", fallback: "Storage" } }
      ]
    });

    // core 插件；teardown 走空实现。
    return () => {
      // no-op
    };
  }
};
