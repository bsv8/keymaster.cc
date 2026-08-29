// 浏览器媒体 session：惰性打开、统一快照、统一 dispose。
// React 只消费这里的状态，不接触 demux、SourceBuffer 或 Block 调度。

import {
  MsFileMediaError,
  normalizeMediaError,
  throwIfMediaAborted,
} from "../core/errors.js";
import { MsFileVodSource } from "../core/blockSource.js";
import type {
  MsFileMediaElementLike,
  MsFileMediaPhase,
  MsFileMediaSession,
  MsFileMediaSnapshot,
  MsFileVodSourceInput,
  MsFileVodSourceOptions,
} from "../core/types.js";
import { probeInDedicatedWorker } from "./mediaDemux.js";
import type { MsFileMediabunnyProbe } from "./mediabunnyAdapter.js";
import { MsFileMseBackend } from "./mseBackend.js";
import { MsFileWavBackend } from "./wavBackend.js";

interface MediaBackend {
  start(signal: AbortSignal): Promise<void>;
  play(signal: AbortSignal): Promise<void>;
  pause(): void;
  seek(seconds: number, signal: AbortSignal): Promise<void>;
  currentTime(): number;
  bufferedSeconds(): number;
  isEnded(): boolean;
  dispose(): Promise<void>;
}

function isMediaElement(value: unknown): value is MsFileMediaElementLike {
  return Boolean(value && typeof value === "object" && typeof (value as MsFileMediaElementLike).play === "function" &&
    typeof (value as MsFileMediaElementLike).pause === "function");
}

function mediaErrorFromSnapshot(error: MsFileMediaSnapshot["error"]): MsFileMediaError {
  const code = error?.code;
  const knownCodes: MsFileMediaError["code"][] = [
    "msfile_media_configuration",
    "msfile_media_network",
    "msfile_media_amount",
    "msfile_media_integrity",
    "msfile_media_unsupported_container",
    "msfile_media_unsupported_codec",
    "msfile_media_browser_capability",
    "msfile_media_decode_failed",
    "msfile_media_cancelled",
  ];
  return new MsFileMediaError(knownCodes.includes(code as MsFileMediaError["code"])
    ? code as MsFileMediaError["code"]
    : "msfile_media_decode_failed", error?.message);
}

export interface CreateMsFileMediaSessionOptions extends MsFileVodSourceOptions {
  /** 只影响错误状态，不把原始异常写入 UI。 */
  mode?: "vod";
}

export class MsFileMediaSessionImpl implements MsFileMediaSession {
  private readonly source: MsFileVodSource;
  private readonly listeners = new Set<() => void>();
  private readonly controller = new AbortController();
  private element: MsFileMediaElementLike | undefined;
  private elementListeners: Array<{ type: string; listener: EventListener }> = [];
  private probe: MsFileMediabunnyProbe | undefined;
  private backend: MediaBackend | undefined;
  private phase: MsFileMediaPhase = "idle";
  private error: MsFileMediaSnapshot["error"];
  private disposed = false;
  private opening: Promise<void> | undefined;
  private seeking = false;

  constructor(input: MsFileVodSourceInput, options: CreateMsFileMediaSessionOptions = {}) {
    this.source = new MsFileVodSource(input, options);
    this.source.subscribe(() => this.emit());
  }

