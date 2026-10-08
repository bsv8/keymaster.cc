import { describe, expect, it } from "vitest";

import { FORUM_PAGE_SIZE_DEFAULT, FORUM_PAGE_SIZE_MAX } from "@keymaster/contracts";

import { buildListArgs, createForumIndexClient, ForumBusinessError, ForumResultShapeError, parseNode, parsePage } from "./indexClient.js";
import type { ForumRoundtripClient } from "../network/roundtripClient.js";

const FORUM_TXID = "0f".repeat(32);
const PARENT = "11".repeat(32);
const AUTHOR = "02".padEnd(66, "a");
const SEED = "22".repeat(32);
const BLOCK = "33".repeat(32);

function validItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    txid: "ab".repeat(32),
    parent_txid: PARENT,
    depth: 1,
    author_publickey: AUTHOR,
    reply_masterseedhash: SEED,
    tip_price: "5",
    confirmed_tip_price: "5",
    effective_tip_price: "5",
    status: "confirmed",
    block_height: 800000,
    block_hash: BLOCK,
    tx_index: 3,
    vout: 1,
    has_children: false,
    ...overrides,
  };
}

function validPage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parent_txid: PARENT,
    snapshot_height: 800000,
    mempool_revision: 2,
    items: [validItem()],
    next_cursor: "cursor-1",
    ...overrides,
  };
}

function clientWith(results: readonly (Record<string, unknown> | Error)[]): ForumRoundtripClient & { calls: { op: string; args: Record<string, unknown> }[] } {
  let index = 0;
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  return {
    callerPublicKeyHex: AUTHOR,
    calls,
    async call(body) {
      calls.push({ op: body.op, args: (body.args ?? {}) as Record<string, unknown> });
      const next = results[index++] as Record<string, unknown> | Error | undefined;
      if (next === undefined) throw new Error("fixture exhausted");
      if (next instanceof Error) throw next;
      return { ok: true, result: next, requestId: "req-1" };
    },
    dispose() {},
  };
}

const requestBase = { configId: "cfg", operation: "list_replies" as const, forumTxid: FORUM_TXID, parentTxid: PARENT, limit: 20 };

describe("列表请求参数", () => {
  it("每个操作使用自己的父字段名", () => {
    const base = requestBase;
    expect(buildListArgs(base, "list_boards")).toMatchObject({ forum_txid: PARENT });
    expect(buildListArgs(base, "list_posts")).toMatchObject({ board_txid: PARENT });
    expect(buildListArgs(base, "list_replies")).toMatchObject({ parent_txid: PARENT });
  });

  it("有游标时不再传 snapshot_height", () => {
    const args = buildListArgs(
      { ...requestBase, cursor: "abc", snapshotHeight: 800000 },
      "list_replies",
    );
    expect(args.cursor).toBe("abc");
    expect(args).not.toHaveProperty("snapshot_height");
  });

  it("没有游标时按需传快照高度；越界页大小回落到默认值", () => {
    expect(
      buildListArgs({ ...requestBase, limit: 50, snapshotHeight: 800000 }, "list_posts"),
    ).toMatchObject({ snapshot_height: 800000 });
    for (const limit of [0, -1, FORUM_PAGE_SIZE_MAX + 1, Number.NaN, 3.5]) {
      const args = buildListArgs({ ...requestBase, limit }, "list_posts");
      expect(args.limit).toBe(FORUM_PAGE_SIZE_DEFAULT);
    }
    expect(buildListArgs({ ...requestBase, limit: FORUM_PAGE_SIZE_MAX }, "list_posts").limit).toBe(FORUM_PAGE_SIZE_MAX);
    // 负的快照高度不发送。
    expect(
      buildListArgs({ ...requestBase, snapshotHeight: -1 }, "list_posts"),
    ).not.toHaveProperty("snapshot_height");
  });
});

