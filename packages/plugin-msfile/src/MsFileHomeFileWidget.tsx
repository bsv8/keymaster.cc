// packages/plugin-msfile/src/MsFileHomeFileWidget.tsx
// 首页「通过 Seed 获取文件」模块。
//
// 组件只调用受信任的 `msfile.service`，不接触 DB、Coordinator、transport 或
// Window executor。文件内容只保存在当前任务的内存引用中；新查询、取消、
// active key / supplier generation 变化和卸载都会释放它以及所有 Blob URL。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MsFileGlobalPriceSettings,
  MsFileReadResult,
  MsFileService,
  MsFileServiceStatus,
  MsFileSettingsSnapshot,
  MsFileStatQuotedEntry,
  MsFileStatResult,
  MsFileSupplierConfig,
  MsFileSupplierStat,
} from "@keymaster/contracts";
import {
  isValidMsFileHashHex,
  isValidMsFileSupplierPublicKeyHex,
  MSFILE_SERVICE_CAPABILITY,
} from "@keymaster/contracts";
import {
  AppLink,
  useCapability,
  useI18n,
  usePluginHost,
  useResourceSelector,
  useRuntimeStatus,
} from "@keymaster/runtime";
import { Button } from "@keymaster/ui";
import {
  assembleMsFileParts,
  extractMsFileReadBytes,
  FileAssemblyError,
  parseSeedBlockPlan,
  parseMsFileUint64,
  readMsFileBlocksWithWorkerPool,
  sanitizeMsFileFilename,
  type FileBlockPlan,
} from "./fileAssembly.js";
import {
  createMsFileIsolatedHtmlBlobUrl,
  decodeMsFileUtf8,
  decideMsFileHomePreview,
  firstMsFileBytes,
  hasMsFilePreviewSignature,
  normalizeMsFileMediaType,
  type MsFileHomePreviewDecision,
  type MsFileHomePreviewKind,
} from "./filePreviewPolicy.js";

const HOME_STATUS_RESOURCE_ID = "msfile.status";
const HOME_LIFECYCLE_RESOURCE_ID = "msfile.home.lifecycle";

type HomePhase =
  | "idle"
  | "validating"
  | "stat-loading"
  | "supplier-selection"
  | "preview-decision"
  | "ready-to-download"
  | "seed-reading"
  | "block-reading"
  | "assembling"
  | "preview-ready"
  | "downloading"
  | "download-ready"
  | "failed"
  | "cancelled";

interface HomeStatusResource {
  status: MsFileServiceStatus;
  globalSettings: MsFileGlobalPriceSettings | null;
  supplierGeneration: number;
}

interface HomeLifecycleResource {
  activePublicKeyHex?: string;
  generation?: number;
}

interface HomeError {
  code: string;
  message: string;
}

interface HomeProgress {
  verifiedBlocks: number;
  totalBlocks: number;
  verifiedBytes: bigint;
  totalBytes: bigint;
}

type CandidateStat =
  | Extract<MsFileSupplierStat, { status: "available" }>
  | Extract<MsFileSupplierStat, { status: "quoted" }>;

interface FileSelection {
  supplierPublicKeyHex: string;
  supplierName: string;
  stat: CandidateStat;
  fileSizeBytes: bigint;
  mediaType: string;
  filename: string;
  previewDecision: MsFileHomePreviewDecision;
}

interface SupplierStatView {
  entry: MsFileSupplierStat;
  supplierName: string;
  selection?: FileSelection;
}

interface PreviewState {
  kind: MsFileHomePreviewKind;
  url?: string;
  text?: string;
}

interface HomeState {
  phase: HomePhase;
  hash: string;
  stats: SupplierStatView[];
  selected?: FileSelection;
  progress?: HomeProgress;
  preview?: PreviewState;
  notice?: string;
  error?: HomeError;
}

interface FetchTask {
  id: number;
  hash: string;
  activeKey: string;
  activeKeyGeneration?: number;
  supplierGeneration: number;
  controller: AbortController;
  stats: SupplierStatView[];
  selected?: FileSelection;
  plan?: FileBlockPlan;
  parts?: Uint8Array[];
  readPromise?: Promise<void>;
  previewUrl?: string;
  downloadUrl?: string;
}

const INITIAL_STATE: HomeState = { phase: "idle", hash: "", stats: [] };

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function shortHex(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function safeSupplierName(config: MsFileSupplierConfig | undefined): string {
  if (!config || typeof config.name !== "string") return "Supplier";
  const cleaned = config.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return cleaned || "Supplier";
}

function formatBytes(bytes: bigint): string {
  if (bytes < 1024n) return `${bytes.toString()} B`;
  if (bytes <= BigInt(Number.MAX_SAFE_INTEGER)) {
    const value = Number(bytes);
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} KiB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value % (1024 * 1024) === 0 ? 0 : 1)} MiB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  }
  return `${bytes.toString()} B`;
}

function isBusyPhase(phase: HomePhase): boolean {
  return phase === "validating" || phase === "stat-loading" || phase === "preview-decision" ||
    phase === "seed-reading" || phase === "block-reading" || phase === "assembling" || phase === "downloading";
}

