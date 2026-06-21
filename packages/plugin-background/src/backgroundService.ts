// packages/plugin-background/src/backgroundService.ts
// 后台任务平台实现。
// 设计缘由：
//   - 任务注册 -> 调度 -> 运行 -> 状态变更订阅。
//   - 同 task id 不并发：使用独立 runPromise 锁；pause/cancel/resume 必须等
//     旧实例真正退出后才允许新实例启动。
//   - pause 立即 abort 当前运行实例并等待其 finally 块退出；之后 state=paused。
//   - cancel 仅 abort 一次；不重置 enabled。
//   - retry 仅重试 failed 任务。
//   - 页面 visibility 变化与定时器节流恢复时只合并为一次 run。
//   - leader lock：浏览器环境优先 Web Locks（FIFO 互斥）；不支持时回退
//     BroadcastChannel + tabId 选举；非浏览器/无 BroadcastChannel 时单进程
//     直接是 leader。
//   - follower 标签页的 trigger/pause/resume/cancel/retry 必须转发到 leader。
//
// 硬切换 001 阶段 5 边界（轻量接入）：
//   BackgroundService 负责触发消息，不直接拥有业务状态。
//   未来把 BackgroundService 改造为 MessageBus 调度器时：
//     - trigger / pause / resume / cancel / retry 改为 dispatch "background.task.*"；
//     - 业务插件订阅这些消息并执行实际 run；
//     - BackgroundService 仍负责 leader 选举、leader 心跳、follower 转发。
//   本期不重写为 actor；只把未来职责边界写入注释，行为保持等价。

import type {
  BackgroundRegistry,
  BackgroundService,
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
  enabled: boolean;
  progress?: BackgroundTaskProgress;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  nextRunAt?: string;
  error?: string;
  rerunRequested: boolean;
  ctl?: AbortController;
  runPromise?: Promise<void>;
  lastScheduledAt?: number;
}

