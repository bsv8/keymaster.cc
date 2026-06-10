// packages/plugin-woc/src/manifest.ts
// WOC 插件清单：注册 woc.service、设置页、路由、菜单、面包屑。
//
// 设计缘由（硬切换 008 收尾）：
//   - actor 必须挂到 runtime messageBus 才能与其它插件在同一总线上。
//   - 因此本插件显式声明对 RUNTIME_MESSAGE_BUS capability 的依赖。
//   - 业务插件仍只依赖 wocService，不再接触 messageBus。
//
// 硬切换 003：所有展示文案走 i18n。

import type {
  BreadcrumbProvider,
  BreadcrumbRegistry,
  I18nPluginResources,
  MenuItem,
  MenuRegistry,
  MessageBus,
  PluginManifest,
  RouteRegistry,
  SettingsRegistry,
  WocService
} from "@keymaster/contracts";
import { RUNTIME_MESSAGE_BUS, WOC_CAPABILITY } from "@keymaster/contracts";
import { createWocService } from "./wocService.js";
import { WocSettingsPage } from "./pages/WocSettingsPage.js";

const wocResources: I18nPluginResources = {
  namespace: "woc",
  resources: {
    en: {
      "woc.route.settings": "WOC settings",
      "woc.menu.settings": "WOC",
      "woc.settings.label": "WOC",
      "woc.settings.description": "WhatsOnChain API endpoint, rate limit, and queue status.",
      "woc.crumb.settings": "Settings",
      "woc.crumb.woc": "WOC",
      "woc.page.title": "WOC settings",
      "woc.page.desc": "Configure the WhatsOnChain endpoint and requests per second. Changes take effect immediately for new requests.",
      "woc.field.baseUrl": "WOC base URL",
      "woc.field.baseUrlDesc": "Root URL before the network path; default https://api.whatsonchain.com/v1/bsv",
      "woc.field.rps": "Requests per second",
      "woc.field.rpsDesc": "Public API recommends 2; custom proxy may allow higher.",
      "woc.action.save": "Save",
      "woc.action.reset": "Reset to default",
      "woc.action.saved": "Saved",
      "woc.status.section": "Queue status",
      "woc.status.queued": "Queued: ",
      "woc.status.inFlight": "In flight: ",
      "woc.status.lastError": "Last error: ",
      "woc.status.backoffLine": "WOC global backoff lifted at {{time}}",
      "woc.status.noBackoff": "No backoff",
      "woc.status.coordinated.ok": "Multi-tab coordination: enabled (Web Locks)",
      "woc.status.coordinated.warn": "Multi-tab coordination: disabled. The current browser does not support Web Locks, so cross-tab rate limiting cannot be guaranteed. Open only one wallet tab at a time, or switch to a Web-Locks-capable browser, to avoid triggering WOC rate limits."
    },
    "zh-CN": {
      "woc.route.settings": "WOC 设置",
      "woc.menu.settings": "WOC",
      "woc.settings.label": "WOC",
      "woc.settings.description": "WhatsOnChain API 入口、限流与队列状态。",
      "woc.crumb.settings": "设置",
      "woc.crumb.woc": "WOC",
      "woc.page.title": "WOC 设置",
      "woc.page.desc": "配置 WhatsOnChain 访问入口与每秒请求数。修改后对后续请求立即生效。",
      "woc.field.baseUrl": "WOC base URL",
      "woc.field.baseUrlDesc": "网络路径之前的根 URL；缺省 https://api.whatsonchain.com/v1/bsv",
      "woc.field.rps": "每秒请求数",
      "woc.field.rpsDesc": "公共 API 建议默认 2；自定义代理可提高。",
      "woc.action.save": "保存",
      "woc.action.reset": "恢复缺省",
      "woc.action.saved": "已保存",
      "woc.status.section": "队列状态",
      "woc.status.queued": "排队：",
      "woc.status.inFlight": "飞行中：",
      "woc.status.lastError": "最近错误：",
      "woc.status.backoffLine": "WOC 全局 backoff 解除于 {{time}}",
      "woc.status.noBackoff": "无 backoff",
      "woc.status.coordinated.ok": "多标签页协调：已启用（Web Locks）",
      "woc.status.coordinated.warn": "多标签页协调：未启用。当前浏览器不支持 Web Locks，跨标签页限流无法保证；请只开一个钱包标签页或换用支持 Web Locks 的浏览器以避免触发 WOC 限流。"
    }
  }
};

export const wocPlugin: PluginManifest = {
  id: "woc",
  name: "WOC",
  description: "WhatsOnChain API 代理：唯一 WOC 入口、全局限流、优先级队列、429 backoff、多标签页协调。",
  i18n: wocResources,
  dependencies: [
    { capability: RUNTIME_MESSAGE_BUS, reason: "注册 WOC actor handlers（target=woc）" },
    { capability: "route.registry", reason: "注册 WOC 设置页" },
    { capability: "menu.registry", reason: "注册 WOC 菜单入口" },
    { capability: "settings.registry", reason: "注册 WOC 设置页" },
    { capability: "breadcrumb.registry", reason: "注册 WOC 面包屑" }
  ],
  setup(ctx) {
    const messageBus = ctx.get<MessageBus>(RUNTIME_MESSAGE_BUS);
    const service = createWocService({ messageBus });
    ctx.provide<WocService>(WOC_CAPABILITY, service);

    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "woc.settings",
      path: "/settings/woc",
      label: { key: "woc.route.settings", fallback: "WOC settings" },
      component: WocSettingsPage,
      inMenu: false,
      menuGroup: "settings",
      order: 120,
      icon: "Cloud"
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const item: MenuItem = {
      id: "menu.woc",
      label: { key: "woc.menu.settings", fallback: "WOC" },
      routeId: "woc.settings",
      group: "settings",
      order: 120,
      icon: "Cloud",
      visibleWhen: ({ unlocked }) => unlocked
    };
    menus.register(item);

    const settings = ctx.get<SettingsRegistry>("settings.registry");
    settings.registerPage({
      id: "woc.config",
      label: { key: "woc.settings.label", fallback: "WOC" },
      description: { key: "woc.settings.description", fallback: "WhatsOnChain API endpoint, rate limit, and queue status." },
      fields: [],
      order: 20,
      component: WocSettingsPage
    });

    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    const crumbProvider: BreadcrumbProvider = {
      id: "woc.crumbs",
      order: 250,
      match: (path) => path === "/settings/woc",
      resolve: () => [
        { label: { key: "woc.crumb.settings", fallback: "Settings" }, path: "/settings" },
        { label: { key: "woc.crumb.woc", fallback: "WOC" } }
      ]
    };
    breadcrumbs.register(crumbProvider);
  }
};
