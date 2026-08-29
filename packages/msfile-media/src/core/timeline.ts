// VOD/Live 共用时间轴的轻量测试适配器。原生 Range 播放路径不使用它；
// 这里只提供不依赖固定 EOF 的有限/无限 segment 数据源。

import { MsFileMediaError, throwIfMediaAborted } from "./errors.js";
import type {
  MediaInitialization,
  MediaSegment,
  MediaTimelineSource,
} from "./types.js";

export interface MsFileFiniteTimelineInput {
  initialization: MediaInitialization;
  segments: readonly MediaSegment[];
}

export class MsFileFiniteTimelineSource implements MediaTimelineSource {
  readonly mode = "vod" as const;
  private closed = false;

  constructor(private readonly input: MsFileFiniteTimelineInput) {}

  async initialization(signal: AbortSignal): Promise<MediaInitialization> {
    throwIfMediaAborted(signal);
    if (this.closed) throw new MsFileMediaError("msfile_media_cancelled");
    return {
      ...this.input.initialization,
      data: this.input.initialization.data?.slice(),
    };
  }

  async *segments(signal: AbortSignal): AsyncIterable<MediaSegment> {
    for (const segment of this.input.segments) {
      throwIfMediaAborted(signal);
      if (this.closed) return;
      yield { ...segment, data: segment.data.slice() };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface MsFileLiveTestSourceOptions {
  initialization?: MediaInitialization;
  /** 每个 segment 的字节长度；测试数据不代表真实编码帧。 */
  segmentBytes?: number;
  /** 每个 segment 的时间长度，单位秒。 */
  segmentDurationSeconds?: number;
  /** 内存中最多保留的 segment 数。 */
  rollingWindowSegments?: number;
  /** 每 N 个 segment 插入一个 discontinuity；0 表示不插入。 */
  discontinuityEvery?: number;
  /** 仅测试用：产生指定数量后结束；缺失表示无限。 */
  maxSegments?: number;
  /** 仅测试用：模拟断流后等待多少毫秒再继续。 */
  disconnectEvery?: number;
  disconnectDurationMs?: number;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** 不依赖总文件大小的 Live-ready 假源，用于 rolling window/断流测试。 */
export class MsFileLiveTestSource implements MediaTimelineSource {
  readonly mode = "live" as const;
  private closed = false;
  private readonly options: {
    segmentBytes: number;
    segmentDurationSeconds: number;
    rollingWindowSegments: number;
    discontinuityEvery: number;
    disconnectEvery: number;
    disconnectDurationMs: number;
    maxSegments?: number;
    initialization: MediaInitialization;
  };
  private readonly rolling: MediaSegment[] = [];

  constructor(options: MsFileLiveTestSourceOptions = {}) {
    const segmentBytes = options.segmentBytes ?? 1024;
    const segmentDurationSeconds = options.segmentDurationSeconds ?? 1;
    const rollingWindowSegments = options.rollingWindowSegments ?? 15;
    if (!Number.isSafeInteger(segmentBytes) || segmentBytes <= 0 || segmentBytes > 4 * 1024 * 1024 ||
      !Number.isFinite(segmentDurationSeconds) || segmentDurationSeconds <= 0 || segmentDurationSeconds > 24 * 60 * 60 ||
      !Number.isSafeInteger(rollingWindowSegments) || rollingWindowSegments < 1 || rollingWindowSegments > 120 ||
      !isNonNegativeSafeInteger(options.discontinuityEvery ?? 0) ||
      !isNonNegativeSafeInteger(options.disconnectEvery ?? 0) ||
      !isNonNegativeSafeInteger(options.disconnectDurationMs ?? 0) || (options.disconnectDurationMs ?? 0) > 60_000 ||
      (options.maxSegments !== undefined && (!isNonNegativeSafeInteger(options.maxSegments) || options.maxSegments > 1_000_000))) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    this.options = {
      segmentBytes,
      segmentDurationSeconds,
      rollingWindowSegments,
      discontinuityEvery: options.discontinuityEvery ?? 0,
      disconnectEvery: options.disconnectEvery ?? 0,
      disconnectDurationMs: options.disconnectDurationMs ?? 0,
      maxSegments: options.maxSegments,
      initialization: options.initialization ?? { mimeType: "video/webm" },
    };
  }

  async initialization(signal: AbortSignal): Promise<MediaInitialization> {
    throwIfMediaAborted(signal);
    if (this.closed) throw new MsFileMediaError("msfile_media_cancelled");
    return { ...this.options.initialization, data: this.options.initialization.data?.slice() };
  }

  rollingWindow(): readonly MediaSegment[] {
    return this.rolling.map((segment) => ({ ...segment, data: segment.data.slice() }));
  }

  async *segments(signal: AbortSignal): AsyncIterable<MediaSegment> {
    let sequence = 0;
    while (!this.closed && (this.options.maxSegments === undefined || sequence < this.options.maxSegments)) {
      throwIfMediaAborted(signal);
      if (this.options.disconnectEvery > 0 && sequence > 0 && sequence % this.options.disconnectEvery === 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, this.options.disconnectDurationMs);
          const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(new MsFileMediaError("msfile_media_cancelled"));
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      const data = new Uint8Array(this.options.segmentBytes);
      data.fill(sequence & 0xff);
      const segment: MediaSegment = {
        sequence,
        timestampSeconds: sequence * this.options.segmentDurationSeconds,
        durationSeconds: this.options.segmentDurationSeconds,
        data,
        keyframe: sequence === 0 || sequence % 5 === 0,
        discontinuity: this.options.discontinuityEvery > 0 && sequence > 0 && sequence % this.options.discontinuityEvery === 0,
      };
      this.rolling.push(segment);
      while (this.rolling.length > this.options.rollingWindowSegments) this.rolling.shift();
      yield { ...segment, data: segment.data.slice() };
      sequence += 1;
      await Promise.resolve();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rolling.length = 0;
  }
}
