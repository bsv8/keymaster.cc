// Window MSE 后端：只接收已验证 Block 组成的连续字节流。
// MSE append 串行执行，读取同时受 Block 窗口和媒体时间水位限制。

import { MsFileMediaError, normalizeMediaError, throwIfMediaAborted } from "../core/errors.js";
import type { MsFileMediaElementLike } from "../core/types.js";
import type { MsFileVodSource } from "../core/blockSource.js";
import { MsFileMp4Transmuxer } from "./mediaTransmux.js";

export const MEDIA_LOW_WATER_SECONDS = 5;
export const MEDIA_TARGET_WATER_SECONDS = 15;
export const MEDIA_HARD_FORWARD_SECONDS = 30;
export const MEDIA_BACKWARD_SUGGESTION_SECONDS = 30;
const MEDIA_SEEK_TOLERANCE_SECONDS = 0.25;

export interface MsFileMseBackendOptions {
  /** 普通 MP4 需要先转成 fMP4；原生分段 MP4/MP3/WebM 仍可直接追加。 */
  transmuxProgressiveMp4?: boolean;
}

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
  private transmuxer: MsFileMp4Transmuxer | undefined;
  private readonly transmuxProgressiveMp4: boolean;
  private transmuxPumpPromise: Promise<boolean> | undefined;
  private transmuxUntilSeconds = 0;
  private transmuxDone = false;
  private appendedData = false;
  private internalAbort = new AbortController();
  private pumpPromise: Promise<void> | undefined;
  private readonly pauseTimers = new Set<ReturnType<typeof setTimeout>>();
  private started = false;
  private ended = false;
  private disposed = false;
  private pendingSeekSeconds: number | undefined;
  private pumpFailure: MsFileMediaError | undefined;
  private unlinkExternalAbort: (() => void) | undefined;
  private readonly onFailure: (error: MsFileMediaError) => void;

  constructor(
    element: MsFileMediaElementLike,
    source: MsFileVodSource,
    mimeType: string,
    durationSeconds?: number,
    onFailure: (error: MsFileMediaError) => void = () => undefined,
    options: MsFileMseBackendOptions = {},
  ) {
    this.element = asMediaElement(element);
    this.source = source;
    this.mimeType = mimeType;
    this.durationSeconds = durationSeconds;
    this.transmuxProgressiveMp4 = options.transmuxProgressiveMp4 === true;
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
    if (this.transmuxProgressiveMp4) {
      const transmuxer = new MsFileMp4Transmuxer(this.source, {
        append: (data, appendSignal) => this.append(data, appendSignal),
      });
      this.transmuxer = transmuxer;
      await this.requestTransmux(MEDIA_TARGET_WATER_SECONDS, operationSignal);
      // 极少数文件的第一个关键帧距离文件起点很远；允许再推进一次，
      // 但仍以媒体时间而不是“读取完整文件”作为转封装水位。
      if (this.element.buffered.length === 0 && !this.transmuxDone) {
        await this.requestTransmux(MEDIA_HARD_FORWARD_SECONDS, operationSignal);
      }
      if (!this.appendedData || this.element.buffered.length === 0) {
        throw new MsFileMediaError("msfile_media_decode_failed");
      }
    } else {
      this.streamReader = this.source.readStream(0, this.source.fileSizeNumber, operationSignal).getReader();
      const first = await this.streamReader.read();
      if (first.done || !first.value || first.value.byteLength === 0) {
        throw new MsFileMediaError("msfile_media_decode_failed");
      }
      await this.append(first.value, operationSignal);
    }
    this.pumpPromise = this.pump(operationSignal).catch((error) => {
      if (this.disposed || this.internalAbort.signal.aborted) return;
      const normalized = error instanceof MsFileMediaError ? error : normalizeMediaError(error, signal);
      this.pumpFailure = normalized;
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
    this.appendedData = true;
    await this.trimOldBuffer(signal);
  }

  private isTimeBuffered(seconds: number): boolean {
    const ranges = this.element.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      if (seconds + MEDIA_SEEK_TOLERANCE_SECONDS >= ranges.start(index) &&
        seconds <= ranges.end(index) + MEDIA_SEEK_TOLERANCE_SECONDS) return true;
    }
    return false;
  }

  /**
   * MSE 不会自动回收已播放数据。这里只保留当前位置之前 30 秒，避免长视频
   * 一直 append 最终触发 QuotaExceededError。remove 与 append 共用同一串行链路。
   */
  private async trimOldBuffer(signal: AbortSignal): Promise<void> {
    const buffer = this.sourceBuffer;
    if (!buffer || buffer.updating) return;
    const cutoff = this.currentTime() - MEDIA_BACKWARD_SUGGESTION_SECONDS;
    if (cutoff <= 0) return;
    const ranges = buffer.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);
      const end = Math.min(ranges.end(index), cutoff);
      if (end <= start + MEDIA_SEEK_TOLERANCE_SECONDS) continue;
      const update = waitForEvent(buffer, "updateend", signal);
      try {
        buffer.remove(start, end);
      } catch {
        // 浏览器可能正处于 readyState 切换；回收失败不应破坏当前可播放数据。
        return;
      }
      await update;
    }
  }

  private endOfStream(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.mediaSource?.readyState === "open") {
      try { this.mediaSource.endOfStream(); } catch { /* 迟到的 endOfStream 不影响 dispose */ }
    }
  }

  private async requestTransmux(untilSeconds: number, signal: AbortSignal): Promise<boolean> {
    const transmuxer = this.transmuxer;
    if (!transmuxer || this.transmuxPumpPromise) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    const request = transmuxer.pump(untilSeconds, signal);
    this.transmuxPumpPromise = request;
    try {
      const done = await request;
      this.transmuxUntilSeconds = Math.max(this.transmuxUntilSeconds, untilSeconds);
      this.transmuxDone = done;
      if (done) this.endOfStream();
      return done;
    } finally {
      if (this.transmuxPumpPromise === request) this.transmuxPumpPromise = undefined;
    }
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
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(new MsFileMediaError("msfile_media_cancelled")); };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        if (timer !== undefined) {
          clearTimeout(timer);
          this.pauseTimers.delete(timer);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { cleanup(); resolve(); }, 250);
      this.pauseTimers.add(timer);
      if (signal.aborted) onAbort();
    });
  }

  private async pump(signal: AbortSignal): Promise<void> {
    if (this.transmuxer) {
      for (;;) {
        throwIfMediaAborted(signal);
        if (this.ended) return;
        const seekTarget = this.pendingSeekSeconds;
        if (seekTarget !== undefined && this.isTimeBuffered(seekTarget)) {
          await this.waitWhilePaused(signal);
          continue;
        }
        if (seekTarget === undefined && (!this.started || this.element.paused)) {
          await this.waitWhilePaused(signal);
          continue;
        }
        const ahead = this.bufferedAhead();
        if (seekTarget === undefined && (ahead >= MEDIA_HARD_FORWARD_SECONDS || ahead >= MEDIA_TARGET_WATER_SECONDS)) {
          await this.waitWhilePaused(signal);
          continue;
        }
        const current = Number.isFinite(this.element.currentTime) ? this.element.currentTime : 0;
        const until = Math.max(
          this.transmuxUntilSeconds + MEDIA_TARGET_WATER_SECONDS,
          (seekTarget ?? current) + MEDIA_TARGET_WATER_SECONDS,
          MEDIA_TARGET_WATER_SECONDS,
        );
        await this.requestTransmux(until, signal);
      }
    }
    const reader = this.streamReader;
    if (!reader) return;
    for (;;) {
      throwIfMediaAborted(signal);
      const seekTarget = this.pendingSeekSeconds;
      if (seekTarget !== undefined && this.isTimeBuffered(seekTarget)) {
        await this.waitWhilePaused(signal);
        continue;
      }
      if (seekTarget === undefined && (!this.started || this.element.paused)) {
        await this.waitWhilePaused(signal);
        continue;
      }
      const ahead = this.bufferedAhead();
      if (seekTarget === undefined && (ahead >= MEDIA_HARD_FORWARD_SECONDS || ahead >= MEDIA_TARGET_WATER_SECONDS)) {
        await this.waitWhilePaused(signal);
        continue;
      }
      const next = await reader.read();
      if (next.done) {
        this.endOfStream();
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
    if (!Number.isFinite(seconds) || seconds < 0 ||
      (this.durationSeconds !== undefined && seconds > this.durationSeconds + MEDIA_SEEK_TOLERANCE_SECONDS)) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    throwIfMediaAborted(signal);
    this.element.currentTime = seconds;
    if (this.isTimeBuffered(seconds) ||
      (this.durationSeconds !== undefined && seconds >= this.durationSeconds - MEDIA_SEEK_TOLERANCE_SECONDS)) return;

    // 缓存外 seek 不是浏览器能力错误。把目标交给现有串行 pump，即使当前
    // 处于暂停状态也继续有界读取，直到目标时间进入 SourceBuffer。
    this.pendingSeekSeconds = seconds;
    try {
      for (;;) {
        throwIfMediaAborted(signal);
        throwIfMediaAborted(this.internalAbort.signal);
        if (this.pumpFailure) throw this.pumpFailure;
        if (this.isTimeBuffered(seconds)) return;
        if (this.ended) throw new MsFileMediaError("msfile_media_decode_failed");
        await this.waitWhilePaused(signal);
      }
    } finally {
      if (this.pendingSeekSeconds === seconds) this.pendingSeekSeconds = undefined;
    }
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
    for (const timer of this.pauseTimers) clearTimeout(timer);
    this.pauseTimers.clear();
    this.element.pause();
    try { await this.streamReader?.cancel(); } catch { /* reader 已取消 */ }
    const transmuxer = this.transmuxer;
    this.transmuxer = undefined;
    try { await transmuxer?.dispose(); } catch { /* Worker 已取消 */ }
    try { this.sourceBuffer && this.mediaSource?.readyState === "open" && this.mediaSource.removeSourceBuffer(this.sourceBuffer); } catch { /* browser 已关闭 */ }
    try { this.mediaSource?.readyState === "open" && this.mediaSource.endOfStream(); } catch { /* ignore */ }
    if (this.objectUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    this.element.removeAttribute("src");
    this.element.load();
  }
}
