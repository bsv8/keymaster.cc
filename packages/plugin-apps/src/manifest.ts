// packages/plugin-apps/src/manifest.ts
// plugin-apps 插件：Keymaster 内部 app launcher。
//
// 设计缘由（施工单 2026-06-29 002 硬切换）：
//   - 注册 `/apps` 页面 + 菜单入口 + 首页 widget；
//   - 点击 `Open App` 时调用 `protocol.service.launchAppView(...)`；
//   - 插件自身**不**直接 import `protocolStorageDb` /
//     `buildAppBootstrapPayload` / `installLauncherBootstrapRegistry` /
//     `window.open` popup URL——这些细节全部收口在 service 内部。
//   - 依赖 `route.registry` / `menu.registry` / `home.registry` /
//     `protocol.service`。
//   - 元数据走 `business`：plugin-apps 是面向用户的 launcher 入口，**不**是
//     core 平台能力；缺省启用、可被禁用。

import type {
  HomeRegistry,
  HomeWidget,
  I18nPluginResources,
  MenuItem,
  MenuRegistry,
  PluginManifest,
  RouteRegistry
} from "@keymaster/contracts";
import { AppsHomeWidget } from "./AppsHomeWidget.js";
import { AppsPage } from "./AppsPage.js";

const appsResources: I18nPluginResources = {
  namespace: "apps",
  resources: {
    en: {
      "apps.route.label": "Apps",
      "apps.menu.label": "Apps",
      "apps.page.title": "Apps",
      "apps.page.description": "Open an app to start a Keymaster Session Window.",
      "apps.page.backToHome": "Back to home",
      "apps.page.empty.title": "No apps yet",
      "apps.page.empty.description": "Apps registered in the catalog will appear here.",
      "apps.open.cta": "Open App",
      "apps.open.launching": "Opening…",
      "apps.invalid.unnamed": "(invalid app)",
      "apps.invalid.duplicate": "Duplicate id, ignored.",
      "apps.invalid.configError": "Configuration error: ",
      // 启动失败的 user-facing 文案（与 LaunchAppViewError.code 一一对应）。
      "apps.open.error.vaultLocked":
        "Please unlock Keymaster first, then try again.",
      "apps.open.error.noActiveKey":
        "No ready owner key is available. Please create or import one first.",
      "apps.open.error.invalidAppConfig":
        "This app's configuration is invalid. Please contact the app provider.",
      "apps.open.error.windowUnavailable":
        "This browser environment cannot open the app.",
      "apps.open.error.sessionStorageUnavailable":
        "Keymaster local storage is unavailable. Please try again later.",
      "apps.open.error.exportUnlockRuntimeFailed":
        "Failed to prepare the secure handoff. Please try again.",
      "apps.open.error.openSessionWindowFailed":
        "Failed to open the Session Window. Please try again.",
      "apps.open.error.openSessionWindowBlocked":
        "The browser blocked opening the Session Window. Please allow popups for Keymaster and try again.",
      "apps.open.error.internal":
        "Failed to open the app. Please try again.",
      "apps.widget.title": "Apps",
      "apps.widget.empty": "No apps registered yet.",
      "apps.widget.viewAll": "View all apps"
    },
    "zh-CN": {
      "apps.route.label": "应用",
      "apps.menu.label": "应用",
      "apps.page.title": "应用",
      "apps.page.description": "打开应用以启动 Keymaster Session Window。",
      "apps.page.backToHome": "返回首页",
      "apps.page.empty.title": "还没有应用",
      "apps.page.empty.description": "在清单中注册的应用会显示在这里。",
      "apps.open.cta": "打开 App",
      "apps.open.launching": "正在打开…",
      "apps.invalid.unnamed": "（非法应用）",
      "apps.invalid.duplicate": "id 重复，已忽略。",
      "apps.invalid.configError": "配置错误：",
      "apps.open.error.vaultLocked": "请先解锁 Keymaster，然后再试一次。",
      "apps.open.error.noActiveKey": "没有可用的 owner key。请先创建或导入一把。",
      "apps.open.error.invalidAppConfig": "该应用配置非法，请联系应用提供方。",
      "apps.open.error.windowUnavailable": "当前浏览器环境无法打开该应用。",
      "apps.open.error.sessionStorageUnavailable": "Keymaster 本地存储不可用，请稍后再试。",
      "apps.open.error.exportUnlockRuntimeFailed": "安全交接准备失败，请稍后再试。",
      "apps.open.error.openSessionWindowFailed": "打开 Session Window 失败，请稍后再试。",
      "apps.open.error.openSessionWindowBlocked": "浏览器拦截了 Session Window 的打开。请允许 Keymaster 弹出窗口后再试一次。",
      "apps.open.error.internal": "打开应用失败，请稍后再试。",
      "apps.widget.title": "应用",
      "apps.widget.empty": "尚未注册应用。",
      "apps.widget.viewAll": "查看所有应用"
    }
  }
};

export const appsPlugin: PluginManifest = {
  id: "apps",
  name: "Apps",
  description: "Keymaster 内部 app launcher：从本地 JSON 清单展示 app，并在当前 Keymaster 窗口作为 launcher 启动 appView。",
  meta: {
    kind: "business",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "business"
  },
  i18n: appsResources,
  dependencies: [
    { capability: "route.registry", reason: "注册 /apps 页面" },
    { capability: "menu.registry", reason: "注册 Apps 菜单入口" },
    { capability: "home.registry", reason: "注册首页 Apps widget" },
    { capability: "protocol.service", reason: "调用 launchAppView 启动 appView" }
  ],
  setup(ctx) {
    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "apps.page",
      path: "/apps",
      label: { key: "apps.route.label", fallback: "Apps" },
      component: AppsPage,
      inMenu: true,
      menuGroup: "apps",
      order: 50,
      icon: "Apps"
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const item: MenuItem = {
      id: "menu.apps",
      label: { key: "apps.menu.label", fallback: "Apps" },
      routeId: "apps.page",
      group: "apps",
      order: 50,
      icon: "Apps"
    };
    menus.register(item);

    const home = ctx.get<HomeRegistry>("home.registry");
    const widget: HomeWidget = {
      id: "apps.home",
      title: { key: "apps.widget.title", fallback: "Apps" },
      component: AppsHomeWidget,
      order: 60,
      slot: "main",
      refreshHint: "manual"
    };
    home.register(widget);

    return () => {
      // host teardown 时清空 route / menu / home；具体 unregister 接口由
      // host 提供（plugin-apps 不持有反向引用）。teardown 走空实现。
    };
  }
};
