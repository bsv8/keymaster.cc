import { describe, expect, it, vi } from "vitest";
import { createP2pkhCoordinatorTasks } from "./p2pkhCoordinatorTasks.js";

describe("P2PKH Coordinator tasks", () => {
  it("exposes the single confirmed transaction sync handler", () => {
    const keyspace = { requireActiveKey: () => ({ publicKeyHex: "a".repeat(64) }), openOwnerAppStore: vi.fn(async () => ({ stateRepository: {} as IDBDatabase, name: "x", close: vi.fn() })) } as never;
    const registry = { getConfirmedProvider: vi.fn(), listConfirmedProviders: vi.fn(() => []) } as never;
    const tasks = createP2pkhCoordinatorTasks({ keyspace, storage: {} as never, registry, getSelection: () => ({ syncProviderId: null, generation: 0 }), messageBus: {} as never });
    expect(tasks.id).toBe("p2pkh.transactions-sync"); expect(tasks.transactionsSync).toBeTypeOf("function");
  });
});
