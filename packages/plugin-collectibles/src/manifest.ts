import { createElement } from "react";
import { createInstanceRegistryService } from "@keymaster/runtime";
import { ASSET_DATA_NOTIFIER_CAPABILITY, ASSET_REGISTRY_CAPABILITY, TOKEN_REGISTRY_CAPABILITY, COLLECTIBLE_REGISTRY_CAPABILITY, COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, P2PKH_SETTINGS_READER_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, BSV_PRICE_READER_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY, I18N_SERVICE_CAPABILITY, defineRuntimeUnitDependencies, type PluginManifest, type PluginSetup, type KeyIdentity } from "@keymaster/contracts";
import { createCollectibleRegistry } from "./registries/collectibleRegistry.js";
import { createCollectibleTransferRegistry } from "./registries/collectibleTransferRegistry.js";
import { CollectiblesPage, CollectibleDetailPage } from "./CollectiblesPage.js";
import { CollectibleTransferPage } from "./CollectibleTransferPage.js";
import { CollectiblesResourceProvider } from "./CollectiblesResourceContext.js";
import { collectiblesResources } from "./collectiblesResources.js";
import { collectibleTransferResources } from "./collectibleTransferResources.js";
const collectiblesPluginDefinition = {
 id: "collectibles", name: "Collectibles", description: "Owns collectible catalogs, detail and transfer UI across standards.",
 units: [{ id: "collectibles.window", runtime: "window-main", scopeKind: "root", provides: [COLLECTIBLE_REGISTRY_CAPABILITY, COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY],
 dependencies: defineRuntimeUnitDependencies([{ capability: RESOURCE_REGISTRY_CAPABILITY }, { capability: OWNED_RESOURCE_ACCESS_CAPABILITY }, { capability: I18N_SERVICE_CAPABILITY }, { capability: PAGE_UI_REGISTRY_CAPABILITY }, { capability: BUSINESS_REGISTRY_CAPABILITY }, { capability: P2PKH_SETTINGS_READER_CAPABILITY, optional: true }]) }],
 i18n: { namespace: "collectibles", resources: { en: { ...collectiblesResources.resources.en, ...collectibleTransferResources.resources.en }, "zh-CN": { ...collectiblesResources.resources["zh-CN"], ...collectibleTransferResources.resources["zh-CN"] } } },
} satisfies PluginManifest;
export const collectiblesPlugin = collectiblesPluginDefinition;
export const collectiblesSetup: PluginSetup = ctx => {
 ctx.provide(COLLECTIBLE_REGISTRY_CAPABILITY, createInstanceRegistryService(createCollectibleRegistry(), COLLECTIBLE_REGISTRY_CAPABILITY, undefined, ctx.scope));
 ctx.provide(COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY, createInstanceRegistryService(createCollectibleTransferRegistry(), COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY, undefined, ctx.scope));
 const collectibles = ctx.capability(COLLECTIBLE_REGISTRY_CAPABILITY);
 const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
 const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
  resources.register( {
    id: "collectibles.list",
    scope: "global",
    key: () => ["collectibles.list"],
    load: async () => Promise.all(collectibles.list().map(async (provider) => {
      try {
        return { provider: { id: provider.id, name: provider.name }, items: await provider.listCollectibles() };
      } catch (error) {
        return { provider: { id: provider.id, name: provider.name }, items: [], error: error instanceof Error ? error.message : String(error) };
      }
    })),
    subscribe: (_args, _context, invalidate) => {
      const offs = collectibles.list().map((provider) => provider.onChange(invalidate));
      return () => { for (const off of offs) off(); };
    },
    invalidation: "immediate"
  });

  business.registerFeature("collectibles", "assets", {
    id: "assets.collectibles",
    label: { key: "collectibles.menu.list", fallback: "Collectibles" },
    order: 10,
    icon: "Package",
    entry: { path: "/collectibles", routeId: "collectibles.page", visibleWhen: ({ unlocked }) => unlocked, activeWhen: (path) => path.startsWith("/collectibles/") }
  });
  resources.register({ id: "collectibles.testnet", scope: "global", key: () => ["collectibles.testnet"],
    load: async () => ({ includeTestnet: ctx.consumer.optionalCapability(P2PKH_SETTINGS_READER_CAPABILITY)?.includeTestnet() ?? false }),
    subscribe: (_args, _context, invalidate) => {
      let offSettings = () => {};
      const bind = () => { offSettings(); offSettings = ctx.consumer.optionalCapability(P2PKH_SETTINGS_READER_CAPABILITY)?.onChange(invalidate) ?? (() => {}); };
      bind(); const offConsumer = ctx.consumer.subscribe(() => { bind(); invalidate(); });
      return () => { offConsumer(); offSettings(); };
    }, invalidation: "immediate",
  });
  resources.register({ id: "collectible-transfer.detail", scope: "active-key",
    key: (args, context) => ["collectible-transfer.detail", context.activePublicKeyHex ?? "none", args[0] ?? "", args[1] ?? ""],
    load: async args => {
      const provider = collectibles.get(args[0] ?? "");
      if (!provider) return null;
      return { provider: { id: provider.id, name: provider.name }, detail: await provider.getCollectible(args[1] ?? "") ?? null };
    },
    subscribe: (args, _context, invalidate) => collectibles.get(args[0] ?? "")?.onChange(invalidate) ?? (() => {}), invalidation: "immediate",
  });
 const reader = ctx.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(ctx.consumer, ctx.scope);
 const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope);
  pages.view.register({ id: "collectibles.page", kind: "page", path: "/collectibles", label: { key: "collectibles.route.list", fallback: "Collectibles" },
    render: () => createElement(CollectiblesResourceProvider, { reader, children: createElement(CollectiblesPage) }),
  });
  pages.view.register({ id: "collectibles.detail.route", kind: "page", path: "/collectibles/detail", label: { key: "collectibles.route.detail", fallback: "Collectible detail" },
    render: location => createElement(CollectiblesResourceProvider, { reader, children: createElement(CollectibleDetailPage, { location }) }),
  });
  pages.view.register({ id: "collectibles.transfer", kind: "page", path: "/collectibles/transfer", label: { key: "collectibles.transfer.route.transfer", fallback: "Transfer collectible" },
    render: location => createElement(CollectiblesResourceProvider, { reader, children: createElement(CollectibleTransferPage, { location }) }),
  });
};
