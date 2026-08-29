// 浏览器原生媒体 session。
//
// 生产播放路径只有一个普通的 HTMLMediaElement.src：浏览器自己决定 Range、
// 缓冲、seek、解码和历史淘汰。Keymaster 不创建应用自管媒体缓冲对象，
// 不监听 seeking 后再次写 currentTime，也不维护时间到 Block 的索引。

import {
  ensureMsFileMediaServiceWorker,
  getMsFileMediaServiceWorkerInfo,
  getMsFileRangeHost,
  hasMsFileMediaServiceWorkerController,
  type MsFileRangeHost,
  type MsFileRangeSessionHandle,
} from "../range/rangeHost.js";
import { MsFileMediaError, normalizeMediaError } from "../core/errors.js";
import type {
  MsFileMediaDebugEntry,
  MsFileMediaDebugValue,
  MsFileMediaElementLike,
  MsFileMediaPhase,
  MsFileMediaSession,
  MsFileMediaSnapshot,
  MsFileVodSourceInput,
} from "../core/types.js";

interface NativeMediaElement extends MsFileMediaElementLike {
  src?: string;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  load?(): void;
  buffered?: TimeRanges;
  seeking?: boolean;
  readyState?: number;
  networkState?: number;
  error?: { code?: number } | null;
}

export interface CreateMsFileNativeMediaSessionOptions {
  /** 是否记录脱敏诊断；默认开启，最近 300 条非高频事件会保留。 */
  debug?: boolean;
  /** 测试或宿主注入的 Service Worker ready 检查。 */
  ensureServiceWorker?: () => Promise<void>;
  /** 测试或宿主注入的页面 Range Host；默认使用当前页面共享 Host。 */
  rangeHost?: MsFileRangeHost;
  /** 测试或宿主注入的 session 绑定握手；生产环境必须绑定真实 Client.id。 */
  bindSession?: () => Promise<void>;
}

const MAX_DEBUG_RECENT_ENTRIES = 300;
const NATIVE_READ_CONCURRENCY = 2;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function buildVersion(): string {
  if (typeof document === "undefined") return "unknown";
  const value = document.querySelector('meta[name="keymaster:version"]')?.getAttribute("content")?.trim();
  return value && value.length <= 64 ? value : "unknown";
}

function isPermanentDebugAction(scope: string, action: string): boolean {
  // 创建上下文和失败原因不能被后续媒体事件覆盖；高频 progress/timeupdate
  // 则完全不进入日志，避免关键诊断被无意义事件挤掉。
  return scope === "session" && (action === "created" || action === "failed");
}

function safeNumber(value: number): number | null {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function isMediaElement(value: unknown): value is MsFileMediaElementLike {
  return Boolean(value && typeof value === "object" && typeof (value as MsFileMediaElementLike).play === "function" &&
    typeof (value as MsFileMediaElementLike).pause === "function");
}

function nativeErrorCode(element: NativeMediaElement): MsFileMediaError["code"] {
  switch (element.error?.code) {
    case 1: return "msfile_media_cancelled";
    case 2: return "msfile_media_network";
    case 3: return "msfile_media_decode_failed";
    case 4: return "msfile_media_native_unsupported";
    default: return "msfile_media_decode_failed";
  }
}

function bufferedAhead(element: NativeMediaElement): number {
  const ranges = element.buffered;
  const current = Number.isFinite(element.currentTime) ? Math.max(0, element.currentTime) : 0;
  if (!ranges) return 0;
  try {
    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);
      const end = ranges.end(index);
      if (current >= start && current <= end) return Math.max(0, end - current);
    }
  } catch {
    return 0;
  }
  return 0;
}

function elementDetails(element: NativeMediaElement | undefined): Record<string, MsFileMediaDebugValue> {
  if (!element) return { attached: false };
  return {
    attached: true,
    currentTime: safeNumber(element.currentTime),
    duration: safeNumber(element.duration),
    paused: element.paused,
    ended: element.ended,
    seeking: element.seeking ?? false,
    readyState: element.readyState ?? null,
    networkState: element.networkState ?? null,
    mediaErrorCode: element.error?.code ?? null,
    bufferedSeconds: safeNumber(bufferedAhead(element)),
  };
}

