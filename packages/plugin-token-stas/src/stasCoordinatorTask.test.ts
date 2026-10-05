import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { createStasCoordinatorTask } from "./stasCoordinatorTask.js";
import { createInMemoryKeyValueStore, withTestStorageBinding } from "@keymaster/runtime";

describe("STAS Coordinator task", () => {
  it("creates a named task definition", () => {
    const task = createStasCoordinatorTask({ walletState: {} as never, stateStore: createInMemoryKeyValueStore(withTestStorageBinding(CENTRAL_STORAGE_DECLARATIONS.tokenStasState)), p2pkh: {} as never, woc: {} as never, vault: {} as never });
    expect(task.id).toBe("token-stas.sync"); expect(task.run).toBeTypeOf("function");
  });
});
