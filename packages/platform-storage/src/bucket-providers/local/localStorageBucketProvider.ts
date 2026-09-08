import type {
  StorageBucketCatalogEntryV2,
  StorageBucketListPage,
  StorageBucketObject,
  StorageBucketProbeResult,
  StorageBucketProvider,
  StorageBucketWriteCondition
} from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import type { StorageErrorCode } from "@keymaster/contracts";
import { StorageRuntimeError } from "../../runtime/storageRuntimeError.js";
import { assertProviderPath, normalizeProviderLimit } from "../bucketProvider.js";

/** localStorage 的最小同步接口，便于页面桥和单元测试注入。 */
export interface LocalStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Web Locks 的最小接口；没有锁就不能宣称支持原子 CAS。 */
export interface LocalStorageLocks {
  request<T>(name: string, callback: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
}

export interface LocalStorageBridgeObject {
  path: string;
  bytes: Uint8Array;
  size?: number;
  etag?: string;
  lastModified?: string;
}

/**
 * 切桶暂存阶段的授权范围。目标桶尚未成为目录 selectedBucket，页面桥仍
 * 可以在旧桶保持选中的前提下为 Coordinator 读取/写入目标 Local 命名空间。
 * 该字段由当前 Coordinator 通过 hello 租约传入，页面会在真正 I/O 前重新
 * 校验目录中的目标密文条目和旧 selectedBucketId。
 */
export interface LocalStorageBridgeCandidateBucket {
  bucket: StorageBucketCatalogEntryV2;
  expectedSelectedBucketId?: string;
  /** Coordinator 为目标 Root 分配的暂存世代；页面桥在 I/O 点校验。 */
  bucketGeneration?: number;
}

/** 页面桥的窄操作协议；桥在真正执行 localStorage I/O 前必须重新校验租约。 */
export type LocalStorageBridgeRequest =
  | { type: "get"; bucketId: string; bucketGeneration: number; path: string; authorityInstanceId?: string; leaseId?: string; candidateBucket?: LocalStorageBridgeCandidateBucket; ifMatch?: string; signal?: AbortSignal }
  | { type: "list"; bucketId: string; bucketGeneration: number; path?: never; authorityInstanceId?: string; leaseId?: string; candidateBucket?: LocalStorageBridgeCandidateBucket; prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }
  | { type: "put"; bucketId: string; bucketGeneration: number; path: string; authorityInstanceId?: string; leaseId?: string; candidateBucket?: LocalStorageBridgeCandidateBucket; bytes: Uint8Array; condition?: StorageBucketWriteCondition; signal?: AbortSignal }
  | { type: "delete"; bucketId: string; bucketGeneration: number; path: string; authorityInstanceId?: string; leaseId?: string; candidateBucket?: LocalStorageBridgeCandidateBucket; ifMatch?: string; signal?: AbortSignal }
  /**
   * Coordinator 改密后的目录 CAS。它只传输已经加密的桶条目，不传密码、
   * Keys 或明文连接凭据；页面端在同一把目录 Web Lock 中校验 expectedBucket。
   */
  | { type: "catalog-update"; bucketId: string; bucketGeneration: number; authorityInstanceId?: string; leaseId?: string; expectedBucket: StorageBucketCatalogEntryV2; nextBucket: StorageBucketCatalogEntryV2; /** CAS 响应丢失后的回滚请求；目标已是 nextBucket 时允许幂等成功。 */ rollback?: boolean; signal?: AbortSignal }
  /** 切桶最终目录 CAS；不传密码，仅更新 selectedBucketId。 */
  | { type: "catalog-select"; bucketId: string; bucketGeneration: number; authorityInstanceId?: string; leaseId?: string; expectedSelectedBucketId?: string; /** CAS 请求丢失响应时允许按目标桶回收；页面仍会在 Web Lock 内确认目录当前值。 */ rollbackFromSelectedBucketId?: string; targetBucket: StorageBucketCatalogEntryV2; signal?: AbortSignal };

export type LocalStorageBridgeResponse =
  | { type: "object"; object?: LocalStorageBridgeObject }
  | { type: "list"; objects: LocalStorageBridgeObject[]; nextCursor?: string }
  | { type: "write"; etag?: string; lastModified?: string }
  | { type: "void" }
  | { type: "catalog"; bucket: StorageBucketCatalogEntryV2 };

export interface LocalStorageBucketProviderOptions {
  /** 页面侧直接注入 localStorage；Worker 生产路径应使用 bridge。 */
  storage?: LocalStorageLike;
  /** 页面桥；存在时不触碰当前执行上下文的 localStorage。 */
  bridge?: (request: LocalStorageBridgeRequest) => Promise<LocalStorageBridgeResponse>;
  /** Web Locks；不注入时尝试使用当前 Window 的 navigator.locks。 */
  locks?: LocalStorageLocks;
  /** 抽象桶身份，不是 localStorage key 前缀。 */
  bucketId: string;
  /** 当前桶世代；桥和 Provider 都在执行点校验它。 */
  bucketGeneration?: number;
  /** 目标桶暂存阶段允许在目录仍选中旧桶时访问该桶。 */
  candidateBucket?: LocalStorageBridgeCandidateBucket;
  /** 测试时可注入时钟。 */
  now?: () => number;
}

function fail(code: StorageErrorCode, message: string): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function assertBucketId(bucketId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(bucketId)) {
    throw fail("storage_invalid_path", "Storage bucket ID is invalid");
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  if (typeof btoa !== "function") throw fail("storage_unavailable", "Base64 encoding is unavailable");
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob !== "function") throw fail("storage_unavailable", "Base64 decoding is unavailable");
  let binary: string;
  try { binary = atob(value); } catch { throw fail("storage_provider_error", "Local storage value is invalid"); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function etagFor(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeCursor(index: number): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify({ version: 1, index })));
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(new TextDecoder().decode(base64ToBytes(cursor))) as { version?: number; index?: number };
    if (value.version !== 1 || !Number.isSafeInteger(value.index) || value.index === undefined || value.index < 0) throw new Error();
    return value.index;
  } catch {
    throw fail("storage_invalid_path", "Storage cursor is invalid");
  }
}

