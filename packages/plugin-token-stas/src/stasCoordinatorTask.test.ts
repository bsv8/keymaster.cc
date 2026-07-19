import { describe, expect, it } from "vitest";
import { createStasCoordinatorTask } from "./stasCoordinatorTask.js";

describe("STAS Coordinator task", () => {
  it("creates a named task definition", () => {
    const task = createStasCoordinatorTask({ keyspace: {} as never, p2pkh: {} as never, woc: {} as never, vault: {} as never });
    expect(task.id).toBe("token-stas.sync"); expect(task.run).toBeTypeOf("function");
  });
});
