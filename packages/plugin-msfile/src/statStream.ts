// MSFile Stat 长驻 stream 客户端。
//
// 每条 supplier connection 只建立一个 Stat stream。Frame decoder 负责增量
// 解码与协议毒化，pending 表按 request id 关联乱序响应；stream 关闭时所有
// 未决请求都收到确定的 transport failure，避免 Coordinator 永久等待。

import { encodeStatRequest, type StatResponsePayload } from "./frameCodec.js";
import { FrameWriter, startReceiveLoop, type WireDuplex } from "./wireStream.js";

export type StatStreamOutcome =
  | { type: "ok"; payload: StatResponsePayload }
  | { type: "transport-failed" };

interface PendingStat {
  resolve: (outcome: StatStreamOutcome) => void;
  reject: (error: Error) => void;
  settled: boolean;
  detachSignal?: () => void;
}

export class StatStreamSession {
  private readonly writer: FrameWriter;
  private readonly pending = new Map<bigint, PendingStat>();
  private readonly stopLoop: () => void;
  private nextRequestId = 1n;
  private disposed = false;
  private failed = false;

  constructor(private readonly duplex: WireDuplex, private readonly maxPending = 16) {
    this.writer = new FrameWriter(duplex);
    this.stopLoop = startReceiveLoop(duplex, {
      onMessage: (message) => {
        if (message.kind !== "stat-response" && message.kind !== "error-response") return true;
        const entry = this.pending.get(message.requestId);
        if (!entry || entry.settled) return true;
        if (message.kind === "stat-response") {
          this.settle(message.requestId, () => entry.resolve({ type: "ok", payload: message.payload }));
        } else if (message.requestKind === 1) {
          // Stat 的供应商业务错误属于本轮不可用，不能伪装 absent。
          this.settle(message.requestId, () => entry.resolve({ type: "transport-failed" }));
        }
        return true;
      },
      onFailure: () => {
        this.failed = true;
        this.failAll();
      },
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get isUsable(): boolean {
    return !this.disposed && !this.failed;
  }

  async send(seedHash: Uint8Array, signal?: AbortSignal): Promise<StatStreamOutcome> {
    if (this.disposed) return { type: "transport-failed" };
    if (seedHash.byteLength !== 32 || this.pending.size >= this.maxPending) {
      return { type: "transport-failed" };
    }
    const requestId = this.nextRequestId;
    if (requestId > 0xffffffffffffffffn) return { type: "transport-failed" };
    this.nextRequestId += 1n;

    let resolveFn!: (outcome: StatStreamOutcome) => void;
    let rejectFn!: (error: Error) => void;
    const promise = new Promise<StatStreamOutcome>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const entry: PendingStat = {
      resolve: resolveFn,
      reject: rejectFn,
      settled: false,
    };
    this.pending.set(requestId, entry);

    const onAbort = () => {
      if (entry.settled) return;
      this.pending.delete(requestId);
      entry.settled = true;
      entry.detachSignal?.();
      rejectFn(new DOMException("The operation was aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return promise;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      entry.detachSignal = () => signal.removeEventListener("abort", onAbort);
    }

    try {
      await this.writer.enqueue(encodeStatRequest(requestId, seedHash));
    } catch (error) {
      if (!entry.settled && this.pending.has(requestId)) this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  private settle(requestId: bigint, finish: () => void): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.settled) return;
    this.pending.delete(requestId);
    entry.settled = true;
    entry.detachSignal?.();
    finish();
  }

  private failAll(error = new Error("msfile Stat stream failed")): void {
    for (const [requestId, entry] of [...this.pending]) {
      this.settle(requestId, () => entry.resolve({ type: "transport-failed" }));
    }
    void error;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    this.failAll();
    void this.duplex.close().catch(() => undefined);
  }
}