function mapStorageError(caught: unknown): StorageRuntimeError {
  if (caught instanceof StorageRuntimeError) return caught;
  const name = caught && typeof caught === "object" ? (caught as { name?: unknown }).name : undefined;
  if (name === "QuotaExceededError") return fail("storage_limit_exceeded", "localStorage quota was exceeded");
  if (name === "AbortError") return fail("storage_unavailable", "Storage operation was cancelled");
  if (name === "SecurityError") return fail("storage_unavailable", "localStorage is unavailable");
  return fail("storage_provider_error", "localStorage operation failed");
}

function bridgeRequestWithoutSignal(input: LocalStorageBridgeRequest): LocalStorageBridgeRequest {
  if (input.type === "catalog-update" || input.type === "catalog-select") {
    const { signal, ...request } = input;
    void signal;
    return request;
  }
  if (input.type === "put") {
    const { signal, condition, ...request } = input;
    void signal;
    return { ...request, ...(condition ? { condition: { ifMatch: condition.ifMatch, ifNoneMatch: condition.ifNoneMatch } } : {}) };
  }
  const { signal, ...request } = input;
  void signal;
  return request;
}

/**
 * localStorage 桶 Provider。
 *
 * localStorage 本身没有事务；所有 compare-and-write 必须经过同桶 Web Lock，
 * 因此没有 `navigator.locks` 时写入明确失败。Worker 不能直接访问 Window，
 * 生产 Worker 通过 `bridge` 把已经加密的 bytes 交给页面桥执行。
 */
