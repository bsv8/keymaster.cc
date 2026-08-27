// packages/plugin-msfile/src/readStream.ts
// Read stream：请求覆盖（同 hash 更大 request ID）、乱序响应关联、
// stale 淘汰与 ReadCancelled 终态（wire 规范 §8）。

import { createRequestIdCounter, FrameWriter, startReceiveLoop, StreamClosedError, type WireDuplex } from "./wireStream.js";
import { encodeReadRequest, type WireMessage } from "./frameCodec.js";

export const WIRE_PRICE_LIMIT_EXCEEDED = "price_limit_exceeded";

export type ReadOutcome =
  | { type: "ok"; contentHashHex: string; content: Uint8Array }
  | { type: "integrity-failed" }
  | { type: "price-limit-exceeded" }
  | { type: "cancelled"; replacedByRequestId: bigint }
  | { type: "supplier-error"; errorCode: string }
  /** stream EOF/Reset/协议错误等传输层失败；不得映射为业务 absent。 */
  | { type: "transport-failed" };

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface PendingEntry {
  contentHashHex: string;
  maxContentBytes: number;
  /** 同 hash 的更大 request id 已覆盖本请求，等待取消或迟到 attachment。 */
  supersededBy?: bigint;
  resolve(outcome: ReadOutcome): void;
  /** 直接完成 Promise；调用方必须先 settle，避免重复结算。 */
  rawResolve(outcome: ReadOutcome): void;
  reject(error: Error): void;
  settled: boolean;
  detachSignal?: () => void;
}

/**
 * 单条 Read stream 的客户端状态。
 *
 * - 同一 content hash 的更大 request ID 覆盖旧请求：旧请求收到 ReadCancelled；
 *   若旧请求在覆盖前已返回成功，客户端仍消费完整 Frame 并丢弃 stale 结果；
 * - 未终结请求随 stream 失败一起进入传输失败，绝不悬挂 Promise；
 * - AbortSignal 只中止本地等待并移除未决条目。
 */
export class ReadStreamSession {
  private readonly pending = new Map<bigint, PendingEntry>();
  private readonly latestByHash = new Map<string, bigint>();
  private readonly counter = createRequestIdCounter();
  private readonly writer: FrameWriter;
  private readonly stopLoop: () => void;
  private disposed = false;
  private failed = false;

  constructor(private readonly duplex: WireDuplex) {
    this.writer = new FrameWriter(duplex);
    this.stopLoop = startReceiveLoop(duplex, {
      onMessage: (message) => this.handleMessage(message),
      onFailure: () => {
        this.failed = true;
        this.failAllPending();
      },
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get isUsable(): boolean {
    return !this.disposed && !this.failed;
  }

  /**
   * 发送一次 wire Read。金额由 service 层解析后传入，本层不做决策。
   * 返回的 Promise 携带 `requestId` 便于日志与覆盖关联。
   */
  send(input: {
    contentHashBytes: Uint8Array;
    maxPriceSatoshis: bigint;
    maxContentBytes: number;
    signal?: AbortSignal;
  }): Promise<ReadOutcome> & { requestId: bigint } {
    const requestId = this.counter.take();
    let resolveFn!: (outcome: ReadOutcome) => void;
    let rejectFn!: (error: Error) => void;
    const promise = Object.assign(
      new Promise<ReadOutcome>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      }),
      { requestId }
    ) as Promise<ReadOutcome> & { requestId: bigint };

    const entry: PendingEntry = {
      contentHashHex: toHex(input.contentHashBytes),
      maxContentBytes: input.maxContentBytes,
      resolve: (outcome) => {
        if (!this.settle(requestId)) return;
        resolveFn(outcome);
      },
      rawResolve: resolveFn,
      reject: (error) => {
        if (!this.settle(requestId)) return;
        rejectFn(error);
      },
      settled: false,
    };
    const previousRequestId = this.latestByHash.get(entry.contentHashHex);
    if (previousRequestId !== undefined) {
      const previous = this.pending.get(previousRequestId);
      if (previous && !previous.settled) previous.supersededBy = requestId;
    }
    this.latestByHash.set(entry.contentHashHex, requestId);
    this.pending.set(requestId, entry);

    const onAbort = () => {
      if (entry.settled) return;
      if (this.pending.delete(requestId)) {
        entry.settled = true;
        if (this.latestByHash.get(entry.contentHashHex) === requestId) this.latestByHash.delete(entry.contentHashHex);
        rejectFn(new DOMException("The operation was aborted", "AbortError"));
      }
    };
    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
        return promise;
      }
      input.signal.addEventListener("abort", onAbort, { once: true });
      entry.detachSignal = () => input.signal?.removeEventListener("abort", onAbort);
    }

