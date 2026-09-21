import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetDataInvalidationEvent, AssetDataNotifier, KeyspaceService, P2pkhUtxoSnapshotResult } from "@keymaster/contracts";
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
  return { available: true, state: "fresh", seq: 1, syncedAt: "2026-09-20T00:00:00.000Z", items };
}

function coordinatorWithSnapshot(items: P2pkhUtxoSnapshotResult["items"], includeTestnet = false) {
  let result = snapshot(items);
  const topicListeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    getBootstrapSnapshot: () => ({ p2pkhSettings: { includeTestnet } }),
    p2pkhUtxosGet: vi.fn(async () => ({ status: "ok" as const, value: result })),
    p2pkhUtxosRefresh: vi.fn(async () => ({ status: "ok" as const, value: result })),
    p2pkhBroadcast: vi.fn(async () => ({ status: "ok" as const, value: { status: "accepted" } })),
    p2pkhSettingsUpdate: vi.fn(async () => ({ status: "ok" as const })),
    setSnapshot(next: P2pkhUtxoSnapshotResult) {
      result = next;
    },
    subscribeTopic(topic: string, handler: (event: unknown) => void) {
      const listeners = topicListeners.get(topic) ?? new Set<(event: unknown) => void>();
      listeners.add(handler);
      topicListeners.set(topic, listeners);
      return () => listeners.delete(handler);
    },
    emitTopic(topic: string, event: unknown) {
      for (const listener of [...(topicListeners.get(topic) ?? [])]) listener(event);
    },
  };
}

