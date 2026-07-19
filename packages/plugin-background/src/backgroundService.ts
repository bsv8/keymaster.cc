// packages/plugin-background/src/backgroundService.ts
// 后台任务平台实现。
// 施工单 002 硬切换：删除所有 leader 选举逻辑，由 Coordinator 统一管理。
//
// 设计缘由：
//   - 任务注册 -> 调度 -> 运行 -> 状态变更订阅。
//   - 同 task id 不并发：使用独立 runPromise 锁；cancel 必须等旧实例真正退出。
//   - cancel 仅 abort 当前轮；不影响未来定时调度。
//   - 失败不是稳态：保留错误信息后自动回到 idle 等待下一周期。
//   - blocked 是门禁阻塞状态：Vault 锁定、keyspace 初始化中、无 active key。
//   - 页面 visibility 变化与定时器节流恢复时只合并为一次 run。
//   - 施工单 002：删除 leader lock、BroadcastChannel 选举、follower 转发等逻辑。
//     所有 tab 共享 Coordinator，不再需要跨 tab 协调。

import type {
  BackgroundRegistry,
  BackgroundService,
  BackgroundSyncSettings,
  BackgroundTaskContext,
  BackgroundTaskDefinition,
  BackgroundTaskKeyScope,
  BackgroundTaskProgress,
  BackgroundTaskSnapshot,
  BackgroundTaskState,
  PluginLogger
} from "@keymaster/contracts";
import { BACKGROUND_REGISTRY_CAPABILITY, BACKGROUND_SERVICE_CAPABILITY } from "@keymaster/contracts";

interface TaskRuntime {
  def: BackgroundTaskDefinition;
  state: BackgroundTaskState;
  progress?: BackgroundTaskProgress;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastAttemptAt?: string;
  nextRunAt?: string;
  error?: string;
  blockedReason?: import("@keymaster/contracts").I18nText;
  rerunRequested: boolean;
  ctl?: AbortController;
  runPromise?: Promise<void>;
  lastScheduledAt?: number;
}

const ENABLED_PREF_KEY = "background.enabled";
const SCHEDULE_SETTINGS_KEY = "background.sync.settings";

/** 默认设置。 */
const DEFAULT_SYNC_SETTINGS: BackgroundSyncSettings = {
  assetHoldingsIntervalMs: 900_000
};

/** 预设间隔值集合。 */
const VALID_INTERVALS = new Set([300_000, 900_000, 1_800_000, 3_600_000]);

/**
 * 归一化 assetHoldingsIntervalMs。
 */
function normalizeAssetHoldingsInterval(
  value: unknown,
  minIntervalMs: number
): number {
  if (typeof value === "number" && Number.isFinite(value) && VALID_INTERVALS.has(value)) {
    return Math.max(value, minIntervalMs);
  }
  return Math.max(DEFAULT_SYNC_SETTINGS.assetHoldingsIntervalMs, minIntervalMs);
}

/** 普通事件冷却时间：2 分钟。 */
const COOLDOWN_MS = 2 * 60 * 1000;

/**
 * 把 task 定义上的 keyScope 统一归一为对象或 undefined。
 */
function resolveKeyScope(
  def: BackgroundTaskDefinition
): BackgroundTaskKeyScope | undefined {
  const raw = def.keyScope;
  if (!raw) return undefined;
  if (typeof raw === "function") {
    try {
      return raw();
    } catch {
      return undefined;
    }
  }
  return raw;
}

export interface BackgroundServiceHandle extends BackgroundService {
  dispose(): void;
}

export interface CreateBackgroundServiceOptions {
  logger?: PluginLogger;
}

/**
 * 创建后台任务服务。
 * 施工单 002：删除所有 leader 选举逻辑，由 Coordinator 统一管理。
 */
