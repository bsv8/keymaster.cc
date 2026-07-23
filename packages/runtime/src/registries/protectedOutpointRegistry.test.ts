// 受保护 outpoint registry 回归测试。

import { describe, expect, it, vi } from "vitest";
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

function mutableProvider(
  id: string,
  ownerPluginId: string,
  initial: Array<{ txid: string; vout: number; network: "main" | "test" }>
): ProtectedOutpointProvider & { setItems(items: Array<{ txid: string; vout: number; network: "main" | "test" }>): void; emitChange(): void } {
  let items = [...initial];
  let onChangeHandler: (() => void) | undefined;
  return {
    id,
    ownerPluginId,
    listProtectedOutpoints: () => items.map((item) => ({
      ...item,
      ownerPluginId,
      kind: "test"
    })),
    onChange(handler) {
      onChangeHandler = handler;
      return () => {
        if (onChangeHandler === handler) onChangeHandler = undefined;
      };
    },
    setItems(next) {
      items = [...next];
    },
    emitChange() {
      onChangeHandler?.();
    }
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

  it("drops stale claims when a provider refresh removes the protected outpoint", async () => {
    const registry = createProtectedOutpointRegistry();
    const p = mutableProvider("a", "token-bsv21", [{ txid: "tx1", vout: 0, network: "main" }]);
    registry.register(p);
    await Promise.resolve();

    await registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx1", vout: 0 }]
    });
    expect(registry.isProtected({ txid: "tx1", vout: 0, network: "main" })).toBe(true);

    p.setItems([]);
    p.emitChange();
    await Promise.resolve();

    expect(registry.isProtected({ txid: "tx1", vout: 0, network: "main" })).toBe(false);
    await expect(registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx1", vout: 0 }]
    })).resolves.toEqual({ claimIds: [] });
  });

  it("clears stale claims when unregisterByOwner removes the provider", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register(provider("a", "token-bsv21", { txid: "tx2", vout: 1, network: "main" }));
    await Promise.resolve();

    await registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx2", vout: 1 }]
    });
    expect(registry.isProtected({ txid: "tx2", vout: 1, network: "main" })).toBe(true);

    registry.unregisterByOwner("token-bsv21");

    expect(registry.isProtected({ txid: "tx2", vout: 1, network: "main" })).toBe(false);
    await expect(registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx2", vout: 1 }]
    })).resolves.toEqual({ claimIds: [] });
  });

  it("notifies listeners when stale claims are pruned", async () => {
    const registry = createProtectedOutpointRegistry();
    const change = vi.fn();
    registry.onChange(change);
    const p = mutableProvider("a", "token-bsv21", [{ txid: "tx3", vout: 0, network: "main" }]);
    registry.register(p);
    await Promise.resolve();

    expect(change).toHaveBeenCalledTimes(1);

    await registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx3", vout: 0 }]
    });
    expect(change).toHaveBeenCalledTimes(2);

    p.setItems([]);
    p.emitChange();
    await Promise.resolve();

    expect(change).toHaveBeenCalledTimes(3);
  });
});