export function createLocalStorageBucketProvider(options: LocalStorageBucketProviderOptions): StorageBucketProvider {
  const bucketId = options.bucketId;
  const bucketGeneration = options.bucketGeneration ?? 1;
  assertBucketId(bucketId);
  // Window 侧的管理页/连接测试可以直接使用 localStorage；SharedWorker
  // 侧必须显式传入 bridge。不要把“未注入 storage”误判成不可用，否则
  // 页面上的 Local 测试和新桶初始化会在第一次调用前就失败。
  const storage = options.storage ?? (options.bridge ? undefined : (globalThis as typeof globalThis & { localStorage?: LocalStorageLike }).localStorage);
  if (!storage && !options.bridge) throw fail("storage_unavailable", "localStorage bridge is unavailable");
  let closed = false;
  const now = options.now ?? (() => Date.now());
  const prefix = `keymaster.bucket.${bucketId}.`;
  const locks = options.locks ?? (globalThis as typeof globalThis & { navigator?: { locks?: LocalStorageLocks } }).navigator?.locks;

  function assertOpen(path?: string, options: { allowEmptyPath?: boolean } = {}): void {
    if (closed) throw fail("storage_unavailable", "Local storage provider is closed");
    if (path !== undefined && !(options.allowEmptyPath && path === "")) assertProviderPath(path);
  }

  async function withWriter<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertOpen();
    if (signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    // Worker 侧的 bridge 不持有页面锁；真正执行 localStorage I/O 的页面
    // Provider 会再次进入同桶 Web Lock。若 Worker 也申请同名锁会形成跨
    // 全局的嵌套锁等待，因此 bridge 模式把锁边界留在页面侧。
    if (options.bridge) return operation();
    if (!locks) throw fail("storage_unavailable", "Local storage requires Web Locks for safe writes");
    try { return await locks.request(`keymaster.storage.local.${bucketId}`, operation, signal ? { signal } : undefined); }
    catch (caught) { throw mapStorageError(caught); }
  }

  function localKey(path: string): string {
    assertProviderPath(path);
    return `${prefix}${path}`;
  }

  function readLocal(path: string): StorageBucketObject | undefined {
    assertOpen(path);
    const encoded = storage!.getItem(localKey(path));
    if (encoded === null) return undefined;
    const bytes = base64ToBytes(encoded);
    return { path, bytes, size: bytes.byteLength, etag: etagFor(bytes) };
  }

  function listLocal(input: { prefix?: string; cursor?: string; limit?: number } = {}): StorageBucketListPage {
    assertOpen(input.prefix, { allowEmptyPath: true });
    const prefixValue = input.prefix ?? "";
    if (prefixValue) assertProviderPath(prefixValue.endsWith("/") ? prefixValue.slice(0, -1) : prefixValue);
    const objects: StorageBucketObject[] = [];
    for (let index = 0; index < storage!.length; index += 1) {
      const key = storage!.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const path = key.slice(prefix.length);
      if (!path.startsWith(prefixValue)) continue;
      const bytes = base64ToBytes(storage!.getItem(key) ?? "");
      objects.push({ path, bytes, size: bytes.byteLength, etag: etagFor(bytes) });
    }
    objects.sort((left, right) => left.path.localeCompare(right.path));
    const start = decodeCursor(input.cursor);
    const limit = normalizeProviderLimit(input.limit);
    const page = objects.slice(start, start + limit);
    return { objects: page, nextCursor: start + page.length < objects.length ? encodeCursor(start + page.length) : undefined };
  }

  async function bridgeRequest(request: LocalStorageBridgeRequest): Promise<LocalStorageBridgeResponse> {
    assertOpen("path" in request ? request.path : undefined);
    if (request.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    try { return await options.bridge!(bridgeRequestWithoutSignal(request)); }
    catch (caught) { throw mapStorageError(caught); }
  }

  async function get(path: string, input: { signal?: AbortSignal; ifMatch?: string } = {}): Promise<StorageBucketObject | undefined> {
    assertOpen(path);
    const result = options.bridge
      ? await bridgeRequest({ type: "get", bucketId, bucketGeneration, path, ...(options.candidateBucket ? { candidateBucket: options.candidateBucket } : {}), ...(input.ifMatch ? { ifMatch: input.ifMatch } : {}), signal: input.signal })
      : { type: "object" as const, object: readLocal(path) };
    if (result.type !== "object") throw fail("storage_provider_error", "Local storage bridge returned an invalid read result");
    if (result.object && input.ifMatch && result.object.etag !== input.ifMatch) throw fail("storage_conflict", "Storage object changed");
    return result.object;
  }

  async function put(path: string, bytes: Uint8Array, condition: StorageBucketWriteCondition & { signal?: AbortSignal } = {}): Promise<{ etag?: string; lastModified?: string }> {
    assertOpen(path);
    if (!(bytes instanceof Uint8Array)) throw fail("storage_provider_error", "Storage value must be bytes");
    return withWriter(async () => {
      if (condition.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
      if (options.bridge) {
        const result = await bridgeRequest({ type: "put", bucketId, bucketGeneration, path, ...(options.candidateBucket ? { candidateBucket: options.candidateBucket } : {}), bytes: bytes.slice(), condition, signal: condition.signal });
        if (result.type !== "write") throw fail("storage_provider_error", "Local storage bridge returned an invalid write result");
        return result;
      }
      const current = readLocal(path);
      if (condition.ifNoneMatch === "*" && current) throw fail("storage_conflict", "Storage object already exists");
      if (condition.ifMatch !== undefined && (!current || current.etag !== condition.ifMatch)) throw fail("storage_conflict", "Storage object changed");
      try { storage!.setItem(localKey(path), bytesToBase64(bytes)); }
      catch (caught) { throw mapStorageError(caught); }
      return { etag: etagFor(bytes), lastModified: new Date(now()).toISOString() };
    }, condition.signal);
  }

  async function remove(path: string, input: { signal?: AbortSignal; ifMatch?: string } = {}): Promise<void> {
    assertOpen(path);
    await withWriter(async () => {
      if (input.signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
      if (options.bridge) {
        const result = await bridgeRequest({ type: "delete", bucketId, bucketGeneration, path, ...(options.candidateBucket ? { candidateBucket: options.candidateBucket } : {}), ...(input.ifMatch ? { ifMatch: input.ifMatch } : {}), signal: input.signal });
        if (result.type !== "void") throw fail("storage_provider_error", "Local storage bridge returned an invalid delete result");
        return;
      }
      const current = readLocal(path);
      if (!current) return;
      if (input.ifMatch !== undefined && current.etag !== input.ifMatch) throw fail("storage_conflict", "Storage object changed");
      try { storage!.removeItem(localKey(path)); }
      catch (caught) { throw mapStorageError(caught); }
    }, input.signal);
  }

  return {
    provider: "local",
    bucketId,
    async probe(signal): Promise<StorageBucketProbeResult> {
      const started = now();
      const probePath = `.keymaster/probes/${crypto.randomUUID()}`;
      const bytes = new TextEncoder().encode("keymaster-local-probe");
      try {
        await put(probePath, bytes, { ifNoneMatch: "*", signal });
        const readback = await get(probePath, { signal });
        if (!readback || readback.etag !== etagFor(bytes)) throw fail("storage_provider_error", "localStorage probe readback failed");
        try {
          await put(probePath, bytes, { ifMatch: "keymaster-invalid-etag", signal });
          throw fail("storage_provider_error", "localStorage provider ignored If-Match");
        } catch (caught) {
          if (!(caught instanceof StorageRuntimeError) || caught.code !== "storage_conflict") throw caught;
        }
        await remove(probePath, { signal });
        return { ok: true, conditionalWrites: "native", latencyMs: Math.max(0, now() - started) };
      } catch (caught) {
        if (caught instanceof StorageRuntimeError) throw caught;
        throw mapStorageError(caught);
      }
    },
    get,
    async list(input = {}): Promise<StorageBucketListPage> {
      assertOpen(input.prefix, { allowEmptyPath: true });
      if (options.bridge) {
        const result = await bridgeRequest({ type: "list", bucketId, bucketGeneration, ...(options.candidateBucket ? { candidateBucket: options.candidateBucket } : {}), ...input });
        if (result.type !== "list") throw fail("storage_provider_error", "Local storage bridge returned an invalid list result");
        return { objects: result.objects, nextCursor: result.nextCursor };
      }
      return listLocal(input);
    },
    put,
    delete: remove,
    dispose() { closed = true; }
  };
}
