import type { SessionEpoch, CoordinatorVaultStatus, CoordinatorResponse, CoordinatorBackgroundSyncSettings, CoordinatorTaskSnapshot, BackgroundSnapshotEvent, WocQueueSnapshot } from "@keymaster/contracts";
import { BACKGROUND_MANAGED_SYNC_TASK_IDS, backgroundSyncDefaultIntervalMs, isValidBackgroundSyncIntervalMs, BACKGROUND_TRIGGER_REASON } from "@keymaster/contracts";
export interface TaskRuntime {
  id: string;
  pluginId: string;
  /** 稳定运行单元身份；与用户可启停的产品 id 分开。 */
  unitId: string;
  /** 本次 Worker 装配的运行实例；任务重建后必须变化。 */
  instanceId: string;
  state: "idle" | "queued" | "running" | "blocked";
  controller?: AbortController;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastAttemptAt?: string;
  nextRunAt?: string;
  error?: string;
  blockedReason?: string;
  timer?: ReturnType<typeof setTimeout>;
  keyScope?: { publicKeyHex: string; label?: string } | (() => { publicKeyHex: string; label?: string } | undefined);
  intervalMs?: number;
  /**
   * 同步策略（2026-09-20 智能调度）：
   *   - "managed"：间隔由同步管理设置决定（30 秒 / 1 分钟 / 5 分钟 / 关闭）。
   *   - "smart"：由 WoC 空闲 2 秒的智能调度驱动，没有固定周期。
   *   - "fixed"/缺省：平台固定周期或测试任务，不读取同步管理设置。
   */
  syncPolicy?: "managed" | "smart" | "fixed";
  run?: (context: { signal: AbortSignal; reason: string; reportProgress(progress: unknown): void; assertSessionFresh(): void }) => Promise<void>;
  startedEpoch?: SessionEpoch;
  startedRunGeneration?: string;
  startedPublicKeyHex?: string;
  completion?: Promise<void>;
}
export function normalizeBackgroundSyncSettings(settings: CoordinatorBackgroundSyncSettings | undefined): CoordinatorBackgroundSyncSettings {
  const taskIntervals: Record<string, number> = {};
  for (const taskId of BACKGROUND_MANAGED_SYNC_TASK_IDS) {
    const raw = settings?.taskIntervals?.[taskId];
    if (isValidBackgroundSyncIntervalMs(raw)) taskIntervals[taskId] = raw;
  }
  return { taskIntervals };
}
export interface WorkerBackgroundPorts {
  state(): { taskRuntimes: Map<string, TaskRuntime>; scheduleSettings: CoordinatorBackgroundSyncSettings; vaultStatus: CoordinatorVaultStatus; sessionEpoch: SessionEpoch; runGeneration: string; activePublicKeyHex?: string };
  blockedReason(runtime: TaskRuntime): string | undefined;
  isAvailabilityBlocked(reason: string | undefined): boolean;
  snapshots(): CoordinatorTaskSnapshot[];
  publish(event: Omit<BackgroundSnapshotEvent, "topic" | "backgroundSnapshotRevision">): void;
  queueSnapshot(): WocQueueSnapshot | undefined;
  activate(taskId: string): string | undefined;
  runAudited(taskId: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<void>): Promise<void>;
  persistSettings(settings: CoordinatorBackgroundSyncSettings): Promise<void>;
  commitSettings(settings: CoordinatorBackgroundSyncSettings): void;
}
/** Background owns scheduling and task completion; the authority owns physical I/O leases. */
export function createWorkerBackgroundRuntime(deps: WorkerBackgroundPorts) {
  const WOC_IDLE_SYNC_DEBOUNCE_MS = 2_000;
  let smartSyncIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let smartSyncDebounceMs = WOC_IDLE_SYNC_DEBOUNCE_MS;
  function managedIntervalFor(taskId: string): number {
    const configured = deps.state().scheduleSettings.taskIntervals[taskId];
    return typeof configured === "number" ? configured : backgroundSyncDefaultIntervalMs(taskId);
  }

  function cancelSmartSyncIdleTimer(): void {
    if (smartSyncIdleTimer !== undefined) {
      clearTimeout(smartSyncIdleTimer);
      smartSyncIdleTimer = undefined;
    }
  }

  function isWocQueueIdle(snapshot: WocQueueSnapshot): boolean {
    return snapshot.queued === 0 && snapshot.inFlight === 0;
  }

  function canArmSmartSync(): boolean {
    return deps.state().vaultStatus === "unlocked" && Boolean(deps.state().activePublicKeyHex);
  }

  function armSmartSyncIdleTimer(snapshot: WocQueueSnapshot = deps.queueSnapshot() ?? { queued: 0, inFlight: 0, coordinated: false }): void {
    if (smartSyncIdleTimer !== undefined) return;
    const now = Date.now();
    const backoffDelay = snapshot.backoffUntil && snapshot.backoffUntil > now ? snapshot.backoffUntil - now : 0;
    smartSyncIdleTimer = setTimeout(() => {
      smartSyncIdleTimer = undefined;
      // 计时期间发生锁定 / 切 owner 时不得触发同步。
      if (!canArmSmartSync()) return;
      triggerSmartSync(BACKGROUND_TRIGGER_REASON.IDLE_SYNC);
    }, Math.max(smartSyncDebounceMs, backoffDelay));
  }

  function onWocQueueChanged(snapshot: WocQueueSnapshot): void {
    if (!isWocQueueIdle(snapshot)) {
      cancelSmartSyncIdleTimer();
      return;
    }
    if (canArmSmartSync()) armSmartSyncIdleTimer(snapshot);
  }

  function armSmartSyncIfIdle(): void {
    if (!canArmSmartSync()) return;
    const snapshot = deps.queueSnapshot();
    if (!snapshot || isWocQueueIdle(snapshot)) armSmartSyncIdleTimer(snapshot);
  }

  function triggerSmartSync(reason: string): void {
    for (const runtime of deps.state().taskRuntimes.values()) {
      if (runtime.syncPolicy !== "smart") continue;
      void executeTask(runtime.id, reason).catch(() => undefined);
    }
  }

  function triggerImmediateSync(reason: string): void {
    if (deps.state().vaultStatus !== "unlocked" || !deps.state().activePublicKeyHex) return;
    for (const runtime of deps.state().taskRuntimes.values()) {
      if (runtime.syncPolicy === "smart") {
        void executeTask(runtime.id, reason).catch(() => undefined);
        continue;
      }
      if (runtime.syncPolicy === "managed" && (runtime.intervalMs ?? 0) > 0) {
        void executeTask(runtime.id, reason).catch(() => undefined);
      }
    }
  }

  function scheduleRuntime(runtime: TaskRuntime): void {
    const availabilityBlockedReason = deps.blockedReason(runtime);
    if (availabilityBlockedReason) {
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.timer = undefined;
      runtime.nextRunAt = undefined;
      if (runtime.state !== "running") {
        runtime.state = "blocked";
        runtime.blockedReason = availabilityBlockedReason;
      }
      return;
    }
    // smart 任务没有固定周期：由 WoC 空闲 2 秒的智能调度驱动。
    if (runtime.syncPolicy === "smart") {
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.timer = undefined;
      runtime.nextRunAt = undefined;
      return;
    }
    // 间隔为 0 / 缺省表示关闭自动同步：清除定时器与 nextRunAt，手动仍可触发。
    if (!runtime.intervalMs) {
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.timer = undefined;
      runtime.nextRunAt = undefined;
      return;
    }
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.nextRunAt = new Date(Date.now() + runtime.intervalMs).toISOString();
    runtime.timer = setTimeout(() => { runtime.timer = undefined; void executeTask(runtime.id, "interval"); }, runtime.intervalMs);
  }

  function assertTaskFresh(taskId: string): void {
    const runtime = deps.state().taskRuntimes.get(taskId);
    if (!runtime || runtime.startedEpoch !== deps.state().sessionEpoch || runtime.startedRunGeneration !== deps.state().runGeneration || runtime.startedPublicKeyHex !== deps.state().activePublicKeyHex) {
      throw new Error("stale task session epoch");
    }
  }

  function resolveKeyScope(runtime: TaskRuntime): { publicKeyHex: string; label?: string } | undefined { return typeof runtime.keyScope === "function" ? runtime.keyScope() : runtime.keyScope; }

  async function handleBackgroundRunNow(
    requestId: string,
    request: { kind: "background.run-now"; taskId: string; expectedSessionEpoch: SessionEpoch },
    reason = "manual"
  ): Promise<CoordinatorResponse> {
    if (deps.state().vaultStatus !== "unlocked") {
      return {
        requestId,
        sessionEpoch: deps.state().sessionEpoch,
        ack: { status: "blocked", reason: { key: "background.blocked.unlock", fallback: "Vault is locked" } },
      };
    }

    const runtime = deps.state().taskRuntimes.get(request.taskId);
    if (!runtime) {
      return {
        requestId,
        sessionEpoch: deps.state().sessionEpoch,
        ack: { status: "validation-error", message: `Task not found: ${request.taskId}` },
      };
    }

    // 意图更新与手动触发可能在同一事件循环内交错；不能只依赖上一轮
    // reconcile 已经把 runtime 标成 blocked。入口再次读取当前意图，避免
    // 一个刚被禁用的产品被旧 UI 命令重新拉起。
    const availabilityBlockedReason = deps.blockedReason(runtime);
    if (availabilityBlockedReason) {
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.timer = undefined;
      runtime.nextRunAt = undefined;
      runtime.state = "blocked";
      runtime.blockedReason = availabilityBlockedReason;
      runtime.error = undefined;
      return {
        requestId,
        sessionEpoch: deps.state().sessionEpoch,
        ack: { status: "blocked", reason: { key: "background.blocked.task", fallback: availabilityBlockedReason } },
      };
    }

    if (runtime.state === "running") {
      return {
        requestId,
        sessionEpoch: deps.state().sessionEpoch,
        ack: { status: "already-running" },
      };
    }

    if (runtime.state === "blocked") {
      return {
        requestId,
        sessionEpoch: deps.state().sessionEpoch,
        ack: { status: "blocked", reason: { key: "background.blocked.task", fallback: runtime.blockedReason ?? "Task blocked" } },
      };
    }

    void executeTask(request.taskId, reason);
    return { requestId, sessionEpoch: deps.state().sessionEpoch, ack: { status: "accepted" } };
  }

  async function handleBackgroundTrigger(requestId: string, request: { kind: "background.trigger"; taskId: string; reason: string; expectedSessionEpoch: SessionEpoch }): Promise<CoordinatorResponse> {
    return handleBackgroundRunNow(requestId, { kind: "background.run-now", taskId: request.taskId, expectedSessionEpoch: request.expectedSessionEpoch }, request.reason);
  }

  async function handleBackgroundCancelByKey(requestId: string, request: { kind: "background.cancel-by-key"; publicKeyHex: string; expectedSessionEpoch: SessionEpoch }): Promise<CoordinatorResponse> {
    const cancelled = await cancelTaskRuntimesByKey(request.publicKeyHex);
    deps.publish( { type: "background.snapshot.changed", sessionEpoch: deps.state().sessionEpoch, snapshots: deps.snapshots() });
    return { requestId, sessionEpoch: deps.state().sessionEpoch, ack: cancelled ? { status: "accepted" } : { status: "ok" } };
  }

  async function cancelTaskRuntimesByKey(publicKeyHex: string): Promise<boolean> {
    let cancelled = false;
    const completions: Promise<void>[] = [];
    for (const runtime of deps.state().taskRuntimes.values()) {
      // keyScope 可能是随当前 active owner 动态变化的函数；owner 切换后，
      // 运行中的旧任务不能被误认为属于新 owner。以任务启动时捕获的 owner
      // 为准，确保旧 Contacts/P2PKH 任务及时 abort 并等待 completion。
      const taskOwnerPublicKeyHex = runtime.state === "running" && runtime.startedPublicKeyHex
        ? runtime.startedPublicKeyHex
        : resolveKeyScope(runtime)?.publicKeyHex;
      if (taskOwnerPublicKeyHex !== publicKeyHex) continue;
      runtime.controller?.abort();
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.timer = undefined;
      runtime.state = "idle";
      if (runtime.completion) completions.push(runtime.completion);
      cancelled = true;
    }
    await Promise.allSettled(completions);
    return cancelled;
  }

  async function handleBackgroundCancel(
    requestId: string,
    request: { kind: "background.cancel"; taskId: string; expectedSessionEpoch: SessionEpoch }
  ): Promise<CoordinatorResponse> {
    const runtime = deps.state().taskRuntimes.get(request.taskId);
    if (!runtime) {
      return {
        requestId,
        sessionEpoch: deps.state().sessionEpoch,
        ack: { status: "validation-error", message: `Task not found: ${request.taskId}` },
      };
    }

    if (runtime.state === "running" && runtime.controller) {
      runtime.controller.abort();
      const completion = runtime.completion;
      runtime.state = "idle";
      if (completion) await completion;
      runtime.controller = undefined;

      deps.publish( {
        type: "background.snapshot.changed",
        sessionEpoch: deps.state().sessionEpoch,
        snapshots: deps.snapshots(),
      });

      return {
        requestId,
        sessionEpoch: deps.state().sessionEpoch,
        ack: { status: "accepted" },
      };
    }

    return {
      requestId,
      sessionEpoch: deps.state().sessionEpoch,
      ack: { status: "ok" },
    };
  }

  async function handleBackgroundSettingsUpdate(
    requestId: string,
    request: { kind: "background.settings.update"; settings: CoordinatorBackgroundSyncSettings; expectedSessionEpoch: SessionEpoch }
  ): Promise<CoordinatorResponse> {
    if (
      request.expectedSessionEpoch !== deps.state().sessionEpoch
      && request.expectedSessionEpoch !== "boot"
      && request.expectedSessionEpoch !== "locked"
    ) {
      return { requestId, sessionEpoch: deps.state().sessionEpoch, ack: { status: "stale-epoch" } };
    }
    const rawIntervals = request.settings?.taskIntervals;
    if (!rawIntervals || typeof rawIntervals !== "object" || Array.isArray(rawIntervals)) {
      return { requestId, sessionEpoch: deps.state().sessionEpoch, ack: { status: "validation-error", message: "Invalid sync settings" } };
    }
    for (const [taskId, interval] of Object.entries(rawIntervals)) {
      if (!(BACKGROUND_MANAGED_SYNC_TASK_IDS as readonly string[]).includes(taskId)
        || !isValidBackgroundSyncIntervalMs(interval)) {
        return { requestId, sessionEpoch: deps.state().sessionEpoch, ack: { status: "validation-error", message: `Invalid sync interval for ${taskId}` } };
      }
    }
    const nextSettings = normalizeBackgroundSyncSettings(request.settings);
    await deps.persistSettings(nextSettings);
    deps.commitSettings(nextSettings);
    for (const runtime of deps.state().taskRuntimes.values()) {
      if (runtime.syncPolicy !== "managed") continue;
      runtime.intervalMs = nextSettings.taskIntervals[runtime.id] ?? backgroundSyncDefaultIntervalMs(runtime.id);
      scheduleRuntime(runtime);
    }

    deps.publish( {
      type: "background.snapshot.changed",
      sessionEpoch: deps.state().sessionEpoch,
      snapshots: deps.snapshots(),
    });

    return {
      requestId,
      sessionEpoch: deps.state().sessionEpoch,
      ack: { status: "accepted" },
    };
  }

  async function executeTask(taskId: string, reason: string): Promise<void> {
    const runtime = deps.state().taskRuntimes.get(taskId);
    if (!runtime) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const availabilityBlockedReason = deps.blockedReason(runtime);
    if (availabilityBlockedReason) {
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.timer = undefined;
      runtime.nextRunAt = undefined;
      runtime.state = "blocked";
      runtime.blockedReason = availabilityBlockedReason;
      runtime.error = undefined;
      deps.publish( {
        type: "background.snapshot.changed",
        sessionEpoch: deps.state().sessionEpoch,
        snapshots: deps.snapshots(),
      });
      return;
    }
    // 「同步管理」关闭（间隔 0）表示不自动同步：定时器 / 领域事件 / 解锁
    // 首次同步都不再拉起任务；托盘的手动「立即同步一次」仍然有效。
    if (runtime.syncPolicy === "managed" && (runtime.intervalMs ?? 0) <= 0 && reason !== BACKGROUND_TRIGGER_REASON.MANUAL) {
      return;
    }
    if (deps.state().vaultStatus !== "unlocked" || !deps.state().activePublicKeyHex) {
      runtime.state = "blocked";
      runtime.blockedReason = "Vault is locked";
      scheduleRuntime(runtime);
      return;
    }

    // 旧 completion 未结束时，re-enable 只能等待它在 finally 中恢复调度；
    // 不能由手动/定时入口再开第二个同任务实例。
    if (runtime.completion) return;
    runtime.instanceId = deps.activate(taskId) ?? runtime.instanceId;

    const controller = new AbortController();
    runtime.controller = controller;
    runtime.startedEpoch = deps.state().sessionEpoch;
    runtime.startedRunGeneration = deps.state().runGeneration;
    runtime.startedPublicKeyHex = deps.state().activePublicKeyHex;
    runtime.blockedReason = undefined;
    runtime.error = undefined;
    runtime.state = "running";
    runtime.lastStartedAt = new Date().toISOString();
    runtime.lastAttemptAt = runtime.lastStartedAt;

    deps.publish( {
      type: "background.snapshot.changed",
      sessionEpoch: deps.state().sessionEpoch,
      snapshots: deps.snapshots(),
    });

    let execution!: Promise<void>;
    execution = (async () => {
     try {
      if (runtime.startedEpoch !== deps.state().sessionEpoch || runtime.startedRunGeneration !== deps.state().runGeneration || runtime.startedPublicKeyHex !== deps.state().activePublicKeyHex) throw new Error("stale task epoch");
      if (!runtime.run) throw new Error(`Task ${taskId} has no Coordinator handler`);
      const run = (signal: AbortSignal) => runtime.run!({
        signal,
        reason,
        reportProgress: () => undefined,
        assertSessionFresh: () => assertTaskFresh(taskId),
      });
      await deps.runAudited(taskId, controller.signal, run);
      if (runtime.startedEpoch !== deps.state().sessionEpoch || runtime.startedRunGeneration !== deps.state().runGeneration || runtime.startedPublicKeyHex !== deps.state().activePublicKeyHex) throw new Error("stale task result");
      runtime.state = "idle";
      runtime.lastCompletedAt = new Date().toISOString();
      runtime.error = undefined;
     } catch (err) {
      const currentAvailabilityBlockedReason = deps.blockedReason(runtime);
      if (currentAvailabilityBlockedReason) {
        runtime.state = "blocked";
        runtime.blockedReason = currentAvailabilityBlockedReason;
        runtime.error = undefined;
      } else if (controller.signal.aborted && deps.isAvailabilityBlocked(runtime.blockedReason)) {
        // 依赖恢复发生在旧 completion 结束前：保持“等旧实例退出”
        // 的中间状态，finally 会在同一 completion 上恢复新的定时器。
        runtime.state = "blocked";
        runtime.error = undefined;
      } else if (controller.signal.aborted) {
        runtime.state = "idle";
        runtime.error = "Cancelled";
      } else if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "provider-unavailable") {
        runtime.state = "blocked";
        runtime.blockedReason = err instanceof Error ? err.message : "Confirmed provider unavailable";
        runtime.error = runtime.blockedReason;
      } else {
        runtime.state = "idle";
        runtime.error = err instanceof Error ? err.message : String(err);
      }
     } finally {
      // 同一 Task 在旧 owner completion 尚未结束时可能已经被新 owner
      // 重新启动；旧 completion 不能覆盖新 execution 的 controller/state。
      if (runtime.completion !== execution) return;
      runtime.controller = undefined;

      const finalAvailabilityBlockedReason = deps.blockedReason(runtime);
      // 依赖或作用域仍不可用时，旧 completion 不得重写为 idle。
      if (finalAvailabilityBlockedReason) {
        runtime.state = "blocked";
        runtime.blockedReason = finalAvailabilityBlockedReason;
        runtime.error = undefined;
      // 若当前 Vault 已锁定或 epoch 已变化，保留 blocked，不得把任务重写为 idle
      } else if (deps.state().vaultStatus !== "unlocked" ||
          runtime.startedEpoch !== deps.state().sessionEpoch ||
          runtime.startedRunGeneration !== deps.state().runGeneration ||
          runtime.startedPublicKeyHex !== deps.state().activePublicKeyHex) {
        runtime.state = "blocked";
        runtime.blockedReason = "Vault is locked";
      } else if (deps.isAvailabilityBlocked(runtime.blockedReason)) {
        // 依赖已恢复且旧任务退出后才允许重新排程。
        runtime.state = "idle";
        runtime.blockedReason = undefined;
        runtime.error = undefined;
        scheduleRuntime(runtime);
      } else if (!controller.signal.aborted && runtime.state !== "blocked") {
        // 仅当任务所属 session 仍有效且未 abort 时才恢复 idle/排程
        scheduleRuntime(runtime);
      }

      // 智能调度：smart 任务完成后，若 WoC 队列已空闲，从「任务完成」
      // 这一刻重新计时 2 秒；任务运行期间的队列事件已把计时取消。
      // 门禁：锁定 / 无 active key / 任务所属 session 已失效时不得重新计时，
      // 否则锁定时被 abort 的任务会在 finally 里把计时器重新挂起来。
      if (runtime.syncPolicy === "smart"
        && runtime.state !== "blocked"
        && deps.state().vaultStatus === "unlocked"
        && deps.state().activePublicKeyHex
        && runtime.startedEpoch === deps.state().sessionEpoch
        && runtime.startedRunGeneration === deps.state().runGeneration
        && runtime.startedPublicKeyHex === deps.state().activePublicKeyHex) {
        armSmartSyncIfIdle();
      }

      deps.publish( {
        type: "background.snapshot.changed",
        sessionEpoch: deps.state().sessionEpoch,
        snapshots: deps.snapshots(),
      });
     }
    })();
    runtime.completion = execution;
    await execution;
    runtime.completion = undefined;
  }
  return { managedIntervalFor, cancelSmartSyncIdleTimer, isWocQueueIdle, canArmSmartSync, armSmartSyncIdleTimer, onWocQueueChanged, armSmartSyncIfIdle, triggerSmartSync, triggerImmediateSync, scheduleRuntime, assertTaskFresh, resolveKeyScope, handleBackgroundRunNow, handleBackgroundTrigger, handleBackgroundCancelByKey, cancelTaskRuntimesByKey, handleBackgroundCancel, handleBackgroundSettingsUpdate, executeTask, resetDebounce: () => { smartSyncDebounceMs = WOC_IDLE_SYNC_DEBOUNCE_MS; }, setDebounce: (ms: number) => { smartSyncDebounceMs = Math.max(0, Math.floor(ms)); }, smartState: () => ({ pending: smartSyncIdleTimer !== undefined, debounceMs: smartSyncDebounceMs }) };
}
