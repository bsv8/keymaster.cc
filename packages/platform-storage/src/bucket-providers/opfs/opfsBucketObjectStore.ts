import type {
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

interface OpfsDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values?(): AsyncIterable<OpfsDirectoryHandle | OpfsFileHandle>;
  kind: "directory";
  name: string;
}

interface OpfsFileHandle {
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableFileStream>;
  kind: "file";
  name: string;
}

interface OpfsWritableFileStream {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface OpfsStorageManager {
  getDirectory(): Promise<OpfsDirectoryHandle>;
  persist?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}

export interface OpfsBucketProviderOptions {
  /** 测试或宿主可注入根句柄；生产默认取 navigator.storage.getDirectory()。 */
  root?: OpfsDirectoryHandle;
  /** 抽象桶 ID，不等于 OPFS 物理目录。 */
  bucketId?: string;
  /** 测试时可注入 navigator.storage。 */
  storageManager?: OpfsStorageManager;
  /** 可注入时钟，便于测试。 */
  now?: () => number;
}

function error(code: StorageErrorCode, message: string = code): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function etagFor(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeCursor(index: number): string {
  return btoa(JSON.stringify({ version: 1, index }));
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(atob(cursor)) as { version?: number; index?: number };
    const index = value.index;
    if (value.version !== 1 || !Number.isSafeInteger(index) || index === undefined || index < 0) throw new Error();
    return index;
  } catch {
    throw error("storage_invalid_path", "Storage cursor is invalid");
  }
}

async function readFileObject(handle: OpfsFileHandle): Promise<{ bytes: Uint8Array; lastModified: string | undefined }> {
  try {
    const file = await handle.getFile();
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      lastModified: Number.isFinite(file.lastModified) && file.lastModified > 0
        ? new Date(file.lastModified).toISOString()
        : undefined,
    };
  } catch {
    throw error("storage_provider_error", "OPFS read failed");
  }
}

async function readFile(handle: OpfsFileHandle): Promise<Uint8Array> {
  return (await readFileObject(handle)).bytes;
}

async function getDirectory(root: OpfsDirectoryHandle, path: string, create: boolean): Promise<OpfsDirectoryHandle> {
  let current = root;
  for (const segment of path ? path.split("/") : []) {
    try {
      current = await current.getDirectoryHandle(segment, { create });
    } catch {
      if (!create) throw error("storage_not_found", "Storage object was not found");
      throw error("storage_provider_error", "OPFS directory operation failed");
    }
  }
  return current;
}

async function getFile(root: OpfsDirectoryHandle, path: string, create: boolean): Promise<OpfsFileHandle> {
  const segments = path.split("/");
  const name = segments.pop();
  if (!name) throw error("storage_invalid_path", "Storage path is invalid");
  return getDirectory(root, segments.join("/"), create).then((directory) => directory.getFileHandle(name, { create }));
}

async function listRecursive(root: OpfsDirectoryHandle, prefix: string, output: StorageBucketObject[]): Promise<void> {
  if (!root.values) return;
  for await (const entry of root.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      await listRecursive(entry, path, output);
      continue;
    }
    const value = await readFileObject(entry);
    output.push({ path, bytes: value.bytes, size: value.bytes.byteLength, etag: etagFor(value.bytes), lastModified: value.lastModified });
  }
}

/**
 * OPFS 抽象桶 Provider。
 * 所有写操作必须通过同一个 navigator.locks 名称串行化；没有本地数据库
 * fallback。没有原生 FileSystemHandle.move 时拒绝写入，避免复制覆盖在
 * 崩溃点产生半写入对象。
 */
