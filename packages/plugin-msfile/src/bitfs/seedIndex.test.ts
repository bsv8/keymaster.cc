// 卖方 Seed 索引：固定分页、固定校验并发，以及 generation 对迟到结果的撤销。

import { describe, expect, it } from "vitest";
import type { OwnerFileStore } from "@keymaster/contracts";
import { BITFS_SEED_INDEX_PAGE_SIZE, BITFS_SEED_INDEX_VERIFY_CONCURRENCY, BitfsSeedIndex } from "./seedIndex.js";

function hash(index: number): string { return index.toString(16).padStart(64, "0"); }

describe("BitFS Seed 索引", () => {
  it("以 200 项分页、4 项并发扫描 10,000 个候选", async () => {
    const paths = Array.from({ length: 10_000 }, (_, index) => `meta/${hash(index + 1)}.json`);
    let activeGets = 0;
    let maxActiveGets = 0;
    const pageLimits: number[] = [];
    const store: OwnerFileStore = {
      async list(input = {}) {
        const limit = input.limit ?? BITFS_SEED_INDEX_PAGE_SIZE;
        pageLimits.push(limit);
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);
        const files = paths.slice(offset, offset + limit).map((path) => ({ path, size: 1 }));
        const next = offset + files.length;
        return { files, ...(next < paths.length ? { nextCursor: String(next) } : {}) };
      },
      async get() {
        activeGets += 1;
        maxActiveGets = Math.max(maxActiveGets, activeGets);
        await Promise.resolve();
        activeGets -= 1;
        return undefined;
      },
      async put() { return {}; },
      async delete() {},
    };
    const index = new BitfsSeedIndex();
    await index.build(store);
    expect(index.size()).toBe(10_000);
    expect(pageLimits).toHaveLength(50);
    expect(new Set(pageLimits)).toEqual(new Set([BITFS_SEED_INDEX_PAGE_SIZE]));
    expect(maxActiveGets).toBeLessThanOrEqual(BITFS_SEED_INDEX_VERIFY_CONCURRENCY);
  }, 20_000);

  it("clear 推进 generation，迟到校验不得写回新 owner 索引", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const candidate = hash(1);
    const store: OwnerFileStore = {
      async list() { return { files: [{ path: `meta/${candidate}.json`, size: 1 }] }; },
      async get() { await gate; return undefined; },
      async put() { return {}; },
      async delete() {},
    };
    const index = new BitfsSeedIndex();
    const build = index.build(store);
    await Promise.resolve();
    index.clear();
    release();
    await build;
    expect(index.size()).toBe(0);
    expect(index.currentGeneration()).toBe(2);
  });
});
