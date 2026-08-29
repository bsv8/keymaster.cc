// 首页媒体播放器适配器。
// 组件只负责绑定原生媒体元素和展示快照；Range、Block 完整性和
// Service Worker 桥接都由 @keymaster/msfile-media 管理。

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@keymaster/ui";
import { MSFILE_READ_CONCURRENCY_RECOMMENDED } from "@keymaster/contracts";
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
  canBlobDownload: boolean;
  /** 当前首页获取任务的 token；改变即销毁旧媒体 session。 */
  taskToken: string;
  /** 创建本媒体 Session 时固定的四项并发快照。 */
  mediaBlockReadConcurrency: number;
  globalSeedReadConcurrency: number;
  globalBlockReadConcurrency: number;
  globalStatConcurrency: number;
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
  blockWindowLimit: MSFILE_READ_CONCURRENCY_RECOMMENDED.mediaBlockReadConcurrency,
  verifiedBlockCount: 0,
  readBlockCount: 0,
  debug: { enabled: true, entries: [] },
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
    case "failed": return t("msfile.home.media.failed", { defaultValue: "原生 Range 播放失败" });
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

function debugText(snapshot: MsFileMediaSnapshot): string {
  return snapshot.debug.entries.map((entry) => {
    const details = Object.keys(entry.details).length > 0 ? ` ${JSON.stringify(entry.details)}` : "";
    return `[${String(entry.sequence).padStart(3, "0")} +${String(entry.elapsedMs).padStart(6, " ")}ms] ${entry.scope}.${entry.action}${details}`;
  }).join("\n");
}

export function MsFileMediaPlayer(props: MsFileMediaPlayerProps) {
  const {
    seedHashHex,
    supplierPublicKeyHex,
    fileSizeBytes,
    declaredMediaType,
    filename,
    kind,
    canBlobDownload,
    onDownload,
    t,
    taskToken,
    mediaBlockReadConcurrency,
    globalSeedReadConcurrency,
    globalBlockReadConcurrency,
    globalStatConcurrency,
  } = props;
  const host = usePluginHost();
  const elementRef = useRef<HTMLAudioElement | HTMLVideoElement>(null);
  const debugRef = useRef<HTMLPreElement>(null);
  const mediaArgs = msFileMediaResourceArgs({
    taskToken,
    seedHashHex,
    supplierPublicKeyHex,
    fileSizeBytes,
    declaredMediaType,
    mediaBlockReadConcurrency,
    globalSeedReadConcurrency,
    globalBlockReadConcurrency,
    globalStatConcurrency,
  });
  const resourceSnapshot = useResourceSelector<MsFileMediaSnapshot, MsFileMediaSnapshot | undefined>(
    host.resourceStore,
    MSFILE_MEDIA_RESOURCE_ID,
    mediaArgs,
    (resource) => resource.data,
  );
  const snapshot = resourceSnapshot ?? {
    ...INITIAL_MEDIA_SNAPSHOT,
    blockWindowLimit: mediaBlockReadConcurrency,
  };
  const session = getMsFileMediaSession(taskToken);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [debugCopied, setDebugCopied] = useState(false);

  useEffect(() => {
    let active = true;
    if (!session) {
      setStartupError(t("msfile.home.media.failed", { defaultValue: "原生 Range 播放失败，仍可单独下载。" }));
      return () => { active = false; };
    }
    const element = elementRef.current;
    if (!element) {
      setStartupError(t("msfile.home.media.failed", { defaultValue: "原生 Range 播放失败，仍可单独下载。" }));
      return () => { active = false; };
    }
    setStartupError(null);
    void session.attach(element).catch(() => {
      // 不把第三方解析器/浏览器原始异常写入 DOM；稳定错误码由 session
      // 快照提供，组件这里只显示统一的本地化失败提示。
      if (active) setStartupError(t("msfile.home.media.failed", { defaultValue: "原生 Range 播放失败，仍可单独下载。" }));
    });
    return () => {
      active = false;
      disposeMsFileMediaSession(taskToken, session);
    };
  }, [session, t, taskToken]);

  useEffect(() => {
    const element = debugRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [snapshot.debug.entries.length]);

  const copyDebug = useCallback(() => {
    const text = debugText(snapshot);
    if (!text || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(text).then(() => {
      setDebugCopied(true);
      setTimeout(() => setDebugCopied(false), 1500);
    }).catch(() => undefined);
  }, [snapshot]);

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

  const failed = snapshot.phase === "failed" || Boolean(startupError);
  return (
    <div
      className="msfile-home-file__streaming-player"
      data-msfile-media-phase={snapshot.phase}
      data-msfile-media-read-blocks={snapshot.readBlockCount}
    >
      {mediaElement}
      <div className="msfile-home-file__media-controls" aria-live="polite">
        <span>{phaseLabel(snapshot.phase, t)}</span>
        <span>{t("msfile.home.media.buffered", { defaultValue: "前方已缓冲：{{seconds}} 秒", seconds: shortSeconds(snapshot.bufferedSeconds) })}</span>
        <span>{t("msfile.home.media.window", { defaultValue: "在途 Block：{{used}} / {{limit}}（本媒体并发）", used: snapshot.inFlightBlockCount ?? snapshot.blockWindowOccupancy, limit: snapshot.blockWindowLimit })}</span>
        <span>{t("msfile.home.media.readBlocks", { defaultValue: "已读取 Block：{{count}}", count: snapshot.readBlockCount })}</span>
      </div>
      {failed ? (
        <p className="msfile-home-file__hint">
          {t("msfile.home.media.failed", { defaultValue: "原生 Range 播放失败，仍可单独下载。" })}
          {snapshot.error?.code ? <code> {snapshot.error.code}</code> : null}
        </p>
      ) : null}
      {!failed && snapshot.phase === "idle" ? (
        <p className="msfile-home-file__hint">
          {t("msfile.home.media.notSupported", { defaultValue: "媒体由浏览器按需读取；回跳到已释放内容时可能重新读取对应文件块。" })}
        </p>
      ) : null}
      {snapshot.debug.enabled ? (
        <details className="msfile-home-file__media-debug" open>
          <summary>{t("msfile.home.media.debug.title", { defaultValue: "媒体 Debug（默认开启）" })}</summary>
          <div className="msfile-home-file__media-debug-actions">
            <span>{t("msfile.home.media.debug.count", { defaultValue: "最近 {{count}} 条事件", count: snapshot.debug.entries.length })}</span>
            <Button size="sm" variant="secondary" onClick={copyDebug} disabled={snapshot.debug.entries.length === 0}>
              {debugCopied
                ? t("msfile.home.media.debug.copied", { defaultValue: "已复制" })
                : t("msfile.home.media.debug.copy", { defaultValue: "复制 Debug 日志" })}
            </Button>
          </div>
          <pre ref={debugRef}>{debugText(snapshot) || t("msfile.home.media.debug.empty", { defaultValue: "等待媒体动作…" })}</pre>
        </details>
      ) : null}
      {canBlobDownload ? (
        <Button variant="secondary" onClick={onDownload}>{t("msfile.home.download", { defaultValue: "下载" })}</Button>
      ) : (
        <p className="msfile-home-file__hint">{t("msfile.home.download.tooLarge", { defaultValue: "超过浏览器安全字节范围的文件当前仅支持下载。" })}</p>
      )}
    </div>
  );
}
