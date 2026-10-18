// 内核时间与事件编号：宿主必须给内核单调未回退的 receivedAt，且 occurredAt ≤ receivedAt。

/** 单调毫秒时钟：宿主 `Date.now()` 回拨时不倒流。 */
export class MonotonicClock {
  private last = 0;

  now(): number {
    const current = Date.now();
    if (current > this.last) this.last = current;
    return this.last;
  }

  /** 把已知时间戳推进到不小于当前值。 */
  advance(at: number): number {
    const current = Number.isFinite(at) ? Math.floor(at) : 0;
    if (current > this.last) this.last = current;
    return this.last;
  }
}

/**
 * 事件时间：`receivedAt` 单调不回退；`occurredAt` 可以早于 receivedAt（晚到的可信事实），
 * 但不能晚于 receivedAt；负值一律归零。
 */
export function schedulerEventTimes(occurredAt: number, receivedAt: number): { occurredAt: number; receivedAt: number } {
  const received = Math.max(0, Number.isFinite(receivedAt) ? Math.floor(receivedAt) : 0);
  const occurred = Math.max(0, Math.min(Number.isFinite(occurredAt) ? Math.floor(occurredAt) : received, received));
  return { occurredAt: occurred, receivedAt: received };
}

/**
 * 稳定事件编号：同一事实在重放与重启后必须复用同一编号，否则内核会重复推进状态。
 * 约定沿用宿主 journal 命名（例如 `kind5-<authorizationIdHex>`、`funding-txid-<txid>`）。
 */
export function schedulerEventId(prefix: string, ...parts: Array<string | number>): string {
  return [prefix, ...parts].join(":");
}
