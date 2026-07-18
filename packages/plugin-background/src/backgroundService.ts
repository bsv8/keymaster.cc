// packages/plugin-background/src/backgroundService.ts
// 后台任务平台实现。
// 设计缘由：
//   - 任务注册 -> 调度 -> 运行 -> 状态变更订阅。
//   - 同 task id 不并发：使用独立 runPromise 锁；cancel 必须等旧实例真正退出。
//   - cancel 仅 abort 当前轮；不影响未来定时调度。
//   - 失败不是稳态：保留错误信息后自动回到 idle 等待下一周期。
//   - blocked 是门禁阻塞状态：Vault 锁定、keyspace 初始化中、无 active key。
//   - 页面 visibility 变化与定时器节流恢复时只合并为一次 run。
//   - leader lock：浏览器环境优先 Web Locks（FIFO 互斥）；不支持时回退
//     BroadcastChannel + tabId 选举；非浏览器/无 BroadcastChannel 时单进程
//     直接是 leader。
//   - follower 标签页的 runNow/cancel 必须转发到 leader。

import type {
  BackgroundRegistry,
  BackgroundRunEligibility,
  BackgroundService,
  BackgroundSyncSettings,
  BackgroundTaskContext,
  BackgroundTaskDefinition,
  BackgroundTaskKeyScope,
  BackgroundTaskProgress,
  BackgroundTaskSchedule,
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
  /** 上次尝试时间（无论成功或失败）。 */
  lastAttemptAt?: string;
  nextRunAt?: string;
  /** 上次错误信息；下次成功后清除。 */
  error?: string;
  /**
   * 阻塞原因（仅 state="blocked" 时有值）。
   * 设计缘由：让用户理解为什么任务没有运行，而不是静默等待。
   */
  blockedReason?: import("@keymaster/contracts").I18nText;
  rerunRequested: boolean;
  ctl?: AbortController;
  runPromise?: Promise<void>;
  lastScheduledAt?: number;
}

const LEADER_LOCK_NAME = "background.leader";
const LEADER_HEARTBEAT_MS = 5000;
const ENABLED_PREF_KEY = "background.enabled";

/**
 * 后台同步设置存储键。
 * 设计缘由：设置属于后台任务平台，而不是某个业务插件。
 * 影响 P2PKH、BSV-21、STAS 及未来所有资产 provider。
 */
const SCHEDULE_SETTINGS_KEY = "background.sync.settings";

/** 默认设置。 */
const DEFAULT_SYNC_SETTINGS: BackgroundSyncSettings = {
  assetHoldingsIntervalMs: 900_000
};

/** 预设间隔值集合。 */
const VALID_INTERVALS = new Set([300_000, 900_000, 1_800_000, 3_600_000]);

/**
 * 归一化 assetHoldingsIntervalMs。
 * 设计缘由：统一 localStorage 读取、设置写入、跨标签 BroadcastChannel
 * 消息处理的校验逻辑。要求：
 *   - 有限数；
 *   - 属于预设值集合；
 *   - 不低于注册任务的最大 minIntervalMs；
 *   - 非法值回退默认值。
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
 * 008：把 task 定义上的 keyScope 统一归一为对象或 undefined。
 * 支持传对象（注册时静态求值）和函数（注册时不求值，调用时才查 active key）。
 * 函数返回值若为 undefined 也视为"未绑定 namespace"——例如 active key
 * 不是 single 模式时。
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
  /**
   * 硬切换 002：业务插件注入的 logger。
   * 设计缘由：后台任务的状态变化是系统诊断面，应有统一埋点。
   * 不传时不记日志（保持旧行为）。
   */
  logger?: PluginLogger;
}

