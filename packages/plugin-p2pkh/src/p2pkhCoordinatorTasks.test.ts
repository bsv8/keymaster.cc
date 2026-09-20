import { afterEach, describe, expect, it, vi } from "vitest";
import { createP2pkhCoordinatorTasks } from "./p2pkhCoordinatorTasks.js";
import { createP2pkhStateRepository, disposeP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { createMemoryOwnerFileStore } from "./storage/testSupport/memoryOwnerFileStore.js";

const OWNER = "02" + "11".repeat(32);
const resource = {
  resourceId: "p2pkh:main",
  publicKeyHex: OWNER,
  label: "test",
  address: "1abc",
  network: "main" as const,
  createdAt: new Date(0).toISOString(),
  generation: 0,
};

afterEach(() => {
  disposeP2pkhStateRepository();
});

describe("P2PKH Coordinator tasks", () => {
  it("exposes the transactions-sync task identity", () => {
    const storage = createMemoryOwnerFileStore();
    const woc = { listAddressConfirmedHistory: vi.fn(async () => ({ items: [] })) } as never;
    const tasks = createP2pkhCoordinatorTasks({ keyspace: {} as never, storage: storage as never, woc, messageBus: {} as never });
    expect(tasks.id).toBe("p2pkh.transactions-sync");
    expect(tasks.unitId).toBe("p2pkh.coordinator-worker");
    expect(tasks.transactionsSync).toBeTypeOf("function");
    expect(tasks.run).toBeTypeOf("function");
  });

  it("runs history sync through WoC for stored resources", async () => {
    const storage = createMemoryOwnerFileStore();
    const bundle = await openP2pkhStateRepository(storage as never);
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    const txid = "aa".repeat(32);
    const woc = {
      listAddressConfirmedHistory: vi.fn(async () => ({ items: [{ txid, height: 10 }] })),
    };
    const tasks = createP2pkhCoordinatorTasks({ keyspace: {} as never, storage: storage as never, woc: woc as never });
    const result = await tasks.run(new AbortController().signal);
    expect(result.resources).toBe(1);
    expect(result.transactions).toBe(1);
    expect(woc.listAddressConfirmedHistory).toHaveBeenCalledWith(
      "main",
      resource.address,
      expect.objectContaining({ limit: 100 }),
      expect.objectContaining({ priority: "background" }),
    );
    const history = await repository.listHistory({ resourceId: resource.resourceId });
    expect(history.map((row) => row.txid)).toEqual([txid]);
  });

  it("skips disabled networks", async () => {
    const storage = createMemoryOwnerFileStore();
    const bundle = await openP2pkhStateRepository(storage as never);
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    await repository.putAddress({ ...resource, resourceId: "p2pkh:test", network: "test" as const, address: "1test" });
    const woc = { listAddressConfirmedHistory: vi.fn(async () => ({ items: [] })) };
    const tasks = createP2pkhCoordinatorTasks({
      keyspace: {} as never,
      storage: storage as never,
      woc: woc as never,
      isNetworkEnabled: (network) => network === "main",
    });
    await tasks.run(new AbortController().signal);
    expect(woc.listAddressConfirmedHistory).toHaveBeenCalledTimes(1);
  });
});