const LEADER_LOCK_NAME = "background.leader";
const LEADER_HEARTBEAT_MS = 5000;
const ENABLED_PREF_KEY = "background.enabled";

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
  const enabledOverrides = loadEnabledOverrides();
  const listeners = new Set<(s: BackgroundTaskSnapshot[]) => void>();
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let visibilityHandler: (() => void) | undefined;
  let disposed = false;
  const leaderCtx = createLeaderContext(LEADER_LOCK_NAME, LEADER_HEARTBEAT_MS);
  const logger = options.logger;

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
      nextRunAt: task.nextRunAt,
      error: task.error,
      enabled: task.enabled,
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
   * 关键修复：follower 标签页触发 pause/resume/cancel/retry/trigger 时
   * 把操作转发到 leader；leader 在本 tab 内执行对应的方法并广播结果快照。
   */
  function handleFollowerAction(action: FollowerAction) {
    if (!leaderCtx.isLeader) return;
    switch (action.type) {
      case "trigger":
        trigger(action.id, action.reason ?? "follower");
        break;
      case "pause":
        void pause(action.id);
        break;
      case "resume":
        resume(action.id);
        break;
      case "cancel":
        void cancel(action.id);
        break;
      case "retry":
        retry(action.id);
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

  function loadEnabledOverrides(): Map<string, boolean> {
    try {
      const raw = localStorage.getItem(ENABLED_PREF_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw) as Record<string, boolean>;
      return new Map(Object.entries(obj));
    } catch {
      return new Map();
    }
  }
  function saveEnabledOverrides() {
    try {
      const obj: Record<string, boolean> = {};
      for (const [k, v] of enabledOverrides) obj[k] = v;
      localStorage.setItem(ENABLED_PREF_KEY, JSON.stringify(obj));
    } catch {
      // 静默失败。
    }
  }

  function register(def: BackgroundTaskDefinition) {
    if (tasks.has(def.id)) {
      throw new Error(`Background task id "${def.id}" is already registered`);
    }
    const enabled = enabledOverrides.has(def.id) ? enabledOverrides.get(def.id)! : def.defaultEnabled ?? true;
    const t: TaskRuntime = {
      def,
      state: "idle",
      enabled,
      rerunRequested: false
    };
    tasks.set(def.id, t);
    if (t.enabled) scheduleNext(t);
    emitAll();
  }

  function list(): BackgroundTaskDefinition[] {
    return [...tasks.values()].map((t) => t.def);
  }
  function getDef(id: string) {
    return tasks.get(id)?.def;
  }

  function scheduleNext(t: TaskRuntime) {
    if (!t.enabled || t.def.intervalMs == null) {
      t.nextRunAt = undefined;
      return;
    }
    const now = Date.now();
    const next = new Date(now + t.def.intervalMs).toISOString();
    t.nextRunAt = next;
  }

  /**
   * 关键修复：以 runPromise 锁 + state 双重防御保证同 id 不并发。
   * 即使 pause/cancel 改了 state，旧的 runPromise 仍会继续执行到 finally，
   * finally 块会清掉 runPromise 并设置 state。
   * 新的 trigger/pause/resume 会通过 await runPromise 等待旧实例退出。
   *
   * 关键修复：canRun=false 或抛错时必须先清掉 runPromise，否则
   * task 永远停在 runPromise 状态，后续 trigger 不会启动新实例。
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
    logger?.info({ scope: "background.task", event: "triggered", message: `Task triggered: ${t.def.id}`, data: { taskId: t.def.id, reason } });
    emitAll();
    const promise = (async () => {
      // canRun 检查：false 时只保持 idle/queued，不标记为 failed。
      try {
        if (t.def.canRun) {
          const ok = await t.def.canRun();
          if (!ok) {
            t.state = t.enabled ? "idle" : "paused";
            scheduleNext(t);
            return;
          }
        }
      } catch (err) {
        t.error = err instanceof Error ? err.message : String(err);
        t.state = "failed";
        return;
      }
      t.state = "running";
      t.error = undefined;
      t.lastStartedAt = new Date().toISOString();
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
        t.state = t.enabled ? "idle" : "paused";
        t.lastCompletedAt = new Date().toISOString();
        t.progress = undefined;
        logger?.info({ scope: "background.task", event: "completed", message: `Task completed: ${t.def.id}`, data: { taskId: t.def.id } });
      } catch (err) {
        if (t.ctl.signal.aborted) {
          t.state = t.enabled ? "idle" : "paused";
          logger?.info({ scope: "background.task", event: "canceled", message: `Task canceled: ${t.def.id}`, data: { taskId: t.def.id } });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          t.error = msg;
          t.state = "failed";
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
      }
    })();
    t.runPromise = promise;
    try {
      await promise;
    } finally {
      t.runPromise = undefined;
      emitAll();
      // 关键修复：消费 rerunRequested。运行期间到达的 trigger 合并为一次后续运行。
      if (t.rerunRequested && t.enabled && !disposed) {
        t.rerunRequested = false;
        // 不递归 await runOne 以避免堆栈过深；通过 microtask 异步起新实例。
        queueMicrotask(() => {
          if (!t.runPromise && t.enabled && !disposed) {
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

  function trigger(id: string, reason = "manual") {
    const t = tasks.get(id);
    if (!t) return;
    // 关键修复：paused 任务不可被 trigger 启动——托盘的"暂停"语义
    // 必须是硬屏障，手动 trigger 也不能绕过。follower → leader 转发
    // 也走同样的判断，leader 端不会再 runOne。
    if (!t.enabled) return;
    // 关键修复：follower 标签页的 trigger/pause/resume/cancel/retry 必须
    // 转发给 leader 执行；本 tab 不能再各自启动实例。
    if (!leaderCtx.isLeader) {
      leaderCtx.forwardAction({ type: "trigger", id, reason });
      return;
    }
    void runOne(t, reason);
  }
  /**
   * 关键修复：pause 立即 abort 当前实例并 await runPromise 退出，
   * 之后才设置 state=paused 并更新 enabled 偏好。
   */
  async function pause(id: string): Promise<void> {
    const t = tasks.get(id);
    if (!t) return;
    if (!leaderCtx.isLeader) {
      leaderCtx.forwardAction({ type: "pause", id });
      return;
    }
    t.enabled = false;
    enabledOverrides.set(id, false);
    saveEnabledOverrides();
    t.ctl?.abort();
    await awaitIdle(t);
    // 旧实例退出后才能安全切到 paused；否则 pause 期间被 trigger 会启动新实例。
    t.state = "paused";
    t.nextRunAt = undefined;
    logger?.info({ scope: "background.task", event: "paused", message: `Task paused: ${t.def.id}`, data: { taskId: t.def.id } });
    emitAll();
  }
  function resume(id: string): void {
    const t = tasks.get(id);
    if (!t) return;
    if (!leaderCtx.isLeader) {
      leaderCtx.forwardAction({ type: "resume", id });
      return;
    }
    t.enabled = true;
    enabledOverrides.set(id, true);
    saveEnabledOverrides();
    if (!t.runPromise) {
      t.state = "idle";
    }
    scheduleNext(t);
    logger?.info({ scope: "background.task", event: "resumed", message: `Task resumed: ${t.def.id}`, data: { taskId: t.def.id } });
    emitAll();
  }
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
      t.state = t.enabled ? "idle" : "paused";
    }
    scheduleNext(t);
    emitAll();
  }
  function retry(id: string) {
    const t = tasks.get(id);
    if (!t) return;
    if (!leaderCtx.isLeader) {
      leaderCtx.forwardAction({ type: "retry", id });
      return;
    }
    if (t.state !== "failed") return;
    void runOne(t, "retry");
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
        t.state = t.enabled ? "idle" : "paused";
      }
      scheduleNext(t);
    }
    emitAll();
  }

  function startTimer() {
    if (intervalTimer) return;
    intervalTimer = setInterval(() => {
      const now = Date.now();
      for (const t of tasks.values()) {
        if (!t.enabled) continue;
        if (t.def.intervalMs == null) continue;
        if (t.runPromise) continue;
        if (t.state === "running" || t.state === "queued" || t.state === "failed" || t.state === "paused") continue;
        if (t.lastScheduledAt == null) {
          t.lastScheduledAt = now;
          continue;
        }
        if (now - t.lastScheduledAt >= t.def.intervalMs) {
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
        if (!t.enabled || t.runPromise) continue;
        if (t.state !== "idle") continue;
        if (leaderCtx.isLeader) {
          void runOne(t, "resume");
        }
      }
    }
  }

  /**
   * 关键修复：浏览器重新联网后触发一次所有 enabled 任务，
   * 让 P2PKH recent-sync 等业务能立即拿到最新链上状态。
   * 设计缘由：节流 / 离线期间任务的 nextRunAt 已过期，但 timer
   * 不会补跑；online 事件是唯一明确的"网络恢复"信号。
   */
  function handleOnline() {
    if (typeof navigator === "undefined" || !navigator.onLine) return;
    for (const t of tasks.values()) {
      if (!t.enabled || t.runPromise) continue;
      if (t.state === "running" || t.state === "queued") continue;
      if (leaderCtx.isLeader) {
        void runOne(t, "online");
      }
    }
  }

  function start() {
    if (typeof window !== "undefined") {
      visibilityHandler = handleVisibility;
      document.addEventListener("visibilitychange", visibilityHandler);
      window.addEventListener("online", handleOnline);
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
    trigger,
    pause,
    resume,
    cancel,
    retry,
    cancelByKey,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (intervalTimer) clearInterval(intervalTimer);
      if (visibilityHandler && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("online", handleOnline);
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
  | { type: "trigger"; id: string; reason?: string; fromTabId?: string }
  | { type: "pause"; id: string; fromTabId?: string }
  | { type: "resume"; id: string; fromTabId?: string }
  | { type: "cancel"; id: string; fromTabId?: string }
  | { type: "retry"; id: string; fromTabId?: string }
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
