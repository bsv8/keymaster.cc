import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { createWocP2pkhBroadcastProvider, createWocP2pkhConfirmedProvider } from "./p2pkhProviders.js";

function txid(raw: string): string {
  const bytes = Uint8Array.from(raw.match(/../g)!.map((part) => Number.parseInt(part, 16)));
  return Array.from(sha256(sha256(bytes)).reverse(), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("WOC P2PKH providers", () => {
  it("normalizes confirmed history/raw transaction and validates broadcast receipts", async () => {
    const raw = "00";
    const id = txid(raw);
    const woc = {
      async listAddressConfirmedHistory() { return { items: [{ txid: id, height: 7 }], nextPageToken: undefined }; },
      async getRawTransaction() { return raw; },
      async broadcast() { return { accepted: true, canonicalTxid: id, txidIntegrity: "verified" as const, providerReturnedTxidRaw: id }; }
    };
    const confirmed = createWocP2pkhConfirmedProvider(woc as never);
    expect(await confirmed.listAddressConfirmedTransactions({ network: "main", address: "1abc", limit: 100, signal: new AbortController().signal })).toEqual({ items: [{ txid: id, blockHeight: 7 }], nextCursor: undefined, exhausted: true });
    expect(await confirmed.getConfirmedTransaction({ network: "main", txid: id, signal: new AbortController().signal })).toEqual({ txid: id, rawTxHex: raw });
    const broadcast = createWocP2pkhBroadcastProvider(woc as never);
    await expect(broadcast.broadcast({ network: "main", canonicalTxid: id, rawTxHex: raw })).resolves.toMatchObject({ status: "accepted", canonicalTxid: id });
  });

  it("normalizes history order to newest block first", async () => {
    const oldRaw = "00";
    const newRaw = "01";
    const oldTxid = txid(oldRaw);
    const newTxid = txid(newRaw);
    const woc = { async listAddressConfirmedHistory() { return { items: [{ txid: oldTxid, height: 100 }, { txid: newTxid, height: 101 }], exhausted: true }; } };
    const confirmed = createWocP2pkhConfirmedProvider(woc as never);
    await expect(confirmed.listAddressConfirmedTransactions({ network: "main", address: "1abc", limit: 100, signal: new AbortController().signal })).resolves.toMatchObject({ items: [{ txid: newTxid, blockHeight: 101 }, { txid: oldTxid, blockHeight: 100 }] });
  });
});
