import { createElement } from "react";
import { bindP2pkhUi } from "../P2pkhResourceContext.js";
import type { BusinessFeatureRegistry, PageUiRegistration, PluginContext } from "@keymaster/contracts";
import { P2pkhWalletPage } from "./P2pkhWalletPage.js";
import { parseTransactionSource, type P2pkhWalletView } from "./p2pkhTransactionView.js";

export interface P2pkhNavigationDeps {
  pages: PageUiRegistration;
  context: PluginContext;
  business: BusinessFeatureRegistry;
}

/** Both lists belong to the current wallet; routes never select a network. */
export function registerP2pkhNavigation(deps: P2pkhNavigationDeps): () => void {
  const routes: Array<{ view: P2pkhWalletView; label: { key: string; fallback: string }; order: number }> = [
    { view: "transactions", label: { key: "p2pkh.menu.transactions", fallback: "On-chain transactions" }, order: 15 },
    { view: "local-transactions", label: { key: "p2pkh.menu.localTransactions", fallback: "Local transactions" }, order: 16 },
  ];
  for (const { view, label, order } of routes) {
    const Component = bindP2pkhUi(deps.context, () => createElement<{ view?: P2pkhWalletView }>(P2pkhWalletPage, { view }));
    const id = `p2pkh.${view}`, path = `/p2pkh/${view}`;
    deps.pages.register({ kind: "page", id, path, label, render: () => createElement(Component) });
    deps.business.registerFeature("p2pkh", "assets", {
      id: `assets.p2pkh.${view}`, label, order, icon: "Wallet",
      entry: { path, routeId: id, visibleWhen: ({ unlocked }) => unlocked, activeWhen: current => isP2pkhListOrDetailPath(current, view) },
    });
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (deps.context.scope.state !== "active") return;
    for (const { view } of routes) {
      deps.business.unregisterFeature(`assets.p2pkh.${view}`);
      deps.pages.unregister(`p2pkh.${view}`);
    }
  };
}

function isP2pkhListOrDetailPath(path: string, source: P2pkhWalletView): boolean {
  if (path === `/p2pkh/${source}`) return true;
  return path.startsWith("/p2pkh/tx/") && typeof window !== "undefined" && parseTransactionSource(window.location.search) === source;
}
