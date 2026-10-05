import { requireUnlockedWalletIdentity } from "@keymaster/contracts";
import { createElement } from "react";
import { createInstanceRegistryService } from "@keymaster/runtime";
import { ASSET_DATA_NOTIFIER_CAPABILITY, ASSET_REGISTRY_CAPABILITY, TOKEN_REGISTRY_CAPABILITY, COLLECTIBLE_REGISTRY_CAPABILITY, COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, P2PKH_SETTINGS_READER_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, BSV_PRICE_READER_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY, I18N_SERVICE_CAPABILITY, defineRuntimeUnitDependencies, type PluginManifest, type PluginSetup, type KeyIdentity } from "@keymaster/contracts";
import { createAssetRegistry } from "./registries/assetRegistry.js";
import { createTokenRegistry } from "./registries/tokenRegistry.js";
import { createAssetDataNotifier } from "./assetDataNotifier.js";
import { AssetsPage, AssetDetailRedirect } from "./AssetsPage.js";
import { AssetsHomeWidget } from "./AssetsHomeWidget.js";
import { AssetsResourceProvider } from "./AssetsResourceContext.js";
import { assetsResources } from "./assetsResources.js";
import { loadAllHoldings } from "./holdingsFlow.js";
const assetsPluginDefinition = {
 id: "assets", name: "Assets", description: "Owns asset and token catalogs, holdings aggregation and their UI.",
 units: [{ id: "assets.window", runtime: "window-main", scopeKind: "root", provides: [ASSET_DATA_NOTIFIER_CAPABILITY, ASSET_REGISTRY_CAPABILITY, TOKEN_REGISTRY_CAPABILITY],
 dependencies: defineRuntimeUnitDependencies([{ capability: VAULT_WALLET_STATE_CAPABILITY }, { capability: RESOURCE_REGISTRY_CAPABILITY }, { capability: OWNED_RESOURCE_ACCESS_CAPABILITY }, { capability: I18N_SERVICE_CAPABILITY }, { capability: PAGE_UI_REGISTRY_CAPABILITY }, { capability: BUSINESS_REGISTRY_CAPABILITY }, { capability: P2PKH_SETTINGS_READER_CAPABILITY, optional: true }, { capability: BSV_PRICE_READER_CAPABILITY, optional: true }]) }], i18n: assetsResources,
} satisfies PluginManifest;
export const assetsPlugin = assetsPluginDefinition;
export const assetsSetup: PluginSetup = ctx => {
 ctx.provide(ASSET_REGISTRY_CAPABILITY, createInstanceRegistryService(createAssetRegistry(), ASSET_REGISTRY_CAPABILITY, undefined, ctx.scope));
 ctx.provide(TOKEN_REGISTRY_CAPABILITY, createInstanceRegistryService(createTokenRegistry(), TOKEN_REGISTRY_CAPABILITY, undefined, ctx.scope));
 ctx.provide(ASSET_DATA_NOTIFIER_CAPABILITY, createAssetDataNotifier());
 const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
  const assets = ctx.capability(ASSET_REGISTRY_CAPABILITY);
  const walletState = ctx.capability(VAULT_WALLET_STATE_CAPABILITY).bind(ctx.consumer, ctx.scope);
  const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
  const tokens = ctx.capability(TOKEN_REGISTRY_CAPABILITY);
  const notifier = ctx.capability(ASSET_DATA_NOTIFIER_CAPABILITY);
  ctx.capability(RESOURCE_REGISTRY_CAPABILITY).register({ id: "assets.holdings", scope: "active-key",
    key: (_args, context) => ["assets.holdings", context.activePublicKeyHex ?? "none"],
    load: () => loadAllHoldings(assets, tokens),
    subscribe: (_args, _context, invalidate) => notifier.subscribe(invalidate), invalidation: "microtask",
  });
  resources.register<KeyIdentity | null, readonly string[]>({
    id: "assets.active-context",
    scope: "active-key",
    key: (_args, context) => ["assets.active-context", context.activePublicKeyHex ?? "none"],
    load: async (_args, context) => {
      if (!context.activePublicKeyHex) return null;
      // 单 Key 本地钱包：activePublicKeyHex 就是当前唯一 Key，身份由
      // walletState 直接投影；锁定/未初始化时取不到，返回 null。
      if (context.activePublicKeyHex.toLowerCase() !== walletState.snapshot().activePublicKeyHex?.toLowerCase()) {
        return null;
      }
      try {
        return requireUnlockedWalletIdentity(walletState.snapshot());
      } catch {
        return null;
      }
    },
    subscribe: (_args, _context, invalidate) => walletState.subscribe(invalidate),
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

  business.registerFeature("assets", "assets", {
    id: "assets.holdings",
    label: { key: "assets.route.list", fallback: "Asset overview" },
    order: 5,
    icon: "Layers",
    entry: { path: "/assets", routeId: "assets.page", visibleWhen: ({ unlocked }) => unlocked, activeWhen: (path) => path.startsWith("/assets/") }
  });
  resources.register({ id: "assets.testnet", scope: "global", key: () => ["assets.testnet"],
    load: async () => ({ includeTestnet: ctx.consumer.optionalCapability(P2PKH_SETTINGS_READER_CAPABILITY)?.includeTestnet() ?? false }),
    subscribe: (_args, _context, invalidate) => {
      let offSettings = () => {};
      const bind = () => { offSettings(); offSettings = ctx.consumer.optionalCapability(P2PKH_SETTINGS_READER_CAPABILITY)?.onChange(invalidate) ?? (() => {}); };
      bind(); const offConsumer = ctx.consumer.subscribe(() => { bind(); invalidate(); });
      return () => { offConsumer(); offSettings(); };
    }, invalidation: "immediate",
  });
  const reader = ctx.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(ctx.consumer, ctx.scope);
  const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope);
  pages.view.register({ id: "assets.page", kind: "page", path: "/assets", label: { key: "assets.route.list", fallback: "Asset overview" },
    render: () => createElement(AssetsResourceProvider, { reader, children: createElement(AssetsPage) }),
  });
  pages.view.register({ id: "assets.detail.route", kind: "page", path: "/assets/detail", label: { key: "assets.route.detail", fallback: "Asset detail" },
    render: location => createElement(AssetsResourceProvider, { reader, children: createElement(AssetDetailRedirect, { location }) }),
  });
  pages.view.register({ kind: "home", id: "assets.overview", label: { key: "assets.home.overview", fallback: "Asset overview" }, order: 5, slot: "aside", render: () => createElement(AssetsHomeWidget, { reader }) });
};
