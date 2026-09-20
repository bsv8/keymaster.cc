import { describe, expect, it } from "vitest";
import type { BsvNetwork, P2pkhTransactionBroadcastProvider } from "@keymaster/contracts";
import { createP2pkhProviderRegistry } from "./p2pkhProviderRegistry.js";

function broadcastProvider(id: string, networks: BsvNetwork[]): P2pkhTransactionBroadcastProvider {
  return {
    descriptor: { id, label: id, supportedNetworks: networks },
    async broadcast(input: { network: BsvNetwork; canonicalTxid: string; rawTxHex: string }) {
      return { status: "accepted", canonicalTxid: input.canonicalTxid };
    },
  };
}

describe("P2PKH broadcast-only provider registry", () => {
  it("registers, lists and resolves broadcast providers", () => {
    const registry = createP2pkhProviderRegistry();
    const woc = broadcastProvider("woc", ["main", "test"]);
    registry.registerBroadcastProvider(woc);
    expect(registry.listBroadcastProviders()).toHaveLength(1);
    expect(registry.listBroadcastProviders("main")).toHaveLength(1);
    expect(registry.getBroadcastProvider("woc", "main")).toBe(woc);
  });

  it("throws on duplicate broadcast provider id", () => {
    const registry = createP2pkhProviderRegistry();
    registry.registerBroadcastProvider(broadcastProvider("woc", ["main"]));
    expect(() => registry.registerBroadcastProvider(broadcastProvider("woc", ["main"]))).toThrow(/Duplicate/);
  });

  it("returns undefined for unsupported networks and removed providers", () => {
    const registry = createP2pkhProviderRegistry();
    const mainOnly = broadcastProvider("main-only", ["main"]);
    registry.registerBroadcastProvider(mainOnly);
    expect(registry.getBroadcastProvider("main-only", "test")).toBeUndefined();
    expect(registry.listBroadcastProviders("test")).toHaveLength(0);
    registry.unregisterBroadcastProvider?.("main-only");
    expect(registry.getBroadcastProvider("main-only", "main")).toBeUndefined();
  });
});
