// MSFile 文件 Repository 的内存 ModuleFileStore 测试替身。
//
// 只实现 ModuleFileStore 的路径/字节/世代语义；格式校验、读改写和 publisher
// 枚举都在被测 Repository 内完成。生产代码不引用本文件。

import type { ModuleFileStore } from "@keymaster/contracts";
import type { MsFileRepositoryStores } from "./msfileRepository.js";

/** 测试用 owner 公钥（私钥 1 的压缩公钥）。 */
export const IN_MEMORY_OWNER_PUBKEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

export interface InMemoryOwnerFileStore extends ModuleFileStore {
  /** 直接读取底层字节，供断言与「损坏文件」注入使用。 */
  readonly objects: Map<string, Uint8Array>;
}

export function createInMemoryOwnerFileStore(): InMemoryOwnerFileStore {
  const objects = new Map<string, Uint8Array>();
  const entries = new Map<string, { revision: number; lastModified: string }>();
  let revisionCounter = 0;
  let closed = false;

  const alive = (): void => {
    if (closed) throw new Error("module file store is closed");
  };
  const label = (revision: number): string => `r${revision}`;
  const stamp = (): string => new Date().toISOString();

  /**
   * 读取某条目的元数据；被测试直接写入 `objects`（模拟损坏或外部改动）时
   * 惰性补一份 revision/时间戳，保证只读断言仍然成立。
   */
  const metaFor = (path: string): { revision: number; lastModified: string } => {
    const existing = entries.get(path);
    if (existing) return existing;
    const created = { revision: ++revisionCounter, lastModified: stamp() };
    entries.set(path, created);
    return created;
  };

  const check = (path: string, condition?: { ifRevision?: string; ifNoneMatch?: true }): void => {
    const current = entries.get(path);
    if (condition?.ifNoneMatch === true && current) {
      throw new Error(`condition failed: ${path} already exists`);
    }
    if (condition?.ifRevision !== undefined && current?.revision !== Number(condition.ifRevision.slice(1))) {
      throw new Error(`condition failed: ${path} revision mismatch`);
    }
  };
  const write = (path: string, bytes: Uint8Array): { revision: number; lastModified: string } => {
    objects.set(path, bytes.slice());
    const entry = { revision: ++revisionCounter, lastModified: stamp() };
    entries.set(path, entry);
    return entry;
  };

  return {
    objects,
    walletGeneration: "test-wallet",
    sessionEpoch: "test-epoch",
    runGeneration: "test-run",
    async list(input = {}) {
      alive();
      const prefix = input.prefix ?? "";
      const limit = input.limit ?? 200;
      const offset = input.cursor ? Number(input.cursor) : 0;
      const paths = [...objects.keys()].filter((path) => path.startsWith(prefix)).sort();
      const page = paths.slice(offset, offset + limit);
      return {
        files: page.map((path) => {
          const entry = metaFor(path);
          return {
            path,
            size: objects.get(path)!.byteLength,
            revision: label(entry.revision),
            lastModified: entry.lastModified,
          };
        }),
        ...(offset + page.length < paths.length ? { nextCursor: String(offset + page.length) } : {}),
      };
    },
    async get(path, options) {
      alive();
      const bytes = objects.get(path);
      if (!bytes) return undefined;
      const entry = metaFor(path);
      if (options?.ifRevision !== undefined && options.ifRevision !== label(entry.revision)) {
        throw new Error(`condition failed: ${path} revision mismatch`);
      }
      return { path, bytes: bytes.slice(), revision: label(entry.revision), lastModified: entry.lastModified };
    },
    async getRange(path, range, options) {
      alive();
      const bytes = objects.get(path);
      if (!bytes) return undefined;
      const entry = metaFor(path);
      if (options?.ifRevision !== undefined && options.ifRevision !== label(entry.revision)) {
        throw new Error(`condition failed: ${path} revision mismatch`);
      }
      return {
        path,
        bytes: bytes.slice(range.offset, range.offset + range.length),
        revision: label(entry.revision),
        lastModified: entry.lastModified,
      };
    },
    async put(path, bytes, options) {
      alive();
      check(path, options);
      const entry = write(path, bytes);
      return { revision: label(entry.revision), lastModified: entry.lastModified };
    },
    async delete(path) {
      alive();
      objects.delete(path);
      entries.delete(path);
    },
    async batch(input) {
      alive();
      // 先整体校验再写入：任一条件失败则整体不生效，与真实事务一致。
      for (const condition of input.conditions ?? []) check(condition.path, condition);
      for (const operation of input.operations) {
        if (operation.type === "put") write(operation.path, operation.bytes);
        else {
          objects.delete(operation.path);
          entries.delete(operation.path);
        }
      }
      return { paths: input.operations.map((operation) => operation.path), committedAt: stamp() };
    },
    close(): void {
      closed = true;
      objects.clear();
      entries.clear();
    },
  };
}

export interface InMemoryMsFileRepositoryStores extends MsFileRepositoryStores {
  readonly settings: InMemoryOwnerFileStore;
  readonly appSettings: InMemoryOwnerFileStore;
}

/** 与生产同形的内存文件绑定：msfiles 模块根 + 平台管理的 app 设置文件。 */
export function createInMemoryMsFileRepositoryStores(
  ownerPublicKeyHex: string = IN_MEMORY_OWNER_PUBKEY,
): InMemoryMsFileRepositoryStores {
  const settings = createInMemoryOwnerFileStore();
  return {
    ownerPublicKeyHex,
    settings,
    appSettings: createInMemoryOwnerFileStore(),
  };
}
