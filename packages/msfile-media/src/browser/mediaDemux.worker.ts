// DedicatedWorker 中的 Mediabunny 探测器。
// Worker 不直接访问网络：每次 CustomSource range 都向 Window 请求，Window
// 再经 MsFileVodSource 做 Block Hash/长度校验后 transferable 传入。

import { MsFileMediaError } from "../core/errors.js";
import { containsAscii, containerOf, type MsFileMediabunnyProbe } from "./mediabunnyAdapter.js";

interface WorkerRequest {
  type: "probe";
  requestId: string;
  fileSizeBytes: number;
  maxProbeBlocks: number;
}

interface RangeResponse {
  type: "range-result";
  requestId: string;
  bytes?: ArrayBuffer;
  code?: string;
}

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest | RangeResponse>) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;
let nextRangeId = 0;
let activeProbeRequestId = "";
const rangeWaiters = new Map<string, {
  start: number;
  end: number;
  resolve(bytes: Uint8Array): void;
  reject(error: MsFileMediaError): void;
}>();

const MAX_MEDIA_TRACKS = 4;
const MAX_MEDIA_CODECS = 4;
const MAX_MEDIA_CODEC_LENGTH = 128;
const MAX_MEDIA_MIME_LENGTH = 256;
const MAX_MEDIA_DURATION_SECONDS = 30 * 24 * 60 * 60;
const MAX_RANGE_WAITERS = 8;

function isStableErrorCode(value: unknown): value is MsFileMediaError["code"] {
  return value === "msfile_media_configuration" || value === "msfile_media_network" ||
    value === "msfile_media_amount" || value === "msfile_media_integrity" ||
    value === "msfile_media_unsupported_container" || value === "msfile_media_unsupported_codec" ||
    value === "msfile_media_browser_capability" || value === "msfile_media_decode_failed" ||
    value === "msfile_media_cancelled";
}

function errorCodeOf(error: unknown): string {
  if (error instanceof MsFileMediaError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "msfile_media_decode_failed";
}

function range(start: number, end: number): Promise<Uint8Array> {
  if (rangeWaiters.size >= MAX_RANGE_WAITERS) {
    return Promise.reject(new MsFileMediaError("msfile_media_unsupported_container"));
  }
  const requestId = `range-${++nextRangeId}`;
  return new Promise((resolve, reject) => {
    rangeWaiters.set(requestId, { start, end, resolve, reject });
    try {
      scope.postMessage({ type: "range", requestId, probeRequestId: activeProbeRequestId, start, end });
    } catch {
      rangeWaiters.delete(requestId);
      reject(new MsFileMediaError("msfile_media_network"));
    }
  });
}
async function probe(request: WorkerRequest): Promise<MsFileMediabunnyProbe> {
  if (!Number.isSafeInteger(request.fileSizeBytes) || request.fileSizeBytes < 0 ||
    !Number.isSafeInteger(request.maxProbeBlocks) || request.maxProbeBlocks < 1 || request.maxProbeBlocks > 8) {
    throw new MsFileMediaError("msfile_media_configuration");
  }
  const mediabunny = await import("mediabunny");
  const maxProbeBytes = request.maxProbeBlocks * 256 * 1024;
  const touched = new Set<number>();
  const customSource = new mediabunny.CustomSource({
    getSize: () => request.fileSizeBytes,
    read: (start, end) => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end > request.fileSizeBytes || end - start > maxProbeBytes) {
        throw new MsFileMediaError("msfile_media_unsupported_container");
      }
      if (end > start) {
        const first = Math.floor(start / (256 * 1024));
        const last = Math.floor((end - 1) / (256 * 1024));
        for (let index = first; index <= last; index += 1) {
          touched.add(index);
          if (touched.size > request.maxProbeBlocks) throw new MsFileMediaError("msfile_media_unsupported_container");
        }
      }
      return range(start, end);
    },
    dispose: () => undefined,
    maxCacheSize: maxProbeBytes,
    prefetchProfile: "none",
  });
  const input = new mediabunny.Input({
    source: customSource,
    formats: [mediabunny.MP4, mediabunny.MATROSKA, mediabunny.WEBM, mediabunny.MP3, mediabunny.WAVE],
  });
  try {
    if (!(await input.canRead())) throw new MsFileMediaError("msfile_media_unsupported_container");
    const format = await input.getFormat();
    const container = containerOf(format);
    if (!container) throw new MsFileMediaError("msfile_media_unsupported_container");
    const tracks = await input.getTracks();
    if (!Array.isArray(tracks) || tracks.length === 0 || tracks.length > MAX_MEDIA_TRACKS) {
      throw new MsFileMediaError("msfile_media_unsupported_container");
    }
    const codecs: string[] = [];
    for (const track of tracks) {
      const codec = await track.getCodecParameterString();
      if (codec !== null) {
        if (typeof codec !== "string" || codec.length === 0 || codec.length > MAX_MEDIA_CODEC_LENGTH || codecs.length >= MAX_MEDIA_CODECS) {
          throw new MsFileMediaError("msfile_media_unsupported_codec");
        }
        codecs.push(codec);
      }
    }
    const mimeType = await input.getMimeType();
    if (typeof mimeType !== "string" || mimeType.length === 0 || mimeType.length > MAX_MEDIA_MIME_LENGTH) {
      throw new MsFileMediaError("msfile_media_unsupported_codec");
    }
    const duration = await input.getDurationFromMetadata().catch(() => null);
    if (duration !== null && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > MAX_MEDIA_DURATION_SECONDS)) {
      throw new MsFileMediaError("msfile_media_unsupported_container");
    }
    let directMse = container === "mp3" || container === "webm";
    if (container === "mp4") {
      const head = await range(0, Math.min(request.fileSizeBytes, maxProbeBytes));
      directMse = containsAscii(head, "moof");
    }
    if (container === "matroska") directMse = false;
    return {
      container,
      mimeType,
      codecs,
      durationSeconds: typeof duration === "number" ? duration : undefined,
      directMse,
    };
  } finally {
    input.dispose();
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "range-result") {
    const waiter = rangeWaiters.get(message.requestId);
    if (!waiter) return;
    rangeWaiters.delete(message.requestId);
    if (message.bytes) {
      if (message.bytes.byteLength !== waiter.end - waiter.start) {
        waiter.reject(new MsFileMediaError("msfile_media_integrity"));
      } else {
        waiter.resolve(new Uint8Array(message.bytes));
      }
    } else {
      waiter.reject(new MsFileMediaError(isStableErrorCode(message.code) ? message.code : "msfile_media_network"));
    }
    return;
  }
  if (message.type !== "probe") return;
  if (activeProbeRequestId) {
    scope.postMessage({ type: "probe-error", requestId: message.requestId, code: "msfile_media_configuration" });
    return;
  }
  activeProbeRequestId = message.requestId;
  void probe(message)
    .then((result) => scope.postMessage({ type: "probe-result", requestId: message.requestId, result }))
    .catch((error: unknown) => scope.postMessage({ type: "probe-error", requestId: message.requestId, code: errorCodeOf(error) }));
};
