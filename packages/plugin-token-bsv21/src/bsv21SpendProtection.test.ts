import { describe, expect, it, vi } from "vitest";
import { createBsv21SpendProtectionProvider } from "./bsv21SpendProtection.js";
import type { AssetDataNotifier, KeyspaceService } from "@keymaster/contracts";
import type { Bsv21Db } from "./bsv21Db.js";

function fakeKeyspace(activePublicKeyHex?: string): KeyspaceService {
  let current = activePublicKeyHex;
  return {
    active: () => ({ activePublicKeyHex: current }),
    setActive(hex: string | undefined) { current = hex; }
  } as unknown as KeyspaceService & { setActive(hex: string | undefined): void };
}

function fakeDb(records: Array<{ origin: string; outpoint?: string; network: "main" | "test" }>): Bsv21Db {
  return {
    async list() {
      return records.map((record) => ({
        origin: record.origin,
        outpoint: record.outpoint,
        network: record.network,
        observation: "unconfirmed" as const,
        canonicalTxid: record.outpoint?.split("_")[0]
      }));
    }
  } as unknown as Bsv21Db;
}

function fakeNotifier(): AssetDataNotifier & {
  emit: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  fire(event: { providerId: string; kinds: string[]; publicKeyHex?: string }): void;
} {
  let handler: ((event: { providerId: string; kinds: string[]; publicKeyHex?: string }) => void) | undefined;
  return {
    emit: vi.fn(),
    subscribe: vi.fn((next: (event: { providerId: string; kinds: string[]; publicKeyHex?: string }) => void) => {
      handler = next;
      return () => {
        if (handler === next) handler = undefined;
      };
    }),
    fire(event: { providerId: string; kinds: string[]; publicKeyHex?: string }) {
      handler?.(event);
    }
  } as unknown as AssetDataNotifier & {
    emit: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    fire(event: { providerId: string; kinds: string[]; publicKeyHex?: string }): void;
  };
}

describe("createBsv21SpendProtectionProvider", () => {
  it("refreshes protected outpoints when bsv21 asset data changes", async () => {
    const keyspace = fakeKeyspace("pk1");
    const db = fakeDb([{ origin: "tok1", outpoint: "tx1_0", network: "main" }]);
    const notifier = fakeNotifier();
    const provider = createBsv21SpendProtectionProvider({ db, keyspace, assetDataNotifier: notifier });
    const handler = vi.fn();
    if (!provider.onChange) {
      throw new Error("provider.onChange is required for refresh propagation");
    }
    const off = provider.onChange(handler);

    notifier.fire({ providerId: "bsv21", kinds: ["holding"], publicKeyHex: "pk1" });
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    off();
  });
});
