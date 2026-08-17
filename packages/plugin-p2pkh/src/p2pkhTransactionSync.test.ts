import { describe, expect, it, vi } from "vitest";
import type { P2pkhProviderRegistry } from "@keymaster/contracts";
import type { P2pkhKeyResource } from "./p2pkhContracts.js";
import { createP2pkhTransactionSync } from "./p2pkhTransactionSync.js";
import type { P2pkhDbHandle } from "./p2pkhDb.js";

const resource: P2pkhKeyResource = {
  resourceId: "p2pkh:main",
  publicKeyHex: "02" + "11".repeat(32),
  label: "test",
  address: "1abc",
  network: "main",
  createdAt: new Date(0).toISOString(),
  generation: 0
};

function makeDb(previous?: Awaited<ReturnType<P2pkhDbHandle["getTransactionSyncState"]>>, existingFacts: unknown[] = []) {
  const states: unknown[] = [];
  const pages: unknown[] = [];
  const db = {
    async getTransactionSyncState() { return previous; },
    async listTransactionFacts() { return existingFacts; },
    async putTransactionSyncState(state: unknown) { states.push(state); },
    async ingestConfirmedTransactionPage(input: unknown) { pages.push(input); }
  } as unknown as P2pkhDbHandle;
  return { db, states, pages };
}

function makeDeps(db: P2pkhDbHandle, provider: unknown) {
  return {
    getDb: async () => db,
    getResources: async () => [resource],
    registry: { getConfirmedProvider: () => provider } as unknown as P2pkhProviderRegistry,
    getSelection: () => ({ syncProviderId: "woc", generation: 1 }),
    isGenerationCurrent: () => true,
    now: () => "2026-08-16T00:00:00.000Z"
  };
}

