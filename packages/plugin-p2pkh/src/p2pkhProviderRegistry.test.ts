import { describe, expect, it } from "vitest";
import type { BsvNetwork } from "@keymaster/contracts";
import { createP2pkhProviderRegistry } from "./p2pkhProviderRegistry.js";

const confirmed = {
  descriptor: { id: "optional", label: "Optional", supportedNetworks: ["main", "test"] as BsvNetwork[] },
  async listAddressConfirmedTransactions() { return { items: [], exhausted: true }; },
  async getConfirmedTransaction(input: { txid: string }) { return { txid: input.txid, rawTxHex: "00" }; }
};

describe("P2PKH provider registry lifecycle", () => {
  it("removes an optional confirmed provider when its plugin is disabled", () => {
    const registry = createP2pkhProviderRegistry();
    registry.registerConfirmedProvider(confirmed);
    expect(registry.getConfirmedProvider("optional", "main")).toBe(confirmed);
    registry.unregisterConfirmedProvider?.("optional");
    expect(registry.getConfirmedProvider("optional", "main")).toBeUndefined();
  });
});
