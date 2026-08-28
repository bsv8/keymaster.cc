// 浏览器能力检测集中在这里，播放器不得靠 User-Agent 猜测 Codec 能力。

export interface MsFileMediaCapabilities {
  mediaSource: boolean;
  /** 只有显式正向信号才为 true；缺失 API 按 false 处理。 */
  mediaSourceInDedicatedWorker: boolean;
  audioDecoder: boolean;
  videoDecoder: boolean;
  mseMimeTypes: Readonly<Record<string, boolean>>;
}

type DecoderConstructor = {
  isConfigSupported?(config: Record<string, unknown>): Promise<unknown>;
};

function decoderAvailable(name: "AudioDecoder" | "VideoDecoder"): boolean {
  const constructor = (globalThis as unknown as Record<string, unknown>)[name] as DecoderConstructor | undefined;
  return typeof constructor?.isConfigSupported === "function";
}

async function decoderSupports(
  name: "AudioDecoder" | "VideoDecoder",
  config: Record<string, unknown>,
): Promise<boolean> {
  const constructor = (globalThis as unknown as Record<string, unknown>)[name] as DecoderConstructor | undefined;
  if (typeof constructor?.isConfigSupported !== "function") return false;
  try {
    const result = await constructor.isConfigSupported(config) as { supported?: unknown };
    return result?.supported === true;
  } catch {
    return false;
  }
}

/** 运行时能力快照；MSE 在当前版本固定运行于 Window。 */
export async function detectMsFileMediaCapabilities(
  mimeTypes: readonly string[] = [
    "audio/mpeg",
    "audio/mp4; codecs=\"mp4a.40.2\"",
    "audio/webm; codecs=\"opus\"",
    "video/mp4; codecs=\"avc1.42E01E,mp4a.40.2\"",
    "video/webm; codecs=\"vp8,opus\"",
  ],
): Promise<MsFileMediaCapabilities> {
  const mediaSource = typeof MediaSource !== "undefined";
  const mseMimeTypes: Record<string, boolean> = {};
  for (const mimeType of mimeTypes) {
    mseMimeTypes[mimeType] = mediaSource && MediaSource.isTypeSupported(mimeType);
  }
  // Chromium 当前没有可稳定依赖的正向 worker MSE 构造标记。不要因为
  // worker 全局中出现 MediaSource 名称就错误地把 append 放到 Worker。
  const workerMarker = (globalThis as unknown as { MediaSource?: { canConstructInDedicatedWorker?: boolean } }).MediaSource;
  return {
    mediaSource,
    mediaSourceInDedicatedWorker: workerMarker?.canConstructInDedicatedWorker === true,
    audioDecoder: decoderAvailable("AudioDecoder"),
    videoDecoder: decoderAvailable("VideoDecoder"),
    mseMimeTypes,
  };
}

export { decoderSupports };
