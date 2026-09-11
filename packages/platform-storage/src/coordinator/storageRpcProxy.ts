import type {
  CoordinatorStorageControl,
  CoordinatorStorageData,
  CoordinatorValueResult,
  StorageCoordinatorControl,
  OwnerAppStorageGrant,
  BucketConditionalCapabilitiesView,
  BucketConditionalCapabilityProbeResult,
  StorageDirectoryResult,
  StorageListResult,
  StorageOpfsProbeResult,
  StorageProbeResult,
  StorageActivationResult,
  StorageProviderConfigDraft,
  StorageProviderConnectionView,
  StorageProviderSummary,
  StoragePutResult,
  StorageRuntimeController,
  StorageRuntimeControllerStatus,
  StorageRuntimeStatus,
  CoordinatorAuthorityRecovery,
  InitialSetupRecoveryRecordV1,
  InitialSetupRecoveryResult,
  StorageUploadAbortResult,
  StorageUploadBeginResult,
  StorageUploadPartResult,
  StorageBucketCatalogEntryV2,
  StorageBucketConnectionConfigV1,
  StorageBucketSwitchResultV1,
} from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageRuntimeError.js";
import { encryptStorageProfile, writeStorageBootstrap } from "../bootstrap/storageProfileRepository.js";
import { readStorageCatalog } from "../bootstrap/storageCatalogRepository.js";
import { normalizeProviderConfig } from "../bucket-providers/s3/s3ClientFactory.js";
import { requestOpfsPersistence } from "../bucket-providers/opfs/opfsPersistence.js";

type StateEvent = { topic: "storage.state"; sessionEpoch: string; status: StorageRuntimeControllerStatus; healthStatus?: StorageRuntimeStatus; catalogBucket?: boolean; bucketId?: string; bucketGeneration?: number; authorityRecovery?: CoordinatorAuthorityRecovery; summary: StorageProviderSummary | null; capabilities: BucketConditionalCapabilitiesView | null };

function unwrap<T>(result: CoordinatorValueResult<unknown>): Promise<T> {
  if (result.status === "ok") return Promise.resolve(result.value as T);
  if (result.status === "transport-error") throw new StorageRuntimeError("storage_unavailable", result.message || "Storage Coordinator request cancelled");
  const code = "code" in result && typeof result.code === "string" ? result.code as import("@keymaster/contracts").StorageErrorCode : undefined;
  const message = "message" in result && typeof result.message === "string"
    ? result.message
    : result.status === "blocked"
      ? (typeof result.reason === "string" ? result.reason : result.reason.fallback)
      : "Storage Coordinator request failed";
  throw new StorageRuntimeError(code ?? (result.status === "stale-epoch" || result.status === "locked" ? "storage_unavailable" : "storage_provider_error"), message);
}

/** Page-side facade. It owns no provider config, client, cursor, or S3 I/O. */
export class StorageRpcProxy implements StorageRuntimeController {
  private current: StateEvent = { topic: "storage.state", sessionEpoch: "boot", status: "locked", healthStatus: "unselected", catalogBucket: false, summary: null, capabilities: null };
  private readonly listeners = new Set<() => void>();
  private readonly grants = new Map<string, Promise<string>>();
  private readonly unsubscribeState: () => void;

  constructor(private readonly coordinator: StorageCoordinatorControl) {
    this.unsubscribeState = coordinator.subscribeTopic("storage.state", (event: StateEvent) => {
      if (event.sessionEpoch !== this.current.sessionEpoch) this.grants.clear();
      this.current = event;
      for (const listener of this.listeners) listener();
    });
  }

