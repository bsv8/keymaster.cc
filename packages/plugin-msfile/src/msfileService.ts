// packages/plugin-msfile/src/msfileService.ts
// 受信任 `msfile.service` 实现（施工单 KMMF-005 / KMMF-006）。
//
// 边界：
//   - trusted stat/readSeed/readBlock 只使用全局额度；全局额度由 Coordinator
//     的有界公平队列执行，服务本身不把设置解释为金额预算；
//     不进入确认流程；
//   - connect gateway 按 (owner, publisher, appId) 解析 override ?? global；
//   - 一次 Connect 调用最多进入一次确认；重新发送仍超额返回稳定错误；
//   - "仅本次"不落库；"始终"只更新对应 Seed/Block 字段。

import type {
  MsFileApprovalDecision,
  MsFileAppAuthorizationView,
  MsFilePendingApprovalView,
  MsFileAppIdentityKey,
  MsFileAppPriceOverrideUpdate,
  MsFileConnectAppContext,
  MsFileContentKind,
  MsFileGlobalPriceSettings,
  MsFileReadConcurrencySettings,
  MsFilePendingApproval,
  MsFileReadBlockInput,
  MsFileReadResult,
  MsFileReadSeedInput,
  MsFileServiceStatus,
  MsFileSettingsSnapshot,
  MsFileStatInput,
  MsFileStatResult,
  MsFileSupplierConfig,
  MsFileSupplierProbeResult,
} from "@keymaster/contracts";
import {
  MSFILE_READ_CONCURRENCY_RECOMMENDED,
  MSFILE_MAX_BLOCK_BYTES,
  MSFILE_MAX_SEED_BYTES,
  isValidMsFileHashHex,
  isValidMsFileSupplierPublicKeyHex,
  msFileSatoshiAmountToBigInt,
  msFileAppPolicyKeyString,
  normalizeMsFileReadConcurrencySettings,
  type MsFileService,
} from "@keymaster/contracts";
import { openMsFileDb, sanitizeAppOverride, type MsFileDb } from "./msfileDb.js";
import { MsFileServiceError } from "./msfileErrors.js";
import { validateBlockContent, validateSeedContent } from "./contentValidation.js";
import { toArrayBuffer } from "./sha256.js";
import { createUnavailableMsFileTransport, type MsFileTransport } from "./msfileTransport.js";

export interface MsFileServiceImplDeps {
  db?: MsFileDb;
  transport?: MsFileTransport;
  now?(): number;
  randomId?(): string;
  notifyStateChange?(state: MsFileServiceEventState): void;
  /** 测试接缝：替换 supplierConfig 动态导入，用于挂起地址校验构造异步窗口。 */
  validatorLoader?: () => Promise<Pick<typeof import("./supplierConfig.js"), "validatePersistedSupplier">>;
}

export interface MsFileServiceEventState {
  status: MsFileServiceStatus;
  supplierGeneration: number;
  globalSettings: MsFileGlobalPriceSettings | null;
  /** 单个媒体 Session 的 Block 读取并发数。 */
  mediaBlockReadConcurrency: number;
  /** 整个 Keymaster 的 Seed 读取并发数。 */
  globalSeedReadConcurrency: number;
  /** 整个 Keymaster 的 Block 读取并发数。 */
  globalBlockReadConcurrency: number;
  /** 整个 Keymaster 的 Stat 并发数。 */
  globalStatConcurrency: number;
  pendingApprovals: MsFilePendingApprovalView[];
}

interface PendingApprovalEntry {
  record: MsFilePendingApproval;
  resolve(decision: MsFileApprovalDecision): void;
  reject(error: Error): void;
}

const DEFAULT_NOW = () => Date.now();
const DEFAULT_RANDOM_ID = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;

export class MsFileServiceImpl implements MsFileService {  private readonly db: Promise<MsFileDb>;
  private readonly transport: MsFileTransport;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly notifyStateChange: ((state: MsFileServiceEventState) => void) | undefined;

  private readonly listeners = new Set<() => void>();
  private readonly approvals = new Map<string, PendingApprovalEntry>();
  /**
   * supplier 数据面栅栏版本号（审查修复）：任何 barrier 转变（set/clear/
   * failed）都递增。数据请求在入口捕获，在每次 await 之后、调用 transport
   * 之前、transport 返回与内容校验之后复核——异步校验期间发生的 mutation
   * 一律使该请求作废。
   */
  private supplierFence = 0;
  /** 初始化失败信息；status() 据此报告 unavailable（而非 unconfigured）。 */
  private initializationError: unknown;
  /**
   * 最近一次成功 Stat 的 file_size_bytes（审查修复）：
   * Read Seed 时传给内容校验执行精确 Seed 长度检查。
   * 键为 supplier|seedHash；供应商配置世代变化时整体失效。
   */
  private readonly statFileSizeBySupplierSeed = new Map<string, string>();
  private supplierGeneration = 0;
  /**
   * 原子供应商快照（审查修复）：{ generation, suppliers } 整体替换，
   * 数据面只消费同一快照，杜绝“DB 读旧列表 + 标新 generation”的窗口。
   */
  private supplierSnapshot: { generation: number; suppliers: MsFileSupplierConfig[] } = { generation: 0, suppliers: [] };
  /**
   * 供应商 mutation barrier（审查修复）：mutation 开始时立即标记，
   * 数据面（stat/read）对被标记供应商拒绝；invalidation 失败后保持
   * failed 标记，该供应商数据面持续禁用直到重新保存成功。
   */
  private readonly supplierBarriers = new Map<string, { failed: boolean }>();
  private cachedSettings: MsFileGlobalSettingsSnapshotLike = {
    settings: null,
    ...MSFILE_READ_CONCURRENCY_RECOMMENDED,
  };
  private cachedSuppliers: MsFileSupplierConfig[] = [];
  private disposed = false;

