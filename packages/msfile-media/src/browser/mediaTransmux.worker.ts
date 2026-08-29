// DedicatedWorker 中的 progressive MP4 -> fragmented MP4 转封装器。
//
// 普通 MP4 不能把任意 256 KiB 切片直接 append 到 MSE；这里使用
// Mediabunny 的已编码 packet 直拷贝和 fragmented MP4 muxer，只把顺序输出的
// ftyp/moov/moof/mdat 片段交给 Window。所有输入 range 仍由 Window 转回
// MsFileVodSource，因此 Worker 不拥有网络、金额或未校验字节。

import { MsFileMediaError } from "../core/errors.js";

interface StartRequest {
  type: "start";
  requestId: string;
  fileSizeBytes: number;
  maxSourceCacheBytes: number;
}

interface PumpRequest {
  type: "pump";
  requestId: string;
  untilSeconds: number;
}

interface CancelRequest {
  type: "cancel";
  requestId: string;
}

interface RangeResponse {
  type: "range-result";
  requestId: string;
  bytes?: ArrayBuffer;
  code?: string;
}

interface ChunkAck {
  type: "chunk-ack";
  requestId: string;
  chunkId: string;
  code?: string;
}

type WorkerRequest = StartRequest | PumpRequest | CancelRequest | RangeResponse | ChunkAck;

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

interface InputLike {
  dispose(): void;
}

interface ConversionLike {
  readonly isValid: boolean;
  readonly discardedTracks: readonly { reason: string }[];
  readonly state: string;
  execute(options: { until: number }): Promise<void>;
  cancel(): Promise<void>;
}

const scope = globalThis as unknown as WorkerScope;
const BLOCK_BYTES = 256 * 1024;
const MAX_RANGE_BYTES = 8 * BLOCK_BYTES;
const MAX_RANGE_WAITERS = 8;

let activeRequestId = "";
let nextRangeId = 0;
let nextChunkId = 0;
let input: InputLike | undefined;
let conversion: ConversionLike | undefined;
let cancelling = false;

const rangeWaiters = new Map<string, {
  start: number;
  end: number;
  resolve(bytes: Uint8Array): void;
  reject(error: MsFileMediaError): void;
}>();

const chunkWaiters = new Map<string, {
  resolve(): void;
  reject(error: MsFileMediaError): void;
}>();

function isStableErrorCode(value: unknown): value is MsFileMediaError["code"] {
  return value === "msfile_media_configuration" || value === "msfile_media_network" ||
    value === "msfile_media_amount" || value === "msfile_media_integrity" ||
    value === "msfile_media_unsupported_container" || value === "msfile_media_unsupported_codec" ||
    value === "msfile_media_browser_capability" || value === "msfile_media_decode_failed" ||
    value === "msfile_media_cancelled";
}

function errorCodeOf(error: unknown, fallback: MsFileMediaError["code"]): MsFileMediaError["code"] {
  if (error instanceof MsFileMediaError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (isStableErrorCode(code)) return code;
  }
  return fallback;
}

function postError(requestId: string, code: MsFileMediaError["code"]): void {
  try { scope.postMessage({ type: "transmux-error", requestId, code }); } catch { /* Worker 已被终止 */ }
}

function range(start: number, end: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end - start > MAX_RANGE_BYTES) {
    return Promise.reject(new MsFileMediaError("msfile_media_configuration"));
  }
  if (rangeWaiters.size >= MAX_RANGE_WAITERS) {
    return Promise.reject(new MsFileMediaError("msfile_media_unsupported_container"));
  }
  const requestId = `range-${++nextRangeId}`;
  return new Promise((resolve, reject) => {
    rangeWaiters.set(requestId, { start, end, resolve, reject });
    try {
      scope.postMessage({ type: "range", requestId, probeRequestId: activeRequestId, start, end });
    } catch {
      rangeWaiters.delete(requestId);
      reject(new MsFileMediaError("msfile_media_network"));
    }
  });
}

function ensureActive(requestId: string): void {
  if (requestId !== activeRequestId || cancelling) {
    throw new MsFileMediaError("msfile_media_cancelled");
  }
}

function outputChunk(data: Uint8Array): Promise<void> {
  if (!activeRequestId || cancelling) return Promise.reject(new MsFileMediaError("msfile_media_cancelled"));
  const chunkId = `chunk-${++nextChunkId}`;
  const bytes = data.slice();
  return new Promise((resolve, reject) => {
    chunkWaiters.set(chunkId, { resolve, reject });
    try {
      scope.postMessage({ type: "transmux-chunk", requestId: activeRequestId, chunkId, bytes: bytes.buffer }, [bytes.buffer]);
    } catch {
      chunkWaiters.delete(chunkId);
      reject(new MsFileMediaError("msfile_media_network"));
    }
  });
}

function rejectPending(error: MsFileMediaError): void {
  for (const waiter of rangeWaiters.values()) waiter.reject(error);
  rangeWaiters.clear();
  for (const waiter of chunkWaiters.values()) waiter.reject(error);
  chunkWaiters.clear();
}

