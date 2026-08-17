import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { P2pkhProviderError } from "@keymaster/contracts";
import { createJungleBusP2pkhConfirmedProvider } from "./p2pkhConfirmedProvider.js";
import { createJungleBusClient } from "./jungleBusClient.js";

function txid(raw: string): string {
  const bytes = Uint8Array.from(raw.match(/../g)!.map((part) => Number.parseInt(part, 16)));
  return Array.from(sha256(sha256(bytes)).reverse(), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("JungleBus confirmed provider", () => {
  it("normalizes confirmed pages and verifies base64 raw transactions", async () => {
    const raw = "00";
    const id = txid(raw);
    const calls: string[] = [];
    const provider = createJungleBusP2pkhConfirmedProvider({ client: {
      async getAddressTransactions() { calls.push("address"); return { transactions: [{ txid: id, height: 10 }, { txid: id, height: 10 }] }; },
      async getTransaction() { calls.push("transaction"); return { transaction: btoa(String.fromCharCode(0)), height: 10 }; }
    } });
    const page = await provider.listAddressConfirmedTransactions({ network: "main", address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", limit: 100, signal: new AbortController().signal });
    expect(page.items).toEqual([{ txid: id, blockHeight: 10 }]);
    const detail = await provider.getConfirmedTransaction({ network: "main", txid: id, signal: new AbortController().signal });
    expect(detail.rawTxHex).toBe(raw);
    expect(calls).toEqual(["address", "transaction"]);
  });

  it("uses the live JungleBus REST paths, network-specific hosts, and transaction_id wire shape", async () => {
    const urls: string[] = [];
    const client = createJungleBusClient({}, (async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, statusText: "OK", json: async () => [] } as Response;
    }) as typeof fetch);
    await client.getAddressTransactions("main", "1abc", new AbortController().signal);
    await client.getTransaction("test", "aa".repeat(32), new AbortController().signal);
    expect(urls).toEqual([
      "https://junglebus.gorillapool.io/v1/address/get/1abc",
      "https://testnet.junglebus.gorillapool.io/v1/transaction/get/" + "aa".repeat(32)
    ]);

    const raw = "00";
    const id = txid(raw);
    let addressCalls = 0;
    const provider = createJungleBusP2pkhConfirmedProvider({ client: {
      async getAddressTransactions() {
        addressCalls += 1;
        return [{ transaction_id: id, block_height: addressCalls === 1 ? 10 : 11, block_index: 7, block_hash: "bb".repeat(32) }];
      },
      async getTransaction() { return { transaction: btoa(String.fromCharCode(0)), block_index: 11 }; }
    } });
    expect((await provider.listAddressConfirmedTransactions({ network: "test", address: "1abc", limit: 100, signal: new AbortController().signal })).items[0]).toMatchObject({ txid: id, blockHeight: 10 });
    expect((await provider.listAddressConfirmedTransactions({ network: "test", address: "1abc", limit: 100, signal: new AbortController().signal })).items[0]).toMatchObject({ blockHeight: 11 });
  });

  it("uses one stable in-memory snapshot across logical pages", async () => {
    const first = txid("00");
    const second = txid("01");
    let addressCalls = 0;
    const provider = createJungleBusP2pkhConfirmedProvider({ client: {
      async getAddressTransactions() { addressCalls += 1; return [{ transaction_id: first, block_height: 20 }, { transaction_id: second, block_height: 19 }]; },
      async getTransaction() { return { transaction: btoa(String.fromCharCode(0)) }; }
    } });
    const signal = new AbortController().signal;
    const page1 = await provider.listAddressConfirmedTransactions({ network: "main", address: "1abc", limit: 1, signal });
    const page2 = await provider.listAddressConfirmedTransactions({ network: "main", address: "1abc", cursor: page1.nextCursor, limit: 1, signal });
    expect(page1.items[0]?.txid).toBe(first);
    expect(page2.items[0]?.txid).toBe(second);
    expect(addressCalls).toBe(1);
  });

  it("restarts from the beginning after a worker restart instead of reusing a stale offset", async () => {
    const first = txid("00");
    const second = txid("01");
    const inserted = txid("02");
    let addressCalls = 0;
    let history = [{ transaction_id: first, block_height: 20 }, { transaction_id: second, block_height: 19 }];
    const client = {
      async getAddressTransactions() { addressCalls += 1; return history; },
      async getTransaction() { return { transaction: btoa(String.fromCharCode(0)) }; }
    };
    const firstProvider = createJungleBusP2pkhConfirmedProvider({ client });
    const signal = new AbortController().signal;
    const page1 = await firstProvider.listAddressConfirmedTransactions({ network: "main", address: "1abc", limit: 1, signal });
    expect(page1.items[0]?.txid).toBe(first);

    // The Worker dies before the next logical page. The upstream history has
    // changed before the replacement Worker resumes the saved cursor.
    history = [{ transaction_id: inserted, block_height: 21 }, { transaction_id: first, block_height: 20 }, { transaction_id: second, block_height: 19 }];
    const restartedProvider = createJungleBusP2pkhConfirmedProvider({ client });
    const resumed = await restartedProvider.listAddressConfirmedTransactions({ network: "main", address: "1abc", cursor: page1.nextCursor, limit: 1, signal });
    expect(resumed.items[0]?.txid).toBe(inserted);
    expect(addressCalls).toBe(2);
  });

  it("rejects invalid Base64/raw payloads and raw transaction txid mismatches", async () => {
    const expected = txid("00");
    const provider = createJungleBusP2pkhConfirmedProvider({ client: {
      async getAddressTransactions() { return []; },
      async getTransaction() { return { transaction: "%%%" }; }
    } });
    await expect(provider.getConfirmedTransaction({ network: "main", txid: expected, signal: new AbortController().signal })).rejects.toMatchObject({ code: "provider-inconsistent" });
    const mismatchProvider = createJungleBusP2pkhConfirmedProvider({ client: {
      async getAddressTransactions() { return []; },
      async getTransaction() { return { hex: "01" }; }
    } });
    await expect(mismatchProvider.getConfirmedTransaction({ network: "main", txid: expected, signal: new AbortController().signal })).rejects.toBeInstanceOf(P2pkhProviderError);
    const malformedRawProvider = createJungleBusP2pkhConfirmedProvider({ client: {
      async getAddressTransactions() { return []; },
      async getTransaction() { return { hex: "zz" }; }
    } });
    await expect(malformedRawProvider.getConfirmedTransaction({ network: "main", txid: expected, signal: new AbortController().signal })).rejects.toMatchObject({ code: "provider-inconsistent" });
    await expect(provider.getConfirmedTransaction({ network: "main", txid: "not-a-txid", signal: new AbortController().signal })).rejects.toMatchObject({ code: "provider-inconsistent" });
  });

  it("propagates AbortSignal cancellation and rejects a non-retryable 429", async () => {
    const controller = new AbortController();
    const client = createJungleBusClient({ requestsPerSecond: 100_000, maxRetries: 0 }, (async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    })) as typeof fetch);
    const pending = client.getAddressTransactions("main", "1abc", controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");

    const throttled = createJungleBusClient({ requestsPerSecond: 100_000, maxRetries: 0 }, (async () => ({ ok: false, status: 429, statusText: "Too Many Requests", json: async () => ({}) })) as unknown as typeof fetch);
    await expect(throttled.getAddressTransactions("main", "1abc", new AbortController().signal)).rejects.toThrow("JungleBus 429");
  });
});
