// packages/plugin-transfer/src/manifest.ts
// 转账平台：注册 /transfer 页面、菜单、面包屑。
// 设计缘由：硬切换后 Transfer 不再依赖 vault / contacts / 具体资产插件。
// 平台只列 Offer 并挂载 provider Widget。
//
// 硬切换 003：route / menu / breadcrumb 走 I18nText。

import type {
  BreadcrumbProvider,
  BreadcrumbRegistry,
  I18nPluginResources,
  MenuItem,
  MenuRegistry,
  PluginManifest,
  RouteRegistry
} from "@keymaster/contracts";
import { TransferPage } from "./TransferPage.js";

const transferResources: I18nPluginResources = {
  namespace: "transfer",
  resources: {
    en: {
      "transfer.route.title": "Transfer",
      "transfer.menu.title": "Transfer",
      "transfer.crumb.wallet": "Wallets",
      "transfer.crumb.title": "Transfer",
      "transfer.page.desc.pickKey": "Transfer requires single mode.",
      "transfer.page.desc.noKey": "No usable key yet.",
      "transfer.page.desc.noProvider": "No transfer providers yet.",
      "transfer.page.desc.default": "Pick an asset offer, then let the provider's widget handle input, preview and submission.",
      "transfer.page.assets": "Assets",
      "transfer.page.completed": "Completed",
      "transfer.page.empty.allMode.title": "Pick a key",
      "transfer.page.empty.allMode.desc": "Pick a specific key in the topbar to start a transfer.",
      "transfer.page.empty.noKey.title": "No key yet",
      "transfer.page.empty.noKey.desc": "Import or create a key before starting a transfer.",
      "transfer.page.empty.noProvider.title": "No provider",
      "transfer.page.empty.noProvider.desc": "Install at least one transfer asset provider (e.g. plugin-p2pkh) for entries to appear.",
      "transfer.page.empty.picker": "No transfer assets available.",
      "transfer.page.err.providerGone": "This offer's provider is no longer available.",
      "transfer.page.err.widget": "This provider's transfer widget errored: ",
      "transfer.page.txidPrefix": " · txid ",
      "transfer.page.completionPrefix": " · completed "
    },
    "zh-CN": {
      "transfer.route.title": "转账",
      "transfer.menu.title": "转账",
      "transfer.crumb.wallet": "钱包",
      "transfer.crumb.title": "转账",
      "transfer.page.desc.pickKey": "转账要求 single 模式。",
      "transfer.page.desc.noKey": "还没有可用的 key。",
      "transfer.page.desc.noProvider": "还没有可用的转账 provider。",
      "transfer.page.desc.default": "选择资产 Offer，然后由 provider 提供的 Widget 完成输入、预览与提交。",
      "transfer.page.assets": "资产",
      "transfer.page.completed": "已完成",
      "transfer.page.empty.allMode.title": "请选择一个 key",
      "transfer.page.empty.allMode.desc": "到顶栏选择一把具体的 key 后再开始转账。",
      "transfer.page.empty.noKey.title": "还没有 key",
      "transfer.page.empty.noKey.desc": "导入或创建一个 key 后再开始转账。",
      "transfer.page.empty.noProvider.title": "没有 provider",
      "transfer.page.empty.noProvider.desc": "安装至少一个转账资产 provider（例如 plugin-p2pkh）后这里会出现选项。",
      "transfer.page.empty.picker": "当前没有可用的转账资产。",
      "transfer.page.err.providerGone": "该 Offer 对应的 provider 不再可用。",
      "transfer.page.err.widget": "该 provider 的转移 Widget 出现错误：",
      "transfer.page.txidPrefix": " · txid ",
      "transfer.page.completionPrefix": " · 完成于 "
    }
  }
};

export const transferPlugin: PluginManifest = {
  id: "transfer",
  name: "Transfer",
  description: "转账平台：聚合 Transfer Offer 并挂载 provider Widget。",
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "platform"
  },
  i18n: transferResources,
  dependencies: [
    { capability: "transfer.registry", reason: "需要 transfer 注册表" },
    { capability: "route.registry", reason: "注册 Transfer 页面" },
    { capability: "menu.registry", reason: "注册 Transfer 菜单入口" },
    { capability: "breadcrumb.registry", reason: "注册 Transfer 面包屑" }
  ],
  setup(ctx) {
    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "transfer.page",
      path: "/transfer",
      label: { key: "transfer.route.title", fallback: "Transfer" },
      component: TransferPage,
      inMenu: true,
      menuGroup: "wallets",
      order: 30,
      icon: "Send"
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const item: MenuItem = {
      id: "menu.transfer",
      label: { key: "transfer.menu.title", fallback: "Transfer" },
      routeId: "transfer.page",
      group: "wallets",
      order: 30,
      icon: "Send",
      visibleWhen: ({ unlocked }) => unlocked
    };
    menus.register(item);

    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    const crumbProvider: BreadcrumbProvider = {
      id: "transfer.crumbs",
      order: 150,
      match: (path) => path === "/transfer",
      resolve: () => [
        { label: { key: "transfer.crumb.wallet", fallback: "Wallets" }, path: "/" },
        { label: { key: "transfer.crumb.title", fallback: "Transfer" } }
      ]
    };
    breadcrumbs.register(crumbProvider);
    return () => {
      // no-op
    };
  }
};
