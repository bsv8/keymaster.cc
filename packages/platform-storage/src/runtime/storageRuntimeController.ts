import type {
  NormalizedStorageProviderConfig,
  OwnerAppStorageGrant,
  StorageDeleteResult,
  BucketConditionalCapabilitiesView,
  BucketConditionalCapabilityProbeResult,
  StorageDirectoryResult,
  StorageListResult,
  StorageProbeResult,
  StorageProviderConfigDraft,
  StorageProviderConnectionView,
  StorageProviderSummary,
  StoragePutResult,
  StorageRuntimeController as StorageRuntimeControllerContract,
  StorageRuntimeControllerStatus,
  StorageBucketProvider,
  StorageUploadAbortResult,
  StorageUploadBeginResult,
  StorageUploadPartResult,
  StorageSecretService
} from "@keymaster/contracts";
import { deriveThirdPartyApplicationStorageId } from "@keymaster/contracts";
import {
  STORAGE_CURSOR_TTL_MS,
  STORAGE_MAX_CURSORS_GLOBAL,
  STORAGE_MAX_CURSORS_PER_SESSION,
  STORAGE_DEFAULT_LIST_LIMIT,
  STORAGE_MAX_LIST_LIMIT,
  STORAGE_MAX_PARTS,
  STORAGE_MAX_PAYLOAD_BYTES,
  STORAGE_PART_SIZE_BYTES,
  STORAGE_UPLOAD_TTL_MS
} from "@keymaster/contracts";
import type { BucketListOutput, BucketObjectStore, BucketObjectStoreCapabilityState } from "../bucket-providers/bucketObjectStore.js";
import { createBucketObjectStoreCapabilityState, setBucketObjectStoreCapabilityMode } from "../bucket-providers/bucketObjectStore.js";
import { createS3BucketObjectStore } from "../bucket-providers/s3/s3BucketObjectStore.js";
import { createProviderBackedBucketObjectStore } from "../bucket-providers/providerBackedBucketObjectStore.js";
import type { MultipartUploadRepository, StoredMultipartUploadRecord, StoredProviderConfigRecord } from "../bootstrap/multipartUploadRepository.js";
import { configFromBytes, configToBytes, normalizeProviderConfig, summaryForConfig } from "../bucket-providers/s3/s3ClientFactory.js";
import { buildKeyForContext, buildOwnerAppNamespaceRoot } from "../storage-access/owner-app/ownerAppNamespace.js";
import { basename, normalizeDirectoryPath, normalizeObjectPath, stripRoot, StoragePathError } from "../bucket-providers/bucketPath.js";
import { StorageRuntimeError, storageErrorCode } from "./storageRuntimeError.js";

export const STORAGE_SECRET_SCOPE = "keymaster.storage.provider-config.v1";

export interface StorageRuntimeSnapshot {
  status: StorageRuntimeControllerStatus;
  /** 独立于 Vault 的统一桶健康状态。 */
  healthStatus?: import("@keymaster/contracts").StorageRuntimeStatus;
  summary: StorageProviderSummary | null;
  capabilities?: BucketConditionalCapabilitiesView | null;
}

interface CursorRecord {
  connectSessionId: string;
  transportOrigin: string;
  root: string;
  relativePrefix: string;
  limit: number;
  generation: number;
  continuationToken?: string;
  expiresAt: number;
}

interface RuntimeUpload {
  s3UploadId: string;
  key: string;
  namespaceRoot: string;
  connectSessionId: string;
}

export interface StorageRuntimeControllerDeps {
  multipartUploadRepository: MultipartUploadRepository;
  /** Coordinator 已启动的唯一抽象桶 Provider；提供后文件 API 与 K-V 共桶。 */
  bucketProvider?: StorageBucketProvider;
  /** 当前抽象桶世代；用于 multipart 和 cursor 的失效判断。 */
  bucketGeneration?: number;
  /** 独立于 Vault 的 Storage Profile 密钥服务。 */
  secret: StorageSecretService;
  objectStoreFactory?: (config: NormalizedStorageProviderConfig, capabilityState?: BucketObjectStoreCapabilityState) => BucketObjectStore;
  now?: () => number;
  generateId?: () => string;
  logger?: { info?: (event: unknown) => void; warn?: (event: unknown) => void; error?: (event: unknown) => void };
}

function id(deps: StorageRuntimeControllerDeps, prefix: string): string {
  return deps.generateId ? `${prefix}-${deps.generateId()}` : `${prefix}-${crypto.randomUUID()}`;
}

function now(deps: StorageRuntimeControllerDeps): number { return deps.now?.() ?? Date.now(); }

function asError(error: unknown): StorageRuntimeError {
  if (error instanceof StorageRuntimeError) return error;
  const code = storageErrorCode(error);
  if (code) return new StorageRuntimeError(code);
  if (error instanceof StoragePathError) return new StorageRuntimeError("storage_invalid_path", error.message);
  return new StorageRuntimeError("storage_provider_error");
}

function diagnostic(error: unknown): StorageProbeResult["diagnostic"] {
  if (error instanceof StorageRuntimeError && error.diagnostic) return error.diagnostic;
  const code = storageErrorCode(error);
  if (code === "storage_forbidden") return "forbidden";
  if (code === "storage_not_found") return "not-found";
  if (code === "storage_unavailable") return "network";
  if (code === "storage_provider_error") return "provider";
  return "configuration";
}

function capabilityView(state: BucketObjectStoreCapabilityState, generation: number): BucketConditionalCapabilitiesView {
  return {
    generation,
    put: { mode: state.put.mode, source: state.put.source, updatedAt: state.put.updatedAt },
    complete: { mode: state.complete.mode, source: state.complete.source, updatedAt: state.complete.updatedAt }
  };
}

function assertLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageRuntimeError("storage_limit_exceeded", `${name} is invalid`);
}

function rootForUploadRecord(config: NormalizedStorageProviderConfig, record: StoredMultipartUploadRecord): string {
  void config;
  return buildOwnerAppNamespaceRoot(record);
}

export class StorageRuntimeControllerImpl implements StorageRuntimeControllerContract {
  private readonly listeners = new Set<() => void>();
  private readonly cursors = new Map<string, CursorRecord>();
  private readonly runtimeUploads = new Map<string, RuntimeUpload>();
  private activeConfig?: NormalizedStorageProviderConfig;
  private activeStore?: BucketObjectStore;
  private activeCapabilityState?: BucketObjectStoreCapabilityState;
  private activeCapabilityUnsubscribe?: () => void;
  private activeRecord: StoredProviderConfigRecord | null = null;
  private currentStatus: StorageRuntimeControllerStatus = "unconfigured";
  private mutation: Promise<void> = Promise.resolve();
  private probeController?: AbortController;
  private capabilityProbeController?: AbortController;
  private rotationAbortController = new AbortController();
  private rotationActive = false;
  private lifecycleFence = 0;
  private readonly pendingRequests = new Set<Promise<void>>();
  private readonly uploadLocks = new Map<string, Promise<void>>();
  private disposed = false;

  private constructor(private readonly deps: StorageRuntimeControllerDeps) {}

