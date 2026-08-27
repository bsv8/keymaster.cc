// apps/web/src/msfileSpike/transferQueue.ts
// 施工单 001 §3.4：Coordinator ↔ executor 的有界 transferable 队列。
//
// - 每项与总字节都有硬上限，超限立即拒绝（不静默丢弃）；
// - 默认使用 structuredClone(value, {transfer}) 证明“移动而非复制”：
//   入队后原 ArrayBuffer 被 detach（byteLength 变为 0）；
// - abort(id) 移除队列项并拒绝对应 Promise；
// - close() 使所有未决请求以稳定英文错误失败；
// - 高水位字节计数用于峰值内存采样。

export interface TransferQueueLimits {
  maxItems: number;
  maxTotalBytes: number;
}

export interface TransferQueueEntry {
  id: string;
  bytes: ArrayBuffer;
}

export type TransferMove = <T>(value: T, transfer: ArrayBuffer[]) => T;

function defaultMove<T>(value: T, transfer: ArrayBuffer[]): T {
  return structuredClone(value, { transfer });
}

export class TransferQueueClosedError extends Error {
  constructor(message = "MSFile spike transfer queue is closed") {
    super(message);
    this.name = "TransferQueueClosedError";
  }
}

export class TransferQueueOverflowError extends Error {
  constructor(public readonly kind: "items" | "bytes", message: string) {
    super(message);
    this.name = "TransferQueueOverflowError";
  }
}

interface PendingItem {
  entry: TransferQueueEntry;
  resolve: (entry: TransferQueueEntry) => void;
  reject: (error: Error) => void;
}

export class TransferQueue {
  private readonly pending: PendingItem[] = [];
  private pendingBytes = 0;
  private highWaterBytes = 0;
  private closedReason: string | undefined;

  constructor(
    private readonly limits: TransferQueueLimits,
    private readonly move: TransferMove = defaultMove
  ) {}

  get pendingCount(): number {
    return this.pending.length;
  }

  get pendingByteLength(): number {
    return this.pendingBytes;
  }

  /** 峰值内存采样：入队后瞬时最大未消费字节数。 */
  get peakPendingByteLength(): number {
    return this.highWaterBytes;
  }

  get isClosed(): boolean {
    return this.closedReason !== undefined;
  }

  /**
   * 入队并等待被 drain。字节数按移动后的缓冲计；超过任一上限即抛
   * OverflowError。成功时原缓冲已被 transfer detach。
   */
  async enqueue(entry: TransferQueueEntry): Promise<TransferQueueEntry> {
    if (this.closedReason !== undefined) throw new TransferQueueClosedError(this.closedReason);
    const byteLength = entry.bytes.byteLength;
    if (this.pending.length + 1 > this.limits.maxItems) {
      throw new TransferQueueOverflowError("items", `queue item limit reached (${this.limits.maxItems})`);
    }
    if (byteLength > this.limits.maxTotalBytes || this.pendingBytes + byteLength > this.limits.maxTotalBytes) {
      throw new TransferQueueOverflowError("bytes", `queue byte limit reached (${this.limits.maxTotalBytes})`);
    }
    // 移动语义：transfer 后原 buffer detach，证明没有隐式整包复制。
    const moved = this.move({ ...entry }, [entry.bytes]);
    return new Promise<TransferQueueEntry>((resolve, reject) => {
      this.pending.push({ entry: moved, resolve, reject });
      this.pendingBytes += moved.bytes.byteLength;
      if (this.pendingBytes > this.highWaterBytes) this.highWaterBytes = this.pendingBytes;
    });
  }

  /** 取出最早的一项；队列空返回 undefined。 */
  drain(): TransferQueueEntry | undefined {
    const head = this.pending.shift();
    if (!head) return undefined;
    this.pendingBytes -= head.entry.bytes.byteLength;
    head.resolve(head.entry);
    return head.entry;
  }

  /** 取消单个未决项：其 Promise 以 AbortError 拒绝并释放字节配额。 */
  abort(id: string): boolean {
    const index = this.pending.findIndex((item) => item.entry.id === id);
    if (index < 0) return false;
    const [item] = this.pending.splice(index, 1);
    this.pendingBytes -= item!.entry.bytes.byteLength;
    item!.reject(new DOMException("The operation was aborted", "AbortError"));
    return true;
  }

  /** 关闭队列：所有未决请求失败；后续 enqueue 一律拒绝。 */
  close(reason = "MSFile spike transfer queue is closed"): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    while (this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.pendingBytes -= item.entry.bytes.byteLength;
      item.reject(new TransferQueueClosedError(reason));
    }
  }
}
