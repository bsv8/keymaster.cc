// Storage 全局健康状态机：与 Vault 生命周期分离。
import type { StorageRuntimeStatus } from "@keymaster/contracts";

export interface StorageHealthSnapshot {
  /** 当前存储健康状态。 */
  status: StorageRuntimeStatus;
  /** 最近一次失败原因，仅供本地诊断，不包含凭据。 */
  message?: string;
  /** 最近一次探测失败的脱敏诊断分类。 */
  diagnostic?: "configuration" | "authentication" | "forbidden" | "not-found" | "cors" | "network" | "provider";
  /** 最近一次探测成功的时间（毫秒）。 */
  lastSuccessAt?: number;
  /** 最近一次探测失败的时间（毫秒）。 */
  lastFailureAt?: number;
  /** 下一次自动探测时间（毫秒）。 */
  nextProbeAt?: number;
  /** 最近一次探测耗时（毫秒）。 */
  latencyMs?: number;
  /** 当前退避重试次数。 */
  retryAttempt: number;
}

export interface StorageHealthControllerOptions {
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type StorageProbeOperation = () => Promise<void>;

export interface StorageProbeOptions {
  /** 初次冷启动由上层应用装配完成后再发布 ready。 */
  publishReady?: boolean;
}

export class StorageHealthController {
  private current: StorageHealthSnapshot = { status: "unselected", retryAttempt: 0 };
  private readonly listeners = new Set<(snapshot: StorageHealthSnapshot) => void>();
  private inFlight?: Promise<StorageHealthSnapshot>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private probeGeneration = 0;
  private recoveryCleanup?: () => void;
  private probeOperation?: StorageProbeOperation;
  /** Provider 成功后必须完成的 Root/Journal/任务恢复。 */
  private probeFinalizeOperation?: StorageProbeOperation;
  private probeOptions: StorageProbeOptions = {};
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(options: StorageHealthControllerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  snapshot(): StorageHealthSnapshot { return { ...this.current }; }
  status(): StorageRuntimeStatus { return this.current.status; }
  subscribe(listener: (snapshot: StorageHealthSnapshot) => void): () => void { this.listeners.add(listener); listener(this.snapshot()); return () => this.listeners.delete(listener); }

  setStatus(status: StorageRuntimeStatus, message?: string): void {
    // ready/unselected 是新的健康基线，必须取消旧 degraded 状态留下的退避探测；
    // 否则旧定时器可能在恢复后再次把 Worker 推回 degraded。
    if (status === "ready" || status === "unselected") this.clearScheduledRetry();
    this.current = {
      ...this.current,
      status,
      retryAttempt: status === "ready" || status === "unselected" ? 0 : this.current.retryAttempt,
      ...(message ? { message } : { message: undefined }),
      ...(status === "ready" || status === "unselected" ? { diagnostic: undefined, nextProbeAt: undefined } : {})
    };
    this.notify();
    // 某些恢复路径不是由 probe() 直接包住的（例如冷启动 Root 安装后），
    // 但仍然要进入同一条自动退避链。只有已有可重试探测且当前没有探测
    // 在途时才安排，避免在 probe() 内部重复创建定时器。
    if (status === "degraded" && this.probeOperation && !this.inFlight) this.scheduleRetry();
  }

  /** 测试用：清理退避与旧探测结果，不触发业务恢复编排。 */
  resetForTesting(status: StorageRuntimeStatus = "unselected"): void {
    this.probeGeneration += 1;
    this.clearScheduledRetry();
    this.inFlight = undefined;
    this.probeOperation = undefined;
    this.probeFinalizeOperation = undefined;
    this.probeOptions = {};
    this.current = { status, retryAttempt: 0 };
  }

  async probe(operation: StorageProbeOperation, finalize?: StorageProbeOperation, options: StorageProbeOptions = {}): Promise<StorageHealthSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.probeOperation = operation;
    this.probeFinalizeOperation = finalize;
    this.probeOptions = options;
    const generation = this.probeGeneration;
    this.clearScheduledRetry();
    this.setStatus("checking");
    const run = (async () => {
      const startedAt = this.now();
      try {
        await operation();
        // Provider 可访问不等于平台 Storage 已恢复。调用方在这里完成
        // Root 重绑、删除 Journal 收敛和业务任务恢复；任何一步失败都
        // 进入下面统一的 degraded + 指数退避分支，且不会先发布 ready。
        await finalize?.();
        if (generation !== this.probeGeneration) return this.snapshot();
        // 初次冷启动可能还要由 Coordinator 完成 Vault metadata、Journal
        // 和任务注册；此时只结束 provider probe，不抢先对外发布 ready。
        if (options.publishReady !== false) {
          this.current = {
            status: "ready",
            retryAttempt: 0,
            lastSuccessAt: this.now(),
            latencyMs: Math.max(0, this.now() - startedAt)
          };
          this.notify();
        }
      } catch (error) {
        if (generation !== this.probeGeneration) return this.snapshot();
        const message = error instanceof Error ? error.message : String(error);
        const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
        const errorDiagnostic = error && typeof error === "object" && "diagnostic" in error ? (error as { diagnostic?: unknown }).diagnostic : undefined;
        const isAuthentication = errorDiagnostic === "authentication" || code === "storage_identity_required" || /password|auth/i.test(message);
        const status: StorageRuntimeStatus = isAuthentication ? "authentication" : code === "storage_forbidden" || /conditional writes|incompatible|schema/i.test(message) ? "incompatible" : "degraded";
        const diagnostic = isAuthentication ? "authentication" : code === "storage_forbidden" ? "forbidden" : code === "storage_provider_error" ? "provider" : "network";
        this.current = {
          status,
          retryAttempt: this.current.retryAttempt + 1,
          message,
          diagnostic,
          lastFailureAt: this.now(),
          latencyMs: Math.max(0, this.now() - startedAt)
        };
        this.notify();
        if (status === "degraded") this.scheduleRetry();
      }
      return this.snapshot();
    })();
    this.inFlight = run;
    try { return await run; } finally { if (this.inFlight === run) this.inFlight = undefined; }
  }

