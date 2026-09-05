// Channel 物理订阅复用器。
//
// 这里是 Coordinator 内唯一允许把逻辑 caller 订阅集合转换成 SSP 物理
// subscribe/unsubscribe 的地方。caller 自己只拥有一份 set；物理频道是所有
// caller 的 union，不能因为某一个 caller 释放就误取消另一个 caller 仍在使用的频道。

export interface ChannelSubscriptionDriver {
  /** 向当前 SSP 连接订阅一个精确频道。 */
  subscribe(channel: string): Promise<void>;
  /** 从当前 SSP 连接取消一个精确频道。 */
  unsubscribe(channel: string): Promise<void>;
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
  async set(callerId: string, channels: readonly string[]): Promise<readonly string[]> {
    if (this.disposed) throw new Error("Channel subscription mux is disposed");
    if (typeof callerId !== "string" || callerId.length === 0) {
      throw new Error("callerId must be non-empty");
    }
    const normalized = normalizeChannels(channels);
    if (normalized.length === 0) this.callers.delete(callerId);
    else this.callers.set(callerId, new Set(normalized));
    try {
      await this.reconcile();
      this.resetRetry();
    } catch {
      // 逻辑集合已经通过入口校验并提交；物理 Supplier 失败只进入
      // 后台重试。Coordinator 必须仍然返回 result.channels，不能让
      // 代理先后得到“新逻辑集合”和异常而发生权限过滤分叉。
      this.scheduleRetry();
    }
    return this.callerChannels(callerId);
  }

  /** 释放 caller，不保存任何 session 信息。 */
  release(callerId: string): void {
    if (this.disposed) return;
    this.callers.delete(callerId);
    void this.reconcile().then(
      () => this.resetRetry(),
      () => this.scheduleRetry()
    );
  }

  /** 释放所有逻辑 caller；用于锁屏、owner 切换和 Worker teardown。 */
  async clear(): Promise<void> {
    if (this.disposed) return;
    this.callers.clear();
    try {
      await this.reconcile();
      this.resetRetry();
    } catch (error) {
      this.scheduleRetry();
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
    this.resetRetry();
    this.callers.clear();
    this.physical.clear();
  }

  private async reconcile(): Promise<void> {
    await this.enqueue(async () => {
      if (this.disposed) return;
      const desired = new Set<string>();
      for (const channels of this.callers.values()) {
        for (const channel of channels) desired.add(channel);
      }

      // 先订阅新增频道，避免 caller 集合替换期间出现不必要的接收空窗。
      for (const channel of [...desired].sort()) {
        if (this.disposed) return;
        if (this.physical.has(channel)) continue;
        await this.options.driver.subscribe(channel);
        if (this.disposed) return;
        this.physical.add(channel);
      }

      // 只有最后一个 caller 释放该频道时才执行物理取消。
      for (const channel of [...this.physical].sort()) {
        if (this.disposed) return;
        if (desired.has(channel)) continue;
        await this.options.driver.unsubscribe(channel);
        if (this.disposed) return;
        this.physical.delete(channel);
      }
    });
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
