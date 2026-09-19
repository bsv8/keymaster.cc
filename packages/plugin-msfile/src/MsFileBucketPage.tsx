// packages/plugin-msfile/src/MsFileBucketPage.tsx
// 桶存储文件页面：列出本桶 `msfiles/` 下由 MasterSeed 生成的种子、文件块
// 和元数据，支持单文件上传、下载、预览、校验与删除。
//
// 边界：
//   - 组件只调用 `MSFILE_BUCKET_SERVICE_CAPABILITY`，不接触 Coordinator、
//     Provider、物理路径或浏览器持久化；
//   - 上传/读取都使用可取消的 AbortController；锁、切 Key、卸载会终止
//     在途任务并释放 Blob URL；
//   - 预览复用首页的 MIME 白名单、签名检查与 32 MiB / 256 MiB 上限。

import { useCallback, useEffect, useRef, useState } from "react";
import type { MsFileSeedEntry, MsFileSeedStoreProgress } from "./storage/msfileSeedStore.js";
import { isMsFileSeedStoreError } from "./storage/msfileSeedStore.js";
import {
  MSFILE_BUCKET_SERVICE_CAPABILITY,
  createBrowserMsFileSeedSource,
  type MsFileBucketService,
} from "./msfileBucketService.js";
import { useOptionalCapability, useResourceSelector } from "webloom-framework/react";
import { AppLink, useI18n, usePluginHost, useRuntimeStatus } from "@keymaster/runtime";
import { Button, DataTable, EmptyState, Modal } from "@keymaster/ui";
import {
  createMsFileIsolatedHtmlBlobUrl,
  decodeMsFileUtf8,
  decideMsFileHomePreview,
  firstMsFileBytes,
  hasMsFilePreviewSignature,
  type MsFileHomePreviewKind,
} from "./filePreviewPolicy.js";

const BUCKET_LIFECYCLE_RESOURCE_ID = "msfile.home.lifecycle";
const PROGRESS_THROTTLE_MS = 120;
const DOWNLOAD_URL_REVOKE_MS = 60_000;

interface BucketLifecycleResource {
  activePublicKeyHex?: string;
  generation?: number;
}

interface BucketError {
  code: string;
  message: string;
}

type ListPhase = "idle" | "loading" | "ready" | "failed";
type UploadPhase = "idle" | "hashing" | "storing" | "done" | "failed" | "cancelled";
type BusyAction = "preview" | "download" | "verify" | "delete";

interface UploadState {
  phase: UploadPhase;
  fileName?: string;
  seedHashHex?: string;
  progress?: MsFileSeedStoreProgress;
  error?: BucketError;
}

interface PreviewState {
  seedHashHex: string;
  kind: MsFileHomePreviewKind;
  url?: string;
  text?: string;
}

interface BusyState {
  action: BusyAction;
  seedHashHex: string;
  progress?: MsFileSeedStoreProgress;
}

const INITIAL_UPLOAD_STATE: UploadState = { phase: "idle" };

