// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createPluginHost } from "@keymaster/runtime";
import type { BusinessFeatureRegistry, RouteRegistry } from "@keymaster/contracts";
import { registerP2pkhNavigation } from "./P2pkhNavigation.js";

function setup(includeTestnet: boolean, initialPath = "/p2pkh/mainnet/transactions") {
  window.history.replaceState({}, "", initialPath);
  const host = createPluginHost({ disableConfigPersistence: true });
  const routes = host.capabilities.get<RouteRegistry>("route.registry");
  const business = host.capabilities.get<BusinessFeatureRegistry>("business.registry");
  if (!routes || !business) throw new Error("Host registries are unavailable");
  business.register("shell", { id: "assets", label: { key: "assets", fallback: "Assets" }, order: 1, features: [] });
  let onSettingsChange: ((include: boolean) => void) | undefined;
  const pushedPaths: string[] = [];
  const dispose = registerP2pkhNavigation({
    routes,
    business,
    includeTestnet,
    onIncludeTestnetChange(handler) {
      onSettingsChange = handler;
      return () => { onSettingsChange = undefined; };
    },
    router: {
      currentPath: () => window.location.pathname,
      push: (path) => { pushedPaths.push(path); window.history.replaceState({}, "", path); }
    }
  });
  return { routes, business, setIncludeTestnet: (value: boolean) => onSettingsChange?.(value), pushedPaths, dispose };
}

describe("P2PKH navigation registration", () => {
  it("registers exactly four formal list routes when testnet is enabled", () => {
    const { routes, dispose } = setup(true);
    expect(routes.list().map((route) => route.path).sort()).toEqual([
      "/p2pkh/mainnet/local-transactions",
      "/p2pkh/mainnet/transactions",
      "/p2pkh/testnet/local-transactions",
      "/p2pkh/testnet/transactions"
    ]);
    expect(routes.list().some((route) => ["/p2pkh", "/p2pkh/mainnet", "/p2pkh/testnet", "/p2pkh/history", "/p2pkh/utxos"].includes(route.path))).toBe(false);
    expect(routes.list().some((route) => ["p2pkh.overview", "p2pkh.mainnet", "p2pkh.testnet", "p2pkh.history", "p2pkh.utxos"].includes(route.id))).toBe(false);
    dispose();
  });

  it("adds and removes both testnet list routes with a dynamic includeTestnet change", () => {
    const navigation = setup(false);
    expect(navigation.routes.list().map((route) => route.path)).toEqual([
      "/p2pkh/mainnet/transactions",
      "/p2pkh/mainnet/local-transactions"
    ]);
    navigation.setIncludeTestnet(true);
    expect(navigation.routes.byPath("/p2pkh/testnet/transactions")).toBeTruthy();
    expect(navigation.routes.byPath("/p2pkh/testnet/local-transactions")).toBeTruthy();
    window.history.replaceState({}, "", "/p2pkh/testnet/local-transactions?page=3");
    navigation.setIncludeTestnet(false);
    expect(navigation.routes.byPath("/p2pkh/testnet/transactions")).toBeUndefined();
    expect(navigation.routes.byPath("/p2pkh/testnet/local-transactions")).toBeUndefined();
    expect(navigation.pushedPaths).toEqual(["/p2pkh/mainnet/transactions"]);
    navigation.dispose();
  });

  it("closes a testnet detail page when includeTestnet is dynamically disabled", () => {
    const navigation = setup(true);
    window.history.replaceState({}, "", "/p2pkh/tx/abc?network=test&page=9&source=local-transactions");
    navigation.setIncludeTestnet(false);
    expect(navigation.routes.byPath("/p2pkh/testnet/transactions")).toBeUndefined();
    expect(navigation.routes.byPath("/p2pkh/testnet/local-transactions")).toBeUndefined();
    expect(navigation.pushedPaths).toEqual(["/p2pkh/mainnet/transactions"]);
    navigation.dispose();
  });

  it("registers two mutually exclusive menus and activates the source menu on detail", () => {
    const { business, dispose } = setup(true);
    const features = business.listFeatures();
    expect(features.map((feature) => [feature.id, feature.label]).map(([id, label]) => [id, (label as { fallback: string }).fallback])).toEqual([
      ["assets.p2pkh.transactions", "On-chain transactions"],
      ["assets.p2pkh.local-transactions", "Local transactions"]
    ]);
    const transactions = features.find((feature) => feature.id === "assets.p2pkh.transactions")!;
    const localTransactions = features.find((feature) => feature.id === "assets.p2pkh.local-transactions")!;
    expect(transactions.entry.path).toBe("/p2pkh/mainnet/transactions");
    expect(localTransactions.entry.path).toBe("/p2pkh/mainnet/local-transactions");
    expect(transactions.entry.activeWhen?.("/p2pkh/mainnet/transactions")).toBe(true);
    expect(localTransactions.entry.activeWhen?.("/p2pkh/mainnet/transactions")).toBe(false);
    window.history.replaceState({}, "", "/p2pkh/tx/abc?network=main&source=local-transactions");
    expect(transactions.entry.activeWhen?.("/p2pkh/tx/abc")).toBe(false);
    expect(localTransactions.entry.activeWhen?.("/p2pkh/tx/abc")).toBe(true);
    for (const source of ["", "invalid", "transactions"]) {
      window.history.replaceState({}, "", `/p2pkh/tx/abc?network=main${source ? `&source=${source}` : ""}`);
      expect(transactions.entry.activeWhen?.("/p2pkh/tx/abc")).toBe(true);
      expect(localTransactions.entry.activeWhen?.("/p2pkh/tx/abc")).toBe(false);
    }
    dispose();
  });
});