  static async create(deps: StorageRuntimeControllerDeps): Promise<StorageRuntimeControllerImpl> {
    const service = new StorageRuntimeControllerImpl(deps);
    await service.loadPersistedConfig();
    return service;
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
  private setStatus(status: StorageRuntimeControllerStatus): void { if (this.currentStatus === status) return; this.currentStatus = status; this.emit(); }
  status(): StorageRuntimeControllerStatus { return this.currentStatus; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private beginReconfiguration(reason: string): void {
    if (this.rotationActive || this.disposed) return;
    this.rotationActive = true;
    this.lifecycleFence += 1;
    this.rotationAbortController.abort();
    this.rotationAbortController = new AbortController();
    this.probeController?.abort();
    this.capabilityProbeController?.abort();
    this.cursors.clear();
    this.setStatus("reconfiguring");
    this.deps.logger?.info?.({ scope: "storage", event: "runtime.reconfiguring", reason });
  }

  /** Coordinator-owned password rotation barrier; no cross-context channel. */
  async beginPasswordRotation(): Promise<void> {
    this.beginReconfiguration("password rotation");
    // A non-cooperating provider must not wedge Vault password rotation. The
    // request/generation fences reject any completion that arrives later.
    await this.waitForRequestsBounded(250);
  }

  finishPasswordRotation(degraded = false): void { this.finishReconfiguration(degraded); }


  private trackRequest<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const marker = new Promise<void>((resolve) => { release = resolve; });
    this.pendingRequests.add(marker);
    return Promise.resolve()
      .then(operation)
      .catch((error) => {
        // Normalize path failures at the service boundary for every CRUD,
        // listing, and multipart path entrance.
        if (error instanceof StoragePathError) throw new StorageRuntimeError("storage_invalid_path", error.message);
        throw error;
      })
      .finally(() => {
        this.pendingRequests.delete(marker);
        release();
      });
  }

  private async waitForRequests(): Promise<void> {
    while (this.pendingRequests.size > 0) {
      await Promise.all([...this.pendingRequests]);
    }
  }

  private async waitForRequestsBounded(timeoutMs = 250): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.waitForRequests(), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  private finishReconfiguration(degraded = false): void {
    if (!this.rotationActive || this.disposed) return;
    this.rotationActive = false;
    this.rotationAbortController = new AbortController();
    if (degraded && this.activeRecord) {
      this.setStatus("degraded");
    } else if (this.activeStore && this.activeConfig && this.activeRecord) {
      this.setStatus("ready");
    } else if (this.activeRecord) {
      void this.restoreAfterUnlock();
    } else {
      this.setStatus("unconfigured");
    }
  }

  private requestSignal(input?: AbortSignal): AbortSignal {
    if (this.rotationActive || this.currentStatus === "reconfiguring") {
      throw new StorageRuntimeError("storage_unavailable", "Storage is temporarily unavailable during password rotation");
    }
    if (!input) return this.rotationAbortController.signal;
    if (typeof AbortSignal.any === "function") return AbortSignal.any([input, this.rotationAbortController.signal]);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.aborted || this.rotationAbortController.signal.aborted) abort();
    else {
      input.addEventListener("abort", abort, { once: true });
      this.rotationAbortController.signal.addEventListener("abort", abort, { once: true });
    }
    return controller.signal;
  }

