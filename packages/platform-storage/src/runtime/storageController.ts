// Worker 侧 Storage 运行时控制器。
//
// 相对旧实现，这个控制器只保留本地介质真正需要的东西：
//   - 一个固定 Key 的冷启动、初始化、解锁、锁定、改密、改名、导出与重置；
//   - 第三方 App 的受限文件数据面（列举、建目录、写、区间读、删、批量）；
//   - 浏览器持久化授权与配额的只读视图。
//
// 删除：桶目录、切桶、条件写能力探测、远程健康状态、multipart 上传和
// S3 初始化恢复。Connect 的游标是 Worker 内存态，App 断开即失效，不写盘。

import type {
  OwnerAppStorageGrant,
  StorageDeleteResult,
  StorageDirectoryResult,
  StorageGetResult,
  StorageListEntry,
  StorageListResult,
  StoragePutResult,
  StorageRuntimeController as StorageRuntimeControllerContract,
  StorageRuntimeControllerStatus,
  StorageRuntimeSummary,
  WalletColdStartSnapshot,
  WalletInitializePlan,
  WalletInitializeResult,
  WalletUnlockResult,
} from "@keymaster/contracts";
import {
  STORAGE_CURSOR_TTL_MS,
  STORAGE_DEFAULT_LIST_LIMIT,
  STORAGE_MAX_CURSORS_GLOBAL,
  STORAGE_MAX_CURSORS_PER_SESSION,
  STORAGE_MAX_LIST_LIMIT,
} from "@keymaster/contracts";
import type { ModuleFileStore } from "@keymaster/contracts";
import { StorageRuntimeError, storageErrorCode } from "./storageError.js";

interface CursorRecord {
  connectSessionId: string;
  appStorageName: string;
  prefix: string;
  after: string | undefined;
  limit: number;
  expiresAt: number;
}

/** Connect 目录 marker 后缀；目录只是路径前缀约定，不额外占用对象。 */
const DIRECTORY_MARKER_SUFFIX = "/.dir";

const CURSOR_TTL_MS = STORAGE_CURSOR_TTL_MS;
const MAX_CURSORS = STORAGE_MAX_CURSORS_GLOBAL;
const MAX_CURSORS_PER_SESSION = STORAGE_MAX_CURSORS_PER_SESSION;
const CURSOR_IDLE_GC_LIMIT = 256;
const DEFAULT_CONNECT_LIST_LIMIT = STORAGE_DEFAULT_LIST_LIMIT;
const MAX_CONNECT_LIST_LIMIT = STORAGE_MAX_LIST_LIMIT;

export interface StorageRuntimeControllerDeps {
  /** 冷启动与钱包生命周期。 */
  coldStart(): Promise<WalletColdStartSnapshot>;
  initialize(plan: WalletInitializePlan): Promise<WalletInitializeResult>;
  unlock(password: string): Promise<WalletUnlockResult>;
  lock(): Promise<void>;
  changeKeyPassword(input: { oldPassword: string; newPassword: string }): Promise<void>;
  renameKey(label: string): Promise<void>;
  exportKeyHold(): Promise<Uint8Array>;
  resetWallet(input: { confirmationLabel: string }): Promise<{ walletGeneration: string; clearedAt: string }>;
  /** 当前钱包摘要（公钥、标签、世代）。 */
  summary(): Promise<Omit<StorageRuntimeSummary, "status" | "medium" | "persistence">>;
  /** 为一个已验证 Connect App 打开它的独立目录句柄。 */
  openAppFileStore(ctx: OwnerAppStorageGrant): Promise<ModuleFileStore>;
  /** 中止一个 Connect 会话。 */
  abortSession(connectSessionId: string): Promise<void>;
  /** 浏览器持久化授权与配额。 */
  persistence(): Promise<{ persisted: boolean; usageBytes?: number; quotaBytes?: number }>;
  /** 当前状态；由生命周期层驱动。 */
  status(): StorageRuntimeControllerStatus;
  now?: () => number;
  generateId?: () => string;
}

