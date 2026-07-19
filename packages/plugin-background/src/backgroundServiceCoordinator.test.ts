import { describe, expect, it } from "vitest";
import { createBackgroundServiceCoordinator } from "./backgroundServiceCoordinator.js";

function createClient(overrides: Partial<{
  backgroundRunNow(taskId: string): Promise<{ status: string; reason?: string }>;
  backgroundTrigger(taskId: string, reason: string): Promise<{ status: string; reason?: string }>;
}> = {}) {
  return {
    getIsConnected: () => true,
    getState: () => ({ taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 900_000 } }),
    onStateChange: () => () => undefined,
    onEvent: () => () => undefined,
    backgroundRunNow: async () => ({ status: "accepted" }),
    backgroundTrigger: async () => ({ status: "accepted" }),
    backgroundCancel: async () => ({ status: "ok" }),
    backgroundCancelByKey: async () => ({ status: "ok" }),
    backgroundSettingsUpdate: async () => ({ status: "ok" }),
    ...overrides,
  };
}

describe("BackgroundService Coordinator facade", () => {
  it("keeps a blocked domain trigger fire-and-forget", async () => {
    const client = createClient({
      backgroundTrigger: async () => ({ status: "blocked", reason: "Vault is locked" }),
    });
    const service = createBackgroundServiceCoordinator({ coordinatorClient: client });

    expect(service.trigger("token-bsv21.sync", "resources-ready")).toBeUndefined();
    await Promise.resolve();

    service.dispose?.();
  });

  it("keeps a blocked manual request non-fatal and notifies subscribers", async () => {
    const client = createClient({
      backgroundRunNow: async () => ({ status: "blocked", reason: "Vault is locked" }),
    });
    const service = createBackgroundServiceCoordinator({ coordinatorClient: client });
    let changes = 0;
    service.onChange(() => { changes += 1; });

    expect(service.runNow("token-bsv21.sync")).toBeUndefined();
    await Promise.resolve();

    expect(changes).toBe(2);
    service.dispose?.();
  });
});
