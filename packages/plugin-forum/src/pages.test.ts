// Forum 页面的导航契约。
//
// 路由 `/forum/:configId/...` 的第一个参数是**本地配置 ID**：页面注册在
// `manifest.ts` 里，渲染时按它调 `getConfig`。如果某个链接把交易 txid 填进这个
// 位置，点进去就变成「按父交易 hash 查配置」，结果通常是配置不存在或一直停在
// 加载占位。因此这里把「链接的形状」变成可执行断言。

import { describe, expect, it } from "vitest";

import { forumPostPath, forumPostsPath, forumPublishPath } from "./pages.js";

const CONFIG_ID = "my-forum";
const CONFIG_ID_WITH_SPACE = "my forum";
const TXID = "ab".repeat(32);
const BOARD_TXID = "cd".repeat(32);

describe("论坛路由路径", () => {
  it("第一段是本地配置 ID，不是交易 txid", () => {
    expect(forumPostPath(CONFIG_ID, TXID)).toBe(`/forum/${CONFIG_ID}/post/${TXID}`);
    expect(forumPostsPath(CONFIG_ID, BOARD_TXID)).toBe(`/forum/${CONFIG_ID}/board/${BOARD_TXID}`);
    expect(forumPublishPath(CONFIG_ID, TXID)).toBe(`/forum/${CONFIG_ID}/publish/${TXID}`);
    // 交易 txid 只能出现在后面的路径段里。
    for (const path of [forumPostPath(CONFIG_ID, TXID), forumPostsPath(CONFIG_ID, BOARD_TXID), forumPublishPath(CONFIG_ID, TXID)]) {
      expect(path.split("/")[2]).toBe(CONFIG_ID);
    }
  });

  it("配置 ID 经过转义，含空格的 ID 也不会把路由拆段", () => {
    const path = forumPostPath(CONFIG_ID_WITH_SPACE, TXID);
    expect(path).toBe(`/forum/${encodeURIComponent(CONFIG_ID_WITH_SPACE)}/post/${TXID}`);
    expect(path.split("/")).toHaveLength(5);
  });

  it("板块入口与节点详情入口是不同路由", () => {
    // 板块行进板块帖子列表，帖子行进节点详情：两者不能共用同一个路径函数。
    expect(forumPostsPath(CONFIG_ID, BOARD_TXID)).not.toBe(forumPostPath(CONFIG_ID, BOARD_TXID));
  });

  it("发布入口的目标是当前节点，不是它的父", () => {
    expect(forumPublishPath(CONFIG_ID, TXID)).toBe(`/forum/${CONFIG_ID}/publish/${TXID}`);
  });
});