export function createBackgroundService(options: CreateBackgroundServiceOptions = {}): BackgroundServiceHandle {
  const tasks = new Map<string, TaskRuntime>();
  const cooldownMap = new Map<string, number>();
  const listeners = new Set<(s: BackgroundTaskSnapshot[]) => void>();
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const logger = options.logger;

  /**
   * 一次性 migration：清除旧的 background.enabled 偏好。
   */
  function migrateEnabledPreferences(): void {
    try {
      const raw = localStorage.getItem(ENABLED_PREF_KEY);
      if (raw) {
        logger?.info({
          scope: "background.migration",
          event: "clearing-old-enabled-prefs",
          message: "Clearing old background.enabled preferences (migration 001)",
          data: { oldValue: raw }
        });
        localStorage.removeItem(ENABLED_PREF_KEY);
      }
    } catch {
      // 静默失败
    }
  }

  migrateEnabledPreferences();

  function snapshot(task: TaskRuntime): BackgroundTaskSnapshot {
    return {
      id: task.def.id,
      pluginId: task.def.pluginId,
      label: typeof task.def.label === "string" ? task.def.label : task.def.label.fallback,
      state: task.state,
      progress: task.progress,
      lastStartedAt: task.lastStartedAt,
      lastCompletedAt: task.lastCompletedAt,
      lastAttemptAt: task.lastAttemptAt,
      nextRunAt: task.nextRunAt,
      error: task.error,
      blockedReason: task.blockedReason,
      keyScope: resolveKeyScope(task.def)
    };
  }

  function snapshotList(): BackgroundTaskSnapshot[] {
    return [...tasks.values()].map(snapshot);
  }

  function notifyListeners() {
    const list = snapshotList();
    for (const l of listeners) l(list);
  }

  function emitAll() {
    notifyListeners();
  }

  /**
   * 读取后台同步设置。
   */
  function loadScheduleSettings(): BackgroundSyncSettings {
    try {
      const raw = localStorage.getItem(SCHEDULE_SETTINGS_KEY);
      if (!raw) return DEFAULT_SYNC_SETTINGS;
      const obj = JSON.parse(raw) as Partial<BackgroundSyncSettings>;
      return {
        assetHoldingsIntervalMs: normalizeAssetHoldingsInterval(obj.assetHoldingsIntervalMs, 0)
      };
    } catch {
      return DEFAULT_SYNC_SETTINGS;
    }
  }

  /**
   * 保存后台同步设置。
   */
  function saveScheduleSettings(settings: BackgroundSyncSettings): void {
    try {
      localStorage.setItem(SCHEDULE_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // 静默失败。
    }
  }

  function register(def: BackgroundTaskDefinition) {
    if (tasks.has(def.id)) {
      throw new Error(`Background task id "${def.id}" is already registered`);
    }
    const t: TaskRuntime = {
      def,
      state: "idle",
      rerunRequested: false
    };
    tasks.set(def.id, t);
    scheduleNext(t);
    emitAll();
  }

  function list(): BackgroundTaskDefinition[] {
    return [...tasks.values()].map((t) => t.def);
  }

  function getDef(id: string) {
    return tasks.get(id)?.def;
  }

  /**
   * 计算任务的下一次运行时间。
   */
  function scheduleNext(t: TaskRuntime) {
    let interval: number | undefined;

    if (t.def.schedule?.group === "asset-holdings") {
      const settings = loadScheduleSettings();
      interval = settings.assetHoldingsIntervalMs;
    } else {
      interval = t.def.intervalMs;
    }

    if (interval == null) {
      t.nextRunAt = undefined;
      return;
    }

    const now = Date.now();
    const next = new Date(now + interval).toISOString();
    t.nextRunAt = next;
    t.lastScheduledAt = now;
  }

  /**
   * 重新计算所有 asset-holdings 组任务的下一次运行时间。
   */
  function recalculateAssetHoldingsSchedule(): void {
    for (const t of tasks.values()) {
      if (t.def.schedule?.group === "asset-holdings") {
        scheduleNext(t);
      }
    }
    emitAll();
  }

  /**
   * 执行单个任务。
   */
  async function runOne(t: TaskRuntime, reason: string): Promise<void> {
    if (t.runPromise) {
      t.rerunRequested = true;
      return t.runPromise;
    }
    t.state = "queued";
    t.rerunRequested = false;
    t.blockedReason = undefined;
    logger?.info({ scope: "background.task", event: "triggered", message: `Task triggered: ${t.def.id}`, data: { taskId: t.def.id, reason } });
    emitAll();

    const promise = (async () => {
      // canRun 检查
      try {
        if (t.def.canRun) {
          const eligibility = await t.def.canRun();
          if (!eligibility.ready) {
            t.state = "blocked";
            t.blockedReason = eligibility.reason;
            t.lastAttemptAt = new Date().toISOString();
            scheduleNext(t);
            logger?.info({
              scope: "background.task",
              event: "blocked",
              message: `Task blocked: ${t.def.id}`,
              data: { taskId: t.def.id, reason: eligibility.retryOn }
            });
            emitAll();
            return;
          }
        }
      } catch (err) {
        t.state = "blocked";
        t.blockedReason = { key: "background.blocked.canRunError", fallback: err instanceof Error ? err.message : String(err) };
        t.lastAttemptAt = new Date().toISOString();
        scheduleNext(t);
        logger?.error({
          scope: "background.task",
          event: "canRun-error",
          message: `Task canRun error: ${t.def.id}`,
          data: { taskId: t.def.id },
          error: { name: err instanceof Error ? err.name : "Error", message: err instanceof Error ? err.message : String(err) }
        });
        emitAll();
        return;
      }

      t.state = "running";
      t.error = undefined;
      t.blockedReason = undefined;
      t.lastStartedAt = new Date().toISOString();
      t.lastAttemptAt = t.lastStartedAt;
      t.ctl = new AbortController();
      logger?.info({ scope: "background.task", event: "started", message: `Task started: ${t.def.id}`, data: { taskId: t.def.id, reason } });
      emitAll();

      const ctx: BackgroundTaskContext = {
        signal: t.ctl.signal,
        reason,
        reportProgress(progress) {
          t.progress = progress;
          emitAll();
        }
      };

      try {
        await t.def.run(ctx);
        if (t.ctl?.signal.aborted) {
          t.state = "idle";
          logger?.info({ scope: "background.task", event: "canceled", message: `Task canceled: ${t.def.id}`, data: { taskId: t.def.id } });
        } else {
          t.state = "idle";
          t.lastCompletedAt = new Date().toISOString();
          t.progress = undefined;
          t.error = undefined;
          logger?.info({ scope: "background.task", event: "completed", message: `Task completed: ${t.def.id}`, data: { taskId: t.def.id } });
        }
      } catch (err) {
        if (t.ctl?.signal.aborted) {
          t.state = "idle";
          logger?.info({ scope: "background.task", event: "canceled", message: `Task canceled: ${t.def.id}`, data: { taskId: t.def.id } });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          t.error = msg;
          t.state = "idle";
          logger?.error({
            scope: "background.task",
            event: "failed",
            message: `Task failed: ${t.def.id}`,
            data: { taskId: t.def.id },
            error: {
              name: err instanceof Error ? err.name : "Error",
              message: msg
            }
          });
        }
      } finally {
        t.ctl = undefined;
        scheduleNext(t);
        emitAll();
        const cooldownKey = `${t.def.id}:${resolveKeyScope(t.def)?.publicKeyHex ?? "global"}`;
        cooldownMap.set(cooldownKey, Date.now());
      }
    })();

    t.runPromise = promise;
    try {
      await promise;
    } finally {
      t.runPromise = undefined;
      emitAll();
      if (t.rerunRequested && !disposed) {
        t.rerunRequested = false;
        queueMicrotask(() => {
          if (!t.runPromise && !disposed) {
            void runOne(t, "rerun");
          }
        });
      }
    }
  }

  async function awaitIdle(t: TaskRuntime): Promise<void> {
    while (t.runPromise) {
      try {
        await t.runPromise;
      } catch {
        // 内部已处理
      }
    }
  }

  /**
   * 触发任务运行（内部领域事件 API）。
   */
  function trigger(id: string, reason = "interval"): void {
    const t = tasks.get(id);
    if (!t) return;

    // 冷却检查
    if (reason !== "manual" && reason !== "first-sync") {
      const cooldownKey = `${id}:${resolveKeyScope(t.def)?.publicKeyHex ?? "global"}`;
      const lastRun = cooldownMap.get(cooldownKey);
      if (lastRun && Date.now() - lastRun < COOLDOWN_MS) {
        t.rerunRequested = true;
        return;
      }
    }

    void runOne(t, reason);
  }

  /**
   * 立即同步一次（UI 手动 API）。
   */
  function runNow(id: string): void {
    const t = tasks.get(id);
    if (!t) return;
    void runOne(t, "manual");
  }

  /**
   * 取消当前运行。
   * 施工单 002：cancel 必须清除 rerunRequested，避免取消后立即重新运行。
   */
  async function cancel(id: string): Promise<void> {
    const t = tasks.get(id);
    if (!t) return;
    t.rerunRequested = false;
    if (t.ctl) {
      t.ctl.abort();
    }
    await awaitIdle(t);
  }

  /**
   * 取消指定 key namespace 下所有 task。
   */
  async function cancelByKey(publicKeyHex: string): Promise<void> {
    const toCancel: TaskRuntime[] = [];
    for (const t of tasks.values()) {
      const ks = resolveKeyScope(t.def);
      if (ks?.publicKeyHex === publicKeyHex) {
        toCancel.push(t);
      }
    }
    for (const t of toCancel) {
      if (t.ctl) t.ctl.abort();
    }
    for (const t of toCancel) {
      await awaitIdle(t);
    }
  }

  function listSnapshots(): BackgroundTaskSnapshot[] {
    return snapshotList();
  }

  function onChange(handler: (snapshots: BackgroundTaskSnapshot[]) => void): () => void {
    listeners.add(handler);
    handler(snapshotList());
    return () => { listeners.delete(handler); };
  }

  function getScheduleSettings(): BackgroundSyncSettings {
    return loadScheduleSettings();
  }

  function updateScheduleSettings(settings: BackgroundSyncSettings): void {
    const minInterval = getMinIntervalMs();
    const normalized: BackgroundSyncSettings = {
      assetHoldingsIntervalMs: normalizeAssetHoldingsInterval(settings.assetHoldingsIntervalMs, minInterval)
    };
    saveScheduleSettings(normalized);
    recalculateAssetHoldingsSchedule();
  }

  function getMinIntervalMs(): number {
    let min = 0;
    for (const t of tasks.values()) {
      if (t.def.schedule?.group === "asset-holdings" && t.def.schedule.minIntervalMs) {
        min = Math.max(min, t.def.schedule.minIntervalMs);
      }
    }
    return min;
  }

  /**
   * 设置定时器，定期触发任务。
   */
  function startScheduler(): void {
    if (intervalTimer) return;
    intervalTimer = setInterval(() => {
      if (disposed) return;
      const now = Date.now();
      for (const t of tasks.values()) {
        if (t.nextRunAt && new Date(t.nextRunAt).getTime() <= now) {
          void runOne(t, "interval");
        }
      }
    }, 10_000); // 每 10 秒检查一次
  }

  function stopScheduler(): void {
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = undefined;
    }
  }

  /**
   * 处理 Vault 锁定事件。
   */
  function onVaultLocked(): void {
    for (const t of tasks.values()) {
      const ks = resolveKeyScope(t.def);
      if (ks?.publicKeyHex) {
        // Vault 锁定时，标记任务为 blocked
        if (t.state === "running" || t.state === "queued") {
          t.state = "blocked";
          t.blockedReason = { key: "background.blocked.unlock", fallback: "Vault locked" };
          if (t.ctl) t.ctl.abort();
        }
      }
    }
    emitAll();
  }

  /**
   * 处理 Vault 解锁事件。
   */
  function onVaultUnlocked(): void {
    for (const t of tasks.values()) {
      if (t.state === "blocked") {
        const reason = t.blockedReason;
        if (reason && typeof reason === "object" && "key" in reason && reason.key === "background.blocked.unlock") {
          t.state = "idle";
          t.blockedReason = undefined;
          scheduleNext(t);
        }
      }
    }
    emitAll();
  }

  // 启动定时器
  startScheduler();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopScheduler();
    for (const t of tasks.values()) {
      if (t.ctl) t.ctl.abort();
    }
    tasks.clear();
    listeners.clear();
  }

  return {
    listSnapshots,
    onChange,
    runNow,
    trigger,
    cancel,
    cancelByKey,
    getScheduleSettings,
    updateScheduleSettings,
    dispose,
    // Registry 接口
    register,
    list,
    get: getDef
  } as BackgroundServiceHandle & BackgroundRegistry;
}

/**
 * 创建 background bundle（registry + service）。
 * 设计缘由：manifest 需要同时获取 registry 和 service。
 */
export function createBackgroundBundle(options: CreateBackgroundServiceOptions = {}): {
  registry: BackgroundRegistry;
  service: BackgroundServiceHandle;
} {
  const service = createBackgroundService(options);
  return {
    registry: service as unknown as BackgroundRegistry,
    service
  };
}

// Re-export capability keys
export { BACKGROUND_REGISTRY_CAPABILITY, BACKGROUND_SERVICE_CAPABILITY };
