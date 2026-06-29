// packages/plugin-collectible-transfer/src/manifest.ts
// collectible transfer 平台壳：注册 /collectibles/transfer。
//
// 设计缘由：
//   - 平台只做路由 + handler 选择 + widget 挂载；不解释 outpoint /
//     raw tx / 手续费 / 脚本。
//   - 现有 transfer.registry 仍只服务 coin / 现有转账平台；collectible
//     transfer 走自己的 collectible-transfer.registry。
//   - phase 1 不要求首批具体 handler 插件落地；本平台在 handler 为 0 时
//     显示可理解空态，不白屏。

import type {
  AppRoute,
  CollectibleRegistry,
  CollectibleTransferRegistry,
  I18nPluginResources,
  PluginManifest,
  RouteRegistry
} from "@keymaster/contracts";
import { CollectibleTransferPage } from "./CollectibleTransferPage.js";

const collectibleTransferResources: I18nPluginResources = {
  namespace: "collectible-transfer",
  resources: {
    en: {
      "collectibleTransfer.route.transfer": "Transfer collectible",
      "collectibleTransfer.page.title": "Transfer collectible",
      "collectibleTransfer.page.loading": "Loading…",
      "collectibleTransfer.page.empty.title": "No transfer handler available",
      "collectibleTransfer.page.empty.desc": "This collectible currently has no transfer handler registered. Install a provider-specific collectible transfer handler to enable transfer.",
      "collectibleTransfer.page.invalid.title": "Cannot start transfer",
      "collectibleTransfer.page.invalid.desc": "Missing providerId/collectibleId parameter.",
      "collectibleTransfer.page.notFound.title": "Collectible not found",
      "collectibleTransfer.page.notFound.desc": "The requested collectible could not be loaded."
    },
    "zh-CN": {
      "collectibleTransfer.route.transfer": "转移藏品",
      "collectibleTransfer.page.title": "转移藏品",
      "collectibleTransfer.page.loading": "正在加载…",
      "collectibleTransfer.page.empty.title": "暂无可用转移处理器",
      "collectibleTransfer.page.empty.desc": "当前藏品没有可用的转移处理器；请安装对应协议的转移 handler 插件。",
      "collectibleTransfer.page.invalid.title": "无法开始转移",
      "collectibleTransfer.page.invalid.desc": "缺少 providerId/collectibleId 参数。",
      "collectibleTransfer.page.notFound.title": "藏品未找到",
      "collectibleTransfer.page.notFound.desc": "无法加载请求的藏品。"
    }
  }
};

export const collectibleTransferPlugin: PluginManifest = {
  id: "collectible-transfer",
  name: "Collectible transfer",
  description: "collectible transfer 平台壳：路由 /collectibles/transfer，按 collectible-transfer.registry 选择 handler 并挂载 widget；不做 outpoint / raw tx 解释。",
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "platform"
  },
  i18n: collectibleTransferResources,
  dependencies: [
    { capability: "collectible.registry", reason: "读 collectible 详情" },
    { capability: "collectible-transfer.registry", reason: "选择 handler" },
    { capability: "route.registry", reason: "注册 /collectibles/transfer 路由" }
  ],
  setup(ctx) {
    const collectibles = ctx.get<CollectibleRegistry>("collectible.registry");
    const transferRegistry = ctx.get<CollectibleTransferRegistry>("collectible-transfer.registry");

    const routes = ctx.get<RouteRegistry>("route.registry");
    const route: AppRoute = {
      id: "collectibles.transfer",
      path: "/collectibles/transfer",
      label: { key: "collectibleTransfer.route.transfer", fallback: "Transfer collectible" },
      component: CollectibleTransferPage,
      inMenu: false
    };
    routes.register(route);

    void collectibles;
    void transferRegistry;
    return () => {
      // route 由 host 回收。
    };
  }
};