import { describe, expect, it, vi } from "vitest";

import type { ForumListPage, ForumNodeView } from "@keymaster/contracts";

import { ForumBusinessError } from "./indexClient.js";
import { ForumListStore } from "./listStore.js";

const FORUM_TXID = "0f".repeat(32);
const PARENT = "11".repeat(32);

function node(txid: string, depth = 1): ForumNodeView {
  return {
    txid,
    parentTxid: depth === 0 ? null : PARENT,
    depth,
    authorPublicKeyHex: "02".padEnd(66, "a"),
    replyMasterSeedHash: "22".repeat(32),
    tipPrice: "1",
    confirmedTipPrice: "1",
    effectiveTipPrice: "1",
    status: "confirmed",
    blockHeight: 800000,
    blockHash: "33".repeat(32),
    txIndex: 0,
    vout: 1,
    hasChildren: false,
  };
}

function page(items: readonly ForumNodeView[], nextCursor: string | null, snapshotHeight = 800000, revision = 3): ForumListPage {
  return {
    forumTxid: FORUM_TXID,
    operation: "list_replies",
    parentTxid: PARENT,
    snapshotHeight,
    mempoolRevision: revision,
    items,
    nextCursor,
  };
}

function businessError(code: string): ForumBusinessError {
  return new ForumBusinessError(code, `business failure ${code}`);
}