export function createOpfsBucketProvider(options: OpfsBucketProviderOptions = {}): StorageBucketProvider {
  const manager = options.storageManager ?? (globalThis as typeof globalThis & { navigator?: { storage?: OpfsStorageManager } }).navigator?.storage;
  const bucketId = options.bucketId ?? "opfs:default";
  let rootPromise: Promise<OpfsDirectoryHandle> | undefined = options.root ? Promise.resolve(options.root) : manager?.getDirectory();
  let closed = false;
  const now = options.now ?? (() => Date.now());

  function requireOpen(): void {
    if (closed) throw error("storage_unavailable", "Storage provider is closed");
    if (!rootPromise) throw error("storage_unavailable", "OPFS is unavailable");
  }

  async function withWriter<T>(operation: () => Promise<T>): Promise<T> {
    requireOpen();
    const locks = (globalThis as typeof globalThis & { navigator?: { locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> } } }).navigator?.locks;
    if (!locks) throw error("storage_unavailable", "OPFS requires navigator.locks for safe writes");
    return locks.request(`keymaster.storage.${bucketId}`, operation);
  }

  async function currentRoot(): Promise<OpfsDirectoryHandle> {
    requireOpen();
    try {
      return await rootPromise!;
    } catch {
      throw error("storage_unavailable", "OPFS root is unavailable");
    }
  }

  async function read(path: string, signal?: AbortSignal): Promise<StorageBucketObject | undefined> {
    assertProviderPath(path);
    if (signal?.aborted) throw error("storage_unavailable", "Storage operation was cancelled");
    try {
      const value = await readFileObject(await getFile(await currentRoot(), path, false));
      return { path, bytes: value.bytes, size: value.bytes.byteLength, etag: etagFor(value.bytes), lastModified: value.lastModified };
    } catch (caught) {
      if (caught instanceof StorageRuntimeError) {
        if (caught.code === "storage_not_found") return undefined;
        throw caught;
      }
      throw error("storage_not_found", "Storage object was not found");
    }
  }

  return {
    provider: "opfs",
    bucketId,
    async probe(signal): Promise<StorageBucketProbeResult> {
      const started = now();
      try {
        if (signal?.aborted) throw error("storage_unavailable", "Storage operation was cancelled");
        const root = await currentRoot();
        // 生产 OPFS 必须显式申请持久化；注入 root 的单元测试不具备
        // StorageManager，因此只在真实浏览器入口执行该探测。
        if (!options.root) {
          if (!manager?.persist || await manager.persist() !== true) throw error("storage_unavailable", "OPFS persistence was not granted");
        }
        const probeName = `.keymaster/probes/${etagFor(new TextEncoder().encode(String(started)))}`;
        const bytes = new TextEncoder().encode("keymaster-opfs-probe");
        await this.put(probeName, bytes, { ifNoneMatch: "*", signal });
        const check = await this.get(probeName, { signal });
        if (!check || check.etag !== etagFor(bytes)) throw error("storage_provider_error", "OPFS probe readback failed");
        // 验证 If-Match 不是“请求成功但条件头被忽略”；错误 ETag 必须
        // 原子拒绝，否则不能把 OPFS 声明为系统 K-V 所需的 CAS Provider。
        try {
          await this.put(probeName, bytes, { ifMatch: "keymaster-invalid-etag", signal });
          throw error("storage_provider_error", "OPFS provider ignored If-Match");
        } catch (caught) {
          if (!(caught instanceof StorageRuntimeError) || caught.code !== "storage_conflict") throw caught;
        }
        await this.delete(probeName, { signal });
        const quota = await manager?.estimate?.();
        return { ok: true, conditionalWrites: "native", latencyMs: Math.max(0, now() - started), quota: quota ? { usageBytes: quota.usage, quotaBytes: quota.quota } : undefined };
      } catch (caught) {
        if (caught instanceof StorageRuntimeError) throw caught;
        throw error("storage_unavailable", "OPFS probe failed");
      }
    },
    async get(path, input = {}) {
      return read(path, input.signal).then((object) => {
        if (object && input.ifMatch && object.etag !== input.ifMatch) throw error("storage_conflict", "Storage object changed");
        return object;
      });
    },
    async list(input = {}): Promise<StorageBucketListPage> {
      const prefix = input.prefix ?? "";
      if (prefix) assertProviderPath(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
      const all: StorageBucketObject[] = [];
      await listRecursive(await currentRoot(), "", all);
      const filtered = all.filter((object) => object.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path));
      const start = decodeCursor(input.cursor);
      const limit = normalizeProviderLimit(input.limit);
      const objects = filtered.slice(start, start + limit);
      return { objects, nextCursor: start + objects.length < filtered.length ? encodeCursor(start + objects.length) : undefined };
    },
    async put(path, bytes, condition = {}) {
      assertProviderPath(path);
      if (!(bytes instanceof Uint8Array)) throw error("storage_provider_error", "Storage value must be bytes");
      return withWriter(async () => {
        const root = await currentRoot();
        const existing = await read(path);
        if (condition.ifNoneMatch === "*" && existing) throw error("storage_conflict", "Storage object already exists");
        if (condition.ifMatch !== undefined && existing?.etag !== condition.ifMatch) throw error("storage_conflict", "Storage object changed");
        if (condition.ifMatch !== undefined && !existing) throw error("storage_conflict", "Storage object changed");
        const parts = path.split("/");
        const name = parts.pop()!;
        const directory = await getDirectory(root, parts.join("/"), true);
        const tempName = `.${name}.keymaster-tmp-${Math.random().toString(36).slice(2)}`;
        const temp = await directory.getFileHandle(tempName, { create: true });
        const writable = await temp.createWritable({ keepExistingData: false });
        try {
          await writable.write(new Uint8Array(bytes));
          await writable.close();
          // FileSystemHandle.move is the only safe replacement primitive. A
          // copy-then-delete fallback would leave a crash window where readers
          // observe a truncated or missing object, so it is deliberately not
          // supported by the unified storage provider.
          const movable = temp as OpfsFileHandle & { move?: (name: string) => Promise<void> };
          if (typeof movable.move !== "function") throw error("storage_provider_error", "OPFS atomic replacement is unavailable");
          await movable.move(name);
        } catch (caught) {
          await writable.abort?.().catch(() => undefined);
          await directory.removeEntry(tempName).catch(() => undefined);
          if (caught instanceof StorageRuntimeError) throw caught;
          throw error("storage_provider_error", "OPFS write failed");
        }
        return { etag: etagFor(bytes), lastModified: new Date(now()).toISOString() };
      });
    },
    async delete(path, input = {}) {
      assertProviderPath(path);
      return withWriter(async () => {
        const root = await currentRoot();
        const existing = await read(path);
        if (!existing) return;
        if (input.ifMatch !== undefined && existing.etag !== input.ifMatch) throw error("storage_conflict", "Storage object changed");
        const parts = path.split("/");
        const name = parts.pop()!;
        await (await getDirectory(root, parts.join("/"), false)).removeEntry(name);
      });
    },
    dispose() {
      closed = true;
      rootPromise = undefined;
    }
  };
}
