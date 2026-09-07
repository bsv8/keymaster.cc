// Channel 物理订阅复用器。
//
// 这里是 Coordinator 内唯一允许把逻辑 caller 订阅集合转换成 SSP 物理
// subscribe/unsubscribe 的地方。caller 自己只拥有一份 set；物理频道是所有
// caller 的 union，不能因为某一个 caller 释放就误取消另一个 caller 仍在使用的频道。

export interface ChannelSubscriptionDriver {
  /** 向当前 SSP 连接订阅一个精确频道。 */
  subscribe(channel: string, signal?: AbortSignal): Promise<void>;
  /** 从当前 SSP 连接取消一个精确频道。 */
  unsubscribe(channel: string, signal?: AbortSignal): Promise<void>;
}

export interface ChannelSubscriptionMuxOptions {
  driver: ChannelSubscriptionDriver;
}

const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 30_000;

export function validateExactChannel(channel: string): void {
  if (
    typeof channel !== "string" ||
    channel.length === 0 ||
    channel === "*" ||
    new TextEncoder().encode(channel).byteLength > 256 ||
    [...channel].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new Error("Channel must be a non-empty exact UTF-8 channel");
  }
}

function normalizeChannels(channels: readonly string[]): string[] {
  if (!Array.isArray(channels)) throw new Error("channels must be an array");
  const normalized = [...new Set(channels)];
  normalized.forEach(validateExactChannel);
  return normalized.sort();
}

/**
 * 多 caller 的单一物理订阅协调器。
 *
 * - `set` 是 replace 语义；传 `[]` 等价于 release。
 * - 网络操作串行执行，重复 set 不会产生重复物理订阅。
 * - caller 集合和本地缓存只属于当前 owner runtime；Supplier/频道的远端
 *   desired/observed 真值由 owner-scoped SatSubscriptionStateStore 维护。
 */
export class ChannelSubscriptionMux {
  private readonly callers = new Map<string, Set<string>>();
  // 仅是当前 runtime 对 driver 成功调用的缓存，不是远端真值。
  private readonly physical = new Set<string>();
  private operationTail: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempts = 0;
  private disposed = false;
  /** 当前物理对账操作的取消控制器；owner 切换时会立即中断网络请求。 */
  private operationController = new AbortController();

  constructor(private readonly options: ChannelSubscriptionMuxOptions) {}

  /** 当前 caller 的逻辑集合。 */
  callerChannels(callerId: string): readonly string[] {
    return [...(this.callers.get(callerId) ?? new Set())].sort();
  }

  /** 当前已知物理远端集合。 */
  physicalChannels(): readonly string[] {
    return [...this.physical].sort();
  }

  /** 替换 caller 集合；空数组释放 caller。 */
  async set(callerId: string, channels: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
    if (this.disposed) throw new Error("Channel subscription mux is disposed");
    if (typeof callerId !== "string" || callerId.length === 0) {
      throw new Error("callerId must be non-empty");
    }
    const normalized = normalizeChannels(channels);
    if (normalized.length === 0) this.callers.delete(callerId);
    else this.callers.set(callerId, new Set(normalized));
    try {
      await this.reconcile(signal);
      this.resetRetry();
    } catch (error) {
      // 生命周期/端口断开取消的是本次物理操作，不是暂时的 Supplier
      // 失败。不能把已撤销的旧 caller 再放进无限退避队列。
      if (isAbortError(error) || signal?.aborted || this.disposed) throw error;
      // 逻辑集合已经通过入口校验并提交；物理 Supplier 失败只进入
      // 后台重试。Coordinator 必须仍然返回 result.channels，不能让
      // 代理先后得到“新逻辑集合”和异常而发生权限过滤分叉。
      this.scheduleRetry();
    }
    return this.callerChannels(callerId);
  }

  /** 释放 caller，不保存任何 session 信息；返回本次物理对账结果。 */
  async release(callerId: string, signal?: AbortSignal): Promise<void> {
    if (this.disposed) return;
    this.callers.delete(callerId);
    try {
      await this.reconcile(signal);
      this.resetRetry();
    } catch (error) {
      if (isAbortError(error) || signal?.aborted || this.disposed) throw error;
      // 逻辑释放已经提交；物理退订失败继续按当前 union 后台重试，
      // 不能让调用方误以为 caller 仍然拥有订阅。
      this.scheduleRetry();
    }
  }

