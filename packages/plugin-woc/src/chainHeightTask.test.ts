import { describe, expect, it, vi } from "vitest";
import { emptyChainHeightSnapshot } from "@keymaster/contracts";
import { createChainHeightTask } from "./chainHeightTask.js";

describe("chain height task", () => {
  it("does not publish a read that finishes after session revocation", async () => {
    let resolveHeight!: (height: number) => void;
    let active = true;
    const publish = vi.fn();
    const task = createChainHeightTask({ network: () => "main", readHeight: () => new Promise(resolve => { resolveHeight = resolve; }), snapshot: () => emptyChainHeightSnapshot(), publish });
    const running = task.run({ signal: new AbortController().signal, reason: "manual", reportProgress: () => {}, assertSessionFresh: () => { if (!active) throw new Error("Session revoked"); } });
    active = false;
    resolveHeight(900_000);
    await expect(running).rejects.toThrow("Session revoked");
    expect(publish).not.toHaveBeenCalled();
  });

  it("preserves the previous snapshot when the provider returns invalid data", async () => {
    const snapshot = { ...emptyChainHeightSnapshot(), height: 899_999, available: true, revision: 3 };
    const publish = vi.fn();
    const task = createChainHeightTask({ network: () => "main", readHeight: async () => -1, snapshot: () => snapshot, publish });
    await expect(task.run({ signal: new AbortController().signal, reason: "manual", reportProgress: () => {} })).rejects.toThrow("invalid height");
    expect(publish).not.toHaveBeenCalled();
  });
});
