import { describe, expect, it, vi } from "vitest";
import { getFatalError, resetFatalErrorForTest } from "@keymaster/runtime";
import { createBackgroundServiceCoordinator } from "./backgroundServiceCoordinator.js";

function createClient(overrides: Partial<{
  backgroundRunNow(taskId: string): Promise<{ status: string; reason?: string | { key: string; fallback: string } }>;
  backgroundTrigger(taskId: string, reason: string): Promise<{ status: string; reason?: string | { key: string; fallback: string } }>;
}> = {}) {
  const topicHandlers = new Set<(event: unknown) => void>();
  return {
    getIsConnected: () => true,
    getState: () => ({ taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 900_000 } }),
    subscribeTopic: (_topic: string, handler: (event: unknown) => void) => { topicHandlers.add(handler); return () => topicHandlers.delete(handler); },
    publishBackgroundSnapshot: (event: unknown) => { for (const handler of topicHandlers) handler(event); },
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
    resetFatalErrorForTest();
    const client = createClient({
      backgroundTrigger: async () => ({ status: "blocked", reason: { key: "background.blocked.unlock", fallback: "Vault is locked" } }),
    });
    const service = createBackgroundServiceCoordinator({ coordinatorClient: client });

    expect(service.trigger("token-bsv21.sync", "resources-ready")).toBeUndefined();
    await Promise.resolve();
    expect(getFatalError()).toBeNull();

    service.dispose?.();
  });

  it("keeps a blocked manual request non-fatal and notifies subscribers", async () => {
    const client = createClient({
      backgroundRunNow: async () => ({ status: "blocked", reason: { key: "background.blocked.unlock", fallback: "Vault is locked" } }),
    });
    const service = createBackgroundServiceCoordinator({ coordinatorClient: client });
    let changes = 0;
    service.onTaskSnapshotsChanged(() => { changes += 1; });

    await expect(service.runNow("token-bsv21.sync")).resolves.toMatchObject({ status: "blocked" });
    await Promise.resolve();

    expect(changes).toBe(2);
    service.dispose?.();
  });

  it("consumes a rejected domain transport and reports it without leaking", async () => {
    resetFatalErrorForTest();
    const report = vi.fn();
    const client = createClient({
      backgroundTrigger: async () => { throw new Error("port closed"); },
    });
    (client as { reportRecoverableCoordinatorFailure?: typeof report }).reportRecoverableCoordinatorFailure = report;
    const service = createBackgroundServiceCoordinator({ coordinatorClient: client });
    expect(service.trigger("token-bsv21.sync", "resources-ready")).toBeUndefined();
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith("background.trigger", expect.any(Error));
    expect(getFatalError()).toBeNull();
    service.dispose?.();
  });

  it("consumes background snapshots with complete UI fields", () => {
    const client = createClient();
    const service = createBackgroundServiceCoordinator({ coordinatorClient: client });
    const snapshots: any[] = [];
    service.onTaskSnapshotsChanged((value) => snapshots.push(value));

    client.publishBackgroundSnapshot({
      topic: "background.snapshot",
      type: "background.snapshot.changed",
      backgroundSnapshotRevision: 1,
      sessionEpoch: "epoch-1",
      snapshots: [{
        id: "task-1",
        pluginId: "plugin-1",
        label: "Sync",
        state: "failed",
        progress: { ratio: 0.3, count: 3 },
        error: "network timeout",
        lastAttemptAt: "2026-07-20T12:00:00.000Z",
        nextRunAt: "2026-07-20T12:05:00.000Z"
      }]
    });

    expect(snapshots.at(-1)?.[0]).toMatchObject({
      id: "task-1",
      state: "failed",
      error: "network timeout",
      lastAttemptAt: "2026-07-20T12:00:00.000Z",
      nextRunAt: "2026-07-20T12:05:00.000Z"
    });
    expect(snapshots.at(-1)?.[0].progress).toEqual({ ratio: 0.3, count: 3 });
    service.dispose?.();
  });
});
