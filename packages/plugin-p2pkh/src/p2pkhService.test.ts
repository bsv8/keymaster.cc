import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyspaceService, P2pkhUtxoSnapshotResult } from "@keymaster/contracts";
import { createMemoryOwnerFileStore } from "./storage/testSupport/memoryOwnerFileStore.js";
import { createP2pkhService } from "./p2pkhService.js";
import { createP2pkhStateRepository, disposeP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import type { P2pkhKeyResource } from "./p2pkhContracts.js";

const OWNER = "02" + "11".repeat(32);
const ADDRESS = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const resource: P2pkhKeyResource = { resourceId: "p2pkh:main", publicKeyHex: OWNER, label: "test", address: ADDRESS, network: "main", createdAt: new Date(0).toISOString(), generation: 0 };

function keyspace(): KeyspaceService {
  return {
    active: () => ({ activePublicKeyHex: OWNER }),
    getKey: async () => ({ publicKeyHex: OWNER, label: "test", capabilities: ["p2pkh"], createdAt: new Date(0).toISOString() }),
    onActiveKeyChanged: () => () => undefined,
  } as unknown as KeyspaceService;
}

const vault = {
  status: () => "unlocked",
  createActiveKeyCrypto: async () => ({ deriveP2pkhAddress: async () => ({ publicKeyHex: OWNER, address: ADDRESS }) }),
} as never;
const messageBus = { publish: () => undefined, subscribe: () => () => undefined } as never;

function snapshot(items: P2pkhUtxoSnapshotResult["items"] = []): P2pkhUtxoSnapshotResult {
  return { available: true, syncedAt: "2026-09-20T00:00:00.000Z", items };
}

function coordinatorWithSnapshot(items: P2pkhUtxoSnapshotResult["items"]) {
  const result = snapshot(items);
  return {
    getBootstrapSnapshot: () => ({}),
    p2pkhUtxosGet: vi.fn(async () => ({ status: "ok" as const, value: result })),
    p2pkhUtxosRefresh: vi.fn(async () => ({ status: "ok" as const, value: result })),
    p2pkhBroadcast: vi.fn(async () => ({ status: "ok" as const, value: { status: "accepted" } })),
    p2pkhSettingsUpdate: vi.fn(async () => ({ status: "ok" as const })),
  };
}

afterEach(() => {
  disposeP2pkhStateRepository();
});

describe("P2PKH service (snapshot + history)", () => {
  it("lists resources and history from the state repository", async () => {
    const storage = createMemoryOwnerFileStore();
    const repository = createP2pkhStateRepository(await openP2pkhStateRepository(storage as never));
    await repository.putAddress(resource);
    const txid = "aa".repeat(32);
    await repository.replaceHistory(resource, [{ txid, height: 10 }]);
    const service = createP2pkhService({ vault, keyspace: keyspace(), messageBus, storage: storage as never, coordinator: coordinatorWithSnapshot([]) as never });
    await service.rehydrate();
    expect((await service.listResources()).map((row) => row.resourceId)).toContain("p2pkh:main");
    expect((await service.listHistory?.({}))?.map((row) => row.txid)).toContain(txid);
    const page = await service.listHistoryPage?.({ resourceId: resource.resourceId });
    expect(page?.items.map((row) => row.txid)).toContain(txid);
    service.dispose?.();
  });

  it("computes the balance breakdown from the coordinator snapshot minus active claims", async () => {
    const storage = createMemoryOwnerFileStore();
    const txA = "bb".repeat(32);
    const txB = "cc".repeat(32);
    const coordinator = coordinatorWithSnapshot([
      { txid: txA, vout: 0, value: 1000, height: 100, status: "confirmed", isSpentInMempoolTx: false },
      { txid: txB, vout: 0, value: 500, height: 0, status: "unconfirmed", isSpentInMempoolTx: false },
    ]);
    const repository = createP2pkhStateRepository(await openP2pkhStateRepository(storage as never));
    await repository.putAddress(resource);
    const now = new Date(0).toISOString();
    await repository.prepareLocalSubmission({
      submission: {
        id: "sub-1", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main",
        txid: "dd".repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved",
        inputOutpointKeys: [`${txA}:0`], ownOutputs: [], createdAt: now, updatedAt: now, attempts: [],
      },
      claims: [{ id: `${resource.resourceId}:${txA}:0`, submissionId: "sub-1", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: txA, vout: 0, outpointKey: `${txA}:0`, value: 1000, state: "active", createdAt: now, updatedAt: now }],
    });
    const service = createP2pkhService({ vault, keyspace: keyspace(), messageBus, storage: storage as never, coordinator: coordinator as never });
    const breakdown = await service.getBalanceBreakdown?.("main");
    expect(breakdown).toMatchObject({ confirmed: 1000, unconfirmed: 500, spendable: 500, pendingInputClaims: 1000 });
    const balance = await service.getResourceBalance(resource.resourceId);
    expect(balance.total).toBe(500);
    expect(balance.available).toBe(true);
    service.dispose?.();
  });

  it("allocates from refreshed snapshot UTXOs excluding mempool-spent outputs", async () => {
    const storage = createMemoryOwnerFileStore();
    const txid = "ee".repeat(32);
    const mempoolTxid = "ff".repeat(32);
    const coordinator = coordinatorWithSnapshot([
      { txid, vout: 0, value: 5000, height: 100, status: "confirmed", isSpentInMempoolTx: false },
      { txid: mempoolTxid, vout: 0, value: 99999, height: 0, status: "unconfirmed", isSpentInMempoolTx: true },
    ]);
    const repository = createP2pkhStateRepository(await openP2pkhStateRepository(storage as never));
    await repository.putAddress(resource);
    const service = createP2pkhService({ vault, keyspace: keyspace(), messageBus, storage: storage as never, coordinator: coordinator as never });
    const allocation = await service.allocateUtxos({ assetId: "bsv", amountSatoshis: 100 });
    expect(allocation.selected).toHaveLength(1);
    expect(allocation.selected[0]).toMatchObject({ txid, value: 5000 });
    expect(coordinator.p2pkhUtxosRefresh).toHaveBeenCalled();
    service.dispose?.();
  });

  it("exposes local transactions and input-claim pages", async () => {
    const storage = createMemoryOwnerFileStore();
    const repository = createP2pkhStateRepository(await openP2pkhStateRepository(storage as never));
    await repository.putAddress(resource);
    const now = new Date(0).toISOString();
    await repository.prepareLocalSubmission({
      submission: {
        id: "sub-page", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main",
        txid: "11".repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved",
        inputOutpointKeys: [], ownOutputs: [], createdAt: now, updatedAt: now, attempts: [],
      },
      claims: [{ id: `${resource.resourceId}:${"11".repeat(32)}:0`, submissionId: "sub-page", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, value: 10, state: "active", createdAt: now, updatedAt: now }],
    });
    const service = createP2pkhService({ vault, keyspace: keyspace(), messageBus, storage: storage as never, coordinator: coordinatorWithSnapshot([]) as never });
    expect((await service.listLocalTransactions?.({}))?.map((row) => row.id)).toContain("sub-page");
    expect((await service.listLocalTransactionsPage?.({ resourceId: resource.resourceId }))?.items.map((row) => row.id)).toContain("sub-page");
    expect((await service.listLocalInputClaimsPage?.({ resourceId: resource.resourceId }))?.items).toHaveLength(1);
    service.dispose?.();
  });
});
