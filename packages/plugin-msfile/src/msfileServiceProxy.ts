// packages/plugin-msfile/src/msfileServiceProxy.ts
// 页面侧 facade：不拥有设置真值、K-V 或网络。所有控制/数据请求经
// Coordinator SharedWorker RPC；状态经 `msfile.state` topic 订阅。

import type {
  BorrowedModuleFileStore,
  CoordinatorMsFileControl,
  CoordinatorMsFileData,
  CoordinatorValueResult,
  MsFileApprovalDecision,
  MsFileBitfsDemandSnapshot,
  MsFileBitfsBuyerSettings,
  MsFileAppAuthorizationView,
  MsFileAppIdentityKey,
  MsFileAppPriceOverrideUpdate,
  MsFileCollectorConfig,
  MsFileCollectorConfigInput,
  MsFileCollectorStatus,
  MsFileConnectAppContext,
  MsFileErrorCode,
  MsFileGlobalPriceSettings,
  MsFileReadConcurrencySettings,
  MsFilePendingApprovalView,
  MsFileReadBlockInput,
  MsFileReadResult,
  MsFileReadSeedInput,
  MsFileSellerRuntimeStatus,
  MsFileSellerSettings,
  MsFileServiceStatus,
  MsFileSettingsSnapshot,
  MsFileStatInput,
  MsFileStatResult,
  MsFileSupplierConfig,
  MsFileSupplierProbeResult,
  MsFileCoordinatorControl,
} from "@keymaster/contracts";
import { MSFILE_LOCAL_SOURCE_ID, MSFILE_READ_CONCURRENCY_RECOMMENDED, MSFILE_SELLER_SETTINGS_DEFAULT, normalizeMsFileReadConcurrencySettings } from "@keymaster/contracts";
import type { MsFileService } from "@keymaster/contracts";
import { MsFileServiceError } from "./msfileErrors.js";

import { createMsFileLocalContentSource } from "./bitfs/localContentSource.js";
import { toArrayBuffer } from "./sha256.js";

type StateEvent = {
  topic: "msfile.state";
  sessionEpoch: string;
  status: MsFileServiceStatus;
  supplierGeneration: number;
  globalSettings: MsFileGlobalPriceSettings | null;
  mediaBlockReadConcurrency: number;
  globalSeedReadConcurrency: number;
  globalBlockReadConcurrency: number;
  globalStatConcurrency: number;
  sellerSettings: MsFileSellerSettings;
  sellerRuntimeStatus: MsFileSellerRuntimeStatus;
  pendingApprovals: MsFilePendingApprovalView[];
};

/** Stat 元数据在页面侧也做短 TTL 缓存，避免首页轮询反复穿越 RPC。 */
const MSFILE_STAT_PROXY_CACHE_TTL_MS = 5_000;
const MSFILE_STAT_PROXY_CACHE_MAX_ENTRIES = 256;

interface CachedStatResult {
  value: MsFileStatResult;
  expiresAt: number;
  sessionEpoch: string;
  supplierGeneration: number;
}

function cloneStatResult(value: MsFileStatResult): MsFileStatResult {
  return {
    seedHashHex: value.seedHashHex,
    sources: value.sources.map((entry) => ({ ...entry })),
  };
}

/**
 * 状态事件等价比较（含审批列表内容）。
 *
 * 页面资源（如 `msfile.status`）订阅代理并在通知时失效回读；如果代理对
 * 每个 topic 事件都无条件通知，冗余事件会变成“通知→回读→再广播”的
 * 死循环。只有内容变化才算一次新状态。
 */
function isSameStateEvent(a: StateEvent, b: StateEvent): boolean {
  return a.sessionEpoch === b.sessionEpoch
    && a.status === b.status
    && a.supplierGeneration === b.supplierGeneration
    && a.mediaBlockReadConcurrency === b.mediaBlockReadConcurrency
    && a.globalSeedReadConcurrency === b.globalSeedReadConcurrency
    && a.globalBlockReadConcurrency === b.globalBlockReadConcurrency
    && a.globalStatConcurrency === b.globalStatConcurrency
    && JSON.stringify(a.sellerSettings) === JSON.stringify(b.sellerSettings)
    && a.sellerRuntimeStatus === b.sellerRuntimeStatus
    && JSON.stringify(a.globalSettings) === JSON.stringify(b.globalSettings)
    && JSON.stringify(a.pendingApprovals) === JSON.stringify(b.pendingApprovals);
}

