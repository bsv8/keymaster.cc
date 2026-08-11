import type {
  CoordinatorStorageControl,
  CoordinatorStorageData,
  CoordinatorValueResult,
  SessionCoordinatorClient,
  StorageAppContext,
  StorageConditionalCapabilitiesView,
  StorageConditionalCapabilityProbeResult,
  StorageDirectoryResult,
  StorageListResult,
  StorageProbeResult,
  StorageProviderConfigDraft,
  StorageProviderConnectionView,
  StorageProviderSummary,
  StoragePutResult,
  StorageService,
  StorageServiceStatus,
  StorageUploadAbortResult,
  StorageUploadBeginResult,
  StorageUploadPartResult,
} from "@keymaster/contracts";
import { StorageServiceError } from "./storageErrors.js";

type StateEvent = { topic: "storage.state"; sessionEpoch: string; status: StorageServiceStatus; summary: StorageProviderSummary | null; capabilities: StorageConditionalCapabilitiesView | null };

function unwrap<T>(result: CoordinatorValueResult<unknown>): Promise<T> {
  if (result.status === "ok") return Promise.resolve(result.value as T);
  if (result.status === "transport-error") throw new StorageServiceError("storage_unavailable", result.message || "Storage Coordinator request cancelled");
  const code = "code" in result && typeof result.code === "string" ? result.code as import("@keymaster/contracts").StorageErrorCode : undefined;
  const message = "message" in result && typeof result.message === "string"
    ? result.message
    : result.status === "blocked"
      ? (typeof result.reason === "string" ? result.reason : result.reason.fallback)
      : "Storage Coordinator request failed";
  throw new StorageServiceError(code ?? (result.status === "stale-epoch" || result.status === "locked" ? "storage_unavailable" : "storage_provider_error"), message);
}

/** Page-side facade. It owns no provider config, client, cursor, or S3 I/O. */
export class StorageServiceProxy implements StorageService {
  private current: StateEvent = { topic: "storage.state", sessionEpoch: "boot", status: "locked", summary: null, capabilities: null };
  private readonly listeners = new Set<() => void>();
  private readonly grants = new Map<string, Promise<string>>();
  private readonly unsubscribeState: () => void;

  constructor(private readonly coordinator: SessionCoordinatorClient) {
    this.unsubscribeState = coordinator.subscribeTopic("storage.state", (event: StateEvent) => {
      if (event.sessionEpoch !== this.current.sessionEpoch) this.grants.clear();
      this.current = event;
      for (const listener of this.listeners) listener();
    });
  }

  status(): StorageServiceStatus { return this.current.status; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose(): void { this.unsubscribeState(); this.listeners.clear(); }
  private control<T>(control: CoordinatorStorageControl): Promise<T> { return this.coordinator.storageControl(control).then(unwrap<T>); }
  private grantFor(ctx: StorageAppContext): Promise<string> {
    const key = `${ctx.connectSessionId}|${ctx.transportOrigin}|${ctx.appIdentity.identityDigestHex}`;
    const existing = this.grants.get(key); if (existing) return existing;
    const pending = this.coordinator.storageGrant(ctx).then(unwrap<string>).catch((error) => { this.grants.delete(key); throw error; });
    this.grants.set(key, pending); return pending;
  }
  private dataFor<T>(ctx: StorageAppContext, build: (grantId: string) => CoordinatorStorageData, transfer: ArrayBuffer[] = [], signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new StorageServiceError("storage_unavailable"));
    const key = `${ctx.connectSessionId}|${ctx.transportOrigin}|${ctx.appIdentity.identityDigestHex}`;
    return this.grantFor(ctx).then((grantId) => {
      if (signal?.aborted) throw new StorageServiceError("storage_unavailable");
      return this.coordinator.storageData(build(grantId), transfer, signal);
    }).then(unwrap<T>).catch((error) => {
      if (error instanceof StorageServiceError && (error.code === "storage_identity_required" || error.code === "storage_unavailable")) this.grants.delete(key);
      throw error;
    });
  }

