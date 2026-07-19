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

    runNow(taskId: string): void {
      // BackgroundService 的调用方（包括 React event handler）按契约不会 await
      // 这个内部命令。blocked 是正常的门禁结果，不能让它变成
      // global.unhandledrejection 并触发应用的 fatal crash page。
      void coordinatorClient.backgroundRunNow(taskId).then(
        () => notifyChange(),
        () => notifyChange()
      );
    },

    trigger(taskId: string, reason?: string): void {
      // trigger 是领域事件 fire-and-forget API。Coordinator 会通过任务快照
      // 广播 accepted / blocked / 失败后的状态；这里绝不可抛出异步异常。
      // 否则 Vault 锁定时的合法 blocked ack 会令调用它的插件崩溃整个页面。
      void coordinatorClient.backgroundTrigger(taskId, reason ?? "manual").then(
        () => undefined,
        () => undefined
      );
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
      // 同样保持 void 契约：状态更新或连接失败会由 Coordinator state 广播，
      // 而不是从一个未 await 的 UI 回调中泄漏 rejection。
      void coordinatorClient.backgroundSettingsUpdate(settings).then(
        () => undefined,
        () => undefined
      );
    },
    dispose: () => { unsubscribeState(); unsubscribeEvent(); changeHandlers.clear(); },
  };
}
