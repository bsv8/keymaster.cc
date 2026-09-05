import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageHealthController } from "./storageHealthController.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("StorageHealthController", () => {
  it("retries after backoff and publishes the final ready state", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const statuses: string[] = [];
    const controller = new StorageHealthController({
      random: () => 0,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (timer) => clearTimeout(timer)
    });
    controller.subscribe((snapshot) => statuses.push(snapshot.status));

    await controller.probe(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary provider failure");
    });

    expect(controller.status()).toBe("degraded");
    expect(attempts).toBe(1);
    expect(statuses).toContain("checking");
    expect(statuses).toContain("degraded");

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(attempts).toBe(2);
    expect(controller.status()).toBe("ready");
    expect(statuses.at(-1)).toBe("ready");
    expect(controller.snapshot().retryAttempt).toBe(0);
  });

  it("shares an in-flight probe instead of starting duplicate recovery work", async () => {
    let release!: () => void;
    const operation = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const controller = new StorageHealthController();
    const first = controller.probe(async () => {
      calls += 1;
      await operation;
    });
    const second = controller.retry();

    expect(calls).toBe(1);
    release();
    await expect(first).resolves.toMatchObject({ status: "ready" });
    await expect(second).resolves.toMatchObject({ status: "ready" });
    expect(calls).toBe(1);
  });

  it("does not publish ready until Journal recovery succeeds and retries the whole operation", async () => {
    vi.useFakeTimers();
    let providerAttempts = 0;
    let recoveryAttempts = 0;
    const statuses: string[] = [];
    const controller = new StorageHealthController({
      now: () => 0,
      random: () => 0,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (timer) => clearTimeout(timer)
    });
    controller.subscribe((snapshot) => statuses.push(snapshot.status));

    const first = await controller.probe(
      async () => { providerAttempts += 1; },
      async () => {
        recoveryAttempts += 1;
        if (recoveryAttempts === 1) throw new Error("Journal recovery failed");
      }
    );

    expect(first.status).toBe("degraded");
    expect(providerAttempts).toBe(1);
    expect(recoveryAttempts).toBe(1);
    expect(first.nextProbeAt).toBe(1_000);
    expect(statuses).not.toContain("ready");

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(providerAttempts).toBe(2);
    expect(recoveryAttempts).toBe(2);
    expect(controller.status()).toBe("ready");
    expect(statuses.at(-1)).toBe("ready");
  });

  it("retains deferred ready mode across an automatic retry", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const controller = new StorageHealthController({
      now: () => 0,
      random: () => 0,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (timer) => clearTimeout(timer)
    });

    await controller.probe(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary startup failure");
    }, undefined, { publishReady: false });

    expect(controller.status()).toBe("degraded");
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(attempts).toBe(2);
    expect(controller.status()).toBe("checking");
  });
});
