/**
 * SharedWorker 退场策略。
 *
 * 浏览器不会保证最后一个 MessagePort 关闭后立刻销毁 SharedWorker。若旧构建
 * 继续存活，它仍会持有 WebLoom 运行锁，使刷新或发布切换后的新 Worker 启动
 * 失败。这里在没有活动页面后主动排空 Runtime，并最终关闭 Worker 全局作用域。
 */
export interface RetirableSharedWorkerApp {
  /** Runtime 首次启动结果。 */
  ready(): Promise<void>;
  /** 当前仍连接到此 Worker 的页面。 */
  activePeers(): readonly unknown[];
  /** 页面连接、关闭等生命周期事件。 */
  subscribePeerLifecycle(listener: (event: { event: string }) => void): () => void;
  /** 排空插件、调用和端口，并释放浏览器运行锁。 */
  dispose(reason?: string): Promise<unknown>;
}

export interface SharedWorkerClosingScope {
  /** 终止当前 SharedWorker 全局作用域。 */
  close?: () => void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SharedWorkerRetirementOptions {
  /** 最后一个页面离开后的宽限时间，允许同构建刷新直接复用 Worker。 */
  idleGraceMs?: number;
  /** 启动失败后保留错误消息投递时间，再关闭已失败的 Worker。 */
  failureGraceMs?: number;
}

/** 安装 Coordinator SharedWorker 的失败退场和空闲退场策略。 */
export function installSharedWorkerRetirement(
  app: RetirableSharedWorkerApp,
  scope: SharedWorkerClosingScope,
  options: SharedWorkerRetirementOptions = {},
): () => void {
  const idleGraceMs = options.idleGraceMs ?? 250;
  const failureGraceMs = options.failureGraceMs ?? 25;
  let timer: unknown;
  let retirementStarted = false;
  let stopped = false;

  const cancelScheduledRetirement = (): void => {
    if (timer === undefined) return;
    scope.clearTimeout(timer);
    timer = undefined;
  };
  const retire = async (reason: string): Promise<void> => {
    if (retirementStarted || stopped) return;
    retirementStarted = true;
    cancelScheduledRetirement();
    removePeerListener();
    try {
      await app.dispose(reason);
    } catch {
      // Runtime 已经失败时 dispose 仍可能拒绝；Worker 必须继续退出，避免
      // 把一个永久 failed 的物理实例留给下一次 connect()。
    } finally {
      scope.close?.();
    }
  };
  const schedule = (delayMs: number, reason: string): void => {
    cancelScheduledRetirement();
    timer = scope.setTimeout(() => {
      timer = undefined;
      if (reason === "Coordinator SharedWorker 空闲退场" && app.activePeers().length > 0) return;
      void retire(reason);
    }, delayMs);
  };

  const removePeerListener = app.subscribePeerLifecycle((event) => {
    if (event.event === "active") {
      cancelScheduledRetirement();
      return;
    }
    if (event.event === "closed" && app.activePeers().length === 0) {
      schedule(idleGraceMs, "Coordinator SharedWorker 空闲退场");
    }
  });

  void app.ready().catch(() => {
    // WebLoom 已先向连接端发布结构化 runtime-error；稍作宽限再退出，保证
    // 启动层下一次构造 SharedWorker 时不会复用当前 failed 实例。
    schedule(failureGraceMs, "Coordinator SharedWorker 启动失败退场");
  });

  return () => {
    stopped = true;
    cancelScheduledRetirement();
    removePeerListener();
  };
}
