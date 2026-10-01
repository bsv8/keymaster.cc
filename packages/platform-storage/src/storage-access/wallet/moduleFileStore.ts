// 模块 / App 文件句柄的唯一实现。
//
// 这是 model:"files" 的唯一 I/O 落点:所有 I/O 都转发到 WalletStore,句柄本身
// 不持有任何 Provider、连接或物理位置。句柄绑定四件事——钱包身份世代、会话
// epoch、Worker 运行世代与已绑定的逻辑根;其中任意一项失效后,旧句柄立即
// fail closed。

import type {
  StorageErrorCode,
  ModuleFileListPage,
  ModuleFileObject,
  ModuleFileStore,
  PluginStorageDeclaration,
  StorageNamespaceBinding,
  StorageObjectRevision,
  StorageWriteCondition,
} from "@keymaster/contracts";
import {
  assertStorageKeyInNamespace,
  buildStorageNamespaceRoot,
  normalizeRelativeStoragePath,
  validatePluginStorageDeclaration,
} from "@keymaster/contracts";
import type { WalletStore } from "../../local/indexedDbWalletStore.js";
import { StorageRuntimeError } from "../../runtime/storageError.js";

export interface ModuleFileStoreOptions {
  /** 正式本地介质;业务调用方不能替换。 */
  store: WalletStore;
  /** Coordinator 已完成中央声明校验与世代预绑定的不可变绑定。 */
  binding: StorageNamespaceBinding;
  /** Coordinator 提供的世代栅栏;返回 false 表示句柄已失效。 */
  isCurrent?: () => boolean;
}

function fail(code: StorageErrorCode, message: string): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

/** 抽象版本标签只是本地单调 revision 的字符串形式。 */
function revisionOf(value: number): StorageObjectRevision {
  return String(value);
}

function parseRevision(value: StorageObjectRevision | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw fail("storage_provider_error", "Storage revision is invalid");
  return parsed;
}

/** 构造已绑定身份世代与逻辑根的文件句柄。 */
export function createModuleFileStore(options: ModuleFileStoreOptions): ModuleFileStore {
  const declaration: PluginStorageDeclaration = validatePluginStorageDeclaration(options.binding);
  if (declaration.model !== "files") throw fail("storage_forbidden", "Module file store requires the files model");
  const root = buildStorageNamespaceRoot(options.binding);
  let closed = false;

  function assertOpen(): void {
    if (closed || options.isCurrent?.() === false) throw fail("storage_unavailable", "Storage file handle is stale");
  }

  /**
   * 根下相对路径 → 规范相对对象路径。
   *
   * guard 逐段校验,`..`、绝对路径、编码折叠和 `apps/a` 之外的相似前缀都在
   * 这里被拒绝;调用方永远拿不到根外的任何位置。
   */
  function absolutePath(relative: string): string {
    if (typeof relative !== "string" || relative.length === 0) throw fail("storage_invalid_path", "File path is invalid");
    const candidate = `${root}${relative}`;
    try {
      assertStorageKeyInNamespace(root, candidate);
    } catch {
      throw fail("storage_provider_error", "File path is outside the module root");
    }
    return candidate;
  }

  /** 目录前缀补尾斜杠,避免 `tx` 误匹配 `txfoo/`。 */
  function absolutePrefix(prefix: string | undefined): string {
    if (prefix === undefined || prefix === "") return root;
    const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (trimmed.length === 0) throw fail("storage_provider_error", "File prefix is invalid");
    return `${absolutePath(trimmed)}/`;
  }

  function relativePath(path: string): string {
    if (!path.startsWith(root)) throw fail("storage_provider_error", "File path is outside the module root");
    return path.slice(root.length);
  }

  return {
    get walletGeneration() { return options.binding.walletGeneration; },
    get sessionEpoch() { return options.binding.sessionEpoch; },
    get runGeneration() { return options.binding.runGeneration; },
    async list(input = {}): Promise<ModuleFileListPage> {
      assertOpen();
      const prefix = absolutePrefix(input.prefix);
      const page = await options.store.list({
        prefix,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      assertOpen();
      return {
        files: page.objects.map((object) => ({
          path: relativePath(object.path),
          size: object.size,
          revision: revisionOf(object.revision),
          lastModified: object.lastModified,
        })),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
    async get(path, input = {}): Promise<ModuleFileObject | undefined> {
      assertOpen();
      const record = await options.store.get(absolutePath(path), {
        ...(input.ifRevision === undefined ? {} : { ifRevision: parseRevision(input.ifRevision) }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      assertOpen();
      if (!record) return undefined;
      return {
        path: relativePath(record.path),
        bytes: record.bytes,
        revision: revisionOf(record.revision),
        lastModified: record.lastModified,
      };
    },
    async getRange(path, range, input = {}) {
      assertOpen();
      const record = await options.store.getRange(absolutePath(path), range, {
        ...(input.ifRevision === undefined ? {} : { ifRevision: parseRevision(input.ifRevision) }),
      });
      assertOpen();
      if (!record) return undefined;
      return {
        path: relativePath(record.path),
        bytes: record.bytes,
        revision: revisionOf(record.revision),
        lastModified: record.lastModified,
      };
    },
    async put(path, bytes, input: StorageWriteCondition & { contentType?: string; signal?: AbortSignal } = {}) {
      assertOpen();
      const written = await options.store.put(absolutePath(path), bytes, {
        ...(input.ifRevision === undefined ? {} : { ifRevision: parseRevision(input.ifRevision) }),
        ...(input.ifNoneMatch === undefined ? {} : { ifNoneMatch: input.ifNoneMatch }),
        ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      assertOpen();
      return { revision: revisionOf(written.revision), lastModified: written.lastModified };
    },
    async delete(path, input = {}) {
      assertOpen();
      const ifRevision = parseRevision(input.ifRevision);
      try {
        await options.store.delete(absolutePath(path), {
          ...(ifRevision === undefined ? {} : { ifRevision }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        // 文件删除不存在视为成功;CAS 冲突和其它错误继续上抛。
        if (!(error instanceof StorageRuntimeError) || error.code !== "storage_not_found") throw error;
      }
      assertOpen();
    },
    async batch(batchInput, batchOptions = {}) {
      assertOpen();
      const result = await options.store.batch({
        operations: batchInput.operations.map((operation) => operation.type === "delete"
          ? { type: "delete" as const, path: absolutePath(operation.path) }
          : {
            type: "put" as const,
            path: absolutePath(operation.path),
            bytes: operation.bytes,
            ...(operation.contentType === undefined ? {} : { contentType: operation.contentType }),
          }),
        conditions: (batchInput.conditions ?? []).map((condition) => ({
          path: absolutePath(condition.path),
          ...(condition.ifRevision === undefined ? {} : { ifRevision: parseRevision(condition.ifRevision) }),
          ...(condition.ifNoneMatch === undefined ? {} : { ifNoneMatch: condition.ifNoneMatch }),
        })),
      }, { ...(batchOptions.signal === undefined ? {} : { signal: batchOptions.signal }) });
      assertOpen();
      return { paths: result.paths.map(relativePath), committedAt: result.committedAt };
    },
    close() { closed = true; },
  };
}

export { normalizeRelativeStoragePath };
