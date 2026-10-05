import { createElement } from "react";
import { router } from "@keymaster/runtime";
import { BUSINESS_REGISTRY_CAPABILITY, CONTACTS_SERVICE_CAPABILITY, CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY,
  type PluginContext, type VaultWalletState, type TransferProvider, type AssetDataNotifier } from "@keymaster/contracts";
import { P2pkhResourceProvider } from "../P2pkhResourceContext.js";
import { P2pkhTransferPage } from "./P2pkhTransferPage.js";

export function registerP2pkhTransferUi(ctx: PluginContext, { walletState, transferProvider, assetDataNotifier, path }: {
  walletState: VaultWalletState; transferProvider: TransferProvider; assetDataNotifier?: AssetDataNotifier; path: "/transfer";
}): void {
  const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
  resources.register<import("@keymaster/contracts").VaultLifecycleSnapshot, readonly string[]>({ id: "p2pkh.transfer-active", scope: "active-key",
    key: (_args, context) => ["p2pkh.transfer-active", context.activePublicKeyHex ?? "none"], load: async () => walletState.snapshot(),
    subscribe: (_args, _context, invalidate) => walletState.subscribe(invalidate), invalidation: "immediate" });
  resources.register<import("@keymaster/contracts").TransferOffer[], readonly string[]>({ id: "p2pkh.transfer-offers", scope: "active-key",
    key: (_args, context) => ["p2pkh.transfer-offers", context.activePublicKeyHex ?? "none"], load: () => transferProvider.listOffers(),
    subscribe: (_args, _context, invalidate) => { const off = transferProvider.onChange(invalidate); const offNotifier = assetDataNotifier?.subscribe(invalidate); return () => { off(); offNotifier?.(); }; }, invalidation: "immediate" });
  resources.register<import("@keymaster/contracts").Contact[], readonly string[]>({ id: "p2pkh.transfer-contacts", scope: "active-key",
    key: (_args, context) => ["p2pkh.transfer-contacts", context.activePublicKeyHex ?? "none"],
    load: () => ctx.consumer.optionalCapability(CONTACTS_SERVICE_CAPABILITY)?.listContacts() ?? Promise.resolve([]),
    subscribe: (_args, _context, invalidate) => {
      let offContacts = () => {};
      const bind = () => { offContacts(); offContacts = ctx.consumer.optionalCapability(CONTACTS_SERVICE_CAPABILITY)?.onChange(invalidate) ?? (() => {}); };
      bind(); const offConsumer = ctx.consumer.subscribe(() => { bind(); invalidate(); });
      return () => { offConsumer(); offContacts(); };
    }, invalidation: "immediate" });
  const transferReader = ctx.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(ctx.consumer, ctx.scope);
  ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view.register({
    id: "transfer.page", kind: "page", path, label: { key: "p2pkh.transferPage.route.title", fallback: "Transfer" },
    render: location => createElement(P2pkhResourceProvider, { reader: transferReader, children: createElement(P2pkhTransferPage, { location }) }),
  });
  ctx.capability(BUSINESS_REGISTRY_CAPABILITY).registerFeature("p2pkh", "assets", { id: "assets.transfer", label: { key: "p2pkh.transferPage.menu.title", fallback: "Transfer" }, order: 20, icon: "Send",
    entry: { path, routeId: "transfer.page", visibleWhen: ({ unlocked }) => unlocked },
  });
  ctx.capability(CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY).register({ id: "transfer.to-contact", label: { key: "p2pkh.transferPage.action.toContact", fallback: "Transfer" }, icon: "Send", order: 10,
    run: ({ publicKeyHex }) => router.push(`${path}?recipientPublicKeyHex=${encodeURIComponent(publicKeyHex)}`),
  });

}
