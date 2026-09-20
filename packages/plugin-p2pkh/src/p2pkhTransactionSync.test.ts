import { afterEach, describe, expect, it, vi } from "vitest";
import type { WocService } from "@keymaster/contracts";
import type { P2pkhKeyResource } from "./p2pkhContracts.js";
import { createP2pkhTransactionSync } from "./p2pkhTransactionSync.js";
import { createP2pkhStateRepository, disposeP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { createMemoryOwnerFileStore } from "./storage/testSupport/memoryOwnerFileStore.js";

const resource: P2pkhKeyResource = {
  resourceId: "p2pkh:main",
  publicKeyHex: "02" + "11".repeat(32),
  label: "test",
  address: "1abc",
  network: "main",
  createdAt: new Date(0).toISOString(),
  generation: 0,
};

afterEach(() => {
  disposeP2pkhStateRepository();
});

async function setup(itemsByToken: Record<string, { items: Array<{ txid: string; height: number; fee?: number }>; nextPageToken?: string }> | { items: Array<{ txid: string; height: number; fee?: number }>; nextPageToken?: string }[], failOnCall?: number, failError: unknown = new Error("woc boom")) {
  const files = createMemoryOwnerFileStore();
  const bundle = await openP2pkhStateRepository(files as never);
  const repository = createP2pkhStateRepository(bundle);
  await repository.putAddress(resource);
  const pages = Array.isArray(itemsByToken) ? itemsByToken : [itemsByToken];
  let calls = 0;
  const listAddressConfirmedHistory = vi.fn(async (_network: string, _address: string, page?: { nextPageToken?: string }) => {
    calls += 1;
    if (failOnCall !== undefined && calls === failOnCall) throw failError;
    const key = page?.nextPageToken ?? "__first__";
    if (Array.isArray(itemsByToken)) {
      return (pages[calls - 1] ?? { items: [] }) as { items: Array<{ txid: string; height: number }>; nextPageToken?: string };
    }
    return ((itemsByToken as Record<string, { items: unknown[] }>)[key] ?? { items: [] }) as { items: Array<{ txid: string; height: number }>; nextPageToken?: string };
  });
  const woc = { listAddressConfirmedHistory } as unknown as WocService;
  const getStore = async () => repository;
  const getResources = async () => [resource];
  return { repository, woc, getStore, getResources, listAddressConfirmedHistory };
}

describe("P2PKH transaction sync (WoC history only)", () => {
  it("commits only after complete pagination", async () => {
    const txA = "aa".repeat(32);
    const txB = "bb".repeat(32);
    const { repository, woc, getStore, getResources } = await setup([
      { items: [{ txid: txA, height: 10 }], nextPageToken: "p2" },
      { items: [{ txid: txB, height: 11, fee: 5 }] },
    ]);
    const sync = createP2pkhTransactionSync({ getStore, getResources, woc, now: () => "2026-09-20T00:00:00.000Z" });
    const result = await sync.runOnce(new AbortController().signal);
    expect(result).toMatchObject({ resources: 1, pages: 2, transactions: 2, cancelled: false });
    const history = await repository.listHistory({ resourceId: resource.resourceId });
    expect(history.map((row) => row.txid).sort()).toEqual([txA, txB]);
    const state = await repository.getTransactionSyncState(resource.resourceId);
    expect(state).toMatchObject({ pagesSynced: 2, transactionsSynced: 2, lastSuccessAt: "2026-09-20T00:00:00.000Z" });
    expect(state?.lastError).toBeUndefined();
  });

  it("keeps old history and records lastError when pagination fails", async () => {
    const oldTxid = "cc".repeat(32);
    const files = createMemoryOwnerFileStore();
    const bundle = await openP2pkhStateRepository(files as never);
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    await repository.replaceHistory(resource, [{ txid: oldTxid, height: 9 }]);
    let calls = 0;
    const woc = {
      listAddressConfirmedHistory: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { items: [{ txid: "dd".repeat(32), height: 10 }], nextPageToken: "p2" };
        throw new Error("page two failed");
      }),
    } as unknown as WocService;
    const sync = createP2pkhTransactionSync({
      getStore: async () => repository,
      getResources: async () => [resource],
      woc,
      now: () => "2026-09-20T00:00:00.000Z",
    });
    await expect(sync.runOnce(new AbortController().signal)).rejects.toThrow(/page two failed/);
    expect((await repository.listHistory({ resourceId: resource.resourceId })).map((row) => row.txid)).toEqual([oldTxid]);
    const state = await repository.getTransactionSyncState(resource.resourceId);
    expect(state?.lastError).toMatch(/page two failed/);
    expect(state?.lastSuccessAt).toBeUndefined();
  });

  it("rejects invalid metadata without touching history", async () => {
    const { repository, woc, getStore, getResources } = await setup([{ items: [{ txid: "not-a-txid", height: 1 }] }]);
    const sync = createP2pkhTransactionSync({ getStore, getResources, woc });
    await expect(sync.runOnce(new AbortController().signal)).rejects.toThrow(/invalid txid/);
    expect(await repository.listHistory({ resourceId: resource.resourceId })).toEqual([]);
    expect((await repository.getTransactionSyncState(resource.resourceId))?.lastError).toBeTruthy();
  });

  it("rejects conflicting duplicate metadata and never derives UTXOs", async () => {
    const txid = "ee".repeat(32);
    const { repository, woc, getStore, getResources, listAddressConfirmedHistory } = await setup([
      { items: [{ txid, height: 10 }], nextPageToken: "p2" },
      { items: [{ txid, height: 11 }] },
    ]);
    const sync = createP2pkhTransactionSync({ getStore, getResources, woc });
    await expect(sync.runOnce(new AbortController().signal)).rejects.toThrow(/Conflicting history metadata/);
    expect(await repository.listHistory({ resourceId: resource.resourceId })).toEqual([]);
    // 同步只允许调用 confirmed-history 分页；不得调用 unspent/raw 等 UTXO 派生入口。
    expect(listAddressConfirmedHistory).toHaveBeenCalled();
    expect(woc.getAddressUnspentAll).toBeUndefined();
    expect(woc.getRawTransaction).toBeUndefined();
  });

  it("marks same-txid local submissions chain-confirmed", async () => {
    const txid = "ff".repeat(32);
    const files = createMemoryOwnerFileStore();
    const bundle = await openP2pkhStateRepository(files as never);
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    const now = new Date(0).toISOString();
    await repository.prepareLocalSubmission({
      submission: {
        id: "sub-1", resourceId: resource.resourceId, publicKeyHex: resource.publicKeyHex, network: "main",
        txid, rawTxHex: "00", localState: "submitting", chainResolution: "unresolved",
        inputOutpointKeys: [], ownOutputs: [], createdAt: now, updatedAt: now, attempts: [],
      },
      claims: [],
    });
    const woc = { listAddressConfirmedHistory: async () => ({ items: [{ txid, height: 12 }] }) } as unknown as WocService;
    const sync = createP2pkhTransactionSync({ getStore: async () => repository, getResources: async () => [resource], woc });
    await sync.runOnce(new AbortController().signal);
    expect((await repository.listLocalTransactions(resource.resourceId))[0]).toMatchObject({
      chainResolution: "chain-confirmed",
      confirmedHistoryId: `${resource.resourceId}:${txid}`,
    });
  });

  it("skips disabled networks without opening history pages", async () => {
    const testResource = { ...resource, resourceId: "p2pkh:test", network: "test" as const, address: "1test" };
    const files = createMemoryOwnerFileStore();
    const bundle = await openP2pkhStateRepository(files as never);
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    await repository.putAddress(testResource);
    const listAddressConfirmedHistory = vi.fn(async () => ({ items: [] }));
    const woc = { listAddressConfirmedHistory } as unknown as WocService;
    const sync = createP2pkhTransactionSync({
      getStore: async () => repository,
      getResources: async () => [resource, testResource],
      woc,
      isNetworkEnabled: (network) => network === "main",
    });
    await sync.runOnce(new AbortController().signal);
    expect(listAddressConfirmedHistory).toHaveBeenCalledTimes(1);
  });
});
