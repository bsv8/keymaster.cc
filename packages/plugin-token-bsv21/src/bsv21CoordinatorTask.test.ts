import { describe, expect, it } from "vitest";
import { createBsv21CoordinatorTask } from "./bsv21CoordinatorTask.js";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";

describe("BSV-21 Coordinator task", () => {
  it("creates a named task definition", () => {
    const task = createBsv21CoordinatorTask({ keyspace: {} as never, store: createInMemoryKeyValueStore({ scope: "key", ownerPublicKeyHex: "02" + "11".repeat(32), applicationStorageId: "BSV21", schemaVersion: 1, bucketId: "test", bucketGeneration: 1 }), p2pkh: {} as never, woc: {} as never, wocService: {} as never, vault: {} as never });
    expect(task.id).toBe("token-bsv21.sync"); expect(task.run).toBeTypeOf("function");
  });
});