describe("P2PKH transaction sync", () => {
  it("commits a terminal checkpoint with the run identity and reorg overlap", async () => {
    const provider = {
      descriptor: { id: "woc", label: "WOC", supportedNetworks: ["main"] },
      async listAddressConfirmedTransactions() { return { items: [{ txid: "aa".repeat(32), blockHeight: 10 }], exhausted: true }; },
      async getConfirmedTransaction(input: { txid: string }) { return { txid: input.txid, rawTxHex: "00" }; }
    };
    const fake = makeDb();
    const sync = createP2pkhTransactionSync(makeDeps(fake.db, provider));
    await sync.runOnce(new AbortController().signal);
    const terminal = fake.pages[0] as { syncState: { runId?: string; inProgressProviderId?: string }; reorgCheck?: { completeHistory: boolean; observedTxids: string[] } };
    expect(terminal.syncState.runId).toBeTruthy();
    expect(terminal.syncState.inProgressProviderId).toBeUndefined();
    expect(terminal.reorgCheck).toMatchObject({ completeHistory: true, observedTxids: ["aa".repeat(32)] });
  });

  it("resumes the previous run head instead of moving completeHeadTxid backwards", async () => {
    const previous = { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: "ff".repeat(32), inProgressProviderId: "woc", inProgressProviderGeneration: 1, inProgressCursor: "1", runHeadTxid: "ff".repeat(32), runId: "run-1", pagesSynced: 1, transactionsSynced: 1 };
    const provider = {
      descriptor: { id: "woc", label: "WOC", supportedNetworks: ["main"] },
      listAddressConfirmedTransactions: vi.fn(async (input: { cursor?: string }) => { expect(input.cursor).toBe("1"); return { items: [{ txid: "aa".repeat(32), blockHeight: 1 }], exhausted: true }; }),
      async getConfirmedTransaction(input: { txid: string }) { return { txid: input.txid, rawTxHex: "00" }; }
    };
    const fake = makeDb(previous);
    const sync = createP2pkhTransactionSync(makeDeps(fake.db, provider));
    await sync.runOnce(new AbortController().signal);
    expect((fake.pages[0] as { syncState: { completeHeadTxid?: string } }).syncState.completeHeadTxid).toBe("ff".repeat(32));
    expect((fake.pages[0] as { reorgCheck?: { completeHistory: boolean } }).reorgCheck?.completeHistory).toBe(false);
    expect((fake.states[0] as { runHeadTxid?: string }).runHeadTxid).toBe("ff".repeat(32));
  });

  it("uses the anchor path instead of a full projection rebuild when the old head is reached", async () => {
    const previous = { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: "aa".repeat(32), pagesSynced: 1, transactionsSynced: 1 };
    const provider = {
      descriptor: { id: "woc", label: "WOC", supportedNetworks: ["main"] },
      async listAddressConfirmedTransactions() { return { items: [{ txid: "bb".repeat(32), blockHeight: 11 }, { txid: "aa".repeat(32), blockHeight: 10 }], exhausted: true }; },
      async getConfirmedTransaction(input: { txid: string }) { return { txid: input.txid, rawTxHex: "00" }; }
    };
    const fake = makeDb(previous, [{ txid: previous.completeHeadTxid }]);
    const sync = createP2pkhTransactionSync(makeDeps(fake.db, provider));
    await sync.runOnce(new AbortController().signal);
    expect((fake.pages[0] as { reorgCheck?: { completeHistory: boolean; anchorTxid?: string } }).reorgCheck).toEqual({ completeHistory: false, observedTxids: ["bb".repeat(32), "aa".repeat(32)], anchorTxid: "aa".repeat(32) });
  });

  it("continues past an old anchor when the provider has no block heights", async () => {
    const anchorTxid = "aa".repeat(32);
    const previous = { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: anchorTxid, pagesSynced: 1, transactionsSynced: 1 };
    let calls = 0;
    const provider = {
      descriptor: { id: "junglebus", label: "JungleBus", supportedNetworks: ["main"] },
      async listAddressConfirmedTransactions() {
        calls += 1;
        return calls === 1 ? { items: [{ txid: anchorTxid }], nextCursor: "after-anchor", exhausted: false } : { items: [], exhausted: true };
      },
      async getConfirmedTransaction(input: { txid: string }) { return { txid: input.txid, rawTxHex: "00" }; }
    };
    const fake = makeDb(previous, [{ txid: anchorTxid }]);
    const sync = createP2pkhTransactionSync(makeDeps(fake.db, provider));
    await sync.runOnce(new AbortController().signal);
    expect(calls).toBe(2);
    expect(fake.pages).toHaveLength(2);
    expect((fake.pages[0] as { reorgCheck?: unknown }).reorgCheck).toBeUndefined();
    expect((fake.pages[1] as { reorgCheck?: { completeHistory: boolean; observedTxids: string[] } }).reorgCheck).toEqual({ completeHistory: true, observedTxids: [anchorTxid] });
  });

  it("retains the run head through a second interruption", async () => {
    const previous = { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: "ff".repeat(32), inProgressProviderId: "woc", inProgressProviderGeneration: 1, inProgressCursor: "1", runHeadTxid: "ff".repeat(32), runObservedTxids: [], runId: "run-1", pagesSynced: 1, transactionsSynced: 1 };
    let current: Awaited<ReturnType<P2pkhDbHandle["getTransactionSyncState"]>> = previous;
    const states: unknown[] = [];
    const pages: unknown[] = [];
    let interruption = true;
    const firstController = new AbortController();
    const provider = {
      descriptor: { id: "woc", label: "WOC", supportedNetworks: ["main"] },
      async listAddressConfirmedTransactions(input: { cursor?: string }) {
        expect(input.cursor).toBe("1");
        return interruption
          ? { items: [{ txid: "aa".repeat(32), blockHeight: 1 }], nextCursor: "2", exhausted: false }
          : { items: [{ txid: "bb".repeat(32), blockHeight: 0 }], exhausted: true };
      },
      async getConfirmedTransaction(input: { txid: string }) {
        if (interruption) { interruption = false; firstController.abort(); }
        return { txid: input.txid, rawTxHex: "00" };
      }
    };
    const db = {
      async getTransactionSyncState() { return current; },
      async listTransactionFacts() { return []; },
      async putTransactionSyncState(state: Awaited<ReturnType<P2pkhDbHandle["getTransactionSyncState"]>>) { current = state; states.push(state); },
      async ingestConfirmedTransactionPage(input: unknown) { pages.push(input); }
    } as unknown as P2pkhDbHandle;
    const sync = createP2pkhTransactionSync(makeDeps(db, provider));
    // The first recovery is interrupted after detail fetch and before page
    // commit. The persisted in-progress head must still be available to the
    // next recovery.
    await sync.runOnce(firstController.signal);
    expect((states[0] as { runHeadTxid?: string }).runHeadTxid).toBe("ff".repeat(32));
    const second = await sync.runOnce(new AbortController().signal);
    expect(second.cancelled).toBe(false);
    expect((pages[0] as { syncState: { completeHeadTxid?: string }; reorgCheck?: { completeHistory: boolean } }).syncState.completeHeadTxid).toBe("ff".repeat(32));
    expect((pages[0] as { reorgCheck?: { completeHistory: boolean } }).reorgCheck?.completeHistory).toBe(true);
  });

  it("requires a second full check before converging an existing resource to empty history", async () => {
    const previous = { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: "ff".repeat(32), pagesSynced: 1, transactionsSynced: 1 };
    let calls = 0;
    const provider = {
      descriptor: { id: "woc", label: "WOC", supportedNetworks: ["main"] },
      async listAddressConfirmedTransactions() { calls += 1; return { items: [], exhausted: true }; },
      async getConfirmedTransaction(input: { txid: string }) { return { txid: input.txid, rawTxHex: "00" }; }
    };
    const fake = makeDb(previous, [{ txid: previous.completeHeadTxid }]);
    const sync = createP2pkhTransactionSync(makeDeps(fake.db, provider));
    await expect(sync.runOnce(new AbortController().signal)).resolves.toMatchObject({ pages: 1, transactions: 0 });
    expect(calls).toBe(2);
    expect(fake.pages).toHaveLength(1);
    expect((fake.pages[0] as { syncState: { completeHeadTxid?: string }; reorgCheck?: { completeHistory: boolean; observedTxids: string[] } }).syncState.completeHeadTxid).toBeUndefined();
    expect((fake.pages[0] as { reorgCheck?: { completeHistory: boolean; observedTxids: string[] } }).reorgCheck).toEqual({ completeHistory: true, observedTxids: [] });
  });

  it("treats a terminal empty page after a non-empty page as normal pagination", async () => {
    const previous = { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: "ff".repeat(32), pagesSynced: 1, transactionsSynced: 1 };
    const provider = {
      descriptor: { id: "woc", label: "WOC", supportedNetworks: ["main"] },
      listAddressConfirmedTransactions: vi.fn(async (input: { cursor?: string }) => input.cursor
        ? { items: [], exhausted: true }
        : { items: [{ txid: "aa".repeat(32), blockHeight: 10 }], nextCursor: "next", exhausted: false }),
      async getConfirmedTransaction(input: { txid: string }) { return { txid: input.txid, rawTxHex: "00" }; }
    };
    const fake = makeDb(previous, [{ txid: previous.completeHeadTxid }]);
    const sync = createP2pkhTransactionSync(makeDeps(fake.db, provider));
    await sync.runOnce(new AbortController().signal);
    expect(provider.listAddressConfirmedTransactions).toHaveBeenCalledTimes(2);
    expect(fake.pages).toHaveLength(2);
    expect((fake.pages[1] as { syncState: { completeHeadTxid?: string }; reorgCheck?: { completeHistory: boolean; observedTxids: string[] } }).syncState.completeHeadTxid).toBe("aa".repeat(32));
    expect((fake.pages[1] as { reorgCheck?: { completeHistory: boolean; observedTxids: string[] } }).reorgCheck).toEqual({ completeHistory: true, observedTxids: ["aa".repeat(32)] });
  });

  it("restarts from the head when the empty confirmation returns transactions", async () => {
    const previous = { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: "ff".repeat(32), pagesSynced: 1, transactionsSynced: 1 };
    let calls = 0;
    const provider = {
      descriptor: { id: "woc", label: "WOC", supportedNetworks: ["main"] },
      async listAddressConfirmedTransactions() {
        calls += 1;
        return calls === 1
          ? { items: [], exhausted: true }
          : { items: [{ txid: "aa".repeat(32), blockHeight: 10 }], exhausted: true };
      },
      async getConfirmedTransaction(input: { txid: string }) { return { txid: input.txid, rawTxHex: "00" }; }
    };
    const fake = makeDb(previous, [{ txid: previous.completeHeadTxid }]);
    const sync = createP2pkhTransactionSync(makeDeps(fake.db, provider));
    await sync.runOnce(new AbortController().signal);
    expect(calls).toBe(3);
    expect((fake.pages[0] as { transactions: Array<{ txid: string }> }).transactions[0]?.txid).toBe("aa".repeat(32));
  });

  it("skips a disabled network before opening its provider", async () => {
    const testResource = { ...resource, resourceId: "p2pkh:test", network: "test" as const };
    const listAddressConfirmedTransactions = vi.fn(async (_input: { network: "main" | "test" }) => ({ items: [], exhausted: true }));
    const provider = {
      descriptor: { id: "woc", label: "WOC", supportedNetworks: ["main", "test"] },
      listAddressConfirmedTransactions,
      async getConfirmedTransaction(input: { txid: string }) { return { txid: input.txid, rawTxHex: "00" }; }
    };
    const fake = makeDb();
    const sync = createP2pkhTransactionSync({
      ...makeDeps(fake.db, provider),
      getResources: async () => [resource, testResource],
      isNetworkEnabled: (network) => network === "main"
    });
    await sync.runOnce(new AbortController().signal);
    expect(listAddressConfirmedTransactions).toHaveBeenCalledTimes(1);
    expect(listAddressConfirmedTransactions.mock.calls[0]?.[0]).toMatchObject({ network: "main" });
  });
});
