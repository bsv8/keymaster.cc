import { describe, expect, it } from "vitest";
import { createFinalIoAudit } from "./finalIoAudit.js";

describe("final I/O audit", () => {
  it("aggregates admitted outcomes and does not double-finish one boundary", () => {
    const audit = createFinalIoAudit();
    const completed = audit.begin("p2pkh.broadcast");
    completed.finish("completed");
    completed.finish("unknown");
    const unknown = audit.begin("sat.operation");
    unknown.finish("unknown");

    expect(audit.snapshot()).toEqual({
      operations: {
        "p2pkh.broadcast": { admitted: 1, completed: 1, failed: 0, unknown: 0 },
        "sat.operation": { admitted: 1, completed: 0, failed: 0, unknown: 1 },
      },
    });
  });
});
