import { createElement } from "react";
import { bindP2pkhUi } from "../P2pkhResourceContext.js";
import type { BusinessFeatureRegistry, PageUiRegistration, PluginContext } from "@keymaster/contracts";
import { router as runtimeRouter } from "@keymaster/runtime";
import {
  P2pkhMainnetLocalTransactionsPage,
  P2pkhMainnetTransactionsPage,
  P2pkhTestnetLocalTransactionsPage,
  P2pkhTestnetTransactionsPage
} from "./P2pkhNetworkRoutes.js";
import { parseTransactionSource } from "./p2pkhTransactionView.js";

export interface P2pkhNavigationDeps {
  pages: PageUiRegistration;
  context: PluginContext;
  business: BusinessFeatureRegistry;
  includeTestnet: boolean;
  onIncludeTestnetChange(handler: (includeTestnet: boolean) => void): () => void;
  router?: Pick<typeof runtimeRouter, "currentPath" | "push">;
}

/**
 * Register the P2PKH list routes and business entries.  This is deliberately
 * the one production registration path so route/feature tests exercise the
 * same registration behavior as the plugin setup.
 */
export function registerP2pkhNavigation(deps: P2pkhNavigationDeps): () => void {
  const navigate = deps.router ?? runtimeRouter;
  const testnetRoutes = [
    {
      id: "p2pkh.testnet.transactions",
      path: "/p2pkh/testnet/transactions",
      label: { key: "p2pkh.route.transactions", fallback: "P2PKH on-chain transactions" },
      component: P2pkhTestnetTransactionsPage
    },
    {
      id: "p2pkh.testnet.local-transactions",
      path: "/p2pkh/testnet/local-transactions",
      label: { key: "p2pkh.route.localTransactions", fallback: "P2PKH local transactions" },
      component: P2pkhTestnetLocalTransactionsPage
    }
  ] as const;
  const registered = new Set<string>();
  const register = (route: (typeof testnetRoutes)[number] | { id: string; path: string; label: { key: string; fallback: string }; component: typeof P2pkhMainnetTransactionsPage }) => {
    if (registered.has(route.id)) return;
    const Component = bindP2pkhUi(deps.context, route.component);
    deps.pages.register({ kind: "page", id: route.id, path: route.path, label: route.label, render: () => createElement(Component) });
    registered.add(route.id);
  };
  const unregister = (id: string) => { if (registered.delete(id)) deps.pages.unregister(id); };
  const syncTestnetRoutes = (includeTestnet: boolean) => {
    if (includeTestnet) {
      for (const route of testnetRoutes) register(route);
      return;
    }
    for (const route of testnetRoutes) unregister(route.id);
    const currentPath = navigate.currentPath();
    const onTestnetList = currentPath === "/p2pkh/testnet/transactions" || currentPath === "/p2pkh/testnet/local-transactions";
    const onTestnetDetail = currentPath.startsWith("/p2pkh/tx/") && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("network") === "test";
    if (onTestnetList || onTestnetDetail) navigate.push("/p2pkh/mainnet/transactions");
  };

  register({
    id: "p2pkh.mainnet.transactions",
    path: "/p2pkh/mainnet/transactions",
    label: { key: "p2pkh.route.transactions", fallback: "P2PKH on-chain transactions" },
    component: P2pkhMainnetTransactionsPage
  });
  register({
    id: "p2pkh.mainnet.local-transactions",
    path: "/p2pkh/mainnet/local-transactions",
    label: { key: "p2pkh.route.localTransactions", fallback: "P2PKH local transactions" },
    component: P2pkhMainnetLocalTransactionsPage
  });
  syncTestnetRoutes(deps.includeTestnet);
  const offSettings = deps.onIncludeTestnetChange(syncTestnetRoutes);

  deps.business.registerFeature("p2pkh", "assets", {
    id: "assets.p2pkh.transactions",
    label: { key: "p2pkh.menu.transactions", fallback: "On-chain transactions" },
    order: 15,
    icon: "Wallet",
    entry: {
      path: "/p2pkh/mainnet/transactions",
      routeId: "p2pkh.mainnet.transactions",
      visibleWhen: ({ unlocked }) => unlocked,
      activeWhen: (path) => isP2pkhListOrDetailPath(path, "transactions")
    }
  });
  deps.business.registerFeature("p2pkh", "assets", {
    id: "assets.p2pkh.local-transactions",
    label: { key: "p2pkh.menu.localTransactions", fallback: "Local transactions" },
    order: 16,
    icon: "Wallet",
    entry: {
      path: "/p2pkh/mainnet/local-transactions",
      routeId: "p2pkh.mainnet.local-transactions",
      visibleWhen: ({ unlocked }) => unlocked,
      activeWhen: (path) => isP2pkhListOrDetailPath(path, "local-transactions")
    }
  });

  return () => {
    offSettings();
    for (const id of [...registered]) unregister(id);
  };
}

function isP2pkhListOrDetailPath(path: string, source: "transactions" | "local-transactions"): boolean {
  if (path === `/p2pkh/mainnet/${source}` || path === `/p2pkh/testnet/${source}`) return true;
  if (!path.startsWith("/p2pkh/tx/")) return false;
  if (typeof window === "undefined") return false;
  return parseTransactionSource(window.location.search) === source;
}
