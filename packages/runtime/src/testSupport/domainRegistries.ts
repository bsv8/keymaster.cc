import { createRouteRegistry } from "./registries/routeRegistry.js";
import { createBreadcrumbRegistry } from "./registries/breadcrumbRegistry.js";
import { createSettingsRegistry } from "./registries/settingsRegistry.js";
import { createVaultSettingsRegistry } from "./registries/vaultSettingsRegistry.js";
import { createHomeRegistry } from "./registries/homeRegistry.js";
import { createBusinessFeatureRegistry } from "./registries/businessFeatureRegistry.js";
import { createCommandRegistry } from "./registries/commandRegistry.js";
import { createTransferRegistry } from "./registries/transferRegistry.js";
import { createContactPublicKeyActionRegistry } from "./registries/contactPublicKeyActionRegistry.js";
import { createAssetRegistry } from "./registries/assetRegistry.js";
import { createTokenRegistry } from "./registries/tokenRegistry.js";
import { createCollectibleRegistry } from "./registries/collectibleRegistry.js";
import { createCollectibleTransferRegistry } from "./registries/collectibleTransferRegistry.js";
import { createProtectedOutpointRegistry } from "./registries/protectedOutpointRegistry.js";
import { createTopbarRegistry } from "./registries/topbarRegistry.js";
import { createNoticeRegistry } from "./registries/noticeRegistry.js";
import type { NoticeRegistry } from "@keymaster/contracts";
import { ASSET_DATA_NOTIFIER_CAPABILITY, TOPBAR_REGISTRY_CAPABILITY } from "@keymaster/contracts";

import type { AssetDataNotifier, AssetDataInvalidationEvent } from "@keymaster/contracts";
const TOPBAR_REGISTRY_KEY = TOPBAR_REGISTRY_CAPABILITY.id;
function createAssetDataNotifier(): AssetDataNotifier {
  const listeners = new Set<(event: AssetDataInvalidationEvent) => void>();
  const pending = new Map<string, AssetDataInvalidationEvent>();
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    const events = [...pending.values()];
    pending.clear();
    for (const event of events) {
      for (const listener of [...listeners]) {
        try { listener(event); } catch { /* 观察者不能改变失效结果。 */ }
      }
    }
  };
  return {
    emit(event) {
      const key = `${event.providerId}:${event.publicKeyHex ?? "none"}`;
      const previous = pending.get(key);
      pending.set(key, previous ? {
        ...previous,
        kinds: [...new Set([...previous.kinds, ...event.kinds])],
        revision: Math.max(previous.revision, event.revision),
        ...(previous.utxoSeqs || event.utxoSeqs ? {
          utxoSeqs: {
            ...(previous.utxoSeqs?.main !== undefined || event.utxoSeqs?.main !== undefined
              ? { main: Math.max(previous.utxoSeqs?.main ?? 0, event.utxoSeqs?.main ?? 0) }
              : {}),
            ...(previous.utxoSeqs?.test !== undefined || event.utxoSeqs?.test !== undefined
              ? { test: Math.max(previous.utxoSeqs?.test ?? 0, event.utxoSeqs?.test ?? 0) }
              : {}),
          },
        } : {}),
      } : event);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 创建延迟模块 K-V 句柄；领域 authority 仍在最终 I/O 边界复核绑定。 */
export function createKeymasterCapabilities(): {
  capabilities: Record<string, unknown>;
  routes: import("./registries/routeRegistry.js").RouteRegistry;
  breadcrumbs: import("./registries/breadcrumbRegistry.js").BreadcrumbRegistry;
  settings: import("./registries/settingsRegistry.js").SettingsRegistry;
  vaultSettings: import("./registries/vaultSettingsRegistry.js").VaultSettingsRegistry;
  home: import("./registries/homeRegistry.js").HomeRegistry;
  business: import("./registries/businessFeatureRegistry.js").BusinessFeatureRegistry;
  commands: import("./registries/commandRegistry.js").CommandRegistry;
  transfers: import("./registries/transferRegistry.js").TransferRegistry;
  contactPublicKeyActions: ReturnType<typeof createContactPublicKeyActionRegistry>;
  assets: import("./registries/assetRegistry.js").AssetRegistry;
  tokens: import("./registries/tokenRegistry.js").TokenRegistry;
  collectibles: import("./registries/collectibleRegistry.js").CollectibleRegistry;
  collectibleTransfer: import("./registries/collectibleTransferRegistry.js").CollectibleTransferRegistry;
  protectedOutpoints: import("./registries/protectedOutpointRegistry.js").ProtectedOutpointRegistry;
  topbar: import("./registries/topbarRegistry.js").TopbarRegistry;
  notice: NoticeRegistry;
  assetDataNotifier: AssetDataNotifier;
} {
  const routes = createRouteRegistry();
  const breadcrumbs = createBreadcrumbRegistry();
  const settings = createSettingsRegistry();
  settings.setRoutePathProbe(path => routes.byPath(path) !== undefined);
  const vaultSettings = createVaultSettingsRegistry();
  const home = createHomeRegistry();
  const business = createBusinessFeatureRegistry();
  const commands = createCommandRegistry();
  const transfers = createTransferRegistry();
  const contactPublicKeyActions = createContactPublicKeyActionRegistry();
  const assets = createAssetRegistry();
  const tokens = createTokenRegistry();
  const collectibles = createCollectibleRegistry();
  const collectibleTransfer = createCollectibleTransferRegistry();
  const protectedOutpoints = createProtectedOutpointRegistry();
  const topbar = createTopbarRegistry();
  const notice = createNoticeRegistry();
  const assetDataNotifier = createAssetDataNotifier();

  const capabilities: Record<string, unknown> = {
    "route.registry": routes,
    "breadcrumb.registry": breadcrumbs,
    "settings.registry": settings,
    "vault-settings.registry": vaultSettings,
    "home.registry": home,
    "business.registry": business,
    "command.registry": commands,
    "transfer.registry": transfers,
    "contacts.public-key-action.registry": contactPublicKeyActions,
    "asset.registry": assets,
    "token.registry": tokens,
    "collectible.registry": collectibles,
    "collectible-transfer.registry": collectibleTransfer,
    "protected-outpoint.registry": protectedOutpoints,
    [TOPBAR_REGISTRY_KEY]: topbar,
    "notice.registry": notice,
    [ASSET_DATA_NOTIFIER_CAPABILITY.id]: assetDataNotifier,
  };
  return {
    capabilities,
    routes,
    breadcrumbs,
    settings,
    vaultSettings,
    home,
    business,
    commands,
    transfers,
    contactPublicKeyActions,
    assets,
    tokens,
    collectibles,
    collectibleTransfer,
    protectedOutpoints,
    topbar,
    notice,
    assetDataNotifier,
  };
}

