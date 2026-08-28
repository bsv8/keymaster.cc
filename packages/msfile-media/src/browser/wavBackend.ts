// WAV PCM 流式后端。
// 不使用 decodeAudioData：只读取 RIFF chunk 与有界 PCM 数据，使用
// AudioBufferSourceNode 维持最多 15 秒的排队，并在暂停时停止继续购买。

import { MsFileMediaError, normalizeMediaError, throwIfMediaAborted } from "../core/errors.js";
import type { MsFileMediaElementLike } from "../core/types.js";
import type { MsFileVodSource } from "../core/blockSource.js";
import { MEDIA_HARD_FORWARD_SECONDS, MEDIA_TARGET_WATER_SECONDS } from "./mseBackend.js";

interface WavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  byteRate: number;
  dataStart: number;
  dataEnd: number;
  float: boolean;
}

const MAX_WAV_HEADER_BYTES = 8 * 256 * 1024;
const MAX_WAV_CHUNKS = 128;
const MAX_WAV_DURATION_SECONDS = 30 * 24 * 60 * 60;

function waitForTimerOrAbort(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new MsFileMediaError("msfile_media_cancelled"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

async function parseWav(source: MsFileVodSource, signal: AbortSignal): Promise<WavInfo> {
  const fileSize = source.fileSizeNumber;
  if (fileSize < 12) throw new MsFileMediaError("msfile_media_unsupported_container");
  let header = await source.readRange(0, Math.min(fileSize, 12), signal);
  if (ascii(header, 0, 4) !== "RIFF" || ascii(header, 8, 4) !== "WAVE") {
    throw new MsFileMediaError("msfile_media_unsupported_container");
  }
  const riffEnd = readU32(header, 4) + 8;
  if (riffEnd < 12 || riffEnd > fileSize) throw new MsFileMediaError("msfile_media_integrity");
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number } | undefined;
  let dataStart: number | undefined;
  let dataEnd: number | undefined;
  for (let chunkIndex = 0; chunkIndex < MAX_WAV_CHUNKS && offset + 8 <= riffEnd && offset < MAX_WAV_HEADER_BYTES; chunkIndex += 1) {
    header = await source.readRange(offset, offset + 8, signal);
    const chunkId = ascii(header, 0, 4);
    const chunkSize = readU32(header, 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + chunkSize;
    if (!Number.isSafeInteger(bodyEnd) || bodyEnd > riffEnd || bodyEnd < bodyStart) {
      throw new MsFileMediaError("msfile_media_integrity");
    }
    if (chunkId === "fmt ") {
      if (chunkSize < 16 || chunkSize > 4096) throw new MsFileMediaError("msfile_media_unsupported_codec");
      if (bodyEnd > MAX_WAV_HEADER_BYTES) throw new MsFileMediaError("msfile_media_unsupported_container");
      const fmtBytes = await source.readRange(bodyStart, bodyStart + chunkSize, signal);
      const view = new DataView(fmtBytes.buffer, fmtBytes.byteOffset, fmtBytes.byteLength);
      fmt = {
        format: view.getUint16(0, true),
        channels: view.getUint16(2, true),
        sampleRate: view.getUint32(4, true),
        byteRate: view.getUint32(8, true),
        blockAlign: view.getUint16(12, true),
        bits: view.getUint16(14, true),
      };
    } else if (chunkId === "data") {
      dataStart = bodyStart;
      dataEnd = bodyEnd;
    }
    // RIFF chunk body按偶数字节对齐；跳过 padding 但不把它当作音频数据。
    offset = bodyEnd + (chunkSize & 1);
    if (fmt && dataStart !== undefined && dataEnd !== undefined) break;
  }
  if (!fmt || dataStart === undefined || dataEnd === undefined) throw new MsFileMediaError("msfile_media_unsupported_container");
  const float = fmt.format === 3;
  if ((fmt.format !== 1 && !float) || (fmt.channels !== 1 && fmt.channels !== 2) ||
    ![8, 16, 24, 32].includes(fmt.bits) || (float && fmt.bits !== 32) || !Number.isSafeInteger(fmt.sampleRate) || fmt.sampleRate < 8000 || fmt.sampleRate > 192000 ||
    fmt.blockAlign !== fmt.channels * (fmt.bits / 8) || fmt.byteRate !== fmt.sampleRate * fmt.blockAlign) {
    throw new MsFileMediaError("msfile_media_unsupported_codec");
  }
  const dataLength = dataEnd - dataStart;
  if (dataLength <= 0 || dataLength % fmt.blockAlign !== 0) throw new MsFileMediaError("msfile_media_integrity");
  if (!Number.isFinite(dataLength / fmt.byteRate) || dataLength / fmt.byteRate > MAX_WAV_DURATION_SECONDS) {
    throw new MsFileMediaError("msfile_media_unsupported_container");
  }
  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bits,
    blockAlign: fmt.blockAlign,
    byteRate: fmt.byteRate,
    dataStart,
    dataEnd,
    float,
  };
}

function sampleFrom(view: DataView, offset: number, bits: number, float: boolean): number {
  const clamp = (value: number): number => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  if (float && bits === 32) return clamp(view.getFloat32(offset, true));
  switch (bits) {
    case 8: return (view.getUint8(offset) - 128) / 128;
    case 16: return clamp(view.getInt16(offset, true) / 32768);
    case 24: {
      const b0 = view.getUint8(offset);
      const b1 = view.getUint8(offset + 1);
      const b2 = view.getInt8(offset + 2);
      return clamp((b0 | (b1 << 8) | (b2 << 16)) / 8388608);
    }
    case 32: return clamp(view.getInt32(offset, true) / 2147483648);
    default: return 0;
  }
}

export class MsFileWavBackend {
  private readonly element: HTMLMediaElement;
  private readonly source: MsFileVodSource;
  private info: WavInfo | undefined;
  private context: AudioContext | undefined;
  private destination: MediaStreamAudioDestinationNode | undefined;
  private readonly nodes = new Set<AudioBufferSourceNode>();
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private internalAbort = new AbortController();
  private playbackAbort = new AbortController();
  private pumpPromise: Promise<void> | undefined;
  private disposed = false;
  private active = false;
  private ended = false;
  private positionSeconds = 0;
  private timelineStart = 0;
  private scheduledUntil = 0;
  private dataPosition = 0;
  private readonly onFailure: (error: MsFileMediaError) => void;

  constructor(element: MsFileMediaElementLike, source: MsFileVodSource, onFailure: (error: MsFileMediaError) => void = () => undefined) {
    this.element = element as unknown as HTMLMediaElement;
    this.source = source;
    this.onFailure = onFailure;
  }

  async start(signal: AbortSignal): Promise<void> {
    this.info = await parseWav(this.source, signal);
    const AudioContextConstructor = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!AudioContextConstructor || typeof MediaStreamAudioDestinationNode === "undefined") {
      throw new MsFileMediaError("msfile_media_browser_capability");
    }
    this.context = new AudioContextConstructor();
    this.destination = this.context.createMediaStreamDestination();
    this.element.srcObject = this.destination.stream;
    this.dataPosition = this.info.dataStart;
    this.element.load();
  }

  private duration(): number {
    if (!this.info) return 0;
    return (this.info.dataEnd - this.info.dataStart) / this.info.byteRate;
  }

  private currentPosition(): number {
    if (!this.active || !this.context) return this.positionSeconds;
    return Math.min(this.duration(), this.positionSeconds + Math.max(0, this.context.currentTime - this.timelineStart));
  }

  private async *audioBuffers(signal: AbortSignal): AsyncGenerator<AudioBuffer> {
    const info = this.info!;
    const stream = this.source.readStream(this.dataPosition, info.dataEnd, signal);
    const reader = stream.getReader();
    this.reader = reader;
    let carry = new Uint8Array();
    try {
      for (;;) {
        throwIfMediaAborted(signal);
        const next = await reader.read();
        if (next.done) break;
        const incoming = next.value;
        const combined = new Uint8Array(carry.length + incoming.length);
        combined.set(carry);
        combined.set(incoming, carry.length);
        const usable = combined.length - (combined.length % info.blockAlign);
        if (usable === 0) {
          carry = combined;
          continue;
        }
        // 一个 256 KiB Block 在低采样率 WAV 中可能超过 30 秒；拆成最多
        // 15 秒的 AudioBuffer，避免单个 attachment Block 穿透时间水位。
        const maxFrames = Math.max(1, Math.floor(info.sampleRate * MEDIA_TARGET_WATER_SECONDS));
        let consumed = 0;
        while (usable - consumed >= info.blockAlign) {
          const frames = Math.min(maxFrames, Math.floor((usable - consumed) / info.blockAlign));
          const context = this.context!;
          const buffer = context.createBuffer(info.channels, frames, info.sampleRate);
          const view = new DataView(combined.buffer, combined.byteOffset + consumed, frames * info.blockAlign);
          const channelData = Array.from({ length: info.channels }, (_, channel) => buffer.getChannelData(channel));
          for (let frame = 0; frame < frames; frame += 1) {
            for (let channel = 0; channel < info.channels; channel += 1) {
              channelData[channel]![frame] = sampleFrom(view, frame * info.blockAlign + channel * (info.bitsPerSample / 8), info.bitsPerSample, info.float);
            }
          }
          consumed += frames * info.blockAlign;
          yield buffer;
        }
        carry = combined.slice(consumed);
      }
    } finally {
      try { await reader.cancel(); } catch { /* dispose/cancel race */ }
      if (this.reader === reader) this.reader = undefined;
    }
  }

  private async pump(signal: AbortSignal): Promise<void> {
    const context = this.context;
    const destination = this.destination;
    if (!context || !destination) throw new MsFileMediaError("msfile_media_browser_capability");
    const buffers = this.audioBuffers(signal);
    try {
      for (;;) {
        throwIfMediaAborted(signal);
        if (!this.active) {
          await waitForTimerOrAbort(signal, 250);
          continue;
        }
        const current = this.currentPosition();
        if (this.scheduledUntil - current >= MEDIA_TARGET_WATER_SECONDS || this.scheduledUntil - current >= MEDIA_HARD_FORWARD_SECONDS) {
          await waitForTimerOrAbort(signal, 250);
          continue;
        }
        const next = await buffers.next();
        if (next.done) {
          this.ended = true;
          return;
        }
        const buffer = next.value;
        const startAt = Math.max(context.currentTime + 0.05, this.scheduledUntil || context.currentTime + 0.05);
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.connect(destination);
        node.onended = () => this.nodes.delete(node);
        node.start(startAt);
        this.nodes.add(node);
        if (this.scheduledUntil <= context.currentTime) this.timelineStart = startAt - this.positionSeconds;
        this.scheduledUntil = startAt + buffer.duration;
      }
    } finally {
      try { await buffers.return?.(undefined); } catch { /* generator already closed */ }
    }
  }

  async play(signal: AbortSignal): Promise<void> {
    throwIfMediaAborted(signal);
    if (!this.context) throw new MsFileMediaError("msfile_media_browser_capability");
    await this.context.resume();
    this.active = true;
    this.timelineStart = this.context.currentTime - this.positionSeconds;
    try { await this.element.play(); } catch { /* stream may already be active; AudioContext is authoritative */ }
    if (!this.pumpPromise || this.ended) {
      this.ended = false;
      const playbackController = new AbortController();
      this.playbackAbort = playbackController;
      this.pumpPromise = this.pump(playbackController.signal).catch((error) => {
        if (this.disposed || this.internalAbort.signal.aborted || playbackController.signal.aborted) return;
        this.onFailure(error instanceof MsFileMediaError ? error : normalizeMediaError(error));
      });
    }
  }

  pause(): void {
    if (!this.context) return;
    this.positionSeconds = this.currentPosition();
    this.active = false;
    this.playbackAbort.abort();
    // WAV 的 pump 在取消后会结束，而不是像 MSE 那样在 paused 状态等待；
    // 恢复播放必须创建新的 pump 和新的 stream reader。
    this.pumpPromise = undefined;
    this.element.pause();
    for (const node of this.nodes) {
      try { node.stop(); } catch { /* already ended */ }
    }
    this.nodes.clear();
    this.scheduledUntil = this.context.currentTime;
    void this.context.suspend().catch(() => undefined);
  }

  async seek(seconds: number, signal: AbortSignal): Promise<void> {
    if (!this.info || !Number.isFinite(seconds) || seconds < 0 || seconds > this.duration()) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    throwIfMediaAborted(signal);
    const wasActive = this.active;
    this.pause();
    this.positionSeconds = seconds;
    const aligned = Math.floor((seconds * this.info.byteRate) / this.info.blockAlign) * this.info.blockAlign;
    this.dataPosition = Math.min(this.info.dataEnd, this.info.dataStart + aligned);
    this.pumpPromise = undefined;
    if (wasActive) await this.play(signal);
  }

  currentTime(): number { return this.currentPosition(); }
  bufferedSeconds(): number { return Math.max(0, this.scheduledUntil - this.currentPosition()); }
  durationSeconds(): number { return this.duration(); }
  isEnded(): boolean { return this.ended; }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.internalAbort.abort();
    this.playbackAbort.abort();
    this.element.pause();
    for (const node of this.nodes) {
      try { node.stop(); } catch { /* already ended */ }
    }
    this.nodes.clear();
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { await this.context?.close(); } catch { /* ignore */ }
    this.reader = undefined;
    this.element.srcObject = null;
    this.element.removeAttribute("src");
  }
}
