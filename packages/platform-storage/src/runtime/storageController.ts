import type {
  OwnerAppStorageGrant,
  StorageDeleteResult,
  BucketConditionalCapabilitiesView,
  BucketConditionalCapabilityProbeResult,
  StorageDirectoryResult,
  StorageListResult,
  StorageProviderConnectionView,
  StorageProviderSummary,
  StoragePutResult,
  StorageRuntimeController as StorageRuntimeControllerContract,
  StorageRuntimeControllerStatus,
  CoordinatorAuthorityRecovery,
  StorageBucketProvider,
  StorageUploadAbortResult,
  StorageUploadBeginResult,
  StorageUploadPartResult
} from "@keymaster/contracts";
import { deriveThirdPartyStorageModuleId } from "@keymaster/contracts";
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
import { createProviderBackedBucketObjectStore } from "../bucket-providers/providerBackedBucketObjectStore.js";
import type { MultipartUploadRepository, StoredMultipartUploadRecord } from "../bootstrap/multipartUploadRepository.js";
import { buildKeyForContext, buildOwnerAppNamespaceRoot } from "../storage-access/owner-app/ownerAppNamespace.js";
import { basename, normalizeDirectoryPath, normalizeObjectPath, stripRoot, StoragePathError } from "../bucket-providers/bucketPath.js";
import { StorageRuntimeError, storageErrorCode } from "./storageError.js";

