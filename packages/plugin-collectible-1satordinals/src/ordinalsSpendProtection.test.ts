import { describe, expect, it, vi } from "vitest";
import { createOrdinalsSpendProtectionProvider } from "./ordinalsSpendProtection.js";
import type { OrdinalsServiceHandle } from "./ordinalsService.js";

function fakeService(initial: Array<{ outpoint: string; network: "main" | "test"; inscriptionId: string }>): OrdinalsServiceHandle & {
  setItems(items: Array<{ outpoint: string; network: "main" | "test"; inscriptionId: string }>): void;
  emitChange(): void;
} {
  let items = [...initial];
  let onChangeHandler: (() => void) | undefined;
  return {
    listActiveKeyCollectibles: vi.fn(async () => items.map((item) => ({
      outpoint: item.outpoint,
      network: item.network,
      address: "addr1",
      inscription: {
        inscriptionId: item.inscriptionId,
        outpoint: item.outpoint.replace(":", "_"),
        contentType: "text/plain",
        origin: "origin",
        preview: "preview",
        owner: "owner",
        observation: "confirmed" as const,
        canonicalTxid: item.outpoint.split(":")[0] ?? "tx"
      }
    }))),
    getOutpoint: vi.fn(async () => null),
    getOutpointContent: vi.fn(async () => null),
    getTransactionOutputScript: vi.fn(async () => new Uint8Array([0x76, 0xa9, 0x14, ...new Uint8Array(20), 0x88, 0xac])),
    sync: vi.fn(async () => {}),
    onChange: vi.fn((handler: () => void) => {
      onChangeHandler = handler;
      return () => {
        if (onChangeHandler === handler) onChangeHandler = undefined;
      };
    }),
    dispose: vi.fn(),
    setItems(next) {
      items = [...next];
    },
    emitChange() {
      onChangeHandler?.();
    }
  };
}

describe("createOrdinalsSpendProtectionProvider", () => {
  it("emits change when the service changes so registries can refresh", async () => {
    const service = fakeService([
      { outpoint: "tx1:0", network: "main", inscriptionId: "insc-1" }
    ]);
    const provider = createOrdinalsSpendProtectionProvider({ service });
    const handler = vi.fn();
    if (!provider.onChange) {
      throw new Error("provider.onChange is required for refresh propagation");
    }
    const off = provider.onChange(handler);

    service.emitChange();
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    service.setItems([]);
    service.emitChange();
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });

    off();
  });
});
