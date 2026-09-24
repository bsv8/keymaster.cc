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
import type { MsFileBitfsQuoteView, MsFileBitfsTaskSnapshot } from "@keymaster/contracts";
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

interface BitfsTaskPriceRange {
  /** 当前已验签报价中的最低完整 Block 价。 */
  min: bigint;
  /** 当前报价中的最高价；报价同价时为最高报价的 120%。 */
  max: bigint;
  /** 首次显示时的预选上限。 */
  initial: bigint;
  /** 报价列表版本，仅用于判断范围变化。 */
  key: string;
}

/** 按施工单计算单个文件的强制下载价格范围，金额全程使用整数聪。 */
function bitfsTaskPriceRange(quotes: readonly MsFileBitfsQuoteView[]): BitfsTaskPriceRange | undefined {
  if (quotes.length === 0) return undefined;
  const prices = quotes.map((quote) => BigInt(quote.fullBlockPriceSatoshis));
  const min = prices.reduce((value, price) => price < value ? price : value);
  const maxQuote = prices.reduce((value, price) => price > value ? price : value);
  const key = quotes.map((quote) => `${quote.sessionId}:${quote.fullBlockPriceSatoshis}`).sort().join("|");
  if (maxQuote > min) return { min, max: maxQuote, initial: min + (maxQuote - min) / 5n, key };
  const uint64Max = 0xffffffffffffffffn;
  const max = (min * 6n + 4n) / 5n;
  const cappedMax = max > uint64Max ? uint64Max : max;
  return { min, max: cappedMax, initial: cappedMax, key };
}

/** 将 0–1000 的滑块刻度换算成整数聪。 */
function bitfsTaskPriceAtTick(range: BitfsTaskPriceRange, tick: number): bigint {
  return range.max <= range.min ? range.min : range.min + ((range.max - range.min) * BigInt(tick)) / 1_000n;
}

