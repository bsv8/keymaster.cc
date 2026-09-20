import type { P2pkhProviderRegistry, WocService } from "@keymaster/contracts";
import type { P2pkhBroadcastResult } from "@keymaster/contracts";

/**
 * 把 WoC 注册为 P2PKH 广播 Provider。
 *
 * 确认同步/历史/UTXO 不再经过 registry：P2PKH 直接调用 WocService
 * （`listAddressConfirmedHistory` / `getAddressUnspentAll`）。
 */
export function registerWocP2pkhProviders(input: { registry: P2pkhProviderRegistry; woc: WocService }): void {
  input.registry.registerBroadcastProvider({
    descriptor: {
      id: "woc",
      label: "WhatsOnChain",
      supportedNetworks: ["main", "test"],
    },
    async broadcast({ network, rawTxHex, signal }): Promise<P2pkhBroadcastResult> {
      const result = await input.woc.broadcast(network, rawTxHex, { signal });
      return {
        status: "accepted",
        canonicalTxid: result.canonicalTxid,
        providerCode: "woc",
      };
    },
  });
}