  async retry(): Promise<StorageHealthSnapshot> {
    return this.probeOperation
      ? this.probe(this.probeOperation, this.probeFinalizeOperation, this.probeOptions)
      : this.snapshot();
  }

  attachRecoveryListeners(target?: { addEventListener: (type: string, listener: () => void) => void; removeEventListener: (type: string, listener: () => void) => void }): () => void {
    this.recoveryCleanup?.();
    if (!target) {
      const candidate = globalThis as typeof globalThis & Partial<EventTarget>;
      if (typeof candidate.addEventListener !== "function" || typeof candidate.removeEventListener !== "function") return () => undefined;
      target = candidate as unknown as { addEventListener: (type: string, listener: () => void) => void; removeEventListener: (type: string, listener: () => void) => void };
    }
    const recover = () => { void this.retry(); };
    target.addEventListener("online", recover);
    target.addEventListener("visibilitychange", recover);
    this.recoveryCleanup = () => {
      target.removeEventListener("online", recover);
      target.removeEventListener("visibilitychange", recover);
      this.recoveryCleanup = undefined;
    };
    return this.recoveryCleanup;
  }

  dispose(): void { this.clearScheduledRetry(); this.recoveryCleanup?.(); this.listeners.clear(); }

  private scheduleRetry(): void {
    this.clearScheduledRetry();
    const base = Math.min(60_000, 1_000 * (2 ** Math.min(this.current.retryAttempt - 1, 6)));
    const jitter = Math.floor(base * 0.2 * this.random());
    this.current.nextProbeAt = this.now() + base + jitter;
    this.notify();
    this.retryTimer = this.setTimer(() => { this.retryTimer = undefined; this.current.nextProbeAt = undefined; void this.retry(); }, base + jitter);
  }

  private clearScheduledRetry(): void {
    if (this.retryTimer !== undefined) { this.clearTimer(this.retryTimer); this.retryTimer = undefined; }
    if (this.current.nextProbeAt !== undefined) {
      this.current.nextProbeAt = undefined;
      this.notify();
    }
  }

  private notify(): void { for (const listener of this.listeners) listener(this.snapshot()); }
}
