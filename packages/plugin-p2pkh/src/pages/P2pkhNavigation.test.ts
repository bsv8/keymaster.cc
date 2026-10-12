import { createFixtureHost as createPluginHost } from "@keymaster/runtime/test-support";
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createLifecycleScope } from "webloom-framework";
import { createScopedRegistryView } from "webloom-framework/advanced";

import { BUSINESS_REGISTRY_CAPABILITY, type BusinessFeatureRegistry, OWNED_RESOURCE_ACCESS_CAPABILITY, type PluginContext, type PageUiContribution } from "@keymaster/contracts";
import { registerP2pkhNavigation } from "./P2pkhNavigation.js";

function setup(bsvNetwork: boolean, initialPath = "/p2pkh/mainnet/transactions") {
  window.history.replaceState({}, "", initialPath);
  const host = createPluginHost({  });
  const entries = new Map<string, PageUiContribution>();
  const routes = { list: () => [...entries.values()].filter((e): e is Extract<PageUiContribution, { kind: "page" }> => e.kind === "page"), byPath: (path: string) => [...entries.values()].find(e => e.kind === "page" && e.path === path) };
  const scope = createLifecycleScope({ kind: "plugin-instance", metadata: { pluginId: "p2pkh" }, instanceId: "navigation-test" });
  const pageRegistry = { register: (entry: PageUiContribution) => { entries.set(entry.id, entry); }, unregister: (id: string) => { entries.delete(id); } };
  const pages = createScopedRegistryView(pageRegistry, scope, { name: "p2pkh test routes", registrations: [{ method: "register", idArgument: 0, unregisterMethod: "unregister", ownerInstanceIdProperty: "ownerInstanceId" }] }).view;
  const context = { scope, capability: () => ({ bind: () => ({}) }) } as unknown as PluginContext;
  const business = host.business as unknown as BusinessFeatureRegistry;
  if (!routes || !business) throw new Error("Host registries are unavailable");
  business.register("shell", { id: "assets", label: { key: "assets", fallback: "Assets" }, order: 1, features: [] });
  let onSettingsChange: ((include: boolean) => void) | undefined;
  const pushedPaths: string[] = [];
  const dispose = registerP2pkhNavigation({
    pages,
    context,
    business,
    bsvNetwork: bsvNetwork ? "test" : "main",
    onBsvNetworkChange(handler) {
      onSettingsChange = include => handler(include ? "test" : "main");
      return () => { onSettingsChange = undefined; };
    },
    router: {
      currentPath: () => window.location.pathname,
      push: (path) => { pushedPaths.push(path); window.history.replaceState({}, "", path); }
    }
  });
  return { scope, routes, business, setBsvNetwork: (value: boolean) => onSettingsChange?.(value), pushedPaths, dispose };
}

describe("P2PKH navigation registration", () => {
  it("tears down after real Scope revocation without calling revoked registry mutations", () => {
    const navigation = setup(false);
    expect(navigation.routes.list()).toHaveLength(2);
    navigation.scope.revoke("wallet locked");
    expect(navigation.routes.list()).toHaveLength(0);
    expect(() => navigation.dispose()).not.toThrow();
    expect(() => navigation.dispose()).not.toThrow();
  });

  it("registers only the two testnet routes for a test identity", () => {
    const { routes, dispose } = setup(true);
    expect(routes.list().map((route) => route.path).sort()).toEqual([
      "/p2pkh/testnet/local-transactions",
      "/p2pkh/testnet/transactions"
    ]);
    expect(routes.list().some((route) => ["/p2pkh", "/p2pkh/mainnet", "/p2pkh/testnet", "/p2pkh/history", "/p2pkh/utxos"].includes(route.path))).toBe(false);
    expect(routes.list().some((route) => ["p2pkh.overview", "p2pkh.mainnet", "p2pkh.testnet", "p2pkh.history", "p2pkh.utxos"].includes(route.id))).toBe(false);
    dispose();
  });

  it("adds and removes both testnet list routes with a dynamic bsvNetwork change", () => {
    const navigation = setup(false);
    expect(navigation.routes.list().map((route) => route.path)).toEqual([
      "/p2pkh/mainnet/transactions",
      "/p2pkh/mainnet/local-transactions"
    ]);
    navigation.setBsvNetwork(true);
    expect(navigation.routes.byPath("/p2pkh/testnet/transactions")).toBeTruthy();
    expect(navigation.routes.byPath("/p2pkh/testnet/local-transactions")).toBeTruthy();
    window.history.replaceState({}, "", "/p2pkh/testnet/local-transactions?page=3");
    navigation.setBsvNetwork(false);
    expect(navigation.routes.byPath("/p2pkh/testnet/transactions")).toBeUndefined();
    expect(navigation.routes.byPath("/p2pkh/testnet/local-transactions")).toBeUndefined();
    expect(navigation.pushedPaths).toEqual(["/p2pkh/testnet/transactions", "/p2pkh/mainnet/transactions"]);
    navigation.dispose();
  });

  it("closes a testnet detail page when bsvNetwork is dynamically disabled", () => {
    const navigation = setup(true);
    window.history.replaceState({}, "", "/p2pkh/tx/abc?network=test&page=9&source=local-transactions");
    navigation.setBsvNetwork(false);
    expect(navigation.routes.byPath("/p2pkh/testnet/transactions")).toBeUndefined();
    expect(navigation.routes.byPath("/p2pkh/testnet/local-transactions")).toBeUndefined();
    expect(navigation.pushedPaths).toEqual(["/p2pkh/testnet/transactions", "/p2pkh/mainnet/transactions"]);
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
    expect(transactions.entry.path).toBe("/p2pkh/testnet/transactions");
    expect(localTransactions.entry.path).toBe("/p2pkh/testnet/local-transactions");
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
