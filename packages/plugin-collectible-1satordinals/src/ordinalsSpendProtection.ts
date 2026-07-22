// 1Sat Ordinals 受保护 outpoint provider。
//
// 设计缘由：
//   - 1Sat Ordinals 本质上占用恰好 1 sat 的 ordinal 输出；
//   - 这些 outpoint 不能被普通 funding 选中；
//   - provider 直接从当前 active key 的 1Sat collectible 列表推导受保护集合。

import type { ProtectedOutpointProvider } from "@keymaster/contracts";
import type { OrdinalsServiceHandle } from "./ordinalsService.js";

export interface OrdinalsSpendProtectionOptions {
  service: OrdinalsServiceHandle;
}

function parseOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const [txid, voutStr] = outpoint.split(":");
  if (!txid || !voutStr) return null;
  const vout = Number(voutStr);
  if (!Number.isFinite(vout)) return null;
  return { txid, vout };
}

export function createOrdinalsSpendProtectionProvider(options: OrdinalsSpendProtectionOptions): ProtectedOutpointProvider {
  if (!options || !options.service) {
    throw new Error("createOrdinalsSpendProtectionProvider: service is required");
  }
  const listeners = new Set<() => void>();
  options.service;
  return {
    id: "1satordinals",
    ownerPluginId: "collectible-1satordinals",
    async listProtectedOutpoints() {
      const collectibles = await options.service.listActiveKeyCollectibles();
      return collectibles
        .map((hit) => {
          const parsed = parseOutpoint(hit.outpoint);
          if (!parsed) return null;
          return {
            txid: parsed.txid,
            vout: parsed.vout,
            network: hit.network,
            ownerPluginId: "collectible-1satordinals",
            publicKeyHex: undefined,
            kind: "1satordinals",
            reason: `1Sat collectible ${hit.inscription.inscriptionId}`
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
    },
    onChange(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    }
  };
}