  constructor(deps: MsFileServiceImplDeps = {}) {
    this.db = deps.db ? Promise.resolve(deps.db) : openMsFileDb();
    this.transport = deps.transport ?? createUnavailableMsFileTransport();
    this.now = deps.now ?? DEFAULT_NOW;
    this.randomId = deps.randomId ?? DEFAULT_RANDOM_ID;
    this.notifyStateChange = deps.notifyStateChange;
    this.validatorLoader = deps.validatorLoader ?? (() => import("./supplierConfig.js"));
    // 审查修复（P1）：所有公开方法先等待初始化完成，杜绝“重启后立即 stat
    // 误报无供应商”与“迟到 refresh 覆盖 mutation 已发布快照”。
    this.ready = this.refreshCaches();
  }

  private readonly validatorLoader: () => Promise<Pick<typeof import("./supplierConfig.js"), "validatePersistedSupplier">>;

  private readonly ready: Promise<void>;

  /**
   * 公开 control/data 方法的初始化与生命周期栅栏。
   * 初始化失败（DB 打不开等）永久 fail closed：调用方必须重建服务
   * （Coordinator 在 lock/unlock 周期中天然重建）。
   */
  private async ensureReady(): Promise<void> {
    if (this.disposed) throw new MsFileServiceError("msfile_unavailable", "MSFile service was disposed");
    await this.ready;
    if (this.disposed) {
      throw new MsFileServiceError("msfile_unavailable", "MSFile service was disposed");
    }
    if (this.initializationError) {
      throw new MsFileServiceError("msfile_unavailable", "MSFile failed to initialize its configuration store");
    }
  }

  /* ============== 状态与订阅 ============== */

  status(): MsFileServiceStatus {
    if (this.disposed || !this.transport.available || this.initializationError) return "unavailable";
    if (!this.cachedSettings.settings && this.cachedSuppliers.length === 0) return "unconfigured";
    return "ready";
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    // 审查修复：同步推进数据面栅栏——悬挂在任意 await 上的 read/stat/probe
    // 恢复后都会因 fence 变化被拒，不再触碰已释放的 transport。
    this.supplierFence += 1;
    this.disposed = true;
    this.supplierBarriers.clear();
    for (const [, entry] of [...this.approvals]) {
      entry.reject(new MsFileServiceError("user_rejected", "MSFile service was disposed"));
    }
    this.approvals.clear();
    this.transport.dispose();
    void this.db.then((db) => db.close()).catch(() => undefined);
    this.listeners.clear();
  }

  describeState(): MsFileServiceEventState {
    return {
      status: this.status(),
      supplierGeneration: this.supplierGeneration,
      globalSettings: this.cachedSettings.settings,
      mediaBlockReadConcurrency: this.cachedSettings.mediaBlockReadConcurrency,
      globalSeedReadConcurrency: this.cachedSettings.globalSeedReadConcurrency,
      globalBlockReadConcurrency: this.cachedSettings.globalBlockReadConcurrency,
      globalStatConcurrency: this.cachedSettings.globalStatConcurrency,
      pendingApprovals: this.pendingApprovalViews(),
    };
  }

  private emit(): void {
    const state = this.describeState();
    this.notifyStateChange?.(state);
    for (const listener of this.listeners) listener();
  }

  private async refreshCaches(): Promise<void> {
    try {
      const generationAtStart = this.supplierGeneration;
      const db = await this.db;
      const [settingsRow, suppliers] = await Promise.all([db.getGlobalSettings(), db.listSuppliers()]);
      // CAS 提交（审查修复）：等待期间若发生 mutation（世代已推进），
      // 本次迟到 refresh 不得覆盖 mutation 发布的新快照。
      if (this.supplierGeneration !== generationAtStart) return;
      this.cachedSettings = settingsRow
        ? canonicalSettingsRow(settingsRow)
        : { settings: null, ...MSFILE_READ_CONCURRENCY_RECOMMENDED };
      this.supplierSnapshot = { generation: generationAtStart, suppliers };
      this.cachedSuppliers = suppliers;
      this.emit();
    } catch (error) {
      // DB 打不开时保持 fail closed 快照，并让 status() 明确报告 unavailable。
      this.initializationError = error;
    }
  }

  /* ============== 设置控制面 ============== */

  async getSettingsSnapshot(): Promise<MsFileSettingsSnapshot> {
    await this.ensureReady();
    const db = await this.db;
    const row = await db.getGlobalSettings();
    const suppliers = await db.listSuppliers();
    this.cachedSettings = row
      ? canonicalSettingsRow(row)
      : { settings: null, ...MSFILE_READ_CONCURRENCY_RECOMMENDED };
    this.cachedSuppliers = suppliers;
    return {
      globalSettings: row?.settings ?? null,
      ...readConcurrencyFromRow(row),
      suppliers,
      supplierGeneration: this.supplierGeneration,
    };
  }

  async getReadConcurrencySettings(): Promise<MsFileReadConcurrencySettings> {
    await this.ensureReady();
    const row = await (await this.db).getGlobalSettings();
    const settings = readConcurrencyFromRow(row);
    this.cachedSettings = {
      ...(row ? canonicalSettingsRow(row) : this.cachedSettings),
      ...settings,
    };
    return settings;
  }

