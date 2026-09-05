// packages/plugin-msfile/src/msfileServiceProxy.ts
// 页面侧 facade：不拥有设置真值、K-V 或网络。所有控制/数据请求经
// Coordinator SharedWorker RPC；状态经 `msfile.state` topic 订阅。

import type {
  CoordinatorMsFileControl,
  CoordinatorMsFileData,
  CoordinatorValueResult,
  MsFileApprovalDecision,
  MsFileAppAuthorizationView,
  MsFileAppIdentityKey,
  MsFileAppPriceOverrideUpdate,
  MsFileConnectAppContext,
  MsFileErrorCode,
  MsFileGlobalPriceSettings,
  MsFileReadConcurrencySettings,
  MsFilePendingApprovalView,
  MsFileReadBlockInput,
  MsFileReadResult,
  MsFileReadSeedInput,
  MsFileServiceStatus,
  MsFileSettingsSnapshot,
  MsFileStatInput,
  MsFileStatResult,
  MsFileSupplierConfig,
  MsFileSupplierProbeResult,
  MsFileCoordinatorControl,
} from "@keymaster/contracts";
import { MSFILE_READ_CONCURRENCY_RECOMMENDED, normalizeMsFileReadConcurrencySettings } from "@keymaster/contracts";
import type { MsFileService } from "@keymaster/contracts";
import { MsFileServiceError } from "./msfileErrors.js";

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
  pendingApprovals: MsFilePendingApprovalView[];
};

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
  private current: StateEvent = {
    topic: "msfile.state",
    sessionEpoch: "boot",
    status: "unavailable",
    supplierGeneration: 0,
    globalSettings: null,
    ...MSFILE_READ_CONCURRENCY_RECOMMENDED,
    pendingApprovals: [],
  };
  private readonly listeners = new Set<() => void>();
  private readonly grants = new Map<string, Promise<string>>();
  private readonly unsubscribeState: () => void;

  constructor(private readonly coordinator: MsFileCoordinatorControl) {
    this.unsubscribeState = coordinator.subscribeTopic("msfile.state", (event: StateEvent) => {
      if (event.sessionEpoch !== this.current.sessionEpoch) this.grants.clear();
      // 兼容旧 Worker 的 baseline：四项并发设置必须以完整快照进入页面。
      const concurrency = normalizeMsFileReadConcurrencySettings(event)
        ?? { ...MSFILE_READ_CONCURRENCY_RECOMMENDED };
      this.current = { ...event, ...concurrency };
      for (const listener of this.listeners) listener();
    });
  }

  status(): MsFileServiceStatus {
    return this.current.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribeState();
    this.listeners.clear();
  }

  private control<T>(control: CoordinatorMsFileControl): Promise<T> {
    return this.coordinator.msfileControl(control).then((result) => unwrap<T>(result));
  }

  private grantFor(ctx: MsFileConnectAppContext): Promise<string> {
    const key = `${ctx.connectSessionId}|${ctx.transportOrigin}|${ctx.appIdentity.identityDigestHex}`;
    const existing = this.grants.get(key);
    if (existing) return existing;
    const pending = this.coordinator
      .msfileGrant(ctx)
      .then((result) => unwrap<string>(result))
      .catch((error) => {
        this.grants.delete(key);
        throw error;
      });
    this.grants.set(key, pending);
    return pending;
  }

  private async dataFor<T>(
    ctx: MsFileConnectAppContext | null,
    build: (grantId?: string) => CoordinatorMsFileData,
    transfer: ArrayBuffer[] = [],
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) throw new MsFileServiceError("msfile_unavailable");
    if (ctx === null) {
      // 受信任内部插件：无 grant，直接走数据面（worker 只按全局额度执行）。
      return this.coordinator.msfileData(build(undefined), transfer, signal).then((result) => unwrap<T>(result));
    }
    const grantId = await this.grantFor(ctx);
    if (signal?.aborted) throw new MsFileServiceError("msfile_unavailable");
    return this.coordinator.msfileData(build(grantId), transfer, signal).then((result) => unwrap<T>(result));
  }

  getSettingsSnapshot(): Promise<MsFileSettingsSnapshot> {
    return this.control<MsFileSettingsSnapshot>({ type: "settings.get" });
  }

  getReadConcurrencySettings(): Promise<MsFileReadConcurrencySettings> {
    return this.control<MsFileReadConcurrencySettings>({ type: "settings.readConcurrency.get" });
  }

  updateReadConcurrencySettings(input: MsFileReadConcurrencySettings): Promise<void> {
    return this.control({ type: "settings.readConcurrency.update", input }).then(() => undefined);
  }

  resetReadConcurrencySettings(): Promise<void> {
    return this.control({ type: "settings.readConcurrency.reset" }).then(() => undefined);
  }

  getMediaBlockReadConcurrency(): Promise<number> {
    return this.getReadConcurrencySettings().then((settings) => settings.mediaBlockReadConcurrency);
  }

  updateGlobalPriceSettings(input: MsFileGlobalPriceSettings): Promise<void> {
    return this.control({ type: "settings.global.update", input }).then(() => undefined);
  }

  updateMediaBlockReadConcurrency(value: number): Promise<void> {
    return this.getReadConcurrencySettings()
      .then((settings) => this.updateReadConcurrencySettings({ ...settings, mediaBlockReadConcurrency: value }));
  }

  upsertSupplier(input: unknown): Promise<void> {
    return this.control({
      type: "supplier.upsert",
      supplier: input as MsFileSupplierConfig,
      expectedGeneration: this.current.supplierGeneration,
    }).then(() => undefined);
  }

  deleteSupplier(supplierPublicKeyHex: string): Promise<void> {
    return this.control({ type: "supplier.delete", supplierPublicKeyHex, expectedGeneration: this.current.supplierGeneration }).then(() => undefined);
  }

  probeSupplier(supplierPublicKeyHex: string, signal?: AbortSignal): Promise<MsFileSupplierProbeResult> {
    if (signal?.aborted) return Promise.reject(new MsFileServiceError("msfile_unavailable"));
    return this.control<MsFileSupplierProbeResult>({ type: "supplier.probe", supplierPublicKeyHex });
  }

  updateAppPriceOverride(input: MsFileAppPriceOverrideUpdate): Promise<void> {
    return this.control({ type: "app-policy.update", input }).then(() => undefined);
  }

  clearAppPriceOverride(key: MsFileAppIdentityKey): Promise<void> {
    return this.control({ type: "app-policy.clear", key }).then(() => undefined);
  }

  listAppAuthorizations(): Promise<MsFileAppAuthorizationView[]> {
    return this.control<MsFileAppAuthorizationView[]>({ type: "app-authorizations.list" });
  }

  listPendingApprovals(): MsFilePendingApprovalView[] {
    return this.current.pendingApprovals;
  }

  resolveApproval(approvalId: string, decision: MsFileApprovalDecision): Promise<void> {
    return this.control({ type: "approval.resolve", approvalId, decision }).then(() => undefined);
  }

  abortSession(connectSessionId: string): Promise<void> {
    for (const key of [...this.grants.keys()]) {
      if (key.startsWith(`${connectSessionId}|`)) this.grants.delete(key);
    }
    return this.coordinator.msfileSessionAbort(connectSessionId).then((result) => {
      if (result.status !== "ok" && result.status !== "accepted") throw new MsFileServiceError("msfile_unavailable");
    });
  }

  stat(input: MsFileStatInput): Promise<MsFileStatResult> {
    return this.dataFor<MsFileStatResult>(null, () => ({ type: "stat", seedHashHex: input.seedHashHex }), [], input.signal);
  }

  readSeed(input: MsFileReadSeedInput): Promise<MsFileReadResult> {
    return this.dataFor<MsFileReadResult>(
      null,
      () => ({ type: "read-seed", supplierPublicKeyHex: input.supplierPublicKeyHex, seedHashHex: input.seedHashHex }),
      [],
      input.signal
    );
  }

  readBlock(input: MsFileReadBlockInput): Promise<MsFileReadResult> {
    return this.dataFor<MsFileReadResult>(
      null,
      () => ({ type: "read-block", supplierPublicKeyHex: input.supplierPublicKeyHex, blockHashHex: input.blockHashHex }),
      [],
      input.signal
    );
  }

  readonly connect = {
    stat: (ctx: MsFileConnectAppContext, input: { seedHashHex: string; signal?: AbortSignal }): Promise<MsFileStatResult> =>
      this.dataFor<MsFileStatResult>(ctx, (grantId) => ({ type: "stat", grantId, seedHashHex: input.seedHashHex }), [], input.signal),
    readSeed: (
      ctx: MsFileConnectAppContext,
      input: { supplierPublicKeyHex: string; seedHashHex: string; signal?: AbortSignal }
    ): Promise<MsFileReadResult> =>
      this.dataFor<MsFileReadResult>(
        ctx,
        (grantId) => ({ type: "read-seed", grantId, supplierPublicKeyHex: input.supplierPublicKeyHex, seedHashHex: input.seedHashHex }),
        [],
        input.signal
      ),
    readBlock: (
      ctx: MsFileConnectAppContext,
      input: { supplierPublicKeyHex: string; blockHashHex: string; signal?: AbortSignal }
    ): Promise<MsFileReadResult> =>
      this.dataFor<MsFileReadResult>(
        ctx,
        (grantId) => ({ type: "read-block", grantId, supplierPublicKeyHex: input.supplierPublicKeyHex, blockHashHex: input.blockHashHex }),
        [],
        input.signal
      ),
  };
}
