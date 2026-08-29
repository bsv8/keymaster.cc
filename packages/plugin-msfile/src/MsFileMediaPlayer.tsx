// 首页媒体播放器适配器。
// 组件只负责把 service 变成 SDK Reader、绑定原生媒体元素和展示快照；
// Block 窗口、完整性、MSE/WAV 后端都由 @keymaster/msfile-media 管理。

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@keymaster/ui";
import {
  type MsFileMediaSnapshot,
} from "@keymaster/msfile-media/browser";
import { usePluginHost, useResourceSelector } from "@keymaster/runtime";
import {
  disposeMsFileMediaSession,
  getMsFileMediaSession,
  MSFILE_MEDIA_RESOURCE_ID,
  msFileMediaResourceArgs,
} from "./msfileMediaResource.js";

interface MsFileMediaPlayerProps {
  seedHashHex: string;
  supplierPublicKeyHex: string;
  fileSizeBytes: bigint;
  declaredMediaType: string;
  filename: string;
  kind: "audio" | "video";
  prefetchBlocks: number;
  canBlobDownload: boolean;
  /** 当前首页获取任务的 token；改变即销毁旧媒体 session。 */
  taskToken: string;
  onDownload(): void;
  t(key: string, values?: Record<string, string | number | boolean | null | undefined>): string;
}

const INITIAL_MEDIA_SNAPSHOT: MsFileMediaSnapshot = {
  phase: "idle",
  mode: "vod",
  codecs: [],
  currentTimeSeconds: 0,
  bufferedSeconds: 0,
  blockWindowOccupancy: 0,
  blockWindowLimit: 5,
  verifiedBlockCount: 0,
  readBlockCount: 0,
};

function phaseLabel(
  phase: MsFileMediaSnapshot["phase"],
  t: MsFileMediaPlayerProps["t"],
): string {
  switch (phase) {
    case "reading-seed": return t("msfile.home.media.readingSeed", { defaultValue: "正在读取 Seed" });
    case "parsing-header": return t("msfile.home.media.parsing", { defaultValue: "正在解析媒体头" });
    case "buffering": return t("msfile.home.media.buffering", { defaultValue: "缓冲中" });
    case "playing": return t("msfile.home.media.playing", { defaultValue: "播放中" });
    case "paused": return t("msfile.home.media.pause", { defaultValue: "已暂停" });
    case "ended": return t("msfile.home.media.ended", { defaultValue: "已结束" });
    case "failed": return t("msfile.home.media.failed", { defaultValue: "流式播放失败" });
    case "cancelled": return t("msfile.home.media.cancelled", { defaultValue: "播放已取消" });
    case "stopped": return t("msfile.home.media.stopped", { defaultValue: "播放已停止" });
    case "disposed": return t("msfile.home.media.disposed", { defaultValue: "播放器已释放" });
    case "idle": return t("msfile.home.media.idle", { defaultValue: "等待播放" });
    default: return phase;
  }
}

