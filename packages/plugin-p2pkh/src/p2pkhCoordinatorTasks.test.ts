import { describe, expect, it, vi } from "vitest";
import { createP2pkhCoordinatorTasks } from "./p2pkhCoordinatorTasks.js";

describe("P2PKH Coordinator tasks", () => {
  it("exposes real recent and backfill handlers", () => {
    const keyspace = { requireActiveKey: () => ({ publicKeyHex: "a".repeat(64) }), openKeyStorage: vi.fn(async () => ({ db: {} as IDBDatabase, name: "x", close: vi.fn() })) } as never;
    const tasks = createP2pkhCoordinatorTasks({ keyspace, woc: {} as never, messageBus: {} as never });
    expect(tasks.recent).toBeTypeOf("function"); expect(tasks.backfill).toBeTypeOf("function");
  });
});
