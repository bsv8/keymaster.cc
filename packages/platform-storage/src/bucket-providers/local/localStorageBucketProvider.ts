import type {
  DevicePasswordRotationRecordV1,
  DeviceRemoteConnectionV1,
  DeviceRemoteRecoveryPointerV1,
  StorageBucketCatalogEntryV2,
  StorageBucketListPage,
  StorageBucketObject,
  StorageBucketProbeResult,
  StorageCatalogV2,
  StorageBucketProvider,
  StorageBucketWriteCondition
} from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import type { StorageErrorCode } from "@keymaster/contracts";
import { StorageRuntimeError, storageErrorCode } from "../../runtime/storageError.js";
import { browserStorageLocks, type BrowserStorageLocks } from "../../runtime/browserLocks.js";
import { assertProviderPath, normalizeProviderLimit } from "../bucketProvider.js";

/** 开发适配器的最小同步键值接口，仅允许测试或显式宿主注入。 */
export interface LocalStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Web Locks 的最小接口；没有锁就不能宣称支持原子 CAS。 */
export interface LocalStorageLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
  request<T>(name: string, options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T>;
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
  /** 首次初始化专用：目录仍为空时允许暂存候选命名空间。 */
  initialSetup?: boolean;
  /** 仅允许清理本事务候选对象；即使目录已被其它事务提交也可 list/delete。 */
  cleanupOnly?: boolean;
}

/** 页面桥的窄操作协议；桥在真正执行设备 I/O 前必须重新校验租约。 */
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
  /** 首次初始化的唯一目录提交点；正常调用把空目录变成一个 selected 桶，rollback 只移除本次同一条目。 */
  | { type: "catalog-commit"; bucketId: string; bucketGeneration: number; authorityInstanceId?: string; leaseId?: string; targetBucket: StorageBucketCatalogEntryV2; rollback?: boolean; signal?: AbortSignal }
  /** 切桶最终目录 CAS；不传密码，仅更新 selectedBucketId。 */
  | { type: "catalog-select"; bucketId: string; bucketGeneration: number; authorityInstanceId?: string; leaseId?: string; expectedSelectedBucketId?: string; /** CAS 请求丢失响应时允许按目标桶回收；页面仍会在 Web Lock 内确认目录当前值。 */ rollbackFromSelectedBucketId?: string; targetBucket: StorageBucketCatalogEntryV2; signal?: AbortSignal }
  /** 读取当前目录；用于并发初始化回滚前重新确认权威引用。 */
  | { type: "catalog-read"; authorityInstanceId?: string; leaseId?: string; signal?: AbortSignal }
  | { type: "device-bootstrap-read"; authorityInstanceId?: string; leaseId?: string; signal?: AbortSignal }
  | { type: "device-bootstrap-connection-upsert"; authorityInstanceId?: string; leaseId?: string; connection: DeviceRemoteConnectionV1; select?: boolean; signal?: AbortSignal }
  | { type: "device-bootstrap-recovery-upsert"; authorityInstanceId?: string; leaseId?: string; recovery: DeviceRemoteRecoveryPointerV1; signal?: AbortSignal }
  | { type: "device-bootstrap-recovery-delete"; authorityInstanceId?: string; leaseId?: string; operationId: string; signal?: AbortSignal }
  | { type: "device-bootstrap-rotation-upsert"; authorityInstanceId?: string; leaseId?: string; rotation: DevicePasswordRotationRecordV1; signal?: AbortSignal }
  | { type: "device-bootstrap-rotation-delete"; authorityInstanceId?: string; leaseId?: string; operationId: string; signal?: AbortSignal };

export type LocalStorageBridgeResponse =
  | { type: "object"; object?: LocalStorageBridgeObject }
  | { type: "list"; objects: LocalStorageBridgeObject[]; nextCursor?: string }
  | { type: "write"; etag?: string; lastModified?: string }
  | { type: "void" }
  | { type: "catalog"; bucket: StorageBucketCatalogEntryV2 }
  | { type: "catalog-state"; catalog: StorageCatalogV2 }
  | { type: "device-bootstrap"; catalog: import("@keymaster/contracts").DeviceBootstrapCatalogV1 | null };