  private assertRequestActive(signal: AbortSignal): void {
    if (this.rotationActive || signal.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
  }

  private async loadPersistedConfig(): Promise<void> {
    this.activeRecord = await this.deps.multipartUploadRepository.getProviderConfig();
    if (this.deps.bucketProvider) {
      // Provider 已由 StorageBootstrapController 探测并绑定。这里不能再
      // 根据旧的 Connect 配置创建第二个 S3 client；文件 API 必须复用同一
      // 个抽象桶。旧配置只作为设置页摘要保留。
      const capabilityState = this.activeCapabilityState ?? createBucketObjectStoreCapabilityState();
      this.activeConfig = this.unifiedRuntimeConfig();
      this.activeStore = this.makeActiveStore(capabilityState);
      this.activeCapabilityState = capabilityState;
      this.bindCapabilityState(capabilityState);
      this.setStatus("ready");
      await this.restoreRuntimeUploads(this.activeConfig);
      await this.cleanupStaleUploads();
      return;
    }
    if (!this.activeRecord) { this.setStatus("unconfigured"); return; }
    this.setStatus("reconfiguring");
    await this.restoreAfterUnlock();
  }

  private releaseRuntime(reason: string): void {
    // Lock/reconfiguration is a hard lifecycle boundary. Abort the runtime
    // controller before dropping the client so late provider completions cannot
    // pass the request gate after Vault lock.
    this.rotationAbortController.abort();
    this.lifecycleFence += 1;
    this.rotationAbortController = new AbortController();
    this.capabilityProbeController?.abort();
    const store = this.activeStore;
    this.cursors.clear();
    this.activeStore = undefined;
    this.activeConfig = undefined;
    if (this.activeRecord) this.setStatus("locked");
    else this.setStatus("unconfigured");
    try { store?.dispose(); } catch { /* best effort */ }
    // Remote multipart cleanup is intentionally not awaited here. Durable
    // orphan records are retried after the next unlock.
    this.deps.logger?.info?.({ scope: "storage", event: "runtime.released", reason });
  }

  private async restoreAfterUnlock(): Promise<void> {
    return this.trackRequest(async () => {
    if (this.deps.bucketProvider) {
      // 统一抽象桶已经在 bootstrap 阶段完成认证和探测，不能再根据
      // `keymaster.storage` 中的旧配置打开第二个 Provider。
      this.setStatus("ready");
      return;
    }
    if (this.disposed || this.rotationActive || !this.activeRecord) return;
    this.setStatus("reconfiguring");
    try {
      const bytes = await this.deps.secret.open(STORAGE_SECRET_SCOPE, this.activeRecord.sealedConfig);
      try {
        const config = configFromBytes(bytes);
        const capabilityState = this.activeCapabilityState ?? createBucketObjectStoreCapabilityState();
        const store = this.makeStore(config, capabilityState);
        try {
          await this.boundedProvider(() => store.probe("", this.rotationAbortController.signal), this.rotationAbortController);
          this.assertRequestActive(this.rotationAbortController.signal);
          if (this.disposed) throw new StorageRuntimeError("storage_unavailable", "Storage runtime is disposed");
        } catch (error) {
          try { store.dispose(); } catch { /* best effort */ }
          throw error;
        }
        this.activeConfig = config;
        this.activeStore = store;
        this.activeCapabilityState = capabilityState;
        this.bindCapabilityState(capabilityState);
        this.setStatus("ready");
        await this.restoreRuntimeUploads(config);
        await this.cleanupStaleUploads();
      } finally { bytes.fill(0); }
    } catch (error) {
      this.releaseRuntime("restore failed");
      const profileLocked = error instanceof Error && error.message === "Storage Profile is unavailable";
      this.setStatus(this.rotationActive ? "reconfiguring" : profileLocked ? "locked" : "degraded");
      this.deps.logger?.warn?.({ scope: "storage", event: "restore.failed", code: storageErrorCode(error) });
    }
    });
  }

  private makeStore(config: NormalizedStorageProviderConfig, capabilityState = createBucketObjectStoreCapabilityState()): BucketObjectStore {
    return this.deps.objectStoreFactory ? this.deps.objectStoreFactory(config, capabilityState) : createS3BucketObjectStore(config, { capabilityState });
  }

  private makeActiveStore(capabilityState = createBucketObjectStoreCapabilityState()): BucketObjectStore {
    return this.deps.bucketProvider
      ? createProviderBackedBucketObjectStore(this.deps.bucketProvider, capabilityState)
      : this.makeStore(this.activeConfig!, capabilityState);
  }

  private unifiedRuntimeConfig(): NormalizedStorageProviderConfig {
    // 统一 Provider 模式的文件运行时只把此配置作为类型和诊断占位，
    // 真正的连接、凭据和读写均由 bucketProvider 持有，绝不使用这些值
    // 创建新的客户端。
    return {
      version: 1,
      providerId: this.deps.bucketProvider?.provider === "s3" ? "aws-s3" : "s3-compatible",
      connection: { endpoint: "https://unified.storage.invalid", region: "keymaster", bucket: this.deps.bucketProvider?.bucketId ?? "unified", forcePathStyle: true },
      credentials: { kind: "access-key", accessKeyId: "unified", secretAccessKey: "unified" }
    };
  }

  private runtimeGeneration(): number {
    return this.deps.bucketGeneration ?? this.activeRecord?.generation ?? 1;
  }

  private runtimeRecord(): StoredProviderConfigRecord {
    if (this.activeRecord && !this.deps.bucketProvider) return this.activeRecord;
    if (this.activeRecord && this.deps.bucketProvider) return { ...this.activeRecord, generation: this.runtimeGeneration() };
    return {
      key: "active",
      providerId: this.unifiedRuntimeConfig().providerId,
      publicSummary: { bucketHint: this.deps.bucketProvider?.bucketId ?? "unified", accessKeyHint: "unified" },
      sealedConfig: { version: 2, saltHex: "", nonceHex: "", ciphertextHex: "" },
      generation: this.runtimeGeneration(),
      updatedAt: 0
    };
  }

  private rememberRuntimeUpload(record: StoredMultipartUploadRecord, config: NormalizedStorageProviderConfig, s3UploadId: string): void {
    this.runtimeUploads.set(record.internalUploadId, {
      s3UploadId,
      key: record.physicalKey,
      namespaceRoot: rootForUploadRecord(config, record),
      connectSessionId: record.connectSessionId
    });
  }

  private async restoreRuntimeUploads(config: NormalizedStorageProviderConfig): Promise<void> {
    for (const record of await this.deps.multipartUploadRepository.listMultiparts()) {
      if (record.providerGeneration !== this.runtimeGeneration()) continue;
      try {
        const bytes = await this.deps.secret.open(`keymaster.storage.upload.v1/${record.internalUploadId}`, record.sealedS3UploadId);
        try { this.rememberRuntimeUpload(record, config, new TextDecoder().decode(bytes)); } finally { bytes.fill(0); }
      } catch (error) {
        this.deps.logger?.warn?.({ scope: "storage", event: "upload_runtime_restore.failed", uploadId: record.internalUploadId, code: storageErrorCode(error) });
      }
    }
  }

  private requireReady(): { config: NormalizedStorageProviderConfig; store: BucketObjectStore; record: StoredProviderConfigRecord } {
    if (this.currentStatus === "unconfigured" || (!this.activeRecord && !this.deps.bucketProvider)) throw new StorageRuntimeError("storage_not_configured");
    if (this.currentStatus !== "ready" || !this.activeConfig || !this.activeStore) throw new StorageRuntimeError("storage_unavailable");
    return { config: this.activeConfig, store: this.activeStore, record: this.runtimeRecord() };
  }

  private contextRoot(ctx: OwnerAppStorageGrant): string {
    this.requireReady();
    return buildOwnerAppNamespaceRoot(ctx);
  }

  private assertContext(ctx: OwnerAppStorageGrant): string {
    if (!ctx.connectSessionId || !ctx.transportOrigin || !ctx.sessionEpoch || !ctx.appIdentity?.identityDigestHex || !/^[0-9a-f]{64}$/u.test(ctx.appIdentity.identityDigestHex)) throw new StorageRuntimeError("storage_identity_required");
    if (!/^(02|03)[0-9a-f]{64}$/u.test(ctx.ownerPublicKeyHex) || !Number.isSafeInteger(ctx.bucketGeneration) || ctx.bucketGeneration < 1 || !ctx.bucketId || ctx.bucketId.includes("/")) throw new StorageRuntimeError("storage_identity_required");
    let derivedId: string;
    try { derivedId = deriveThirdPartyApplicationStorageId(ctx.appIdentity.publisherPublicKeyHex, ctx.appIdentity.appId); }
    catch { throw new StorageRuntimeError("storage_identity_required"); }
    if (derivedId !== ctx.applicationStorageId) throw new StorageRuntimeError("storage_identity_required");
    return this.contextRoot(ctx);
  }

  private pruneCursors(nowValue = now(this.deps)): void {
    for (const [token, cursor] of this.cursors) if (cursor.expiresAt <= nowValue) this.cursors.delete(token);
    const bySession = new Map<string, string[]>();
    for (const [token, cursor] of this.cursors) {
      const list = bySession.get(cursor.connectSessionId) ?? [];
      list.push(token); bySession.set(cursor.connectSessionId, list);
    }
    for (const tokens of bySession.values()) while (tokens.length > STORAGE_MAX_CURSORS_PER_SESSION) this.cursors.delete(tokens.shift()!);
    while (this.cursors.size > STORAGE_MAX_CURSORS_GLOBAL) {
      const oldest = this.cursors.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cursors.delete(oldest);
    }
  }

  async getProviderSummary(): Promise<StorageProviderSummary | null> {
    return this.activeRecord?.publicSummary ? {
      providerId: this.activeRecord.providerId as StorageProviderSummary["providerId"],
      bucketHint: this.activeRecord.publicSummary.bucketHint,
      endpointHint: this.activeRecord.publicSummary.endpointHint,
      accessKeyHint: this.activeRecord.publicSummary.accessKeyHint,
      secretConfigured: true,
      generation: this.activeRecord.generation,
      updatedAt: this.activeRecord.updatedAt
    } : null;
  }

  async getProviderConnection(): Promise<StorageProviderConnectionView | null> {
    const config = this.activeConfig ?? await this.readExistingConfig();
    if (!config) return null;
    return { providerId: config.providerId, connection: structuredClone(config.connection) };
  }

  private bindCapabilityState(state: BucketObjectStoreCapabilityState): void {
    this.activeCapabilityUnsubscribe?.();
    this.activeCapabilityUnsubscribe = state.subscribe?.(() => this.emit());
  }

  getConditionalCapabilities(): BucketConditionalCapabilitiesView | null {
    if ((!this.activeRecord && !this.deps.bucketProvider) || !this.activeCapabilityState) return null;
    return capabilityView(this.activeCapabilityState, this.runtimeGeneration());
  }

  cancelProbe(): void {
    this.probeController?.abort();
    this.capabilityProbeController?.abort();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.then(() => undefined, () => undefined);
    return next;
  }

  async probeProvider(draft: StorageProviderConfigDraft): Promise<StorageProbeResult> {
    this.probeController?.abort();
    const controller = new AbortController();
    this.probeController = controller;
    return this.enqueue(async () => {
      const started = now(this.deps);
      try {
        if (this.rotationActive) throw new StorageRuntimeError("storage_unavailable", "Storage is temporarily unavailable during password rotation");
        const signal = this.requestSignal(controller.signal);
        const persistedUnifiedConfig = this.deps.bucketProvider && this.activeRecord ? await this.readExistingConfig() : null;
        const existing = persistedUnifiedConfig ?? this.activeConfig ?? await this.readExistingConfig();
        const config = normalizeProviderConfig(draft, existing ?? undefined);
        if (this.deps.bucketProvider?.provider === "opfs") {
          throw new StorageRuntimeError("storage_provider_error", "The active OPFS bucket cannot be replaced while the runtime is running");
        }
        if (this.deps.bucketProvider && persistedUnifiedConfig && (
          persistedUnifiedConfig.providerId !== config.providerId ||
          JSON.stringify(persistedUnifiedConfig.connection) !== JSON.stringify(config.connection) ||
          JSON.stringify(persistedUnifiedConfig.credentials) !== JSON.stringify(config.credentials)
        )) {
          throw new StorageRuntimeError("storage_provider_error", "The selected storage bucket is already bound; reselect the backend before changing its Profile");
        }
        const candidate = this.makeStore(config);
        try {
          await this.boundedProvider(() => candidate.probe("", signal), controller);
          this.assertRequestActive(signal);
        } finally { candidate.dispose(); }
        return { ok: true, providerId: config.providerId, latencyMs: Math.max(0, now(this.deps) - started) };
      } catch (error) {
        return { ok: false, providerId: draft.providerId, latencyMs: Math.max(0, now(this.deps) - started), diagnostic: diagnostic(asError(error)) };
      } finally {
        if (this.probeController === controller) this.probeController = undefined;
      }
    });
  }

  private async probeConditionalPut(store: BucketObjectStore, root: string, key: string, signal: AbortSignal, state: BucketObjectStoreCapabilityState): Promise<"native" | "best-effort" | "inconclusive"> {
    try {
      await store.put({ namespaceRoot: root, key, bytes: new Uint8Array([1]), contentType: "application/octet-stream", ifNoneMatch: "*", signal });
    } catch {
      return state.put.mode === "best-effort" ? "best-effort" : "inconclusive";
    }
    if (state.put.mode === "best-effort") return "best-effort";
    try {
      await store.put({ namespaceRoot: root, key, bytes: new Uint8Array([2]), contentType: "application/octet-stream", ifNoneMatch: "*", signal });
    } catch (error) {
      return error instanceof StorageRuntimeError && error.code === "storage_conflict" ? "native" : "inconclusive";
    }
    return "best-effort";
  }

  private async probeConditionalComplete(store: BucketObjectStore, root: string, key: string, signal: AbortSignal, state: BucketObjectStoreCapabilityState, uploadIds: Set<string>): Promise<"native" | "best-effort" | "inconclusive"> {
    const run = async (): Promise<{ status: "success" | "error"; error?: unknown }> => {
      let uploadId: string | undefined;
      try {
        uploadId = await store.createMultipart({ namespaceRoot: root, key, contentType: "application/octet-stream", signal });
        uploadIds.add(uploadId);
        const etag = await store.uploadPart({ namespaceRoot: root, key, uploadId, partNumber: 1, bytes: new Uint8Array([1]), signal });
        await store.completeMultipart({ namespaceRoot: root, key, uploadId, parts: [{ partNumber: 1, etag }], ifNoneMatch: "*", signal });
        uploadIds.delete(uploadId);
        return { status: "success" };
      } catch (error) {
        return { status: "error", error };
      } finally {
        if (uploadId && uploadIds.has(uploadId)) {
          try { await this.boundedCleanup(() => store.abortMultipart({ namespaceRoot: root, key, uploadId: uploadId!, signal })); } catch { /* aggregated by caller cleanup */ }
        }
      }
    };
    const first = await run();
    if (first.status === "error") return state.complete.mode === "best-effort" ? "best-effort" : "inconclusive";
    if (state.complete.mode === "best-effort") return "best-effort";
    const second = await run();
    if (second.status === "success") return "best-effort";
    return second.error instanceof StorageRuntimeError && second.error.code === "storage_conflict" ? "native" : "inconclusive";
  }

  async probeConditionalCapabilities(inputSignal?: AbortSignal): Promise<BucketConditionalCapabilityProbeResult> {
    this.capabilityProbeController?.abort();
    const controller = new AbortController();
    this.capabilityProbeController = controller;
    let signal: AbortSignal = controller.signal;
    if (inputSignal) {
      if (typeof AbortSignal.any === "function") signal = AbortSignal.any([inputSignal, controller.signal]);
      else {
        const abort = () => controller.abort();
        if (inputSignal.aborted) controller.abort();
        else inputSignal.addEventListener("abort", abort, { once: true });
      }
    }
    const operation = this.trackRequest(async () => {
      const record = this.runtimeRecord();
      const config = this.activeConfig;
      const state = this.activeCapabilityState;
      if (!config || !state || this.currentStatus !== "ready" || this.rotationActive) throw new StorageRuntimeError("storage_unavailable", "Storage is not ready");
      const generation = this.runtimeGeneration();
      const stateIdentity = state;
      const root = `.keymaster-system/capability-probe/${crypto.randomUUID()}/`;
      const probeState = createBucketObjectStoreCapabilityState();
      const store = this.deps.bucketProvider
        ? createProviderBackedBucketObjectStore(this.deps.bucketProvider, probeState)
        : this.makeStore(config, probeState);
      const keys = { put: `${root}put.bin`, complete: `${root}complete.bin` };
      const uploadIds = new Set<string>();
      const cleanupErrors: unknown[] = [];
      let put: "native" | "best-effort" | "inconclusive" = "inconclusive";
      let complete: "native" | "best-effort" | "inconclusive" = "inconclusive";
      let mainError: unknown;
      try {
        put = await this.boundedProvider(() => this.probeConditionalPut(store, root, keys.put, signal, probeState), controller);
        complete = await this.boundedProvider(() => this.probeConditionalComplete(store, root, keys.complete, signal, probeState, uploadIds), controller);
        if (signal.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
        const current = this.runtimeGeneration() === generation && this.activeCapabilityState === stateIdentity && this.currentStatus === "ready" && !this.rotationActive && !signal.aborted;
        if (!current) throw new StorageRuntimeError("storage_unavailable", "Storage capability detection was cancelled");
        if (put !== "inconclusive") setBucketObjectStoreCapabilityMode(state, "put", put, "manual");
        if (complete !== "inconclusive") setBucketObjectStoreCapabilityMode(state, "complete", complete, "manual");
      } catch (error) {
        mainError = error;
      } finally {
        for (const uploadId of uploadIds) {
          try { await this.boundedCleanup(() => store.abortMultipart({ namespaceRoot: root, key: keys.complete, uploadId })); } catch (error) { cleanupErrors.push(error); }
        }
        for (const key of [keys.put, keys.complete]) {
          try { await this.boundedCleanup(() => store.delete({ namespaceRoot: root, key })); } catch (error) { cleanupErrors.push(error); }
        }
        try { store.dispose(); } catch (error) { cleanupErrors.push(error); }
        if (this.capabilityProbeController === controller) this.capabilityProbeController = undefined;
      }
      if (cleanupErrors.length) this.deps.logger?.warn?.({ scope: "storage", event: "capability_probe.cleanup_failed", code: "storage_provider_error", count: cleanupErrors.length });
      if (mainError) throw asError(mainError);
      return { generation, put, complete, cleanupWarning: cleanupErrors.length > 0 };
    });
    return operation.finally(() => {
      if (this.capabilityProbeController === controller) this.capabilityProbeController = undefined;
    });
  }

  /**
   * 在 Coordinator 更新独立密钥后重新打开已保存的 Provider。
   *
   * 密码本身不进入 Runtime；Runtime 只通过注入的 StorageSecretService
   * 读取当前密钥。这样冷启动时可以先显示脱敏摘要，再由用户输入密码。
   */
  async unlockStorageProfile(password: string): Promise<StorageProbeResult> {
    return this.trackRequest(async () => {
      const started = now(this.deps);
      if (typeof password !== "string" || password.length < 8) {
        throw new StorageRuntimeError("storage_provider_error", "Storage Profile password must contain at least 8 characters", "authentication");
      }
      if (this.deps.bucketProvider) {
        return { ok: this.currentStatus === "ready", providerId: this.deps.bucketProvider.provider === "s3" ? "aws-s3" : "s3-compatible", latencyMs: Math.max(0, now(this.deps) - started), ...(this.currentStatus === "ready" ? {} : { diagnostic: "authentication" as const }) };
      }
      const record = this.activeRecord;
      if (!record) {
        return { ok: false, providerId: "aws-s3", latencyMs: Math.max(0, now(this.deps) - started), diagnostic: "configuration" };
      }
      await this.restoreAfterUnlock();
      const providerId = record.providerId as StorageProbeResult["providerId"];
      return this.currentStatus === "ready"
        ? { ok: true, providerId, latencyMs: Math.max(0, now(this.deps) - started) }
        : { ok: false, providerId, latencyMs: Math.max(0, now(this.deps) - started), diagnostic: "authentication" };
    });
  }

  // 这些两个入口由 Coordinator 页面代理实现；Worker 内部 Runtime 不负责
  // 修改本机 bootstrap 状态，保留明确的 fail-closed 实现避免误用。
  async selectOpfs(): Promise<StorageProbeResult> {
    return { ok: false, providerId: "s3-compatible", latencyMs: 0, diagnostic: "configuration" };
  }

  async importStorageProfile(_envelope: import("@keymaster/contracts").StorageProfileEnvelopeV1, password: string): Promise<StorageProbeResult> {
    return this.unlockStorageProfile(password);
  }

  private async readExistingConfig(): Promise<NormalizedStorageProviderConfig | null> {
    const record = await this.deps.multipartUploadRepository.getProviderConfig();
    if (!record) return null;
    const bytes = await this.deps.secret.open(STORAGE_SECRET_SCOPE, record.sealedConfig);
    try { return configFromBytes(bytes); } finally { bytes.fill(0); }
  }

  async activateProvider(draft: StorageProviderConfigDraft): Promise<StorageProbeResult> {
    return this.enqueue(async () => {
      const started = now(this.deps);
      if (this.rotationActive) throw new StorageRuntimeError("storage_unavailable", "Storage is temporarily unavailable during password rotation");
      this.rotationActive = true;
      this.lifecycleFence += 1;
      this.rotationAbortController.abort();
      this.rotationAbortController = new AbortController();
      this.cursors.clear();
      this.setStatus("reconfiguring");
      await this.waitForRequestsBounded();
      this.capabilityProbeController?.abort();
      this.setStatus("checking");
      let candidate: BucketObjectStore | undefined;
      try {
        if (this.deps.bucketProvider) {
          throw new StorageRuntimeError("storage_provider_error", "Active storage bucket changes require a restart; the current root remains bound until then");
        }
        const existing = this.activeConfig ?? await this.readExistingConfig();
        const config = normalizeProviderConfig(draft, existing ?? undefined);
        const capabilityState = createBucketObjectStoreCapabilityState();
        candidate = this.makeStore(config, capabilityState);
        const signal = this.rotationAbortController.signal;
        await this.boundedProvider(() => candidate!.probe("", signal), this.rotationAbortController);
        if (signal.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
        const configBytes = configToBytes(config);
        let sealedConfig;
        try { sealedConfig = await this.deps.secret.seal(STORAGE_SECRET_SCOPE, configBytes); }
        finally { configBytes.fill(0); }
        const generation = (this.activeRecord?.generation ?? 0) + 1;
        const updatedAt = now(this.deps);
        const summary = summaryForConfig(config, generation, updatedAt);
        const record: StoredProviderConfigRecord = { key: "active", providerId: config.providerId, publicSummary: { bucketHint: summary.bucketHint, endpointHint: summary.endpointHint, accessKeyHint: summary.accessKeyHint }, sealedConfig, generation, updatedAt };
        const oldStore = this.activeStore;
        const oldConfig = this.activeConfig;
        const oldGeneration = this.activeRecord?.generation;
        // Commit the new configuration before retiring the old provider. A
        // failed K-V commit must leave both the old provider and its uploads
        // untouched; cleanup after commit is deliberately best effort because
        // the new configuration is already the durable truth at that point.
        await this.deps.multipartUploadRepository.replaceProviderConfig(record);
        this.activeRecord = record;
        this.activeConfig = config;
        this.activeStore = candidate;
        this.activeCapabilityState = capabilityState;
        this.bindCapabilityState(capabilityState);
        this.rotationActive = false;
        this.rotationAbortController = new AbortController();
        candidate = undefined;
        this.cursors.clear();
        this.setStatus("ready");
        if (oldStore && oldConfig) {
          const cleanup = this.abortKnownUploads(oldStore, oldConfig, false, oldGeneration).catch((error) => { this.deps.logger?.warn?.({ scope: "storage", event: "provider_replace_cleanup.failed", code: storageErrorCode(error) }); });
          this.disposeAfterCleanup(cleanup, oldStore);
        }
        try {
          await this.cleanupStaleUploads();
        } catch (error) {
          // Do not report save failure after the new record has committed.
          this.deps.logger?.warn?.({ scope: "storage", event: "stale_upload_cleanup.failed", code: storageErrorCode(error) });
        }
        return { ok: true, providerId: config.providerId, latencyMs: Math.max(0, now(this.deps) - started) };
      } catch (error) {
        try { candidate?.dispose(); } catch { /* best effort */ }
        this.rotationActive = false;
        this.rotationAbortController = new AbortController();
        this.setStatus(this.activeStore && this.activeConfig ? "ready" : this.activeRecord ? "degraded" : "unconfigured");
        const mapped = asError(error);
        throw mapped;
      }
    });
  }

  async clearProviderConfig(): Promise<void> {
    return this.enqueue(async () => {
      this.capabilityProbeController?.abort();
      if (this.rotationActive) throw new StorageRuntimeError("storage_unavailable", "Storage is temporarily unavailable during password rotation");
      if (this.deps.bucketProvider) {
        throw new StorageRuntimeError("storage_provider_error", "The active bucket cannot be switched while the runtime is running; restart after selecting another backend");
      }
      if (!this.activeRecord) {
        this.releaseRuntime("cleared");
        return;
      }
      const store = this.activeStore;
      const config = this.activeConfig;
      const generation = this.activeRecord.generation;
      this.beginReconfiguration("provider cleared");
      await this.waitForRequestsBounded();
      const uploadSnapshot = await this.deps.multipartUploadRepository.listMultiparts();
      try {
        await this.deps.multipartUploadRepository.clearProviderConfig();
      } catch (error) {
        this.finishReconfiguration(false);
        throw error;
      }
      this.activeStore = undefined;
      this.activeConfig = undefined;
      this.activeCapabilityUnsubscribe?.();
      this.activeCapabilityUnsubscribe = undefined;
      this.activeCapabilityState = undefined;
      this.activeRecord = null;
      this.runtimeUploads.clear();
      this.rotationActive = false;
      this.rotationAbortController = new AbortController();
      this.setStatus("unconfigured");
      if (store && config) {
        this.disposeAfterCleanup(this.abortUploadSnapshot(uploadSnapshot.filter((record) => record.providerGeneration === generation), store, config), store);
      }
      this.deps.logger?.info?.({ scope: "storage", event: "runtime.released", reason: "cleared" });
    });
  }

  /**
   * Destructive recovery escape hatch used only after an explicit Settings
   * confirmation. Unlike ordinary writes it is allowed to remove a stuck or
   * corrupt rotation journal and clears both local Storage stores atomically.
   */
  async resetStorage(): Promise<void> {
    return this.enqueue(async () => {
      if (this.deps.bucketProvider) {
        throw new StorageRuntimeError("storage_provider_error", "Active storage reset requires a restart; the current root remains bound until then");
      }
      const store = this.activeStore;
      const config = this.activeConfig;
      const generation = this.activeRecord?.generation;
      const previousRotation = { active: this.rotationActive };
      const previousStatus = this.currentStatus;
      this.rotationActive = true;
      this.lifecycleFence += 1;
      this.setStatus("reconfiguring");
      this.rotationAbortController.abort();
      this.probeController?.abort();
      this.capabilityProbeController?.abort();
      this.cursors.clear();
      await this.waitForRequestsBounded();
      const uploadSnapshot = await this.deps.multipartUploadRepository.listMultiparts();
      try {
        await this.deps.multipartUploadRepository.resetStorage();
      } catch (error) {
        // The old client and record are still the active truth. Re-arm request
        // cancellation so a failed reset does not leave status=ready backed by
        // a permanently aborted signal.
        this.rotationActive = previousRotation.active;
        this.rotationAbortController = new AbortController();
        this.setStatus(previousStatus);
        throw error;
      }
      this.activeStore = undefined;
      this.activeConfig = undefined;
      this.activeCapabilityUnsubscribe?.();
      this.activeCapabilityUnsubscribe = undefined;
      this.activeCapabilityState = undefined;
      this.activeRecord = null;
      this.runtimeUploads.clear();
      this.rotationActive = false;
      this.rotationAbortController = new AbortController();
      this.setStatus("unconfigured");
      if (store && config) {
        this.disposeAfterCleanup(this.abortUploadSnapshot(uploadSnapshot.filter((record) => generation === undefined || record.providerGeneration === generation), store, config), store);
      }
    });
  }

  async abortSession(connectSessionId: string): Promise<void> {
    return this.trackRequest(async () => {
    if (this.rotationActive) return;
    const activeGeneration = this.runtimeGeneration();
    const records = (await this.deps.multipartUploadRepository.listMultiparts()).filter((record) => record.connectSessionId === connectSessionId);
    const store = this.activeStore;
    const config = this.activeConfig;
    const cleanupDeadline = Date.now() + 1000;
    const cleanupOne = async (record: StoredMultipartUploadRecord): Promise<void> => {
      try {
        if (activeGeneration !== undefined && record.providerGeneration !== activeGeneration) return;
        if (store && config) {
          const runtime = this.runtimeUploads.get(record.internalUploadId);
          let uploadId = runtime?.s3UploadId;
          if (!uploadId) {
            const bytes = await this.deps.secret.open(`keymaster.storage.upload.v1/${record.internalUploadId}`, record.sealedS3UploadId);
            try { uploadId = new TextDecoder().decode(bytes); } finally { bytes.fill(0); }
          }
          const remaining = cleanupDeadline - Date.now();
          if (remaining <= 0) return;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              store.abortMultipart({ namespaceRoot: runtime?.namespaceRoot ?? rootForUploadRecord(config, record), key: record.physicalKey, uploadId }),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("storage cleanup timeout")), remaining); })
            ]);
          } finally { if (timer) clearTimeout(timer); }
          this.runtimeUploads.delete(record.internalUploadId);
          await this.deps.multipartUploadRepository.deleteMultipart(record.internalUploadId);
        }
      } catch (error) {
        this.deps.logger?.warn?.({ scope: "storage", event: "session_upload_abort.failed", uploadId: record.internalUploadId, code: storageErrorCode(error) });
      }
    };
    for (let index = 0; index < records.length; index += 4) {
      await Promise.all(records.slice(index, index + 4).map((record) => cleanupOne(record)));
      if (Date.now() >= cleanupDeadline) break;
    }
    });
  }

  private listPrefix(input: string | undefined): string {
    if (input === undefined || input === "") return "";
    return normalizeDirectoryPath(input).slice(0, -1);
  }

  async list(ctx: OwnerAppStorageGrant, input: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<StorageListResult> {
    return this.trackRequest(async () => {
    this.pruneCursors();
    const signal = this.requestSignal(input.signal);
    const { store, record } = this.requireReady();
    const root = this.assertContext(ctx);
    const relativePrefix = this.listPrefix(input.prefix);
    const limit = input.limit ?? STORAGE_DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > STORAGE_MAX_LIST_LIMIT) throw new StorageRuntimeError("storage_limit_exceeded");
    let continuationToken: string | undefined;
    if (input.cursor) {
      const cursor = this.cursors.get(input.cursor);
      if (!cursor || cursor.expiresAt <= now(this.deps)) { this.cursors.delete(input.cursor); throw new StorageRuntimeError("storage_invalid_upload", "Cursor expired"); }
      if (cursor.connectSessionId !== ctx.connectSessionId || cursor.transportOrigin !== ctx.transportOrigin || cursor.root !== root || cursor.relativePrefix !== relativePrefix || cursor.generation !== record.generation || cursor.limit !== limit) throw new StorageRuntimeError("storage_invalid_upload", "Cursor is not valid for this context");
      continuationToken = cursor.continuationToken;
      this.cursors.delete(input.cursor);
    }
    const physicalPrefix = relativePrefix ? buildKeyForContext(root, relativePrefix, true) : root;
    const output: BucketListOutput = await store.list({ namespaceRoot: root, prefix: physicalPrefix, delimiter: "/", continuationToken, maxKeys: limit, signal });
    this.assertRequestActive(signal);
    const currentPrefix = relativePrefix.length > 0 ? `${relativePrefix}/` : "";
    const directories = output.commonPrefixes.flatMap((key) => {
      const relative = stripRoot(root, key);
      if (!relative.startsWith(currentPrefix) || !relative.endsWith("/")) return [];
      const remainder = relative.slice(currentPrefix.length).replace(/\/$/u, "");
      if (!remainder || remainder.includes("/")) return [];
      return [{ path: relative, name: remainder }];
    });
    let markerPath: string | undefined;
    const files = output.objects.flatMap((entry) => {
      const relative = stripRoot(root, entry.key);
      if (relative === currentPrefix) { markerPath = relative; return []; }
      if (!relative.startsWith(currentPrefix) || relative.slice(currentPrefix.length).includes("/")) return [];
      return [{ path: relative, name: basename(relative), size: entry.size, ...(entry.etag ? { etag: entry.etag } : {}), ...(entry.lastModified ? { lastModified: entry.lastModified.toISOString() } : {}) }];
    });
    let nextCursor: string | undefined;
    if (output.nextContinuationToken) {
      this.pruneCursors();
      nextCursor = id(this.deps, "cursor");
      this.cursors.set(nextCursor, { connectSessionId: ctx.connectSessionId, transportOrigin: ctx.transportOrigin, root, relativePrefix, limit, generation: record.generation, continuationToken: output.nextContinuationToken, expiresAt: now(this.deps) + STORAGE_CURSOR_TTL_MS });
      // Enforce both caps after insertion as well as before the provider call.
      this.pruneCursors();
    }
    const parentPrefix = relativePrefix.includes("/") ? `${relativePrefix.slice(0, relativePrefix.lastIndexOf("/"))}/` : "";
    return { prefix: relativePrefix ? `${relativePrefix}/` : "", parentPrefix, directories, files, ...(markerPath ? { markerPath } : {}), ...(nextCursor ? { nextCursor } : {}) };
    });
  }

  async createDirectory(ctx: OwnerAppStorageGrant, input: { path: string; overwrite?: boolean; signal?: AbortSignal }): Promise<StorageDirectoryResult> {
    return this.trackRequest(async () => {
    const signal = this.requestSignal(input.signal);
    const { store } = this.requireReady(); const root = this.assertContext(ctx); const key = buildKeyForContext(root, input.path, true);
    await store.put({ namespaceRoot: root, key, bytes: new Uint8Array(0), contentType: "application/x-directory", ifNoneMatch: input.overwrite === false ? "*" : undefined, signal });
    this.assertRequestActive(signal);
    return { path: `${normalizeDirectoryPath(input.path)}`, created: true };
    });
  }

  async deleteDirectory(ctx: OwnerAppStorageGrant, input: { path: string; signal?: AbortSignal }): Promise<StorageDirectoryResult> {
    return this.trackRequest(async () => {
    const signal = this.requestSignal(input.signal);
    const { store } = this.requireReady(); const root = this.assertContext(ctx); const key = buildKeyForContext(root, input.path, true);
    await store.delete({ namespaceRoot: root, key, signal });
    this.assertRequestActive(signal);
    return { path: normalizeDirectoryPath(input.path), deleted: true };
    });
  }

  async put(ctx: OwnerAppStorageGrant, input: { path: string; content: { bytes: ArrayBuffer; $type: "binary"; mime?: string }; contentType?: string; overwrite?: boolean; signal?: AbortSignal }): Promise<StoragePutResult> {
    return this.trackRequest(async () => {
    const signal = this.requestSignal(input.signal);
    if (input.content.bytes.byteLength > STORAGE_MAX_PAYLOAD_BYTES) throw new StorageRuntimeError("storage_limit_exceeded");
    const { store } = this.requireReady(); const root = this.assertContext(ctx); const path = normalizeObjectPath(input.path); const key = buildKeyForContext(root, path);
    const output = await store.put({ namespaceRoot: root, key, bytes: new Uint8Array(input.content.bytes), contentType: input.contentType ?? input.content.mime, ifNoneMatch: input.overwrite === false ? "*" : undefined, signal });
    this.assertRequestActive(signal);
    return { path, size: input.content.bytes.byteLength, ...(output.etag ? { etag: output.etag } : {}), updatedAt: now(this.deps) };
    });
  }

  async getRange(ctx: OwnerAppStorageGrant, input: { path: string; offset?: number; length?: number; ifMatch?: string; signal?: AbortSignal }) {
    return this.trackRequest(async () => {
    const signal = this.requestSignal(input.signal);
    const offset = input.offset ?? 0; const length = input.length ?? STORAGE_MAX_PAYLOAD_BYTES;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > STORAGE_MAX_PAYLOAD_BYTES) throw new StorageRuntimeError("storage_limit_exceeded");
    if (offset > Number.MAX_SAFE_INTEGER - (length - 1)) throw new StorageRuntimeError("storage_limit_exceeded", "Requested range exceeds safe integer bounds");
    const { store } = this.requireReady(); const root = this.assertContext(ctx); const path = normalizeObjectPath(input.path); const key = buildKeyForContext(root, path);
    const output = await store.get({ namespaceRoot: root, key, range: `bytes=${offset}-${offset + length - 1}`, ifMatch: input.ifMatch, signal });
    this.assertRequestActive(signal);
    const actualOffset = output.offset ?? offset;
    if (!Number.isSafeInteger(actualOffset) || actualOffset < 0) throw new StorageRuntimeError("storage_provider_error", "Storage provider returned an invalid range offset");
    if (actualOffset !== offset) throw new StorageRuntimeError("storage_provider_error", "Storage provider returned an unexpected range offset");
    if (output.bytes.byteLength > STORAGE_MAX_PAYLOAD_BYTES || output.bytes.byteLength > length) throw new StorageRuntimeError("storage_limit_exceeded", "Storage provider returned too many bytes");
    const totalSize = output.totalSize ?? offset + output.bytes.byteLength;
    const end = actualOffset + output.bytes.byteLength;
    if (!Number.isSafeInteger(end) || !Number.isSafeInteger(totalSize) || totalSize < 0 || totalSize < end) throw new StorageRuntimeError("storage_provider_error", "Storage provider returned an invalid range size");
    return { path, content: { $type: "binary" as const, bytes: output.bytes.slice().buffer, ...(output.contentType ? { mime: output.contentType } : {}) }, ...(output.contentType ? { contentType: output.contentType } : {}), offset: actualOffset, totalSize, eof: end >= totalSize, ...(output.etag ? { etag: output.etag } : {}), ...(output.lastModified ? { lastModified: output.lastModified.toISOString() } : {}) };
    });
  }

  async delete(ctx: OwnerAppStorageGrant, input: { path: string; signal?: AbortSignal }): Promise<StorageDeleteResult> {
    return this.trackRequest(async () => {
    const signal = this.requestSignal(input.signal);
    const { store } = this.requireReady(); const root = this.assertContext(ctx); const path = normalizeObjectPath(input.path); await store.delete({ namespaceRoot: root, key: buildKeyForContext(root, path), signal }); this.assertRequestActive(signal); return { path, deleted: true, updatedAt: now(this.deps) };
    });
  }

  async beginUpload(ctx: OwnerAppStorageGrant, input: { path: string; contentType?: string; size: number; overwrite?: boolean; signal?: AbortSignal }): Promise<StorageUploadBeginResult> {
    return this.trackRequest(async () => {
    const signal = this.requestSignal(input.signal);
    assertLimit(input.size, "size");
    if (input.size < 1) throw new StorageRuntimeError("storage_invalid_upload", "multipart uploads must contain at least one byte");
    const parts = Math.ceil(input.size / STORAGE_PART_SIZE_BYTES);
    if (parts > STORAGE_MAX_PARTS) throw new StorageRuntimeError("storage_limit_exceeded", "upload has too many parts");
    const { store, record } = this.requireReady(); const root = this.assertContext(ctx); const path = normalizeObjectPath(input.path); const key = buildKeyForContext(root, path); const internalUploadId = id(this.deps, "upload");
    if (input.overwrite === false) {
      if (signal.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
      if (await store.head({ namespaceRoot: root, key, signal })) throw new StorageRuntimeError("storage_conflict", "Storage object already exists");
    }
    const s3UploadId = await store.createMultipart({ namespaceRoot: root, key, contentType: input.contentType, signal });
    this.assertRequestActive(signal);
    const runtimeRecord = { internalUploadId, connectSessionId: ctx.connectSessionId, transportOrigin: ctx.transportOrigin, ownerPublicKeyHex: ctx.ownerPublicKeyHex, applicationStorageId: ctx.applicationStorageId, bucketId: ctx.bucketId, bucketGeneration: ctx.bucketGeneration, sessionEpoch: ctx.sessionEpoch, relativePath: path, physicalKey: key, sealedS3UploadId: { version: 2 as const, saltHex: "", nonceHex: "", ciphertextHex: "" }, providerGeneration: record.generation, contentType: input.contentType, expectedSize: input.size, overwrite: input.overwrite !== false, parts: [], expiresAt: now(this.deps) + STORAGE_UPLOAD_TTL_MS, createdAt: now(this.deps) } satisfies StoredMultipartUploadRecord;
    this.rememberRuntimeUpload(runtimeRecord, this.requireReady().config, s3UploadId);
    let persisted = false;
    try {
      if (signal.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
      const uploadIdBytes = new TextEncoder().encode(s3UploadId);
      let sealedS3UploadId;
      try { sealedS3UploadId = await this.deps.secret.seal(`keymaster.storage.upload.v1/${internalUploadId}`, uploadIdBytes); }
      finally { uploadIdBytes.fill(0); }
      await this.deps.multipartUploadRepository.putMultipart({ ...runtimeRecord, sealedS3UploadId });
      persisted = true;
      this.assertRequestActive(signal);
    } catch (error) {
      this.runtimeUploads.delete(internalUploadId);
      if (persisted) await this.deps.multipartUploadRepository.deleteMultipart(internalUploadId).catch(() => undefined);
      try { await this.boundedCleanup(() => store.abortMultipart({ namespaceRoot: root, key, uploadId: s3UploadId })); } catch { /* best effort */ }
      throw error;
    }
    return { uploadId: internalUploadId, partSize: STORAGE_PART_SIZE_BYTES, maxParts: STORAGE_MAX_PARTS };
    });
  }

  private async uploadRecord(ctx: OwnerAppStorageGrant, uploadId: string, signal: AbortSignal): Promise<{ record: StoredMultipartUploadRecord; store: BucketObjectStore }> {
    this.assertRequestActive(signal);
    const { store, record: active } = this.requireReady(); const record = await this.deps.multipartUploadRepository.getMultipart(uploadId);
    this.assertRequestActive(signal);
    if (!record || record.expiresAt <= now(this.deps) || record.providerGeneration !== active.generation || record.connectSessionId !== ctx.connectSessionId || record.transportOrigin !== ctx.transportOrigin || record.ownerPublicKeyHex !== ctx.ownerPublicKeyHex || record.applicationStorageId !== ctx.applicationStorageId || record.bucketId !== ctx.bucketId || record.bucketGeneration !== ctx.bucketGeneration || record.sessionEpoch !== ctx.sessionEpoch) throw new StorageRuntimeError("storage_invalid_upload", "Upload is not valid for this context");
    return { record, store };
  }

  async uploadPart(ctx: OwnerAppStorageGrant, input: { uploadId: string; partNumber: number; content: { bytes: ArrayBuffer; $type: "binary"; mime?: string }; signal?: AbortSignal }): Promise<StorageUploadPartResult> {
    return this.trackRequest(() => this.withUploadLock(input.uploadId, async () => {
    const signal = this.requestSignal(input.signal);
    const lifecycleFence = this.lifecycleFence;
    const { record, store } = await this.uploadRecord(ctx, input.uploadId, signal); const size = input.content.bytes.byteLength;
    if (input.partNumber < 1 || input.partNumber > STORAGE_MAX_PARTS || size > STORAGE_PART_SIZE_BYTES) throw new StorageRuntimeError("storage_limit_exceeded");
    const expectedParts = Math.ceil(record.expectedSize / STORAGE_PART_SIZE_BYTES);
    if (record.expectedSize === 0 || input.partNumber > Math.max(1, expectedParts)) throw new StorageRuntimeError("storage_invalid_upload");
    if (input.partNumber < expectedParts && size !== STORAGE_PART_SIZE_BYTES) throw new StorageRuntimeError("storage_invalid_upload", "Non-final parts must use the fixed part size");
    if (input.partNumber === expectedParts && size !== record.expectedSize - STORAGE_PART_SIZE_BYTES * (expectedParts - 1)) throw new StorageRuntimeError("storage_invalid_upload", "Final part size does not match the declared upload size");
    const bytes = await this.deps.secret.open(`keymaster.storage.upload.v1/${record.internalUploadId}`, record.sealedS3UploadId);
    let s3UploadId: string;
    try { s3UploadId = new TextDecoder().decode(bytes); } finally { bytes.fill(0); }
    this.rememberRuntimeUpload(record, this.requireReady().config, s3UploadId);
    const etag = await store.uploadPart({ namespaceRoot: rootForUploadRecord(this.requireReady().config, record), key: record.physicalKey, uploadId: s3UploadId, partNumber: input.partNumber, bytes: new Uint8Array(input.content.bytes), signal });
    this.assertRequestActive(signal);
    if (lifecycleFence !== this.lifecycleFence || this.runtimeGeneration() !== record.providerGeneration) throw new StorageRuntimeError("storage_unavailable", "Storage generation changed");
    const parts = [...record.parts.filter((part) => part.partNumber !== input.partNumber), { partNumber: input.partNumber, etag, size }].sort((a, b) => a.partNumber - b.partNumber);
    await this.deps.multipartUploadRepository.putMultipart({ ...record, parts });
    if (lifecycleFence !== this.lifecycleFence) {
      await this.deps.multipartUploadRepository.deleteMultipart(record.internalUploadId).catch(() => undefined);
      throw new StorageRuntimeError("storage_unavailable", "Storage generation changed");
    }
    return { uploadId: input.uploadId, partNumber: input.partNumber, size };
    }));
  }

  private async withUploadLock<T>(uploadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.uploadLocks.get(uploadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.uploadLocks.set(uploadId, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.uploadLocks.get(uploadId) === current) this.uploadLocks.delete(uploadId);
    }
  }

  async completeUpload(ctx: OwnerAppStorageGrant, input: { uploadId: string; signal?: AbortSignal }): Promise<StoragePutResult> {
    return this.trackRequest(async () => {
    const signal = this.requestSignal(input.signal);
    const { record, store } = await this.uploadRecord(ctx, input.uploadId, signal); const expectedParts = Math.ceil(record.expectedSize / STORAGE_PART_SIZE_BYTES);
    if (record.expectedSize > 0 && (record.parts.length !== expectedParts || record.parts.some((part, index) => part.partNumber !== index + 1))) throw new StorageRuntimeError("storage_invalid_upload", "Upload parts are incomplete");
    if (record.parts.reduce((total, part) => total + part.size, 0) !== record.expectedSize) throw new StorageRuntimeError("storage_invalid_upload", "Upload size does not match declaration");
    const bytes = await this.deps.secret.open(`keymaster.storage.upload.v1/${record.internalUploadId}`, record.sealedS3UploadId); let s3UploadId: string;
    try { s3UploadId = new TextDecoder().decode(bytes); } finally { bytes.fill(0); }
    this.rememberRuntimeUpload(record, this.requireReady().config, s3UploadId);
    if (record.overwrite === false) {
      if (signal.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
      if (await store.head({ namespaceRoot: rootForUploadRecord(this.requireReady().config, record), key: record.physicalKey, signal })) throw new StorageRuntimeError("storage_conflict", "Storage object already exists");
    }
    const output = await store.completeMultipart({ namespaceRoot: rootForUploadRecord(this.requireReady().config, record), key: record.physicalKey, uploadId: s3UploadId, parts: record.parts.map(({ partNumber, etag }) => ({ partNumber, etag })), ifNoneMatch: record.overwrite === false ? "*" : undefined, signal });
    this.assertRequestActive(signal);
    await this.deps.multipartUploadRepository.deleteMultipart(record.internalUploadId);
    this.runtimeUploads.delete(record.internalUploadId);
    return { path: record.relativePath, size: record.expectedSize, ...(output.etag ? { etag: output.etag } : {}), updatedAt: now(this.deps) };
    });
  }

  async abortUpload(ctx: OwnerAppStorageGrant, input: { uploadId: string; signal?: AbortSignal }): Promise<StorageUploadAbortResult> {
    return this.trackRequest(async () => {
    const signal = this.requestSignal(input.signal);
    const { record, store } = await this.uploadRecord(ctx, input.uploadId, signal); const bytes = await this.deps.secret.open(`keymaster.storage.upload.v1/${record.internalUploadId}`, record.sealedS3UploadId); let s3UploadId: string;
    try { s3UploadId = new TextDecoder().decode(bytes); } finally { bytes.fill(0); }
    this.rememberRuntimeUpload(record, this.requireReady().config, s3UploadId);
    await store.abortMultipart({ namespaceRoot: rootForUploadRecord(this.requireReady().config, record), key: record.physicalKey, uploadId: s3UploadId, signal }); this.assertRequestActive(signal); await this.deps.multipartUploadRepository.deleteMultipart(record.internalUploadId); this.runtimeUploads.delete(record.internalUploadId); return { uploadId: input.uploadId, aborted: true };
    });
  }

  private async cleanupStaleUploads(): Promise<void> {
    if (this.currentStatus !== "ready" || !this.activeStore || (!this.activeRecord && !this.deps.bucketProvider)) return;
    const records = await this.deps.multipartUploadRepository.listMultiparts();
    const deadline = Date.now() + 1000;
    for (const record of records) {
      if (Date.now() >= deadline) break;
      if (record.providerGeneration !== this.runtimeGeneration()) {
        // The old provider handle is no longer available after a restart or
        // provider swap; never send an old physical key through the new
        // adapter. Retire only the local orphan record.
        this.runtimeUploads.delete(record.internalUploadId);
        await this.deps.multipartUploadRepository.deleteMultipart(record.internalUploadId).catch(() => undefined);
        continue;
      }
      if (record.expiresAt > now(this.deps)) continue;
      try {
        const runtime = this.runtimeUploads.get(record.internalUploadId);
        let s3UploadId = runtime?.s3UploadId;
        if (!s3UploadId) {
          const bytes = await this.deps.secret.open(`keymaster.storage.upload.v1/${record.internalUploadId}`, record.sealedS3UploadId);
          try { s3UploadId = new TextDecoder().decode(bytes); } finally { bytes.fill(0); }
        }
        await this.boundedCleanup(() => this.activeStore!.abortMultipart({ namespaceRoot: rootForUploadRecord(this.activeConfig!, record), key: record.physicalKey, uploadId: s3UploadId }), Math.max(1, deadline - Date.now()));
        await this.deps.multipartUploadRepository.deleteMultipart(record.internalUploadId);
        this.runtimeUploads.delete(record.internalUploadId);
      } catch (error) { this.deps.logger?.warn?.({ scope: "storage", event: "stale_upload_cleanup.failed", uploadId: record.internalUploadId, code: storageErrorCode(error) }); }
    }
  }

  private async abortKnownUploads(storeOverride?: BucketObjectStore, configOverride?: NormalizedStorageProviderConfig, strict = false, generationOverride?: number, retireLocal = true): Promise<void> {
    const store = storeOverride ?? this.activeStore;
    const config = configOverride ?? this.activeConfig;
    const activeGeneration = generationOverride ?? this.activeRecord?.generation;
    const records = (await this.deps.multipartUploadRepository.listMultiparts()).filter((record) => activeGeneration === undefined || record.providerGeneration === activeGeneration);
    const deadline = Date.now() + 1000;
    for (const record of records) {
      if (Date.now() >= deadline) break;
      let aborted = false;
      try {
        if (store) {
          const runtime = this.runtimeUploads.get(record.internalUploadId);
          let uploadId = runtime?.s3UploadId;
          if (!uploadId) {
            const bytes = await this.deps.secret.open(`keymaster.storage.upload.v1/${record.internalUploadId}`, record.sealedS3UploadId);
            try { uploadId = new TextDecoder().decode(bytes); } finally { bytes.fill(0); }
          }
          if (!config) throw new StorageRuntimeError("storage_unavailable", "Storage configuration is unavailable");
          await this.boundedCleanup(() => store.abortMultipart({ namespaceRoot: runtime?.namespaceRoot ?? rootForUploadRecord(config, record), key: record.physicalKey, uploadId }), Math.max(1, deadline - Date.now()));
          aborted = true;
        }
      } catch (error) {
        this.deps.logger?.warn?.({ scope: "storage", event: "upload_abort.failed", code: storageErrorCode(error) });
        if (strict) throw error;
      } finally {
        // Once configuration is cleared/replaced, retaining an opaque upload
        // record would either leak an orphan or bind it to a new provider
        // generation. The provider abort is best-effort; the local record is
        // always retired at the lifecycle boundary.
        if (retireLocal && (!strict || aborted)) await this.deps.multipartUploadRepository.deleteMultipart(record.internalUploadId).catch(() => undefined);
        if (retireLocal && (!strict || aborted)) this.runtimeUploads.delete(record.internalUploadId);
      }
    }
  }

  private async abortUploadSnapshot(records: StoredMultipartUploadRecord[], store: BucketObjectStore | undefined, config: NormalizedStorageProviderConfig | undefined): Promise<void> {
    if (!store || !config) return;
    const deadline = Date.now() + 1000;
    for (const record of records) {
      if (Date.now() >= deadline) break;
      try {
        const bytes = await this.deps.secret.open(`keymaster.storage.upload.v1/${record.internalUploadId}`, record.sealedS3UploadId);
        let uploadId: string;
        try { uploadId = new TextDecoder().decode(bytes); } finally { bytes.fill(0); }
        await this.boundedCleanup(() => store.abortMultipart({ namespaceRoot: rootForUploadRecord(config, record), key: record.physicalKey, uploadId }), Math.max(1, deadline - Date.now()));
      } catch (error) {
        this.deps.logger?.warn?.({ scope: "storage", event: "upload_snapshot_abort.failed", code: storageErrorCode(error) });
      }
    }
  }

  private disposeAfterCleanup(cleanup: Promise<void>, store: BucketObjectStore): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); });
    void Promise.race([cleanup, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
      try { store.dispose(); } catch { /* best effort */ }
    });
  }

  private async boundedCleanup(operation: () => Promise<unknown>, timeoutMs = 1000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("storage cleanup timeout")), timeoutMs); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async boundedProvider<T>(operation: () => Promise<T>, controller: AbortController, timeoutMs = 5000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new StorageRuntimeError("storage_unavailable", "Storage provider cancelled"));
        if (controller.signal.aborted) onAbort(); else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([operation(), aborted, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new StorageRuntimeError("storage_unavailable", "Storage provider timeout")); }, timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); if (onAbort) controller.signal.removeEventListener("abort", onAbort); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.probeController?.abort();
    this.capabilityProbeController?.abort();
    this.rotationAbortController.abort();
    this.cursors.clear();
    const store = this.activeStore;
    this.activeStore = undefined;
    this.activeConfig = undefined;
    this.activeCapabilityUnsubscribe?.();
    this.activeCapabilityUnsubscribe = undefined;
    this.listeners.clear();
    try { store?.dispose(); } catch { /* best effort */ }
    this.deps.multipartUploadRepository.close();
  }
}

export async function createStorageRuntimeController(deps: StorageRuntimeControllerDeps): Promise<StorageRuntimeControllerImpl> { return StorageRuntimeControllerImpl.create(deps); }