  status(): StorageRuntimeControllerStatus { return this.current.status; }
  hasCatalogBuckets(): boolean {
    try { return readStorageCatalog().buckets.length > 0; }
    catch { return false; }
  }
  healthStatus(): StorageRuntimeStatus { return this.current.healthStatus ?? "degraded"; }
  /** 当前是否为新版桶目录；页面据此决定是否必须再次输入桶密码。 */
  isCatalogBucket(): boolean { return this.current.catalogBucket === true; }
  /** 当前目录桶身份；仅用于页面把桶树与 Worker 当前会话对齐。 */
  selectedBucketId(): string | undefined { return this.current.bucketId; }
  /** 返回旧 Worker 租约阻塞信息；页面只能据此等待并重试，不能强制接管。 */
  authorityRecovery(): CoordinatorAuthorityRecovery | undefined { return this.current.authorityRecovery; }
  /** 由 Storage Onboarding 或网络恢复事件触发一次全局探测。 */
  retry(): Promise<unknown> { return this.control({ type: "retry" }); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose(): void {
    this.unsubscribeState();
    this.listeners.clear();
  }
  private control<T>(control: CoordinatorStorageControl): Promise<T> { return this.coordinator.storageControl(control).then(unwrap<T>); }
  private grantFor(ctx: OwnerAppStorageGrant): Promise<string> {
    const key = `${ctx.connectSessionId}|${ctx.transportOrigin}|${ctx.appIdentity.identityDigestHex}`;
    const existing = this.grants.get(key); if (existing) return existing;
    const pending = this.coordinator.storageGrant(ctx).then(unwrap<string>).catch((error) => { this.grants.delete(key); throw error; });
    this.grants.set(key, pending); return pending;
  }
  private dataFor<T>(ctx: OwnerAppStorageGrant, build: (grantId: string) => CoordinatorStorageData, transfer: ArrayBuffer[] = [], signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new StorageRuntimeError("storage_unavailable"));
    const key = `${ctx.connectSessionId}|${ctx.transportOrigin}|${ctx.appIdentity.identityDigestHex}`;
    return this.grantFor(ctx).then((grantId) => {
      if (signal?.aborted) throw new StorageRuntimeError("storage_unavailable");
      return this.coordinator.storageData(build(grantId), transfer, signal);
    }).then(unwrap<T>).catch((error) => {
      if (error instanceof StorageRuntimeError && (error.code === "storage_identity_required" || error.code === "storage_unavailable")) this.grants.delete(key);
      throw error;
    });
  }