  getProviderSummary(): Promise<StorageProviderSummary | null> { return Promise.resolve(this.current.summary); }
  getProviderConnection(): Promise<StorageProviderConnectionView | null> { return this.control({ type: "connection" }); }
  cancelProbe(): void { void this.control({ type: "cancel-probe" }); }
  probeProvider(config: StorageProviderConfigDraft): Promise<StorageProbeResult> { return this.control({ type: "probe", config }); }
  getConditionalCapabilities(): StorageConditionalCapabilitiesView | null { return this.current.capabilities; }
  probeConditionalCapabilities(signal?: AbortSignal): Promise<StorageConditionalCapabilityProbeResult> {
    if (signal?.aborted) return Promise.reject(new StorageServiceError("storage_unavailable"));
    const abort = () => { void this.control({ type: "cancel-probe" }).catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    return this.control<StorageConditionalCapabilityProbeResult>({ type: "probe-capabilities" }).finally(() => signal?.removeEventListener("abort", abort));
  }
  activateProvider(config: StorageProviderConfigDraft): Promise<StorageProbeResult> { return this.control({ type: "activate", config, expectedProviderGeneration: this.current.summary?.generation ?? null }); }
  clearProviderConfig(): Promise<void> { return this.control({ type: "clear", expectedProviderGeneration: this.current.summary?.generation ?? null }).then(() => undefined); }
  resetStorage(): Promise<void> { return this.control({ type: "reset", expectedProviderGeneration: this.current.summary?.generation ?? null }).then(() => undefined); }
  abortSession(connectSessionId: string): Promise<void> { return this.coordinator.storageSessionAbort(connectSessionId).then((result) => { if (result.status !== "ok") throw new StorageServiceError("storage_unavailable"); for (const key of this.grants.keys()) if (key.startsWith(`${connectSessionId}|`)) this.grants.delete(key); }); }

  list(ctx: StorageAppContext, input: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<StorageListResult> {
    return this.dataFor(ctx, (grantId) => ({ type: "list", grantId, input: { prefix: input.prefix, cursor: input.cursor, limit: input.limit } }), [], input.signal);
  }
  createDirectory(ctx: StorageAppContext, input: { path: string; overwrite?: boolean; signal?: AbortSignal }): Promise<StorageDirectoryResult> { return this.dataFor(ctx, (grantId) => ({ type: "create-directory", grantId, input: { path: input.path, overwrite: input.overwrite } }), [], input.signal); }
  deleteDirectory(ctx: StorageAppContext, input: { path: string; signal?: AbortSignal }): Promise<StorageDirectoryResult> { return this.dataFor(ctx, (grantId) => ({ type: "delete-directory", grantId, input: { path: input.path } }), [], input.signal); }
  put(ctx: StorageAppContext, input: { path: string; content: { $type: "binary"; bytes: ArrayBuffer; mime?: string }; contentType?: string; overwrite?: boolean; signal?: AbortSignal }): Promise<StoragePutResult> {
    return this.dataFor(ctx, (grantId) => ({ type: "put", grantId, input: { path: input.path, content: input.content, contentType: input.contentType, overwrite: input.overwrite } }), [input.content.bytes], input.signal);
  }
  getRange(ctx: StorageAppContext, input: { path: string; offset?: number; length?: number; ifMatch?: string; signal?: AbortSignal }) { return this.dataFor<Awaited<ReturnType<StorageService["getRange"]>>>(ctx, (grantId) => ({ type: "get-range", grantId, input: { path: input.path, offset: input.offset, length: input.length, ifMatch: input.ifMatch } }), [], input.signal); }
  delete(ctx: StorageAppContext, input: { path: string; signal?: AbortSignal }) { return this.dataFor<Awaited<ReturnType<StorageService["delete"]>>>(ctx, (grantId) => ({ type: "delete", grantId, input: { path: input.path } }), [], input.signal); }
  beginUpload(ctx: StorageAppContext, input: { path: string; contentType?: string; size: number; overwrite?: boolean; signal?: AbortSignal }): Promise<StorageUploadBeginResult> { return this.dataFor(ctx, (grantId) => ({ type: "begin-upload", grantId, input: { path: input.path, contentType: input.contentType, size: input.size, overwrite: input.overwrite } }), [], input.signal); }
  uploadPart(ctx: StorageAppContext, input: { uploadId: string; partNumber: number; content: { $type: "binary"; bytes: ArrayBuffer; mime?: string }; signal?: AbortSignal }): Promise<StorageUploadPartResult> { return this.dataFor(ctx, (grantId) => ({ type: "upload-part", grantId, input: { uploadId: input.uploadId, partNumber: input.partNumber, content: input.content } }), [input.content.bytes], input.signal); }
  completeUpload(ctx: StorageAppContext, input: { uploadId: string; signal?: AbortSignal }) { return this.dataFor<Awaited<ReturnType<StorageService["completeUpload"]>>>(ctx, (grantId) => ({ type: "complete-upload", grantId, input: { uploadId: input.uploadId } }), [], input.signal); }
  abortUpload(ctx: StorageAppContext, input: { uploadId: string; signal?: AbortSignal }): Promise<StorageUploadAbortResult> { return this.dataFor(ctx, (grantId) => ({ type: "abort-upload", grantId, input: { uploadId: input.uploadId } }), [], input.signal); }
}
