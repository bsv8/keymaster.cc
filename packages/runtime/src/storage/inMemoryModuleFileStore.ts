// 仅供测试夹具使用的模块文件句柄实现。
//
// 与 inMemoryKeyValueStore 同样的边界：生产代码必须注入绑定本地钱包的
// ModuleFileStore，这里不接触任何浏览器持久化 API，避免测试为了构造插件
// 而重新引入底层存储后端。
import type {
  ModuleFileListPage,
  ModuleFileObject,
  ModuleFileStore,
  ModuleFileWriteResult,
  StorageObjectRevision,
  StorageWriteCondition,
} from "@keymaster/contracts";

export interface InMemoryModuleFileStoreOptions {
  walletGeneration?: string;
  sessionEpoch?: string;
  runGeneration?: string;
  now?: () => number;
}

interface Entry {
  bytes: Uint8Array;
  revision: number;
  lastModified: string;
}

function label(revision: number): StorageObjectRevision {
  return `r${revision}`;
}

export interface InMemoryModuleFileStore extends ModuleFileStore {
  /** 直接读取底层快照，供断言使用。 */
  snapshot(): ReadonlyMap<string, Uint8Array>;
}

export function createInMemoryModuleFileStore(
  options: InMemoryModuleFileStoreOptions = {},
): InMemoryModuleFileStore {
  const entries = new Map<string, Entry>();
  const now = options.now ?? (() => Date.now());
  let closed = false;
  let revisionCounter = 0;

  const alive = (): void => {
    if (closed) throw new Error("module file store is closed");
  };
  const stamp = (): string => new Date(now()).toISOString();

  const check = (path: string, condition: StorageWriteCondition | undefined): void => {
    const current = entries.get(path);
    if (condition?.ifNoneMatch && current) throw new Error(`condition failed: ${path} already exists`);
    if (condition?.ifRevision !== undefined && current?.revision !== Number(condition.ifRevision.slice(1))) {
      throw new Error(`condition failed: ${path} revision mismatch`);
    }
  };

  const write = (path: string, bytes: Uint8Array): Entry => {
    const entry: Entry = { bytes: new Uint8Array(bytes), revision: ++revisionCounter, lastModified: stamp() };
    entries.set(path, entry);
    return entry;
  };

  return {
    walletGeneration: options.walletGeneration ?? "test-wallet",
    sessionEpoch: options.sessionEpoch ?? "test-epoch",
    runGeneration: options.runGeneration ?? "test-run",
    async list(input = {}): Promise<ModuleFileListPage> {
      alive();
      const prefix = input.prefix ?? "";
      const limit = input.limit ?? 200;
      const offset = input.cursor ? Number(input.cursor) : 0;
      const paths = [...entries.keys()].filter((path) => path.startsWith(prefix)).sort();
      const page = paths.slice(offset, offset + limit);
      return {
        files: page.map((path) => {
          const entry = entries.get(path)!;
          return { path, size: entry.bytes.byteLength, revision: label(entry.revision), lastModified: entry.lastModified };
        }),
        ...(offset + page.length < paths.length ? { nextCursor: String(offset + page.length) } : {})
      };
    },
    async get(path: string, options2?: { ifRevision?: string; signal?: AbortSignal }): Promise<ModuleFileObject | undefined> {
      alive();
      const entry = entries.get(path);
      if (!entry) return undefined;
      if (options2?.ifRevision !== undefined && options2.ifRevision !== label(entry.revision)) {
        throw new Error(`condition failed: ${path} revision mismatch`);
      }
      return { path, bytes: new Uint8Array(entry.bytes), revision: label(entry.revision), lastModified: entry.lastModified };
    },
    async getRange(path: string, range: { offset: number; length: number }): Promise<ModuleFileObject | undefined> {
      alive();
      const entry = entries.get(path);
      if (!entry) return undefined;
      return { path, bytes: entry.bytes.slice(range.offset, range.offset + range.length), revision: label(entry.revision), lastModified: entry.lastModified };
    },
    async put(path: string, bytes: Uint8Array, options2?: StorageWriteCondition): Promise<ModuleFileWriteResult> {
      alive();
      check(path, options2);
      const entry = write(path, bytes);
      return { revision: label(entry.revision), lastModified: entry.lastModified };
    },
    async delete(path: string): Promise<void> {
      alive();
      entries.delete(path);
    },
    async batch(input): Promise<{ paths: string[]; committedAt: string }> {
      alive();
      // 先整体校验再写入，保证测试语义与真实事务一致：任一条件失败则整体失败。
      for (const condition of input.conditions ?? []) check(condition.path, condition);
      const paths: string[] = [];
      for (const operation of input.operations) {
        if (operation.type === "put") write(operation.path, operation.bytes);
        else entries.delete(operation.path);
        paths.push(operation.path);
      }
      return { paths, committedAt: stamp() };
    },
    close(): void {
      closed = true;
      entries.clear();
    },
    snapshot(): ReadonlyMap<string, Uint8Array> {
      return new Map([...entries].map(([path, entry]) => [path, new Uint8Array(entry.bytes)]));
    }
  };
}
