// Window MSE 后端：只接收已验证 Block 组成的连续字节流。
// MSE append 串行执行，读取同时受 Block 窗口和媒体时间水位限制。

import { MsFileMediaError, normalizeMediaError, throwIfMediaAborted } from "../core/errors.js";
import type { MsFileMediaElementLike } from "../core/types.js";
import type { MsFileVodSource } from "../core/blockSource.js";

export const MEDIA_LOW_WATER_SECONDS = 5;
export const MEDIA_TARGET_WATER_SECONDS = 15;
export const MEDIA_HARD_FORWARD_SECONDS = 30;
export const MEDIA_BACKWARD_SUGGESTION_SECONDS = 30;

function asMediaElement(element: MsFileMediaElementLike): HTMLMediaElement {
  return element as unknown as HTMLMediaElement;
}

function waitForEvent(target: EventTarget, type: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(new MsFileMediaError("msfile_media_cancelled")); };
    const cleanup = () => {
      target.removeEventListener(type, onEvent);
      signal.removeEventListener("abort", onAbort);
    };
    target.addEventListener(type, onEvent, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export class MsFileMseBackend {
  private readonly element: HTMLMediaElement;
  private readonly source: MsFileVodSource;
  private readonly mimeType: string;
  private readonly durationSeconds: number | undefined;
  private mediaSource: MediaSource | undefined;
  private sourceBuffer: SourceBuffer | undefined;
  private objectUrl: string | undefined;
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private internalAbort = new AbortController();
  private pumpPromise: Promise<void> | undefined;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private ended = false;
  private disposed = false;
  private unlinkExternalAbort: (() => void) | undefined;
  private readonly onFailure: (error: MsFileMediaError) => void;

  constructor(
    element: MsFileMediaElementLike,
    source: MsFileVodSource,
    mimeType: string,
    durationSeconds?: number,
    onFailure: (error: MsFileMediaError) => void = () => undefined,
  ) {
    this.element = asMediaElement(element);
    this.source = source;
    this.mimeType = mimeType;
    this.durationSeconds = durationSeconds;
    this.onFailure = onFailure;
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
    const abort = () => this.internalAbort.abort();
    if (signal.aborted) this.internalAbort.abort();
    else signal.addEventListener("abort", abort, { once: true });
    this.unlinkExternalAbort = () => signal.removeEventListener("abort", abort);
    const operationSignal = this.internalAbort.signal;
    if (typeof MediaSource === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      throw new MsFileMediaError("msfile_media_browser_capability");
    }
    const mimeCandidates = [this.mimeType, this.mimeType.split(";", 1)[0]!.trim()];
    const mimeType = mimeCandidates.find((candidate) => candidate && MediaSource.isTypeSupported(candidate));
    if (!mimeType) throw new MsFileMediaError("msfile_media_unsupported_codec");
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    this.objectUrl = URL.createObjectURL(mediaSource);
    // 先挂监听再设置 src，避免极快浏览器在 listener 建立前发出 sourceopen。
    const sourceOpen = waitForEvent(mediaSource, "sourceopen", operationSignal);
    this.element.src = this.objectUrl;
    throwIfMediaAborted(signal);
    await sourceOpen;
    if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
    try {
      this.sourceBuffer = mediaSource.addSourceBuffer(mimeType);
      this.sourceBuffer.mode = "segments";
    } catch {
      throw new MsFileMediaError("msfile_media_unsupported_codec");
    }
    if (this.durationSeconds !== undefined && Number.isFinite(this.durationSeconds)) {
      try { mediaSource.duration = this.durationSeconds; } catch { /* duration 可在 EOF 时由浏览器计算 */ }
    }
    this.streamReader = this.source.readStream(0, this.source.fileSizeNumber, operationSignal).getReader();
    const first = await this.streamReader.read();
    if (first.done || !first.value || first.value.byteLength === 0) {
      throw new MsFileMediaError("msfile_media_decode_failed");
    }
    await this.append(first.value, operationSignal);
    this.pumpPromise = this.pump(operationSignal).catch((error) => {
      if (this.disposed || this.internalAbort.signal.aborted) return;
      const normalized = error instanceof MsFileMediaError ? error : normalizeMediaError(error, signal);
      this.onFailure(normalized);
    });
  }

  private async append(data: Uint8Array, signal: AbortSignal): Promise<void> {
    const buffer = this.sourceBuffer;
    if (!buffer) throw new MsFileMediaError("msfile_media_browser_capability");
    throwIfMediaAborted(signal);
    if (buffer.updating) await waitForEvent(buffer, "updateend", signal);
    const update = waitForEvent(buffer, "updateend", signal);
    try {
      buffer.appendBuffer(data.slice().buffer);
    } catch (error) {
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        throw new MsFileMediaError("msfile_media_browser_capability");
      }
      throw new MsFileMediaError("msfile_media_decode_failed");
    }
    await update;
  }

  private bufferedAhead(): number {
    const current = Number.isFinite(this.element.currentTime) ? this.element.currentTime : 0;
    const ranges = this.element.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);
      const end = ranges.end(index);
      if (current + 0.25 >= start && current <= end + 0.25) return Math.max(0, end - current);
    }
    return 0;
  }

  private async waitWhilePaused(signal: AbortSignal): Promise<void> {
    if (this.pauseTimer !== undefined) clearTimeout(this.pauseTimer);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(new MsFileMediaError("msfile_media_cancelled")); };
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pauseTimer = setTimeout(() => { cleanup(); resolve(); }, 250);
    });
    this.pauseTimer = undefined;
  }

  private async pump(signal: AbortSignal): Promise<void> {
    const reader = this.streamReader;
    if (!reader) return;
    for (;;) {
      throwIfMediaAborted(signal);
      if (!this.started || this.element.paused) {
        await this.waitWhilePaused(signal);
        continue;
      }
      const ahead = this.bufferedAhead();
      if (ahead >= MEDIA_HARD_FORWARD_SECONDS || ahead >= MEDIA_TARGET_WATER_SECONDS) {
        await this.waitWhilePaused(signal);
        continue;
      }
      const next = await reader.read();
      if (next.done) {
        this.ended = true;
        if (this.mediaSource?.readyState === "open") {
          try { this.mediaSource.endOfStream(); } catch { /* 迟到的 endOfStream 不影响 dispose */ }
        }
        return;
      }
      if (next.value.byteLength === 0) continue;
      await this.append(next.value, signal);
    }
  }

  async play(signal: AbortSignal): Promise<void> {
    throwIfMediaAborted(signal);
    throwIfMediaAborted(this.internalAbort.signal);
    this.started = true;
    try {
      await this.element.play();
    } catch {
      throw new MsFileMediaError("msfile_media_browser_capability");
    }
  }

  pause(): void {
    this.started = false;
    this.element.pause();
  }

  async seek(seconds: number, signal: AbortSignal): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0) throw new MsFileMediaError("msfile_media_configuration");
    throwIfMediaAborted(signal);
    const ranges = this.element.buffered;
    let buffered = false;
    for (let index = 0; index < ranges.length; index += 1) {
      if (seconds >= ranges.start(index) && seconds <= ranges.end(index)) buffered = true;
    }
    if (!buffered) throw new MsFileMediaError("msfile_media_browser_capability");
    this.element.currentTime = seconds;
  }

  currentTime(): number { return Number.isFinite(this.element.currentTime) ? this.element.currentTime : 0; }
  bufferedSeconds(): number { return this.bufferedAhead(); }
  isEnded(): boolean { return this.ended || this.element.ended; }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.internalAbort.abort();
    this.unlinkExternalAbort?.();
    this.unlinkExternalAbort = undefined;
    if (this.pauseTimer !== undefined) clearTimeout(this.pauseTimer);
    this.pauseTimer = undefined;
    this.element.pause();
    try { await this.streamReader?.cancel(); } catch { /* reader 已取消 */ }
    try { this.sourceBuffer && this.mediaSource?.readyState === "open" && this.mediaSource.removeSourceBuffer(this.sourceBuffer); } catch { /* browser 已关闭 */ }
    try { this.mediaSource?.readyState === "open" && this.mediaSource.endOfStream(); } catch { /* ignore */ }
    if (this.objectUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    this.element.removeAttribute("src");
    this.element.load();
  }
}
