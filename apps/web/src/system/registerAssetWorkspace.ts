import type {
  AssetDataNotifier,
  AssetRegistry,
  BusinessFeatureRegistry,
  BusinessDomain,
  CollectibleRegistry,
  CollectibleTransferRegistry,
  ActiveKeyState,
  HomeRegistry,
  I18nPluginResources,
  KeyIdentity,
  KeyspaceService,
  ResourceRegistry,
  RouteRegistry,
  TokenRegistry,
  TransferOffer,
  TransferRegistry
} from "@keymaster/contracts";
import { ASSET_DATA_NOTIFIER_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import type { PluginHost } from "@keymaster/runtime";
import { AssetsPage, AssetDetailRedirect, AssetsHomeWidget } from "./assets.js";
import { loadAllHoldings, type HoldingRowsResult as HoldingsLoadResult } from "./assets/holdingsFlow.js";
import { CollectiblesPage, CollectibleDetailPage } from "./collectibles.js";
import { TransferPage } from "./transfer.js";
import { createTransferFeatureCapability } from "./transfer/transferFeature.js";
import { CollectibleTransferPage } from "./collectibleTransfer.js";
import { router } from "@keymaster/runtime";
import type { CollectibleSummary } from "@keymaster/contracts";

const assetsResources: I18nPluginResources = {
  namespace: "assets",
  resources: {
    en: {
      "assets.domain.label": "Wallet",
      "assets.route.list": "Asset overview",
      "assets.route.detail": "Asset detail",
      "assets.menu.list": "Asset overview",
      "assets.home.overview": "Asset overview",
      "assets.redirect.missing": "Missing providerId/assetId parameter.",
      "assets.context.noKey": "No key",
      "assets.context.unnamed": "Unnamed",
      "assets.network.main": "Mainnet",
      "assets.network.test": "Testnet",
      "assets.observation.confirmed": "WOC confirmed",
      "assets.observation.unconfirmed": "WOC observed (unconfirmed)",
      "assets.page.eyebrow": "Asset workspace",
      "assets.page.title": "Assets",
      "assets.page.lede.mainnet": "View coins, tokens, and sync status aggregated by provider for your current key. Mainnet only is shown.",
      "assets.page.lede.testnet": "View coins, tokens, and sync status aggregated by provider for your current key. Mainnet and testnet are shown separately.",
      "assets.page.scope.main": "Mainnet only",
      "assets.page.scope.dual": "Mainnet + testnet",
      "assets.page.refresh": "Refresh",
      "assets.page.stats": "Summary",
      "assets.page.stats.assets": "Assets",
      "assets.page.stats.tokens": "Tokens",
      "assets.page.stats.ready": "Ready",
      "assets.page.empty.providers.title": "No asset providers",
      "assets.page.assets.desc": "Coins and provider-specific assets.",
      "assets.page.provider.empty": "No items yet.",
      "assets.page.tokens.title": "Tokens",
      "assets.page.tokens.desc": "BSV-21 and other token providers.",
      "assets.status.ready": "Ready",
      "assets.status.syncing": "Syncing",
      "assets.status.stale": "Stale",
      "assets.status.failed": "Failed",
      "assets.status.unsupported": "Unsupported"
    },
    "zh-CN": {
      "assets.domain.label": "钱包",
      "assets.route.list": "资产总览",
      "assets.route.detail": "资产详情",
      "assets.menu.list": "资产总览",
      "assets.home.overview": "资产总览",
      "assets.redirect.missing": "缺少 providerId/assetId 参数。",
      "assets.context.noKey": "无 key",
      "assets.context.unnamed": "未命名",
      "assets.network.main": "主网",
      "assets.network.test": "测试网",
      "assets.observation.confirmed": "WOC 已确认",
      "assets.observation.unconfirmed": "WOC 已观察（未确认）",
      "assets.page.eyebrow": "资产工作区",
      "assets.page.title": "资产",
      "assets.page.lede.mainnet": "按 provider 聚合展示当前 key 下的 coin、token 与同步状态。当前只显示主网。",
      "assets.page.lede.testnet": "按 provider 聚合展示当前 key 下的 coin、token 与同步状态。主网和测试网会分开展示。",
      "assets.page.scope.main": "仅主网",
      "assets.page.scope.dual": "主网 + 测试网",
      "assets.page.refresh": "刷新",
      "assets.page.stats": "汇总",
      "assets.page.stats.assets": "资产",
      "assets.page.stats.tokens": "代币",
      "assets.page.stats.ready": "就绪",
      "assets.page.empty.providers.title": "暂无资产 provider",
      "assets.page.assets.desc": "Coin 与各 provider 提供的资产。",
      "assets.page.provider.empty": "暂无条目。",
      "assets.page.tokens.title": "代币",
      "assets.page.tokens.desc": "BSV-21 及其他代币 provider。",
      "assets.status.ready": "就绪",
      "assets.status.syncing": "同步中",
      "assets.status.stale": "已过期",
      "assets.status.failed": "失败",
      "assets.status.unsupported": "不支持"
    }
  }
};

const collectiblesResources: I18nPluginResources = {
  namespace: "collectibles",
  resources: {
    en: {
      "collectibles.route.list": "Collectibles",
      "collectibles.route.detail": "Collectible detail",
      "collectibles.menu.list": "Collectibles",
      "collectibles.redirect.missing": "Missing providerId/collectibleId parameter.",
      "collectibles.network.main": "Mainnet",
      "collectibles.network.test": "Testnet",
      "collectibles.observation.confirmed": "WOC confirmed",
      "collectibles.observation.unconfirmed": "WOC observed (unconfirmed)",
      "collectibles.page.eyebrow": "Collectible workspace",
      "collectibles.page.title": "Collectibles",
      "collectibles.page.lede.mainnet": "Browse individual collectibles by provider. Mainnet only is shown.",
      "collectibles.page.lede.testnet": "Browse individual collectibles by provider. Mainnet and testnet are shown separately.",
      "collectibles.page.scope.main": "Mainnet only",
      "collectibles.page.scope.dual": "Mainnet + testnet",
      "collectibles.page.mint": "Create collectible",
      "collectibles.page.stats": "Summary",
      "collectibles.page.stats.providers": "Providers",
      "collectibles.page.stats.items": "Items",
      "collectibles.page.stats.ready": "Ready",
      "collectibles.page.empty.providers.title": "No collectible providers",
      "collectibles.page.providers.title": "Providers",
      "collectibles.page.providers.desc": "Each provider keeps its own registry and status.",
      "collectibles.page.provider.empty": "No items yet.",
      "collectibles.status.ready": "Ready",
      "collectibles.status.syncing": "Syncing",
      "collectibles.status.stale": "Stale",
      "collectibles.status.failed": "Failed",
      "collectibles.status.unsupported": "Unsupported",
      "collectibles.detail.transfer": "Transfer"
    },
    "zh-CN": {
      "collectibles.route.list": "藏品",
      "collectibles.route.detail": "藏品详情",
      "collectibles.menu.list": "藏品",
      "collectibles.redirect.missing": "缺少 providerId/collectibleId 参数。",
      "collectibles.network.main": "主网",
      "collectibles.network.test": "测试网",
      "collectibles.observation.confirmed": "WOC 已确认",
      "collectibles.observation.unconfirmed": "WOC 已观察（未确认）",
      "collectibles.page.eyebrow": "藏品工作区",
      "collectibles.page.title": "藏品",
      "collectibles.page.lede.mainnet": "按 provider 浏览单件藏品。当前只显示主网。",
      "collectibles.page.lede.testnet": "按 provider 浏览单件藏品。主网和测试网会分开展示。",
      "collectibles.page.scope.main": "仅主网",
      "collectibles.page.scope.dual": "主网 + 测试网",
      "collectibles.page.mint": "创建藏品",
      "collectibles.page.stats": "汇总",
      "collectibles.page.stats.providers": "Provider",
      "collectibles.page.stats.items": "条目",
      "collectibles.page.stats.ready": "就绪",
      "collectibles.page.empty.providers.title": "暂无藏品 provider",
      "collectibles.page.providers.title": "Provider",
      "collectibles.page.providers.desc": "每个 provider 都维护自己的注册表和状态。",
      "collectibles.page.provider.empty": "暂无条目。",
      "collectibles.status.ready": "就绪",
      "collectibles.status.syncing": "同步中",
      "collectibles.status.stale": "已过期",
      "collectibles.status.failed": "失败",
      "collectibles.status.unsupported": "不支持",
      "collectibles.detail.transfer": "转移"
    }
  }
};

const transferResources: I18nPluginResources = {
  namespace: "transfer",
  resources: {
    en: {
      "transfer.route.title": "Transfer",
      "transfer.menu.title": "Transfer",
      "transfer.crumb.wallet": "Wallets",
      "transfer.crumb.title": "Transfer",
      "transfer.action.toContact": "Transfer",
      "transfer.observation.confirmed": "WOC confirmed",
      "transfer.observation.unconfirmed": "WOC observed (unconfirmed)",
      "transfer.page.assets": "Assets",
      "transfer.section.collectibles": "Collectibles",
      "transfer.page.empty.noKey.title": "No key yet",
      "transfer.page.empty.noProvider.title": "No provider"
    },
    "zh-CN": {
      "transfer.route.title": "转账",
      "transfer.menu.title": "转账",
      "transfer.crumb.wallet": "钱包",
      "transfer.crumb.title": "转账",
      "transfer.action.toContact": "转账",
      "transfer.observation.confirmed": "WOC 已确认",
      "transfer.observation.unconfirmed": "WOC 已观察（未确认）",
      "transfer.page.assets": "资产",
      "transfer.section.collectibles": "藏品",
      "transfer.page.empty.noKey.title": "还没有 key",
      "transfer.page.empty.noProvider.title": "没有 provider"
    }
  }
};

const collectibleTransferResources: I18nPluginResources = {
  namespace: "collectibleTransfer",
  resources: {
    en: {
      "collectibleTransfer.route.transfer": "Transfer collectible",
      "collectibleTransfer.page.title": "Transfer collectible",
      "collectibleTransfer.page.invalid.title": "Cannot start transfer",
      "collectibleTransfer.page.invalid.desc": "Missing providerId/collectibleId parameter.",
      "collectibleTransfer.observation.confirmed": "WOC confirmed",
      "collectibleTransfer.observation.unconfirmed": "WOC observed (unconfirmed)",
      "collectibleTransfer.page.invalidRecipient": "The contact transfer target is invalid",
      "collectibleTransfer.page.loading": "Loading…",
      "collectibleTransfer.page.error.title": "Failed to load collectible",
      "collectibleTransfer.page.missing.title": "This collectible is unavailable",
      "collectibleTransfer.page.missing.desc": "WOC's final state removed it from current holdings. Return and choose another item.",
      "collectibleTransfer.page.empty.title": "No transfer handler available"
    },
    "zh-CN": {
      "collectibleTransfer.route.transfer": "转移藏品",
      "collectibleTransfer.page.title": "转移藏品",
      "collectibleTransfer.page.invalid.title": "无法开始转移",
      "collectibleTransfer.page.invalid.desc": "缺少 providerId/collectibleId 参数。",
      "collectibleTransfer.observation.confirmed": "WOC 已确认",
      "collectibleTransfer.observation.unconfirmed": "WOC 已观察（未确认）",
      "collectibleTransfer.page.invalidRecipient": "联系人转账目标无效",
      "collectibleTransfer.page.loading": "正在加载…",
      "collectibleTransfer.page.error.title": "载入藏品失败",
      "collectibleTransfer.page.missing.title": "该藏品已不可用",
      "collectibleTransfer.page.missing.desc": "WOC 最终状态已将其从当前持仓中移除，请返回后重新选择。",
      "collectibleTransfer.page.empty.title": "暂无可用转移处理器"
    }
  }
};

function get<T>(host: PluginHost, capability: string): T {
  return host.capabilities.get<T>(capability);
}

function registerAssetsWorkspace(host: PluginHost): void {
  host.i18n.registerResources("assets", assetsResources);
  const assets = get<AssetRegistry>(host, "asset.registry");
  const tokens = get<TokenRegistry>(host, "token.registry");
  const keyspace = get<KeyspaceService>(host, "keyspace.service");
  const resources = get<ResourceRegistry>(host, RESOURCE_REGISTRY_CAPABILITY);
  const notifier = get<AssetDataNotifier>(host, ASSET_DATA_NOTIFIER_CAPABILITY);
  const routes = get<RouteRegistry>(host, "route.registry");
  const business = get<BusinessFeatureRegistry>(host, "business.registry");
  const home = get<HomeRegistry>(host, "home.registry");

  const assetsDomain: BusinessDomain = {
    id: "assets",
    label: { key: "assets.domain.label", fallback: "Wallet" },
    order: 20,
    features: []
  };
  business.register("asset-workspace", assetsDomain);

  resources.register<HoldingsLoadResult, readonly string[]>({
    id: "assets.holdings",
    scope: "active-key",
    key: (_args, context) => ["assets.holdings", context.activePublicKeyHex ?? "none"],
    load: async () => loadAllHoldings(assets, tokens),
    subscribe: (_args, _context, invalidate) => notifier.subscribe(invalidate),
    invalidation: "microtask"
  });

  resources.register<KeyIdentity | null, readonly string[]>({
    id: "assets.active-context",
    scope: "active-key",
    key: (_args, context) => ["assets.active-context", context.activePublicKeyHex ?? "none"],
    load: async (_args, context) => {
      if (!context.activePublicKeyHex) return null;
      return (await keyspace.getKey(context.activePublicKeyHex)) ?? null;
    },
    subscribe: (_args, _context, invalidate) => keyspace.onActiveKeyChanged(invalidate),
    equals: (a, b) => a?.publicKeyHex === b?.publicKeyHex && a?.label === b?.label,
    invalidation: "immediate"
  });

  resources.register({
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
        return { kind: "asset", provider: { id: assetProvider.id, name: assetProvider.name }, detail, detailRoute: detail.summary.detailRoute };
      }
      const tokenProvider = tokens.get(providerId);
      if (tokenProvider) {
        const detail = await tokenProvider.getToken(assetId);
        if (!detail) throw new Error(`Token "${assetId}" not found in provider "${providerId}"`);
        return { kind: "token", provider: { id: tokenProvider.id, name: tokenProvider.name }, detail, detailRoute: detail.summary.detailRoute };
      }
      throw new Error(`Unknown holding provider "${providerId}"`);
    },
    subscribe: (args, _context, invalidate) => {
      const providerId = args[0] ?? "";
      return assets.get(providerId)?.onChange(invalidate) ?? tokens.get(providerId)?.onChange(invalidate) ?? (() => {});
    },
    invalidation: "immediate"
  });

  routes.register({ id: "assets.page", path: "/assets", label: { key: "assets.route.list", fallback: "Asset overview" }, component: AssetsPage });
  routes.register({ id: "assets.detail.route", path: "/assets/detail", label: { key: "assets.route.detail", fallback: "Asset detail" }, component: AssetDetailRedirect });
  business.registerFeature("assets", "assets", {
    id: "assets.holdings",
    label: { key: "assets.route.list", fallback: "Asset overview" },
    order: 5,
    icon: "Layers",
    entry: { path: "/assets", routeId: "assets.page", visibleWhen: ({ unlocked }) => unlocked, activeWhen: (path) => path.startsWith("/assets/") }
  });
  home.register({ id: "assets.overview", title: { key: "assets.home.overview", fallback: "Asset overview" }, component: AssetsHomeWidget, order: 5, slot: "aside", refreshHint: "realtime" });
}