export class MsFileNativeMediaSession implements MsFileMediaSession {
  private readonly listeners = new Set<() => void>();
  private readonly debugEnabled: boolean;
  private readonly debugStartedAt = now();
  private readonly debugEntries: MsFileMediaDebugEntry[] = [];
  private readonly permanentDebugEntries: MsFileMediaDebugEntry[] = [];
  private readonly rangeSession: MsFileRangeSessionHandle;
  private readonly workerReadyOverride?: () => Promise<void>;
  private readonly bindSessionOverride?: () => Promise<void>;
  private element: NativeMediaElement | undefined;
  private elementListeners: Array<{ type: string; listener: EventListener }> = [];
  private workerReady: Promise<void> | undefined;
  private sourceInstalled = false;
  private phase: MsFileMediaPhase = "idle";
  private error: MsFileMediaSnapshot["error"];
  private debugSequence = 0;
  private disposed = false;

  constructor(input: MsFileVodSourceInput, options: CreateMsFileNativeMediaSessionOptions = {}) {
    this.debugEnabled = options.debug !== false;
    this.workerReadyOverride = options.ensureServiceWorker;
    this.bindSessionOverride = options.bindSession;
    const host = options.rangeHost ?? getMsFileRangeHost();
    this.rangeSession = host.createSession(input, {
      onDebug: (scope, action, details) => this.recordDebug(scope, action, details),
    });
    this.rangeSession.source.subscribe(() => {
      const source = this.rangeSession.source.snapshot();
      if (source.error && this.phase !== "failed" && this.phase !== "stopped" && this.phase !== "disposed") {
        this.error = source.error;
        this.setPhase(source.error.code === "msfile_media_cancelled" ? "cancelled" : "failed");
      }
      this.emit();
    });
    this.recordDebug("session", "created", {
      backend: "native-range",
      buildVersion: buildVersion(),
      serviceWorkerProtocolVersion: getMsFileMediaServiceWorkerInfo().protocolVersion,
      serviceWorkerScriptUrl: getMsFileMediaServiceWorkerInfo().scriptUrl,
      debugEnabled: this.debugEnabled,
      fileSizeBytes: input.fileSizeBytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(input.fileSizeBytes) : null,
      declaredMediaType: input.declaredMediaType || "empty",
      maxConcurrentReads: NATIVE_READ_CONCURRENCY,
    });
  }

