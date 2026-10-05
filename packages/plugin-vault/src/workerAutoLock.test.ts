import { afterEach, expect, it, vi } from "vitest";
import { createWorkerAutoLock } from "./workerAutoLock.js";

afterEach(() => vi.useRealTimers());
it("does not lock a replacement session from the previous session's deadline", async () => {
  vi.useFakeTimers();
  let epoch = "first";
  let deadline: number | undefined;
  const lock = vi.fn(async () => undefined);
  const runtime = createWorkerAutoLock({
    session: () => ({ sessionEpoch: epoch, runGeneration: "generation", vaultStatus: "unlocked" }),
    timeout: () => 60_000, commitTimeout: () => undefined,
    deadline: () => deadline, commitDeadline: value => { deadline = value; },
    keepUnlocked: () => false, persistTimeout: async () => undefined, publishSettings: () => undefined, lock,
  });
  runtime.reset();
  epoch = "second";
  await vi.advanceTimersByTimeAsync(60_000);
  expect(lock).not.toHaveBeenCalled();
  runtime.reset();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(lock).toHaveBeenCalledOnce();
  runtime.pause();
  expect(deadline).toBeUndefined();
});
it("does not change the deadline or publish settings when persistence fails", async () => {
  const publish = vi.fn();
  const commitTimeout = vi.fn();
  const runtime = createWorkerAutoLock({
    session: () => ({ sessionEpoch: "epoch", runGeneration: "generation", vaultStatus: "unlocked" }),
    timeout: () => 60_000, commitTimeout,
    deadline: () => undefined, commitDeadline: () => undefined, keepUnlocked: () => false,
    persistTimeout: async () => { throw new Error("write failed"); }, publishSettings: publish, lock: async () => undefined,
  });
  await expect(runtime.update("request", { kind: "autolock.settings.update", expectedSessionEpoch: "epoch", settings: { timeoutMs: 60_000 } })).rejects.toThrow("write failed");
  expect(commitTimeout).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});