function registerCollectiblesWorkspace(host: PluginHost): void {
  host.i18n.registerResources("collectibles", collectiblesResources);
  const collectibles = get<CollectibleRegistry>(host, "collectible.registry");
  const transferRegistry = get<CollectibleTransferRegistry>(host, "collectible-transfer.registry");
  const resources = get<ResourceRegistry>(host, RESOURCE_REGISTRY_CAPABILITY);
  const routes = get<RouteRegistry>(host, "route.registry");
  const business = get<BusinessFeatureRegistry>(host, "business.registry");

  resources.register({
    id: "collectibles.list",
    scope: "global",
    key: () => ["collectibles.list"],
    load: async () => Promise.all(collectibles.list().map(async (provider) => {
      try {
        return { provider, items: await provider.listCollectibles() };
      } catch (error) {
        return { provider, items: [], error: error instanceof Error ? error.message : String(error) };
      }
    })),
    subscribe: (_args, _context, invalidate) => {
      const offs = collectibles.list().map((provider) => provider.onChange(invalidate));
      return () => { for (const off of offs) off(); };
    },
    invalidation: "immediate"
  });

  routes.register({ id: "collectibles.page", path: "/collectibles", label: { key: "collectibles.route.list", fallback: "Collectibles" }, component: CollectiblesPage });
  routes.register({ id: "collectibles.detail.route", path: "/collectibles/detail", label: { key: "collectibles.route.detail", fallback: "Collectible detail" }, component: CollectibleDetailPage });
  business.registerFeature("collectibles", "assets", {
    id: "assets.collectibles",
    label: { key: "collectibles.menu.list", fallback: "Collectibles" },
    order: 10,
    icon: "Package",
    entry: { path: "/collectibles", routeId: "collectibles.page", visibleWhen: ({ unlocked }) => unlocked, activeWhen: (path) => path.startsWith("/collectibles/") }
  });
  void transferRegistry;
}

