// 受保护 outpoint registry 回归测试。

import { describe, expect, it } from "vitest";
import type { ProtectedOutpointProvider } from "@keymaster/contracts";
import { createProtectedOutpointRegistry } from "./protectedOutpointRegistry.js";

function provider(
  id: string,
  ownerPluginId: string,
  outpoint: { txid: string; vout: number; network: "main" | "test" }
): ProtectedOutpointProvider {
  return {
    id,
    ownerPluginId,
    listProtectedOutpoints: () => [{
      ...outpoint,
      ownerPluginId,
      kind: "test",
    }]
  };
}

describe("createProtectedOutpointRegistry", () => {
  it("registers providers and reports protected outpoints", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register(provider("a", "token-bsv21", { txid: "tx1", vout: 0, network: "main" }));
    await Promise.resolve();

    expect(registry._ids()).toEqual(["a"]);
    expect(registry.list()).toEqual([{
      txid: "tx1",
      vout: 0,
      network: "main",
      ownerPluginId: "token-bsv21",
      kind: "test"
    }]);
    expect(registry.isProtected({ txid: "tx1", vout: 0, network: "main" })).toBe(true);
  });

  it("claims only the matching owner plugin protected inputs", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register(provider("a", "token-bsv21", { txid: "tx1", vout: 0, network: "main" }));
    await Promise.resolve();

    const claimed = await registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx1", vout: 0 }]
    });
    expect(claimed.claimIds).toHaveLength(1);

    await expect(registry.claimProtectedInputs({
      ownerPluginId: "collectible-1satordinals",
      network: "main",
      inputs: [{ txid: "tx1", vout: 0 }]
    })).rejects.toThrow(/belongs to token-bsv21/);
  });

  it("unregisterByOwner removes only matching providers", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register(provider("a", "token-bsv21", { txid: "tx1", vout: 0, network: "main" }));
    registry.register(provider("b", "collectible-1satordinals", { txid: "tx2", vout: 1, network: "test" }));
    await Promise.resolve();

    registry.unregisterByOwner("token-bsv21");
    await Promise.resolve();

    expect(registry._ids()).toEqual(["b"]);
    expect(registry.isProtected({ txid: "tx1", vout: 0, network: "main" })).toBe(false);
    expect(registry.isProtected({ txid: "tx2", vout: 1, network: "test" })).toBe(true);
  });

  it("filters by network and public key when listing", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register({
      id: "a",
      ownerPluginId: "token-bsv21",
      listProtectedOutpoints: () => [
        { txid: "tx1", vout: 0, network: "main", ownerPluginId: "token-bsv21", publicKeyHex: "pk1" },
        { txid: "tx2", vout: 1, network: "test", ownerPluginId: "token-bsv21", publicKeyHex: "pk2" }
      ]
    });
    await Promise.resolve();

    expect(registry.list({ network: "main" })).toHaveLength(1);
    expect(registry.list({ publicKeyHex: "pk2" })).toHaveLength(1);
  });
});