function candidateOf(view: SupplierStatView): FileSelection | undefined {
  return view.selection;
}

function quoteFields(entry: MsFileStatQuotedEntry): readonly string[] {
  return [
    entry.minSeedPriceSatoshis,
    entry.maxSeedPriceSatoshis,
    entry.minFullBlockPriceSatoshis,
    entry.maxFullBlockPriceSatoshis,
  ];
}

/**
 * 把 service 的 Stat 结果转成一次获取快照。供应商返回的元数据不可信，
 * 因此候选的大小、报价、hash 和 MIME 都先做本地结构校验。
 */
function buildStatViews(
  result: MsFileStatResult,
  settings: MsFileSettingsSnapshot | null,
  seedHashHex: string,
): SupplierStatView[] {
  if (!result || result.seedHashHex !== seedHashHex || !Array.isArray(result.suppliers)) {
    throw new FileAssemblyError("invalid-block-response");
  }
  const supplierByKey = new Map((settings?.suppliers ?? []).map((supplier) => [supplier.supplierPublicKeyHex, supplier]));
  return result.suppliers.map((entry) => {
    if (!entry || typeof entry.supplierPublicKeyHex !== "string" || !isValidMsFileSupplierPublicKeyHex(entry.supplierPublicKeyHex)) {
      throw new FileAssemblyError("invalid-block-response");
    }
    const config = supplierByKey.get(entry.supplierPublicKeyHex);
    const supplierName = safeSupplierName(config);
    if (entry.status !== "available" && entry.status !== "quoted") {
      if (entry.status === "discovering" && (!Number.isFinite(entry.retryAfterMs) || entry.retryAfterMs < 0)) {
        throw new FileAssemblyError("invalid-block-response");
      }
      if (entry.status === "absent" || entry.status === "network-error" || entry.status === "discovering") {
        return { entry, supplierName };
      }
      throw new FileAssemblyError("invalid-block-response");
    }

    const fileSizeBytes = parseMsFileUint64(entry.fileSizeBytes);
    const previewDecision = decideMsFileHomePreview(entry.mediaType, entry.fileSizeBytes);
    if (previewDecision.reason === "invalid-file-size") throw new FileAssemblyError("invalid-file-size");
    if (entry.status === "quoted") {
      for (const amount of quoteFields(entry)) parseMsFileUint64(amount);
    }
    const selection: FileSelection = {
      supplierPublicKeyHex: entry.supplierPublicKeyHex,
      supplierName,
      stat: entry,
      fileSizeBytes,
      mediaType: normalizeMsFileMediaType(entry.mediaType),
      filename: sanitizeMsFileFilename(entry.recommendedFilename, seedHashHex),
      previewDecision,
    };
    return { entry, supplierName, selection };
  });
}

