import type { WalletLockCleanup } from "@keymaster/contracts";

/** 权限撤销与清理完成分开提交。超时只报错，不能把仍在执行的清理当成成功。
 * 重试复用未完成 Promise，只有明确失败的步骤才重新执行，避免重复退出。
 */
export class WalletLockBarrier {
  private participants = new Set<string>();
  private windows = new Map<string, string | undefined>();
  private operations: { label: string; run: () => Promise<void>; pending?: Promise<void>; done?: boolean; error?: string }[] = [];
  private attempt = 0;
  private failures: string[] = [];
  private reportedFailures = new Set<string>();
  private epoch?: string;
  private state?: WalletLockCleanup;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  constructor(private publish: (state: WalletLockCleanup | undefined) => void, private timeoutMs = 15_000) {}
  snapshot() { return this.state; }
  register(peer: string) {
    this.participants.add(peer);
    if (this.state && !this.windows.has(peer)) { this.windows.set(peer, undefined); this.commit(); }
  }
  remove(peer: string) { this.participants.delete(peer); this.windows.delete(peer); this.commit(); }
  begin(epoch: string, operations: { label: string; run: () => Promise<void> }[]) {
    this.failures = []; this.reportedFailures.clear();
    this.epoch = epoch;
    this.operations = operations;
    return this.retry();
  }
  retry(): Promise<void> {
    if (this.running && this.state?.phase !== "failed") return this.running;
    this.attempt++;
    this.windows = new Map([...this.participants].map(peer => [peer, undefined]));
    for (const operation of this.operations) operation.error = undefined;
    this.state = { phase: "pending", attempt: this.attempt, ...this.diagnostics() };
    this.publish(this.state);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      for (const [peer, error] of this.windows) if (error === undefined) { this.windows.set(peer, "页面插件退出超时"); this.recordFailure(`page:${peer}`, "页面插件退出超时"); }
      for (const operation of this.operations) if (!operation.done) { operation.error = `${operation.label}退出超时`; this.recordFailure(operation.label, operation.error); }
      this.commit();
    }, this.timeoutMs);
    const attempt = this.attempt;
    const running = Promise.all(this.operations.map(async operation => {
      if (operation.done) return;
      // 真正失败后允许重试；超时的原操作仍运行，继续等同一个 Promise。
      // A task boundary lets the lock event leave the Worker before synchronous
      // teardown starts; a microtask would still run before message delivery.
      operation.pending ??= new Promise<void>(resolve => setTimeout(resolve, 0)).then(operation.run);
      try { await operation.pending; operation.done = true; operation.error = undefined; }
      catch (error) {
        operation.error = `${operation.label}: ${error instanceof Error ? error.message : String(error)}`;
        operation.pending = undefined;
        if (attempt === this.attempt) this.recordFailure(operation.label, error instanceof Error ? error.stack ?? error.message : String(error));
      }
      if (attempt === this.attempt) this.commit();
    })).then(() => { this.commit(); }).finally(() => { if (this.running === running) this.running = undefined; });
    this.running = running;
    // 不等待所有页面上报，避免 Window 上报与 lock RPC 相互等待。
    return running;
  }
  report(peer: string, epoch: string, attempt: number, error?: string) {
    if (epoch !== this.epoch || attempt !== this.attempt || !this.windows.has(peer)) return;
    if (error) { this.windows.set(peer, error); this.recordFailure(`page:${peer}`, error); } else this.windows.delete(peer);
    this.commit();
  }
  private diagnostics() {
    return this.failures.length ? { diagnostics: this.failures.join("\n\n").slice(0, 32768) } : {};
  }
  private recordFailure(source: string, details: string) {
    const key = `${this.attempt}:${source}:${details}`;
    if (this.reportedFailures.has(key)) return;
    this.reportedFailures.add(key);
    const entry = `[${new Date().toISOString()}] attempt=${this.attempt} source=${source}\n${details}`;
    // Preserve the FIRST failure, even when subsequent retry failures fill the log.
    this.failures.push(entry.slice(0, 8192));
    if (this.failures.length > 4) this.failures.splice(1, 1);
    console.error("[wallet-lock] cleanup failed", entry);
  }
  private commit() {
    if (!this.state) return;
    const errors = [...this.operations.flatMap(operation => operation.error ? [operation.error] : []), ...[...this.windows.values()].filter((error): error is string => error !== undefined)];
    const waiting = this.operations.some(operation => !operation.done) || this.windows.size > 0;
    this.state = errors.length ? { phase: "failed", attempt: this.attempt, error: errors.join("；").slice(0, 8192), ...this.diagnostics() } : waiting ? { phase: "pending", attempt: this.attempt, ...this.diagnostics() } : undefined;
    if (!this.state && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.publish(this.state);
  }
  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.state = undefined; this.windows.clear(); this.participants.clear(); this.operations = []; this.epoch = undefined; this.running = undefined;
    this.failures = []; this.reportedFailures.clear();
    this.attempt++;
  }
}