describe("分页状态机", () => {
  it("第一页替换整组页，之后按服务端游标顺序追加", async () => {
    const pages: ForumListPage[] = [page([node("aa")], "cursor-1"), page([node("bb")], null)];
    let index = 0;
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async ({ cursor }) => {
        void cursor;
        return pages[index++] as ForumListPage;
      },
    );
    await store.reload("initial");
    expect(store.items().map((item) => item.txid)).toEqual(["aa"]);
    expect(store.view().exhausted).toBe(false);
    await store.loadMore();
    expect(store.items().map((item) => item.txid)).toEqual(["aa", "bb"]);
    expect(store.view().exhausted).toBe(true);
    // 末页不再发请求。
    expect(await store.loadMore()).toBe(false);
    expect(index).toBe(2);
  });

  it("有游标时不再传 snapshot_height", async () => {
    const seen: (string | undefined)[][] = [];
    const snapshots: (number | undefined)[] = [];
    let index = 0;
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async ({ cursor, snapshotHeight }) => {
        seen.push([cursor]);
        snapshots.push(snapshotHeight);
        index += 1;
        return index === 1 ? page([node("aa")], "cursor-1") : page([node("bb")], null);
      },
    );
    await store.reload("initial");
    await store.loadMore();
    expect(seen).toEqual([[undefined], ["cursor-1"]]);
    // 第一页可以带快照高度，后续页只靠游标。
    expect(snapshots).toEqual([undefined, 800000]);
  });

  it("严格保留服务端顺序，不按本地时间或高度重排", async () => {
    const outOfOrder = [node("cc", 3), node("aa", 1), node("bb", 2)];
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async () => page(outOfOrder, null),
    );
    await store.reload("initial");
    expect(store.items().map((item) => item.txid)).toEqual(["cc", "aa", "bb"]);
  });

  it("SNAPSHOT_INVALIDATED 撤销旧请求、重新读第一页并替换整组页", async () => {
    let index = 0;
    const responses: (ForumListPage | Error)[] = [
      page([node("aa")], "cursor-1"),
      page([node("bb")], "cursor-2"),
      businessError("SNAPSHOT_INVALIDATED"),
      page([node("cc")], null),
    ];
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async () => {
        const next = responses[index++] as ForumListPage | Error;
        if (next instanceof Error) throw next;
        return next;
      },
      { invalidationLimit: 5 },
    );
    await store.reload("initial");
    await store.loadMore();
    expect(store.items().map((item) => item.txid)).toEqual(["aa", "bb"]);
    await store.loadMore();
    // 旧页被整体替换，而不是与新视图混拼。
    expect(store.items().map((item) => item.txid)).toEqual(["cc"]);
    expect(store.view().generation).toBeGreaterThan(1);
    expect(store.view().needsManualRefresh).toBe(false);
  });

  it("连续视图失效时停止自动循环并要求用户刷新", async () => {
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async () => {
        throw businessError("SNAPSHOT_INVALIDATED");
      },
      { invalidationLimit: 2 },
    );
    await store.reload("initial");
    expect(store.view().needsManualRefresh).toBe(false);
    await store.loadMore();
    expect(store.view().needsManualRefresh).toBe(true);
    expect(store.view().errorCode).toBe("SNAPSHOT_INVALIDATED");
    // 停止自动循环：不再发请求。
    expect(await store.loadMore()).toBe(false);
    // 刷新入口仍然可用。
    await store.reload("manual");
    expect(store.view().status).toBe("failed");
  });

  it("INVALID_CURSOR 清理该游标并报错，不无限重试", async () => {
    let calls = 0;
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async ({ cursor }) => {
        calls += 1;
        if (cursor === undefined) return page([node("aa")], "cursor-1");
        throw businessError("INVALID_CURSOR");
      },
    );
    await store.reload("initial");
    await store.loadMore();
    expect(store.view().errorCode).toBe("INVALID_CURSOR");
    expect(store.view().cursor).toBeUndefined();
    expect(store.items()).toHaveLength(0);
    // 再点「加载更多」会从第一页重来，而不是重发同一个被拒的游标。
    expect(calls).toBe(2);
  });

  it("同一列表不能混拼不同快照", async () => {
    let index = 0;
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async () => {
        index += 1;
        // 服务端在同一游标下换了快照高度：拒绝混页而不是拼起来。
        return index === 1 ? page([node("aa")], "cursor-1", 800000) : page([node("bb")], null, 800001);
      },
    );
    await store.reload("initial");
    await store.loadMore();
    expect(store.view().errorCode).toBe("SNAPSHOT_INVALIDATED");
    expect(store.items()).toHaveLength(0);
  });

  it("切父节点后旧世代的迟到响应不可交付", async () => {
    const resolvers: ((page: ForumListPage) => void)[] = [];
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async () =>
        await new Promise<ForumListPage>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const first = store.reload("initial");
    // 重新加载会递增世代并中止在途请求。
    const second = store.reload("parent-change");
    // 让两个在途请求都返回；只有第二个世代的结果能被交付。
    resolvers.forEach((resolve) => resolve(page([node("zz")], null)));
    await Promise.all([first, second]);
    expect(store.view().generation).toBe(2);
    expect(store.items().map((item) => item.txid)).toEqual(["zz"]);
  });

  it("被中止的请求不写入错误状态", async () => {
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async ({ signal }) =>
        new Promise<ForumListPage>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const pending = store.reload("initial");
    store.dispose();
    await pending;
    expect(store.view().status).toBe("loading");
    expect(store.view().errorCode).toBeUndefined();
  });

  it("离线缓存标注为旧视图，不能当作当前报价真值", async () => {
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async () => page([node("aa")], null),
    );
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.view().stale));
    await store.reload("initial");
    store.markStale(true);
    expect(store.view().stale).toBe(true);
    store.markStale(true);
    expect(seen.filter((value) => value)).toHaveLength(1);
  });

  it("区分合法空页与失败：空页是 ready，不是错误", async () => {
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async () => page([], null),
    );
    await store.reload("initial");
    expect(store.view().status).toBe("ready");
    expect(store.view().errorCode).toBeUndefined();
    expect(store.view().exhausted).toBe(true);
  });

  it("NODE_NOT_FOUND、INVALID_PARENT 与传输失败分别展示", async () => {
    for (const [code, expected] of [
      ["NODE_NOT_FOUND", "NODE_NOT_FOUND"],
      ["INVALID_PARENT", "INVALID_PARENT"],
    ] as const) {
      const store = new ForumListStore(
        { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
        async () => {
          throw businessError(code);
        },
      );
      await store.reload("initial");
      expect(store.view().status).toBe("failed");
      expect(store.view().errorCode).toBe(expected);
    }
    const transport = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async () => {
        const error = new Error("connection reset");
        error.name = "ForumTransportError";
        throw error;
      },
    );
    await transport.reload("initial");
    expect(transport.view().errorCode).toBe("transport");
  });

  it("服务端顺序内存池 revision 变化被记录而不是被重排", async () => {
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async () => page([node("aa"), node("bb")], null, 800000, 9),
    );
    await store.reload("initial");
    expect(store.view().mempoolRevision).toBe(9);
    expect(store.view().snapshotHeight).toBe(800000);
  });

  it("订阅者在 reload 之前就收到 loading 状态", async () => {
    const statuses: string[] = [];
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      async () => {
        await Promise.resolve();
        return page([node("aa")], null);
      },
    );
    store.subscribe(() => statuses.push(store.view().status));
    await store.reload("initial");
    expect(statuses[0]).toBe("loading");
    expect(statuses.at(-1)).toBe("ready");
  });

  it("加载更多在已有在途请求时不并发发第二次", async () => {
    const loader = vi.fn(async () => page([node("aa")], "cursor-1"));
    const store = new ForumListStore(
      { configId: "cfg", operation: "list_replies", parentTxid: PARENT, forumTxid: FORUM_TXID },
      loader,
    );
    await store.reload("initial");
    await Promise.all([store.loadMore(), store.loadMore()]);
    expect(loader.mock.calls.length).toBe(2);
  });
});