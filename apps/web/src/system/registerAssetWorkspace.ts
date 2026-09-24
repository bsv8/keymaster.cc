import type {
  AssetDataNotifier,
  AssetRegistry,
  BusinessFeatureRegistry,
  BusinessDomain,
  ActiveKeyState,
  HomeRegistry,
  I18nPluginResources,
  KeyIdentity,
  KeyspaceService,
  ResourceRegistry,
  ResourceDefinition,
  RouteRegistry,
  TokenRegistry,
  TransferOffer,
  TransferRegistry
} from "@keymaster/contracts";
import {
  ASSET_DATA_NOTIFIER_CAPABILITY,
  ASSET_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  BREADCRUMB_REGISTRY_CAPABILITY,
  COLLECTIBLE_REGISTRY_CAPABILITY,
  COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY,
  CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY,
  HOME_REGISTRY_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  ROUTE_REGISTRY_CAPABILITY,
  TOKEN_REGISTRY_CAPABILITY,
  TRANSFER_REGISTRY_CAPABILITY,
} from "@keymaster/contracts";
import type { LocalCapability } from "webloom-framework";
import { registerKeymasterOwnedResource, router, type PluginHost } from "@keymaster/runtime";
import { AssetsPage, AssetDetailRedirect, AssetsHomeWidget } from "./assets.js";
import { loadAllHoldings, type HoldingRowsResult as HoldingsLoadResult } from "./assets/holdingsFlow.js";
import { CollectiblesPage, CollectibleDetailPage } from "./collectibles.js";
import { TransferPage } from "./transfer.js";
import { createTransferFeatureCapability, TRANSFER_FEATURE_CAPABILITY } from "./transfer/transferFeature.js";
import { CollectibleTransferPage } from "./collectibleTransfer.js";
import { BsvChainSettingsPage } from "./bsvChain.js";

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
      "assets.status.unsupported": "Unsupported",
      "assets.status.unavailable": "Wallet is locked or asset services are temporarily unavailable; unlock to restore.",
      "assets.balance.unknown": "Unknown"
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
      "assets.status.unsupported": "不支持",
      "assets.status.unavailable": "钱包已锁定或资产服务暂不可用；解锁后会自动恢复。",
      "assets.balance.unknown": "未知"
    }
  }
};