  async updateReadConcurrencySettings(input: MsFileReadConcurrencySettings): Promise<void> {
    await this.ensureReady();
    const settings = normalizeMsFileReadConcurrencySettings(input);
    if (!settings) assertReadConcurrencySettings(input);
    const updatedAt = this.now();
    await (await this.db).putReadConcurrencySettings(settings!, updatedAt);
    this.cachedSettings = {
      settings: this.cachedSettings.settings,
      ...settings!,
      updatedAt,
    };
    this.emit();
  }

  async resetReadConcurrencySettings(): Promise<void> {
    await this.updateReadConcurrencySettings({ ...MSFILE_READ_CONCURRENCY_RECOMMENDED });
  }

  async getMediaBlockReadConcurrency(): Promise<number> {
    return (await this.getReadConcurrencySettings()).mediaBlockReadConcurrency;
  }

  async updateGlobalPriceSettings(input: MsFileGlobalPriceSettings): Promise<void> {
    await this.ensureReady();
    assertAmount(input?.seedMaxPriceSatoshis, "seedMaxPriceSatoshis");
    assertAmount(input?.blockMaxPriceSatoshis, "blockMaxPriceSatoshis");
    const db = await this.db;
    const updatedAt = this.now();
    await db.putGlobalSettings(
      { seedMaxPriceSatoshis: input.seedMaxPriceSatoshis, blockMaxPriceSatoshis: input.blockMaxPriceSatoshis },
      updatedAt,
    );
    this.cachedSettings = {
      settings: { ...input },
      mediaBlockReadConcurrency: this.cachedSettings.mediaBlockReadConcurrency,
      globalSeedReadConcurrency: this.cachedSettings.globalSeedReadConcurrency,
      globalBlockReadConcurrency: this.cachedSettings.globalBlockReadConcurrency,
      globalStatConcurrency: this.cachedSettings.globalStatConcurrency,
      updatedAt,
    };
    this.emit();
  }

  async updateMediaBlockReadConcurrency(value: number): Promise<void> {
    const current = await this.getReadConcurrencySettings();
    await this.updateReadConcurrencySettings({ ...current, mediaBlockReadConcurrency: value });
  }

  async upsertSupplier(input: unknown): Promise<void> {
    await this.ensureReady();
    // 惰性加载：multiaddr/libp2p 依赖只被设置页控制面需要，
    // 不进入 Worker 初始模块图（生产 Runtime 就绪前数据面 fail closed）。
    const { normalizeSupplierDraft } = await import("./supplierConfig.js");
    const normalized = normalizeSupplierDraft(input);
    if (!normalized.ok) throw new Error(`invalid supplier config: ${normalized.failure.message}`);
    const key = normalized.config.supplierPublicKeyHex;
    // 显式状态机：idle → mutating(pre-commit) → committed-invalidating → ready | failed。
    // 保存 previousBarrier：pre-commit 失败时恢复原状（含既有 failed 隔离）。
    const previousBarrier = this.supplierBarriers.get(key);
    this.setBarrier(key, { failed: false });
    let committed = false;
    try {
      const db = await this.db;
      await db.upsertSupplier(normalized.config);
      // ---- DB 已提交；以下不得再有任何 await 直到世代/快照推进 ----
      committed = true;
      const nextList = [
        ...this.supplierSnapshot.suppliers.filter((entry) => entry.supplierPublicKeyHex !== key),
        normalized.config
      ];
      this.supplierGeneration += 1;
      this.statFileSizeBySupplierSeed.clear();
      this.supplierSnapshot = { generation: this.supplierGeneration, suppliers: nextList };
      this.cachedSuppliers = nextList;
      // ---- fencing 完成；等待旧连接关闭 ----
      let cleanupError: unknown;
      try {
        await this.transport.invalidateSupplier(key, this.supplierGeneration);
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError) {
        this.setBarrier(key, { failed: true });
        this.emit();
        throw new Error("MSFile supplier configuration was saved, but closing previous connections failed");
      }
      this.setBarrier(key, undefined);
      this.emit();
    } catch (error) {
      if (!committed) {
        // pre-commit 失败：DB 未变化，恢复原 barrier 状态（可能是 failed 隔离）。
        this.setBarrier(key, previousBarrier ?? undefined);
        this.emit();
      } else if (!(error instanceof Error) || !/closing previous connections failed/.test(error.message)) {
        // committed 后的意外错误：必须保持隔离，不能放行旧连接。
        this.setBarrier(key, { failed: true });
        this.emit();
      }
      throw error;
    }
  }

  async deleteSupplier(supplierPublicKeyHex: string): Promise<void> {
    await this.ensureReady();
    assertSupplierKey(supplierPublicKeyHex);
    const key = supplierPublicKeyHex;
    const previousBarrier = this.supplierBarriers.get(key);
    this.setBarrier(key, { failed: false });
    let committed = false;
    try {
      const db = await this.db;
      await db.deleteSupplier(key);
      // ---- DB 已提交；同步推进世代与快照（无 await 窗口）----
      committed = true;
      const nextList = this.supplierSnapshot.suppliers.filter((entry) => entry.supplierPublicKeyHex !== key);
      this.supplierGeneration += 1;
      this.statFileSizeBySupplierSeed.clear();
      this.supplierSnapshot = { generation: this.supplierGeneration, suppliers: nextList };
      this.cachedSuppliers = nextList;
      let cleanupError: unknown;
      try {
        await this.transport.invalidateSupplier(key, this.supplierGeneration);
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError) {
        this.setBarrier(key, { failed: true });
        this.emit();
        throw new Error("MSFile supplier configuration was saved, but closing previous connections failed");
      }
      this.setBarrier(key, undefined);
      this.emit();
    } catch (error) {
      if (!committed) {
        this.setBarrier(key, previousBarrier ?? undefined);
        this.emit();
      } else if (!(error instanceof Error) || !/closing previous connections failed/.test(error.message)) {
        this.setBarrier(key, { failed: true });
        this.emit();
      }
      throw error;
    }
  }

