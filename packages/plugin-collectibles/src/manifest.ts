// packages/plugin-collectibles/src/manifest.ts
// collectible 平台插件：注册 /collectibles 列表页、/collectibles/detail
// 详情页、菜单入口。
//
// 设计缘由：
//   - collectible 不进入统一持仓页（/assets），围绕单件对象展开（preview
//     / media / attributes / owner / activity），与 coin/token 余额语义
//     完全不同。
//   - 详情入口优先由 collectible provider 声明 detailRoute；未声明时由
//     通用详情页接管。
//   - "转移"入口仅在 collectible-transfer.registry 至少有一个 supports
//     handler 时显示，否则不渲染该按钮，避免诱导用户进入空态页面。

import type {
  AppRoute,
  CollectibleRegistry,
  CollectibleTransferRegistry,
  I18nPluginResources,
  MenuItem,
  MenuRegistry,
  PluginManifest,
  RouteRegistry
} from "@keymaster/contracts";
import { CollectiblesPage } from "./CollectiblesPage.js";
import { CollectibleDetailPage } from "./CollectibleDetailPage.js";

const collectiblesResources: I18nPluginResources = {
  namespace: "collectibles",
  resources: {
    en: {
      "collectibles.route.list": "Collectibles",
      "collectibles.route.detail": "Collectible detail",
      "collectibles.menu.list": "Collectibles",
      "collectibles.page.title": "Collectibles",
      "collectibles.page.loading": "Loading…",
      "collectibles.page.empty.providers.title": "No collectible providers yet",
      "collectibles.page.empty.providers.desc": "Install at least one collectible provider (e.g. plugin-collectible-1satordinals) for entries to appear.",
      "collectibles.page.empty.items.title": "No collectibles yet",
      "collectibles.page.empty.items.desc": "After importing or unlocking a wallet, collectibles held by the active key will appear here.",
      "collectibles.page.error.load": " failed to load: ",
      "collectibles.page.refresh": "Refresh",
      "collectibles.card.previewMissing": "No preview",
      "collectibles.detail.title": "Collectible detail",
      "collectibles.detail.loading": "Loading…",
      "collectibles.detail.notFound": "Cannot display collectible",
      "collectibles.detail.previewMissing": "No preview available",
      "collectibles.detail.attributes": "Attributes",
      "collectibles.detail.activity": "Activity",
      "collectibles.detail.activityEmpty": "No activities yet",
      "collectibles.detail.transfer": "Transfer",
      "collectibles.detail.transferUnavailable": "Transfer unavailable",
      "collectibles.redirect.missing": "Missing providerId/collectibleId parameter."
    },
    "zh-CN": {
      "collectibles.route.list": "藏品",
      "collectibles.route.detail": "藏品详情",
      "collectibles.menu.list": "藏品",
      "collectibles.page.title": "藏品",
      "collectibles.page.loading": "正在加载…",
      "collectibles.page.empty.providers.title": "暂无 collectible provider",
      "collectibles.page.empty.providers.desc": "安装至少一个 collectible provider（例如 plugin-collectible-1satordinals）后这里会出现选项。",
      "collectibles.page.empty.items.title": "暂无藏品",
      "collectibles.page.empty.items.desc": "导入或解锁钱包后，当前 key 持有的藏品会出现在这里。",
      "collectibles.page.error.load": " 加载失败：",
      "collectibles.page.refresh": "刷新",
      "collectibles.card.previewMissing": "暂无预览",
      "collectibles.detail.title": "藏品详情",
      "collectibles.detail.loading": "正在加载…",
      "collectibles.detail.notFound": "无法显示藏品",
      "collectibles.detail.previewMissing": "暂无预览",
      "collectibles.detail.attributes": "属性",
      "collectibles.detail.activity": "活动",
      "collectibles.detail.activityEmpty": "暂无活动",
      "collectibles.detail.transfer": "转移",
      "collectibles.detail.transferUnavailable": "暂无可用转移处理器",
      "collectibles.redirect.missing": "缺少 providerId/collectibleId 参数。"
    }
  }
};

export const collectiblesPlugin: PluginManifest = {
  id: "collectibles",
  name: "Collectibles",
  description: "collectible 平台：聚合 CollectibleProvider，提供 /collectibles 列表与通用详情页；collectible transfer 由 plugin-collectible-transfer 单独承接。",
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "platform"
  },
  i18n: collectiblesResources,
  dependencies: [
    { capability: "collectible.registry", reason: "聚合 collectible provider 列表" },
    { capability: "collectible-transfer.registry", reason: "在详情页判断转移入口是否可用" },
    { capability: "route.registry", reason: "注册 collectible 列表与详情页" },
    { capability: "menu.registry", reason: "注册 collectible 菜单入口" }
  ],
  setup(ctx) {
    const collectibles = ctx.get<CollectibleRegistry>("collectible.registry");
    const transferRegistry = ctx.get<CollectibleTransferRegistry>("collectible-transfer.registry");

    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "collectibles.list",
      path: "/collectibles",
      label: { key: "collectibles.route.list", fallback: "Collectibles" },
      component: CollectiblesPage,
      inMenu: true,
      menuGroup: "wallets",
      order: 6,
      icon: "Package"
    });
    routes.register({
      id: "collectibles.detail",
      path: "/collectibles/detail",
      label: { key: "collectibles.route.detail", fallback: "Collectible detail" },
      component: CollectibleDetailPage,
      inMenu: false
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    menus.register({
      id: "menu.collectibles",
      label: { key: "collectibles.menu.list", fallback: "Collectibles" },
      routeId: "collectibles.list",
      group: "wallets",
      order: 6,
      icon: "Package",
      visibleWhen: ({ unlocked }) => unlocked
    });

    void collectibles;
    void transferRegistry;
    return () => {
      // no-op：route / menu 由 host 回收。
    };
  }
};