import { createElement, useSyncExternalStore } from "react";
import { ScopedPluginConsumerProvider as PluginConsumerProvider } from "@keymaster/runtime";
import { I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
// packages/plugin-apps/src/manifest.ts
// plugin-apps 插件：Keymaster 内部 app launcher。
//
// 设计缘由：
//   - 注册 `/apps` 页面，并接入新业务导航的首页域与首页 widget；
//   - 点击 `Open App` 时调用 `protocol.service.launchAppView(...)`，只传
//     origin 推导的启动入口，不传 appIdentity、不做签名/能力前置要求；
//   - 插件不自行操作协议存储、App 运行材料或开窗，由主钱包连接宿主统一管理。
//   - 依赖 `page.ui.registry` / `business.registry` / `protocol.service`。
//   - plugin-apps 拥有 launcher 入口，寿命由依赖与作用域决定。
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
  PROTOCOL_SERVICE_CAPABILITY,
  STORAGE_FILE_CLIENTS_CAPABILITY, CENTRAL_STORAGE_DECLARATIONS, APPLICATION_CONNECTIONS_CAPABILITY,
  VAULT_WALLET_STATE_CAPABILITY,
  PAGE_UI_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  capabilityDescriptor,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import { APP_DIRECTORY_CAPABILITY, createAppDirectoryService } from "./catalog.js";
import { AppsHomeWidget } from "./AppsHomeWidget.js";
import { AppsPage } from "./AppsPage.js";

const appsResources: I18nPluginResources = {
  namespace: "apps",
  resources: {
    en: {
      "apps.route.label": "Apps",
      "apps.menu.label": "Apps",
      "apps.domain.label": "Applications",
      "apps.page.title": "Apps",
      "apps.page.description": "Open an external app. Manage its connections and permissions in Keymaster.",
      "apps.page.backToHome": "Back to home",
      "apps.page.empty.title": "No apps yet",
      "apps.page.empty.description": "Apps registered in the catalog will appear here.",
      "apps.open.cta": "Open App",
      "apps.open.launching": "Opening…",
      // 启动失败的 user-facing 文案（与 LaunchAppViewError.code 一一对应）。
      "apps.open.error.vaultLocked":
        "Please unlock Keymaster first, then try again.",
      "apps.open.error.noActiveKey":
        "No ready owner key is available. Please create or import one first.",
      "apps.open.error.invalidAppConfig":
        "This app's configuration is invalid. Please contact the app provider.",
      "apps.open.error.requirementUnavailable":
        "This app requirement is not ready. Please configure Storage first.",
      "apps.open.error.windowUnavailable":
        "This browser environment cannot open the app.",
      "apps.open.error.sessionStorageUnavailable":
        "Keymaster local storage is unavailable. Please try again later.",
      "apps.open.error.exportOwnerRuntimeFailed":
        "Failed to prepare the app owner runtime. Please try again.",
      "apps.open.error.openSessionWindowFailed":
        "Failed to open the app window. Please try again.",
      "apps.open.error.openSessionWindowBlocked":
        "The browser blocked opening the app. Please allow popups for Keymaster and try again.",
      "apps.open.error.internal":
        "Failed to open the app. Please try again.",
      "apps.launch.title": "Open {name}",
      "apps.launch.titleFallback": "Open App",
      "apps.launch.key": "Key",
      "apps.launch.keyHint": "This app session binds to the only key kept in this browser.",
      "apps.launch.password": "Vault password",
      "apps.launch.hardware": "Use the connected RocKey, unlocked on the device. Enter the PIN only on the device.",
      "apps.launch.error.noKeys": "No Vault key is available.",
      "apps.launch.url": "URL",
      "apps.launch.source": "Source",
      "apps.widget.title": "Apps",
      "apps.widget.empty": "No apps registered yet.",
      "apps.widget.unavailable": "The app service is temporarily unavailable for this session.",
      "apps.widget.viewAll": "View all apps",
      "apps.directory.loading": "Loading apps…",
      "apps.directory.loadFailed":
        "Failed to update the market listing. Local apps are still available.",
      "apps.directory.retry": "Retry",
      "apps.directory.persist.failed": "Failed to save the app directory. Your change was not saved.",
      "apps.directory.ephemeral":
        "Temporary in-memory mode: browser storage is unavailable. Changes will be lost on reload.",
      "apps.directory.source.market": "Market",
      "apps.directory.source.local": "Local",
      "apps.directory.source.favorite": "Favorite",
      "apps.directory.favorite.add": "Favorite",
      "apps.directory.favorite.remove": "Unfavorite",
      "apps.directory.local.remove": "Remove",
      "apps.directory.local.edit": "Edit",
      "apps.directory.local.save": "Save",
      "apps.directory.local.cancel": "Cancel",
      "apps.directory.add.open": "Add app",
      "apps.directory.add.url": "App URL",
      "apps.directory.add.name": "Name (optional)",
      "apps.directory.add.description": "Description (optional)",
      "apps.directory.add.submit": "Add",
      "apps.directory.add.invalidUrl": "Enter a valid http(s) URL."
    },
    "zh-CN": {
      "apps.route.label": "应用",
      "apps.menu.label": "应用",
      "apps.domain.label": "应用",
      "apps.page.title": "应用",
      "apps.page.description": "打开外部应用，在钱包内管理该应用的连接与许可。",
      "apps.page.backToHome": "返回首页",
      "apps.page.empty.title": "还没有应用",
      "apps.page.empty.description": "在清单中注册的应用会显示在这里。",
      "apps.open.cta": "打开 App",
      "apps.open.launching": "正在打开…",
      "apps.open.error.vaultLocked": "请先解锁 Keymaster，然后再试一次。",
      "apps.open.error.noActiveKey": "没有可用的 owner key。请先创建或导入一把。",
      "apps.open.error.invalidAppConfig": "该应用配置非法，请联系应用提供方。",
      "apps.open.error.requirementUnavailable": "该应用所需能力尚未就绪，请先配置 Storage。",
      "apps.open.error.windowUnavailable": "当前浏览器环境无法打开该应用。",
      "apps.open.error.sessionStorageUnavailable": "Keymaster 本地存储不可用，请稍后再试。",
      "apps.open.error.exportOwnerRuntimeFailed": "app owner runtime 准备失败，请稍后再试。",
      "apps.open.error.openSessionWindowFailed": "打开应用窗口失败，请稍后再试。",
      "apps.open.error.openSessionWindowBlocked": "浏览器拦截了应用窗口。请允许 Keymaster 打开新窗口后再试一次。",
      "apps.open.error.internal": "打开应用失败，请稍后再试。",
      "apps.launch.title": "打开 {name}",
      "apps.launch.titleFallback": "打开应用",
      "apps.launch.key": "密钥",
      "apps.launch.keyHint": "该应用会话只绑定本浏览器保存的唯一一把 Key。",
      "apps.launch.password": "Vault 密码",
      "apps.launch.hardware": "使用已连接并在设备上解锁的 RocKey。PIN 只在设备上输入。",
      "apps.launch.error.noKeys": "没有可用的 Vault key。",
      "apps.launch.url": "链接",
      "apps.launch.source": "来源",
      "apps.widget.title": "应用",
      "apps.widget.empty": "尚未注册应用。",
      "apps.widget.unavailable": "当前会话暂时无法提供应用服务。",
      "apps.widget.viewAll": "查看所有应用",
      "apps.directory.loading": "正在加载应用…",
      "apps.directory.loadFailed": "更新市场目录失败，本地应用仍可使用。",
      "apps.directory.retry": "重试",
      "apps.directory.persist.failed": "保存应用目录失败，本次更改未生效。",
      "apps.directory.ephemeral": "临时内存模式：浏览器存储不可用，刷新后更改会丢失。",
      "apps.directory.source.market": "市场",
      "apps.directory.source.local": "本地",
      "apps.directory.source.favorite": "收藏",
      "apps.directory.favorite.add": "收藏",
      "apps.directory.favorite.remove": "取消收藏",
      "apps.directory.local.remove": "删除",
      "apps.directory.local.edit": "编辑",
      "apps.directory.local.save": "保存",
      "apps.directory.local.cancel": "取消",
      "apps.directory.add.open": "自添加应用",
      "apps.directory.add.url": "应用 URL",
      "apps.directory.add.name": "名称（可选）",
      "apps.directory.add.description": "介绍（可选）",
      "apps.directory.add.submit": "添加",
      "apps.directory.add.invalidUrl": "请输入合法的 http(s) URL。"
    }
  }
};

const appsPluginDefinition = {
  id: "apps",
  name: "Apps",
  description: "Keymaster 内部 app launcher：展示应用目录并在当前 Keymaster 窗口作为 launcher 启动 appView。",

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
      { capability: PROTOCOL_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "调用 launchAppView 启动 appView" },
      { capability: PAGE_UI_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册应用列表页面" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "接入首页业务导航" },
    ]),
  }],
  i18n: appsResources,
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
      id: "apps.launcher",
      path: "/apps",
      label: { key: "apps.route.label", fallback: "Apps" },
      kind: "page",
      render: () => createElement(AppsPage)
    });

    const AppHome = () => {
      const status = useSyncExternalStore(ctx.consumer.subscribe, () => ctx.consumer.status, () => ctx.consumer.status);
      return status === "active" ? createElement(PluginConsumerProvider, { consumer: ctx.consumer, children: createElement(AppsHomeWidget) }) : null;
    };
    pages.view.register({ kind: "home", slot: "main", id: "apps.home", label: "apps", space: { id: "apps.applications", label: { key: "apps.domain.label", fallback: "Applications" }, order: 400 }, order: 60, render: () => createElement(AppHome) });
    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
    business.registerFeature("apps", "home", {
      id: "home.apps",
      label: { key: "apps.menu.label", fallback: "Apps" },
      order: 50,
      icon: "LayoutGrid",
      entry: { path: "/apps", routeId: "apps.launcher" },
    });
    return off;
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: appsSetup, ...appsPlugin } = appsPluginDefinition;
export { appsSetup, appsPlugin };