function shortSeconds(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

export function MsFileMediaPlayer(props: MsFileMediaPlayerProps) {
  const {
    seedHashHex,
    supplierPublicKeyHex,
    fileSizeBytes,
    declaredMediaType,
    filename,
    kind,
    prefetchBlocks,
    canBlobDownload,
    onDownload,
    t,
    taskToken,
  } = props;
  const host = usePluginHost();
  const elementRef = useRef<HTMLAudioElement | HTMLVideoElement>(null);
  const mediaArgs = msFileMediaResourceArgs({ taskToken, seedHashHex, supplierPublicKeyHex, fileSizeBytes, declaredMediaType, prefetchBlocks });
  const resourceSnapshot = useResourceSelector<MsFileMediaSnapshot, MsFileMediaSnapshot | undefined>(
    host.resourceStore,
    MSFILE_MEDIA_RESOURCE_ID,
    mediaArgs,
    (resource) => resource.data,
  );
  const snapshot = resourceSnapshot ?? INITIAL_MEDIA_SNAPSHOT;
  const session = getMsFileMediaSession(taskToken);
  const [startupError, setStartupError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!session) {
      setStartupError(t("msfile.home.media.failed", { defaultValue: "流式播放失败，仍可单独下载。" }));
      return () => { active = false; };
    }
    const element = elementRef.current;
    if (!element) {
      setStartupError(t("msfile.home.media.failed", { defaultValue: "流式播放失败，仍可单独下载。" }));
      return () => { active = false; };
    }
    setStartupError(null);
    void session.attach(element).catch(() => {
      // 不把第三方解析器/浏览器原始异常写入 DOM；稳定错误码由 session
      // 快照提供，组件这里只显示统一的本地化失败提示。
      if (active) setStartupError(t("msfile.home.media.failed", { defaultValue: "流式播放失败，仍可单独下载。" }));
    });
    return () => {
      active = false;
      disposeMsFileMediaSession(taskToken);
    };
  }, [session, t, taskToken]);

  useEffect(() => {
    session?.setPrefetchBlocks(prefetchBlocks);
  }, [prefetchBlocks, session]);

  const play = useCallback(() => {
    if (!session) return;
    setStartupError(null);
    void session.play().catch(() => {
      if (getMsFileMediaSession(taskToken) !== session) return;
      setStartupError(t("msfile.home.media.failed", { defaultValue: "流式播放失败，仍可单独下载。" }));
    });
  }, [session, t, taskToken]);

  const pause = useCallback(() => session?.pause(), [session]);

  const mediaElement = kind === "audio" ? (
    <audio
      ref={elementRef as React.RefObject<HTMLAudioElement>}
      className="msfile-home-file__media-preview"
      controls
      preload="none"
      aria-label={filename}
    />
  ) : (
    <video
      ref={elementRef as React.RefObject<HTMLVideoElement>}
      className="msfile-home-file__media-preview"
      controls
      preload="none"
      playsInline
      aria-label={filename}
    />
  );

  const isPlaying = snapshot.phase === "playing";
  const failed = snapshot.phase === "failed" || Boolean(startupError);
  return (
    <div
      className="msfile-home-file__streaming-player"
      data-msfile-media-phase={snapshot.phase}
      data-msfile-media-read-blocks={snapshot.readBlockCount}
    >
      {mediaElement}
      <div className="msfile-home-file__media-controls" aria-live="polite">
        <Button size="sm" onClick={isPlaying ? pause : play} disabled={snapshot.phase === "reading-seed" || snapshot.phase === "parsing-header"}>
          {isPlaying
            ? t("msfile.home.media.pause", { defaultValue: "暂停" })
            : t("msfile.home.media.play", { defaultValue: "使用流式读取播放" })}
        </Button>
        <span>{phaseLabel(snapshot.phase, t)}</span>
        <span>{t("msfile.home.media.buffered", { defaultValue: "前方已缓冲：{{seconds}} 秒", seconds: shortSeconds(snapshot.bufferedSeconds) })}</span>
        <span>{t("msfile.home.media.window", { defaultValue: "Block 窗口：{{used}} / {{limit}}", used: snapshot.blockWindowOccupancy, limit: snapshot.blockWindowLimit })}</span>
        <span>{t("msfile.home.media.readBlocks", { defaultValue: "已读取 Block：{{count}}", count: snapshot.readBlockCount })}</span>
      </div>
      {failed ? (
        <p className="msfile-home-file__hint">
          {t("msfile.home.media.failed", { defaultValue: "流式播放失败，仍可单独下载。" })}
          {snapshot.error?.code ? <code> {snapshot.error.code}</code> : null}
        </p>
      ) : null}
      {!failed && snapshot.phase === "idle" ? (
        <p className="msfile-home-file__hint">
          {t("msfile.home.media.notSupported", { defaultValue: "播放会按 Block 窗口读取，不会先组装完整 Blob。" })}
        </p>
      ) : null}
      {canBlobDownload ? (
        <Button variant="secondary" onClick={onDownload}>{t("msfile.home.download", { defaultValue: "下载" })}</Button>
      ) : (
        <p className="msfile-home-file__hint">{t("msfile.home.download.tooLarge", { defaultValue: "超过 256 MiB 的文件当前仅支持有界流式播放。" })}</p>
      )}
    </div>
  );
}