  getProviderSummary(): Promise<StorageProviderSummary | null> { return Promise.resolve(this.current.summary); }
  getProviderConnection(): Promise<StorageProviderConnectionView | null> { return this.control({ type: "connection" }); }
  /** 首次初始化的唯一高层入口；页面不再分别调用桶/Vault 持久化 API。 */
  initialSetup(plan: import("@keymaster/contracts").InitialSetupPlan): Promise<import("@keymaster/contracts").InitialSetupResult> {
    return this.control({ type: "initial-setup", plan });
  }
  getInitialSetupResult(transactionId: string): Promise<import("@keymaster/contracts").InitialSetupResult | undefined> {
    return this.control({ type: "initial-setup-result", transactionId });
  }
  listInitialSetupRecoveries(): Promise<InitialSetupRecoveryRecordV1[]> {
    return this.control({ type: "initial-setup-recovery-list" });
  }
  retryInitialSetupCleanup(transactionId: string, input: { password?: string; connection?: StorageBucketConnectionConfigV1 } = {}): Promise<InitialSetupRecoveryResult> {
    return this.control({
      type: "initial-setup-cleanup",
      transactionId,
      ...(input.password === undefined ? {} : { password: input.password }),
      ...(input.connection === undefined ? {} : { connection: input.connection }),
    });
  }
  inspectLegacyInitialSetup(password: string): Promise<import("@keymaster/contracts").InitialSetupLegacyInspection> {
    return this.control({ type: "initial-setup-legacy-inspect", password });
  }
  cleanupLegacyInitialSetup(password: string): Promise<import("@keymaster/contracts").InitialSetupLegacyCleanupResult> {
    return this.control({ type: "initial-setup-legacy-cleanup", password });
  }
  unlockStorageProfile(password: string): Promise<StorageProbeResult> { return this.control({ type: "unlock-profile", password }); }
  /** 新版桶目录的临时解锁；密码只进入本次 Worker bootstrap。 */
  async unlockBucket(password: string): Promise<unknown> {
    await this.coordinator.refreshStorageBootstrap?.();
    return this.control({ type: "unlock-bucket", password });
  }
  /** 目标桶先在 Worker 暂存并认证，成功后才更新目录和当前运行时。 */
  switchBucket(bucket: StorageBucketCatalogEntryV2, password: string): Promise<StorageBucketSwitchResultV1> {
    return this.control({ type: "switch-bucket", bucket, password });
  }
  /** 当前桶配置改动必须由 Coordinator 同步 Provider、快照和目录。 */
  changeBucketConnectionConfig(config: StorageBucketConnectionConfigV1, password: string, label?: string): Promise<StorageBucketCatalogEntryV2> {
    return this.control({ type: "change-bucket-config", config, ...(label === undefined ? {} : { label }), password });
  }
  /** 当前桶改名与 Coordinator 运行态/目录保持同一条 CAS 边界。 */
  renameBucket(label: string): Promise<StorageBucketCatalogEntryV2> {
    return this.control({ type: "rename-bucket", label });
  }
  /** 当前桶全量改密；页面只负责把返回的目录条目写回本机目录。 */
  changeBucketPassword(oldPassword: string, newPassword: string): Promise<import("@keymaster/contracts").StorageBucketPasswordRotationResultV1> {
    return this.control({ type: "change-bucket-password", oldPassword, newPassword });
  }
  /**
   * 冷导出当前 Coordinator 已绑定桶的已提交 Hold 快照。
   * 返回值只允许二进制；页面不会接触桶密码或解密配置。
   */
  async coldExportBucket(): Promise<Uint8Array> {
    const value = await this.control<unknown>({ type: "cold-export" });
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new StorageRuntimeError("storage_provider_error", "Storage cold export returned invalid bytes");
  }
  async selectOpfs(): Promise<StorageOpfsProbeResult> {
    // 只有 Window 能申请授权；StorageManager 访问封装在 OPFS Provider。
    await requestOpfsPersistence();
    const result = await this.control<StorageOpfsProbeResult>({ type: "select-opfs" });
    if (result.ok) writeStorageBootstrap({ selectedBackend: "opfs", selectedProfileId: "opfs" });
    return result;
  }
  importStorageProfile(envelope: import("@keymaster/contracts").StorageProfileEnvelopeV1, password: string): Promise<StorageProbeResult> {
    return this.control<StorageProbeResult>({ type: "import-profile", envelope, password }).then((result) => {
      if (result.ok) writeStorageBootstrap({ selectedBackend: "s3", selectedProfileId: `${result.providerId}:imported`, encryptedStorageProfileEnvelope: envelope });
      return result;
    });
  }
  cancelProbe(): void { void this.control({ type: "cancel-probe" }); }
  probeProvider(config: StorageProviderConfigDraft): Promise<StorageProbeResult> { return this.control({ type: "probe", config }); }
  getConditionalCapabilities(): BucketConditionalCapabilitiesView | null { return this.current.capabilities; }
  probeConditionalCapabilities(signal?: AbortSignal): Promise<BucketConditionalCapabilityProbeResult> {
    if (signal?.aborted) return Promise.reject(new StorageRuntimeError("storage_unavailable"));
    const abort = () => { void this.control({ type: "cancel-probe" }).catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    return this.control<BucketConditionalCapabilityProbeResult>({ type: "probe-capabilities" }).finally(() => signal?.removeEventListener("abort", abort));
  }
  async activateProvider(config: StorageProviderConfigDraft): Promise<StorageActivationResult> {
    const result = await this.control<StorageActivationResult>({ type: "activate", config, expectedProviderGeneration: this.current.summary?.generation ?? null });
    // 页面把启动选择同步到本机 bootstrap；密文由独立 Storage Profile
    // 密码保护，明文凭据不会进入 localStorage。
    if ((("status" in result && result.status === "selected") || ("ok" in result && result.ok)) && config.profilePassword && config.profilePassword.length >= 8) {
      try {
        const normalized = normalizeProviderConfig(config);
        const envelope = await encryptStorageProfile(normalized, config.profilePassword);
        writeStorageBootstrap({ selectedBackend: "s3", selectedProfileId: `${normalized.providerId}:${(normalized.connection as { bucket: string }).bucket}`, encryptedStorageProfileEnvelope: envelope });
      } catch {
        // Provider 已由 Coordinator 激活；本机 bootstrap 写失败由下次设置页重试，
        // 不能把成功的远端配置改报成失败。
      }
    }
    return result;
  }
  async clearProviderConfig(): Promise<void> {
    await this.control({ type: "clear", expectedProviderGeneration: this.current.summary?.generation ?? null });
    // 只有 Coordinator 确认当前没有活跃 Root 时，页面侧才持久化下次启动项。
    writeStorageBootstrap({ selectedBackend: "opfs" });
  }
  async resetStorage(): Promise<void> {
    await this.control({ type: "reset", expectedProviderGeneration: this.current.summary?.generation ?? null });
    writeStorageBootstrap({ selectedBackend: "opfs" });
  }
  abortSession(connectSessionId: string): Promise<void> { return this.coordinator.storageSessionAbort(connectSessionId).then((result) => { if (result.status !== "ok") throw new StorageRuntimeError("storage_unavailable"); for (const key of this.grants.keys()) if (key.startsWith(`${connectSessionId}|`)) this.grants.delete(key); }); }

  list(ctx: OwnerAppStorageGrant, input: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<StorageListResult> {
    return this.dataFor(ctx, (grantId) => ({ type: "list", grantId, input: { prefix: input.prefix, cursor: input.cursor, limit: input.limit } }), [], input.signal);
  }
  createDirectory(ctx: OwnerAppStorageGrant, input: { path: string; overwrite?: boolean; signal?: AbortSignal }): Promise<StorageDirectoryResult> { return this.dataFor(ctx, (grantId) => ({ type: "create-directory", grantId, input: { path: input.path, overwrite: input.overwrite } }), [], input.signal); }
  deleteDirectory(ctx: OwnerAppStorageGrant, input: { path: string; signal?: AbortSignal }): Promise<StorageDirectoryResult> { return this.dataFor(ctx, (grantId) => ({ type: "delete-directory", grantId, input: { path: input.path } }), [], input.signal); }
  put(ctx: OwnerAppStorageGrant, input: { path: string; content: { $type: "binary"; bytes: ArrayBuffer; mime?: string }; contentType?: string; overwrite?: boolean; signal?: AbortSignal }): Promise<StoragePutResult> {
    return this.dataFor(ctx, (grantId) => ({ type: "put", grantId, input: { path: input.path, content: input.content, contentType: input.contentType, overwrite: input.overwrite } }), [input.content.bytes], input.signal);
  }
  getRange(ctx: OwnerAppStorageGrant, input: { path: string; offset?: number; length?: number; ifMatch?: string; signal?: AbortSignal }) { return this.dataFor<Awaited<ReturnType<StorageRuntimeController["getRange"]>>>(ctx, (grantId) => ({ type: "get-range", grantId, input: { path: input.path, offset: input.offset, length: input.length, ifMatch: input.ifMatch } }), [], input.signal); }
  delete(ctx: OwnerAppStorageGrant, input: { path: string; signal?: AbortSignal }) { return this.dataFor<Awaited<ReturnType<StorageRuntimeController["delete"]>>>(ctx, (grantId) => ({ type: "delete", grantId, input: { path: input.path } }), [], input.signal); }
  beginUpload(ctx: OwnerAppStorageGrant, input: { path: string; contentType?: string; size: number; overwrite?: boolean; signal?: AbortSignal }): Promise<StorageUploadBeginResult> { return this.dataFor(ctx, (grantId) => ({ type: "begin-upload", grantId, input: { path: input.path, contentType: input.contentType, size: input.size, overwrite: input.overwrite } }), [], input.signal); }
  uploadPart(ctx: OwnerAppStorageGrant, input: { uploadId: string; partNumber: number; content: { $type: "binary"; bytes: ArrayBuffer; mime?: string }; signal?: AbortSignal }): Promise<StorageUploadPartResult> { return this.dataFor(ctx, (grantId) => ({ type: "upload-part", grantId, input: { uploadId: input.uploadId, partNumber: input.partNumber, content: input.content } }), [input.content.bytes], input.signal); }
  completeUpload(ctx: OwnerAppStorageGrant, input: { uploadId: string; signal?: AbortSignal }) { return this.dataFor<Awaited<ReturnType<StorageRuntimeController["completeUpload"]>>>(ctx, (grantId) => ({ type: "complete-upload", grantId, input: { uploadId: input.uploadId } }), [], input.signal); }
  abortUpload(ctx: OwnerAppStorageGrant, input: { uploadId: string; signal?: AbortSignal }): Promise<StorageUploadAbortResult> { return this.dataFor(ctx, (grantId) => ({ type: "abort-upload", grantId, input: { uploadId: input.uploadId } }), [], input.signal); }
}