function asError(error: unknown): StorageRuntimeError {
  if (error instanceof StorageRuntimeError) return error;
  const code = storageErrorCode(error);
  if (code) return new StorageRuntimeError(code);
  return new StorageRuntimeError("storage_provider_error", "Storage operation failed");
}

function now(deps: StorageRuntimeControllerDeps): number {
  return deps.now?.() ?? Date.now();
}

function id(deps: StorageRuntimeControllerDeps): string {
  return deps.generateId ? deps.generateId() : crypto.randomUUID();
}

/** Connect 可见的相对目录路径；空串表示 App 根。 */
function normalizeAppPrefix(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("/") || trimmed.includes("\\") || trimmed.includes("\u0000")) {
    throw new StorageRuntimeError("storage_invalid_path", "Storage prefix is invalid");
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new StorageRuntimeError("storage_invalid_path", "Storage prefix is invalid");
  }
  return segments.join("/");
}

/** 父目录前缀；根的父级仍是根。 */
function parentPrefix(prefix: string): string {
  if (prefix === "") return "";
  const index = prefix.lastIndexOf("/");
  return index < 0 ? "" : prefix.slice(0, index);
}

function assertListLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_CONNECT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONNECT_LIST_LIMIT) {
    throw new StorageRuntimeError("storage_limit_exceeded", "Storage list limit is invalid");
  }
  return limit;
}

export class StorageRuntimeControllerImpl implements StorageRuntimeControllerContract {
  private readonly listeners = new Set<() => void>();
  private readonly cursors = new Map<string, CursorRecord>();
  private disposed = false;

  constructor(private readonly deps: StorageRuntimeControllerDeps) {}

  /** 控制器自身即依赖来源：列表时间戳与游标 ID 都由注入的时钟/生成器决定。 */
  private get clock(): StorageRuntimeControllerDeps {
    return this.deps;
  }

