import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { createBsv21CoordinatorTask } from "./bsv21CoordinatorTask.js";
import { createInMemoryKeyValueStore, withTestStorageBinding } from "@keymaster/runtime";

describe("BSV-21 Coordinator task", () => {
  it("creates a named task definition", () => {
    const task = createBsv21CoordinatorTask({ keyspace: {} as never, stateStore: createInMemoryKeyValueStore(withTestStorageBinding(CENTRAL_STORAGE_DECLARATIONS.tokenBsv21State)), p2pkh: {} as never, woc: {} as never, wocService: {} as never, vault: {} as never });
    expect(task.id).toBe("token-bsv21.sync"); expect(task.run).toBeTypeOf("function");
  });
});
