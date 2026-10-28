import { createElement } from "react";
import { BUSINESS_REGISTRY_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY,
  type PluginContext, type VaultWalletState } from "@keymaster/contracts";
import { P2pkhResourceProvider } from "../P2pkhResourceContext.js";
import { P2pkhTransferPage } from "./P2pkhTransferPage.js";

export function registerP2pkhTransferUi(ctx: PluginContext, { walletState, path }: {
  walletState: VaultWalletState; path: "/transfer";
}): void {
  void walletState;
  const transferReader = ctx.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(ctx.consumer, ctx.scope);
  ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view.register({
    id: "transfer.page", kind: "page", path, label: { key: "p2pkh.transferPage.route.title", fallback: "Transfer" },
    render: location => createElement(P2pkhResourceProvider, { reader: transferReader, children: createElement(P2pkhTransferPage, { location }) }),
  });
  ctx.capability(BUSINESS_REGISTRY_CAPABILITY).registerFeature("p2pkh", "assets", { id: "assets.transfer", label: { key: "p2pkh.transferPage.menu.title", fallback: "Transfer" }, order: 20, icon: "Send",
    entry: { path, routeId: "transfer.page", visibleWhen: ({ unlocked }) => unlocked },
  });
}
