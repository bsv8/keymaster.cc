import { describe, expect, it, vi } from "vitest";
import type { P2pkhTransactionBroadcastProvider } from "@keymaster/contracts";
import { registerWocP2pkhProviders } from "./p2pkhProviders.js";

function createFakeRegistry() {
  const broadcastProviders: P2pkhTransactionBroadcastProvider[] = [];
  return {
    providers: broadcastProviders,
    registry: {
      registerBroadcastProvider(provider: P2pkhTransactionBroadcastProvider) {
        broadcastProviders.push(provider);
      },
      listBroadcastProviders() {
        return broadcastProviders.map((p) => p.descriptor);
      },
      getBroadcastProvider(id: string, network: string) {
        return broadcastProviders.find(
          (p) => p.descriptor.id === id && p.descriptor.supportedNetworks.includes(network as never)
        );
      }
    }
  };
}

describe("WOC P2PKH providers", () => {
  it("registers a broadcast provider for main+test", () => {
    const { registry, providers } = createFakeRegistry();
    const woc = { broadcast: vi.fn() };
    registerWocP2pkhProviders({ registry: registry as never, woc: woc as never });
    expect(providers).toHaveLength(1);
    expect(providers[0]!.descriptor.id).toBe("woc");
    expect(providers[0]!.descriptor.supportedNetworks).toEqual(
      expect.arrayContaining(["main", "test"])
    );
  });

  it("broadcasting delegates to woc.broadcast and returns canonicalTxid", async () => {
    const { registry, providers } = createFakeRegistry();
    const canonicalTxid = "ab".repeat(32);
    const woc = {
      broadcast: vi.fn(async () => ({ accepted: true as const, canonicalTxid }))
    };
    registerWocP2pkhProviders({ registry: registry as never, woc: woc as never });
    const provider = providers[0]!;
    const signal = new AbortController().signal;
    const result = await provider.broadcast({
      network: "main",
      canonicalTxid,
      rawTxHex: "deadbeef",
      signal
    });
    expect(woc.broadcast).toHaveBeenCalledWith("main", "deadbeef", { signal });
    expect(result).toEqual({ status: "accepted", canonicalTxid, providerCode: "woc" });
  });

  it("broadcasting works for test network", async () => {
    const { registry } = createFakeRegistry();
    const canonicalTxid = "cd".repeat(32);
    const woc = {
      broadcast: vi.fn(async () => ({ accepted: true as const, canonicalTxid }))
    };
    registerWocP2pkhProviders({ registry: registry as never, woc: woc as never });
    const provider = (registry as { getBroadcastProvider(id: string, network: string): P2pkhTransactionBroadcastProvider | undefined }).getBroadcastProvider("woc", "test");
    expect(provider).toBeDefined();
    const result = await provider!.broadcast({ network: "test", canonicalTxid, rawTxHex: "cafebabe" });
    expect(woc.broadcast).toHaveBeenCalledWith("test", "cafebabe", { signal: undefined });
    expect(result).toMatchObject({ status: "accepted", canonicalTxid });
  });
});