const bsvChainResources: I18nPluginResources = {
  namespace: "bsvChain",
  resources: {
    en: {
      "bsvChain.menu": "BSV Chain",
      "bsvChain.crumb.settings": "Settings",
      "bsvChain.page.title": "BSV Chain",
      "bsvChain.page.description": "Configure P2PKH network scope, fee rates, and the WOC connection.",
      "bsvChain.p2pkh": "P2PKH",
      "bsvChain.woc": "WOC"
    },
    "zh-CN": {
      "bsvChain.menu": "BSV 链",
      "bsvChain.crumb.settings": "设置",
      "bsvChain.page.title": "BSV 链",
      "bsvChain.page.description": "配置 P2PKH 网络范围、矿工费率与 WOC 连接。",
      "bsvChain.p2pkh": "P2PKH",
      "bsvChain.woc": "WOC"
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
      "transfer.page.desc.default": "Choose a recipient address, enter the amount and fee rate, then verify the read-only transfer details before submitting.",
      "transfer.page.recipient.title": "Recipient",
      "transfer.page.recipient.hint": "Search a contact or paste a compressed public key or P2PKH address.",
      "transfer.page.recipient.contacts": "From contacts",
      "transfer.page.recipient.manual": "Manual input",
      "transfer.page.recipient.publicKey": "Recipient public key",
      "transfer.page.recipient.change": "Change recipient",
      "transfer.page.recipient.placeholder": "Select a contact",
      "transfer.page.recipient.inputPlaceholder": "Paste public key, address, or search a contact",
      "transfer.page.recipient.address": "Recipient address",
      "transfer.page.recipient.copy": "Copy address",
      "transfer.page.recipient.copied": "Copied",
      "transfer.page.recipient.network": "Network",
      "transfer.page.recipient.mainnet": "Mainnet",
      "transfer.page.recipient.testnet": "Testnet",
      "transfer.page.recipient.source.contact": "Contact public-key derivation",
      "transfer.page.recipient.source.resolved": "Address matched contact",
      "transfer.page.recipient.source.manualPublicKey": "Manual public key",
      "transfer.page.recipient.source.manualAddress": "Manual address",
      "transfer.page.recipient.unknownAddress": "Unknown address",
      "transfer.page.recipient.noCodec": "The P2PKH address capability is unavailable; address lookup is disabled.",
      "transfer.page.recipient.searchHint": "Other text is searched in local contacts.",
      "transfer.page.recipient.searchEmpty": "No matching local contact.",
      "transfer.page.recipient.invalidPublicKey": "Public key must be a compressed 33-byte hex key.",
      "transfer.page.recipient.invalidAddress": "This is not a valid P2PKH address. Use the corresponding asset transfer entry.",
      "transfer.page.recipient.testnetDisabled": "Testnet is not enabled. Enable testnet in settings first.",
      "transfer.page.recipient.conflict": "The public key and address do not match; transfer is blocked.",
      "transfer.page.recipient.networkChanged": "Address updated; verify again before submitting.",
      "transfer.page.empty.noKey.title": "No key yet",
      "transfer.page.empty.noKey.desc": "Import or create a key before starting a transfer.",
      "transfer.page.empty.noProvider.title": "No provider",
      "transfer.page.empty.picker": "No ordinary BSV (P2PKH) transfer is currently available.",
      "transfer.page.invalidRecipient": "The recipient parameters are invalid.",
      "transfer.page.noRecipientProvider": "No ordinary BSV transfer is available for this network.",
      "transfer.page.clearRecipient": "Clear recipient"
    },
    "zh-CN": {
      "transfer.route.title": "转账",
      "transfer.menu.title": "转账",
      "transfer.crumb.wallet": "钱包",
      "transfer.crumb.title": "转账",
      "transfer.action.toContact": "转账",
      "transfer.observation.confirmed": "WOC 已确认",
      "transfer.observation.unconfirmed": "WOC 已观察（未确认）",
      "transfer.page.desc.default": "选择收款地址，填写金额与矿工费率，再核对只读转账信息后提交。",
      "transfer.page.recipient.title": "收款方",
      "transfer.page.recipient.hint": "搜索联系人，或粘贴压缩公钥、P2PKH 地址。",
      "transfer.page.recipient.contacts": "从通讯录选择",
      "transfer.page.recipient.manual": "手工输入",
      "transfer.page.recipient.publicKey": "收款人公钥",
      "transfer.page.recipient.change": "更换收款方",
      "transfer.page.recipient.placeholder": "选择联系人",
      "transfer.page.recipient.inputPlaceholder": "粘贴公钥、地址，或搜索联系人",
      "transfer.page.recipient.address": "收款地址",
      "transfer.page.recipient.copy": "复制地址",
      "transfer.page.recipient.copied": "已复制",
      "transfer.page.recipient.network": "网络",
      "transfer.page.recipient.mainnet": "主网",
      "transfer.page.recipient.testnet": "testnet",
      "transfer.page.recipient.source.contact": "联系人公钥派生",
      "transfer.page.recipient.source.resolved": "地址命中联系人",
      "transfer.page.recipient.source.manualPublicKey": "手工公钥",
      "transfer.page.recipient.source.manualAddress": "手工地址",
      "transfer.page.recipient.unknownAddress": "陌生地址",
      "transfer.page.recipient.noCodec": "P2PKH 地址能力不可用，地址反查已关闭。",
      "transfer.page.recipient.searchHint": "其他文本会在本地通讯录中搜索。",
      "transfer.page.recipient.searchEmpty": "没有匹配的本地联系人。",
      "transfer.page.recipient.invalidPublicKey": "公钥必须是压缩格式的 33 字节 hex 公钥。",
      "transfer.page.recipient.invalidAddress": "这不是有效的 P2PKH 地址，请从对应资产入口转账。",
      "transfer.page.recipient.testnetDisabled": "未启用 testnet，请在设置中开启。",
      "transfer.page.recipient.conflict": "公钥与地址不一致，已阻断转账。",
      "transfer.page.recipient.networkChanged": "地址已更新，请重新核对。",
      "transfer.page.empty.noKey.title": "还没有 key",
      "transfer.page.empty.noKey.desc": "导入或创建一个 key 后再开始转账。",
      "transfer.page.empty.noProvider.title": "没有 provider",
      "transfer.page.empty.picker": "当前没有可用的普通 BSV（P2PKH）转账。",
      "transfer.page.invalidRecipient": "收款方参数无效。",
      "transfer.page.noRecipientProvider": "当前网络没有可用的普通 BSV 转账。",
      "transfer.page.clearRecipient": "清除收款方"
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

function get<T>(host: PluginHost, capability: LocalCapability<T>): T {
  return host.capabilities.get(capability);
}

function registerBsvChainWorkspace(host: PluginHost): void {
  host.i18n.registerResources("bsvChain", bsvChainResources);
  const routes = get(host, ROUTE_REGISTRY_CAPABILITY);
  const business = get(host, BUSINESS_REGISTRY_CAPABILITY);
  const breadcrumbs = get(host, BREADCRUMB_REGISTRY_CAPABILITY);

  routes.register({
    id: "settings.bsv-chain",
    path: "/settings/bsv-chain",
    label: { key: "bsvChain.menu", fallback: "BSV Chain" },
    component: BsvChainSettingsPage
  });
  business.registerFeature("bsv-chain-workspace", "settings", {
    id: "settings.bsv-chain",
    label: { key: "bsvChain.menu", fallback: "BSV Chain" },
    order: 20,
    icon: "Network",
    entry: {
      path: "/settings/bsv-chain",
      routeId: "settings.bsv-chain",
      visibleWhen: ({ unlocked }) => unlocked
    }
  });
  breadcrumbs.register({
    id: "settings.bsv-chain.crumbs",
    order: 190,
    match: (path) => path === "/settings/bsv-chain",
    resolve: () => [
      { label: { key: "bsvChain.crumb.settings", fallback: "Settings" } },
      { label: { key: "bsvChain.page.title", fallback: "BSV Chain" } }
    ]
  });
}

/** 资产工作区不是独立产品插件，仍必须绑定到 owner-session 进行回收。 */
function registerWorkspaceResource<T, TArgs extends readonly string[]>(
  registry: ResourceRegistry,
  definition: ResourceDefinition<T, TArgs>,
): void {
  registerKeymasterOwnedResource(registry, "asset-workspace", definition);
}

function registerAssetsWorkspace(host: PluginHost): void {
  host.i18n.registerResources("assets", assetsResources);
  const assets = get(host, ASSET_REGISTRY_CAPABILITY);
  const tokens = get(host, TOKEN_REGISTRY_CAPABILITY);
  const keyspace = get(host, KEYSPACE_SERVICE_CAPABILITY);
  const resources = get<ResourceRegistry>(host, RESOURCE_REGISTRY_CAPABILITY);
  const notifier = get<AssetDataNotifier>(host, ASSET_DATA_NOTIFIER_CAPABILITY);
  const routes = get(host, ROUTE_REGISTRY_CAPABILITY);
  const business = get(host, BUSINESS_REGISTRY_CAPABILITY);
  const home = get(host, HOME_REGISTRY_CAPABILITY);

  const assetsDomain: BusinessDomain = {
    id: "assets",
    label: { key: "assets.domain.label", fallback: "Wallet" },
    order: 20,
    features: []
  };
  business.register("asset-workspace", assetsDomain);

  registerWorkspaceResource<HoldingsLoadResult, readonly string[]>(resources, {
    id: "assets.holdings",
    scope: "active-key",
    key: (_args, context) => ["assets.holdings", context.activePublicKeyHex ?? "none"],
    load: async () => loadAllHoldings(assets, tokens),
    subscribe: (_args, _context, invalidate) => notifier.subscribe(invalidate),
    invalidation: "microtask"
  });

  registerWorkspaceResource<KeyIdentity | null, readonly string[]>(resources, {
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

  registerWorkspaceResource(resources, {
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
  const collectibles = get(host, COLLECTIBLE_REGISTRY_CAPABILITY);
  const transferRegistry = get(host, COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY);
  const resources = get<ResourceRegistry>(host, RESOURCE_REGISTRY_CAPABILITY);
  const routes = get(host, ROUTE_REGISTRY_CAPABILITY);
  const business = get(host, BUSINESS_REGISTRY_CAPABILITY);

  registerWorkspaceResource(resources, {
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
  host.provide(TRANSFER_FEATURE_CAPABILITY, createTransferFeatureCapability());
  const registry = get(host, TRANSFER_REGISTRY_CAPABILITY);
  const keyspace = get(host, KEYSPACE_SERVICE_CAPABILITY);
  const resources = get<ResourceRegistry>(host, RESOURCE_REGISTRY_CAPABILITY);
  const routes = get(host, ROUTE_REGISTRY_CAPABILITY);
  const business = get(host, BUSINESS_REGISTRY_CAPABILITY);
  const notifier = get<AssetDataNotifier>(host, ASSET_DATA_NOTIFIER_CAPABILITY);

  registerWorkspaceResource<ActiveKeyState, readonly string[]>(resources, {
    id: "transfer.active-key",
    scope: "global",
    key: () => ["transfer.active-key"],
    load: async () => keyspace.active(),
    subscribe: (_args, _context, invalidate) => keyspace.onActiveKeyChanged(invalidate),
    equals: (a, b) => a?.activePublicKeyHex === b?.activePublicKeyHex,
    invalidation: "immediate"
  });

  registerWorkspaceResource<TransferOffer[], readonly string[]>(resources, {
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
      // Provider 自身的 onChange 只在同步状态/广播事件时触发；UTXO 快照刷新
      // 只通过 asset.data-changed 到达页面。Offer 余额同样必须跟着余额刷新，
      // 否则转账后余额会长时间停留在旧值。
      const offNotifier = notifier.subscribe(() => invalidate());
      return () => { for (const off of offs) off(); offNotifier(); };
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

  const contactActions = get(host, CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY);
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
  const routes = get(host, ROUTE_REGISTRY_CAPABILITY);
  routes.register({ id: "collectibles.transfer", path: "/collectibles/transfer", label: { key: "collectibleTransfer.route.transfer", fallback: "Transfer collectible" }, component: CollectibleTransferPage });
}

export async function registerAssetWorkspace(host: PluginHost): Promise<() => void> {
  const beforeRouteIds = new Set(host.routes._ids());
  const beforeHomeIds = new Set(host.home._ids());
  const beforeResourceIds = new Set(get<ResourceRegistry>(host, RESOURCE_REGISTRY_CAPABILITY)._ids());
  const beforeContactActionIds = new Set(host.contactPublicKeyActions._ids());
  const beforeBusiness = host.business._ids();
  const beforeBusinessDomainIds = new Set(beforeBusiness.domains);
  const beforeBusinessFeatureIds = new Set(beforeBusiness.features);
  const beforeBreadcrumbIds = new Set(host.breadcrumbs._ids());
  const hadTransferFeature = host.capabilities.has(TRANSFER_FEATURE_CAPABILITY);

  registerBsvChainWorkspace(host);
  registerAssetsWorkspace(host);
  registerCollectiblesWorkspace(host);
  registerCollectibleTransferWorkspace(host);
  registerTransferWorkspace(host);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const resources = get<ResourceRegistry>(host, RESOURCE_REGISTRY_CAPABILITY);
    // 卸载必须走正常的外部 store 通知，不能在渲染过程中 flushSync 强制
    // 卸载 React root：owner 锁定时插件 teardown 与页面渲染会重叠，
    // 同步卸载会触发 React 的嵌套更新告警和 removeChild 竞态。
    for (const id of host.business._ids().features.filter((item) => !beforeBusinessFeatureIds.has(item))) {
      host.business.unregisterFeature(id);
    }
    for (const id of host.business._ids().domains.filter((item) => !beforeBusinessDomainIds.has(item))) {
      host.business.unregisterDomain(id);
    }
    for (const id of host.routes._ids().filter((item) => !beforeRouteIds.has(item))) {
      host.routes.unregister(id);
    }
    for (const id of host.breadcrumbs._ids().filter((item) => !beforeBreadcrumbIds.has(item))) {
      host.breadcrumbs.unregister(id);
    }
    for (const id of host.home._ids().filter((item) => !beforeHomeIds.has(item))) {
      host.home.unregister(id);
    }
    for (const id of host.contactPublicKeyActions._ids().filter((item) => !beforeContactActionIds.has(item))) {
      host.contactPublicKeyActions.unregister(id);
    }
    host.resourceStore.disposeOwner("asset-workspace");
    for (const id of resources._ids().filter((item) => !beforeResourceIds.has(item))) {
      resources.unregister(id);
    }
    if (!hadTransferFeature) host.capabilities.revoke(TRANSFER_FEATURE_CAPABILITY);
    for (const pluginId of ["bsvChain", "assets", "collectibles", "collectibleTransfer", "transfer"]) {
      host.i18n.unregisterResources(pluginId);
    }
  };
}
