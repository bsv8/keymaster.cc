// packages/plugin-background/src/backgroundServiceCoordinator.ts
// BackgroundService Coordinator Facade
//
// 设计缘由（施工单 002）：
//   - 页面只拥有 runNow/cancel/snapshot/setting facade
//   - 页面不注册或执行任务，仅通过 facade 调用 Coordinator
//   - 设置更新由 coordinator 持久化并广播

import type {
  BackgroundService,
  BackgroundSyncSettings,
  BackgroundTaskSnapshot,
} from "@keymaster/contracts";

// ============================================================
// 1. Types
// ============================================================

/** Coordinator client 最小接口（避免跨包导入）。 */
interface CoordinatorClientLike {
  getIsConnected(): boolean;
  getState(): { taskSnapshots: CoordinatorTaskSnapshotLike[]; scheduleSettings: BackgroundSyncSettings };
  onStateChange(handler: (state: { taskSnapshots: CoordinatorTaskSnapshotLike[]; scheduleSettings: BackgroundSyncSettings }) => void): () => void;
  onEvent(eventType: string, handler: (event: { type: string; snapshots?: CoordinatorTaskSnapshotLike[] }) => void): () => void;
  backgroundRunNow(taskId: string): Promise<{ status: string; message?: string; reason?: string }>;
  backgroundTrigger(taskId: string, reason: string): Promise<{ status: string; message?: string; reason?: string }>;
  backgroundCancel(taskId: string): Promise<{ status: string; message?: string }>;
  backgroundCancelByKey(publicKeyHex: string): Promise<{ status: string; message?: string }>;
  backgroundSettingsUpdate(settings: BackgroundSyncSettings): Promise<{ status: string; message?: string; reason?: string }>;
}

interface CoordinatorTaskSnapshotLike {
  id: string;
  pluginId: string;
  label: string;
  state: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastAttemptAt?: string;
  nextRunAt?: string;
  error?: string;
  blockedReason?: string;
  keyScope?: { publicKeyHex: string; label?: string };
}

export interface BackgroundServiceCoordinatorDeps {
  coordinatorClient: CoordinatorClientLike;
}

// ============================================================
// 2. BackgroundService Coordinator Facade
// ============================================================

/**
 * BackgroundService Coordinator Facade。
 * 设计缘由：页面只拥有 runNow/cancel/snapshot/setting facade。
 */
export function createBackgroundServiceCoordinator(
  deps: BackgroundServiceCoordinatorDeps
): BackgroundService {
  const { coordinatorClient } = deps;

  // 只读 cache
  let cachedSnapshots: BackgroundTaskSnapshot[] = [];
  let cachedSettings: BackgroundSyncSettings = { assetHoldingsIntervalMs: 900_000 };

  // 状态变化监听器
  const changeHandlers = new Set<(snapshots: BackgroundTaskSnapshot[]) => void>();

  // 订阅 Coordinator 状态变化
  const unsubscribeState = coordinatorClient.onStateChange((state: { taskSnapshots: CoordinatorTaskSnapshotLike[]; scheduleSettings: BackgroundSyncSettings }) => {
    cachedSnapshots = state.taskSnapshots.map((s: CoordinatorTaskSnapshotLike) => ({
      id: s.id,
      pluginId: s.pluginId,
      label: s.label,
      state: s.state as BackgroundTaskSnapshot["state"],
      lastStartedAt: s.lastStartedAt,
      lastCompletedAt: s.lastCompletedAt,
      lastAttemptAt: s.lastAttemptAt,
      nextRunAt: s.nextRunAt,
      error: s.error,
      blockedReason: s.blockedReason ? { key: s.blockedReason, fallback: s.blockedReason } : undefined,
      keyScope: s.keyScope,
    }));
    cachedSettings = state.scheduleSettings;
    notifyChange();
  });

  const unsubscribeEvent = coordinatorClient.onEvent("background.snapshot-updated", (event: { type: string; snapshots?: CoordinatorTaskSnapshotLike[] }) => {
    if (event.type === "background.snapshot-updated" && event.snapshots) {
      cachedSnapshots = event.snapshots.map((s: CoordinatorTaskSnapshotLike) => ({
        id: s.id,
        pluginId: s.pluginId,
        label: s.label,
        state: s.state as BackgroundTaskSnapshot["state"],
        lastStartedAt: s.lastStartedAt,
        lastCompletedAt: s.lastCompletedAt,
        lastAttemptAt: s.lastAttemptAt,
        nextRunAt: s.nextRunAt,
        error: s.error,
        blockedReason: s.blockedReason ? { key: s.blockedReason, fallback: s.blockedReason } : undefined,
        keyScope: s.keyScope,
      }));
      notifyChange();
    }
  });

  function notifyChange() {
    const snapshots = [...cachedSnapshots];
    for (const handler of changeHandlers) {
      try { handler(snapshots); } catch { /* noop */ }
    }
  }

  return {
    listSnapshots(): BackgroundTaskSnapshot[] {
      return [...cachedSnapshots];
    },

    onChange(handler: (snapshots: BackgroundTaskSnapshot[]) => void): () => void {
      changeHandlers.add(handler);
      handler([...cachedSnapshots]);
      return () => { changeHandlers.delete(handler); };
    },

    async runNow(taskId: string): Promise<void> {
      const ack = await coordinatorClient.backgroundRunNow(taskId);
      if (ack.status === "already-running" || ack.status === "accepted") return;
      if (ack.status === "blocked") throw new Error(`Task ${taskId} is blocked: ${ack.reason ?? "等待解锁"}`);
      throw new Error(`Run task failed: ${ack.status}${"message" in ack ? ` - ${ack.message}` : ""}`);
    },

    async trigger(taskId: string, reason?: string): Promise<void> {
      const ack = await coordinatorClient.backgroundTrigger(taskId, reason ?? "manual");
      if (ack.status !== "accepted" && ack.status !== "already-running") throw new Error(`Trigger task failed: ${ack.status}`);
    },

    async cancel(taskId: string): Promise<void> {
      const ack = await coordinatorClient.backgroundCancel(taskId);
      if (ack.status !== "accepted" && ack.status !== "ok") {
        throw new Error(`Cancel task failed: ${ack.status}${"message" in ack ? ` - ${ack.message}` : ""}`);
      }
    },

    async cancelByKey(publicKeyHex: string): Promise<void> {
      const ack = await coordinatorClient.backgroundCancelByKey(publicKeyHex);
      if (ack.status !== "accepted" && ack.status !== "ok") throw new Error(`Cancel tasks failed: ${ack.status}`);
    },

    getScheduleSettings(): BackgroundSyncSettings {
      return { ...cachedSettings };
    },

    updateScheduleSettings(settings: BackgroundSyncSettings): void {
      void coordinatorClient.backgroundSettingsUpdate(settings).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "ok") throw new Error(`Schedule update failed: ${ack.status}`);
      });
    },
    dispose: () => { unsubscribeState(); unsubscribeEvent(); changeHandlers.clear(); },
  };
}
