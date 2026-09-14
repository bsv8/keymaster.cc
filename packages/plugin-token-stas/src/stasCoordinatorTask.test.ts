import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { createStasCoordinatorTask } from "./stasCoordinatorTask.js";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";

describe("STAS Coordinator task", () => {
  it("creates a named task definition", () => {
    const task = createStasCoordinatorTask({ keyspace: {} as never, stateStore: createInMemoryKeyValueStore({ ...CENTRAL_STORAGE_DECLARATIONS.tokenStasState, ownerPublicKeyHex: "02" + "11".repeat(32), bucketId: "test", bucketGeneration: 1 }), p2pkh: {} as never, woc: {} as never, vault: {} as never });
    expect(task.id).toBe("token-stas.sync"); expect(task.run).toBeTypeOf("function");
  });
});
