import type { P2pkhCoordinatorControl } from "@keymaster/contracts";
import type { P2pkhSyncSnapshot } from "./p2pkhContracts.js";
import { P2PKH_TASK_TRANSACTIONS_SYNC } from "./p2pkhService.js";

type SyncStatusCoordinator = Pick<P2pkhCoordinatorControl, "getBootstrapSnapshot" | "subscribeTopic">;

export function readP2pkhSyncStatus(coordinator: Pick<SyncStatusCoordinator, "getBootstrapSnapshot">): P2pkhSyncSnapshot {
  const task = coordinator.getBootstrapSnapshot().taskSnapshots.find((snapshot) => snapshot.id === P2PKH_TASK_TRANSACTIONS_SYNC);
  const status: P2pkhSyncSnapshot["status"] = !task
    ? "idle"
    : task.state === "running"
      ? "syncing"
      : task.state === "blocked"
        ? "blocked"
        : task.error
          ? "failed"
          : task.lastCompletedAt
            ? "ok"
            : "idle";
  const blockedReason = task?.blockedReason;
  const error = (typeof blockedReason === "string" ? blockedReason : blockedReason?.fallback) ?? task?.error;
  return {
    status,
    ...(task?.lastCompletedAt === undefined ? {} : { lastCompletedAt: task.lastCompletedAt }),
    ...(error === undefined ? {} : { error }),
  };
}

export function subscribeP2pkhSyncStatus(coordinator: Pick<SyncStatusCoordinator, "subscribeTopic">, invalidate: () => void): () => void {
  return coordinator.subscribeTopic("background.snapshot", invalidate);
}
