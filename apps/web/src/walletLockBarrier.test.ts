import { describe, expect, it } from "vitest";
import { WalletLockBarrier } from "./walletLockBarrier.js";
import type { WalletLockCleanup } from "@keymaster/contracts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("wallet lock cleanup barrier", () => {
  it("publishes locked cleanup immediately and waits for every page and worker", async () => {
    const states: (WalletLockCleanup | undefined)[] = [];
    const barrier = new WalletLockBarrier(state => states.push(state));
    barrier.register("a"); barrier.register("b");
    const exit = deferred();
    let cleanupStarted = false;
    const cleanup = barrier.begin("locked-1", [{ label: "service", run: () => { cleanupStarted = true; return exit.promise; } }]);
    expect(cleanupStarted).toBe(false);
    expect(states[0]).toMatchObject({ phase: "pending" });
    barrier.report("a", "locked-1", 1);
    barrier.report("b", "old-epoch", 1);
    exit.resolve(); await cleanup;
    expect(barrier.snapshot()?.phase).toBe("pending");
    barrier.report("b", "locked-1", 1);
    expect(barrier.snapshot()).toBeUndefined();
    barrier.reset();
  });

  it("keeps failed cleanup locked and retries only failed steps with new page acknowledgements", async () => {
    const barrier = new WalletLockBarrier(() => {});
    barrier.register("page");
    let attempts = 0, completed = 0;
    await barrier.begin("epoch", [
      { label: "done", run: async () => { completed++; } },
      { label: "retry", run: async () => { if (++attempts === 1) throw new Error("connection busy"); } },
    ]);
    expect(barrier.snapshot()).toMatchObject({ phase: "failed", error: "retry: connection busy" });
    await barrier.retry();
    barrier.report("page", "epoch", 1);
    expect(barrier.snapshot()).toMatchObject({ phase: "pending", attempt: 2 });
    barrier.report("page", "epoch", 2);
    expect(barrier.snapshot()).toBeUndefined();
    expect(attempts).toBe(2); expect(completed).toBe(1);
    barrier.reset();
  });

  it("reports the very first failure before other cleanup settles and retains details during retry", async () => {
    const failed = deferred();
    const blocker = deferred();
    const barrier = new WalletLockBarrier(state => { if (state?.phase === "failed") failed.resolve(); });
    let attempts = 0;
    const first = barrier.begin("epoch", [
      { label: "broken-service", run: async () => { if (++attempts === 1) throw new Error("first-exit-failed"); } },
      { label: "still-exiting", run: () => blocker.promise },
    ]);
    await failed.promise;
    expect(barrier.snapshot()).toMatchObject({ phase: "failed", error: "broken-service: first-exit-failed" });
    expect(barrier.snapshot()?.diagnostics).toContain("first-exit-failed");
    expect(barrier.snapshot()?.diagnostics).toContain("attempt=1 source=broken-service");
    const retry = barrier.retry();
    expect(barrier.snapshot()?.phase).toBe("pending");
    expect(barrier.snapshot()?.diagnostics).toContain("first-exit-failed");
    blocker.resolve(); await Promise.all([first, retry]);
    expect(barrier.snapshot()).toBeUndefined();
    barrier.reset();
  });

  it("reports timeouts without duplicating an in-flight exit on retry", async () => {
    const barrier = new WalletLockBarrier(() => {}, 15);
    const exit = deferred(); let exits = 0;
    const first = barrier.begin("epoch", [{ label: "plugin", run: () => { exits++; return exit.promise; } }]);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(barrier.snapshot()).toMatchObject({ phase: "failed" });
    const second = barrier.retry();
    expect(barrier.snapshot()).toMatchObject({ phase: "pending", attempt: 2 });
    exit.resolve(); await Promise.all([first, second]);
    expect(exits).toBe(1); expect(barrier.snapshot()).toBeUndefined();
    barrier.reset();
  });

  it("surfaces page errors and removes physically closed participants", async () => {
    const barrier = new WalletLockBarrier(() => {});
    barrier.register("page");
    await barrier.begin("epoch", []);
    barrier.report("page", "epoch", 1, "plugin cleanup failed");
    expect(barrier.snapshot()).toMatchObject({ phase: "failed", error: "plugin cleanup failed" });
    barrier.remove("page");
    expect(barrier.snapshot()).toBeUndefined();
    barrier.reset();
  });
});
