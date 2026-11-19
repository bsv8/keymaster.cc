import { createElement } from "react";
import { CONNECT_APP_SOURCE_BATCH_CAPABILITY, STORAGE_FILE_CLIENTS_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, defineRuntimeUnitDependencies, type PluginContext, type PluginManifest, type PluginSetup } from "@keymaster/contracts";
import { MARKET_PRIVATE_COMMAND, MARKET_PRIVATE_EVENTS } from "./marketWorkerContract.js";
import { MARKET_STORAGE_DECLARATIONS } from "./storage/marketStorageDeclarations.js";
import { createWindowMarket } from "./windowMarket.js";
import { MarketSettingsPage } from "./MarketSettingsPage.js";
const definition = {
  id: "apps", name: "Market", description: "同步市场来源与手工来源；主数据和审批归 Connect Worker。",
  units: [{
    id: "apps.window", runtime: "window-main", scopeKind: "root",
    provides: [],
    dependencies: defineRuntimeUnitDependencies([
      { capability: PAGE_UI_REGISTRY_CAPABILITY, reason: "注册 Market 设置页" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, reason: "设置区入口" },
    ]),
  }, {
    id: "apps.coordinator-worker", runtime: "shared-worker", scopeKind: "storage",
    provides: [], privateProvides: [MARKET_PRIVATE_COMMAND, MARKET_PRIVATE_EVENTS],
    storages: [MARKET_STORAGE_DECLARATIONS.files],
    dependencies: defineRuntimeUnitDependencies([
      { capability: STORAGE_FILE_CLIENTS_CAPABILITY, sourceRuntime: "shared-worker", reason: "Market 自有存储" },
      { capability: CONNECT_APP_SOURCE_BATCH_CAPABILITY, sourceRuntime: "shared-worker", optional: true, reason: "提交已验证发布与来源失效；缺席时只记录同步失败，不阻止 Market 加载" },
    ]),
  }],
  async setup(ctx: PluginContext) {
    const market = createWindowMarket(ctx);
    const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view;
    pages.register({ kind: "page", path: "/settings/market", id: "market.settings", label: "市场来源", render: () => createElement(MarketSettingsPage, { market }) });
    ctx.capability(BUSINESS_REGISTRY_CAPABILITY).registerFeature("apps", "settings", {
      id: "settings.market", label: "市场来源", order: 40, icon: "Store", entry: { path: "/settings/market", routeId: "market.settings" },
    });
    return () => market.dispose();
  },
} satisfies PluginManifest & { setup: PluginSetup };
const { setup: marketSetup, ...marketPlugin } = definition;
export { marketPlugin, marketSetup };
