// Coordinator 唯一卖方运行单元使用的 Seed 内存索引。
// 索引是可丢弃派生缓存；锁定、切 Key、切存储或 generation 变化时清空。

import type { OwnerFileStore } from "@keymaster/contracts";
import { inspectLocalMsFileSeed } from "../storage/msfileSeedStore.js";

const META_PATTERN = /^meta\/([0-9a-f]{64})\.json$/u;
/** 10,000 Seed 验收场景采用的分页大小，避免一次加载全部元数据字节。 */
export const BITFS_SEED_INDEX_PAGE_SIZE = 200;
/** 索引完整性检查并发；每项只保留摘要，不保留 Seed/Block 字节。 */
export const BITFS_SEED_INDEX_VERIFY_CONCURRENCY = 4;

export interface BitfsSeedIndexEntry {
  /** Seed Hash，也是索引键。 */
  seedHashHex: string;
  /** 推荐文件名。 */
  fileName: string;
  /** 规范媒体类型。 */
  mediaType: string;
  /** 原始文件字节数（uint64 十进制字符串）。 */
  fileSizeBytes: string;
  /** Seed 引用的块数量。 */
  blockCount: number;
  /** 当前派生可用性。 */
  availability: "indexing" | "available" | "invalid" | "missing";
}

export class BitfsSeedIndex {
  private readonly entries = new Map<string, BitfsSeedIndexEntry>();
  private generation = 0;

  /** 当前索引 generation；每次 clear/build 都推进。 */
  currentGeneration(): number { return this.generation; }
  /** 返回单项副本，调用方不能修改索引。 */
  get(seedHashHex: string): BitfsSeedIndexEntry | undefined { const value = this.entries.get(seedHashHex); return value ? { ...value } : undefined; }
  /** 当前条目数量，仅用于状态与测试。 */
  size(): number { return this.entries.size; }
  /** 撤销全部可用性并推进 generation。 */
  clear(): void { this.generation += 1; this.entries.clear(); }
  /** 定向失效；上传/买入完成后可随后调用 refresh。 */
  invalidate(seedHashHex: string): void { this.entries.delete(seedHashHex); }

  /** 分页重建索引；迟到页或校验结果不能写入新 generation。 */
  async build(store: OwnerFileStore, signal?: AbortSignal): Promise<number> {
    const generation = ++this.generation;
    this.entries.clear();
    let cursor: string | undefined;
    do {
      if (signal?.aborted) throw new DOMException("Seed 索引已取消", "AbortError");
      const page = await store.list({ prefix: "meta/", limit: BITFS_SEED_INDEX_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }), ...(signal === undefined ? {} : { signal }) });
      if (generation !== this.generation) return generation;
      const hashes = page.files.map((file) => META_PATTERN.exec(file.path)?.[1]).filter((value): value is string => value !== undefined);
      let next = 0;
      const workers = Array.from({ length: Math.min(BITFS_SEED_INDEX_VERIFY_CONCURRENCY, hashes.length) }, async () => {
        for (;;) {
          const index = next++;
          if (index >= hashes.length) return;
          const seedHashHex = hashes[index]!;
          const descriptor = await inspectLocalMsFileSeed({ store, seedHashHex, ...(signal === undefined ? {} : { signal }) });
          if (generation !== this.generation || signal?.aborted) return;
          if (!descriptor) {
            this.entries.set(seedHashHex, { seedHashHex, fileName: seedHashHex, mediaType: "application/octet-stream", fileSizeBytes: "0", blockCount: 0, availability: "invalid" });
            continue;
          }
          this.entries.set(seedHashHex, {
            seedHashHex,
            fileName: descriptor.meta.fileName,
            mediaType: descriptor.meta.mediaType,
            fileSizeBytes: descriptor.meta.fileSizeBytes,
            blockCount: descriptor.meta.blockCount,
            availability: "available",
          });
        }
      });
      await Promise.all(workers);
      cursor = page.nextCursor;
    } while (cursor !== undefined && generation === this.generation);
    return generation;
  }

  /** 定向重新校验一个 Seed。 */
  async refresh(store: OwnerFileStore, seedHashHex: string, expectedGeneration = this.generation, signal?: AbortSignal): Promise<void> {
    const descriptor = await inspectLocalMsFileSeed({ store, seedHashHex, ...(signal === undefined ? {} : { signal }) });
    if (expectedGeneration !== this.generation || signal?.aborted) return;
    if (!descriptor) { this.entries.delete(seedHashHex); return; }
    this.entries.set(seedHashHex, { seedHashHex, fileName: descriptor.meta.fileName, mediaType: descriptor.meta.mediaType, fileSizeBytes: descriptor.meta.fileSizeBytes, blockCount: descriptor.meta.blockCount, availability: "available" });
  }
}