async function startTransmux(request: StartRequest): Promise<void> {
  if (activeRequestId || input || conversion) throw new MsFileMediaError("msfile_media_configuration");
  if (!Number.isSafeInteger(request.fileSizeBytes) || request.fileSizeBytes <= 0 ||
    !Number.isSafeInteger(request.maxSourceCacheBytes) || request.maxSourceCacheBytes < BLOCK_BYTES) {
    throw new MsFileMediaError("msfile_media_configuration");
  }
  activeRequestId = request.requestId;
  cancelling = false;

  const mediabunny = await import("mediabunny");
  ensureActive(request.requestId);
  const customSource = new mediabunny.CustomSource({
    getSize: () => request.fileSizeBytes,
    read: (start, end) => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > request.fileSizeBytes || end - start > MAX_RANGE_BYTES) {
        throw new MsFileMediaError("msfile_media_configuration");
      }
      return range(start, end);
    },
    dispose: () => undefined,
    maxCacheSize: Math.min(request.maxSourceCacheBytes, 64 * BLOCK_BYTES),
    prefetchProfile: "none",
  });
  const mediaInput = new mediabunny.Input({ source: customSource, formats: [mediabunny.MP4] });
  input = mediaInput;

  try {
    ensureActive(request.requestId);
    if (!(await mediaInput.canRead())) throw new MsFileMediaError("msfile_media_unsupported_container");
    ensureActive(request.requestId);
    const format = await mediaInput.getFormat();
    if (!format || format.name.toLowerCase() !== "mp4") throw new MsFileMediaError("msfile_media_unsupported_container");
    const tracks = await mediaInput.getTracks();
    if (!Array.isArray(tracks) || tracks.length === 0 || tracks.length > 4) {
      throw new MsFileMediaError("msfile_media_unsupported_container");
    }
    for (const track of tracks) {
      const codec = await track.getCodecParameterString();
      if (codec !== null && (typeof codec !== "string" || codec.length === 0 || codec.length > 128)) {
        throw new MsFileMediaError("msfile_media_unsupported_codec");
      }
    }

    const target = new mediabunny.AppendOnlyStreamTarget(new WritableStream<Uint8Array>({
      write: (data) => outputChunk(data),
    }));
    const output = new mediabunny.Output({
      format: new mediabunny.Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
      target,
    });
    const mediaConversion = await mediabunny.Conversion.init({ input: mediaInput, output, tracks: "primary", showWarnings: false });
    ensureActive(request.requestId);
    if (!mediaConversion.isValid) {
      const codecProblem = mediaConversion.discardedTracks.some((track) =>
        track.reason === "unknown_source_codec" || track.reason === "undecodable_source_codec" || track.reason === "no_encodable_target_codec");
      throw new MsFileMediaError(codecProblem ? "msfile_media_unsupported_codec" : "msfile_media_unsupported_container");
    }
    conversion = mediaConversion;
    const mimeType = await mediaInput.getMimeType();
    if (typeof mimeType !== "string" || mimeType.length === 0 || mimeType.length > 256) {
      throw new MsFileMediaError("msfile_media_unsupported_codec");
    }
    scope.postMessage({ type: "transmux-ready", requestId: request.requestId, mimeType });
  } catch (error) {
    const code = errorCodeOf(error, "msfile_media_unsupported_container");
    mediaInput.dispose();
    input = undefined;
    conversion = undefined;
    activeRequestId = "";
    rejectPending(new MsFileMediaError(code));
    throw new MsFileMediaError(code);
  }
}

async function pumpTransmux(request: PumpRequest): Promise<void> {
  if (request.requestId !== activeRequestId || !conversion || cancelling) {
    throw new MsFileMediaError("msfile_media_cancelled");
  }
  if (!Number.isFinite(request.untilSeconds) || request.untilSeconds <= 0) {
    throw new MsFileMediaError("msfile_media_configuration");
  }
  await conversion.execute({ until: request.untilSeconds });
  scope.postMessage({
    type: "transmux-pump-done",
    requestId: request.requestId,
    done: conversion.state === "done",
  });
}

async function cancelTransmux(requestId: string): Promise<void> {
  if (requestId !== activeRequestId) return;
  cancelling = true;
  const cancelled = new MsFileMediaError("msfile_media_cancelled");
  rejectPending(cancelled);
  try { await conversion?.cancel(); } catch { /* dispose 竞态 */ }
  input?.dispose();
  input = undefined;
  conversion = undefined;
  activeRequestId = "";
}

scope.onmessage = (event) => {
  const message = event.data;
  if (!message) return;
  if (message.type === "range-result") {
    const waiter = rangeWaiters.get(message.requestId);
    if (!waiter) return;
    rangeWaiters.delete(message.requestId);
    if (message.bytes) {
      if (message.bytes.byteLength !== waiter.end - waiter.start) waiter.reject(new MsFileMediaError("msfile_media_integrity"));
      else waiter.resolve(new Uint8Array(message.bytes));
    } else {
      waiter.reject(new MsFileMediaError(isStableErrorCode(message.code) ? message.code : "msfile_media_network"));
    }
    return;
  }
  if (message.type === "chunk-ack") {
    const waiter = chunkWaiters.get(message.chunkId);
    if (!waiter) return;
    chunkWaiters.delete(message.chunkId);
    if (message.code) waiter.reject(new MsFileMediaError(isStableErrorCode(message.code) ? message.code : "msfile_media_network"));
    else waiter.resolve();
    return;
  }
  if (message.type === "cancel") {
    void cancelTransmux(message.requestId);
    return;
  }
  if (message.type === "start") {
    void startTransmux(message).catch((error: unknown) => {
      const requestId = message.requestId;
      postError(requestId, errorCodeOf(error, "msfile_media_unsupported_container"));
    });
    return;
  }
  if (message.type === "pump") {
    void pumpTransmux(message).catch((error: unknown) => {
      postError(message.requestId, errorCodeOf(error, "msfile_media_decode_failed"));
    });
  }
};