  async probeSupplier(supplierPublicKeyHex: string, signal?: AbortSignal): Promise<MsFileSupplierProbeResult> {
    await this.ensureReady();
    assertSupplierKey(supplierPublicKeyHex);
    const db = await this.db;
    const supplierGenerationAtStart = this.supplierGeneration;
    const fenceAtStart = this.supplierFence;
    // barrier：mutation 窗口内不拨号（审查修复）。
    this.assertNotInvalidating(supplierPublicKeyHex);
    const supplier = await db.getSupplier(supplierPublicKeyHex);
    if (!supplier) throw new MsFileServiceError("msfile_supplier_not_found");
    if (!supplier.enabled) throw new MsFileServiceError("msfile_supplier_disabled");
    // 与 stat/read 同源的持久化地址严格校验（审查修复）。
    const validated = await this.strictlyValidated([supplier]);
    if (validated.length === 0) {
      throw new MsFileServiceError("msfile_supplier_not_found", "persisted supplier config is invalid");
    }
    // 异步校验之后、拨号之前复核栅栏。
    if (this.supplierFence !== fenceAtStart || this.supplierGeneration !== supplierGenerationAtStart) {
      throw new MsFileServiceError("msfile_unavailable", "MSFile supplier configuration changed during probe");
    }
    // 测试连接只拨号 + 协商 + pin，不发送 Read、不产生购买。
    const result = await this.transport.probe({ supplier: validated[0]!, supplierGeneration: supplierGenerationAtStart, signal });
    if (this.supplierFence !== fenceAtStart || this.supplierGeneration !== supplierGenerationAtStart) {
      throw new MsFileServiceError("msfile_unavailable", "MSFile supplier configuration changed during probe");
    }
    return result;
  }

  async updateAppPriceOverride(input: MsFileAppPriceOverrideUpdate): Promise<void> {
    await this.ensureReady();
    assertAppKey(input?.key);
    const override = sanitizeAppOverride(input.override);
    if (override === undefined) throw new Error("override must contain at least one canonical amount field");
    const db = await this.db;
    if (!override.seedMaxPriceSatoshis && !override.blockMaxPriceSatoshis) {
      await db.deleteAppPolicy(input.key);
      this.emit();
      return;
    }
    await db.putAppPolicy({
      policyKey: msFileAppPolicyKeyString(input.key),
      key: input.key,
      override,
      updatedAt: this.now(),
    });
    this.emit();
  }

  async clearAppPriceOverride(key: MsFileAppIdentityKey): Promise<void> {
    await this.ensureReady();
    assertAppKey(key);
    const db = await this.db;
    await db.deleteAppPolicy(key);
    this.emit();
  }

  async listAppAuthorizations(): Promise<MsFileAppAuthorizationView[]> {
    await this.ensureReady();
    const db = await this.db;
    const usages = await db.listAppUsages();
    const policies = new Map((await db.listAppPolicies()).map((row) => [row.policyKey, row]));
    return usages.map((usage) => ({
      key: usage.key,
      appName: usage.appName,
      firstSeenAt: usage.firstSeenAt,
      lastSeenAt: usage.lastSeenAt,
      policy: policies.get(msFileAppPolicyKeyString(usage.key)) ?? null,
    }));
  }

  /* ============== 超额确认 ============== */

  listPendingApprovals(): MsFilePendingApprovalView[] {
    return this.pendingApprovalViews();
  }

  /** 广播用脱敏投影：不携带完整 owner/publisher/supplier/hash/session id。 */
  private pendingApprovalViews(): MsFilePendingApprovalView[] {
    return [...this.approvals.values()].map(({ record }) => ({
      approvalId: record.approvalId,
      createdAt: record.createdAt,
      appName: record.appName,
      appId: record.appId,
      publisherHint: record.publisherPublicKeyHex.slice(0, 10),
      supplierHint: record.supplierPublicKeyHex.slice(0, 10),
      contentHashHint: record.contentHashHex.slice(0, 16),
      kind: record.kind,
      effectiveMaxPriceSatoshis: record.effectiveMaxPriceSatoshis,
    }));
  }

  async resolveApproval(approvalId: string, decision: MsFileApprovalDecision): Promise<void> {
    await this.ensureReady();
    const entry = this.approvals.get(approvalId);
    if (!entry) throw new MsFileServiceError("msfile_unavailable", "approval is no longer pending");
    if (decision.action === "reject") {
      entry.reject(new MsFileServiceError("user_rejected", "User rejected the price increase"));
      return;
    }
    assertAmount(decision.newMaxPriceSatoshis, "newMaxPriceSatoshis");
    if (decision.scope === "always") {
      // 审查修复：永久提额必须严格高于触发确认时的有效额度；
      // 否则先持久化再重试只会必然再次失败。
      const current = BigInt(recordEffectiveCapOf(entry.record));
      const next = BigInt(decision.newMaxPriceSatoshis);
      const unlimited = current === 0n;
      if (unlimited || next <= current) {
        throw new Error(
          unlimited
            ? "current cap is already unlimited"
            : `permanent cap must exceed the current cap (${entry.record.effectiveMaxPriceSatoshis})`
        );
      }
      await this.persistAlwaysOverride(entry.record, decision.newMaxPriceSatoshis);
    }
    entry.resolve({ action: "allow", scope: decision.scope, newMaxPriceSatoshis: decision.newMaxPriceSatoshis });
  }