function createBlobUrl(parts: readonly Uint8Array[], mediaType: string): string | undefined {
  if (typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return undefined;
  try {
    return URL.createObjectURL(new Blob(parts as unknown as BlobPart[], { type: mediaType }));
  } catch {
    return undefined;
  }
}

function displayErrorMessage(code: string, t: (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string): string {
  switch (code) {
    case "msfile_invalid_hash": return t("msfile.home.errors.invalidHash", { defaultValue: "Seed Hash 必须是 64 位小写十六进制字符。" });
    case "msfile_not_configured": return t("msfile.home.errors.notConfigured", { defaultValue: "MSFile 尚未完成配置，请先设置全局金额上限并启用供应商。" });
    case "msfile_unavailable": return t("msfile.home.errors.unavailable", { defaultValue: "MSFile 当前不可用，请稍后重试。" });
    case "msfile_supplier_not_found":
    case "msfile_supplier_disabled": return t("msfile.home.errors.supplierChanged", { defaultValue: "所选供应商已变化，请重新查询。" });
    case "msfile_price_limit_exceeded": return t("msfile.home.errors.priceLimit", { defaultValue: "读取金额超过全局上限，请前往 MSFile 设置调整。首页不会临时提高额度。" });
    case "msfile_integrity_error": return t("msfile.home.errors.integrity", { defaultValue: "文件完整性校验失败，已丢弃全部内容。" });
    case "msfile_content_not_found": return t("msfile.home.errors.contentNotFound", { defaultValue: "供应商没有找到请求的内容。" });
    case "msfile_rate_limited": return t("msfile.home.errors.rateLimited", { defaultValue: "供应商暂时限制了请求，请稍后重试。" });
    case "msfile_supplier_error": return t("msfile.home.errors.supplier", { defaultValue: "供应商暂时无法完成请求，请稍后重试。" });
    case "msfile_protocol_error": return t("msfile.home.errors.protocol", { defaultValue: "供应商协议响应无效，文件未被使用。" });
    case "msfile_transport_error": return t("msfile.home.errors.transport", { defaultValue: "供应商暂时不可用，请稍后重试。" });
    case "user_rejected": return t("msfile.home.errors.rejected", { defaultValue: "读取请求未获批准。" });
    case "msfile_download_error": return t("msfile.home.errors.download", { defaultValue: "浏览器无法创建下载文件。" });
    default: return t("msfile.home.errors.default", { defaultValue: "文件获取失败，请重试。" });
  }
}

function messageForPreviewReason(
  selection: FileSelection,
  t: (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string,
): string | undefined {
  if (!selection.previewDecision.canBlobDownload) {
    return t("msfile.home.download.tooLarge", { defaultValue: "超过 256 MiB 的文件需要后续流式下载支持，当前不会读取。" });
  }
  if (selection.previewDecision.reason === "preview-size-limit") {
    return t("msfile.home.preview.tooLarge", { defaultValue: "超过 32 MiB 的文件不会自动预览，请点击下载。" });
  }
  if (selection.previewDecision.reason === "unsupported-media-type") {
    return t("msfile.home.preview.unsupported", { defaultValue: "该文件类型不会自动预览，请点击下载后使用。" });
  }
  return undefined;
}

export function MsFileHomeFileWidget() {
  const { t } = useI18n();
  const host = usePluginHost();
  const service = useCapability<MsFileService>(MSFILE_SERVICE_CAPABILITY);
  const { vault } = useRuntimeStatus();

  // 状态和配置通过 Resource Store 感知，避免组件直接订阅 service / keyspace。
  const statusResource = useResourceSelector<HomeStatusResource, HomeStatusResource>(
    host.resourceStore,
    HOME_STATUS_RESOURCE_ID,
    [],
    (snapshot) => snapshot.data ?? {
      status: service.status(),
      globalSettings: null,
      supplierGeneration: 0,
    },
    (a, b) => a.status === b.status && a.supplierGeneration === b.supplierGeneration &&
      JSON.stringify(a.globalSettings) === JSON.stringify(b.globalSettings),
  );
  const lifecycle = useResourceSelector<HomeLifecycleResource, HomeLifecycleResource>(
    host.resourceStore,
    HOME_LIFECYCLE_RESOURCE_ID,
    [],
    (snapshot) => snapshot.data ?? {},
    (a, b) => a.activePublicKeyHex === b.activePublicKeyHex && a.generation === b.generation,
  );

  const [seedHashDraft, setSeedHashDraft] = useState("");
  const [settingsSnapshot, setSettingsSnapshot] = useState<MsFileSettingsSnapshot | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const [state, setState] = useState<HomeState>(INITIAL_STATE);

  const taskRef = useRef<FetchTask | null>(null);
  const taskSequenceRef = useRef(0);
  const activeKeyRef = useRef<string | undefined>(lifecycle.activePublicKeyHex);
  const activeKeyGenerationRef = useRef<number | undefined>(lifecycle.generation);
  // settings snapshot 是本次读取使用的配置真值；刷新期间切回 status
  // resource 的当前世代，避免 SharedWorker 会话重建后世代归零时被
  // `Math.max` 错误地保留为旧世代。
  const supplierGeneration = settingsLoading || !settingsSnapshot
    ? statusResource.supplierGeneration
    : settingsSnapshot.supplierGeneration;
  const supplierGenerationRef = useRef(supplierGeneration);
  const vaultRef = useRef(vault);
  activeKeyRef.current = lifecycle.activePublicKeyHex;
  activeKeyGenerationRef.current = lifecycle.generation;
  supplierGenerationRef.current = supplierGeneration;
  vaultRef.current = vault;

  const revokeUrl = useCallback((url: string | undefined) => {
    if (!url || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
    try { URL.revokeObjectURL(url); } catch { /* URL 已失效时保持 fail closed */ }
  }, []);

  const releaseTask = useCallback((task: FetchTask) => {
    task.controller.abort();
    if (task.previewUrl && task.previewUrl !== task.downloadUrl) revokeUrl(task.previewUrl);
    revokeUrl(task.downloadUrl);
    task.previewUrl = undefined;
    task.downloadUrl = undefined;
    task.parts = undefined;
    task.plan = undefined;
    task.readPromise = undefined;
  }, [revokeUrl]);

  const abandonTask = useCallback(() => {
    const task = taskRef.current;
    if (task) releaseTask(task);
    taskRef.current = null;
    taskSequenceRef.current += 1;
  }, [releaseTask]);

  const isCurrent = useCallback((task: FetchTask): boolean => {
    return taskRef.current === task &&
      !task.controller.signal.aborted &&
      task.activeKey === activeKeyRef.current &&
      task.activeKeyGeneration === activeKeyGenerationRef.current &&
      task.supplierGeneration === supplierGenerationRef.current &&
      vaultRef.current === "unlocked";
  }, []);

  useEffect(() => {
    if (vault !== "unlocked" || statusResource.status === "unavailable") {
      setSettingsSnapshot(null);
      setSettingsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setSettingsLoading(true);
    setSettingsError(false);
    void service.getSettingsSnapshot()
      .then((snapshot) => {
        if (cancelled) return;
        setSettingsSnapshot(snapshot);
        setSettingsError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSettingsError(true);
        setSettingsSnapshot(null);
      })
      .finally(() => {
        if (!cancelled) setSettingsLoading(false);
      });
    return () => { cancelled = true; };
  }, [service, statusResource.status, statusResource.supplierGeneration, vault]);

  // active key / supplier generation / lock 是任务栅栏。effect 之外 isCurrent
  // 也同步检查 ref，覆盖 React effect 尚未运行的微小窗口。
  useEffect(() => {
    const task = taskRef.current;
    if (!task) return;
    const invalid = vault !== "unlocked" ||
      !lifecycle.activePublicKeyHex ||
      task.activeKey !== lifecycle.activePublicKeyHex ||
      task.activeKeyGeneration !== lifecycle.generation ||
      task.supplierGeneration !== supplierGeneration ||
      statusResource.status === "unavailable";
    if (!invalid) return;
    const hash = task.hash;
    abandonTask();
    setState({ phase: "cancelled", hash, stats: [] });
  }, [abandonTask, lifecycle.activePublicKeyHex, lifecycle.generation, statusResource.status, supplierGeneration, vault]);

  useEffect(() => () => abandonTask(), [abandonTask]);

  const configurationState = useMemo<"loading" | "unavailable" | "unconfigured" | "ready">(() => {
    if (vault !== "unlocked") return "unavailable";
    if (statusResource.status === "unavailable" || settingsError) return "unavailable";
    if (settingsLoading || !settingsSnapshot) return "loading";
    if (!settingsSnapshot.globalSettings || !settingsSnapshot.suppliers.some((supplier) => supplier.enabled)) return "unconfigured";
    return "ready";
  }, [settingsError, settingsLoading, settingsSnapshot, statusResource.status, vault]);

  const makeError = useCallback((cause: unknown): HomeError => {
    const code = cause instanceof FileAssemblyError ? "msfile_integrity_error" : errorCodeOf(cause) ?? "msfile_unavailable";
    return { code, message: displayErrorMessage(code, t) };
  }, [t]);

  const failTask = useCallback((task: FetchTask, cause: unknown) => {
    if (!isCurrent(task)) return;
    const error = makeError(cause);
    // 终态失败也必须释放已验证文件。尤其是 Blob 已创建但浏览器拒绝
    // `anchor.click()` 时，不能因为 task 仍挂在 ref 上而保留大文件引用。
    releaseTask(task);
    setState((previous) => ({ ...previous, phase: "failed", preview: undefined, progress: undefined, error, notice: undefined }));
  }, [isCurrent, makeError, releaseTask]);

  const createPreview = useCallback((selection: FileSelection, parts: readonly Uint8Array[]): PreviewState | undefined => {
    const firstBytes = firstMsFileBytes(parts);
    if (!hasMsFilePreviewSignature(selection.mediaType, firstBytes)) return undefined;
    switch (selection.previewDecision.kind) {
      case "text": {
        const text = decodeMsFileUtf8(parts);
        return text === undefined ? undefined : { kind: "text", text };
      }
      case "html": {
        const html = decodeMsFileUtf8(parts);
        if (html === undefined) return undefined;
        const url = createMsFileIsolatedHtmlBlobUrl(html);
        return url ? { kind: "html", url } : undefined;
      }
      case "pdf": {
        const url = createBlobUrl(parts, selection.mediaType);
        return url ? { kind: "pdf", url } : undefined;
      }
      case "image":
      case "audio":
      case "video": {
        const url = createBlobUrl(parts, selection.mediaType);
        return url ? { kind: selection.previewDecision.kind, url } : undefined;
      }
      default:
        return undefined;
    }
  }, []);

  const readFile = useCallback((task: FetchTask, intent: "preview" | "download"): Promise<void> => {
    if (task.readPromise) return task.readPromise;
    const run = async (): Promise<void> => {
      if (!isCurrent(task) || !task.selected) return;
      const selection = task.selected;
      if (!selection.previewDecision.canBlobDownload) return;
      try {
        setState((previous) => ({
          ...previous,
          phase: "seed-reading",
          error: undefined,
          notice: undefined,
          progress: {
            verifiedBlocks: 0,
            totalBlocks: 0,
            verifiedBytes: 0n,
            totalBytes: selection.fileSizeBytes,
          },
        }));
        const seedResponse = await service.readSeed({
          supplierPublicKeyHex: selection.supplierPublicKeyHex,
          seedHashHex: task.hash,
          signal: task.controller.signal,
        });
        if (!isCurrent(task)) return;
        const seedBytes = extractMsFileReadBytes(seedResponse, task.hash);
        const plan = parseSeedBlockPlan(seedBytes, selection.fileSizeBytes);
        task.plan = plan;
        if (!isCurrent(task)) return;
        setState((previous) => ({
          ...previous,
          phase: plan.blockCount === 0 ? "assembling" : "block-reading",
          progress: {
            verifiedBlocks: 0,
            totalBlocks: plan.blockCount,
            verifiedBytes: 0n,
            totalBytes: selection.fileSizeBytes,
          },
        }));
        const parts = await readMsFileBlocksWithWorkerPool(
          plan,
          (blockHashHex, signal) => service.readBlock({
            supplierPublicKeyHex: selection.supplierPublicKeyHex,
            blockHashHex,
            signal,
          }),
          {
            signal: task.controller.signal,
            onVerified: ({ verifiedBytes }) => {
              if (!isCurrent(task)) return;
              setState((previous) => {
                if (!isCurrent(task)) return previous;
                const progress = previous.progress ?? {
                  verifiedBlocks: 0,
                  totalBlocks: plan.blockCount,
                  verifiedBytes: 0n,
                  totalBytes: selection.fileSizeBytes,
                };
                return {
                  ...previous,
                  phase: "block-reading",
                  progress: {
                    ...progress,
                    verifiedBlocks: progress.verifiedBlocks + 1,
                    verifiedBytes: progress.verifiedBytes + BigInt(verifiedBytes),
                  },
                };
              });
            },
          },
        );
        if (!isCurrent(task)) return;
        setState((previous) => ({ ...previous, phase: "assembling" }));
        // worker pool 已验证每块；这里再按计划装配一次，确保最终总长度严格相等。
        const assembled = assembleMsFileParts(plan, parts);
        if (!isCurrent(task)) return;
        task.parts = assembled;
        const finalProgress: HomeProgress = {
          verifiedBlocks: plan.blockCount,
          totalBlocks: plan.blockCount,
          verifiedBytes: selection.fileSizeBytes,
          totalBytes: selection.fileSizeBytes,
        };
        if (intent === "preview") {
          const preview = createPreview(selection, assembled);
          if (!isCurrent(task)) return;
          if (preview) {
            task.previewUrl = preview.url;
            setState((previous) => ({ ...previous, phase: "preview-ready", preview, progress: finalProgress, error: undefined, notice: undefined }));
          } else {
            setState((previous) => ({
              ...previous,
              phase: "download-ready",
              preview: undefined,
              progress: finalProgress,
              notice: t("msfile.home.preview.unconfirmed", { defaultValue: "无法确认浏览器可安全解码该内容，已降级为下载。" }),
              error: undefined,
            }));
          }
        } else {
          setState((previous) => ({ ...previous, phase: "download-ready", progress: finalProgress, error: undefined }));
        }
      } catch (cause) {
        if (!isCurrent(task)) return;
        if (task.controller.signal.aborted || isAbortError(cause)) {
          setState((previous) => ({ ...previous, phase: "cancelled", preview: undefined, progress: undefined, error: undefined }));
        } else {
          failTask(task, cause);
        }
      }
    };
    task.readPromise = run();
    return task.readPromise;
  }, [createPreview, failTask, isCurrent, service, t]);

  const beginSelected = useCallback(async (task: FetchTask, selection: FileSelection): Promise<void> => {
    if (!isCurrent(task)) return;
    task.selected = selection;
    setState((previous) => ({
      ...previous,
      phase: "preview-decision",
      selected: selection,
      preview: undefined,
      progress: undefined,
      error: undefined,
      notice: messageForPreviewReason(selection, t),
    }));
    if (!selection.previewDecision.canBlobDownload || !selection.previewDecision.canAutoPreview) {
      if (isCurrent(task)) setState((previous) => ({ ...previous, phase: "ready-to-download" }));
      return;
    }
    await readFile(task, "preview");
  }, [isCurrent, readFile, t]);

  const submitQuery = useCallback(async () => {
    // 无论新输入是否合法，先取消并释放旧文件，保证“新查询覆盖旧查询”。
    abandonTask();
    setState({ phase: "validating", hash: seedHashDraft, stats: [] });
    const hash = seedHashDraft;
    if (!isValidMsFileHashHex(hash)) {
      setState({
        phase: "failed",
        hash,
        stats: [],
        error: { code: "msfile_invalid_hash", message: t("msfile.home.errors.invalidHash", { defaultValue: "Seed Hash 必须是 64 位小写十六进制字符。" }) },
      });
      return;
    }
    const activeKey = activeKeyRef.current;
    if (vaultRef.current !== "unlocked" || !activeKey) {
      setState({ phase: "failed", hash, stats: [], error: makeError({ code: "msfile_unavailable" }) });
      return;
    }
    if (configurationState !== "ready") {
      const code = configurationState === "unconfigured" ? "msfile_not_configured" : "msfile_unavailable";
      setState({ phase: "failed", hash, stats: [], error: makeError({ code }) });
      return;
    }
    const task: FetchTask = {
      id: ++taskSequenceRef.current,
      hash,
      activeKey,
      activeKeyGeneration: activeKeyGenerationRef.current,
      supplierGeneration: supplierGenerationRef.current,
      controller: new AbortController(),
      stats: [],
    };
    taskRef.current = task;
    setState({ phase: "stat-loading", hash, stats: [] });
    try {
      const result = await service.stat({ seedHashHex: hash, signal: task.controller.signal });
      if (!isCurrent(task)) return;
      const views = buildStatViews(result, settingsSnapshot, hash);
      task.stats = views;
      const candidates = views.map(candidateOf).filter((candidate): candidate is FileSelection => Boolean(candidate));
      if (candidates.length === 0) {
        setState({ phase: "supplier-selection", hash, stats: views, notice: t("msfile.home.noCandidate", { defaultValue: "当前没有供应商可以提供这个文件。" }) });
        return;
      }
      if (candidates.length === 1) {
        // 唯一候选会立即进入读取流程，但 Stat 结果仍要先写入状态，
        // 这样用户可以看到真实的供应商状态，而不是只看到文件预览。
        setState((previous) => ({ ...previous, stats: views }));
        await beginSelected(task, candidates[0]!);
      } else {
        setState({
          phase: "supplier-selection",
          hash,
          stats: views,
          notice: t("msfile.home.chooseSupplier", { defaultValue: "请选择一个供应商；Seed 与所有 Block 将固定使用同一供应商。" }),
        });
      }
    } catch (cause) {
      if (!isCurrent(task)) return;
      if (task.controller.signal.aborted || isAbortError(cause)) {
        setState({ phase: "cancelled", hash, stats: [] });
      } else {
        failTask(task, cause);
      }
    }
  }, [abandonTask, beginSelected, configurationState, failTask, isCurrent, makeError, seedHashDraft, service, settingsSnapshot, t]);

  const selectSupplier = useCallback((supplierPublicKeyHex: string) => {
    const task = taskRef.current;
    if (!task || !isCurrent(task)) return;
    const selection = task.stats.find((view) => view.entry.supplierPublicKeyHex === supplierPublicKeyHex)?.selection;
    if (!selection) return;
    void beginSelected(task, selection);
  }, [beginSelected, isCurrent]);

  const createDownloadUrl = useCallback((task: FetchTask): string | undefined => {
    if (task.downloadUrl) return task.downloadUrl;
    if (!task.selected || !task.parts) return undefined;
    const url = createBlobUrl(task.parts, task.selected.mediaType);
    if (url) task.downloadUrl = url;
    return url;
  }, []);

  const triggerDownload = useCallback((task: FetchTask): boolean => {
    if (!isCurrent(task) || !task.selected || !task.parts || typeof document === "undefined") return false;
    const url = createDownloadUrl(task);
    if (!url) return false;
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      // 本地 Blob 下载使用浏览器的 download 属性；没有伪造 HTTP header。
      anchor.download = task.selected.filename;
      anchor.click();
      return true;
    } catch {
      return false;
    }
  }, [createDownloadUrl, isCurrent]);

  const handleDownload = useCallback(() => {
    const task = taskRef.current;
    if (!task || !isCurrent(task) || !task.selected) return;
    if (!task.selected.previewDecision.canBlobDownload) {
      setState((previous) => ({ ...previous, phase: "ready-to-download", notice: t("msfile.home.download.tooLarge", { defaultValue: "超过 256 MiB 的文件需要后续流式下载支持，当前不会读取。" }) }));
      return;
    }
    if (task.parts) {
      if (!triggerDownload(task)) {
        failTask(task, { code: "msfile_download_error" });
      }
      return;
    }
    setState((previous) => ({ ...previous, phase: "downloading", error: undefined }));
    void readFile(task, "download").then(() => {
      if (!isCurrent(task) || !task.parts) return;
      if (!triggerDownload(task)) {
        failTask(task, { code: "msfile_download_error" });
      }
    });
  }, [failTask, isCurrent, readFile, t, triggerDownload]);

  const handlePreviewDecodeError = useCallback(() => {
    const task = taskRef.current;
    if (!task || !isCurrent(task)) return;
    if (task.previewUrl && task.previewUrl !== task.downloadUrl) revokeUrl(task.previewUrl);
    task.previewUrl = undefined;
    setState((previous) => ({
      ...previous,
      phase: "download-ready",
      preview: undefined,
      notice: t("msfile.home.preview.unconfirmed", { defaultValue: "浏览器无法确认该内容可安全解码，已降级为下载。" }),
    }));
  }, [isCurrent, revokeUrl, t]);

  const cancel = useCallback(() => {
    const hash = taskRef.current?.hash ?? state.hash;
    abandonTask();
    setState({ phase: "cancelled", hash, stats: [] });
  }, [abandonTask, state.hash]);

  const hasEnabledSupplier = settingsSnapshot?.suppliers.some((supplier) => supplier.enabled) ?? false;
  const busy = isBusyPhase(state.phase);
  const canSubmit = vault === "unlocked" && Boolean(lifecycle.activePublicKeyHex);
  const hasTaskResult = Boolean(taskRef.current) && state.phase !== "failed" && state.phase !== "cancelled";
  const candidateCount = state.stats.filter((view) => Boolean(view.selection)).length;
  const hasRetryableStat = state.stats.some((view) => view.entry.status === "discovering" || view.entry.status === "network-error");

  return (
    <section className="msfile-home-file" aria-labelledby="msfile-home-file-title">
      <header className="msfile-home-file__header">
        <div>
          <h3 id="msfile-home-file-title">{t("msfile.home.title", { defaultValue: "通过 Seed 获取文件" })}</h3>
          <p>{t("msfile.home.description", { defaultValue: "输入 Seed Hash，查询供应商并安全预览或下载原文件。" })}</p>
        </div>
        {hasTaskResult ? <Button variant="ghost" size="sm" onClick={cancel}>{t("msfile.home.cancel", { defaultValue: "取消" })}</Button> : null}
      </header>

      <form className="msfile-home-file__form" onSubmit={(event) => { event.preventDefault(); void submitQuery(); }}>
        <label htmlFor="msfile-home-seed-hash" className="msfile-home-file__label">
          {t("msfile.home.seedHash.label", { defaultValue: "Seed Hash" })}
        </label>
        <div className="msfile-home-file__input-row">
          <input
            id="msfile-home-seed-hash"
            className="msfile-home-file__input"
            value={seedHashDraft}
            onChange={(event) => setSeedHashDraft(event.target.value)}
            aria-describedby="msfile-home-seed-hash-hint"
            aria-invalid={state.error?.code === "msfile_invalid_hash"}
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
          />
          <Button type="submit" disabled={!canSubmit}>{busy ? t("msfile.home.querying", { defaultValue: "处理中…" }) : t("msfile.home.fetch", { defaultValue: "查询文件" })}</Button>
        </div>
        <p id="msfile-home-seed-hash-hint" className="msfile-home-file__hint">
          {t("msfile.home.seedHash.hint", { defaultValue: "只接受 64 位小写 hex；不会自动修改输入。" })}
        </p>
      </form>

      {configurationState === "loading" ? (
        <p className="msfile-home-file__notice">{t("msfile.home.config.loading", { defaultValue: "正在读取 MSFile 配置…" })}</p>
      ) : null}
      {configurationState === "unavailable" ? (
        <div className="msfile-home-file__notice" role="status">
          <p>{t("msfile.home.config.unavailable", { defaultValue: "MSFile 当前不可用，请稍后重试。" })}</p>
          <AppLink to="/settings/system">{t("msfile.home.settings", { defaultValue: "打开 MSFile 设置" })}</AppLink>
        </div>
      ) : null}
      {configurationState === "unconfigured" ? (
        <div className="msfile-home-file__notice" role="status">
          <p>{hasEnabledSupplier
            ? t("msfile.home.config.priceMissing", { defaultValue: "请先保存全局 Seed/Block 金额上限。" })
            : t("msfile.home.config.supplierMissing", { defaultValue: "请先启用至少一个供应商。" })}</p>
          <AppLink to="/settings/system">{t("msfile.home.settings", { defaultValue: "打开 MSFile 设置" })}</AppLink>
        </div>
      ) : null}

      {state.error ? (
        <p className="msfile-home-file__error" role="alert">
          {state.error.message} <span className="msfile-home-file__diagnostic">{t("msfile.home.diagnostic", { defaultValue: "诊断代码" })}: <code>{state.error.code}</code></span>
        </p>
      ) : null}
      {state.notice ? <p className="msfile-home-file__notice" role="status">{state.notice}</p> : null}

      {state.stats.length > 0 ? (
        <section className="msfile-home-file__suppliers" aria-labelledby="msfile-home-suppliers-title">
          <h4 id="msfile-home-suppliers-title">{t("msfile.home.suppliers", { defaultValue: "供应商结果" })}</h4>
          <ul>
            {state.stats.map((view) => (
              <li key={view.entry.supplierPublicKeyHex} className={view.selection ? "is-candidate" : ""}>
                <div className="msfile-home-file__supplier-head">
                  <strong>{view.supplierName}</strong>
                  <code title={view.entry.supplierPublicKeyHex}>{shortHex(view.entry.supplierPublicKeyHex)}</code>
                  <span className={`msfile-home-file__status msfile-home-file__status--${view.entry.status}`}>
                    {view.entry.status === "available" ? t("msfile.home.status.available", { defaultValue: "可获取" })
                      : view.entry.status === "quoted" ? t("msfile.home.status.quoted", { defaultValue: "有报价" })
                        : view.entry.status === "absent" ? t("msfile.home.status.absent", { defaultValue: "没有文件" })
                          : view.entry.status === "discovering" ? t("msfile.home.status.discovering", { defaultValue: "发现中" })
                            : t("msfile.home.status.networkError", { defaultValue: "暂时不可用" })}
                  </span>
                </div>
                {view.selection ? (
                  <>
                    <dl className="msfile-home-file__metadata">
                      <div><dt>{t("msfile.home.fileName", { defaultValue: "文件名" })}</dt><dd>{view.selection.filename}</dd></div>
                      <div><dt>{t("msfile.home.fileSize", { defaultValue: "文件大小" })}</dt><dd>{formatBytes(view.selection.fileSizeBytes)}</dd></div>
                      <div><dt>{t("msfile.home.mediaType", { defaultValue: "媒体类型" })}</dt><dd><code>{view.selection.mediaType || "(unknown)"}</code></dd></div>
                    </dl>
                    {view.entry.status === "quoted" ? (
                      <p className="msfile-home-file__quote">
                        {t("msfile.home.quote", { defaultValue: "报价" })}: Seed {view.entry.minSeedPriceSatoshis}–{view.entry.maxSeedPriceSatoshis} sats · Block {view.entry.minFullBlockPriceSatoshis}–{view.entry.maxFullBlockPriceSatoshis} sats
                      </p>
                    ) : null}
                    {candidateCount > 1 && state.phase === "supplier-selection" ? (
                      <Button size="sm" onClick={() => selectSupplier(view.entry.supplierPublicKeyHex)}>
                        {t("msfile.home.selectSupplier", { defaultValue: "选择此供应商" })}
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <p className="msfile-home-file__supplier-detail">
                    {view.entry.status === "discovering"
                      ? <>{t("msfile.home.discoveringDetail", { defaultValue: "供应商正在发现该 Seed，可稍后重试。" })} {t("msfile.home.discoveringRetry", { defaultValue: "可重试状态：约 {{ms}} ms 后重试。", ms: view.entry.retryAfterMs })}</>
                      : view.entry.status === "network-error"
                        ? t("msfile.home.networkDetail", { defaultValue: "供应商暂时不可用；这不是 absent。" })
                          : t("msfile.home.absentDetail", { defaultValue: "该供应商没有此文件。" })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state.selected ? (
        <section className="msfile-home-file__selected" aria-label={t("msfile.home.selectedFile", { defaultValue: "已选择文件" })}>
          <div className="msfile-home-file__selected-head">
            <strong>{state.selected.filename}</strong>
            <span>{state.selected.supplierName}</span>
          </div>
          {state.progress && (state.phase === "seed-reading" || state.phase === "block-reading" || state.phase === "assembling" || state.phase === "preview-ready" || state.phase === "download-ready") ? (
            <div className="msfile-home-file__progress" aria-live="polite">
              <span>{t("msfile.home.progress.blocks", { defaultValue: "已验证 Block：{{done}} / {{total}}", done: state.progress.verifiedBlocks, total: state.progress.totalBlocks })}</span>
              <span>{t("msfile.home.progress.bytes", { defaultValue: "已验证字节：{{done}} / {{total}}", done: formatBytes(state.progress.verifiedBytes), total: formatBytes(state.progress.totalBytes) })}</span>
            </div>
          ) : null}

          {state.preview?.kind === "text" ? (
            <pre className="msfile-home-file__text-preview" aria-label={t("msfile.home.preview.text", { defaultValue: "文本预览" })}>{state.preview.text}</pre>
          ) : null}
          {state.preview?.kind === "html" && state.preview.url ? (
            <div className="msfile-home-file__html-preview">
              <p className="msfile-home-file__safe-notice">{t("msfile.home.preview.htmlSafe", { defaultValue: "安全静态预览：脚本、网络、表单和导航已禁用。" })}</p>
              <iframe
                title={t("msfile.home.preview.htmlTitle", { defaultValue: "HTML 安全静态预览" })}
                src={state.preview.url}
                sandbox=""
                referrerPolicy="no-referrer"
              />
            </div>
          ) : null}
          {state.preview?.kind === "pdf" && state.preview.url ? (
            <iframe
              className="msfile-home-file__pdf-preview"
              title={t("msfile.home.preview.pdfTitle", { defaultValue: "PDF 预览" })}
              src={state.preview.url}
              sandbox=""
              referrerPolicy="no-referrer"
            />
          ) : null}
          {state.preview?.kind === "image" && state.preview.url ? (
            <img className="msfile-home-file__image-preview" src={state.preview.url} alt={state.selected.filename} onError={handlePreviewDecodeError} />
          ) : null}
          {state.preview?.kind === "audio" && state.preview.url ? (
            <audio className="msfile-home-file__media-preview" src={state.preview.url} controls onError={handlePreviewDecodeError} />
          ) : null}
          {state.preview?.kind === "video" && state.preview.url ? (
            <video className="msfile-home-file__media-preview" src={state.preview.url} controls onError={handlePreviewDecodeError} />
          ) : null}

          {(state.phase === "ready-to-download" || state.phase === "download-ready" || state.phase === "preview-ready") ? (
            <div className="msfile-home-file__actions">
              {state.selected.previewDecision.canBlobDownload ? (
                <Button onClick={handleDownload}>{t("msfile.home.download", { defaultValue: "下载" })}</Button>
              ) : null}
              {state.phase === "ready-to-download" && !state.selected.previewDecision.canBlobDownload ? (
                <p className="msfile-home-file__hint">{t("msfile.home.download.tooLarge", { defaultValue: "超过 256 MiB 的文件需要后续流式下载支持，当前不会读取。" })}</p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {state.phase === "cancelled" ? <p className="msfile-home-file__hint" role="status">{t("msfile.home.cancelled", { defaultValue: "文件获取已取消。" })}</p> : null}
      {state.hash && (state.phase === "failed" || (state.phase === "supplier-selection" && candidateCount === 0 && hasRetryableStat)) ? (
        <Button variant="secondary" onClick={() => void submitQuery()}>{t("msfile.home.retry", { defaultValue: "重试" })}</Button>
      ) : null}
    </section>
  );
}
