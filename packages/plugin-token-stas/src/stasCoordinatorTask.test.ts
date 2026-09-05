import { describe, expect, it } from "vitest";
import { createStasCoordinatorTask } from "./stasCoordinatorTask.js";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";

describe("STAS Coordinator task", () => {
  it("creates a named task definition", () => {
    const task = createStasCoordinatorTask({ keyspace: {} as never, store: createInMemoryKeyValueStore({ scope: "key", ownerPublicKeyHex: "02" + "11".repeat(32), applicationStorageId: "STAS", schemaVersion: 1, bucketId: "test", bucketGeneration: 1 }), p2pkh: {} as never, woc: {} as never, vault: {} as never });
    expect(task.id).toBe("token-stas.sync"); expect(task.run).toBeTypeOf("function");
  });
});