  snapshot(): MsFileMediaSnapshot {
    const source = this.source.snapshot();
    const backend = this.backend;
    const currentTimeSeconds = backend?.currentTime() ?? 0;
    return {
      phase: this.phase,
      mode: "vod",
      container: this.probe?.container,
      codecs: this.probe?.codecs ?? [],
      durationSeconds: this.probe?.durationSeconds ?? (backend && "durationSeconds" in backend && typeof (backend as unknown as { durationSeconds?: () => number }).durationSeconds === "function"
        ? (backend as unknown as { durationSeconds: () => number }).durationSeconds()
        : undefined),
      currentTimeSeconds,
      bufferedSeconds: backend?.bufferedSeconds() ?? 0,
      blockWindowOccupancy: source.blockWindowOccupancy,
      blockWindowLimit: source.blockWindowLimit,
      verifiedBlockCount: source.verifiedBlockCount,
      readBlockCount: source.readCount,
      error: this.error,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private setPhase(phase: MsFileMediaPhase): void {
    this.phase = phase;
    this.emit();
  }

  async attach(element: MsFileMediaElementLike): Promise<void> {
    if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
    if (!isMediaElement(element)) throw new MsFileMediaError("msfile_media_configuration");
    if (this.backend && this.element !== element) {
      // 后端已经持有旧的 HTMLMediaElement 时禁止热切换，避免 UI 看着绑定
      // 到新元素、实际 SourceBuffer/AudioContext 仍向旧元素输出。
      throw new MsFileMediaError("msfile_media_configuration");
    }
    if (this.element && this.element !== element) this.detachElementListeners();
    this.element = element;
    const eventTypes = ["timeupdate", "progress", "durationchange", "ended", "error", "play", "pause", "seeking"];
    for (const type of eventTypes) {
      const listener: EventListener = () => {
        if (type === "ended" && this.phase === "playing") this.phase = "ended";
        if (type === "play" && (this.phase === "idle" || this.phase === "paused")) {
          // 原生 controls 也是合法的用户 gesture 入口；第一次点击时由
          // session 惰性打开，暂停后点击则恢复有界读取。
          void this.play().catch(() => undefined);
        }
        if (type === "pause" && (this.phase === "playing" || this.phase === "buffering")) {
          this.pause();
        }
        if (type === "seeking" && this.backend && !this.seeking &&
          (this.phase === "playing" || this.phase === "paused" || this.phase === "buffering")) {
          void this.seek(this.element?.currentTime ?? 0).catch(() => undefined);
        }
        this.emit();
      };
      element.addEventListener?.(type, listener);
      this.elementListeners.push({ type, listener });
    }
    this.emit();
  }

  private detachElementListeners(): void {
    if (!this.element) return;
    for (const { type, listener } of this.elementListeners) this.element.removeEventListener?.(type, listener);
    this.elementListeners = [];
  }

  private async open(signal: AbortSignal): Promise<void> {
    if (this.backend) return;
    if (!this.element) throw new MsFileMediaError("msfile_media_configuration");
    this.setPhase("reading-seed");
    await this.source.initialize(signal);
    if (this.source.blockCount() === 0) throw new MsFileMediaError("msfile_media_unsupported_container");
    // 这是首播的硬栅栏：没有完成 Block 0 的长度与 SHA-256 校验之前，
    // 不允许 Mediabunny、MSE 或 Web Audio 看见任何 attachment 字节。
    await this.source.readBlockAt(0, signal);
    throwIfMediaAborted(signal);
    this.setPhase("parsing-header");
    this.probe = await probeInDedicatedWorker(this.source, signal);
    if (this.probe.container === "wave") {
      this.backend = new MsFileWavBackend(this.element, this.source, (error) => this.backendFailure(error));
    } else if (this.probe.container === "mp4") {
      // 普通 MP4 的 moov/mdat 不是可直接 append 的 MSE 分段；在 Worker
      // 内转成 fMP4。已经带 moof 的 MP4 继续走零拷贝直通路径。
      this.backend = new MsFileMseBackend(
        this.element,
        this.source,
        this.probe.mimeType,
        this.probe.durationSeconds,
        (error) => this.backendFailure(error),
        { transmuxProgressiveMp4: !this.probe.directMse },
      );
    } else {
      if (!this.probe.directMse) throw new MsFileMediaError("msfile_media_unsupported_container");
      this.backend = new MsFileMseBackend(this.element, this.source, this.probe.mimeType, this.probe.durationSeconds, (error) => this.backendFailure(error));
    }
    await this.backend.start(signal);
    this.setPhase("buffering");
  }

  private backendFailure(error: MsFileMediaError): void {
    if (this.disposed || this.phase === "failed" || this.phase === "stopped" || this.phase === "disposed") return;
    this.error = { code: error.code, message: error.message };
    this.phase = "failed";
    this.source.abort();
    // 后端异步 pump 失败时，不能只中止 BlockSource；MSE、Worker、定时器
    // 仍可能持有资源。失败态同样执行一次幂等 dispose，阻断迟到回调。
    void this.backend?.dispose().catch(() => undefined);
    this.emit();
  }

  async play(): Promise<void> {
    if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
    if (this.phase === "playing") return;
    if (this.phase === "ended") return;
    if (this.phase === "stopped") throw new MsFileMediaError("msfile_media_cancelled");
    if (this.phase === "failed" && this.error) throw mediaErrorFromSnapshot(this.error);
    const signal = this.controller.signal;
    try {
      if (!this.opening) {
        this.opening = this.open(signal).finally(() => { this.opening = undefined; });
      }
      await this.opening;
      throwIfMediaAborted(signal);
      if (this.phase === "paused") this.setPhase("buffering");
      await this.backend!.play(signal);
      // 原生 controls 的 play/pause 事件可能在 Promise 完成前交错；
      // 不要把已被用户暂停的请求错误地提交为 playing。
      if (this.phase === "paused") return;
      this.error = undefined;
      this.setPhase("playing");
    } catch (error) {
      const normalized = normalizeMediaError(error, signal);
      if (normalized.code === "msfile_media_cancelled" && this.disposed) {
        this.setPhase("disposed");
      } else if (normalized.code === "msfile_media_cancelled" && (this.phase as MsFileMediaPhase) === "stopped") {
        // stop() 是终态；不要让并发中止的旧 play() 把状态倒退成 cancelled。
      } else if (normalized.code === "msfile_media_cancelled") {
        this.setPhase("cancelled");
      } else {
        this.error = { code: normalized.code, message: normalized.message };
        this.setPhase("failed");
        try { await this.backend?.dispose(); } catch { /* failure cleanup */ }
        this.backend = undefined;
        this.source.abort();
      }
      throw normalized;
    }
  }

  pause(): void {
    if (this.disposed || !this.backend) return;
    if (this.phase === "playing" || this.phase === "buffering") this.setPhase("paused");
    this.backend.pause();
  }

  async seek(seconds: number): Promise<void> {
    if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
    if (!this.backend) throw new MsFileMediaError("msfile_media_configuration");
    this.seeking = true;
    try {
      await this.backend.seek(seconds, this.controller.signal);
      this.emit();
    } catch (error) {
      const normalized = normalizeMediaError(error, this.controller.signal);
      this.error = { code: normalized.code, message: normalized.message };
      this.setPhase(normalized.code === "msfile_media_cancelled" ? "cancelled" : "failed");
      throw normalized;
    } finally {
      this.seeking = false;
    }
  }

  setPrefetchBlocks(value: number): void {
    if (this.disposed) return;
    this.source.setPrefetchBlocks(value);
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    this.controller.abort();
    try { await this.backend?.dispose(); } catch { /* stop is idempotent */ }
    this.backend = undefined;
    this.source.abort();
    this.setPhase("stopped");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.detachElementListeners();
    try { await this.backend?.dispose(); } catch { /* deterministic cleanup continues */ }
    this.backend = undefined;
    await this.source.dispose();
    this.setPhase("disposed");
    this.listeners.clear();
  }
}

export function createMsFileMediaSession(
  input: MsFileVodSourceInput,
  options: CreateMsFileMediaSessionOptions = {},
): MsFileMediaSessionImpl {
  return new MsFileMediaSessionImpl(input, options);
}