export interface StorageRuntimeSnapshot {
  status: StorageRuntimeControllerStatus;
  /** 独立于 Vault 的统一桶健康状态。 */
  healthStatus?: import("@keymaster/contracts").StorageRuntimeStatus;
  /** 当前是否是新版多桶目录绑定。 */
  catalogBucket?: boolean;
  /** 本机目录中是否存在至少一个新版桶；用于旧版入口让位。 */
  hasCatalogBuckets?: boolean;
  /** Coordinator 最终 I/O 接管被旧 Worker 阻塞时的脱敏恢复提示。 */
  authorityRecovery?: CoordinatorAuthorityRecovery;
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

/** 当前已绑定桶的内存描述；不代表可恢复的 Provider 配置。 */
interface RuntimeBucketBindingRecord {
  providerId: StorageProviderSummary["providerId"];
  publicSummary: {
    bucketHint: string;
    endpointHint?: string;
    accessKeyHint: string;
  };
  generation: number;
  updatedAt: number;
}

export interface StorageRuntimeControllerDeps {
  multipartUploadRepository: MultipartUploadRepository;
  /** Coordinator 已启动的唯一抽象桶 Provider；提供后文件 API 与 K-V 共桶。 */
  bucketProvider?: StorageBucketProvider;
  /** 当前抽象桶世代；用于 multipart 和 cursor 的失效判断。 */
  bucketGeneration?: number;
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

function rootForUploadRecord(record: StoredMultipartUploadRecord): string {
  return buildOwnerAppNamespaceRoot({
    ownerPublicKeyHex: record.ownerPublicKeyHex,
    moduleId: record.moduleId,
    purposeId: record.purposeId,
  });
}

export class StorageRuntimeControllerImpl implements StorageRuntimeControllerContract {
  private readonly listeners = new Set<() => void>();
  private readonly cursors = new Map<string, CursorRecord>();
  private readonly runtimeUploads = new Map<string, RuntimeUpload>();
  private activeStore?: BucketObjectStore;
  private activeCapabilityState?: BucketObjectStoreCapabilityState;
  private activeCapabilityUnsubscribe?: () => void;
  private activeRecord: RuntimeBucketBindingRecord | null = null;
  private currentStatus: StorageRuntimeControllerStatus = "unconfigured";
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
    await service.bindCurrentBucket();
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
    } else if (this.activeStore && this.activeRecord) {
      this.setStatus("ready");
    } else if (this.activeRecord) {
      void this.bindCurrentBucket();
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

  private async bindCurrentBucket(): Promise<void> {
    const provider = this.deps.bucketProvider;
    if (!provider) {
      this.setStatus("unconfigured");
      return;
    }
    const capabilityState = this.activeCapabilityState ?? createBucketObjectStoreCapabilityState();
    this.activeRecord = {
      // The actual connection and credentials belong to the Coordinator's
      // bucket binding. Runtime only keeps a redacted in-memory summary.
      providerId: "s3-compatible",
      publicSummary: { bucketHint: provider.bucketId, accessKeyHint: "unified" },
      generation: this.runtimeGeneration(),
      updatedAt: now(this.deps),
    };
    this.activeStore = this.makeActiveStore(capabilityState);
    this.activeCapabilityState = capabilityState;
    this.bindCapabilityState(capabilityState);
    this.setStatus("ready");
    await this.restoreRuntimeUploads();
    await this.cleanupStaleUploads();
  }

  private makeActiveStore(capabilityState = createBucketObjectStoreCapabilityState()): BucketObjectStore {
    if (!this.deps.bucketProvider) throw new StorageRuntimeError("storage_not_configured");
    return createProviderBackedBucketObjectStore(this.deps.bucketProvider, capabilityState);
  }

  private runtimeGeneration(): number {
    return this.deps.bucketGeneration ?? this.activeRecord?.generation ?? 1;
  }

  private runtimeRecord(): RuntimeBucketBindingRecord {
    if (!this.activeRecord) throw new StorageRuntimeError("storage_not_configured");
    return { ...this.activeRecord, generation: this.runtimeGeneration() };
  }

  private rememberRuntimeUpload(record: StoredMultipartUploadRecord, s3UploadId: string): void {
    this.runtimeUploads.set(record.internalUploadId, {
      s3UploadId,
      key: record.physicalKey,
      namespaceRoot: rootForUploadRecord(record),
      connectSessionId: record.connectSessionId
    });
  }

  private async restoreRuntimeUploads(): Promise<void> {
    for (const record of await this.deps.multipartUploadRepository.listMultiparts()) {
      if (record.providerGeneration !== this.runtimeGeneration()) continue;
      this.rememberRuntimeUpload(record, record.uploadId);
    }
  }

  private requireReady(): { store: BucketObjectStore; record: RuntimeBucketBindingRecord } {
    if (this.currentStatus === "unconfigured" || !this.activeRecord) throw new StorageRuntimeError("storage_not_configured");
    if (this.currentStatus !== "ready" || !this.activeStore) throw new StorageRuntimeError("storage_unavailable");
    return { store: this.activeStore, record: this.runtimeRecord() };
  }

  private contextRoot(ctx: OwnerAppStorageGrant): string {
    this.requireReady();
    return buildOwnerAppNamespaceRoot(ctx);
  }

  private assertContext(ctx: OwnerAppStorageGrant): string {
    if (!ctx.connectSessionId || !ctx.transportOrigin || !ctx.sessionEpoch || !ctx.appIdentity?.identityDigestHex || !/^[0-9a-f]{64}$/u.test(ctx.appIdentity.identityDigestHex)) throw new StorageRuntimeError("storage_identity_required");
    if (!/^(02|03)[0-9a-f]{64}$/u.test(ctx.ownerPublicKeyHex) || !Number.isSafeInteger(ctx.bucketGeneration) || ctx.bucketGeneration < 1 || !ctx.bucketId || ctx.bucketId.includes("/")) throw new StorageRuntimeError("storage_identity_required");
    let derivedId: string;
    try { derivedId = deriveThirdPartyStorageModuleId(ctx.appIdentity.publisherPublicKeyHex, ctx.appIdentity.appId); }
    catch { throw new StorageRuntimeError("storage_identity_required"); }
    if (derivedId !== ctx.moduleId || ctx.purposeId !== "files") throw new StorageRuntimeError("storage_identity_required");
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
    // The connection is owned by the Coordinator's catalog binding. Runtime
    // intentionally has no persisted or reconstructable provider config.
    return null;
  }

  private bindCapabilityState(state: BucketObjectStoreCapabilityState): void {
    this.activeCapabilityUnsubscribe?.();
    this.activeCapabilityUnsubscribe = state.subscribe?.(() => this.emit());
  }

  getConditionalCapabilities(): BucketConditionalCapabilitiesView | null {
    if (!this.activeRecord || !this.activeCapabilityState) return null;
    return capabilityView(this.activeCapabilityState, this.runtimeGeneration());
  }

  cancelProbe(): void {
    this.capabilityProbeController?.abort();
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
      const state = this.activeCapabilityState;
      if (!state || this.currentStatus !== "ready" || this.rotationActive) throw new StorageRuntimeError("storage_unavailable", "Storage is not ready");
      const generation = this.runtimeGeneration();
      const stateIdentity = state;
      const root = `.keymaster-system/capability-probe/${crypto.randomUUID()}/`;
      const probeState = createBucketObjectStoreCapabilityState();
      const provider = this.deps.bucketProvider;
      if (!provider) throw new StorageRuntimeError("storage_not_configured");
      const store = createProviderBackedBucketObjectStore(provider, probeState);
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

  async abortSession(connectSessionId: string): Promise<void> {
    return this.trackRequest(async () => {
    if (this.rotationActive) return;
    const activeGeneration = this.runtimeGeneration();
    const records = (await this.deps.multipartUploadRepository.listMultiparts()).filter((record) => record.connectSessionId === connectSessionId);
    const store = this.activeStore;
    const cleanupDeadline = Date.now() + 1000;
    const cleanupOne = async (record: StoredMultipartUploadRecord): Promise<void> => {
      try {
        if (activeGeneration !== undefined && record.providerGeneration !== activeGeneration) return;
        if (store) {
          const runtime = this.runtimeUploads.get(record.internalUploadId);
          let uploadId = runtime?.s3UploadId;
          if (!uploadId) uploadId = record.uploadId;
          const remaining = cleanupDeadline - Date.now();
          if (remaining <= 0) return;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              store.abortMultipart({ namespaceRoot: runtime?.namespaceRoot ?? rootForUploadRecord(record), key: record.physicalKey, uploadId }),
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
    const runtimeRecord = { internalUploadId, connectSessionId: ctx.connectSessionId, transportOrigin: ctx.transportOrigin, ownerPublicKeyHex: ctx.ownerPublicKeyHex, moduleId: ctx.moduleId, purposeId: ctx.purposeId, bucketId: ctx.bucketId, bucketGeneration: ctx.bucketGeneration, sessionEpoch: ctx.sessionEpoch, relativePath: path, physicalKey: key, uploadId: s3UploadId, providerGeneration: record.generation, contentType: input.contentType, expectedSize: input.size, overwrite: input.overwrite !== false, parts: [], expiresAt: now(this.deps) + STORAGE_UPLOAD_TTL_MS, createdAt: now(this.deps) } satisfies StoredMultipartUploadRecord;
    this.rememberRuntimeUpload(runtimeRecord, s3UploadId);
    let persisted = false;
    try {
      if (signal.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
      await this.deps.multipartUploadRepository.putMultipart(runtimeRecord);
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
    if (!record || record.expiresAt <= now(this.deps) || record.providerGeneration !== active.generation || record.connectSessionId !== ctx.connectSessionId || record.transportOrigin !== ctx.transportOrigin || record.ownerPublicKeyHex !== ctx.ownerPublicKeyHex || record.moduleId !== ctx.moduleId || record.purposeId !== ctx.purposeId || record.bucketId !== ctx.bucketId || record.bucketGeneration !== ctx.bucketGeneration || record.sessionEpoch !== ctx.sessionEpoch) throw new StorageRuntimeError("storage_invalid_upload", "Upload is not valid for this context");
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
    const s3UploadId = record.uploadId;
    this.rememberRuntimeUpload(record, s3UploadId);
    const etag = await store.uploadPart({ namespaceRoot: rootForUploadRecord(record), key: record.physicalKey, uploadId: s3UploadId, partNumber: input.partNumber, bytes: new Uint8Array(input.content.bytes), signal });
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
    const s3UploadId = record.uploadId;
    this.rememberRuntimeUpload(record, s3UploadId);
    if (record.overwrite === false) {
      if (signal.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
      if (await store.head({ namespaceRoot: rootForUploadRecord(record), key: record.physicalKey, signal })) throw new StorageRuntimeError("storage_conflict", "Storage object already exists");
    }
    const output = await store.completeMultipart({ namespaceRoot: rootForUploadRecord(record), key: record.physicalKey, uploadId: s3UploadId, parts: record.parts.map(({ partNumber, etag }) => ({ partNumber, etag })), ifNoneMatch: record.overwrite === false ? "*" : undefined, signal });
    this.assertRequestActive(signal);
    await this.deps.multipartUploadRepository.deleteMultipart(record.internalUploadId);
    this.runtimeUploads.delete(record.internalUploadId);
    return { path: record.relativePath, size: record.expectedSize, ...(output.etag ? { etag: output.etag } : {}), updatedAt: now(this.deps) };
    });
  }

  async abortUpload(ctx: OwnerAppStorageGrant, input: { uploadId: string; signal?: AbortSignal }): Promise<StorageUploadAbortResult> {
    return this.trackRequest(async () => {
    const signal = this.requestSignal(input.signal);
    const { record, store } = await this.uploadRecord(ctx, input.uploadId, signal); const s3UploadId = record.uploadId;
    this.rememberRuntimeUpload(record, s3UploadId);
    await store.abortMultipart({ namespaceRoot: rootForUploadRecord(record), key: record.physicalKey, uploadId: s3UploadId, signal }); this.assertRequestActive(signal); await this.deps.multipartUploadRepository.deleteMultipart(record.internalUploadId); this.runtimeUploads.delete(record.internalUploadId); return { uploadId: input.uploadId, aborted: true };
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
        if (!s3UploadId) s3UploadId = record.uploadId;
        await this.boundedCleanup(() => this.activeStore!.abortMultipart({ namespaceRoot: rootForUploadRecord(record), key: record.physicalKey, uploadId: s3UploadId }), Math.max(1, deadline - Date.now()));
        await this.deps.multipartUploadRepository.deleteMultipart(record.internalUploadId);
        this.runtimeUploads.delete(record.internalUploadId);
      } catch (error) { this.deps.logger?.warn?.({ scope: "storage", event: "stale_upload_cleanup.failed", uploadId: record.internalUploadId, code: storageErrorCode(error) }); }
    }
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
    this.capabilityProbeController?.abort();
    this.rotationAbortController.abort();
    this.cursors.clear();
    const store = this.activeStore;
    this.activeStore = undefined;
    this.activeCapabilityUnsubscribe?.();
    this.activeCapabilityUnsubscribe = undefined;
    this.listeners.clear();
    try { store?.dispose(); } catch { /* best effort */ }
    this.deps.multipartUploadRepository.close();
  }
}

export async function createStorageRuntimeController(deps: StorageRuntimeControllerDeps): Promise<StorageRuntimeControllerImpl> { return StorageRuntimeControllerImpl.create(deps); }
