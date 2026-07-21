// packages/plugin-assets/src/manifest.ts
// 资产平台插件：注册资产列表页、菜单、首页 widget。
// 设计缘由：plugin-assets 是资产平台，不注册任何具体资产；
// 具体资产（plugin-p2pkh 等）通过 asset.registry 注入 AssetProvider。

import type {
  AssetDataNotifier,
  AssetRegistry,
  KeyspaceService,
  KeyIdentity,
  I18nPluginResources,
  PluginManifest,
  ResourceRegistry,
  TokenRegistry
} from "@keymaster/contracts";
import {
  ASSET_DATA_NOTIFIER_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY
} from "@keymaster/contracts";
import { AssetsPage } from "./AssetsPage.js";
import { AssetDetailRedirect } from "./AssetDetailRedirect.js";
import { AssetDetailPage, type HoldingResolution } from "./AssetDetailPage.js";
import { AssetsHomeWidget } from "./AssetsHomeWidget.js";
import {
  loadAllHoldings,
  toHoldingRows,
  type HoldingRow,
  type HoldingsLoadResult
} from "./holdingsFlow.js";

/** 资产 i18n 资源：覆盖 route / menu / home widget 展示以及通用资产页公共文案。 */
const assetsResources: I18nPluginResources = {
  namespace: "assets",
  resources: {
    en: {
      "assets.domain.label": "Wallet",
      "assets.route.list": "Asset overview",
      "assets.route.detail": "Asset detail",
      "assets.menu.list": "Asset overview",
      "assets.home.overview": "Asset overview",
      "assets.page.title": "Assets",
      "assets.page.description": "Cross-provider aggregation.",
      "assets.page.descriptionPrefix": "Cross-provider aggregation · ",
      "assets.page.loading": "Loading…",
      "assets.page.empty.providers.title": "No asset providers yet",
      "assets.page.empty.providers.desc": "Install at least one asset provider (e.g. plugin-p2pkh) for entries to appear.",
      "assets.page.empty.assets.title": "No assets yet",
      "assets.page.empty.assets.desc": "After importing or unlocking a wallet, assets will appear here.",
      "assets.page.error.load": " failed to load: ",
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
      "assets.domain.label": "钱包",
      "assets.route.list": "资产总览",
      "assets.route.detail": "资产详情",
      "assets.menu.list": "资产总览",
      "assets.home.overview": "资产总览",
      "assets.page.title": "资产",
      "assets.page.description": "跨 provider 聚合展示。",
      "assets.page.descriptionPrefix": "跨 provider 聚合展示 · ",
      "assets.page.loading": "正在加载…",
      "assets.page.empty.providers.title": "暂无资产 provider",
      "assets.page.empty.providers.desc": "安装至少一个资产 provider（例如 plugin-p2pkh）后这里会出现选项。",
      "assets.page.empty.assets.title": "暂无资产",
      "assets.page.empty.assets.desc": "导入或解锁钱包后这里会显示资产。",
      "assets.page.error.load": " 加载失败：",
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
  description: "统一持仓平台：聚合 AssetProvider（coin）与 TokenProvider（fungible token），提供 /assets 持仓列表与首页 widget。collectible 由 plugin-collectibles 单独承接。",
  meta: {
    kind: "platform",
    startup: "optional",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "platform"
  },
  i18n: assetsResources,
  dependencies: [
    { capability: "asset.registry", reason: "需要资产注册表来聚合 coin provider" },
    { capability: "token.registry", reason: "需要 token 注册表来聚合 fungible token provider" },
    { capability: "keyspace.service", reason: "读取 active key 上下文" },
  ],
  business: {
    domains: [{ id: "assets", label: { key: "assets.domain.label", fallback: "Wallet" }, order: 200, features: [
      {
        id: "assets.holdings",
        label: { key: "assets.route.list", fallback: "Asset overview" },
        order: 5, icon: "Layers", views: [{ id: "assets.detail", path: "/assets/detail", label: { key: "assets.route.detail", fallback: "Asset detail" }, component: AssetDetailRedirect }], entry: { path: "/assets", component: AssetsPage, visibleWhen: ({ unlocked }) => unlocked },
        home: [{ id: "assets.overview", space: { id: "assets.portfolio", label: { key: "assets.domain.label", fallback: "Wallet" }, order: 200 }, order: 5, component: AssetsHomeWidget }]
      }
    ], }]
  },
  setup(ctx) {
    const assets = ctx.get<AssetRegistry>("asset.registry");
    const tokens = ctx.get<TokenRegistry>("token.registry");
    const resources = ctx.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY);
    const notifier = ctx.get<AssetDataNotifier>(ASSET_DATA_NOTIFIER_CAPABILITY);

    //注册 holdings 资源
    //设计缘由：holdings 是资产页面的核心数据依赖，使用resource 实现：
    // - 请求去重（StrictMode双挂载）
    // - 失效批处理（microtask合并）
    // - 语义相等判断
    // - active key切换时自动隔离
    resources.register<HoldingsLoadResult, readonly string[]>({
      id: "assets.holdings",
      scope: "active-key",
      key: (_args, context) => ["assets.holdings", context.activePublicKeyHex ?? "none"],
      load: async (_args, _context, _signal) => {
        return loadAllHoldings(assets, tokens);
      },
      subscribe: (_args, _context, invalidate) => {
        return notifier.subscribe(() => {
          invalidate();
        });
      },
      equals: (prev, next) => {
        // 语义相等：比较 provider 级别的结果
        if (!prev || !next) return prev === next;
        if (prev.assets.length !== next.assets.length) return false;
        if (prev.tokens.length !== next.tokens.length) return false;
        // 简化比较：检查每个 provider的结果是否相同
        for (let i = 0; i < prev.assets.length; i++) {
          const a = prev.assets[i];
          const b = next.assets[i];
          if (!a || !b) return a === b;
          if (a.provider.id !== b.provider.id) return false;
          if (a.assets.length !== b.assets.length) return false;
          if (a.error !== b.error) return false;
        }
        for (let i = 0; i < prev.tokens.length; i++) {
          const a = prev.tokens[i];
          const b = next.tokens[i];
          if (!a || !b) return a === b;
          if (a.provider.id !== b.provider.id) return false;
          if (a.tokens.length !== b.tokens.length) return false;
          if (a.error !== b.error) return false;
        }
        return true;
      },
      invalidation: "microtask"
    });

    resources.register<KeyIdentity | null, readonly string[]>({
      id: "assets.active-context",
      scope: "active-key",
      key: (_args, context) => ["assets.active-context", context.activePublicKeyHex ?? "none"],
      load: async (_args, context) => {
        const keyspace = context.getCapability<KeyspaceService>("keyspace.service");
        if (!context.activePublicKeyHex || !keyspace) return null;
        return (await keyspace.getKey(context.activePublicKeyHex)) ?? null;
      },
      subscribe: (_args, context, invalidate) =>
        context.getCapability<KeyspaceService>("keyspace.service")?.onActiveKeyChanged(invalidate) ?? (() => {}),
      equals: (a, b) => a?.publicKeyHex === b?.publicKeyHex && a?.label === b?.label,
      invalidation: "immediate"
    });

    resources.register<HoldingResolution, readonly string[]>({
      id: "assets.detail",
      scope: "global",
      key: (args) => ["assets.detail", args[0] ?? "", args[1] ?? ""],
      load: async (args) => {
        const providerId = args[0] ?? "";
        const assetId = args[1] ?? "";
        const assetProvider = assets.get(providerId);
        if (assetProvider) {
          const detail = await assetProvider.getAsset(assetId);
          if (!detail) throw new Error(`Asset "${assetId}" not found in provider "${providerId}"`);
          return { kind: "asset", provider: { id: assetProvider.id, name: assetProvider.name }, detail: detail as unknown as HoldingResolution["detail"], detailRoute: detail.summary.detailRoute };
        }
        const tokenProvider = tokens.get(providerId);
        if (tokenProvider) {
          const detail = await tokenProvider.getToken(assetId);
          if (!detail) throw new Error(`Token "${assetId}" not found in provider "${providerId}"`);
          return { kind: "token", provider: { id: tokenProvider.id, name: tokenProvider.name }, detail: detail as unknown as HoldingResolution["detail"], detailRoute: detail.summary.detailRoute };
        }
        throw new Error(`Unknown holding provider "${providerId}"`);
      },
      subscribe: (args, _context, invalidate) => {
        const providerId = args[0] ?? "";
        const provider = assets.get(providerId) ?? tokens.get(providerId);
        return provider?.onChange(invalidate) ?? (() => {});
      },
      invalidation: "immediate"
    });

    void assets;
    void tokens;
    return () => {
      // no-op：assets 平台不持有后台资源；route / menu / home widget 由 host 回收。
    };
  }
};
