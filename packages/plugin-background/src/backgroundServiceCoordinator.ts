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
  BackgroundCommandResult,
  CoordinatorCommandResult,
} from "@keymaster/contracts";

// ============================================================
// 1. Types
// ============================================================

/** Coordinator client 最小接口（避免跨包导入）。 */
export interface CoordinatorClientLike {
  getIsConnected(): boolean;
  getState(): { taskSnapshots: CoordinatorTaskSnapshotLike[]; scheduleSettings: BackgroundSyncSettings };
  onStateChange(handler: (state: { taskSnapshots: CoordinatorTaskSnapshotLike[]; scheduleSettings: BackgroundSyncSettings }) => void): () => void;
  onEvent(eventType: string, handler: (event: { type: string; snapshots?: CoordinatorTaskSnapshotLike[] }) => void): () => void;
  backgroundRunNow(taskId: string): Promise<{ status: string; message?: string; reason?: { key: string; fallback: string } | string; retryable?: boolean }>;
  backgroundTrigger(taskId: string, reason: string): Promise<{ status: string; message?: string; reason?: { key: string; fallback: string } | string; retryable?: boolean }>;
  backgroundCancel(taskId: string): Promise<{ status: string; message?: string; reason?: { key: string; fallback: string } | string; retryable?: boolean }>;
  backgroundCancelByKey(publicKeyHex: string): Promise<{ status: string; message?: string; reason?: { key: string; fallback: string } | string; retryable?: boolean }>;
  backgroundSettingsUpdate(settings: BackgroundSyncSettings): Promise<{ status: string; message?: string; reason?: { key: string; fallback: string } | string; retryable?: boolean }>;
  reportRecoverableCoordinatorFailure?(kind: string, cause: unknown): void;
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
  blockedReason?: { key: string; fallback: string };
  keyScope?: { publicKeyHex: string; label?: string };
}

type CoordinatorResultLike = { status: string; message?: string; reason?: { key: string; fallback: string } | string; retryable?: boolean };

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
      blockedReason: s.blockedReason,
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
        blockedReason: s.blockedReason,
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

    async runNow(taskId: string): Promise<BackgroundCommandResult> {
      const result = await coordinatorClient.backgroundRunNow(taskId);
      notifyChange();
      return toBackgroundResult(result);
    },

    trigger(taskId: string, reason?: string): void {
      // trigger 是领域事件 fire-and-forget API。Coordinator 会通过任务快照
      // 广播 accepted / blocked / 失败后的状态；这里绝不可抛出异步异常。
      // 否则 Vault 锁定时的合法 blocked ack 会令调用它的插件崩溃整个页面。
      void coordinatorClient.backgroundTrigger(taskId, reason ?? "manual").then(
        (result) => {
          if (result.status !== "accepted" && result.status !== "ok") {
            coordinatorClient.reportRecoverableCoordinatorFailure?.("background.trigger", result);
          }
        },
        (cause) => {
          coordinatorClient.reportRecoverableCoordinatorFailure?.("background.trigger", cause);
        }
      );
    },

    async cancel(taskId: string): Promise<BackgroundCommandResult> {
      return toBackgroundResult(await coordinatorClient.backgroundCancel(taskId));
    },

    async cancelByKey(publicKeyHex: string): Promise<BackgroundCommandResult> {
      return toBackgroundResult(await coordinatorClient.backgroundCancelByKey(publicKeyHex));
    },

    getScheduleSettings(): BackgroundSyncSettings {
      return { ...cachedSettings };
    },

    async updateScheduleSettings(settings: BackgroundSyncSettings): Promise<BackgroundCommandResult> {
      const result = toBackgroundResult(await coordinatorClient.backgroundSettingsUpdate(settings));
      notifyChange();
      return result;
    },
    dispose: () => { unsubscribeState(); unsubscribeEvent(); changeHandlers.clear(); },
  };
}

function toBackgroundResult(result: CoordinatorResultLike): BackgroundCommandResult {
  if (result.status === "ok") return { status: "accepted" };
  if (result.status === "already-unlocked") return { status: "accepted" };
  if (result.status === "blocked" && result.reason && typeof result.reason !== "string") return { status: "blocked", reason: result.reason };
  if (result.status === "transport-error") return { status: "transport-error", message: result.message ?? "Coordinator connection lost" };
  if (result.status === "validation-error" || result.status === "error") return { status: result.status, message: result.message ?? "Request failed" };
  if (result.status === "accepted" || result.status === "already-running" || result.status === "locked" || result.status === "not-ready" || result.status === "stale-epoch") return { status: result.status };
  return { status: "error", message: result.message ?? "Invalid Coordinator response" };
}
