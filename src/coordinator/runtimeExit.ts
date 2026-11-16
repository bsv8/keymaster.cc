/** 框架已丢弃失败 teardown 的执行入口，不能用 reconcile 冒充清理重试。 */
export class RuntimeRestartRequiredError extends Error {
  readonly code = "storage_unavailable";
  constructor(pluginId: string) {
    super(`后台插件 ${pluginId} 退出清理失败，当前运行无法安全恢复。请保存其他页面的工作，关闭所有钱包页面并重启浏览器，再重新打开钱包。重复输入密码不能解决此问题。`);
    this.name = "RuntimeRestartRequiredError";
  }
}

/** 真实退出的步骤只在成功后退役；失败不会放开激活入口。
 * 并发等待共享同一次尝试，重试只执行尚未完成的步骤。
 */
export function createRuntimeExit(steps: readonly { label: string; run(): Promise<void> }[]) {
  const completed = new Set<number>();
  let pending: Promise<void> | undefined;
  return function finish(): Promise<void> {
    if (pending) return pending;
    const attempt = Promise.allSettled(steps.map(async (step, index) => {
      if (completed.has(index)) return;
      try { await step.run(); completed.add(index); }
      catch (cause) {
        if (cause instanceof RuntimeRestartRequiredError) throw cause;
        throw new Error(`Wallet runtime exit failed: ${step.label}`, { cause });
      }
    })).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      const restart = failures.find(result => result.reason instanceof RuntimeRestartRequiredError);
      if (restart) throw restart.reason;
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Wallet runtime exit is incomplete");
    }).finally(() => { if (pending === attempt) pending = undefined; });
    pending = attempt;
    return attempt;
  };
}
