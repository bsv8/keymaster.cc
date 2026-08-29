// Window 侧 progressive MP4 转封装 Worker 控制器。
// Worker 只负责 Mediabunny demux/mux；每个输入 range 仍回到
// MsFileVodSource，输出片段在 append 完成后才向 Worker ack，形成明确背压。

import { MsFileMediaError, normalizeMediaError, throwIfMediaAborted } from "../core/errors.js";
import type { MsFileVodSource } from "../core/blockSource.js";

interface WorkerMessage {
  type: "transmux-ready" | "transmux-error" | "transmux-pump-done" | "range" | "transmux-chunk";
  requestId: string;
  code?: string;
  mimeType?: string;
  done?: boolean;
  probeRequestId?: string;
  start?: number;
  end?: number;
  chunkId?: string;
  bytes?: ArrayBuffer;
}

const BLOCK_BYTES = 256 * 1024;
const MAX_RANGE_BLOCKS = 8;

function stableError(code: unknown): MsFileMediaError {
  const known = new Set<MsFileMediaError["code"]>([
    "msfile_media_configuration",
    "msfile_media_network",
    "msfile_media_amount",
    "msfile_media_integrity",
    "msfile_media_unsupported_container",
    "msfile_media_unsupported_codec",
    "msfile_media_browser_capability",
    "msfile_media_decode_failed",
    "msfile_media_cancelled",
  ]);
  return new MsFileMediaError(known.has(code as MsFileMediaError["code"]) ? code as MsFileMediaError["code"] : "msfile_media_decode_failed");
}

export interface MsFileMp4TransmuxerOptions {
  /** append 完成后才 resolve，用于把 Worker 输出连接到 MSE 的背压。 */
  append(data: Uint8Array, signal: AbortSignal): Promise<void>;
}

