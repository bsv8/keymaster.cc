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
  BackgroundSnapshotEvent,
} from "@keymaster/contracts";

// ============================================================
// 1. Types
// ============================================================

interface CoordinatorTaskSnapshotLike {
  id: string;
  pluginId: string;
  label: string;
  state: string;
  progress?: BackgroundTaskSnapshot["progress"];
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastAttemptAt?: string;
  nextRunAt?: string;
  error?: string;
  blockedReason?: BackgroundTaskSnapshot["blockedReason"];
  keyScope?: { publicKeyHex: string; label?: string };
}

type CoordinatorResultLike = { status: string; message?: string; reason?: { key: string; fallback: string } | string; retryable?: boolean };

/** Background 实际使用的最小 RPC 面；不把完整 SessionCoordinatorClient 强制带入插件。 */
export interface CoordinatorClientLike {
  getIsConnected(): boolean;
  subscribeTopic(topic: string, listener: (event: any) => void): () => void;
  backgroundRunNow(taskId: string): Promise<CoordinatorResultLike>;
  backgroundTrigger(taskId: string, reason: string): Promise<CoordinatorResultLike>;
  backgroundCancel(taskId: string): Promise<CoordinatorResultLike>;
  backgroundCancelByKey(publicKeyHex: string): Promise<CoordinatorResultLike>;
  backgroundSettingsUpdate(settings: BackgroundSyncSettings): Promise<CoordinatorResultLike>;
  reportRecoverableCoordinatorFailure?(kind: string, cause: unknown): void;
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
  let taskSnapshotsCache: BackgroundTaskSnapshot[] = [];
  let cachedSettings: BackgroundSyncSettings = { assetHoldingsIntervalMs: 900_000 };

  // 状态变化监听器
  const taskSnapshotsChangedHandlers = new Set<(snapshots: BackgroundTaskSnapshot[]) => void>();

  // 订阅 Coordinator 状态变化
  const unsubscribeTopic = coordinatorClient.subscribeTopic("background.snapshot", (event: BackgroundSnapshotEvent) => {
    taskSnapshotsCache = event.snapshots.map((s) => ({
      id: s.id,
      pluginId: s.pluginId,
      label: s.label,
      state: s.state as BackgroundTaskSnapshot["state"],
      progress: s.progress,
      lastStartedAt: s.lastStartedAt,
      lastCompletedAt: s.lastCompletedAt,
      lastAttemptAt: s.lastAttemptAt,
      nextRunAt: s.nextRunAt,
      error: s.error,
      blockedReason: s.blockedReason,
      keyScope: s.keyScope,
    }));
    if (event.scheduleSettings) cachedSettings = { ...event.scheduleSettings };
    emitTaskSnapshotsChanged();
  });

  function emitTaskSnapshotsChanged() {
    const snapshots = [...taskSnapshotsCache];
    for (const handler of taskSnapshotsChangedHandlers) {
      try { handler(snapshots); } catch { /* noop */ }
    }
  }

  return {
    listTaskSnapshots(): BackgroundTaskSnapshot[] {
      return [...taskSnapshotsCache];
    },

    onTaskSnapshotsChanged(handler: (snapshots: BackgroundTaskSnapshot[]) => void): () => void {
      taskSnapshotsChangedHandlers.add(handler);
      handler([...taskSnapshotsCache]);
      return () => { taskSnapshotsChangedHandlers.delete(handler); };
    },

    async runNow(taskId: string): Promise<BackgroundCommandResult> {
      const result = await coordinatorClient.backgroundRunNow(taskId);
      emitTaskSnapshotsChanged();
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
      emitTaskSnapshotsChanged();
      return result;
    },
    dispose: () => { unsubscribeTopic(); taskSnapshotsChangedHandlers.clear(); },
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