  private async persistAlwaysOverride(record: MsFilePendingApproval, amount: string): Promise<void> {
    const db = await this.db;
    const key: MsFileAppIdentityKey = {
      ownerPublicKeyHex: record.ownerPublicKeyHex,
      publisherPublicKeyHex: record.publisherPublicKeyHex,
      appId: record.appId,
    };
    const existing = (await db.getAppPolicy(key))?.override ?? {};
    const override =
      record.kind === "seed"
        ? { ...existing, seedMaxPriceSatoshis: amount }
        : { ...existing, blockMaxPriceSatoshis: amount };
    await db.putAppPolicy({ policyKey: msFileAppPolicyKeyString(key), key, override, updatedAt: this.now() });
  }

  private async requestApproval(record: MsFilePendingApproval, signal?: AbortSignal): Promise<MsFileApprovalDecision> {
    const approvalId = record.approvalId;
    let entry: PendingApprovalEntry | undefined;
    const promise = new Promise<MsFileApprovalDecision>((resolve, reject) => {
      entry = { record, resolve, reject };
      this.approvals.set(approvalId, entry);
    });
    const onAbort = () => {
      if (this.approvals.delete(approvalId)) {
        entry!.reject(new DOMException("The operation was aborted", "AbortError"));
        this.emit();
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    this.emit();
    try {
      return await promise;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      this.approvals.delete(approvalId);
      this.emit();
    }
  }

  async abortSession(connectSessionId: string): Promise<void> {
    for (const [id, entry] of [...this.approvals]) {
      if (entry.record.connectSessionId !== connectSessionId) continue;
      this.approvals.delete(id);
      entry.reject(new MsFileServiceError("user_rejected", "Connect session was revoked"));
    }
    this.emit();
    return Promise.resolve();
  }

  /* ============== 数据面：trusted ============== */

  async stat(input: MsFileStatInput): Promise<MsFileStatResult> {
    assertHash(input?.seedHashHex, "seedHashHex");
    await this.ensureReady();
    // 审查修复（P1-3）：数据面只消费同一原子快照；DB 读取前先固定世代。
    const snapshot = this.supplierSnapshot;
    const generationAtStart = snapshot.generation;
    const fenceAtStart = this.supplierFence;
    // barrier 下的供应商不参与本轮广播（其结果必然被栅栏丢弃）。
    const enabled = (await this.strictlyValidated(this.excludeInvalidating(snapshot.suppliers)))
      .filter((supplier) => supplier.enabled);
    if (this.supplierFence !== fenceAtStart || this.supplierGeneration !== generationAtStart) {
      throw new MsFileServiceError("msfile_unavailable", "MSFile supplier configuration changed during stat setup");
    }
    if (enabled.length === 0) return { seedHashHex: input.seedHashHex, suppliers: [] };
    // Stat 对所有启用供应商并发；单个供应商失败不影响其他结果，
    // 网络错误不得折叠成 absent。
    const entries = await Promise.all(
      enabled.map(async (supplier): Promise<MsFileStatEntryUnion> => {
        try {
          if (this.disposed || this.supplierFence !== fenceAtStart || this.supplierGeneration !== generationAtStart) {
            throw new MsFileServiceError("msfile_unavailable");
          }
          return await this.transport.stat({ supplier, seedHashHex: input.seedHashHex, supplierGeneration: generationAtStart, signal: input.signal });
        } catch (error) {
          if (input.signal?.aborted) throw error;
          // 单个供应商失败不影响其他供应商结果；网络错误不得折叠成 absent。
          return { supplierPublicKeyHex: supplier.supplierPublicKeyHex, status: "network-error" };
        }
      })
    );
    // 返回前复核世代；尺寸缓存只在通过最终检查后提交，
    // 迟到响应不得在缓存清理之后重新写入旧值。
    if (this.supplierFence !== fenceAtStart || this.supplierGeneration !== generationAtStart) {
      throw new MsFileServiceError("msfile_unavailable", "MSFile supplier configuration changed during stat");
    }
    for (const entry of entries) {
      if ((entry.status === "available" || entry.status === "quoted")) {
        this.statFileSizeBySupplierSeed.set(`${entry.supplierPublicKeyHex}|${input.seedHashHex}`, entry.fileSizeBytes);
      }
    }
    return { seedHashHex: input.seedHashHex, suppliers: entries };
  }

  async readSeed(input: MsFileReadSeedInput): Promise<MsFileReadResult> {
    return this.trustedRead(input.supplierPublicKeyHex, "seed", input.seedHashHex, input.signal);
  }

  async readBlock(input: MsFileReadBlockInput): Promise<MsFileReadResult> {
    return this.trustedRead(input.supplierPublicKeyHex, "block", input.blockHashHex, input.signal);
  }

  private async trustedRead(
    supplierPublicKeyHex: string,
    kind: MsFileContentKind,
    hashHex: string,
    signal?: AbortSignal
  ): Promise<MsFileReadResult> {
    await this.ensureReady();
    assertHash(hashHex, kind === "seed" ? "seedHashHex" : "blockHashHex");
    assertSupplierKey(supplierPublicKeyHex);
    // barrier 先于一切解析：mutation 窗口内的购买请求立即 fail closed。
    this.assertNotInvalidating(supplierPublicKeyHex);
    const db = await this.db;
    const settings = (await db.getGlobalSettings())?.settings ?? null;
    const cap = kind === "seed" ? settings?.seedMaxPriceSatoshis : settings?.blockMaxPriceSatoshis;
    if (cap === undefined) throw new MsFileServiceError("msfile_not_configured");
    const { outcome, supplierGeneration, supplierFence } = await this.sendWireRead({ supplierPublicKeyHex, kind, hashHex, cap, signal });
    return this.finishVerifiedRead(supplierPublicKeyHex, kind, hashHex, outcome, supplierGeneration, supplierFence);
  }

  /* ============== 数据面：connect gateway ============== */

  readonly connect = {
    stat: (ctx: MsFileConnectAppContext, input: { seedHashHex: string; signal?: AbortSignal }): Promise<MsFileStatResult> =>
      this.connectCall(ctx, async () => this.stat(input)),
    readSeed: (ctx: MsFileConnectAppContext, input: { supplierPublicKeyHex: string; seedHashHex: string; signal?: AbortSignal }): Promise<MsFileReadResult> =>
      this.connectCall(ctx, () => this.connectRead(ctx, "seed", input.supplierPublicKeyHex, input.seedHashHex, input.signal)),
    readBlock: (ctx: MsFileConnectAppContext, input: { supplierPublicKeyHex: string; blockHashHex: string; signal?: AbortSignal }): Promise<MsFileReadResult> =>
      this.connectCall(ctx, () => this.connectRead(ctx, "block", input.supplierPublicKeyHex, input.blockHashHex, input.signal)),
  };

  private async connectCall<T>(ctx: MsFileConnectAppContext, run: () => Promise<T>): Promise<T> {
    await this.ensureReady();
    if (!ctx || typeof ctx.connectSessionId !== "string" || ctx.connectSessionId.length === 0) {
      throw new MsFileServiceError("msfile_identity_required");
    }
    assertAppKeyShape(ctx);
    const db = await this.db;
    // 首次调用只记录脱敏 App 摘要与 lastSeenAt，不创建任何文件许可。
    await db.touchAppUsage(
      { ownerPublicKeyHex: ctx.ownerPublicKeyHex, publisherPublicKeyHex: ctx.appIdentity.publisherPublicKeyHex, appId: ctx.appIdentity.appId },
      ctx.appIdentity.appName,
      this.now()
    );
    return run();
  }

  private async connectRead(
    ctx: MsFileConnectAppContext,
    kind: MsFileContentKind,
    supplierPublicKeyHex: string,
    hashHex: string,
    signal?: AbortSignal
  ): Promise<MsFileReadResult> {
    assertHash(hashHex, kind === "seed" ? "seedHashHex" : "blockHashHex");
    assertSupplierKey(supplierPublicKeyHex);
    // 同上：gateway 路径的 barrier 前置。
    this.assertNotInvalidating(supplierPublicKeyHex);
    const db = await this.db;
    const key: MsFileAppIdentityKey = {
      ownerPublicKeyHex: ctx.ownerPublicKeyHex,
      publisherPublicKeyHex: ctx.appIdentity.publisherPublicKeyHex,
      appId: ctx.appIdentity.appId,
    };
    const [globalSettings, appPolicy] = await Promise.all([db.getGlobalSettings(), db.getAppPolicy(key)]);
    const effectiveCap =
      kind === "seed"
        ? appPolicy?.override.seedMaxPriceSatoshis ?? globalSettings?.settings?.seedMaxPriceSatoshis
        : appPolicy?.override.blockMaxPriceSatoshis ?? globalSettings?.settings?.blockMaxPriceSatoshis;
    if (effectiveCap === undefined) throw new MsFileServiceError("msfile_not_configured");

    let cap = effectiveCap;
    const record: MsFilePendingApproval = {
      approvalId: this.randomId(),
      createdAt: this.now(),
      connectSessionId: ctx.connectSessionId,
      transportOrigin: ctx.transportOrigin,
      ownerPublicKeyHex: ctx.ownerPublicKeyHex,
      publisherPublicKeyHex: ctx.appIdentity.publisherPublicKeyHex,
      appId: ctx.appIdentity.appId,
      appName: ctx.appIdentity.appName,
      kind,
      supplierPublicKeyHex,
      contentHashHex: hashHex,
      effectiveMaxPriceSatoshis: effectiveCap,
    };

    let escalatedOnce = false;
    for (;;) {
      const { outcome, supplierGeneration, supplierFence } = await this.sendWireRead({ supplierPublicKeyHex, kind, hashHex, cap, signal });
      switch (outcome.type) {
        case "ok":
          return this.finishVerifiedRead(supplierPublicKeyHex, kind, hashHex, outcome, supplierGeneration, supplierFence);
        case "price-limit-exceeded": {
          // wire price_limit_exceeded 不报告实际价格；一次调用最多确认一次。
          if (escalatedOnce) throw new MsFileServiceError("msfile_price_limit_exceeded");
          escalatedOnce = true;
          const decision = await this.requestApproval(record, signal);
          if (decision.action === "reject") throw new MsFileServiceError("user_rejected");
          cap = decision.newMaxPriceSatoshis;
          continue;
        }
      }
    }
  }

  /* ============== 内部工具 ============== */

  /** barrier 转变必须推进数据面栅栏版本。 */
  private setBarrier(key: string, state: { failed: boolean } | undefined): void {
    this.supplierFence += 1;
    if (state === undefined) this.supplierBarriers.delete(key);
    else this.supplierBarriers.set(key, state);
  }

  /** mutation barrier 检查：进行中或失败均 fail closed。 */
  private assertNotInvalidating(supplierPublicKeyHex: string | undefined): void {
    if (supplierPublicKeyHex === undefined) return;
    const barrier = this.supplierBarriers.get(supplierPublicKeyHex);
    if (!barrier) return;
    if (barrier.failed) {
      throw new MsFileServiceError("msfile_unavailable", "supplier has a failed configuration change; re-save it to retry");
    }
    throw new MsFileServiceError("msfile_unavailable", "supplier configuration change is in progress");
  }

  /** 过滤掉处于 mutation barrier 下的供应商（stat 广播路径）。 */
  private excludeInvalidating(list: MsFileSupplierConfig[]): MsFileSupplierConfig[] {
    return list.filter((entry) => !this.supplierBarriers.has(entry.supplierPublicKeyHex));
  }

  /** 统一的持久化地址严格校验（stat/probe 与 read 同源，审查修复）。 */
  private async strictlyValidated(list: MsFileSupplierConfig[]): Promise<MsFileSupplierConfig[]> {
    if (list.length === 0) return list;
    const { validatePersistedSupplier } = await this.validatorLoader();
    return list.filter((entry) => {
      try {
        return validatePersistedSupplier(entry).ok;
      } catch {
        return false;
      }
    });
  }

  private async sendWireRead(input: {
    supplierPublicKeyHex: string;
    kind: MsFileContentKind;
    hashHex: string;
    cap: string;
    signal?: AbortSignal;
  }): Promise<{ outcome: Awaited<ReturnType<MsFileTransport["read"]>>; supplierGeneration: number; supplierFence: number }> {
    // P1-3 六步 + fence token（第五轮审查）：异步地址校验窗口内发生的任何
    // barrier 转变都会推进 fence，使本次请求在后续每个阶段作废。
    await this.ensureReady();
    const snapshot = this.supplierSnapshot;
    const supplierGeneration = snapshot.generation;
    const fenceAtStart = this.supplierFence;
    const fenceChanged = (): boolean =>
      this.supplierFence !== fenceAtStart || this.supplierGeneration !== supplierGeneration;
    // barrier：mutation 进行中 / 失败未恢复 → 拒绝发起购买。
    this.assertNotInvalidating(input.supplierPublicKeyHex);
    const supplier = await this.requireEnabledSupplierFrom(snapshot, input.supplierPublicKeyHex);
    if (fenceChanged()) {
      throw new MsFileServiceError("msfile_unavailable", "MSFile supplier configuration changed during read setup");
    }
    const maxPrice = msFileSatoshiAmountToBigInt(input.cap);
    if (maxPrice === undefined) throw new MsFileServiceError("msfile_not_configured");
    if (this.disposed) throw new MsFileServiceError("msfile_unavailable", "MSFile service was disposed");
    try {
      const outcome = await this.transport.read({
        supplier,
        kind: input.kind,
        hashHex: input.hashHex,
        maxPriceSatoshis: maxPrice,
        supplierGeneration,
        signal: input.signal,
      });
      if (fenceChanged()) {
        throw new MsFileServiceError("msfile_unavailable", "MSFile supplier configuration changed during read");
      }
      return { outcome, supplierGeneration, supplierFence: fenceAtStart };
    } catch (error) {
      if (error instanceof MsFileServiceError) throw error;
      throw mapTransportError(error);
    }
  }

  /**
   * 数据面供应商解析（审查修复 P1-3）：只消费调用方传入的原子快照，
   * 不回读 DB。地址严格校验在拨号前执行（动态导入，模块缓存后近零开销）；
   * 持久化记录可能来自旧版本校验或外部改动，fail closed。
   */
  private async requireEnabledSupplierFrom(snapshot: { generation: number; suppliers: MsFileSupplierConfig[] }, supplierPublicKeyHex: string): Promise<MsFileSupplierConfig> {
    const supplier = snapshot.suppliers.find((entry) => entry.supplierPublicKeyHex === supplierPublicKeyHex);
    if (!supplier) throw new MsFileServiceError("msfile_supplier_not_found");
    if (!supplier.enabled) throw new MsFileServiceError("msfile_supplier_disabled");
    const { validatePersistedSupplier } = await this.validatorLoader();
    const validation = validatePersistedSupplier(supplier);
    if (!validation.ok) {
      throw new MsFileServiceError("msfile_supplier_not_found", `persisted supplier config is invalid: ${validation.message}`);
    }
    return supplier;
  }

  /** 返回 App 或插件前必须完成 hash 与尺寸校验与世代复核；已知 file size 时执行 Seed 精确长度检查。 */
  private async finishVerifiedRead(
    supplierPublicKeyHex: string,
    kind: MsFileContentKind,
    hashHex: string,
    outcome: { type: "ok"; content: Uint8Array } | { type: "integrity-failed" } | { type: "price-limit-exceeded" } | { type: "supplier-error"; errorCode: string } | { type: "cancelled"; replacedByRequestId: bigint } | { type: "transport-failed" },
    supplierGenerationAtStart: number,
    supplierFenceAtStart: number
  ): Promise<MsFileReadResult> {
    if (outcome.type !== "ok") {
      switch (outcome.type) {
        case "price-limit-exceeded":
          throw new MsFileServiceError("msfile_price_limit_exceeded");
        case "supplier-error":
          throw mapSupplierErrorCode(outcome.errorCode);
        case "integrity-failed":
          throw new MsFileServiceError("msfile_integrity_error");
        default:
          throw new MsFileServiceError("msfile_transport_error");
      }
    }
    const bytes = outcome.content;
    try {
      if (kind === "seed") {
        const knownFileSize = this.statFileSizeBySupplierSeed.get(`${supplierPublicKeyHex}|${hashHex}`);
        await validateSeedContent(bytes, hashHex, knownFileSize === undefined ? {} : { fileSizeBytes: BigInt(knownFileSize) });
      } else {
        await validateBlockContent(bytes, hashHex);
      }
    } catch {
      // 内容哈希或尺寸不符：内容不可信，一律 integrity_error 且不得返回字节。
      throw new MsFileServiceError("msfile_integrity_error");
    }
    // 第⑤步：hash/尺寸校验完成之后、返回字节之前最后复核栅栏与世代——
    // 校验期间发生的 disable/delete/地址修改都会丢弃这份内容。
    if (this.disposed || this.supplierGeneration !== supplierGenerationAtStart || this.supplierFence !== supplierFenceAtStart) {
      throw new MsFileServiceError("msfile_unavailable", "MSFile service was disposed or supplier configuration changed during read");
    }
    return {
      contentHashHex: hashHex,
      content: { $type: "binary", bytes: toArrayBuffer(bytes) },
    };
  }
}

function recordEffectiveCapOf(record: MsFilePendingApproval): string {
  return record.effectiveMaxPriceSatoshis;
}

type MsFileGlobalSettingsSnapshotLike = {
  settings: MsFileGlobalPriceSettings | null;
  mediaBlockReadConcurrency: number;
  globalSeedReadConcurrency: number;
  globalBlockReadConcurrency: number;
  globalStatConcurrency: number;
  updatedAt?: number | null;
};
type MsFileStatEntryUnion = import("@keymaster/contracts").MsFileSupplierStat;

function readConcurrencyFromRow(row: {
  mediaBlockReadConcurrency?: number;
  globalSeedReadConcurrency?: number;
  globalBlockReadConcurrency?: number;
  globalStatConcurrency?: number;
} | null): MsFileReadConcurrencySettings {
  const candidate = {
    mediaBlockReadConcurrency: row?.mediaBlockReadConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.mediaBlockReadConcurrency,
    globalSeedReadConcurrency: row?.globalSeedReadConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.globalSeedReadConcurrency,
    globalBlockReadConcurrency: row?.globalBlockReadConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.globalBlockReadConcurrency,
    globalStatConcurrency: row?.globalStatConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.globalStatConcurrency,
  };
  return normalizeMsFileReadConcurrencySettings(candidate) ?? { ...MSFILE_READ_CONCURRENCY_RECOMMENDED };
}

function canonicalSettingsRow(row: import("./msfileDb.js").MsFileGlobalSettingsSnapshot): MsFileGlobalSettingsSnapshotLike {
  return {
    settings: row.settings,
    ...readConcurrencyFromRow(row),
    updatedAt: row.updatedAt,
  };
}

function assertAmount(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 0xffffffffffffffffn) {
    throw new Error(`${field} must be a canonical decimal amount in 0..2^64-1`);
  }
}

function assertReadConcurrencySettings(value: unknown): asserts value is MsFileReadConcurrencySettings {
  void value;
  throw new Error("MSFile read concurrency must be positive integers within the technical limits, with mediaBlockReadConcurrency <= globalBlockReadConcurrency");
}

function assertHash(value: unknown, field: string): void {
  if (!isValidMsFileHashHex(value)) throw new MsFileServiceError("msfile_invalid_hash", `${field} must be 64 lower-case hex chars`);
}

function assertSupplierKey(value: unknown): void {
  if (!isValidMsFileSupplierPublicKeyHex(value)) throw new MsFileServiceError("msfile_supplier_not_found", "supplier public key is invalid");
}

function assertAppKeyShape(ctx: MsFileConnectAppContext): void {
  assertAppKey({
    ownerPublicKeyHex: ctx.ownerPublicKeyHex,
    publisherPublicKeyHex: ctx.appIdentity?.publisherPublicKeyHex,
    appId: ctx.appIdentity?.appId,
  });
}

function assertAppKey(key: Partial<MsFileAppIdentityKey> | undefined): void {
  if (
    !key ||
    !isValidMsFileSupplierPublicKeyHex(key.ownerPublicKeyHex) ||
    !isValidMsFileSupplierPublicKeyHex(key.publisherPublicKeyHex) ||
    typeof key.appId !== "string" ||
    key.appId.length === 0 ||
    key.appId.length > 256
  ) {
    throw new MsFileServiceError("msfile_identity_required");
  }
}

/** transport 抛出的未知异常统一归为传输错误（不是 absent）。 */
function mapTransportError(_error: unknown): MsFileServiceError {
  return new MsFileServiceError("msfile_transport_error");
}

/**
 * supplier wire error code 保留为内部诊断；只把可判定的码映射到稳定公开码，
 * 其余一律归入传输错误，不把任意远端字符串变成公开 code。
 */
function mapSupplierErrorCode(errorCode: string): MsFileServiceError {
  switch (errorCode) {
    case "integrity_error":
      return new MsFileServiceError("msfile_integrity_error");
    case "invalid_content_hash":
      return new MsFileServiceError("msfile_invalid_hash");
    case "bad_request":
    case "unsupported_version":
    case "wrong_stream_role":
    case "stale_request_id":
    case "unauthorized_peer":
      return new MsFileServiceError("msfile_protocol_error");
    // 供应商业务终态与网络失败分开（审查修复）。
    case "content_not_found":
      return new MsFileServiceError("msfile_content_not_found");
    case "rate_limited":
      return new MsFileServiceError("msfile_rate_limited");
    // 明确的供应商侧业务失败：不归入网络/transport 语义。
    case "price_already_committed":
    case "acquisition_failed":
    case "internal_error":
      return new MsFileServiceError("msfile_supplier_error");
    default:
      // 未知远端字符串不得变成任意公开 code（施工单 §6）。
      return new MsFileServiceError("msfile_transport_error", "supplier reported a non-terminal failure");
  }
}

/** 导出尺寸常量便于 proxy 层做 transfer 上限提示。 */
export const MSFILE_READ_SIZE_LIMITS = {
  seed: MSFILE_MAX_SEED_BYTES,
  block: MSFILE_MAX_BLOCK_BYTES,
} as const;

export function createMsFileService(deps?: MsFileServiceImplDeps): MsFileServiceImpl {
  return new MsFileServiceImpl(deps);
}