function createTestNotifier(): AssetDataNotifier & { emit: ReturnType<typeof vi.fn> } {
  const listeners = new Set<(event: AssetDataInvalidationEvent) => void>();
  const emit = vi.fn((event: AssetDataInvalidationEvent) => {
    queueMicrotask(() => {
      for (const listener of [...listeners]) listener(event);
    });
  });
  return {
    emit,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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

  it("T01/T02/T03/T11：余额 map 按设置成形，未知不等于 0", async () => {
    const storage = createMemoryOwnerFileStore();
    const pending = new Promise<{ status: "ok"; value: P2pkhUtxoSnapshotResult }>((resolve) => {
      queueMicrotask(() => resolve({ status: "ok", value: snapshot([{ txid: "01".repeat(32), vout: 0, value: 1200, height: 10, status: "confirmed", isSpentInMempoolTx: false }]) }));
    });
    const coordinator = coordinatorWithSnapshot([]);
    coordinator.p2pkhUtxosGet.mockImplementation(async () => pending);
    const service = createP2pkhService({ vault, keyspace: keyspace(), messageBus, storage: storage as never, coordinator: coordinator as never });

    const cold = service.balanceBroadcaster.getSnapshot();
    expect(Object.keys(cold.balances)).toEqual(["mainnet"]);
    expect(cold.balances.mainnet?.available).toBe(false);

    await service.getResourceBalance(resource.resourceId);
    const ready = service.balanceBroadcaster.getSnapshot();
    expect(Object.keys(ready.balances)).toEqual(["mainnet"]);
    expect(ready.balances.mainnet).toMatchObject({ total: 1200, available: true });
    service.dispose?.();

    const testnetService = createP2pkhService({
      vault,
      keyspace: keyspace(),
      messageBus,
      storage: createMemoryOwnerFileStore() as never,
      coordinator: coordinatorWithSnapshot([{ txid: "02".repeat(32), vout: 0, value: 300, height: 0, status: "unconfirmed", isSpentInMempoolTx: false }], true) as never,
    });
    await testnetService.getResourceBalance(resource.resourceId);
    const bothNetworks = testnetService.balanceBroadcaster.getSnapshot();
    expect(Object.keys(bothNetworks.balances).sort()).toEqual(["mainnet", "testnet"]);
    expect(bothNetworks.balances.testnet).toMatchObject({ total: 300, available: true });
    testnetService.dispose?.();
  });

  it("T04：切换全局 testnet 设置时立即增删 testnet map 键", async () => {
    const storage = createMemoryOwnerFileStore();
    const coordinator = coordinatorWithSnapshot([{ txid: "03".repeat(32), vout: 0, value: 700, height: 10, status: "confirmed", isSpentInMempoolTx: false }]);
    const service = createP2pkhService({ vault, keyspace: keyspace(), messageBus, storage: storage as never, coordinator: coordinator as never });

    await service.getResourceBalance(resource.resourceId);
    expect(Object.keys(service.balanceBroadcaster.getSnapshot().balances)).toEqual(["mainnet"]);

    coordinator.emitTopic("background.snapshot", {
      type: "background.snapshot.changed",
      p2pkhSettings: { includeTestnet: true },
    });
    await service.getResourceBalance("p2pkh:test");
    expect(Object.keys(service.balanceBroadcaster.getSnapshot().balances).sort()).toEqual(["mainnet", "testnet"]);

    coordinator.emitTopic("background.snapshot", {
      type: "background.snapshot.changed",
      p2pkhSettings: { includeTestnet: false },
    });
    await service.getResourceBalance(resource.resourceId);
    expect(Object.keys(service.balanceBroadcaster.getSnapshot().balances)).toEqual(["mainnet"]);
    service.dispose?.();
  });

  it("T05/T06：广播提交后重算并通知消费方，重算只读 Coordinator 快照", async () => {
    const storage = createMemoryOwnerFileStore();
    const coordinator = coordinatorWithSnapshot([{ txid: "04".repeat(32), vout: 0, value: 1000, height: 10, status: "confirmed", isSpentInMempoolTx: false }]);
    const notifier = createTestNotifier();
    const service = createP2pkhService({ vault, keyspace: keyspace(), messageBus, storage: storage as never, coordinator: coordinator as never, assetDataNotifier: notifier });
    const onDataChanged = vi.fn();
    service.onDataChanged(onDataChanged);

    await service.getResourceBalance(resource.resourceId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = service.balanceBroadcaster.getSnapshot();
    coordinator.setSnapshot(snapshot([{ txid: "05".repeat(32), vout: 0, value: 400, height: 11, status: "confirmed", isSpentInMempoolTx: false }]));
    notifier.emit({ providerId: "p2pkh", publicKeyHex: OWNER, revision: 99, kinds: ["utxo", "balance"] });

    await vi.waitFor(() => expect(service.balanceBroadcaster.getSnapshot().balances.mainnet?.total).toBe(400));
    const after = service.balanceBroadcaster.getSnapshot();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(onDataChanged).toHaveBeenCalled();
    expect(notifier.emit).toHaveBeenCalledWith(expect.objectContaining({ providerId: "p2pkh", publicKeyHex: OWNER, kinds: ["balance"] }));
    expect(coordinator.p2pkhUtxosRefresh).not.toHaveBeenCalled();
    service.dispose?.();
  });

  it("T07/T08：owner 不一致、锁屏和旧 owner 失效事件都不能暴露旧快照", async () => {
    const storage = createMemoryOwnerFileStore();
    const notifier = createTestNotifier();
    const coordinator = coordinatorWithSnapshot([{ txid: "06".repeat(32), vout: 0, value: 900, height: 12, status: "confirmed", isSpentInMempoolTx: false }]);
    let activeOwner = OWNER;
    let vaultStatus: "unlocked" | "locked" = "unlocked";
    const service = createP2pkhService({
      vault: Object.assign({}, vault as unknown as object, { status: () => vaultStatus }) as never,
      keyspace: { ...keyspace(), active: () => ({ activePublicKeyHex: activeOwner }) } as never,
      messageBus,
      storage: storage as never,
      coordinator: coordinator as never,
      assetDataNotifier: notifier,
    });

    await service.getResourceBalance(resource.resourceId);
    const ready = service.balanceBroadcaster.getSnapshot();
    await service.getResourceBalance(resource.resourceId);
    expect(service.balanceBroadcaster.getSnapshot().revision).toBe(ready.revision);

    notifier.emit({ providerId: "p2pkh", publicKeyHex: "03" + "22".repeat(32), revision: 100, kinds: ["balance"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.balanceBroadcaster.getSnapshot().revision).toBe(ready.revision);

    activeOwner = "03" + "22".repeat(32);
    expect(service.balanceBroadcaster.getSnapshot()).toMatchObject({ publicKeyHex: "", balances: {} });
    activeOwner = OWNER;
    vaultStatus = "locked";
    expect(service.balanceBroadcaster.getSnapshot()).toMatchObject({ publicKeyHex: "", balances: {} });
    service.dispose?.();
  });
});
