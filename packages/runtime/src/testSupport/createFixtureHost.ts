import { createScopedStorageClients } from "@keymaster/platform-storage/assembly";
import type { StorageBindingAuthority } from "@keymaster/contracts/storage-internal";
import type { BusinessFeatureRegistry } from "./registries/businessFeatureRegistry.js";
import type { CommandRegistry, TransferRegistry, ContactPublicKeyActionRegistry, AssetRegistry, TopbarRegistry, NoticeRegistry, VaultSettingsRegistry } from "@keymaster/contracts";
import { coordinatorClientBindings } from "./coordinatorClientBindings.js";
import { createKeymasterPluginHost } from "../keymasterHostAdapter.js";
import { createKeymasterCapabilities } from "./domainRegistries.js";
import { createInstanceRegistryService } from "../instanceRegistry.js";
import { defineCapability } from "webloom-framework";
import type { PluginHost, CreatePluginHostOptions } from "../pluginHostContract.js";
export interface FixtureHost extends PluginHost {
  routes: import("@keymaster/contracts").RouteRegistry;
  breadcrumbs: import("@keymaster/contracts").BreadcrumbRegistry;
  settings: import("@keymaster/contracts").SettingsRegistry;
  vaultSettings: VaultSettingsRegistry;
  home: import("@keymaster/contracts").HomeRegistry;
  business: BusinessFeatureRegistry;
  commands: CommandRegistry;
  transfers: TransferRegistry;
  contactPublicKeyActions: ContactPublicKeyActionRegistry;
  assets: AssetRegistry;
  tokens: import("@keymaster/contracts").TokenRegistry;
  collectibles: import("@keymaster/contracts").CollectibleRegistry;
  collectibleTransfer: import("@keymaster/contracts").CollectibleTransferRegistry;
  protectedOutpoints: import("@keymaster/contracts").ProtectedOutpointRegistry;
  topbar: TopbarRegistry;
  notice: NoticeRegistry;
}
export function createFixtureHost(options: CreatePluginHostOptions & { storageBindingAuthority?: StorageBindingAuthority; fixtureExcludedCapabilities?: readonly string[]; coordinatorForPlugin?: (pluginId: string) => unknown } = {}) {
  const registries = createKeymasterCapabilities();
  const capabilities = Object.entries(registries.capabilities).filter(([id]) => !options.fixtureExcludedCapabilities?.includes(id)).map(([id, value]) => ({ capability: defineCapability({ kind: "local", id, version: "1" }), value: id === "asset.dataNotifier" ? value : createInstanceRegistryService(value as object, defineCapability({ kind: "local", id, version: "1" }), id === "business.registry" ? { name: id, registrations: [{ method: "register", idArgument: 1, unregisterMethod: "unregisterDomain", unregisterArgument: 0, bindPluginIdArgument: 0 }, { method: "registerFeature", idArgument: 2, unregisterMethod: "unregisterFeature", unregisterArgument: 0, bindPluginIdArgument: 0 }] } : id === "notice.registry" ? { name: id, registrations: [{ method: "upsert", idArgument: 0, unregisterMethod: "dismiss" }] } : undefined) }));
  const host: PluginHost = createKeymasterPluginHost({ ...options, capabilities: [...capabilities, ...(options.coordinatorForPlugin ? coordinatorClientBindings(options.coordinatorForPlugin) : []), ...(options.capabilities ?? []), ...(options.storageBindingAuthority ? createScopedStorageClients(options.storageBindingAuthority, id => host.getManifest(id)) : [])] });
  for (const [property, id] of Object.entries({ routes: "route.registry", breadcrumbs: "breadcrumb.registry", settings: "settings.registry", vaultSettings: "vault-settings.registry", home: "home.registry", business: "business.registry", commands: "command.registry", transfers: "transfer.registry", contactPublicKeyActions: "contacts.public-key-action.registry", assets: "asset.registry", tokens: "token.registry", collectibles: "collectible.registry", collectibleTransfer: "collectible-transfer.registry", protectedOutpoints: "protected-outpoint.registry", topbar: "topbar.registry", notice: "notice.registry" })) {
    Object.defineProperty(host, property, { enumerable: true, get: () => options.fixtureExcludedCapabilities?.includes(id) ? host.capabilities.get(defineCapability({ kind: "local", id, version: "1" })) : registries.capabilities[id] });
  }
  return host as FixtureHost;
}

export { SHELL_TEST_RESOURCES } from "./shellTestResources.js";
export { walletStateFixtureSnapshot, walletStateFixtureAccess } from "./walletStateFixture.js";
