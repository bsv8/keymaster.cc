import { createElement, useSyncExternalStore } from "react";
import { ScopedPluginConsumerProvider as PluginConsumerProvider } from "@keymaster/runtime";
import { I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
// packages/plugin-market/src/manifest.ts
// plugin-market 插件：Keymaster 内部 market launcher（显示名 Market，持久身份仍为 apps）。
//
// 设计缘由：
//   - 注册 `/apps` 页面，并接入新业务导航的首页域与首页 widget；
//   - 点击 `Open App` 时调用 `protocol.service`（CONNECT_SERVICE_CAPABILITY，能力字符串保留）`launchAppView(...)`，只传
//     origin 推导的启动入口，不传 appIdentity、不做签名/能力前置要求；
//   - 插件不自行操作协议存储、App 运行材料或开窗，由主钱包连接宿主统一管理。
//   - 依赖 `page.ui.registry` / `business.registry` / `protocol.service`（能力字符串保留）。
//   - plugin-market 拥有 launcher 入口，寿命由依赖与作用域决定。
//   - 应用目录走共享的 `app.directory` 能力：同一份已上架目录 + 本地缓存
//     （TTL 600000ms、lastSuccessfulFetchAt）+ 收藏 + 自添加合并；
//     首页 widget 与 `/apps` 页面共用该能力，共享缓存与请求合并。
//   - 启动失败的 user-facing 文案（与 LaunchAppViewError.code 一一对应）；
//     当前激活错误码 `export_owner_runtime_failed` 表示 launcher 端
//     生成 appView owner runtime capability 失败。

import type {
  BusinessFeatureRegistry,
  I18nPluginResources,
  PluginManifest,
  PluginSetup,
  RouteRegistry
} from "@keymaster/contracts";
import {
  CONNECT_SERVICE_CAPABILITY,
  STORAGE_FILE_CLIENTS_CAPABILITY, CENTRAL_STORAGE_DECLARATIONS, APPLICATION_CONNECTIONS_CAPABILITY,
  VAULT_WALLET_STATE_CAPABILITY,
  PAGE_UI_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  capabilityDescriptor,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import { APP_DIRECTORY_CAPABILITY, createAppDirectoryService } from "./catalog.js";
import { AppsHomeWidget } from "./AppsHomeWidget.js";
import { MarketPage } from "./MarketPage.js";
import { AppDetailPage } from "./AppDetailPage.js";

const marketResources: I18nPluginResources = {
  namespace: "market",
  resources: {
    en: {
      "market.route.label": "App market",
      "market.menu.label": "App market",
      "market.domain.label": "Applications",
      "market.page.title": "App market",
      "market.page.description": "Open an external app. Manage its connections and permissions in Keymaster.",
      "market.page.backToHome": "Back to home",
      "market.page.empty.title": "No apps yet",
      "market.page.empty.description": "Apps registered in the catalog will appear here.",
      "market.open.cta": "Open App",
      "market.open.launching": "Opening…",
      // 启动失败的 user-facing 文案（与 LaunchAppViewError.code 一一对应）。
      "market.open.error.vaultLocked":
        "Please unlock Keymaster first, then try again.",
      "market.open.error.noActiveKey":
        "No ready owner key is available. Please create or import one first.",
      "market.open.error.invalidAppConfig":
        "This app's configuration is invalid. Please contact the app provider.",
      "market.open.error.requirementUnavailable":
        "This app requirement is not ready. Please configure Storage first.",
      "market.open.error.windowUnavailable":
        "This browser environment cannot open the app.",
      "market.open.error.sessionStorageUnavailable":
        "Keymaster local storage is unavailable. Please try again later.",
      "market.open.error.exportOwnerRuntimeFailed":
        "Failed to prepare the app owner runtime. Please try again.",
      "market.open.error.openSessionWindowFailed":
        "Failed to open the app window. Please try again.",
      "market.open.error.openSessionWindowBlocked":
        "The browser blocked opening the app. Please allow popups for Keymaster and try again.",
      "market.open.error.internal":
        "Failed to open the app. Please try again.",
      "market.launch.title": "Open {name}",
      "market.launch.titleFallback": "Open App",
      "market.launch.key": "Key",
      "market.launch.keyHint": "This app session binds to the only key kept in this browser.",
      "market.launch.password": "Vault password",
      "market.launch.hardware": "Use the connected RocKey, unlocked on the device. Enter the PIN only on the device.",
      "market.launch.error.noKeys": "No Vault key is available.",
      "market.launch.url": "URL",
      "market.launch.source": "Source",
      "market.widget.title": "Apps",
      "market.widget.empty": "No apps registered yet.",
      "market.widget.unavailable": "The app service is temporarily unavailable for this session.",
      "market.widget.viewAll": "View all apps",
      "market.directory.loading": "Loading apps…",
      "market.directory.loadFailed":
        "Failed to update the market listing. Local apps are still available.",
      "market.directory.retry": "Retry",
      "market.directory.persist.failed": "Failed to save the app directory. Your change was not saved.",
      "market.directory.ephemeral":
        "Temporary in-memory mode: browser storage is unavailable. Changes will be lost on reload.",
      "market.directory.source.market": "Market",
      "market.directory.source.local": "Local",
      "market.directory.source.favorite": "Favorite",
      "market.directory.favorite.add": "Favorite",
      "market.directory.favorite.remove": "Unfavorite",
      "market.directory.local.remove": "Remove",
      "market.directory.local.edit": "Edit",
      "market.directory.local.save": "Save",
      "market.directory.local.cancel": "Cancel",
      "market.directory.add.open": "Add app",
      "market.directory.add.url": "App URL",
      "market.directory.add.name": "Name (optional)",
      "market.directory.add.description": "Description (optional)",
      "market.directory.add.submit": "Add",
      "market.directory.add.invalidUrl": "Enter a valid http(s) URL."
    },
    "zh-CN": {
      "market.route.label": "应用市场",
      "market.menu.label": "应用市场",
      "market.domain.label": "应用",
      "market.page.title": "应用市场",
      "market.page.description": "打开外部应用，在钱包内管理该应用的连接与许可。",
      "market.page.backToHome": "返回首页",
      "market.page.empty.title": "还没有应用",
      "market.page.empty.description": "在清单中注册的应用会显示在这里。",
      "market.open.cta": "打开 App",
      "market.open.launching": "正在打开…",
      "market.open.error.vaultLocked": "请先解锁 Keymaster，然后再试一次。",
      "market.open.error.noActiveKey": "没有可用的 owner key。请先创建或导入一把。",
      "market.open.error.invalidAppConfig": "该应用配置非法，请联系应用提供方。",
      "market.open.error.requirementUnavailable": "该应用所需能力尚未就绪，请先配置 Storage。",
      "market.open.error.windowUnavailable": "当前浏览器环境无法打开该应用。",
      "market.open.error.sessionStorageUnavailable": "Keymaster 本地存储不可用，请稍后再试。",
      "market.open.error.exportOwnerRuntimeFailed": "app owner runtime 准备失败，请稍后再试。",
      "market.open.error.openSessionWindowFailed": "打开应用窗口失败，请稍后再试。",
      "market.open.error.openSessionWindowBlocked": "浏览器拦截了应用窗口。请允许 Keymaster 打开新窗口后再试一次。",
      "market.open.error.internal": "打开应用失败，请稍后再试。",
      "market.launch.title": "打开 {name}",
      "market.launch.titleFallback": "打开应用",
      "market.launch.key": "密钥",
      "market.launch.keyHint": "该应用会话只绑定本浏览器保存的唯一一把 Key。",
      "market.launch.password": "Vault 密码",
      "market.launch.hardware": "使用已连接并在设备上解锁的 RocKey。PIN 只在设备上输入。",
      "market.launch.error.noKeys": "没有可用的 Vault key。",
      "market.launch.url": "链接",
      "market.launch.source": "来源",
      "market.widget.title": "应用",
      "market.widget.empty": "尚未注册应用。",
      "market.widget.unavailable": "当前会话暂时无法提供应用服务。",
      "market.widget.viewAll": "查看所有应用",
      "market.directory.loading": "正在加载应用…",
      "market.directory.loadFailed": "更新市场目录失败，本地应用仍可使用。",
      "market.directory.retry": "重试",
      "market.directory.persist.failed": "保存应用目录失败，本次更改未生效。",
      "market.directory.ephemeral": "临时内存模式：浏览器存储不可用，刷新后更改会丢失。",
      "market.directory.source.market": "市场",
      "market.directory.source.local": "本地",
      "market.directory.source.favorite": "收藏",
      "market.directory.favorite.add": "收藏",
      "market.directory.favorite.remove": "取消收藏",
      "market.directory.local.remove": "删除",
      "market.directory.local.edit": "编辑",
      "market.directory.local.save": "保存",
      "market.directory.local.cancel": "取消",
      "market.directory.add.open": "自添加应用",
      "market.directory.add.url": "应用 URL",
      "market.directory.add.name": "名称（可选）",
      "market.directory.add.description": "介绍（可选）",
      "market.directory.add.submit": "添加",
      "market.directory.add.invalidUrl": "请输入合法的 http(s) URL。"
    }
  }
};

export const MARKET_PLUGIN_ID = "apps";
// 兼容说明：显示名已统一为 Market，但 pluginId/moduleId/unitId 仍保留 apps/apps.window，
// 存储布局与数据不变（本次 A 方案硬切换，不做迁移）。

const marketPluginDefinition = {
  id: MARKET_PLUGIN_ID,
  name: "Market",
  description: "Keymaster 内部 market launcher（显示名 Market，持久身份 apps）：展示应用目录并在当前 Keymaster 窗口作为 launcher 启动 appView。",

  units: [{
    id: "apps.window",
    runtime: "window-main",
    scopeKind: "storage",
    storages: [CENTRAL_STORAGE_DECLARATIONS.appsDirectory],
    provides: [capabilityDescriptor(APP_DIRECTORY_CAPABILITY)],
    dependencies: defineRuntimeUnitDependencies([
      { capability: STORAGE_FILE_CLIENTS_CAPABILITY, sourceRuntime: "window-main", reason: "目录完整状态的原子持久化" },
      { capability: APPLICATION_CONNECTIONS_CAPABILITY, sourceRuntime: "window-main", reason: "真实连接验证成功后解析 pending URL 身份" },
      { capability: I18N_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
      { capability: VAULT_WALLET_STATE_CAPABILITY, reason: "应用授权弹窗读取唯一钱包 Key 元数据" },
      { capability: CONNECT_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "调用 launchAppView 启动 appView（能力字符串 protocol.service 保留）" },
      { capability: PAGE_UI_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册应用列表页面" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "接入首页业务导航" },
    ]),
  }],
  i18n: marketResources,
  setup(ctx) {
    // 完整目录以模块根下的 directory.json 原子保存；不读取旧 K-V 路径。
    const directory = createAppDirectoryService({ repository: ctx.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(ctx.consumer,ctx.scope,CENTRAL_STORAGE_DECLARATIONS.appsDirectory.purposeId) });
    ctx.provide(APP_DIRECTORY_CAPABILITY, directory);
    const connections = ctx.capability(APPLICATION_CONNECTIONS_CAPABILITY);
    const off = connections.subscribe(() => {
      for (const app of connections.snapshot().applications) {
        if (!app.verifiedUrl||!app.display) continue;
        for (const pending of directory.getSnapshot().pending) {
          if (pending.url === app.verifiedUrl) void directory.resolvePending(pending.pendingId,app.key,app.verifiedUrl,app.display).catch(() => undefined);
        }
      }
    });

    const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope);
    pages.view.register({
      id: "market.launcher",
      path: "/apps",
      label: { key: "market.route.label", fallback: "Market" },
      kind: "page",
      render: () => createElement(MarketPage)
    });

    pages.view.register({
      id: "market.detail", path: "/app/:appId", kind: "page", label: "应用详情",
      render: location => createElement(AppDetailPage, { key: location.params.appId, appId: location.params.appId ?? "" }),
    });

    const AppHome = () => {
      const status = useSyncExternalStore(ctx.consumer.subscribe, () => ctx.consumer.status, () => ctx.consumer.status);
      return status === "active" ? createElement(PluginConsumerProvider, { consumer: ctx.consumer, children: createElement(AppsHomeWidget) }) : null;
    };
    pages.view.register({ kind: "home", slot: "main", id: "market.home", label: "market", space: { id: "market.applications", label: { key: "market.domain.label", fallback: "Applications" }, order: 400 }, order: 60, render: () => createElement(AppHome) });
    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
    business.registerFeature("apps", "home", {
      id: "home.market",
      label: { key: "market.menu.label", fallback: "Market" },
      order: 50,
      icon: "LayoutGrid",
      entry: { path: "/apps", routeId: "market.launcher" },
    });
    return off;
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: marketSetup, ...marketPlugin } = marketPluginDefinition;
export { marketSetup, marketPlugin };
export { MARKET_PLUGIN_ID as MARKET_PERSISTENT_ID };