export class MsFileMp4Transmuxer {
  private readonly source: MsFileVodSource;
  private readonly append: MsFileMp4TransmuxerOptions["append"];
  private worker: Worker | undefined;
  private readonly requestId = `transmux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  private operationSignal: AbortSignal | undefined;
  private readyPromise: Promise<void> | undefined;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: MsFileMediaError) => void) | undefined;
  private pumpPromise: Promise<boolean> | undefined;
  private resolvePump: ((done: boolean) => void) | undefined;
  private rejectPump: ((error: MsFileMediaError) => void) | undefined;
  private disposed = false;

  constructor(source: MsFileVodSource, options: MsFileMp4TransmuxerOptions) {
    this.source = source;
    this.append = options.append;
  }

  private fail(error: unknown): MsFileMediaError {
    const normalized = error instanceof MsFileMediaError
      ? error
      : normalizeMediaError(error, this.operationSignal);
    this.rejectReady?.(normalized);
    this.rejectPump?.(normalized);
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    this.resolvePump = undefined;
    this.rejectPump = undefined;
    this.pumpPromise = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    return normalized;
  }

  private postRangeResult(requestId: string, bytes: Uint8Array): void {
    const worker = this.worker;
    if (!worker || this.disposed) return;
    const copy = bytes.slice();
    try {
      worker.postMessage({ type: "range-result", requestId, bytes: copy.buffer }, [copy.buffer]);
    } catch {
      this.fail(new MsFileMediaError("msfile_media_network"));
    }
  }

  private postRangeError(requestId: string, error: unknown): void {
    const worker = this.worker;
    if (!worker || this.disposed) return;
    const normalized = error instanceof MsFileMediaError
      ? error
      : normalizeMediaError(error, this.operationSignal);
    try { worker.postMessage({ type: "range-result", requestId, code: normalized.code }); } catch { this.fail(normalized); }
  }

  private async consumeChunk(message: WorkerMessage): Promise<void> {
    const worker = this.worker;
    const signal = this.operationSignal;
    if (!worker || !signal || this.disposed || message.chunkId === undefined || !(message.bytes instanceof ArrayBuffer)) return;
    try {
      throwIfMediaAborted(signal);
      await this.append(new Uint8Array(message.bytes), signal);
      if (!this.disposed) worker.postMessage({ type: "chunk-ack", requestId: this.requestId, chunkId: message.chunkId });
    } catch (error) {
      const normalized = error instanceof MsFileMediaError ? error : normalizeMediaError(error, signal);
      try { worker.postMessage({ type: "chunk-ack", requestId: this.requestId, chunkId: message.chunkId, code: normalized.code }); } catch { /* Worker 已失效 */ }
      this.fail(normalized);
    }
  }

  private onMessage = (event: MessageEvent<WorkerMessage>): void => {
    const message = event.data;
    if (!message || this.disposed) return;
    // range 的 requestId 是本次 range 调用的临时 ID；外层会话 ID 放在
    // probeRequestId 中。不能先按 message.requestId 做统一过滤，否则
    // Worker 发出的所有输入读取都会被 Window 静默丢弃。
    if (message.type === "range") {
      if (message.probeRequestId !== this.requestId || message.start === undefined || message.end === undefined) return;
      const { start, end } = message;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > this.source.fileSizeNumber ||
        end - start > MAX_RANGE_BLOCKS * BLOCK_BYTES) {
        this.postRangeError(message.requestId, new MsFileMediaError("msfile_media_configuration"));
        return;
      }
      void this.source.readRange(start, end, this.operationSignal)
        .then((bytes) => this.postRangeResult(message.requestId, bytes))
        .catch((error: unknown) => this.postRangeError(message.requestId, error));
      return;
    }
    if (message.requestId !== this.requestId) return;
    if (message.type === "transmux-ready") {
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      return;
    }
    if (message.type === "transmux-error") {
      this.fail(stableError(message.code));
      return;
    }
    if (message.type === "transmux-pump-done") {
      const resolve = this.resolvePump;
      this.resolvePump = undefined;
      this.rejectPump = undefined;
      this.pumpPromise = undefined;
      resolve?.(message.done === true);
      return;
    }
    if (message.type === "transmux-chunk") void this.consumeChunk(message);
  };

  async start(signal: AbortSignal): Promise<void> {
    if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
    if (this.readyPromise) return this.readyPromise;
    throwIfMediaAborted(signal);
    if (typeof Worker === "undefined") throw new MsFileMediaError("msfile_media_browser_capability");
    let worker: Worker;
    try {
      worker = new Worker(new URL("./mediaTransmux.worker.ts", import.meta.url), { type: "module" });
    } catch {
      throw new MsFileMediaError("msfile_media_browser_capability");
    }
    this.worker = worker;
    this.operationSignal = signal;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const onAbort = () => this.fail(new MsFileMediaError("msfile_media_cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = this.onMessage;
    worker.onerror = () => this.fail(new MsFileMediaError("msfile_media_decode_failed"));
    worker.onmessageerror = () => this.fail(new MsFileMediaError("msfile_media_decode_failed"));
    const readyPromise = this.readyPromise;
    try {
      worker.postMessage({
        type: "start",
        requestId: this.requestId,
        fileSizeBytes: this.source.fileSizeNumber,
        maxSourceCacheBytes: this.source.maxCacheBytes,
      });
    } catch {
      this.fail(new MsFileMediaError("msfile_media_network"));
    }
    try {
      await readyPromise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async pump(untilSeconds: number, signal: AbortSignal): Promise<boolean> {
    await this.start(signal);
    throwIfMediaAborted(signal);
    if (this.disposed || !this.worker) throw new MsFileMediaError("msfile_media_cancelled");
    if (this.pumpPromise) throw new MsFileMediaError("msfile_media_configuration");
    const pumpPromise = new Promise<boolean>((resolve, reject) => {
      this.resolvePump = resolve;
      this.rejectPump = reject;
    });
    this.pumpPromise = pumpPromise;
    try {
      this.worker.postMessage({ type: "pump", requestId: this.requestId, untilSeconds });
    } catch {
      this.fail(new MsFileMediaError("msfile_media_network"));
    }
    return pumpPromise;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    this.worker = undefined;
    const cancelled = new MsFileMediaError("msfile_media_cancelled");
    this.rejectReady?.(cancelled);
    this.rejectPump?.(cancelled);
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    this.resolvePump = undefined;
    this.rejectPump = undefined;
    this.pumpPromise = undefined;
    if (worker) {
      try { worker.postMessage({ type: "cancel", requestId: this.requestId }); } catch { /* Worker 已失效 */ }
      worker.terminate();
    }
  }
}
