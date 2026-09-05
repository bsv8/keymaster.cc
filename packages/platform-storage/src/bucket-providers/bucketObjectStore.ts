/**
 * 抽象桶 Provider 与条件写能力状态。
 *
 * 本文件只定义 Provider 适配层使用的通用对象形状和能力状态，不引入
 * S3 SDK、OPFS API 或任何具体物理存储实现。具体实现必须位于对应 Provider
 * 子目录，避免业务层绕过统一边界。
 */

export interface BucketObject {
  /** 物理对象路径；Provider 内部始终使用相对桶根的路径。 */
  key: string;
  /** 对象字节数。 */
  size: number;
  /** Provider 返回的 ETag。 */
  etag?: string;
  /** Provider 返回的最后修改时间。 */
  lastModified?: Date;
}

export interface BucketListOutput {
  /** 当前页对象元数据。 */
  objects: BucketObject[];
  /** 当前页下的逻辑目录。 */
  commonPrefixes: string[];
  /** Provider 分页游标。 */
  nextContinuationToken?: string;
}

export interface BucketGetOutput {
  /** 对象内容。 */
  bytes: Uint8Array;
  /** range 请求实际返回的起始偏移。 */
  offset?: number;
  /** 内容类型。 */
  contentType?: string;
  /** Provider 返回的 Content-Range。 */
  contentRange?: string;
  /** 当前响应字节数。 */
  contentLength?: number;
  /** 完整对象字节数。 */
  totalSize?: number;
  /** Provider 返回的 ETag。 */
  etag?: string;
  /** Provider 返回的最后修改时间。 */
  lastModified?: Date;
}

export interface BucketObjectStore {
  probe(prefix: string, signal?: AbortSignal): Promise<void>;
  list(input: { namespaceRoot: string; prefix: string; delimiter?: string; continuationToken?: string; maxKeys: number; signal?: AbortSignal }): Promise<BucketListOutput>;
  put(input: { namespaceRoot: string; key: string; bytes: Uint8Array; contentType?: string; ifNoneMatch?: string; ifMatch?: string; signal?: AbortSignal }): Promise<{ etag?: string; lastModified?: Date }>;
  head(input: { namespaceRoot: string; key: string; signal?: AbortSignal }): Promise<boolean>;
  get(input: { namespaceRoot: string; key: string; range?: string; ifMatch?: string; signal?: AbortSignal }): Promise<BucketGetOutput>;
  delete(input: { namespaceRoot: string; key: string; ifMatch?: string; signal?: AbortSignal }): Promise<void>;
  createMultipart(input: { namespaceRoot: string; key: string; contentType?: string; signal?: AbortSignal }): Promise<string>;
  uploadPart(input: { namespaceRoot: string; key: string; uploadId: string; partNumber: number; bytes: Uint8Array; signal?: AbortSignal }): Promise<string>;
  completeMultipart(input: { namespaceRoot: string; key: string; uploadId: string; parts: Array<{ partNumber: number; etag: string }>; ifNoneMatch?: string; ifMatch?: string; signal?: AbortSignal }): Promise<{ etag?: string; lastModified?: Date }>;
  abortMultipart(input: { namespaceRoot: string; key: string; uploadId: string; signal?: AbortSignal }): Promise<void>;
  dispose(): void;
}

/** 测试或 Provider 工厂注入的客户端；根目录不依赖具体 SDK。 */
export interface BucketClientAdapter {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  destroy(): void;
}

export type BucketConditionalWriteMode = "unknown" | "native" | "best-effort";
export type BucketConditionalCapabilitySource = "automatic" | "manual";

export interface BucketConditionalCapability {
  /** 已验证的条件写模式。 */
  mode: BucketConditionalWriteMode;
  /** 能力来源：启动自动探测或用户手动探测。 */
  source?: BucketConditionalCapabilitySource;
  /** 最近一次状态变化时间。 */
  updatedAt?: number;
  /** 手动覆盖或世代切换使用的版本号。 */
  revision: number;
  /** 当前正在执行的探测。 */
  probe?: Promise<unknown>;
}

/** 同一 Provider 世代共享的条件写能力状态。 */
export interface BucketObjectStoreCapabilityState {
  put: BucketConditionalCapability;
  complete: BucketConditionalCapability;
  subscribe?: (listener: () => void) => () => void;
}

export function createBucketObjectStoreCapabilityState(): BucketObjectStoreCapabilityState {
  const listeners = new Set<() => void>();
  const state: BucketObjectStoreCapabilityState = {
    put: { mode: "unknown", revision: 0 },
    complete: { mode: "unknown", revision: 0 },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
  Object.defineProperty(state, "_notify", {
    value: () => { for (const listener of listeners) listener(); },
    enumerable: false
  });
  return state;
}

function notifyCapabilityState(state: BucketObjectStoreCapabilityState): void {
  const notify = (state as BucketObjectStoreCapabilityState & { _notify?: () => void })._notify;
  notify?.();
}

export function setBucketObjectStoreCapabilityMode(
  state: BucketObjectStoreCapabilityState,
  capability: "put" | "complete",
  mode: BucketConditionalWriteMode,
  source: BucketConditionalCapabilitySource
): void {
  const target = state[capability];
  if (source === "manual") target.revision += 1;
  target.mode = mode;
  target.source = source;
  target.updatedAt = Date.now();
  notifyCapabilityState(state);
}

export function commitAutomaticBucketObjectStoreCapability(
  state: BucketObjectStoreCapabilityState,
  capability: "put" | "complete",
  mode: BucketConditionalWriteMode,
  revision: number
): boolean {
  const target = state[capability];
  if (target.revision !== revision || target.mode !== "unknown") return false;
  target.mode = mode;
  target.source = "automatic";
  target.updatedAt = Date.now();
  notifyCapabilityState(state);
  return true;
}
