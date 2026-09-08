import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageHealthController } from "./storageHealthController.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("StorageHealthController", () => {
  it("does not retry until the caller explicitly requests it", async () => {
    let attempts = 0;
    const statuses: string[] = [];
    const controller = new StorageHealthController({
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

    expect(controller.snapshot().nextProbeAt).toBeUndefined();
    await expect(controller.retry()).resolves.toMatchObject({ status: "ready" });
    expect(attempts).toBe(2);
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
    expect(first.nextProbeAt).toBeUndefined();
    expect(statuses).not.toContain("ready");

    await controller.retry();

    expect(providerAttempts).toBe(2);
    expect(recoveryAttempts).toBe(2);
    expect(controller.status()).toBe("ready");
    expect(statuses.at(-1)).toBe("ready");
  });

  it("retains deferred ready mode across an explicit retry", async () => {
    let attempts = 0;
    const controller = new StorageHealthController({
      now: () => 0,
    });

    await controller.probe(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary startup failure");
    }, undefined, { publishReady: false });

    expect(controller.status()).toBe("degraded");
    await controller.retry();

    expect(attempts).toBe(2);
    expect(controller.status()).toBe("checking");
  });
});