function unwrap<T>(result: CoordinatorValueResult<unknown>): Promise<T> {
  if (result.status === "ok") return Promise.resolve(result.value as T);
  if (result.status === "transport-error") {
    throw new MsFileServiceError("msfile_unavailable", result.message || "MSFile Coordinator request failed");
  }
  const code = "code" in result && typeof result.code === "string" ? (result.code as MsFileErrorCode) : undefined;
  const message = "message" in result && typeof result.message === "string" ? result.message : "MSFile Coordinator request failed";
  if (result.status === "locked" || result.status === "stale-epoch") {
    throw new MsFileServiceError("msfile_unavailable", message);
  }
  throw new MsFileServiceError(code ?? "msfile_unavailable", message);
}

export class MsFileServiceProxy implements MsFileService {
  #current: StateEvent = {
    topic: "msfile.state",
    sessionEpoch: "boot",
    status: "unavailable",
    supplierGeneration: 0,
    globalSettings: null,
    ...MSFILE_READ_CONCURRENCY_RECOMMENDED,
    sellerSettings: { ...MSFILE_SELLER_SETTINGS_DEFAULT, supportedArbiterPublicKeys: [] },
    sellerRuntimeStatus: "waiting-unlock",
    pendingApprovals: [],
  };
  readonly #listeners = new Set<() => void>();
  readonly #grants = new Map<string, Promise<string>>();
  readonly #statCache = new Map<string, CachedStatResult>();
  readonly #unsubscribeState: () => void;

  readonly #coordinator: MsFileCoordinatorControl;
  constructor(coordinator: MsFileCoordinatorControl) {
    this.#coordinator = coordinator;
    this.#unsubscribeState = coordinator.subscribeTopic("msfile.state", (event: StateEvent) => {
      if (event.sessionEpoch !== this.#current.sessionEpoch) {
        this.#grants.clear();
        this.#statCache.clear();
      }
      if (event.supplierGeneration !== this.#current.supplierGeneration) this.#statCache.clear();
      // 兼容旧 Worker 的 baseline：四项并发设置必须以完整快照进入页面。
      const concurrency = normalizeMsFileReadConcurrencySettings(event)
        ?? { ...MSFILE_READ_CONCURRENCY_RECOMMENDED };
      const next: StateEvent = {
        ...event,
        ...concurrency,
        // 缺少运行快照时使用初始状态，避免设置回读与
        // baseline 在 undefined/default 之间反复切换并触发通知循环。
        sellerSettings: event.sellerSettings ?? { ...MSFILE_SELLER_SETTINGS_DEFAULT, supportedArbiterPublicKeys: [] },
        sellerRuntimeStatus: event.sellerRuntimeStatus ?? "waiting-unlock",
      };
      const changed = !isSameStateEvent(this.#current, next);
      this.#current = next;
      // 变更驱动：内容相同的重复事件不得让资源订阅者失效回读。
      if (changed) {
        for (const listener of this.#listeners) listener();
      }
    });
  }

  status(): MsFileServiceStatus {
    return this.#current.status;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#unsubscribeState();
    this.#listeners.clear();
    this.#statCache.clear();
  }

  #control<T>(control: CoordinatorMsFileControl): Promise<T> {
    return this.#coordinator.msfileControl(control).then((result) => unwrap<T>(result));
  }

  /**
   * 配置读取也是状态同步边界：新页面可能先收到 Coordinator 的
   * `unconfigured` 基线，随后才按需启动 MSFile runtime。成功读取到当前
   * 快照后，代理必须立即反映同一份权威配置，不能依赖恰好到达的 topic
   * 事件来决定页面是否可用。
   */
  #applySettingsSnapshot(snapshot: MsFileSettingsSnapshot): void {
    const status: MsFileServiceStatus = snapshot.globalSettings || snapshot.suppliers.length > 0
      ? "ready"
      : "unconfigured";
    const next: StateEvent = {
      ...this.#current,
      status,
      supplierGeneration: snapshot.supplierGeneration,
      globalSettings: snapshot.globalSettings,
      mediaBlockReadConcurrency: snapshot.mediaBlockReadConcurrency,
      globalSeedReadConcurrency: snapshot.globalSeedReadConcurrency,
      globalBlockReadConcurrency: snapshot.globalBlockReadConcurrency,
      globalStatConcurrency: snapshot.globalStatConcurrency,
      sellerSettings: snapshot.sellerSettings,
      sellerRuntimeStatus: snapshot.sellerRuntimeStatus,
    };
    const changed = !isSameStateEvent(this.#current, next);
    this.#current = next;
    if (changed) {
      for (const listener of this.#listeners) listener();
    }
  }

  #grantFor(ctx: MsFileConnectAppContext): Promise<string> {
    const key = `${ctx.walletPublicKeyHex}|${ctx.bsvNetwork}|${ctx.transportOrigin}|${ctx.origin}`;
    const existing = this.#grants.get(key);
    if (existing) return existing;
    const pending = this.#coordinator
      .msfileGrant(ctx)
      .then((result) => unwrap<string>(result))
      .catch((error) => {
        this.#grants.delete(key);
        throw error;
      });
    this.#grants.set(key, pending);
    return pending;
  }

  async #dataFor<T>(
    ctx: MsFileConnectAppContext | null,
    build: (grantId?: string) => CoordinatorMsFileData,
    transfer: ArrayBuffer[] = [],
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) throw new MsFileServiceError("msfile_unavailable");
    if (ctx === null) {
      // 受信任内部插件：无 grant，直接走数据面（worker 只按全局额度执行）。
      return this.#coordinator.msfileData(build(undefined), transfer, signal).then((result) => unwrap<T>(result));
    }
    const grantId = await this.#grantFor(ctx);
    if (signal?.aborted) throw new MsFileServiceError("msfile_unavailable");
    return this.#coordinator.msfileData(build(grantId), transfer, signal).then((result) => unwrap<T>(result));
  }

  listBitfsArbitrations(): Promise<import("@keymaster/contracts").MsFileArbitrationTask[]> { return this.#control({ type: "bitfs.arbitration.list" }); }
  operateBitfsArbitration(sessionId: string, action: "submit" | "retrieve" | "check"): Promise<void> { return this.#control({ type: "bitfs.arbitration.operate", sessionId, action }).then(() => undefined); }

  async getSettingsSnapshot(): Promise<MsFileSettingsSnapshot> {
    const snapshot = await this.#control<MsFileSettingsSnapshot>({ type: "settings.get" });
    this.#applySettingsSnapshot(snapshot);
    return snapshot;
  }

  getReadConcurrencySettings(): Promise<MsFileReadConcurrencySettings> {
    return this.#control<MsFileReadConcurrencySettings>({ type: "settings.readConcurrency.get" });
  }

  updateReadConcurrencySettings(input: MsFileReadConcurrencySettings): Promise<void> {
    return this.#control({ type: "settings.readConcurrency.update", input }).then(() => undefined);
  }

  resetReadConcurrencySettings(): Promise<void> {
    return this.#control({ type: "settings.readConcurrency.reset" }).then(() => undefined);
  }

  updateGlobalPriceSettings(input: MsFileGlobalPriceSettings): Promise<void> {
    return this.#control({ type: "settings.global.update", input }).then(() => undefined);
  }

  updateSellerSettings(input: MsFileSellerSettings): Promise<void> {
    return this.#control({ type: "settings.seller.update", input }).then(() => undefined);
  }

  /** 读取 Worker 持久化的 BitFS 自动购买策略。 */
  getBitfsBuyerSettings(): Promise<MsFileBitfsBuyerSettings> {
    return this.#control({ type: "settings.bitfsBuyer.get" });
  }

  /** 读取采集提交配置（地址、启用开关）。 */
  getCollectorConfig(): Promise<MsFileCollectorConfig> {
    return this.#control<MsFileCollectorConfig>({ type: "collector.config.get" });
  }

  /** 保存采集提交配置；首次启用会补齐已有完整文件。 */
  updateCollectorConfig(input: MsFileCollectorConfigInput): Promise<void> {
    return this.#control({ type: "collector.config.update", input }).then(() => undefined);
  }

  /** 读取采集提交状态摘要。 */
  getCollectorStatus(): Promise<MsFileCollectorStatus> {
    return this.#control<MsFileCollectorStatus>({ type: "collector.status" });
  }

  /** 保存 Worker 持久化的 BitFS 自动购买策略。 */
  updateBitfsBuyerSettings(input: MsFileBitfsBuyerSettings): Promise<void> {
    return this.#control({ type: "settings.bitfsBuyer.update", input }).then(() => undefined);
  }

  upsertSupplier(input: unknown): Promise<void> {
    return this.#control({
      type: "supplier.upsert",
      supplier: input as MsFileSupplierConfig,
      expectedGeneration: this.#current.supplierGeneration,
    }).then(() => undefined);
  }

  deleteSupplier(supplierPublicKeyHex: string): Promise<void> {
    return this.#control({ type: "supplier.delete", supplierPublicKeyHex, expectedGeneration: this.#current.supplierGeneration }).then(() => undefined);
  }

  probeSupplier(supplierPublicKeyHex: string, signal?: AbortSignal): Promise<MsFileSupplierProbeResult> {
    if (signal?.aborted) return Promise.reject(new MsFileServiceError("msfile_unavailable"));
    return this.#control<MsFileSupplierProbeResult>({ type: "supplier.probe", supplierPublicKeyHex });
  }

  updateAppPriceOverride(input: MsFileAppPriceOverrideUpdate): Promise<void> {
    return this.#control({ type: "app-policy.update", input }).then(() => undefined);
  }

  clearAppPriceOverride(key: MsFileAppIdentityKey): Promise<void> {
    return this.#control({ type: "app-policy.clear", key }).then(() => undefined);
  }

  listAppAuthorizations(): Promise<MsFileAppAuthorizationView[]> {
    return this.#control<MsFileAppAuthorizationView[]>({ type: "app-authorizations.list" });
  }

  listPendingApprovals(): MsFilePendingApprovalView[] {
    return this.#current.pendingApprovals;
  }

  resolveApproval(approvalId: string, decision: MsFileApprovalDecision): Promise<void> {
    return this.#control({ type: "approval.resolve", approvalId, decision }).then(() => undefined);
  }

  private pageContent?: ReturnType<typeof createMsFileLocalContentSource>;

  usePageContent(store: BorrowedModuleFileStore): void {
    this.pageContent = createMsFileLocalContentSource(store, {
      onReadFailure: seedHashHex => this.#statCache.delete(seedHashHex),
    });
  }

  buyer?: Pick<MsFileService, "publishBitfsDemand" | "resumeBitfsDownload" | "getBitfsDemand" | "startBitfsPurchase" | "cancelBitfsPurchase" | "cancelBitfsDemand">;

  publishBitfsDemand(seedHashHex: string): Promise<MsFileBitfsDemandSnapshot> {
    return this.buyer?.publishBitfsDemand?.(seedHashHex) ?? Promise.reject(new Error("下载页面不可用"));
  }

  resumeBitfsDownload(seedHashHex: string): Promise<MsFileBitfsDemandSnapshot> {
    return this.buyer?.resumeBitfsDownload?.(seedHashHex) ?? Promise.reject(new Error("下载页面不可用"));
  }

  getBitfsDemand(seedHashHex: string): Promise<MsFileBitfsDemandSnapshot> {
    return this.buyer?.getBitfsDemand?.(seedHashHex) ?? this.#control({ type: "bitfs.demand.snapshot", seedHashHex });
  }

  startBitfsPurchase(seedHashHex: string, sessionId: string, maxFullBlockPriceSatoshis?: string): Promise<MsFileBitfsDemandSnapshot> {
    return this.buyer?.startBitfsPurchase?.(seedHashHex, sessionId, maxFullBlockPriceSatoshis) ?? Promise.reject(new Error("下载页面不可用"));
  }

  cancelBitfsPurchase(seedHashHex: string, sessionId: string): Promise<MsFileBitfsDemandSnapshot> {
    return this.buyer?.cancelBitfsPurchase?.(seedHashHex, sessionId) ?? Promise.reject(new Error("下载页面不可用"));
  }

  cancelBitfsDemand(seedHashHex: string): Promise<void> {
    return this.buyer?.cancelBitfsDemand?.(seedHashHex) ?? Promise.resolve();
  }

  abortSession(walletPublicKeyHex: string): Promise<void> {
    for (const key of [...this.#grants.keys()]) {
      if (key.startsWith(`${walletPublicKeyHex}|`)) this.#grants.delete(key);
    }
    return this.#coordinator.msfileSessionAbort(walletPublicKeyHex).then((result) => {
      if (result.status !== "ok" && result.status !== "accepted") throw new MsFileServiceError("msfile_unavailable");
    });
  }

  stat(input: MsFileStatInput): Promise<MsFileStatResult> {
    if (input.signal?.aborted) return Promise.reject(new MsFileServiceError("msfile_unavailable"));
    const sessionEpoch = this.#current.sessionEpoch;
    const supplierGeneration = this.#current.supplierGeneration;
    const cached = this.#statCache.get(input.seedHashHex);
    if (
      cached
      && cached.expiresAt > Date.now()
      && cached.sessionEpoch === sessionEpoch
      && cached.supplierGeneration === supplierGeneration
    ) {
      return Promise.resolve(cloneStatResult(cached.value));
    }
    if (cached) this.#statCache.delete(input.seedHashHex);
    return this.#dataFor<MsFileStatResult>(null, () => ({ type: "stat", seedHashHex: input.seedHashHex }), [], input.signal)
      .then((result) => {
        if (!result.sources.some((entry) => entry.status === "network-error")
          && this.#current.sessionEpoch === sessionEpoch
          && this.#current.supplierGeneration === supplierGeneration) {
          this.#statCache.set(input.seedHashHex, {
            value: cloneStatResult(result),
            expiresAt: Date.now() + MSFILE_STAT_PROXY_CACHE_TTL_MS,
            sessionEpoch,
            supplierGeneration,
          });
          while (this.#statCache.size > MSFILE_STAT_PROXY_CACHE_MAX_ENTRIES) {
            const oldest = this.#statCache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.#statCache.delete(oldest);
          }
        }
        return result;
      });
  }

  readSeed(input: MsFileReadSeedInput): Promise<MsFileReadResult> {
    if (input.sourceId === MSFILE_LOCAL_SOURCE_ID && this.pageContent) {
      return this.pageContent.readSeed(input.seedHashHex, input.signal).then(content => ({
        contentHashHex: input.seedHashHex, content: { $type: "binary", bytes: toArrayBuffer(content) },
      }));
    }
    return this.#dataFor<MsFileReadResult>(
      null,
      () => ({ type: "read-seed", sourceId: input.sourceId, seedHashHex: input.seedHashHex }),
      [],
      input.signal
    );
  }

  readBlock(input: MsFileReadBlockInput): Promise<MsFileReadResult> {
    if (input.sourceId === MSFILE_LOCAL_SOURCE_ID && this.pageContent) {
      return this.pageContent.readBlock(input.seedHashHex, input.blockHashHex, input.signal).then(content => ({
        contentHashHex: input.blockHashHex, content: { $type: "binary", bytes: toArrayBuffer(content) },
      }));
    }
    return this.#dataFor<MsFileReadResult>(
      null,
      () => ({ type: "read-block", sourceId: input.sourceId, seedHashHex: input.seedHashHex, blockHashHex: input.blockHashHex }),
      [],
      input.signal
    );
  }

  readonly connect = {
    stat: (ctx: MsFileConnectAppContext, input: { seedHashHex: string; signal?: AbortSignal }): Promise<MsFileStatResult> =>
      this.#dataFor<MsFileStatResult>(ctx, (grantId) => ({ type: "stat", grantId, seedHashHex: input.seedHashHex }), [], input.signal),
    readSeed: (
      ctx: MsFileConnectAppContext,
      input: { sourceId: string; seedHashHex: string; signal?: AbortSignal }
    ): Promise<MsFileReadResult> =>
      this.#dataFor<MsFileReadResult>(
        ctx,
        (grantId) => ({ type: "read-seed", grantId, sourceId: input.sourceId, seedHashHex: input.seedHashHex }),
        [],
        input.signal
      ),
    readBlock: (
      ctx: MsFileConnectAppContext,
      input: { sourceId: string; seedHashHex: string; blockHashHex: string; signal?: AbortSignal }
    ): Promise<MsFileReadResult> =>
      this.#dataFor<MsFileReadResult>(
        ctx,
        (grantId) => ({ type: "read-block", grantId, sourceId: input.sourceId, seedHashHex: input.seedHashHex, blockHashHex: input.blockHashHex }),
        [],
        input.signal
      ),
  };
}
