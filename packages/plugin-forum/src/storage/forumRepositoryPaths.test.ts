// Forum 仓储的存储路径校验。
//
// 这里盯的是一个看不出症状的失效：txid 与 seed hash 是 64 字符，而业务 ID 的路径
// 规则只接受 63 字符。缓存与投影的写入异常在调用方被吞掉，于是「离线缓存失效」
// 没有任何报错——只有真正用 64 长度 hash 读写一次才会暴露。

import { describe, expect, it } from "vitest";

import type { ForumListOperation } from "@keymaster/contracts";

import { createForumRepository, ForumRecordError, type ForumIndexCacheEntry } from "./forumRepository.js";

const CONFIG_ID = "my-forum";
const TXID = "ab".repeat(32);
const SEED_HASH = "cd".repeat(32);
const FORUM_TXID = "ef".repeat(32);

/** 内存 owner 文件句柄；保留全部路径以便断言「写到了哪个文件」。 */
function store() {
  const files = new Map<string, Uint8Array>();
  return {
    paths: () => [...files.keys()],
    async get(path: string) {
      const bytes = files.get(path);
      return bytes === undefined ? undefined : { path, bytes, revision: "1", lastModified: "now" };
    },
    async put(path: string, bytes: Uint8Array) {
      files.set(path, bytes);
      return { revision: "1", lastModified: "now" };
    },
    async delete(path: string) {
      files.delete(path);
    },
    async list() {
      return { files: [...files.keys()].map((path) => ({ path, sizeBytes: files.get(path)?.byteLength ?? 0 })), nextCursor: null };
    },
    close() {},
  };
}

function repository() {
  const files = store();
  return { files, repo: createForumRepository(files as never) };
}

function cacheEntry(parentTxid: string): ForumIndexCacheEntry {
  return {
    configId: CONFIG_ID,
    operation: "list_posts" as ForumListOperation,
    parentTxid,
    snapshotHeight: 100,
    mempoolRevision: 1,
    items: [],
    nextCursor: null,
    cachedAtMs: 1_700_000_000_000,
    stale: false,
  };
}

describe("索引缓存路径", () => {
  it("用 64 位父 txid 能写入并读回", async () => {
    const { repo } = repository();
    await repo.writeIndexCache(cacheEntry(TXID));
    const read = await repo.readIndexCache({
      configId: CONFIG_ID,
      operation: "list_posts",
      parentTxid: TXID,
    });
    expect(read?.parentTxid).toBe(TXID);
  });

  it("根 txid（同样是 64 位）也能写入板块缓存", async () => {
    const { repo, files } = repository();
    await repo.writeIndexCache({
      ...cacheEntry(FORUM_TXID),
      operation: "list_boards",
    });
    expect(files.paths().some((path) => path.includes(FORUM_TXID))).toBe(true);
    const read = await repo.readIndexCache({
      configId: CONFIG_ID,
      operation: "list_boards",
      parentTxid: FORUM_TXID,
    });
    expect(read?.parentTxid).toBe(FORUM_TXID);
  });

  it("不同父节点的缓存互不覆盖", async () => {
    const { repo } = repository();
    const other = "12".repeat(32);
    await repo.writeIndexCache(cacheEntry(TXID));
    await repo.writeIndexCache({ ...cacheEntry(TXID), parentTxid: other });
    expect((await repo.readIndexCache({ configId: CONFIG_ID, operation: "list_posts", parentTxid: TXID }))?.parentTxid).toBe(TXID);
    expect((await repo.readIndexCache({ configId: CONFIG_ID, operation: "list_posts", parentTxid: other }))?.parentTxid).toBe(other);
  });

  it("非 64 字符的父字段被明确拒绝", async () => {
    const { repo } = repository();
    // 同步抛出（路径在构造时就校验），因此不用 rejects。
    expect(() => cacheEntry("short") && repo.writeIndexCache(cacheEntry("short"))).toThrow(/parent_txid/u);
    expect(() => repo.writeIndexCache(cacheEntry(TXID.toUpperCase()))).toThrow(/parent_txid/u);
  });
});

describe("展示投影路径", () => {
  it("用 64 位 seed hash 能写入并读回", async () => {
    const { repo } = repository();
    await repo.writeProjection({
      seedHashHex: SEED_HASH,
      title: "标题",
      summary: "摘要",
      parserVersion: 1,
      bytes: "8",
      projectedAtMs: 1_700_000_000_000,
    });
    const read = await repo.readProjections([SEED_HASH]);
    expect(read.get(SEED_HASH)?.title).toBe("标题");
  });

  it("不同 seed hash 的投影互不覆盖", async () => {
    const { repo } = repository();
    const other = "34".repeat(32);
    await repo.writeProjection({ seedHashHex: SEED_HASH, title: "A", summary: "", parserVersion: 1, bytes: "1", projectedAtMs: 1 });
    await repo.writeProjection({ seedHashHex: other, title: "B", summary: "", parserVersion: 1, bytes: "1", projectedAtMs: 1 });
    const read = await repo.readProjections([SEED_HASH, other]);
    expect(read.get(SEED_HASH)?.title).toBe("A");
    expect(read.get(other)?.title).toBe("B");
  });

  it("非法 seed hash 被拒绝而不是被当成不存在的投影", () => {
    const { repo } = repository();
    expect(() =>
      repo.writeProjection({ seedHashHex: "nope", title: "", summary: "", parserVersion: 1, bytes: "0", projectedAtMs: 1 }),
    ).toThrow(/seed hash/u);
  });
});

describe("发布任务与专用资金路径", () => {
  it("taskId 仍按业务 ID 规则校验（与 hash 分开）", async () => {
    const { repo } = repository();
    // taskId 是业务 ID（短、稳定），沿用 63 字符上限；它不是 hash。
    await expect(repo.readTask("a".repeat(64))).rejects.toBeInstanceOf(ForumRecordError);
    await expect(repo.readDedicatedFunding("a".repeat(64))).rejects.toBeInstanceOf(ForumRecordError);
  });

  it("常规长度的 taskId 正常读写", async () => {
    const { repo } = repository();
    await expect(repo.readTask("task-1")).resolves.toBeUndefined();
  });
});