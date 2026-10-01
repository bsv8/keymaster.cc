// 测试用内存模块文件根：实现 ModuleFileStore 的路径/字节语义与世代字段。
//
// 放在 src 下与测试同构：生产构建只打包非测试入口,本文件仅供 vitest 导入。

import type { ModuleFileStore } from "@keymaster/contracts";

export type MemoryOwnerFileStore = ModuleFileStore & {
  /** 直接观察/注入文件内容（损坏文件、外部写入）。 */
  __files: Map<string, Uint8Array>;
  __encode(text: string): Uint8Array;
};

export function createMemoryOwnerFileStore(seed?: Iterable<readonly [string, string]>): MemoryOwnerFileStore {
  const files = new Map<string, Uint8Array>();
  const entries = new Map<string, { revision: number; lastModified: string }>();
  let revisionCounter = 0;
  const encode = (text: string) => new TextEncoder().encode(text);
  if (seed) {
    for (const [path, text] of seed) {
      files.set(path, encode(text));
      entries.set(path, { revision: ++revisionCounter, lastModified: new Date().toISOString() });
    }
  }
  const label = (revision: number) => `r${revision}`;
  /**
   * 读取某路径的元数据；`__files.set` 绕过 write 直接注入字节时按需补一条记录，
   * 让「外部写入」这个测试接缝读起来和正常 put 写入的对象完全一样。
   */
  const entryFor = (path: string): { revision: number; lastModified: string } => {
    const existing = entries.get(path);
    if (existing) return existing;
    const entry = { revision: ++revisionCounter, lastModified: new Date().toISOString() };
    entries.set(path, entry);
    return entry;
  };
  const check = (path: string, condition?: { ifRevision?: string; ifNoneMatch?: true }): void => {
    const current = entries.get(path);
    if (condition?.ifNoneMatch === true && current) throw new Error(`condition failed: ${path} already exists`);
    if (condition?.ifRevision !== undefined && current?.revision !== Number(condition.ifRevision.slice(1))) {
      throw new Error(`condition failed: ${path} revision mismatch`);
    }
  };
  const write = (path: string, bytes: Uint8Array) => {
    files.set(path, new Uint8Array(bytes));
    const entry = { revision: ++revisionCounter, lastModified: new Date().toISOString() };
    entries.set(path, entry);
    return entry;
  };
  return {
    __files: files,
    __encode: encode,
    walletGeneration: "test-wallet",
    sessionEpoch: "test-epoch",
    runGeneration: "test-run",
    list: async (input = {}) => {
      const prefix = input.prefix ?? "";
      const paths = [...files.keys()].filter((path) => path.startsWith(prefix)).sort();
      const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
      const limit = input.limit ?? 1000;
      const selected = paths.slice(offset, offset + limit);
      return {
        files: selected.map((path) => {
          const entry = entryFor(path);
          return { path, size: files.get(path)!.byteLength, revision: label(entry.revision), lastModified: entry.lastModified };
        }),
        ...(offset + selected.length < paths.length ? { nextCursor: String(offset + selected.length) } : {}),
      };
    },
    get: async (path, options) => {
      if (!files.has(path)) return undefined;
      const entry = entryFor(path);
      if (options?.ifRevision !== undefined && options.ifRevision !== label(entry.revision)) {
        throw new Error(`condition failed: ${path} revision mismatch`);
      }
      return { path, bytes: new Uint8Array(files.get(path)!), revision: label(entry.revision), lastModified: entry.lastModified };
    },
    getRange: async (path, range) => {
      if (!files.has(path)) return undefined;
      const entry = entryFor(path);
      return {
        path,
        bytes: files.get(path)!.slice(range.offset, range.offset + range.length),
        revision: label(entry.revision),
        lastModified: entry.lastModified,
      };
    },
    put: async (path, bytes, options) => {
      check(path, options);
      const entry = write(path, bytes);
      return { revision: label(entry.revision), lastModified: entry.lastModified };
    },
    delete: async (path) => {
      files.delete(path);
      entries.delete(path);
    },
    batch: async (input) => {
      for (const condition of input.conditions ?? []) check(condition.path, condition);
      for (const operation of input.operations) {
        if (operation.type === "put") write(operation.path, operation.bytes);
        else {
          files.delete(operation.path);
          entries.delete(operation.path);
        }
      }
      return { paths: input.operations.map((operation) => operation.path), committedAt: new Date().toISOString() };
    },
    close: () => {
      files.clear();
      entries.clear();
    },
  };
}