  snapshot(): MsFileMediaSnapshot {
    const source = this.rangeSession.source.snapshot();
    const element = this.element;
    const currentTimeSeconds = element && Number.isFinite(element.currentTime) ? Math.max(0, element.currentTime) : 0;
    const duration = element && Number.isFinite(element.duration) && element.duration >= 0 ? element.duration : undefined;
    return {
      phase: this.phase,
      mode: "vod",
      container: source.container,
      codecs: [],
      durationSeconds: duration,
      currentTimeSeconds,
      bufferedSeconds: element ? bufferedAhead(element) : 0,
      blockWindowOccupancy: source.inFlightBlockCount,
      blockWindowLimit: NATIVE_READ_CONCURRENCY,
      activeRequestCount: source.activeRequestCount,
      inFlightBlockCount: source.inFlightBlockCount,
      verifiedBlockCount: source.verifiedBlockCount,
      readBlockCount: source.supplierReadCount,
      error: this.error,
      debug: {
        enabled: this.debugEnabled,
        entries: [...this.permanentDebugEntries, ...this.debugEntries].sort((a, b) => a.sequence - b.sequence),
      },
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private recordDebug(scope: string, action: string, details: Record<string, MsFileMediaDebugValue> = {}): void {
    if (!this.debugEnabled) return;
    const entry: MsFileMediaDebugEntry = {
      sequence: ++this.debugSequence,
      elapsedMs: Math.max(0, Math.round(now() - this.debugStartedAt)),
      scope,
      action,
      details: { ...details },
    };
    if (isPermanentDebugAction(scope, action)) this.permanentDebugEntries.push(entry);
    else this.debugEntries.push(entry);
    if (this.debugEntries.length > MAX_DEBUG_RECENT_ENTRIES) {
      this.debugEntries.splice(0, this.debugEntries.length - MAX_DEBUG_RECENT_ENTRIES);
    }
    this.emit();
  }

  private setPhase(phase: MsFileMediaPhase): void {
    if (this.phase === phase) return;
    this.recordDebug("session", "phase", { from: this.phase, to: phase });
    this.phase = phase;
    this.emit();
  }

  private ensureUsable(): void {
    if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
    if (this.phase === "stopped") throw new MsFileMediaError("msfile_media_cancelled");
    if (this.phase === "failed" && this.error) throw new MsFileMediaError(this.error.code as MsFileMediaError["code"]);
  }

  private ensureServiceWorker(): Promise<void> {
    if (!this.workerReady) {
      this.recordDebug("sw", "register.begin");
      const operation = this.workerReadyOverride ?? ensureMsFileMediaServiceWorker;
      this.workerReady = operation().then(() => {
        this.recordDebug("sw", "register.ready", { controlled: hasMsFileMediaServiceWorkerController() });
      }).catch((error) => {
        this.workerReady = undefined;
        this.recordDebug("sw", "register.failed", {
          stage: "service-worker-register",
          code: normalizeMediaError(error).code,
        });
        throw new MsFileMediaError("msfile_media_service_worker");
      });
    }
    return this.workerReady;
  }

  private installSource(): void {
    if (this.sourceInstalled || !this.element) return;
    const element = this.element;
    try {
      element.setAttribute?.("src", this.rangeSession.url);
      if (!element.setAttribute && "src" in element) element.src = this.rangeSession.url;
      element.load?.();
      this.sourceInstalled = true;
    } catch {
      throw new MsFileMediaError("msfile_media_service_worker");
    }
  }

  private bindRangeSession(): Promise<void> {
    return this.bindSessionOverride?.() ?? this.rangeSession.bind();
  }

  private attachNativeListeners(element: NativeMediaElement): void {
    const eventTypes = [
      "loadedmetadata", "loadeddata", "canplay", "playing", "waiting", "stalled",
      "play", "pause", "ended", "error", "abort", "seeking", "seeked", "timeupdate",
      "progress", "durationchange",
    ];
    for (const type of eventTypes) {
      const listener: EventListener = () => {
        if (type !== "timeupdate" && type !== "progress") {
          this.recordDebug("media.native", "event", { event: type, ...elementDetails(element) });
        }
        switch (type) {
          case "loadedmetadata":
          case "loadeddata":
          case "canplay":
            if (this.phase === "reading-seed" || this.phase === "parsing-header") this.setPhase("buffering");
            break;
          case "playing":
            if (this.phase !== "failed" && this.phase !== "stopped" && this.phase !== "disposed") this.setPhase("playing");
            break;
          case "play":
            if (this.phase !== "failed" && this.phase !== "stopped" && this.phase !== "disposed" && this.phase !== "playing") {
              this.setPhase("buffering");
            }
            break;
          case "waiting":
          case "stalled":
            if (!element.paused && this.phase !== "failed" && this.phase !== "stopped" && this.phase !== "disposed") this.setPhase("buffering");
            break;
          case "pause":
            if (this.phase !== "ended" && this.phase !== "failed" && this.phase !== "stopped" && this.phase !== "disposed") this.setPhase("paused");
            break;
          case "ended":
            this.setPhase("ended");
            break;
          case "error":
            this.failFromNativeElement(element);
            break;
          case "abort":
            if (this.phase === "reading-seed" || this.phase === "buffering") this.setPhase("cancelled");
            break;
          // `seeking`/`seeked` 只记录原生事件。绝不在这里再次设置 currentTime。
          default:
            break;
        }
        this.emit();
      };
      element.addEventListener?.(type, listener);
      this.elementListeners.push({ type, listener });
    }
  }

  private detachNativeListeners(): void {
    if (!this.element) return;
    for (const { type, listener } of this.elementListeners) this.element.removeEventListener?.(type, listener);
    this.elementListeners = [];
  }

  private failFromNativeElement(element: NativeMediaElement): void {
    if (this.disposed || this.phase === "stopped" || this.phase === "disposed") return;
    const sourceError = this.rangeSession.source.snapshot().error;
    const error = sourceError ? new MsFileMediaError(sourceError.code as MsFileMediaError["code"]) : new MsFileMediaError(nativeErrorCode(element));
    this.error = { code: error.code, message: error.message };
    this.recordDebug("session", "failed", {
      stage: "native-event",
      code: error.code,
      nativeErrorCode: element.error?.code ?? null,
    });
    this.setPhase("failed");
    // 原生解码失败也撤销虚拟 URL，后续再次请求必须重新创建 session，不能
    // 让已经失败的媒体映射继续可见。
    void this.rangeSession.dispose().catch(() => undefined);
  }

  async attach(element: MsFileMediaElementLike): Promise<void> {
    if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
    if (!isMediaElement(element)) throw new MsFileMediaError("msfile_media_configuration");
    const nativeElement = element as NativeMediaElement;
    if (this.element && this.element !== nativeElement) throw new MsFileMediaError("msfile_media_configuration");
    if (this.element === nativeElement) return;
    this.element = nativeElement;
    this.attachNativeListeners(nativeElement);
    this.emit();
    // preload="none" 下设置 src 不应主动购买内容；它只让原生 controls 在用户
    // 点击时拥有正确 URL。真正的 Seed/Block 请求仍从浏览器 pull 开始。
    try {
      await this.ensureServiceWorker();
      if (this.disposed || this.element !== nativeElement) return;
      await this.bindRangeSession();
      if (this.disposed || this.element !== nativeElement) return;
      this.installSource();
      this.emit();
    } catch (error) {
      if (this.disposed || this.element !== nativeElement) return;
      const normalized = normalizeMediaError(error);
      this.error = { code: normalized.code, message: normalized.message };
      this.recordDebug("session", "failed", { stage: "attach", code: normalized.code });
      this.setPhase("failed");
      throw normalized;
    }
  }

  async play(): Promise<void> {
    this.ensureUsable();
    if (!this.element) throw new MsFileMediaError("msfile_media_configuration");
    if (this.phase === "ended") {
      // 遵循 HTMLMediaElement 原生 play 语义；不维护应用自己的时间轴。
    }
    this.error = undefined;
    this.setPhase("reading-seed");
    if (!this.sourceInstalled) {
      await this.ensureServiceWorker();
      if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
      await this.bindRangeSession();
      if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
      this.installSource();
    }
    try {
      // source 已在 attach 阶段安装时，这个调用仍处于调用方用户 gesture 的
      // 同步路径；网络和 Range 读取由浏览器在其后异步完成。
      await this.element.play();
      if (this.phase !== "paused" && this.phase !== "failed" && this.phase !== "stopped" && this.phase !== "playing") {
        this.setPhase("buffering");
      }
    } catch (error) {
      const normalized = error instanceof DOMException && error.name === "NotAllowedError"
        ? new MsFileMediaError("msfile_media_browser_capability")
        : error instanceof DOMException && error.name === "NotSupportedError"
          ? new MsFileMediaError("msfile_media_native_unsupported")
          : normalizeMediaError(error);
      this.error = { code: normalized.code, message: normalized.message };
      this.recordDebug("session", "failed", { stage: "play", code: normalized.code });
      this.setPhase(normalized.code === "msfile_media_cancelled" ? "cancelled" : "failed");
      throw normalized;
    }
  }

  pause(): void {
    if (this.disposed || !this.element) return;
    this.element.pause();
    if (this.phase === "playing" || this.phase === "buffering" || this.phase === "reading-seed" || this.phase === "parsing-header") {
      this.setPhase("paused");
    }
  }

  async seek(seconds: number): Promise<void> {
    this.ensureUsable();
    if (!this.element || !Number.isFinite(seconds) || seconds < 0) throw new MsFileMediaError("msfile_media_configuration");
    // 这是兼容旧 public API 的显式命令；原生 controls 不调用该方法。不要
    // 维护 seek revision，也不要在 seeking 事件中重复写入。
    this.element.currentTime = seconds;
  }

  async stop(): Promise<void> {
    if (this.disposed || this.phase === "stopped") return;
    if (this.element) {
      this.element.pause();
      this.element.removeAttribute?.("src");
      try { this.element.load?.(); } catch { /* element may already be detached */ }
    }
    this.sourceInstalled = false;
    await this.rangeSession.dispose();
    this.setPhase("stopped");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.element) {
      this.element.pause();
      this.element.removeAttribute?.("src");
      try { this.element.load?.(); } catch { /* element may already be detached */ }
    }
    this.detachNativeListeners();
    this.sourceInstalled = false;
    await this.rangeSession.dispose();
    this.setPhase("disposed");
    this.listeners.clear();
  }
}

export function createMsFileNativeMediaSession(
  input: MsFileVodSourceInput,
  options: CreateMsFileNativeMediaSessionOptions = {},
): MsFileNativeMediaSession {
  return new MsFileNativeMediaSession(input, options);
}

/** 原生 Range 播放器是媒体包当前唯一的生产 session 工厂。 */
export const createMsFileMediaSession = createMsFileNativeMediaSession;
