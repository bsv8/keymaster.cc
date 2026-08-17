import { sha256 } from "@noble/hashes/sha256";
import type { P2pkhConfirmedDataProvider, P2pkhTransactionBroadcastProvider, WocService } from "@keymaster/contracts";
import { P2pkhProviderError } from "@keymaster/contracts";

function normalizeTxid(value: string): string {
  const normalized = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new P2pkhProviderError("provider-inconsistent", "Provider returned an invalid txid");
  return normalized;
}
function hexBytes(value: string): Uint8Array {
  const normalized = value.replace(/^0x/i, "");
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) throw new P2pkhProviderError("provider-inconsistent", "Provider returned invalid raw transaction hex");
  return Uint8Array.from({ length: normalized.length / 2 }, (_, i) => Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16));
}
function calculatedTxid(raw: string): string {
  const hash = sha256(sha256(hexBytes(raw)));
  return Array.from(hash.reverse(), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createWocP2pkhConfirmedProvider(woc: WocService): P2pkhConfirmedDataProvider {
  return {
    descriptor: { id: "woc", label: "WhatsOnChain", supportedNetworks: ["main", "test"] },
    async listAddressConfirmedTransactions(input) {
      const page = await woc.listAddressConfirmedHistory(input.network, input.address, { limit: input.limit, nextPageToken: input.cursor }, { priority: "background", signal: input.signal });
      const items = page.items
        .map((item) => ({ txid: normalizeTxid(item.txid), ...(Number.isSafeInteger(item.height) && item.height >= 0 ? { blockHeight: item.height } : {}) }))
        .sort((a, b) => (b.blockHeight ?? -1) - (a.blockHeight ?? -1));
      return { items, nextCursor: page.nextPageToken, exhausted: !page.nextPageToken };
    },
    async getConfirmedTransaction(input) {
      if (!woc.getRawTransaction) throw new P2pkhProviderError("provider-unavailable", "WOC raw transaction capability is unavailable");
      const txid = normalizeTxid(input.txid);
      const rawTxHex = (await woc.getRawTransaction(input.network, txid, { priority: "background", signal: input.signal })).replace(/^0x/i, "").toLowerCase();
      if (calculatedTxid(rawTxHex) !== txid) throw new P2pkhProviderError("provider-inconsistent", `WOC raw transaction txid mismatch for ${txid}`);
      return { txid, rawTxHex };
    }
  };
}

export function createWocP2pkhBroadcastProvider(woc: WocService): P2pkhTransactionBroadcastProvider {
  return {
    descriptor: { id: "woc", label: "WhatsOnChain", supportedNetworks: ["main", "test"] },
    async broadcast(input) {
      const canonicalTxid = normalizeTxid(input.canonicalTxid);
      if (calculatedTxid(input.rawTxHex) !== canonicalTxid) throw new P2pkhProviderError("provider-inconsistent", "Local raw transaction txid mismatch");
      const result = await woc.broadcast(input.network, input.rawTxHex, { signal: input.signal });
      if (!result.accepted || result.canonicalTxid !== canonicalTxid || result.txidIntegrity === "mismatch") throw new P2pkhProviderError("provider-inconsistent", "WOC broadcast receipt did not match canonical txid");
      return { status: "accepted", canonicalTxid, providerReference: result.providerReturnedTxidRaw, providerCode: result.txidIntegrity };
    }
  };
}

export function registerWocP2pkhProviders(input: { registry: { registerConfirmedProvider(provider: P2pkhConfirmedDataProvider): void; registerBroadcastProvider(provider: P2pkhTransactionBroadcastProvider): void }; woc: WocService }): void {
  input.registry.registerConfirmedProvider(createWocP2pkhConfirmedProvider(input.woc));
  input.registry.registerBroadcastProvider(createWocP2pkhBroadcastProvider(input.woc));
}
