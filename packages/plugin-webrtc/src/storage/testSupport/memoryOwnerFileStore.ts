// 测试用内存 owner 文件根：只实现 owner 文件仓储用到的 list/get/put/delete。
//
// 放在 src 下与测试同构：生产构建只打包非测试入口,本文件仅供 vitest 导入。

import type { BorrowedOwnerFileStore } from "@keymaster/contracts";

export type MemoryOwnerFileStore = BorrowedOwnerFileStore & {
  /** 直接观察/注入文件内容（损坏文件、外部写入）。 */
  __files: Map<string, Uint8Array>;
  __encode(text: string): Uint8Array;
};

export function createMemoryOwnerFileStore(seed?: Iterable<readonly [string, string]>): MemoryOwnerFileStore {
  const files = new Map<string, Uint8Array>();
  const encode = (text: string) => new TextEncoder().encode(text);
  if (seed) for (const [path, text] of seed) files.set(path, encode(text));
  return {
    __files: files,
    __encode: encode,
    list: async (input = {}) => {
      const prefix = input.prefix ?? "";
      const paths = [...files.keys()].filter((path) => path.startsWith(prefix)).sort();
      const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
      const limit = input.limit ?? 1000;
      const selected = paths.slice(offset, offset + limit);
      return {
        files: selected.map((path) => ({ path, size: files.get(path)!.byteLength })),
        ...(offset + selected.length < paths.length ? { nextCursor: String(offset + selected.length) } : {}),
      };
    },
    get: async (path) => files.has(path) ? { path, bytes: new Uint8Array(files.get(path)!) } : undefined,
    put: async (path, bytes) => { files.set(path, new Uint8Array(bytes)); return {}; },
    delete: async (path) => { files.delete(path); },
  };
}