  status(): StorageRuntimeControllerStatus {
    return this.deps.status();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async summary(): Promise<StorageRuntimeSummary> {
    const [base, persistence] = await Promise.all([this.deps.summary(), this.deps.persistence()]);
    return { ...base, status: this.deps.status(), medium: "indexeddb", persistence };
  }

  coldStart(): Promise<WalletColdStartSnapshot> {
    return this.deps.coldStart();
  }

  initialize(plan: WalletInitializePlan): Promise<WalletInitializeResult> {
    return this.deps.initialize(plan);
  }

  unlock(password: string): Promise<WalletUnlockResult> {
    return this.deps.unlock(password);
  }

  lock(): Promise<void> {
    return this.deps.lock();
  }

  changeKeyPassword(input: { oldPassword: string; newPassword: string }): Promise<void> {
    return this.deps.changeKeyPassword(input);
  }

  renameKey(label: string): Promise<void> {
    return this.deps.renameKey(label);
  }

  exportKeyHold(): Promise<Uint8Array> {
    return this.deps.exportKeyHold();
  }

  resetWallet(input: { confirmationLabel: string }): Promise<{ walletGeneration: string; clearedAt: string }> {
    return this.deps.resetWallet(input);
  }

  async abortSession(connectSessionId: string): Promise<void> {
    // 断开会话同时丢弃它的游标：游标是运行态句柄，不是持久真值。
    for (const [key, record] of [...this.cursors]) {
      if (record.connectSessionId === connectSessionId) this.cursors.delete(key);
    }
    await this.deps.abortSession(connectSessionId);
  }

  async list(ctx: OwnerAppStorageGrant, input: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<StorageListResult> {
    const store = await this.deps.openAppFileStore(ctx);
    const prefix = normalizeAppPrefix(input.prefix);
    const limit = assertListLimit(input.limit);
    const absolutePrefix = `${prefix === "" ? "" : `${prefix}/`}`;
    const after = input.cursor === undefined
      ? undefined
      : this.resolveCursor(ctx, input.cursor, prefix, limit);
    const page = await store.list({
      ...(absolutePrefix === "" ? {} : { prefix: absolutePrefix }),
      ...(after === undefined ? {} : { cursor: after }),
      limit,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const directories = new Map<string, StorageListEntry["path"] extends string ? string : never>();
    const files: StorageListEntry[] = [];
    for (const entry of page.files) {
      const relative = entry.path.startsWith(absolutePrefix) ? entry.path.slice(absolutePrefix.length) : entry.path;
      // 目录 marker 是实现细节，不出现在 Connect 的文件列表里。
      if (relative === ".dir") continue;
      const slash = relative.indexOf("/");
      if (slash > 0) {
        const child = absolutePrefix + relative.slice(0, slash);
        directories.set(child, child.slice(absolutePrefix.length));
        continue;
      }
      files.push({
        path: absolutePrefix + relative,
        name: relative,
        size: entry.size,
        revision: entry.revision,
        lastModified: entry.lastModified,
      });
    }
    const nextCursor = page.nextCursor === undefined
      ? undefined
      : this.issueCursor(ctx, {
        connectSessionId: ctx.connectSessionId,
        appStorageName: ctx.appStorageName,
        prefix,
        after: page.nextCursor,
        limit,
        expiresAt: now(this.clock) + CURSOR_TTL_MS,
      });
    return {
      prefix: absolutePrefix,
      parentPrefix: parentPrefix(prefix) === "" ? "" : `${parentPrefix(prefix)}/`,
      directories: [...directories.values()].map((path) => ({ path, name: path.slice(absolutePrefix.length) })),
      files,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async createDirectory(ctx: OwnerAppStorageGrant, input: { path: string; overwrite?: boolean }): Promise<StorageDirectoryResult> {
    const store = await this.deps.openAppFileStore(ctx);
    const prefix = normalizeAppPrefix(input.path);
    if (prefix === "") throw new StorageRuntimeError("storage_invalid_path", "Directory path is required");
    const marker = `${prefix}${DIRECTORY_MARKER_SUFFIX}`;
    const existing = await store.get(marker);
    if (existing && input.overwrite !== true) {
      throw new StorageRuntimeError("storage_conflict", "Storage directory already exists");
    }
    await store.put(marker, new Uint8Array(0), { contentType: "application/x-directory" });
    return { path: prefix, created: true };
  }

  async deleteDirectory(ctx: OwnerAppStorageGrant, input: { path: string }): Promise<StorageDirectoryResult> {
    const store = await this.deps.openAppFileStore(ctx);
    const prefix = normalizeAppPrefix(input.path);
    if (prefix === "") throw new StorageRuntimeError("storage_invalid_path", "Directory path is required");
    const page = await store.list({ prefix: `${prefix}/`, limit: MAX_CONNECT_LIST_LIMIT });
    if (page.files.length > 0) {
      throw new StorageRuntimeError("storage_conflict", "Storage directory is not empty");
    }
    await store.delete(`${prefix}${DIRECTORY_MARKER_SUFFIX}`);
    return { path: prefix, deleted: true };
  }

  async put(ctx: OwnerAppStorageGrant, input: {
    path: string;
    content: { $type: "binary"; bytes: ArrayBuffer; mime?: string };
    contentType?: string;
    overwrite?: boolean;
  }): Promise<StoragePutResult> {
    const store = await this.deps.openAppFileStore(ctx);
    const path = normalizeAppPrefix(input.path);
    if (path === "" || path.endsWith(DIRECTORY_MARKER_SUFFIX)) {
      throw new StorageRuntimeError("storage_invalid_path", "Storage file path is required");
    }
    const bytes = new Uint8Array(input.content.bytes);
    if (input.overwrite === false) {
      const existing = await store.get(path);
      if (existing) throw new StorageRuntimeError("storage_conflict", "Storage object already exists");
    }
    const written = await store.put(path, bytes, {
      contentType: input.contentType ?? input.content.mime ?? "application/octet-stream",
    });
    return {
      path,
      size: bytes.byteLength,
      revision: written.revision,
      updatedAt: Date.parse(written.lastModified) || now(this.clock),
    };
  }

  async getRange(ctx: OwnerAppStorageGrant, input: {
    path: string;
    offset?: number;
    length?: number;
    ifMatch?: string;
  }): Promise<StorageGetResult> {
    const store = await this.deps.openAppFileStore(ctx);
    const path = normalizeAppPrefix(input.path);
    const object = await store.get(path);
    if (!object) throw new StorageRuntimeError("storage_not_found", "Storage object was not found");
    if (input.ifMatch !== undefined && input.ifMatch !== object.revision) {
      throw new StorageRuntimeError("storage_conflict", "Storage object changed");
    }
    const totalSize = object.bytes.byteLength;
    const offset = Math.min(Math.max(0, input.offset ?? 0), totalSize);
    const end = input.length === undefined ? totalSize : Math.min(totalSize, offset + Math.max(0, input.length));
    const bytes = object.bytes.slice(offset, end);
    return {
      path,
      // 拷贝成独立 ArrayBuffer：transfer 到页面时不能与 Worker 内部缓冲共享。
      content: { $type: "binary", bytes: bytes.slice().buffer },
      offset,
      totalSize,
      eof: end >= totalSize,
      revision: object.revision,
      lastModified: object.lastModified,
    };
  }

  async delete(ctx: OwnerAppStorageGrant, input: { path: string }): Promise<StorageDeleteResult> {
    const store = await this.deps.openAppFileStore(ctx);
    const path = normalizeAppPrefix(input.path);
    if (path === "") throw new StorageRuntimeError("storage_invalid_path", "Storage file path is required");
    await store.delete(path);
    return { path, deleted: true, updatedAt: now(this.clock) };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.cursors.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 游标是 Worker 内存态：绑定会话、App name 与前缀，跨会话复用即拒绝。 */
  private issueCursor(ctx: OwnerAppStorageGrant, record: Omit<CursorRecord, "expiresAt"> & { expiresAt: number }): string {
    this.gcCursors();
    let perSession = 0;
    for (const candidate of this.cursors.values()) {
      if (candidate.connectSessionId === record.connectSessionId) perSession += 1;
    }
    if (perSession >= MAX_CURSORS_PER_SESSION) {
      const oldest = [...this.cursors.entries()]
        .filter(([, candidate]) => candidate.connectSessionId === record.connectSessionId)
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
      if (oldest) this.cursors.delete(oldest[0]);
    }
    const key = `${record.connectSessionId}|${record.appStorageName}|${record.after ?? ""}|${record.prefix}`;
    this.cursors.set(key, record);
    return `${id(this.clock)}.${key}`;
  }

  private resolveCursor(ctx: OwnerAppStorageGrant, cursor: string, prefix: string, limit: number): string {
    const separator = cursor.indexOf(".");
    const key = separator < 0 ? cursor : cursor.slice(separator + 1);
    const record = this.cursors.get(key);
    if (!record
      || record.connectSessionId !== ctx.connectSessionId
      || record.appStorageName !== ctx.appStorageName
      || record.prefix !== prefix
      || record.limit !== limit
      || record.expiresAt <= now(this.clock)) {
      throw new StorageRuntimeError("storage_conflict", "Storage cursor is no longer valid");
    }
    return record.after ?? "";
  }

  private gcCursors(): void {
    const timestamp = now(this.clock);
    for (const [key, record] of [...this.cursors]) {
      if (record.expiresAt <= timestamp) this.cursors.delete(key);
    }
    while (this.cursors.size > CURSOR_IDLE_GC_LIMIT) {
      const oldest = [...this.cursors.entries()].sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
      if (!oldest) return;
      this.cursors.delete(oldest[0]);
    }
  }
}

export async function createStorageRuntimeController(
  deps: StorageRuntimeControllerDeps,
): Promise<StorageRuntimeControllerContract> {
  return new StorageRuntimeControllerImpl(deps);
}