describe("严格响应解析", () => {
  const request = { configId: "cfg", operation: "list_replies" as const, forumTxid: FORUM_TXID, parentTxid: PARENT, limit: 20 };

  it("接受合法页并保留服务端顺序", () => {
    const page = parsePage("list_replies", request, validPage({ items: [validItem({ txid: "cc".repeat(32) }), validItem({ txid: "aa".repeat(32) })] }));
    expect(page.items.map((item) => item.txid)).toEqual(["cc".repeat(32), "aa".repeat(32)]);
    expect(page.nextCursor).toBe("cursor-1");
    expect(page.snapshotHeight).toBe(800000);
    expect(page.mempoolRevision).toBe(2);
  });

  it("next_cursor 为 null 表示读完；不是缺失", () => {
    expect(parsePage("list_replies", request, validPage({ next_cursor: null })).nextCursor).toBeNull();
    expect(() => parsePage("list_replies", request, validPage({ next_cursor: undefined }))).toThrow(/next_cursor/);
  });

  it("响应父节点与请求不一致时拒绝：这条页属于另一条列表", () => {
    expect(() => parsePage("list_replies", request, validPage({ parent_txid: "99".repeat(32) }))).toThrow(/不一致/);
  });

  it("金额必须是规范十进制字符串；收到 JSON number 也拒绝", () => {
    for (const bad of [5, "005", "+5", "-5", "", "1e3", "18446744073709551616"]) {
      expect(() => parseNode(validItem({ tip_price: bad }))).toThrow(ForumResultShapeError);
    }
    // 三种价格都同样严格。
    expect(() => parseNode(validItem({ confirmed_tip_price: 5 }))).toThrow(/必须是字符串|规范十进制/);
    expect(() => parseNode(validItem({ effective_tip_price: 5 }))).toThrow(/必须是字符串|规范十进制/);
    // uint64 上限是合法的。
    expect(parseNode(validItem({ tip_price: "18446744073709551615" })).tipPrice).toBe("18446744073709551615");
  });

  it("txid、公钥与 hash 字段的形态被严格校验", () => {
    expect(() => parseNode(validItem({ txid: "AB".repeat(32) }))).toThrow(/小写 hex/);
    expect(() => parseNode(validItem({ txid: "ab".repeat(31) }))).toThrow(/64 字符/);
    expect(() => parseNode(validItem({ author_publickey: "04".padEnd(66, "a") }))).toThrow(/压缩公钥/);
    expect(() => parseNode(validItem({ block_hash: "zz".repeat(32) }))).toThrow(/小写 hex/);
    expect(() => parseNode(validItem({ status: "pending" }))).toThrow(/confirmed 或 mempool/);
    expect(() => parseNode(validItem({ has_children: "yes" }))).toThrow(/布尔值/);
    expect(() => parseNode(validItem({ vout: 1.5 }))).toThrow(/安全整数/);
    // 高度、序号与 vout 必须非负：负数说明对端不是这一版协议。
    expect(() => parseNode(validItem({ depth: -1 }))).toThrow(/不能为负数/);
    expect(() => parseNode(validItem({ vout: -1 }))).toThrow(/不能为负数/);
    expect(() => parseNode(validItem({ block_height: -5 }))).toThrow(/不能为负数/);
    expect(() => parseNode(validItem({ tx_index: -1 }))).toThrow(/不能为负数/);
    expect(() => parsePage("list_replies", request, validPage({ snapshot_height: -1 }))).toThrow(/不能为负数/);
    expect(() => parsePage("list_replies", request, validPage({ mempool_revision: -1 }))).toThrow(/不能为负数/);
  });

  it("内存池节点的链上位置是显式 null，不是 0", () => {
    const node = parseNode(validItem({ status: "mempool", block_height: null, block_hash: null, tx_index: null }));
    expect(node.blockHeight).toBeNull();
    expect(node.blockHash).toBeNull();
    expect(node.txIndex).toBeNull();
    expect(node.status).toBe("mempool");
  });

  it("根节点没有父与正文 hash 时是 null，回复节点带 forum_name 时才出现", () => {
    const root = parseNode(validItem({ depth: 0, parent_txid: null, reply_masterseedhash: null, forum_name: "论坛名" }));
    expect(root.parentTxid).toBeNull();
    expect(root.replyMasterSeedHash).toBeNull();
    expect(root.forumName).toBe("论坛名");
    expect(parseNode(validItem()).forumName).toBeUndefined();
  });

  it("items 不是数组或元素不是对象时拒绝", () => {
    expect(() => parsePage("list_replies", request, validPage({ items: "nope" }))).toThrow(/数组/);
    expect(() => parsePage("list_replies", request, validPage({ items: [1] }))).toThrow(/JSON 对象/);
  });
});

describe("领域客户端", () => {
  const request = { configId: "cfg", operation: "list_replies" as const, forumTxid: FORUM_TXID, parentTxid: PARENT, limit: 20 };

  it("四种查询走同一入口并发出正确的 op", async () => {
    const client = clientWith([validPage(), validPage(), validPage(), validItem({ forum_name: "f" })]);
    const index = createForumIndexClient({ client });
    await index.listBoards(request);
    await index.listPosts(request);
    await index.listReplies(request);
    await index.getNode("cfg", "ab".repeat(32));
    expect(client.calls.map((call) => call.op)).toEqual(["list_boards", "list_posts", "list_replies", "get_node"]);
    expect(client.calls[0]?.args).toMatchObject({ forum_txid: PARENT });
    expect(client.calls[1]?.args).toMatchObject({ board_txid: PARENT });
    expect(client.calls[2]?.args).toMatchObject({ parent_txid: PARENT });
    expect(client.calls[3]?.args).toEqual({ txid: "ab".repeat(32) });
  });

  it("get_node 返回索引状态与根证据", async () => {
    const evidence = {
      configId: "cfg",
      forumTxid: FORUM_TXID,
      rawTxHex: "00",
      forumName: "f",
      tipPrice: "1",
      forumPublicKeyHex: AUTHOR,
      payToPublicKeyHex: AUTHOR,
      verifiedAtMs: 0,
      baseline: "test",
    };
    const client = clientWith([validItem({ status: "mempool" }), validItem({ status: "confirmed" })]);
    const index = createForumIndexClient({ client, root: () => evidence });
    const mempool = await index.getNode("cfg", "ab".repeat(32));
    expect(mempool.indexState).toBe("mempool");
    expect(mempool.forum?.forumName).toBe("f");
    const confirmed = await index.getNode("cfg", "ab".repeat(32));
    expect(confirmed.indexState).toBe("confirmed");
    // 钱包侧观测到确认不等于 Forum 已确认索引；这里只表达服务端返回的状态。
    expect(confirmed.indexState).not.toBe("unknown");
  });

  it("业务错误码映射成稳定的 ForumBusinessError", async () => {
    const client = clientWith([new ForumBusinessError("NODE_NOT_FOUND", "没有这个节点")]);
    const index = createForumIndexClient({ client });
    await expect(index.getNode("cfg", "ab".repeat(32))).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
  });
});