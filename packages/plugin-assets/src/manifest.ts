// packages/plugin-assets/src/manifest.ts
// 资产平台插件：注册资产列表页、菜单、首页 widget。
// 设计缘由：plugin-assets 是资产平台，不注册任何具体资产；
// 具体资产（plugin-p2pkh 等）通过 asset.registry 注入 AssetProvider。

import type {
  AppRoute,
  AssetRegistry,
  HomeRegistry,
  HomeWidget,
  I18nPluginResources,
  MenuItem,
  MenuRegistry,
  PluginManifest,
  RouteRegistry
} from "@keymaster/contracts";
import { AssetsPage } from "./AssetsPage.js";
import { AssetDetailRedirect } from "./AssetDetailRedirect.js";
import { AssetsHomeWidget } from "./AssetsHomeWidget.js";

/** 资产 i18n 资源：覆盖 route / menu / home widget 展示以及通用资产页公共文案。 */
const assetsResources: I18nPluginResources = {
  namespace: "assets",
  resources: {
    en: {
      "assets.route.list": "Assets",
      "assets.route.detail": "Asset detail",
      "assets.menu.list": "Assets",
      "assets.home.overview": "Assets",
      "assets.page.title": "Assets",
      "assets.page.description": "Cross-provider aggregation.",
      "assets.page.descriptionPrefix": "Cross-provider aggregation · ",
      "assets.page.loading": "Loading…",
      "assets.page.empty.providers.title": "No asset providers yet",
      "assets.page.empty.providers.desc": "Install at least one asset provider (e.g. plugin-p2pkh) for entries to appear.",
      "assets.page.empty.assets.title": "No assets yet",
      "assets.page.empty.assets.desc": "After importing or unlocking a wallet, assets will appear here.",
      "assets.page.error.load": " failed to load: ",
      "assets.page.refresh": "Refresh",
      "assets.context.noKey": "No key",
      "assets.context.loading": "Loading…",
      "assets.context.unnamed": "Unnamed",
      "assets.context.identityMissing": "Identity not available",
      "assets.table.col.name": "Name",
      "assets.table.col.kind": "Kind",
      "assets.table.col.provider": "Provider",
      "assets.table.col.network": "Network",
      "assets.table.col.balance": "Balance",
      "assets.table.col.status": "Status",
      "assets.table.col.detail": "Detail",
      "assets.table.open": "Open",
      "assets.homeWidget.refresh": "Refresh",
      "assets.homeWidget.empty": "No assets yet",
      "assets.detail.title": "Asset detail",
      "assets.detail.loading": "Loading…",
      "assets.detail.notFound": "Cannot display asset",
      "assets.detail.openSpecific": "Open dedicated view",
      "assets.detail.assetId": "Asset id: ",
      "assets.detail.balance": "Balance: ",
      "assets.detail.empty.activities": "No activities yet",
      "assets.detail.table.title": "Title",
      "assets.detail.table.txid": "txid",
      "assets.detail.table.amount": "Amount",
      "assets.detail.table.direction": "Direction",
      "assets.detail.table.status": "Status",
      "assets.detail.table.time": "Time",
      "assets.redirect.missing": "Missing providerId/assetId parameter."
    },
    "zh-CN": {
      "assets.route.list": "资产",
      "assets.route.detail": "资产详情",
      "assets.menu.list": "资产",
      "assets.home.overview": "资产",
      "assets.page.title": "资产",
      "assets.page.description": "跨 provider 聚合展示。",
      "assets.page.descriptionPrefix": "跨 provider 聚合展示 · ",
      "assets.page.loading": "正在加载…",
      "assets.page.empty.providers.title": "暂无资产 provider",
      "assets.page.empty.providers.desc": "安装至少一个资产 provider（例如 plugin-p2pkh）后这里会出现选项。",
      "assets.page.empty.assets.title": "暂无资产",
      "assets.page.empty.assets.desc": "导入或解锁钱包后这里会显示资产。",
      "assets.page.error.load": " 加载失败：",
      "assets.page.refresh": "刷新",
      "assets.context.noKey": "无 key",
      "assets.context.loading": "加载中…",
      "assets.context.unnamed": "未命名",
      "assets.context.identityMissing": "身份不可用",
      "assets.table.col.name": "名称",
      "assets.table.col.kind": "类别",
      "assets.table.col.provider": "Provider",
      "assets.table.col.network": "网络",
      "assets.table.col.balance": "余额",
      "assets.table.col.status": "状态",
      "assets.table.col.detail": "详情",
      "assets.table.open": "进入",
      "assets.homeWidget.refresh": "刷新",
      "assets.homeWidget.empty": "暂无资产",
      "assets.detail.title": "资产详情",
      "assets.detail.loading": "正在加载…",
      "assets.detail.notFound": "无法显示资产",
      "assets.detail.openSpecific": "打开专属详情",
      "assets.detail.assetId": "资产 id：",
      "assets.detail.balance": "余额：",
      "assets.detail.empty.activities": "暂无活动",
      "assets.detail.table.title": "标题",
      "assets.detail.table.txid": "txid",
      "assets.detail.table.amount": "金额",
      "assets.detail.table.direction": "方向",
      "assets.detail.table.status": "状态",
      "assets.detail.table.time": "时间",
      "assets.redirect.missing": "缺少 providerId/assetId 参数。"
    }
  }
};

export const assetsPlugin: PluginManifest = {
  id: "assets",
  name: "Assets",
  description: "资产平台：聚合所有 AssetProvider 并提供资产列表与首页 widget。",
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "platform"
  },
  i18n: assetsResources,
  dependencies: [
    { capability: "asset.registry", reason: "需要资产注册表来聚合 provider" },
    { capability: "route.registry", reason: "注册资产列表与详情页" },
    { capability: "menu.registry", reason: "注册资产菜单入口" },
    { capability: "home.registry", reason: "注册资产首页 widget" }
  ],
  setup(ctx) {
    const assets = ctx.get<AssetRegistry>("asset.registry");

    const routes = ctx.get<RouteRegistry>("route.registry");
    const listRoute: AppRoute = {
      id: "assets.list",
      path: "/assets",
      label: { key: "assets.route.list", fallback: "Assets" },
      component: AssetsPage,
      inMenu: true,
      menuGroup: "wallets",
      order: 5,
      icon: "Layers"
    };
    routes.register(listRoute);
    routes.register({
      id: "assets.detail",
      path: "/assets/detail",
      label: { key: "assets.route.detail", fallback: "Asset detail" },
      component: AssetDetailRedirect,
      inMenu: false
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const item: MenuItem = {
      id: "menu.assets",
      label: { key: "assets.menu.list", fallback: "Assets" },
      routeId: "assets.list",
      group: "wallets",
      order: 5,
      icon: "Layers",
      visibleWhen: ({ unlocked }) => unlocked
    };
    menus.register(item);

    const home = ctx.get<HomeRegistry>("home.registry");
    const widget: HomeWidget = {
      id: "assets.overview",
      title: { key: "assets.home.overview", fallback: "Assets" },
      component: AssetsHomeWidget,
      order: 5,
      slot: "main",
      refreshHint: "manual"
    };
    home.register(widget);

    void assets;
    return () => {
      // no-op：assets 平台不持有后台资源；route / menu / home widget 由 host 回收。
    };
  }
};