function shortHex(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function formatBytes(value: string): string {
  const bytes = BigInt(value);
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let index = 0;
  let divisor = 1n;
  while (index < units.length - 1 && bytes >= divisor * 1024n) {
    divisor *= 1024n;
    index += 1;
  }
  if (index === 0) return `${bytes} B`;
  const tenths = (bytes * 10n) / divisor;
  return `${tenths / 10n}.${tenths % 10n} ${units[index]}`;
}

function isCancellation(cause: unknown): boolean {
  return (isMsFileSeedStoreError(cause) && cause.code === "cancelled")
    || (cause instanceof DOMException && cause.name === "AbortError");
}

function BucketPageUnavailable() {
  const { t } = useI18n();
  return (
    <section className="msfile-bucket msfile-bucket--unavailable" data-msfile-bucket="unavailable">
      <h3>{t("msfile.bucket.title", { defaultValue: "桶存储文件" })}</h3>
      <p className="msfile-bucket__hint">{t("msfile.bucket.unavailable", { defaultValue: "MSFile 当前不可用，请稍后重试。" })}</p>
    </section>
  );
}

export function MsFileBucketPage() {
  const host = usePluginHost();
  const service = useOptionalCapability(MSFILE_BUCKET_SERVICE_CAPABILITY);
  const hasLifecycleResource = host.resourceRegistry?.get(BUCKET_LIFECYCLE_RESOURCE_ID) !== undefined;
  if (!service || !hasLifecycleResource || !host.resourceStore) return <BucketPageUnavailable />;
  return <MsFileBucketPageContent service={service} />;
}

function MsFileBucketPageContent({ service }: { service: MsFileBucketService }) {
  const { t } = useI18n();
  const host = usePluginHost();
  const { vault } = useRuntimeStatus();
  const lifecycle = useResourceSelector<BucketLifecycleResource, BucketLifecycleResource>(
    host.resourceStore,
    BUCKET_LIFECYCLE_RESOURCE_ID,
    [],
    (snapshot) => snapshot.data ?? {},
    (a, b) => a.activePublicKeyHex === b.activePublicKeyHex && a.generation === b.generation,
  );

  const [entries, setEntries] = useState<MsFileSeedEntry[]>([]);
  const [listPhase, setListPhase] = useState<ListPhase>("idle");
  const [listError, setListError] = useState<BucketError | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>(INITIAL_UPLOAD_STATE);
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MsFileSeedEntry | null>(null);

  const listControllerRef = useRef<AbortController | null>(null);
  const opControllerRef = useRef<AbortController | null>(null);
  const uploadControllerRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | undefined>(undefined);
  const lastProgressAtRef = useRef(0);

  const bucketError = useCallback((cause: unknown): BucketError => {
    const code = isMsFileSeedStoreError(cause) ? cause.code : "storage";
    const fallback = t("msfile.bucket.error.default", { defaultValue: "桶存储操作失败，请重试。" });
    switch (code) {
      case "invalid-hash": return { code, message: t("msfile.bucket.error.invalidHash", { defaultValue: "Seed Hash 必须是 64 位小写十六进制字符。" }) };
      case "invalid-source": return { code, message: t("msfile.bucket.error.invalidSource", { defaultValue: "该文件无法读取或超过浏览器可处理的大小。" }) };
      case "source-changed": return { code, message: t("msfile.bucket.error.sourceChanged", { defaultValue: "读取过程中源文件发生变化，上传已中止。" }) };
      case "missing-seed": return { code, message: t("msfile.bucket.error.missingSeed", { defaultValue: "种子文件不存在。" }) };
      case "missing-meta": return { code, message: t("msfile.bucket.error.missingMeta", { defaultValue: "元数据缺失，无法还原文件名、类型和大小。" }) };
      case "missing-block": return { code, message: t("msfile.bucket.error.missingBlock", { defaultValue: "文件块缺失，内容不完整。" }) };
      case "invalid-meta": return { code, message: t("msfile.bucket.error.invalidMeta", { defaultValue: "元数据损坏，已按缺失处理。" }) };
      case "integrity": return { code, message: t("msfile.bucket.error.integrity", { defaultValue: "内容校验失败，已丢弃全部字节。" }) };
      case "cancelled": return { code, message: t("msfile.bucket.error.cancelled", { defaultValue: "操作已取消。" }) };
      default: return { code, message: fallback };
    }
  }, [t]);

  const releasePreview = useCallback(() => {
    const url = previewUrlRef.current;
    previewUrlRef.current = undefined;
    if (url && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try { URL.revokeObjectURL(url); } catch { /* URL 已失效时保持 fail closed */ }
    }
    setPreview(null);
  }, []);

  const reload = useCallback(async () => {
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    setListPhase("loading");
    setListError(null);
    try {
      const next = await service.list({ signal: controller.signal });
      if (controller.signal.aborted) return;
      setEntries(next);
      setListPhase("ready");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setListError(bucketError(cause));
      setListPhase("failed");
    } finally {
      if (listControllerRef.current === controller) listControllerRef.current = null;
    }
  }, [bucketError, service]);

  const canOperate = vault === "unlocked" && Boolean(lifecycle.activePublicKeyHex);

  // active key / 世代变化或锁定时，放弃在途任务并清空展示内容。
  useEffect(() => {
    if (!canOperate) {
      listControllerRef.current?.abort();
      opControllerRef.current?.abort();
      uploadControllerRef.current?.abort();
      listControllerRef.current = null;
      opControllerRef.current = null;
      uploadControllerRef.current = null;
      setEntries([]);
      setListPhase("idle");
      setListError(null);
      setUploadState(INITIAL_UPLOAD_STATE);
      setBusy(null);
      setDeleteTarget(null);
      releasePreview();
      return undefined;
    }
    void reload();
    return () => {
      listControllerRef.current?.abort();
      opControllerRef.current?.abort();
      uploadControllerRef.current?.abort();
    };
  }, [canOperate, lifecycle.activePublicKeyHex, lifecycle.generation, reload, releasePreview]);

  useEffect(() => () => releasePreview(), [releasePreview]);

  const handleUploadProgress = useCallback((progress: MsFileSeedStoreProgress) => {
    const terminal = progress.completedBlocks !== undefined
      && progress.totalBlocks !== undefined
      && progress.completedBlocks === progress.totalBlocks;
    const now = Date.now();
    if (!terminal && now - lastProgressAtRef.current < PROGRESS_THROTTLE_MS) return;
    lastProgressAtRef.current = now;
    setUploadState((previous) => previous.phase === "hashing" || previous.phase === "storing"
      ? { ...previous, phase: progress.phase === "hashing" ? "hashing" : "storing", progress }
      : previous);
  }, []);

  const handleFileChosen = useCallback(async (file: File) => {
    uploadControllerRef.current?.abort();
    const controller = new AbortController();
    uploadControllerRef.current = controller;
    releasePreview();
    setNotice(null);
    lastProgressAtRef.current = 0;
    setUploadState({ phase: "hashing", fileName: file.name });
    try {
      const result = await service.upload(createBrowserMsFileSeedSource(file), {
        signal: controller.signal,
        onProgress: handleUploadProgress,
      });
      if (controller.signal.aborted) return;
      setUploadState({ phase: "done", fileName: result.meta.fileName, seedHashHex: result.entry.seedHashHex });
      setNotice({ kind: "ok", text: t("msfile.bucket.notice.uploadDone", { defaultValue: "上传完成，种子与文件块已写入存储桶。" }) });
      await reload();
    } catch (cause) {
      if (controller.signal.aborted || isCancellation(cause)) {
        setUploadState({ phase: "cancelled", fileName: file.name });
        return;
      }
      setUploadState({ phase: "failed", fileName: file.name, error: bucketError(cause) });
    } finally {
      if (uploadControllerRef.current === controller) uploadControllerRef.current = null;
    }
  }, [bucketError, handleUploadProgress, reload, releasePreview, service, t]);

  const cancelUpload = useCallback(() => {
    uploadControllerRef.current?.abort();
    uploadControllerRef.current = null;
    setUploadState({ phase: "cancelled" });
  }, []);

  /**
   * 懒检测结果回写：读取/校验发现种子缺失时，只把这一行标记为“种子丢失”；
   * 列表本身不做任何缺失检查。
   */
  const markSeedMissing = useCallback((seedHashHex: string) => {
    setEntries((previous) => previous.map((entry) => entry.seedHashHex === seedHashHex
      ? { ...entry, seedPresent: false }
      : entry));
  }, []);

  const runRead = useCallback(async (
    entry: MsFileSeedEntry,
    action: "preview" | "download",
  ) => {
    opControllerRef.current?.abort();
    const controller = new AbortController();
    opControllerRef.current = controller;
    const onProgress = (progress: MsFileSeedStoreProgress) => {
      setBusy((previous) => previous && previous.seedHashHex === entry.seedHashHex
        ? { ...previous, progress }
        : previous);
    };
    setBusy({ action, seedHashHex: entry.seedHashHex });
    try {
      const result = await service.read(entry.seedHashHex, { signal: controller.signal, onProgress });
      if (controller.signal.aborted) return undefined;
      return result;
    } catch (cause) {
      if (!controller.signal.aborted && !isCancellation(cause)) {
        if (isMsFileSeedStoreError(cause) && cause.code === "missing-seed") markSeedMissing(entry.seedHashHex);
        setNotice({ kind: "error", text: bucketError(cause).message });
      }
      return undefined;
    } finally {
      if (opControllerRef.current === controller) {
        opControllerRef.current = null;
        setBusy(null);
      }
    }
  }, [bucketError, markSeedMissing, service]);

  const handleDownload = useCallback(async (entry: MsFileSeedEntry) => {
    if (entry.seedPresent === false) {
      setNotice({ kind: "error", text: t("msfile.bucket.notice.seedMissing", { defaultValue: "种子文件已丢失，无法读取内容。" }) });
      return;
    }
    if (!entry.meta) {
      setNotice({ kind: "error", text: bucketError(new Error("missing-meta")).message });
      return;
    }
    const decision = decideMsFileHomePreview(entry.meta.mediaType, entry.meta.fileSizeBytes);
    if (!decision.canBlobDownload) {
      setNotice({ kind: "error", text: t("msfile.bucket.notice.downloadTooLarge", { defaultValue: "文件超过 256 MiB，当前不会读取。" }) });
      return;
    }
    const result = await runRead(entry, "download");
    if (!result) return;
    try {
      const url = URL.createObjectURL(new Blob(result.parts as unknown as BlobPart[], { type: result.meta.mediaType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.meta.fileName;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch { /* URL 已失效 */ }
      }, DOWNLOAD_URL_REVOKE_MS);
    } catch {
      setNotice({ kind: "error", text: t("msfile.bucket.error.download", { defaultValue: "浏览器无法创建下载文件。" }) });
    }
  }, [bucketError, runRead, t]);

  const handlePreview = useCallback(async (entry: MsFileSeedEntry) => {
    if (entry.seedPresent === false) {
      setNotice({ kind: "error", text: t("msfile.bucket.notice.seedMissing", { defaultValue: "种子文件已丢失，无法读取内容。" }) });
      return;
    }
    if (!entry.meta) {
      setNotice({ kind: "error", text: bucketError(new Error("missing-meta")).message });
      return;
    }
    const decision = decideMsFileHomePreview(entry.meta.mediaType, entry.meta.fileSizeBytes);
    if (!decision.canAutoPreview || !decision.kind) {
      setNotice({
        kind: "error",
        text: decision.reason === "preview-size-limit"
          ? t("msfile.bucket.notice.previewTooLarge", { defaultValue: "超过 32 MiB 的文件不会自动预览，请下载后查看。" })
          : t("msfile.bucket.notice.previewUnsupported", { defaultValue: "该文件类型不会自动预览，请下载后使用。" }),
      });
      return;
    }
    const result = await runRead(entry, "preview");
    if (!result) return;
    const firstBytes = firstMsFileBytes(result.parts);
    if (!hasMsFilePreviewSignature(decision.normalizedMediaType, firstBytes)) {
      setNotice({ kind: "error", text: t("msfile.bucket.notice.previewUnsupported", { defaultValue: "该文件类型不会自动预览，请下载后使用。" }) });
      return;
    }
    releasePreview();
    if (decision.kind === "text") {
      const text = decodeMsFileUtf8(result.parts);
      if (text === undefined) {
        setNotice({ kind: "error", text: t("msfile.bucket.notice.previewUnsupported", { defaultValue: "该文件类型不会自动预览，请下载后使用。" }) });
        return;
      }
      setPreview({ seedHashHex: entry.seedHashHex, kind: "text", text });
      return;
    }
    if (decision.kind === "html") {
      const html = decodeMsFileUtf8(result.parts);
      const url = html === undefined ? undefined : createMsFileIsolatedHtmlBlobUrl(html);
      if (!url) {
        setNotice({ kind: "error", text: t("msfile.bucket.notice.previewUnsupported", { defaultValue: "该文件类型不会自动预览，请下载后使用。" }) });
        return;
      }
      previewUrlRef.current = url;
      setPreview({ seedHashHex: entry.seedHashHex, kind: "html", url });
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob(result.parts as unknown as BlobPart[], { type: result.meta.mediaType }));
      previewUrlRef.current = url;
      setPreview({ seedHashHex: entry.seedHashHex, kind: decision.kind, url });
    } catch {
      setNotice({ kind: "error", text: t("msfile.bucket.notice.previewUnsupported", { defaultValue: "该文件类型不会自动预览，请下载后使用。" }) });
    }
  }, [bucketError, releasePreview, runRead, t]);

  const handleVerify = useCallback(async (entry: MsFileSeedEntry) => {
    if (entry.seedPresent === false) {
      setNotice({ kind: "error", text: t("msfile.bucket.notice.seedMissing", { defaultValue: "种子文件已丢失，无法读取内容。" }) });
      return;
    }
    opControllerRef.current?.abort();
    const controller = new AbortController();
    opControllerRef.current = controller;
    setBusy({ action: "verify", seedHashHex: entry.seedHashHex });
    try {
      // 桶内校验只查存在性与完整性，不做 hash 计算；内容校验留给下载路径。
      const result = await service.verify(entry.seedHashHex, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result.seedPresent) {
        markSeedMissing(entry.seedHashHex);
        setNotice({ kind: "error", text: t("msfile.bucket.notice.seedMissing", { defaultValue: "种子文件已丢失，无法读取内容。" }) });
        return;
      }
      if (!result.seedValid) {
        setNotice({ kind: "error", text: t("msfile.bucket.notice.verifySeedInvalid", { defaultValue: "种子文件损坏（长度不是 32 的整数倍）。" }) });
        return;
      }
      if (!result.metaConsistent) {
        setNotice({ kind: "error", text: t("msfile.bucket.notice.verifyMetaMismatch", { defaultValue: "元数据与种子不一致。" }) });
        return;
      }
      if (result.missingBlocks > 0) {
        setNotice({
          kind: "error",
          text: t("msfile.bucket.notice.verifyMissingBlocks", { defaultValue: "内容不完整：缺少 {{missing}} 个块文件。", missing: result.missingBlocks }),
        });
        return;
      }
      setNotice({
        kind: "ok",
        text: result.metaAvailable
          ? t("msfile.bucket.notice.verifyOk", { defaultValue: "校验通过：种子存在，{{blocks}} 个块文件齐全。", blocks: result.blockCount })
          : t("msfile.bucket.notice.verifySeedOnly", { defaultValue: "校验通过：种子存在，{{blocks}} 个块文件齐全（元数据缺失）。", blocks: result.blockCount }),
      });
    } catch (cause) {
      if (!controller.signal.aborted && !isCancellation(cause)) {
        if (isMsFileSeedStoreError(cause) && cause.code === "missing-seed") markSeedMissing(entry.seedHashHex);
        setNotice({ kind: "error", text: bucketError(cause).message });
      }
    } finally {
      if (opControllerRef.current === controller) {
        opControllerRef.current = null;
        setBusy(null);
      }
    }
  }, [bucketError, markSeedMissing, service, t]);

  const confirmDelete = useCallback(async () => {
    const entry = deleteTarget;
    setDeleteTarget(null);
    if (!entry) return;
    opControllerRef.current?.abort();
    const controller = new AbortController();
    opControllerRef.current = controller;
    setBusy({ action: "delete", seedHashHex: entry.seedHashHex });
    try {
      await service.remove(entry.seedHashHex, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (preview?.seedHashHex === entry.seedHashHex) releasePreview();
      setNotice({ kind: "ok", text: t("msfile.bucket.notice.deleteDone", { defaultValue: "条目已删除：种子、元数据和文件块。" }) });
      await reload();
    } catch (cause) {
      if (!controller.signal.aborted && !isCancellation(cause)) setNotice({ kind: "error", text: bucketError(cause).message });
    } finally {
      if (opControllerRef.current === controller) {
        opControllerRef.current = null;
        setBusy(null);
      }
    }
  }, [bucketError, deleteTarget, preview, releasePreview, reload, service, t]);

  const uploadBusy = uploadState.phase === "hashing" || uploadState.phase === "storing";
  const busyLabel = busy === null ? null : (() => {
    const blocks = busy.progress?.completedBlocks;
    const total = busy.progress?.totalBlocks;
    const suffix = blocks !== undefined && total !== undefined ? ` ${blocks}/${total}` : "";
    switch (busy.action) {
      case "preview": return t("msfile.bucket.status.previewing", { defaultValue: "正在读取文件块…" }) + suffix;
      case "download": return t("msfile.bucket.status.downloading", { defaultValue: "正在读取并校验文件块…" }) + suffix;
      case "verify": return t("msfile.bucket.status.verifying", { defaultValue: "正在完整校验…" });
      default: return t("msfile.bucket.status.deleting", { defaultValue: "正在删除…" });
    }
  })();

  return (
    <section className="msfile-bucket" aria-labelledby="msfile-bucket-title" data-msfile-bucket="page">
      <header className="msfile-bucket__header">
        <div>
          <h3 id="msfile-bucket-title">{t("msfile.bucket.title", { defaultValue: "桶存储文件" })}</h3>
          <p>{t("msfile.bucket.description", { defaultValue: "按 MasterSeed 格式存入本桶的种子与文件块；可直接下载、预览、校验或删除。" })}</p>
        </div>
      </header>

      <div className="msfile-bucket__upload">
        <label className="msfile-bucket__file-label" htmlFor="msfile-bucket-file">
          {t("msfile.bucket.upload.label", { defaultValue: "选择文件并上传" })}
        </label>
        <input
          id="msfile-bucket-file"
          className="msfile-bucket__file-input"
          type="file"
          disabled={!canOperate || uploadBusy}
          data-msfile-bucket="file-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleFileChosen(file);
          }}
        />
        {uploadBusy ? <Button variant="ghost" size="sm" onClick={cancelUpload}>{t("msfile.bucket.upload.cancel", { defaultValue: "取消上传" })}</Button> : null}
      </div>

      {uploadState.phase === "hashing" ? (
        <p className="msfile-bucket__progress" role="status">
          {t("msfile.bucket.upload.hashing", { defaultValue: "正在计算种子摘要…" })}
          {uploadState.progress ? ` ${formatBytes(uploadState.progress.completedBytes)} / ${formatBytes(uploadState.progress.totalBytes)}` : ""}
        </p>
      ) : null}
      {uploadState.phase === "storing" ? (
        <p className="msfile-bucket__progress" role="status">
          {t("msfile.bucket.upload.storing", { defaultValue: "正在写入文件块…" })}
          {uploadState.progress?.completedBlocks !== undefined && uploadState.progress.totalBlocks !== undefined
            ? ` ${uploadState.progress.completedBlocks}/${uploadState.progress.totalBlocks}`
            : ""}
          {uploadState.progress ? ` (${formatBytes(uploadState.progress.completedBytes)} / ${formatBytes(uploadState.progress.totalBytes)})` : ""}
        </p>
      ) : null}
      {uploadState.phase === "failed" ? (
        <p className="msfile-bucket__error" role="alert">{uploadState.error?.message ?? t("msfile.bucket.upload.failed", { defaultValue: "上传失败，请重试。" })}</p>
      ) : null}
      {uploadState.phase === "cancelled" ? (
        <p className="msfile-bucket__hint" role="status">{t("msfile.bucket.upload.cancelled", { defaultValue: "上传已取消；未完成的块不会进入列表。" })}</p>
      ) : null}

      {notice ? (
        <p className={notice.kind === "ok" ? "msfile-bucket__ok" : "msfile-bucket__error"} role={notice.kind === "ok" ? "status" : "alert"}>
          {notice.text}
        </p>
      ) : null}
      {busyLabel ? <p className="msfile-bucket__progress" role="status">{busyLabel}</p> : null}

      {listPhase === "loading" ? (
        <p className="msfile-bucket__hint" role="status">{t("msfile.bucket.list.loading", { defaultValue: "正在读取桶内种子…" })}</p>
      ) : null}
      {listPhase === "failed" ? (
        <div className="msfile-bucket__error" role="alert">
          <span>{listError?.message ?? t("msfile.bucket.error.default", { defaultValue: "桶存储操作失败，请重试。" })}</span>
          <Button variant="ghost" size="sm" onClick={() => { void reload(); }}>{t("msfile.bucket.list.retry", { defaultValue: "重试" })}</Button>
        </div>
      ) : null}
      {listPhase === "ready" && entries.length === 0 ? (
        <EmptyState
          title={t("msfile.bucket.list.empty", { defaultValue: "还没有已存储的种子" })}
          description={t("msfile.bucket.list.emptyHint", { defaultValue: "选择上面的文件上传；上传完成后会按 MasterSeed 制作种子文件并写入文件块。" })}
        />
      ) : null}
      {entries.length > 0 ? (
        <DataTable<MsFileSeedEntry>
          rowKey={(entry) => entry.seedHashHex}
          rows={entries}
          columns={[
            {
              key: "seed",
              header: t("msfile.bucket.column.seed", { defaultValue: "Seed Hash" }),
              render: (entry) => <code title={entry.seedHashHex}>{shortHex(entry.seedHashHex)}</code>,
            },
            {
              key: "name",
              header: t("msfile.bucket.column.name", { defaultValue: "文件名" }),
              render: (entry) => (
                <span className="msfile-bucket__name">
                  {entry.meta
                    ? entry.meta.fileName
                    : <em>{t("msfile.bucket.metaMissing", { defaultValue: "元数据缺失" })}</em>}
                  {entry.seedPresent === false
                    ? <span className="msfile-bucket__badge">{t("msfile.bucket.seedMissing", { defaultValue: "种子丢失" })}</span>
                    : null}
                </span>
              ),
            },
            {
              key: "type",
              header: t("msfile.bucket.column.type", { defaultValue: "类型" }),
              render: (entry) => entry.meta ? <code>{entry.meta.mediaType}</code> : "—",
            },
            {
              key: "size",
              header: t("msfile.bucket.column.size", { defaultValue: "大小" }),
              render: (entry) => entry.meta ? formatBytes(entry.meta.fileSizeBytes) : "—",
            },
            {
              key: "blocks",
              header: t("msfile.bucket.column.blocks", { defaultValue: "块数" }),
              render: (entry) => entry.meta ? String(entry.meta.blockCount) : "—",
            },
            {
              key: "storedAt",
              header: t("msfile.bucket.column.storedAt", { defaultValue: "存入时间" }),
              render: (entry) => entry.meta ? new Date(entry.meta.storedAt).toLocaleString() : "—",
            },
            {
              key: "actions",
              header: t("msfile.bucket.column.actions", { defaultValue: "操作" }),
              render: (entry) => (
                <div className="msfile-bucket__row-actions">
                  <Button variant="ghost" size="sm" disabled={!canOperate || busy !== null || entry.seedPresent === false} onClick={() => { void handlePreview(entry); }}>
                    {t("msfile.bucket.action.preview", { defaultValue: "预览" })}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={!canOperate || busy !== null || entry.seedPresent === false} onClick={() => { void handleDownload(entry); }}>
                    {t("msfile.bucket.action.download", { defaultValue: "下载" })}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={!canOperate || busy !== null || entry.seedPresent === false} onClick={() => { void handleVerify(entry); }}>
                    {t("msfile.bucket.action.verify", { defaultValue: "校验" })}
                  </Button>
                  <Button variant="danger" size="sm" disabled={!canOperate || busy !== null} onClick={() => setDeleteTarget(entry)}>
                    {t("msfile.bucket.action.delete", { defaultValue: "删除" })}
                  </Button>
                </div>
              ),
            },
          ]}
        />
      ) : null}

      {preview ? (
        <section className="msfile-bucket__preview" aria-labelledby="msfile-bucket-preview-title">
          <header className="msfile-bucket__preview-head">
            <h4 id="msfile-bucket-preview-title">{t("msfile.bucket.preview.title", { defaultValue: "文件预览" })}</h4>
            <Button variant="ghost" size="sm" onClick={releasePreview}>{t("msfile.bucket.preview.close", { defaultValue: "关闭预览" })}</Button>
          </header>
          {preview.kind === "text" ? <pre className="msfile-bucket__text-preview">{preview.text}</pre> : null}
          {preview.kind === "html" && preview.url ? (
            <iframe title={t("msfile.bucket.preview.htmlTitle", { defaultValue: "HTML 安全静态预览" })} src={preview.url} sandbox="" referrerPolicy="no-referrer" className="msfile-bucket__frame-preview" />
          ) : null}
          {preview.kind === "pdf" && preview.url ? (
            <iframe title={t("msfile.bucket.preview.pdfTitle", { defaultValue: "PDF 预览" })} src={preview.url} sandbox="" className="msfile-bucket__frame-preview" />
          ) : null}
          {preview.kind === "image" && preview.url ? <img className="msfile-bucket__image-preview" src={preview.url} alt="" /> : null}
          {preview.kind === "audio" && preview.url ? <audio className="msfile-bucket__media-preview" controls src={preview.url} /> : null}
          {preview.kind === "video" && preview.url ? <video className="msfile-bucket__media-preview" controls src={preview.url} /> : null}
        </section>
      ) : null}

      <Modal
        open={deleteTarget !== null}
        title={t("msfile.bucket.action.deleteConfirmTitle", { defaultValue: "删除这个条目？" })}
        onClose={() => setDeleteTarget(null)}
        closeButtonLabel={t("msfile.bucket.action.cancel", { defaultValue: "取消" })}
        footer={(
          <div className="msfile-bucket__modal-actions">
            <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>{t("msfile.bucket.action.cancel", { defaultValue: "取消" })}</Button>
            <Button variant="danger" size="sm" onClick={() => { void confirmDelete(); }}>{t("msfile.bucket.action.deleteConfirm", { defaultValue: "删除" })}</Button>
          </div>
        )}
      >
        <p>{t("msfile.bucket.action.deleteConfirmBody", { defaultValue: "将删除种子、元数据以及该种子目录下的全部文件块；其它种子不受影响。" })}</p>
        {deleteTarget ? (
          <p className="msfile-bucket__hint">
            {deleteTarget.meta?.fileName ?? t("msfile.bucket.metaMissing", { defaultValue: "元数据缺失" })} · <code title={deleteTarget.seedHashHex}>{shortHex(deleteTarget.seedHashHex)}</code>
          </p>
        ) : null}
      </Modal>
    </section>
  );
}

/**
 * 首页 MSFile 空间里的桶存储入口：默认折叠，不读取桶。
 *
 * 桶读取效率不高，首页没看之前不做任何 list；用户点击“查看存储文件”后
 * 才挂载完整页面（此时才会加载 `meta/` 列表）。完整页面入口仍然保留，
 * 用户也可以直接进入 `/msfile/storage`。
 */
export function MsFileBucketHomeWidget() {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (expanded) return <MsFileBucketPage />;
  return (
    <section className="msfile-bucket msfile-bucket--collapsed" data-msfile-bucket="collapsed">
      <h3>{t("msfile.bucket.title", { defaultValue: "桶存储文件" })}</h3>
      <p className="msfile-bucket__hint">{t("msfile.bucket.description", { defaultValue: "按 MasterSeed 格式存入本桶的种子与文件块。" })}</p>
      <div className="msfile-bucket__actions">
        <Button size="sm" onClick={() => setExpanded(true)}>{t("msfile.bucket.load", { defaultValue: "查看存储文件" })}</Button>
        <AppLink to="/msfile/storage">{t("msfile.bucket.openPage", { defaultValue: "打开完整页面" })}</AppLink>
      </div>
    </section>
  );
}