/** 将已选上限映射为滑块刻度；报价刷新时保留金额本身。 */
function bitfsTaskTickAtPrice(range: BitfsTaskPriceRange, price: bigint): number {
  if (range.max <= range.min || price <= range.min) return 0;
  if (price >= range.max) return 1_000;
  return Number(((price - range.min) * 1_000n) / (range.max - range.min));
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
  const [bitfsTasks, setBitfsTasks] = useState<MsFileBitfsTaskSnapshot[]>([]);
  const [bitfsTasksLoading, setBitfsTasksLoading] = useState(false);
  const [bitfsTaskBusyId, setBitfsTaskBusyId] = useState<string | null>(null);
  const [bitfsPriceDrafts, setBitfsPriceDrafts] = useState<Record<string, { key: string; value: string; dirty: boolean }>>({});
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

  const reloadBitfsTasks = useCallback(async () => {
    if (!service.listBitfsTasks) {
      setBitfsTasks([]);
      return;
    }
    setBitfsTasksLoading(true);
    try {
      const next = await service.listBitfsTasks();
      setBitfsTasks(next);
    } catch (cause) {
      setNotice({ kind: "error", text: bucketError(cause).message });
    } finally {
      setBitfsTasksLoading(false);
    }
  }, [bucketError, service]);

  const cancelBitfsTask = useCallback(async (task: MsFileBitfsTaskSnapshot) => {
    if (task.discoveryOnly ? !service.cancelBitfsDemand : !service.cancelBitfsTask) return;
    setBitfsTaskBusyId(task.sessionId);
    try {
      if (task.discoveryOnly) await service.cancelBitfsDemand!(task.seedHashHex);
      else await service.cancelBitfsTask!(task.seedHashHex, task.sessionId);
      await reloadBitfsTasks();
    } catch (cause) {
      setNotice({ kind: "error", text: bucketError(cause).message });
      await reloadBitfsTasks();
    } finally {
      setBitfsTaskBusyId(null);
    }
  }, [bucketError, reloadBitfsTasks, service]);

  const reconnectBitfsTask = useCallback(async (task: MsFileBitfsTaskSnapshot) => {
    if (!service.reconnectBitfsTask) return;
    setBitfsTaskBusyId(task.sessionId);
    try {
      await service.reconnectBitfsTask(task.seedHashHex);
      await reloadBitfsTasks();
    } catch (cause) {
      setNotice({ kind: "error", text: bucketError(cause).message });
      await reloadBitfsTasks();
    } finally {
      setBitfsTaskBusyId(null);
    }
  }, [bucketError, reloadBitfsTasks, service]);

  const startBitfsTask = useCallback(async (task: MsFileBitfsTaskSnapshot, quote: MsFileBitfsQuoteView, maxPrice: string) => {
    if (!service.startBitfsTask) return;
    setBitfsTaskBusyId(task.sessionId);
    try {
      await service.startBitfsTask(task.seedHashHex, quote.sessionId, maxPrice);
      await reloadBitfsTasks();
    } catch (cause) {
      setNotice({ kind: "error", text: bucketError(cause).message });
      await reloadBitfsTasks();
    } finally {
      setBitfsTaskBusyId(null);
    }
  }, [bucketError, reloadBitfsTasks, service]);

  const saveBitfsPriceLimit = useCallback(async (task: MsFileBitfsTaskSnapshot, maxPrice: string) => {
    if (!service.saveBitfsPriceLimit) return;
    setBitfsTaskBusyId(task.sessionId);
    try {
      await service.saveBitfsPriceLimit(task.seedHashHex, maxPrice);
      setBitfsPriceDrafts((previous) => {
        const draft = previous[task.seedHashHex];
        return draft ? { ...previous, [task.seedHashHex]: { ...draft, value: maxPrice, dirty: false } } : previous;
      });
      setNotice({ kind: "ok", text: t("msfile.bucket.bitfs.priceSaved", { defaultValue: "本文件最高价已保存；不会改变自动购买上限。" }) });
      await reloadBitfsTasks();
    } catch (cause) {
      setNotice({ kind: "error", text: bucketError(cause).message });
    } finally {
      setBitfsTaskBusyId(null);
    }
  }, [bucketError, reloadBitfsTasks, service, t]);

  useEffect(() => {
    setBitfsPriceDrafts((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const task of bitfsTasks) {
        if (!task.discoveryOnly) continue;
        const range = bitfsTaskPriceRange(task.availableQuotes ?? []);
        if (!range) continue;
        const draft = previous[task.seedHashHex];
        if (draft?.dirty) {
          if (draft.key !== range.key) {
            next[task.seedHashHex] = { ...draft, key: range.key };
            changed = true;
          }
        } else if (!draft || draft.key !== range.key
          || (task.currentMaxFullBlockPriceSatoshis != null && draft.value !== task.currentMaxFullBlockPriceSatoshis)) {
          next[task.seedHashHex] = {
            key: range.key,
            value: task.currentMaxFullBlockPriceSatoshis ?? range.initial.toString(10),
            dirty: false,
          };
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [bitfsTasks]);

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
      setBitfsTasks([]);
      setBitfsTasksLoading(false);
      setBitfsTaskBusyId(null);
      setListPhase("idle");
      setListError(null);
      setUploadState(INITIAL_UPLOAD_STATE);
      setBusy(null);
      setDeleteTarget(null);
      releasePreview();
      return undefined;
    }
    void reload();
    void reloadBitfsTasks();
    const taskTimer = setInterval(() => { void reloadBitfsTasks(); }, 5_000);
    return () => {
      clearInterval(taskTimer);
      listControllerRef.current?.abort();
      opControllerRef.current?.abort();
      uploadControllerRef.current?.abort();
    };
  }, [canOperate, lifecycle.activePublicKeyHex, lifecycle.generation, reload, reloadBitfsTasks, releasePreview]);

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

      <section className="msfile-bucket__tasks" aria-labelledby="msfile-bucket-tasks-title">
        <header className="msfile-bucket__tasks-head">
          <div>
            <h4 id="msfile-bucket-tasks-title">{t("msfile.bucket.bitfs.title", { defaultValue: "BitFS 购买任务" })}</h4>
            <p className="msfile-bucket__hint">{t("msfile.bucket.bitfs.hint", { defaultValue: "任务从本地购买日志和专款账本恢复；页面每 5 秒刷新一次。" })}</p>
          </div>
          <Button variant="ghost" size="sm" disabled={!canOperate || bitfsTasksLoading} onClick={() => { void reloadBitfsTasks(); }}>
            {bitfsTasksLoading
              ? t("msfile.bucket.bitfs.refreshing", { defaultValue: "正在刷新…" })
              : t("msfile.bucket.bitfs.refresh", { defaultValue: "刷新任务" })}
          </Button>
        </header>
        {bitfsTasksLoading && bitfsTasks.length === 0 ? (
          <p className="msfile-bucket__hint" role="status">{t("msfile.bucket.bitfs.loading", { defaultValue: "正在读取购买日志和资金状态…" })}</p>
        ) : null}
        {!bitfsTasksLoading && bitfsTasks.length === 0 ? (
          <p className="msfile-bucket__hint">{t("msfile.bucket.bitfs.empty", { defaultValue: "当前 Key 没有未完成的 BitFS 购买任务。" })}</p>
        ) : null}
        {bitfsTasks.map((task) => {
          const progress = task.discoveryOnly
            ? t("msfile.bucket.bitfs.quoteProgress", { defaultValue: "资金尚未拆分；已验签报价 {{count}} 条。", count: task.availableQuotes?.length ?? 0 })
            : task.totalBlockCount === null
              ? t("msfile.bucket.bitfs.verifiedUnknown", { defaultValue: "已验收 {{count}} 个 Block、{{bytes}}；总数未知。", count: task.verifiedBlockCount, bytes: task.verifiedBytes === null ? "未知字节数" : formatBytes(task.verifiedBytes) })
              : t("msfile.bucket.bitfs.verified", { defaultValue: "已验收 {{done}} / {{total}} 个 Block、{{bytes}}", done: task.verifiedBlockCount, total: task.totalBlockCount, bytes: task.verifiedBytes === null ? "未知字节数" : formatBytes(task.verifiedBytes) });
          const quotes = task.availableQuotes ?? [];
          const priceRange = task.discoveryOnly ? bitfsTaskPriceRange(quotes) : undefined;
          const priceDraft = bitfsPriceDrafts[task.seedHashHex];
          const selectedMaxPrice = priceRange
            ? priceDraft?.value ?? priceRange.initial.toString(10)
            : null;
          const selectedMax = selectedMaxPrice === null ? 0n : BigInt(selectedMaxPrice);
          const isDiscovery = task.discoveryOnly === true;
          const isTerminal = task.phase === "completed" || task.phase === "cancelled" || task.phase === "refunded";
          return (
            <article className="msfile-bucket__task" key={`${task.seedHashHex}:${task.sessionId}`}>
              <header className="msfile-bucket__task-head">
                <div className="msfile-bucket__task-title">
                  <strong>{task.recommendedFilename ?? t("msfile.bucket.bitfs.unknownFile", { defaultValue: "未知文件名" })}</strong>
                  <code title={task.seedHashHex}>{shortHex(task.seedHashHex)}</code>
                </div>
                <span className="msfile-bucket__badge">{t(`msfile.bucket.bitfs.phase.${task.phase}`, { defaultValue: task.phase })}</span>
              </header>
              <p className="msfile-bucket__hint">{progress}</p>
              {task.message ? <p className="msfile-bucket__task-message">{task.message}</p> : null}
              {priceRange && selectedMaxPrice !== null ? (
                <div className="msfile-bucket__price-limit">
                  <label htmlFor={`bitfs-price-${task.seedHashHex}`}>
                    {t("msfile.bucket.bitfs.priceLimit", { defaultValue: "本文件完整 Block 最高价" })}: <strong>{selectedMaxPrice} sats</strong>
                  </label>
                  <input
                    id={`bitfs-price-${task.seedHashHex}`}
                    type="range"
                    min="0"
                    max="1000"
                    step="1"
                    value={bitfsTaskTickAtPrice(priceRange, selectedMax)}
                    disabled={!isDiscovery || bitfsTaskBusyId === task.sessionId}
                    onChange={(event) => setBitfsPriceDrafts((previous) => ({
                      ...previous,
                      [task.seedHashHex]: {
                        key: priceRange.key,
                        value: bitfsTaskPriceAtTick(priceRange, Number(event.target.value)).toString(10),
                        dirty: true,
                      },
                    }))}
                  />
                  <p className="msfile-bucket__hint">
                    {t("msfile.bucket.bitfs.priceRange", { defaultValue: "可选 {{min}}–{{max}} sats；新报价不会提高已选上限。", min: priceRange.min.toString(10), max: priceRange.max.toString(10) })}
                  </p>
                  {priceDraft?.dirty ? (
                    <div className="msfile-bucket__task-actions">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!service.saveBitfsPriceLimit || bitfsTaskBusyId === task.sessionId}
                        onClick={() => { void saveBitfsPriceLimit(task, selectedMaxPrice); }}
                      >
                        {t("msfile.bucket.bitfs.savePrice", { defaultValue: "保存本文件最高价" })}
                      </Button>
                    </div>
                  ) : null}
                  {selectedMax < priceRange.min ? (
                    <p className="msfile-bucket__hint" role="status">{t("msfile.bucket.bitfs.noMatchingQuote", { defaultValue: "已选上限低于当前最低报价，目前没有卖家符合。" })}</p>
                  ) : null}
                </div>
              ) : null}
              {!isDiscovery ? <dl className="msfile-bucket__task-metrics">
                <div>
                  <dt>{t("msfile.bucket.bitfs.fileSize", { defaultValue: "文件大小" })}</dt>
                  <dd>{task.fileSizeBytes === null ? "—" : formatBytes(task.fileSizeBytes)}</dd>
                </div>
                <div>
                  <dt>{t("msfile.bucket.bitfs.blockPrice", { defaultValue: "完整 Block 单价" })}</dt>
                  <dd>{task.fullBlockPriceSatoshis === null ? "—" : `${task.fullBlockPriceSatoshis} sats`}</dd>
                </div>
                <div>
                  <dt>{t("msfile.bucket.bitfs.currentMaxBlockPrice", { defaultValue: "本文件已选 Block 最高价" })}</dt>
                  <dd>{task.currentMaxFullBlockPriceSatoshis == null ? "—" : `${task.currentMaxFullBlockPriceSatoshis} sats`}</dd>
                </div>
                <div>
                  <dt>{t("msfile.bucket.bitfs.openingAmount", { defaultValue: "开池金额" })}</dt>
                  <dd>{task.openingAmountSatoshis === null ? "—" : `${task.openingAmountSatoshis} sats`}</dd>
                </div>
                <div>
                  <dt>{t("msfile.bucket.bitfs.paid", { defaultValue: "已付卖家" })}</dt>
                  <dd>{task.paidSatoshis} sats</dd>
                </div>
                <div>
                  <dt>{t("msfile.bucket.bitfs.minerFee", { defaultValue: "已知矿工费" })}</dt>
                  <dd>{task.minerFeeSatoshis} sats</dd>
                </div>
                <div>
                  <dt>{t("msfile.bucket.bitfs.locked", { defaultValue: "受保护金额" })}</dt>
                  <dd>{task.lockedSatoshis} sats</dd>
                </div>
                <div>
                  <dt>{t("msfile.bucket.bitfs.pendingReturn", { defaultValue: "待回收金额" })}</dt>
                  <dd>{task.pendingReturnSatoshis} sats</dd>
                </div>
              </dl> : null}
              {quotes.length > 0 ? (
                <ul className="msfile-bucket__quotes">
                  {quotes.map((quote) => {
                    const overLimit = priceRange !== undefined && BigInt(quote.fullBlockPriceSatoshis) > selectedMax;
                    return (
                      <li key={quote.sessionId}>
                        <div className="msfile-bucket__quote-info">
                          <strong>{quote.recommendedFilename}</strong>
                          <span>{formatBytes(quote.fileSizeBytes)}</span>
                          <span>{t("msfile.bucket.bitfs.quote.seller", { defaultValue: "卖家 {{key}}", key: shortHex(quote.sellerPublicKeyHex) })}</span>
                          <span>{t("msfile.bucket.bitfs.quote.seedPrice", { defaultValue: "Seed {{price}} sats", price: quote.seedPriceSatoshis })}</span>
                          <span>{t("msfile.bucket.bitfs.quote.blockPrice", { defaultValue: "完整 Block {{price}} sats", price: quote.fullBlockPriceSatoshis })}</span>
                          <span>{quote.recentBytesPerSecond === null || quote.recentBytesPerSecond === undefined
                            ? t("msfile.bucket.bitfs.quote.speedUnknown", { defaultValue: "最近速度未知" })
                            : t("msfile.bucket.bitfs.quote.speed", { defaultValue: "最近速度 {{speed}} B/s", speed: quote.recentBytesPerSecond })}</span>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!isDiscovery || !service.startBitfsTask || overLimit || bitfsTaskBusyId === task.sessionId}
                          onClick={() => { if (selectedMaxPrice !== null) void startBitfsTask(task, quote, selectedMaxPrice); }}
                        >
                          {bitfsTaskBusyId === task.sessionId
                            ? t("msfile.bucket.bitfs.starting", { defaultValue: "正在启动…" })
                            : isDiscovery
                              ? t("msfile.bucket.bitfs.forceDownload", { defaultValue: "强制下载此报价" })
                              : t("msfile.bucket.bitfs.currentPurchase", { defaultValue: "当前购买任务" })}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {task.canReconnect === true ? (
                <div className="msfile-bucket__task-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!canOperate || bitfsTaskBusyId === task.sessionId || !service.reconnectBitfsTask}
                    onClick={() => { void reconnectBitfsTask(task); }}
                  >
                    {bitfsTaskBusyId === task.sessionId
                      ? t("msfile.bucket.bitfs.reconnecting", { defaultValue: "正在重新连接…" })
                      : t("msfile.bucket.bitfs.reconnect", { defaultValue: "重新连接卖家并续接" })}
                  </Button>
                </div>
              ) : null}
              {!isTerminal && (isDiscovery || task.canCancel === true) ? (
                <div className="msfile-bucket__task-actions">
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={!canOperate || bitfsTaskBusyId === task.sessionId}
                    onClick={() => { void cancelBitfsTask(task); }}
                  >
                    {bitfsTaskBusyId === task.sessionId
                      ? t("msfile.bucket.bitfs.cancelling", { defaultValue: "正在提交取消…" })
                      : isDiscovery
                        ? t("msfile.bucket.bitfs.stopDemand", { defaultValue: "停止收集报价" })
                        : t("msfile.bucket.bitfs.cancel", { defaultValue: "取消整份下载并回收费用池" })}
                  </Button>
                </div>
              ) : null}
            </article>
          );
        })}
      </section>

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
