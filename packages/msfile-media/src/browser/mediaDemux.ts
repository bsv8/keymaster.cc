// Window ↔ DedicatedWorker 的 demux RPC。
// Window 只处理 Worker 的 range 请求，Block 内容通过 transferable 传递，
// 不写日志、不进 DOM；Worker 完成探测后立即 terminate。

import { MsFileMediaError, normalizeMediaError, throwIfMediaAborted } from "../core/errors.js";
import type { MsFileVodSource } from "../core/blockSource.js";
import type { MsFileMediabunnyProbe } from "./mediabunnyAdapter.js";

interface ProbeMessage {
  type: "probe-result" | "probe-error" | "range";
  requestId: string;
  result?: MsFileMediabunnyProbe;
  code?: string;
  probeRequestId?: string;
  start?: number;
  end?: number;
}

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

export async function probeInDedicatedWorker(
  source: MsFileVodSource,
  signal: AbortSignal,
): Promise<MsFileMediabunnyProbe> {
  throwIfMediaAborted(signal);
  if (typeof Worker === "undefined" || typeof URL === "undefined") {
    throw new MsFileMediaError("msfile_media_browser_capability");
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL("./mediaDemux.worker.ts", import.meta.url), { type: "module" });
  } catch {
    throw new MsFileMediaError("msfile_media_browser_capability");
  }
  const requestId = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const touched = new Set<number>();
  const maxProbeBytes = source.maxProbeBlocksAllowed * 256 * 1024;
  return new Promise<MsFileMediabunnyProbe>((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error instanceof MsFileMediaError ? error : normalizeMediaError(error, signal));
    };
    const onAbort = () => fail(new MsFileMediaError("msfile_media_cancelled"));
    worker.onerror = () => fail(new MsFileMediaError("msfile_media_decode_failed"));
    worker.onmessageerror = () => fail(new MsFileMediaError("msfile_media_decode_failed"));
    worker.onmessage = (event: MessageEvent<ProbeMessage>) => {
      const message = event.data;
      if (!message) return;
      if (message.type === "range") {
        if (message.probeRequestId !== requestId) return;
      } else if (message.requestId !== requestId) return;
      if (message.type === "probe-result" && message.result) {
        finished = true;
        cleanup();
        resolve(message.result);
        return;
      }
      if (message.type === "probe-error") {
        fail(stableError(message.code));
        return;
      }
      if (message.type !== "range" || message.start === undefined || message.end === undefined) return;
      const { start, end } = message;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end > source.fileSizeNumber || end - start > maxProbeBytes) {
        worker.postMessage({ type: "range-result", requestId: message.requestId, code: "msfile_media_unsupported_container" });
        return;
      }
      if (end > start) {
        const first = Math.floor(start / (256 * 1024));
        const last = Math.floor((end - 1) / (256 * 1024));
        for (let index = first; index <= last; index += 1) {
          if (!source.isBlockCachedAt(index)) touched.add(index);
          if (touched.size > source.maxProbeBlocksAllowed) {
            worker.postMessage({ type: "range-result", requestId: message.requestId, code: "msfile_media_unsupported_container" });
            return;
          }
        }
      }
      void source.readRange(start, end, signal)
        .then((bytes) => {
          if (finished) return;
          worker.postMessage({ type: "range-result", requestId: message.requestId, bytes: bytes.buffer }, [bytes.buffer]);
        })
        .catch((error: unknown) => {
          if (finished) return;
          const normalized = normalizeMediaError(error, signal);
          worker.postMessage({ type: "range-result", requestId: message.requestId, code: normalized.code });
        });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    worker.postMessage({ type: "probe", requestId, fileSizeBytes: source.fileSizeNumber, maxProbeBlocks: source.maxProbeBlocksAllowed });
  });
}