function registerTransferWorkspace(host: PluginHost): void {
  host.i18n.registerResources("transfer", transferResources);
  host.provide("feature.transfer", createTransferFeatureCapability());
  const registry = get<TransferRegistry>(host, "transfer.registry");
  const collectibles = get<CollectibleRegistry>(host, "collectible.registry");
  const collectibleTransfers = get<CollectibleTransferRegistry>(host, "collectible-transfer.registry");
  const keyspace = get<KeyspaceService>(host, "keyspace.service");
  const resources = get<ResourceRegistry>(host, RESOURCE_REGISTRY_CAPABILITY);
  const routes = get<RouteRegistry>(host, "route.registry");
  const business = get<BusinessFeatureRegistry>(host, "business.registry");

  resources.register<ActiveKeyState, readonly string[]>({
    id: "transfer.active-key",
    scope: "global",
    key: () => ["transfer.active-key"],
    load: async () => keyspace.active(),
    subscribe: (_args, _context, invalidate) => keyspace.onActiveKeyChanged(invalidate),
    equals: (a, b) => a?.activePublicKeyHex === b?.activePublicKeyHex,
    invalidation: "immediate"
  });

  resources.register<Array<{ providerId: string; items: CollectibleSummary[]; error?: string }>, readonly string[]>({
    id: "transfer.recipient-collectibles",
    scope: "active-key",
    key: (_args, context) => ["transfer.recipient-collectibles", context.activePublicKeyHex ?? "none"],
    load: async (_args, context) => {
      if (!context.activePublicKeyHex) return [];
      return Promise.all(collectibles.list().map(async (provider) => {
        try {
          const items = await provider.listCollectibles();
          return {
            providerId: provider.id,
            items: items.filter((item) => collectibleTransfers.listSupporting({ providerId: provider.id, collectibleId: item.collectibleId }).length > 0)
          };
        } catch (error) {
          return { providerId: provider.id, items: [], error: error instanceof Error ? error.message : String(error) };
        }
      }));
    },
    subscribe: (_args, _context, invalidate) => {
      const offs = collectibles.list().map((provider) => provider.onChange(invalidate));
      const offKey = keyspace.onActiveKeyChanged(invalidate);
      return () => { for (const off of offs) off(); offKey(); };
    },
    invalidation: "immediate"
  });

  resources.register<TransferOffer[], readonly string[]>({
    id: "transfer.offers",
    scope: "global",
    key: () => ["transfer.offers"],
    load: async () => {
      const out: TransferOffer[] = [];
      for (const provider of registry.list()) {
        try { out.push(...await provider.listOffers()); } catch { /* ignore */ }
      }
      return out;
    },
    subscribe: (_args, _context, invalidate) => {
      const offs = registry.list().map((provider) => provider.onChange(invalidate));
      return () => { for (const off of offs) off(); };
    },
    invalidation: "immediate"
  });

  routes.register({ id: "transfer.page", path: "/transfer", label: { key: "transfer.route.title", fallback: "Transfer" }, component: TransferPage });
  business.registerFeature("transfer", "assets", {
    id: "assets.transfer",
    label: { key: "transfer.menu.title", fallback: "Transfer" },
    order: 20,
    icon: "Send",
    entry: { path: "/transfer", routeId: "transfer.page", visibleWhen: ({ unlocked }) => unlocked }
  });

  const contactActions = get<import("@keymaster/contracts").ContactPublicKeyActionRegistry>(host, "contacts.public-key-action.registry");
  contactActions.register({
    id: "transfer.to-contact",
    label: { key: "transfer.action.toContact", fallback: "Transfer" },
    icon: "Send",
    order: 10,
    run: ({ publicKeyHex }) => router.push(`/transfer?recipientPublicKeyHex=${encodeURIComponent(publicKeyHex)}`)
  });
}

function registerCollectibleTransferWorkspace(host: PluginHost): void {
  host.i18n.registerResources("collectibleTransfer", collectibleTransferResources);
  const routes = get<RouteRegistry>(host, "route.registry");
  routes.register({ id: "collectibles.transfer", path: "/collectibles/transfer", label: { key: "collectibleTransfer.route.transfer", fallback: "Transfer collectible" }, component: CollectibleTransferPage });
}

export async function registerAssetWorkspace(host: PluginHost): Promise<void> {
  registerAssetsWorkspace(host);
  registerCollectiblesWorkspace(host);
  registerCollectibleTransferWorkspace(host);
  registerTransferWorkspace(host);
}