export interface LocalStorageBucketProviderOptions {
  /** 测试/开发宿主显式注入的同步键值设施。 */
  storage?: LocalStorageLike;
  /** 页面桥；存在时不触碰当前执行上下文的任何持久化设施。 */
  bridge?: (request: LocalStorageBridgeRequest) => Promise<LocalStorageBridgeResponse>;
  /** Web Locks；不注入时尝试使用当前 Window 的 navigator.locks。 */
  locks?: LocalStorageLocks;
  /** 抽象桶身份，不是物理 key 前缀。 */
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
  // WebLoom 的跨 realm 错误不会保留 StorageRuntimeError 原型，但页面侧
  // capability adapter 会把领域错误码写入 WebLoomError.code。必须先恢复
  // 该错误码，否则正常的 CAS 冲突会被误判成 provider 故障并触发回滚。
  const transportedCode = storageErrorCode(caught);
  if (transportedCode) {
    const message = transportedCode === "storage_conflict"
      ? "Local storage object changed"
      : transportedCode === "storage_limit_exceeded"
        ? "Injected local provider quota was exceeded"
        : transportedCode === "storage_forbidden"
          ? "Local storage operation is forbidden"
          : transportedCode === "storage_unavailable"
            ? "Injected local provider storage is unavailable"
            : "Local storage operation failed";
    return fail(transportedCode, message);
  }
  const name = caught && typeof caught === "object" ? (caught as { name?: unknown }).name : undefined;
  if (name === "QuotaExceededError") return fail("storage_limit_exceeded", "Injected local provider quota was exceeded");
  if (name === "AbortError") return fail("storage_unavailable", "Storage operation was cancelled");
  if (name === "SecurityError") return fail("storage_unavailable", "Injected local provider storage is unavailable");
  return fail("storage_provider_error", "Injected local provider operation failed");
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
 * 仅供开发/测试的 Local Provider。
 *
 * 注入的同步键值设施本身没有事务；所有 compare-and-write 必须经过同桶 Web Lock，
 * 因此安全上下文优先使用 Web Locks；任意主机 HTTP 页面没有 Web Locks 时
 * 使用当前页面内的兼容队列。该队列不提供跨标签页互斥，不能作为多标签页
 * 安全保证。Worker 不能直接访问 Window，生产 Worker 通过 `bridge` 把已经
 * 加密的 bytes 交给页面桥执行。
 */
export function createLocalStorageBucketProvider(options: LocalStorageBucketProviderOptions): StorageBucketProvider {
  const bucketId = options.bucketId;
  const bucketGeneration = options.bucketGeneration ?? 1;
  assertBucketId(bucketId);
  // Local Provider 不得自行取得浏览器持久化设施。测试/开发宿主必须显式
  // 注入 storage，Worker 则必须注入受租约保护的 bridge。
  const storage = options.storage;
  if (!storage && !options.bridge) throw fail("storage_unavailable", "Injected Local Provider storage or bridge is required");
  let closed = false;
  const now = options.now ?? (() => Date.now());
  const prefix = `keymaster.bucket.${bucketId}.`;
  const locks: LocalStorageLocks | BrowserStorageLocks | undefined = options.locks ?? browserStorageLocks();

  function assertOpen(path?: string, options: { allowEmptyPath?: boolean } = {}): void {
    if (closed) throw fail("storage_unavailable", "Local storage provider is closed");
    if (path !== undefined && !(options.allowEmptyPath && path === "")) assertProviderPath(path);
  }

  async function withWriter<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertOpen();
    if (signal?.aborted) throw fail("storage_unavailable", "Storage operation was cancelled");
    // Worker 侧的 bridge 不持有页面锁；真正执行设备 I/O 的页面
    // Provider 会再次进入同桶 Web Lock。若 Worker 也申请同名锁会形成跨
    // 全局的嵌套锁等待，因此 bridge 模式把锁边界留在页面侧。
    if (options.bridge) return operation();
    if (!locks) throw fail("storage_unavailable", "Local storage locking is unavailable");
    try {
      return signal
        ? await locks.request(`keymaster.storage.local.${bucketId}`, { signal }, operation)
        : await locks.request(`keymaster.storage.local.${bucketId}`, operation);
    }
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
    const prefixValue = input.prefix ?? "";
    // 目录前缀允许以 `/` 结尾（例如 owner namespace）；校验时剥离末尾斜杠。
    assertOpen(prefixValue && prefixValue.endsWith("/") ? prefixValue.slice(0, -1) : prefixValue, { allowEmptyPath: true });
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
        if (!readback || readback.etag !== etagFor(bytes)) throw fail("storage_provider_error", "Injected local provider probe readback failed");
        try {
          await put(probePath, bytes, { ifMatch: "keymaster-invalid-etag", signal });
          throw fail("storage_provider_error", "Injected local provider ignored If-Match");
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
      // 目录前缀允许以 `/` 结尾（例如 owner namespace）；校验时剥离末尾
      // 斜杠，与 listLocal 和 S3 Provider 的语义保持一致。
      const listPrefix = input.prefix ?? "";
      assertOpen(listPrefix && listPrefix.endsWith("/") ? listPrefix.slice(0, -1) : listPrefix, { allowEmptyPath: true });
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
