import { describe, expect, it } from "vitest";
import { createBsv21CoordinatorTask } from "./bsv21CoordinatorTask.js";

describe("BSV-21 Coordinator task", () => {
  it("creates a named task definition", () => {
    const task = createBsv21CoordinatorTask({ keyspace: {} as never, p2pkh: {} as never, woc: {} as never, vault: {} as never });
    expect(task.id).toBe("token-bsv21.sync"); expect(task.run).toBeTypeOf("function");
  });
});
