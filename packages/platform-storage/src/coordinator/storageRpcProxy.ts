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
  StorageProbeResult,
  StorageActivationResult,
  StorageProviderConfigDraft,
  StorageProviderConnectionView,
  StorageProviderSummary,
  StoragePutResult,
  StorageRuntimeController,
  StorageRuntimeControllerStatus,
  StorageRuntimeStatus,
  StorageUploadAbortResult,
  StorageUploadBeginResult,
  StorageUploadPartResult,
} from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageRuntimeError.js";
import { encryptStorageProfile, writeStorageBootstrap } from "../bootstrap/storageProfileRepository.js";
import { normalizeProviderConfig } from "../bucket-providers/s3/s3ClientFactory.js";

type StateEvent = { topic: "storage.state"; sessionEpoch: string; status: StorageRuntimeControllerStatus; healthStatus?: StorageRuntimeStatus; summary: StorageProviderSummary | null; capabilities: BucketConditionalCapabilitiesView | null };

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
  private current: StateEvent = { topic: "storage.state", sessionEpoch: "boot", status: "locked", healthStatus: "unselected", summary: null, capabilities: null };
  private readonly listeners = new Set<() => void>();
  private readonly grants = new Map<string, Promise<string>>();
  private readonly unsubscribeState: () => void;
  private readonly recoveryTarget?: Window;
  private readonly recoverStorage: () => void;

  constructor(private readonly coordinator: StorageCoordinatorControl) {
    this.unsubscribeState = coordinator.subscribeTopic("storage.state", (event: StateEvent) => {
      if (event.sessionEpoch !== this.current.sessionEpoch) this.grants.clear();
      this.current = event;
      for (const listener of this.listeners) listener();
    });
    this.recoveryTarget = typeof window === "undefined" ? undefined : window;
    this.recoverStorage = () => { void this.control({ type: "retry" }).catch(() => undefined); };
    this.recoveryTarget?.addEventListener("online", this.recoverStorage);
    this.recoveryTarget?.addEventListener("visibilitychange", this.recoverStorage);
  }

  status(): StorageRuntimeControllerStatus { return this.current.status; }
  healthStatus(): StorageRuntimeStatus { return this.current.healthStatus ?? "degraded"; }
  /** 由 Storage Onboarding 或网络恢复事件触发一次全局探测。 */
  retry(): Promise<unknown> { return this.control({ type: "retry" }); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose(): void {
    this.unsubscribeState();
    this.recoveryTarget?.removeEventListener("online", this.recoverStorage);
    this.recoveryTarget?.removeEventListener("visibilitychange", this.recoverStorage);
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
  unlockStorageProfile(password: string): Promise<StorageProbeResult> { return this.control({ type: "unlock-profile", password }); }
  selectOpfs(): Promise<StorageProbeResult> {
    return this.control<StorageProbeResult>({ type: "select-opfs" }).then((result) => {
      if (result.ok) writeStorageBootstrap({ selectedBackend: "opfs", selectedProfileId: "opfs" });
      return result;
    });
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