  /** 释放所有逻辑 caller；用于锁屏、owner 切换和 Worker teardown。 */
  async clear(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return;
    this.callers.clear();
    try {
      await this.reconcile(signal);
      this.resetRetry();
    } catch (error) {
      if (!isAbortError(error) && !signal?.aborted && !this.disposed) this.scheduleRetry();
      throw error;
    }
  }

  /**
   * 终止当前 owner 的协调器。
   *
   * 进行中的 driver Promise 无法被强制取消，但 dispose 会取消所有后续
   * 重试并阻止旧 caller 集合再次驱动新连接，避免 owner 切换后旧 Runtime
   * 复活。远端未完成的退订由 owner-scoped Sat K-V 中的清理意图接管。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.operationController.abort();
    this.resetRetry();
    this.callers.clear();
    this.physical.clear();
  }

  /**
   * 取消当前网络对账，但保留 Mux 供锁屏第二阶段继续执行退订。
   * 仅取消在途操作；调用方随后可以用 `clear()` 开启独立的清理操作。
   */
  cancelInFlight(): void {
    if (this.disposed) return;
    this.operationController.abort();
    this.operationController = new AbortController();
  }

  private async reconcile(externalSignal?: AbortSignal): Promise<void> {
    const linked = linkAbortSignals(this.operationController.signal, externalSignal);
    try {
      await this.enqueue(async () => {
        try {
          throwIfAborted(linked.signal);
          if (this.disposed) throw new ChannelSubscriptionAbortError();
          const desired = new Set<string>();
          for (const channels of this.callers.values()) {
            for (const channel of channels) desired.add(channel);
          }

          // 先订阅新增频道，避免 caller 集合替换期间出现不必要的接收空窗。
          for (const channel of [...desired].sort()) {
            throwIfAborted(linked.signal);
            if (this.disposed) throw new ChannelSubscriptionAbortError();
            if (this.physical.has(channel)) continue;
            await this.options.driver.subscribe(channel, linked.signal);
            throwIfAborted(linked.signal);
            if (this.disposed) throw new ChannelSubscriptionAbortError();
            this.physical.add(channel);
          }

          // 只有最后一个 caller 释放该频道时才执行物理取消。
          for (const channel of [...this.physical].sort()) {
            throwIfAborted(linked.signal);
            if (this.disposed) throw new ChannelSubscriptionAbortError();
            if (desired.has(channel)) continue;
            await this.options.driver.unsubscribe(channel, linked.signal);
            throwIfAborted(linked.signal);
            if (this.disposed) throw new ChannelSubscriptionAbortError();
            this.physical.delete(channel);
          }
        } finally {
          linked.dispose();
        }
      });
    } finally {
      linked.dispose();
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operationTail.then(operation, operation);
    this.operationTail = next.catch(() => undefined);
    return next;
  }

  /** 退订失败不能丢失；后续重试始终读取当前 caller union。 */
  private scheduleRetry(): void {
    if (this.disposed) return;
    if (this.retryTimer) return;
    const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** Math.min(this.retryAttempts, 7)));
    this.retryAttempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.reconcile().then(
        () => this.resetRetry(),
        () => this.scheduleRetry()
      );
    }, delay);
  }

  private resetRetry(): void {
    this.retryAttempts = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

}

/** 物理请求已被 owner/页面生命周期取消；不能按 Supplier 失败重试。 */
class ChannelSubscriptionAbortError extends Error {
  constructor() {
    super("Channel subscription operation was aborted");
    this.name = "ChannelSubscriptionAbortError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof ChannelSubscriptionAbortError
    || (error instanceof Error && (error.name === "AbortError" || error.message === "Channel subscription operation was aborted"));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ChannelSubscriptionAbortError();
}

/** 让请求取消和 Mux owner teardown 任一边界都能中断同一物理请求。 */
function linkAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const signal of active) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of active) signal.removeEventListener("abort", abort);
    }
  };
}