export function createBackgroundService(options: CreateBackgroundServiceOptions = {}): BackgroundServiceHandle {
  const tasks = new Map<string, TaskRuntime>();
  /** 冷却 map：key -> lastRunAt。每个实例独立，不跨实例共享。 */
  const cooldownMap = new Map<string, number>();
  const listeners = new Set<(s: BackgroundTaskSnapshot[]) => void>();
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let visibilityHandler: (() => void) | undefined;
  let disposed = false;
  const leaderCtx = createLeaderContext(LEADER_LOCK_NAME, LEADER_HEARTBEAT_MS);
  const logger = options.logger;

  /**
   * 一次性 migration：清除旧的 background.enabled 偏好。
   * 设计缘由：施工单 001 要求所有任务默认持续启用，删除 pause/resume 语义。
   * 读取旧值仅用于诊断日志，不能继承其中的 false。
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

  // 启动时执行 migration
  migrateEnabledPreferences();

  function snapshot(task: TaskRuntime): BackgroundTaskSnapshot {
    return {
      id: task.def.id,
      pluginId: task.def.pluginId,
      // label 在 BackgroundTaskDefinition 是 I18nText；snapshot 字段类型
      // 是已解析 string。这里用 task 上一次解析的结果（fallback 优先），
      // 避免在每次 snapshot 都重新调用 i18n 解析——i18n.onChange 会触发
      // 全量 snapshot 重发，UI 端自然重渲染。
      label: typeof task.def.label === "string" ? task.def.label : task.def.label.fallback,
      state: task.state,
      progress: task.progress,
      lastStartedAt: task.lastStartedAt,
      lastCompletedAt: task.lastCompletedAt,
      lastAttemptAt: task.lastAttemptAt,
      nextRunAt: task.nextRunAt,
      error: task.error,
      blockedReason: task.blockedReason,
      // 008：每次取快照时重新解析 keyScope，支持函数形式的延迟求值。
      keyScope: resolveKeyScope(task.def)
    };
  }
  function emitAll() {
    const list = [...tasks.values()].map(snapshot);
    for (const l of listeners) l(list);
    // 关键修复：leader 把最新任务快照广播给 follower，使 follower
    // 托盘也能看到真实状态（运行中、进度、错误等）。
    if (leaderCtx.isLeader) {
      leaderCtx.broadcastSnapshots(list);
    }
  }

  /**
   * 关键修复：follower 标签页触发 runNow/cancel 时把操作转发到 leader；
   * leader 在本 tab 内执行对应的方法并广播结果快照。
   */
  function handleFollowerAction(action: FollowerAction) {
    if (!leaderCtx.isLeader) return;
    switch (action.type) {
      case "run-now":
        runNow(action.id);
        break;
      case "cancel":
        void cancel(action.id);
        break;
      case "cancel-by-key":
        void cancelByKey(action.publicKeyHex);
        break;
      case "sync-state":
        // follower 主动询问最新快照：响应一份给请求方。
        if (action.fromTabId) {
          leaderCtx.sendToTab(action.fromTabId, { type: "snapshots", snapshots: [...tasks.values()].map(snapshot) });
        }
        break;
    }
  }

  /**
   * 读取后台同步设置。
   * 设计缘由：从 localStorage 读取，使用 normalizeAssetHoldingsInterval
   * 归一化（校验有限数 + 预设值集合），缺省返回默认值。
   * 注意：不在此处校验 minIntervalMs（需要遍历 tasks），
   * 由 getEffectiveIntervalMs 和 updateScheduleSettings 分别处理。
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
   * 设计缘由：写入 localStorage 并通过 BroadcastChannel 通知其他标签页。
   */
  function saveScheduleSettings(settings: BackgroundSyncSettings): void {
    try {
      localStorage.setItem(SCHEDULE_SETTINGS_KEY, JSON.stringify(settings));
      // 通过 BroadcastChannel 通知其他标签页
      if (settingsChannel) {
        settingsChannel.postMessage({ type: "settings-changed", settings });
      }
    } catch {
      // 静默失败。
    }
  }

  /**
   * 跨标签页设置同步通道。
   * 设计缘由：leader 写入设置后通知 follower，follower 收到后重算 nextRunAt。
   */
  let settingsChannel: BroadcastChannel | null = null;
  try {
    settingsChannel = new BroadcastChannel("background.settings.sync");
    settingsChannel.onmessage = (ev) => {
      if (ev.data?.type === "settings-changed" && ev.data.settings) {
        // 收到其他标签页的设置变更：重算 schedule
        recalculateAssetHoldingsSchedule();
      }
    };
  } catch {
    // BroadcastChannel 不可用时退化为单 tab 模式
    settingsChannel = null;
  }

  function register(def: BackgroundTaskDefinition) {
    if (tasks.has(def.id)) {
      throw new Error(`Background task id "${def.id}" is already registered`);
    }
    // 施工单 001：所有任务默认持续启用，删除 defaultEnabled 字段
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
   * 设计缘由：优先使用 schedule group 配置的 interval，否则使用任务定义的 intervalMs。
   * asset-holdings 组的 interval 从 BackgroundSyncSettings 读取。
   */
  function scheduleNext(t: TaskRuntime) {
    let interval: number | undefined;

    // 优先使用 schedule group 配置
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
  }

  /**
   * 重新计算所有 asset-holdings 组任务的下一次运行时间。
   * 设计缘由：配置变更后需要重算，新周期从保存时刻开始计时。
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
   * 关键修复：以 runPromise 锁 + state 双重防御保证同 id 不并发。
   * 即使 cancel 改了 state，旧的 runPromise 仍会继续执行到 finally，
   * finally 块会清掉 runPromise 并设置 state。
   * 新的 runNow 会通过 await runPromise 等待旧实例退出。
   *
   * 关键修复：canRun 返回 blocked 或抛错时必须先清掉 runPromise，否则
   * task 永远停在 runPromise 状态，后续 runNow 不会启动新实例。
   * 关键修复：rerunRequested 必须真正消费——运行结束后若 rerunRequested=true
   * 要再次进入 run()；否则运行期间到达的 broadcast 触发的同步会被吞掉。
   */
  async function runOne(t: TaskRuntime, reason: string): Promise<void> {
    if (t.runPromise) {
      // 已在运行：合并为一次后续 rerun。
      t.rerunRequested = true;
      return t.runPromise;
    }
    t.state = "queued";
    t.rerunRequested = false;
    t.blockedReason = undefined;
    logger?.info({ scope: "background.task", event: "triggered", message: `Task triggered: ${t.def.id}`, data: { taskId: t.def.id, reason } });
    emitAll();
    const promise = (async () => {
      // canRun 检查：返回 blocked 时设置 blockedReason 和 blocked 状态。
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
        // canRun 抛错视为 blocked（门禁异常），不是网络失败
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
        // 关键修复：框架级兜底——即使 run() 正常 resolve，若 signal 已被
        // abort（cancel 触发），必须走取消分支，不记 completed、不写
        // lastCompletedAt。不能只依赖各业务任务自行抛出 AbortError。
        if (t.ctl?.signal.aborted) {
          t.state = "idle";
          logger?.info({ scope: "background.task", event: "canceled", message: `Task canceled: ${t.def.id}`, data: { taskId: t.def.id } });
        } else {
          t.state = "idle";
          t.lastCompletedAt = new Date().toISOString();
          t.progress = undefined;
          // 成功后清除错误信息
          t.error = undefined;
          logger?.info({ scope: "background.task", event: "completed", message: `Task completed: ${t.def.id}`, data: { taskId: t.def.id } });
        }
      } catch (err) {
        if (t.ctl?.signal.aborted) {
          t.state = "idle";
          logger?.info({ scope: "background.task", event: "canceled", message: `Task canceled: ${t.def.id}`, data: { taskId: t.def.id } });
        } else {
          // 网络或业务错误：保留错误信息，回到 idle 等待下一周期
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
        // 更新冷却时间戳
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
      // 关键修复：消费 rerunRequested。运行期间到达的 trigger 合并为一次后续运行。
      if (t.rerunRequested && !disposed) {
        t.rerunRequested = false;
        // 不递归 await runOne 以避免堆栈过深；通过 microtask 异步起新实例。
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
   * 立即同步一次（UI 手动 API）。
   * 设计缘由：托盘唯一的手动动作，绕过普通冷却但不绕过门禁。
   * 等价于 trigger(taskId, "manual")，但语义更清晰。
   */
  function runNow(id: string): void {
    const t = tasks.get(id);
    if (!t) return;

    // 关键修复：follower 标签页的 runNow 必须转发给 leader 执行
    if (!leaderCtx.isLeader) {
      leaderCtx.forwardAction({ type: "run-now", id });
      return;
    }
    // manual 理由绕过普通冷却
    void runOne(t, "manual");
  }

  /**
   * 取消当前运行。
   * 设计缘由：只中止当前 instance，不会禁用任务、不会取消未来定时。
   * 取消后以取消完成时为新周期起点。
   */
  async function cancel(id: string): Promise<void> {
    const t = tasks.get(id);
    if (!t) return;
    if (!leaderCtx.isLeader) {
      leaderCtx.forwardAction({ type: "cancel", id });
      return;
    }
    t.ctl?.abort();
    t.rerunRequested = false;
    await awaitIdle(t);
    if (!t.runPromise) {
      t.state = "idle";
    }
    scheduleNext(t);
    emitAll();
  }

  /**
   * 硬切换 007：取消指定 key namespace 下所有 task。
   * follower 必须把操作转发给 leader；leader 在本 tab 内执行 cancel。
   */
  async function cancelByKey(publicKeyHex: string): Promise<void> {
    if (!leaderCtx.isLeader) {
      leaderCtx.forwardAction({ type: "cancel-by-key", publicKeyHex });
      return;
    }
    const targets: TaskRuntime[] = [];
    for (const t of tasks.values()) {
      // 008：用 resolveKeyScope 取最新求值结果——active key 切换后再调
      // cancelByKey 也能匹配到正确 namespace。
      if (resolveKeyScope(t.def)?.publicKeyHex === publicKeyHex) {
        targets.push(t);
      }
    }
    for (const t of targets) {
      t.ctl?.abort();
      t.rerunRequested = false;
      await awaitIdle(t);
      if (!t.runPromise) {
        t.state = "idle";
      }
      scheduleNext(t);
    }
    emitAll();
  }

  /**
   * 获取任务的有效周期毫秒。
   * 设计缘由：优先使用 schedule group 配置的 interval，否则使用任务定义的 intervalMs。
   */
  function getEffectiveIntervalMs(t: TaskRuntime): number | undefined {
    if (t.def.schedule?.group === "asset-holdings") {
      return loadScheduleSettings().assetHoldingsIntervalMs;
    }
    return t.def.intervalMs;
  }

  function startTimer() {
    if (intervalTimer) return;
    intervalTimer = setInterval(() => {
      const now = Date.now();
      for (const t of tasks.values()) {
        if (t.runPromise) continue;
        if (t.state === "running" || t.state === "queued" || t.state === "blocked") continue;

        // 冷却唤醒：检查是否有待处理的 rerunRequested 且已过冷却期
        if (t.rerunRequested) {
          const cooldownKey = `${t.def.id}:${resolveKeyScope(t.def)?.publicKeyHex ?? "global"}`;
          const lastRun = cooldownMap.get(cooldownKey);
          if (!lastRun || now - lastRun >= COOLDOWN_MS) {
            t.rerunRequested = false;
            if (leaderCtx.isLeader) {
              void runOne(t, "cooldown-wakeup");
            }
            continue;
          }
        }

        const intervalMs = getEffectiveIntervalMs(t);
        if (intervalMs == null) continue;
        if (t.lastScheduledAt == null) {
          t.lastScheduledAt = now;
          continue;
        }
        if (now - t.lastScheduledAt >= intervalMs) {
          t.lastScheduledAt = now;
          if (leaderCtx.isLeader) {
            void runOne(t, "interval");
          }
        }
      }
    }, 1000);
  }

  function handleVisibility() {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "visible") {
      for (const t of tasks.values()) {
        if (t.runPromise) continue;
        if (t.state !== "idle") continue;
        if (leaderCtx.isLeader) {
          void runOne(t, "visibility");
        }
      }
    }
  }

  /**
   * 关键修复：浏览器重新联网后触发一次所有任务，
   * 让 P2PKH recent-sync 等业务能立即拿到最新链上状态。
   * 设计缘由：节流 / 离线期间任务的 nextRunAt 已过期，但 timer
   * 不会补跑；online 事件是唯一明确的"网络恢复"信号。
   */
  function handleOnline() {
    if (typeof navigator === "undefined" || !navigator.onLine) return;
    for (const t of tasks.values()) {
      if (t.runPromise) continue;
      if (t.state === "running" || t.state === "queued") continue;
      if (leaderCtx.isLeader) {
        void runOne(t, "online");
      }
    }
  }

  /**
   * 监听 localStorage storage 事件（跨标签页同步的 fallback）。
   * 设计缘由：BroadcastChannel 在某些浏览器可能不可用，
   * storage 事件是更广泛的跨标签页同步机制。
   */
  let storageHandler: ((ev: StorageEvent) => void) | undefined;
  function handleStorage(ev: StorageEvent) {
    if (ev.key === SCHEDULE_SETTINGS_KEY) {
      recalculateAssetHoldingsSchedule();
    }
  }

  function start() {
    if (typeof window !== "undefined") {
      visibilityHandler = handleVisibility;
      document.addEventListener("visibilitychange", visibilityHandler);
      window.addEventListener("online", handleOnline);
      storageHandler = handleStorage;
      window.addEventListener("storage", storageHandler);
    }
    leaderCtx.start({
      onAction: handleFollowerAction,
      getSnapshots: () => [...tasks.values()].map(snapshot),
      onSnapshots: (snapshots) => {
        // follower 收到 leader 广播的快照：仅通知 listeners，不写入本地 tasks。
        for (const l of listeners) l(snapshots);
      }
    });
    startTimer();
  }

  start();

  const registry: BackgroundRegistry = {
    register,
    list,
    get: getDef
  };

  const service: BackgroundServiceHandle = {
    listSnapshots() {
      return [...tasks.values()].map(snapshot);
    },
    onChange(handler) {
      listeners.add(handler);
      handler([...tasks.values()].map(snapshot));
      return () => listeners.delete(handler);
    },
    runNow,
    trigger: runNow, // trigger 等价于 runNow，保留供业务插件内部使用
    cancel,
    cancelByKey,
    getScheduleSettings() {
      return loadScheduleSettings();
    },
    updateScheduleSettings(settings) {
      // 校验最小间隔：遍历所有 asset-holdings 组任务，取最大 minIntervalMs。
      // 设计缘由：防止用户配置过短的同步间隔导致 API 限流或资源浪费。
      let minIntervalMs = 0;
      for (const t of tasks.values()) {
        if (t.def.schedule?.group === "asset-holdings" && t.def.schedule.minIntervalMs) {
          minIntervalMs = Math.max(minIntervalMs, t.def.schedule.minIntervalMs);
        }
      }
      const validatedSettings: BackgroundSyncSettings = {
        assetHoldingsIntervalMs: normalizeAssetHoldingsInterval(settings.assetHoldingsIntervalMs, minIntervalMs)
      };
      saveScheduleSettings(validatedSettings);
      // 重置所有 asset-holdings 组任务的 lastScheduledAt，让新周期从保存时刻开始。
      // 设计缘由：不重置的话，旧 lastScheduledAt + 新 interval 可能导致
      // 下一次触发时间不符合用户预期（例如旧周期刚触发过，新 interval 更短，
      // 但 lastScheduledAt 还是旧值，下次触发要等新 interval）。
      for (const t of tasks.values()) {
        if (t.def.schedule?.group === "asset-holdings") {
          t.lastScheduledAt = undefined;
        }
      }
      recalculateAssetHoldingsSchedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (intervalTimer) clearInterval(intervalTimer);
      if (visibilityHandler && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
      if (storageHandler && typeof window !== "undefined") {
        window.removeEventListener("storage", storageHandler);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("online", handleOnline);
      }
      if (settingsChannel) {
        try { settingsChannel.close(); } catch { /* 静默 */ }
        settingsChannel = null;
      }
      for (const t of tasks.values()) {
        t.ctl?.abort();
      }
      leaderCtx.stop();
    }
  };

  return Object.assign(service, { __registry: registry } as { __registry: BackgroundRegistry });
}

export interface BackgroundBundle {
  registry: BackgroundRegistry;
  service: BackgroundServiceHandle;
}

export function createBackgroundBundle(options: CreateBackgroundServiceOptions = {}): BackgroundBundle {
  const service = createBackgroundService(options);
  const registry = (service as unknown as { __registry: BackgroundRegistry }).__registry;
  return { registry, service };
}

void BACKGROUND_REGISTRY_CAPABILITY;
void BACKGROUND_SERVICE_CAPABILITY;

interface LeaderContext {
  isLeader: boolean;
  start(handlers: { onAction: (action: FollowerAction) => void; getSnapshots: () => BackgroundTaskSnapshot[]; onSnapshots: (snapshots: BackgroundTaskSnapshot[]) => void }): void;
  stop(): void;
  /** Leader 把当前快照广播给所有 follower。 */
  broadcastSnapshots(snapshots: BackgroundTaskSnapshot[]): void;
  /** Follower 把操作转发给 leader。 */
  forwardAction(action: FollowerAction): void;
  /** Leader 主动向指定 tab 发送消息（未使用则保持扩展性）。 */
  sendToTab(tabId: string, message: LeaderToFollower): void;
}

type FollowerAction =
  | { type: "run-now"; id: string; fromTabId?: string }
  | { type: "cancel"; id: string; fromTabId?: string }
  | { type: "cancel-by-key"; publicKeyHex: string; fromTabId?: string }
  | { type: "sync-state"; fromTabId: string };

type LeaderToFollower =
  | { type: "snapshots"; snapshots: BackgroundTaskSnapshot[] }
  | { type: "action-result"; ok: boolean; actionId: string };

function createLeaderContext(channelName: string, heartbeatMs: number): LeaderContext {
  let isLeader = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let bc: BroadcastChannel | null = null;
  let lastHeartbeat = 0;
  let onAction: ((action: FollowerAction) => void) | undefined;
  let getSnapshots: (() => BackgroundTaskSnapshot[]) | undefined;
  let onSnapshots: ((snapshots: BackgroundTaskSnapshot[]) => void) | undefined;
  // Web Locks 持有的 AbortController：用于在 stop() 时主动放弃 leadership。
  let lockAbort: AbortController | null = null;
  // 当前 tab 选举状态：用于 "want/claim" 协议期间判断自己是否已赢得选举。
  let electionInProgress = false;
  // 选举结果：在超时前收到其他 tab 的 heartbeat 则立即置 "lost"，
  // 让 runElection 的超时回调认输，避免短暂双 leader。
  let electionResult: "won" | "lost" | null = null;
  // 选举期间收到的其他 tab 的 tabId（"want" 消息中携带），用于 tabId tiebreak。
  const contenders = new Set<string>();
  // 缓存 leader 自己的 tabId，用于把 action 标记来源。
  const tabId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `tab-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  function broadcastHeartbeat() {
    if (bc) bc.postMessage({ type: "heartbeat", t: Date.now(), from: tabId });
  }
  function broadcastSnapshotsImpl(snapshots: BackgroundTaskSnapshot[]) {
    if (bc) bc.postMessage({ type: "snapshots", snapshots, from: tabId });
  }

  /**
   * 检查是否拿到 Web Lock。
   * 关键修复：旧实现每个 tab 启动时无条件把 isLeader 设为 true，
   * 收到首个 heartbeat 才降级——并发启动时可能短暂双 leader，也可能
   * 互相降级后无 leader。
   * 新实现：
   *   - 非浏览器环境（无 window）：单进程，自任 leader。
   *   - 有 navigator.locks：使用 Web Locks 做 FIFO 互斥；锁释放后下一个
   *     requestor 自动获取。leader 死亡等价于浏览器关闭，浏览器会释放锁。
   *   - 无 navigator.locks：使用 BroadcastChannel 选举（tabId tiebreak）。
   *     每个 tab 广播 "want" + 自己的 tabId；tabId 最小者赢得选举；
   *     leader 周期性 heartbeat；follower 超时未收到 heartbeat 重新参选。
   */
  function start(handlers: {
    onAction: (action: FollowerAction) => void;
    getSnapshots: () => BackgroundTaskSnapshot[];
    onSnapshots: (snapshots: BackgroundTaskSnapshot[]) => void;
  }) {
    onAction = handlers.onAction;
    getSnapshots = handlers.getSnapshots;
    onSnapshots = handlers.onSnapshots;

    // 非浏览器环境（node / 单进程测试）：没有跨 tab 协调需求，自任 leader。
    if (typeof window === "undefined") {
      isLeader = true;
      return;
    }

    const locker = (navigator as Navigator & { locks?: WebLocksLike }).locks;
    if (locker) {
      // Web Locks 路径：FIFO 互斥，第一个 requestor 拿锁即成 leader。
      // 锁一直持有到 callback 返回；lockAbort 用于 stop() 时主动放弃。
      lockAbort = new AbortController();
      const myLockAbort = lockAbort;
      void locker.request(LEADER_LOCK_NAME, async () => {
        isLeader = true;
        lastHeartbeat = Date.now();
        if (bc) broadcastHeartbeat();
        try {
          await new Promise<void>((resolve) => {
            if (myLockAbort.signal.aborted) {
              resolve();
              return;
            }
            myLockAbort.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          isLeader = false;
        }
      });
      // 仍然挂一个 BroadcastChannel 监听 follower 转发过来的操作；
      // 没有 Web Locks 时这个 channel 也用于选举。
      try {
        bc = new BroadcastChannel(channelName);
        bc.onmessage = (ev) => handleBroadcastMessage(ev);
      } catch {
        bc = null;
      }
      // 周期性把快照广播给 follower；心跳检测锁丢失。
      interval = setInterval(() => {
        if (isLeader) {
          lastHeartbeat = Date.now();
          if (bc) {
            broadcastHeartbeat();
            if (getSnapshots) broadcastSnapshotsImpl(getSnapshots());
          }
        } else if (bc) {
          // 锁可能被另一 tab 抢到；继续观察但不主动让出。
        }
      }, heartbeatMs);
      return;
    }

    // 无 Web Locks：BroadcastChannel 选举。
    try {
      bc = new BroadcastChannel(channelName);
    } catch {
      bc = null;
      // BroadcastChannel 不可用：单 tab 限流，自任 leader。
      isLeader = true;
      return;
    }
    bc.onmessage = (ev) => handleBroadcastMessage(ev);
    runElection();
    interval = setInterval(() => {
      const now = Date.now();
      if (isLeader) {
        lastHeartbeat = now;
        broadcastHeartbeat();
        if (getSnapshots) broadcastSnapshotsImpl(getSnapshots());
      } else if (now - lastHeartbeat > heartbeatMs * 3) {
        // 长期未收到 leader 心跳：重新参与选举。
        runElection();
      }
    }, heartbeatMs);
  }

  /**
   * 启动一次选举：广播 want + 自己的 tabId,等待一个选举超时窗口;
   * 窗口结束后如果未发现比自己 tabId 更小的参选者,且没有听到 leader
   * 心跳,就赢。
   * 关键修复(用户验收反馈)：旧实现 250ms 超时只检查 contenders,没看
   * 期间是否收到过 heartbeat——已有 leader 收到新 tab 的 want 后只 return,
   * 没有立即响应,新 tab 在 250ms 内看不到任何 contender 就会自任 leader。
   * 修复后 leader 收到 want 立即广播 heartbeat;新 tab 收到 heartbeat 后
   * 立刻标 electionResult="lost",超时检查时直接认输。
   *
   * 关键修复(用户验收反馈,2026-06)：旧实现在 runElection 内
   * `lastHeartbeat = 0`,会抹掉刚收到的旧 leader heartbeat。如果选举触发
   * 与 heartbeat 到达的顺序刚好让 onMessage 的 electionResult="lost"
   * 没能在 250ms 内执行,该 tab 会错误地自任 leader 形成短暂双 leader。
   * 改成不清零 lastHeartbeat;改用局部 `electionStartedAt` 把"本轮选举
   * 期间是否有任何新心跳"明确出来,超时时再做一次保险检查。
   */
  function runElection() {
    if (!bc) {
      isLeader = true;
      return;
    }
    electionInProgress = true;
    electionResult = null;
    contenders.clear();
    contenders.add(tabId);
    const electionStartedAt = Date.now();
    bc.postMessage({ type: "want", from: tabId, t: electionStartedAt });
    setTimeout(() => {
      electionInProgress = false;
      if (electionResult === "lost") {
        // 在 250ms 内收到了 leader 的 heartbeat——认输。
        isLeader = false;
        return;
      }
      if (isLeader) return;
      // 关键修复:保险检查——如果 onMessage 未及时把 electionResult 置 lost
      // (例如 heartbeat 与本回调几乎同时到达),通过 lastHeartbeat 的真实
      // 时间戳兜底判定。lastHeartbeat 不再被本函数清零,可信任其值。
      if (lastHeartbeat >= electionStartedAt) {
        isLeader = false;
        return;
      }
      // 取 contenders 中最小的 tabId;如果不是自己,说明有更低 tabId 在争。
      let winner = tabId;
      for (const c of contenders) {
        if (c < winner) winner = c;
      }
      if (winner === tabId) {
        // 关键修复:自己 tabId 最小(没有更小者),赢得选举。
        isLeader = true;
        lastHeartbeat = Date.now();
        broadcastHeartbeat();
        if (getSnapshots) broadcastSnapshotsImpl(getSnapshots());
      }
    }, 250);
  }

  function handleBroadcastMessage(ev: MessageEvent) {
    const data = ev.data as
      | { type?: string; t?: number; from?: string; action?: FollowerAction; snapshots?: BackgroundTaskSnapshot[] }
      | undefined;
    if (!data?.type || !data.from || data.from === tabId) return;
    if (data.type === "want") {
      // 另一个 tab 想要 leadership。
      contenders.add(data.from);
      if (isLeader) {
        // 关键修复：已有 leader 立即广播 heartbeat 让新 tab 知道自己在线。
        // 旧实现只 return，新 tab 250ms 内看不到任何 contender，会自任 leader
        // 形成短暂双 leader（直到旧 leader 下一次 5s heartbeat 才纠正）。
        broadcastHeartbeat();
        return;
      }
      // 我不是 leader；什么都不做，等选举超时 + contenders tabId tiebreak。
    } else if (data.type === "heartbeat" && typeof data.t === "number") {
      if (data.t > lastHeartbeat) {
        lastHeartbeat = data.t;
        // 收到其他 tab 的心跳：让出 leadership。
        if (data.from !== tabId) {
          if (isLeader) {
            isLeader = false;
          } else if (electionInProgress) {
            // 关键修复：election 中立即标 lost，不等超时——避免新 tab 与
            // 旧 leader 短暂双 leader。
            electionResult = "lost";
          }
        }
      }
    } else if (data.type === "snapshots" && Array.isArray(data.snapshots)) {
      if (onSnapshots) onSnapshots(data.snapshots);
    } else if (data.type === "action" && data.action) {
      if (isLeader && onAction) {
        const action = data.action;
        if (action.type === "sync-state") {
          onAction({ type: "sync-state", fromTabId: data.from });
        } else {
          onAction({ ...action, fromTabId: data.from });
        }
      }
    }
  }

  function stop() {
    if (interval) clearInterval(interval);
    interval = undefined;
    if (lockAbort) {
      try { lockAbort.abort(); } catch { /* 静默 */ }
      lockAbort = null;
    }
    if (bc) {
      try { bc.close(); } catch { /* 静默 */ }
      bc = null;
    }
    isLeader = false;
    electionInProgress = false;
    electionResult = null;
  }
  function forwardAction(action: FollowerAction) {
    if (bc) bc.postMessage({ type: "action", action, from: tabId });
  }
  function sendToTab(_tabId: string, _message: LeaderToFollower) {
    // 当前实现：所有 leader->follower 消息都通过 broadcast 发送；
    // tab-targeted 消息保留扩展点（按需可改用 id 匹配过滤）。
    if (bc) bc.postMessage({ type: "broadcast", from: tabId });
  }
  return {
    get isLeader() {
      return isLeader;
    },
    start,
    stop,
    broadcastSnapshots: broadcastSnapshotsImpl,
    forwardAction,
    sendToTab
  };
}

/**
 * navigator.locks.request 的最小类型子集；运行时通过 navigator.locks 调用，
 * 不引入 dom lib 类型。
 */
interface WebLocksLike {
  request<T>(name: string, cb: () => Promise<T>): Promise<T | undefined>;
}