    void this.writer
      .enqueue(encodeReadRequest(requestId, input.contentHashBytes, input.maxPriceSatoshis))
      .catch((error: unknown) => {
        // 写失败意味着 stream 已不可用；让本请求与其余未决一起进入传输失败。
        if (!entry.settled && this.pending.has(requestId)) this.failAllPending();
        else entry.reject?.(error instanceof Error ? error : new Error(String(error)));
      });
    return promise;
  }

  /** 返回是否发生了本次结算（用于幂等）。 */
  private settle(requestId: bigint, after?: () => void): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.settled) return false;
    this.pending.delete(requestId);
    entry.settled = true;
    if (this.latestByHash.get(entry.contentHashHex) === requestId) this.latestByHash.delete(entry.contentHashHex);
    entry.detachSignal?.();
    after?.();
    return true;
  }

  private handleMessage(message: WireMessage): boolean {
    switch (message.kind) {
      case "read-response": {
        const entry = this.pending.get(message.requestId);
        if (!entry || message.attachment === undefined) return true; // stale：读完即淘汰
        if (entry.supersededBy !== undefined) {
          this.settle(message.requestId, () => entry.rawResolve({ type: "cancelled", replacedByRequestId: entry.supersededBy! }));
          return true;
        }
        if (toHex(message.contentHash) !== entry.contentHashHex) {
          this.settle(message.requestId, () => entry.rawResolve({ type: "integrity-failed" }));
          this.poisonAfterResponse();
          return true;
        }
        if (message.attachment.length > entry.maxContentBytes) {
          this.settle(message.requestId, () => entry.rawResolve({ type: "integrity-failed" }));
          this.poisonAfterResponse();
          return true;
        }
        entry.resolve({ type: "ok", contentHashHex: entry.contentHashHex, content: message.attachment });
        return true;
      }
      case "read-cancelled": {
        const entry = this.pending.get(message.requestId);
        if (!entry) return true;
        entry.resolve({ type: "cancelled", replacedByRequestId: entry.supersededBy ?? message.replacedByRequestId });
        return true;
      }
      case "error-response": {
        if (message.requestKind !== 3) return true;
        const entry = this.pending.get(message.requestId);
        if (!entry) return true;
        if (message.errorCode === WIRE_PRICE_LIMIT_EXCEEDED) entry.resolve({ type: "price-limit-exceeded" });
        else entry.resolve({ type: "supplier-error", errorCode: message.errorCode });
        return true;
      }
      default:
        return true;
    }
  }

  private failAllPending(): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.settled) continue;
      this.pending.delete(id);
      entry.settled = true;
      if (this.latestByHash.get(entry.contentHashHex) === id) this.latestByHash.delete(entry.contentHashHex);
      entry.detachSignal?.();
      entry.rawResolve({ type: "transport-failed" });
    }
  }

  private poisonAfterResponse(): void {
    this.failed = true;
    this.failAllPending();
    void this.duplex.close().catch(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    this.failAllPending();
    void this.duplex.close().catch(() => undefined);
  }
}

/** Stat stream 的响应关联表：同一 seed_hash 只保留最大 stat_request_id 的结果。 */
export class StatResponseTable<T> {
  private latestPerHash = new Map<string, { requestId: bigint; value: T }>();

  apply(requestId: bigint, seedHashHex: string, value: T): T | undefined {
    const existing = this.latestPerHash.get(seedHashHex);
    if (existing && existing.requestId >= requestId) return undefined; // stale
    this.latestPerHash.set(seedHashHex, { requestId, value });
    return value;
  }

  latest(seedHashHex: string): T | undefined {
    return this.latestPerHash.get(seedHashHex)?.value;
  }

  clear(): void {
    this.latestPerHash.clear();
  }
}

export { StreamClosedError };
