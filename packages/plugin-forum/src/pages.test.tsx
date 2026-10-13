// @vitest-environment jsdom
// Forum 页面的渲染断言。
//
// 路由路径与 MIME 判断是纯函数，测它们只能证明字符串处理正确；「图片是否真的
// 出现在页面上」「配置卡片是否给出浏览入口」这类问题必须在渲染结果上看，否则
// 会写出一个内联分支永远走不到的 UI 却以为它已完成。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";

import type { ForumConfig, ForumReadingView, ForumRootVerification } from "@keymaster/contracts";

import { ForumConfigCard, ForumHomePage, ForumReadingBody, isInlineImageMime } from "./pages.js";
import { ForumResourceProvider } from "./ForumResourceContext.js";

vi.mock("@keymaster/runtime", () => ({
  usePluginI18n: () => ({ t: (key: string) => key }),
}));

// jsdom 没有对象 URL：给一个可断言的替身，让「内联 vs 下载」能在 DOM 上区分。
let objectUrlSeq = 0;
beforeEach(() => {
  objectUrlSeq = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => `blob:forum/${(objectUrlSeq += 1)}`,
    revokeObjectURL: () => undefined,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const CONFIG_ID = "my-forum";
const SEED_HASH = "ab".repeat(32);

const CONFIG: ForumConfig = {
  id: CONFIG_ID,
  label: "Test Forum",
  network: "test",
  forumTxid: "cd".repeat(32),
  forumPublicKeyHex: "02".repeat(33),
  endpoints: [{ kind: "https", url: "https://forum.example" }],
};

function root(overrides: Partial<ForumRootVerification> = {}): ForumRootVerification {
  return {
    configId: CONFIG_ID,
    forumTxid: CONFIG.forumTxid,
    rawTxHex: "00",
    forumName: "Test Forum",
    tipPrice: "10",
    forumPublicKeyHex: CONFIG.forumPublicKeyHex,
    payToPublicKeyHex: CONFIG.forumPublicKeyHex,
    verifiedAtMs: 1,
    baseline: "unknown",
    ...overrides,
  };
}

/** 可配置的论坛替身：让测试驱动「新增配置 → 验证 → 进入论坛」这条链路。 */
function forumStub(overrides: Record<string, unknown> = {}): never {
  return {
    async verifyRoot() {
      return root();
    },
    async listConfigs() {
      return [CONFIG];
    },
    async getRootVerification() {
      return undefined;
    },
    async getConfig() {
      return CONFIG;
    },
    ...overrides,
  } as never;
}

/** 在 Forum 资源上下文里渲染：组件通过 useForum 拿服务。 */
function renderForum(node: ReturnType<typeof createElement>, forum: never = forumStub()): void {
  render(createElement(ForumResourceProvider, { value: { forum }, children: node }));
}

afterEach(cleanup);

describe("配置卡片的浏览入口", () => {
  it("根已验证时给出进入板块的链接", () => {
    renderForum(createElement(ForumConfigCard, { config: CONFIG, root: root() }));
    const link = screen.getByRole("link", { name: "forum.config.browse" });
    // 链接必须指向该配置的板块列表，而不是某个交易 txid。
    expect(link.getAttribute("href")).toBe(`/forum/${CONFIG_ID}`);
  });

  it("验证成功后把证据上报，浏览入口随之出现（不必刷新页面）", async () => {
    // 首页持有 roots；卡片验证成功后必须把新证据交回去，否则「新增配置 → 验证 →
    // 进入论坛」会断在最后一步，只能靠刷新。
    const verified: ForumRootVerification[] = [];
    renderForum(createElement(ForumConfigCard, {
      config: CONFIG,
      root: undefined,
      onRootVerified: (value) => verified.push(value),
    }));
    expect(screen.queryByRole("link", { name: "forum.config.browse" })).toBeNull();

    await userEvent.click(await screen.findByRole("button", { name: "forum.config.verifyRoot" }));
    await waitFor(() => expect(verified).toHaveLength(1));
    expect(verified[0]?.forumName).toBe("Test Forum");
  });

  it("首页在验证回调后出现进入论坛的链接", async () => {
    // 端到端一点：首页渲染配置卡片 → 点验证 → 链接出现。
    let current: ForumRootVerification | undefined;
    const forum = forumStub({
      async verifyRoot() {
        current = root();
        return current;
      },
    });
    renderForum(
      createElement(ForumHomePage),
      forum,
    );
    expect(await screen.findByRole("button", { name: "forum.config.verifyRoot" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "forum.config.verifyRoot" }));
    const link = await screen.findByRole("link", { name: "forum.config.browse" });
    expect(link.getAttribute("href")).toBe(`/forum/${CONFIG_ID}`);
  });

  it("根未验证时不给出浏览入口", () => {
    renderForum(createElement(ForumConfigCard, { config: CONFIG, root: undefined }));
    // 没有信任锚就没有后续操作的依据，入口不应存在。
    expect(screen.queryByRole("link", { name: "forum.config.browse" })).toBeNull();
  });
});

describe("附件内联展示", () => {
  it("白名单里的图片内联渲染 img", async () => {
    const view: ForumReadingView = {
      node: {
        txid: "", parentTxid: null, depth: 0, authorPublicKeyHex: "", replyMasterSeedHash: null,
        tipPrice: "0", confirmedTipPrice: "0", effectiveTipPrice: "0", status: "mempool",
        blockHeight: null, blockHash: null, txIndex: null, vout: 0, hasChildren: false,
      },
      content: { seedHashHex: SEED_HASH, state: "verified", verifiedBytes: "10", localCopy: true },
      markdown: "![alt](msfile:" + SEED_HASH + ")",
      attachments: [{ seedHashHex: SEED_HASH, state: "verified" }],
      offline: false,
    };
    const loadAttachment = vi.fn(async () => ({
      seedHashHex: SEED_HASH,
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      byteLength: "4",
      mediaType: "image/png",
      fileName: "chart.png",
    }));
    renderForum(createElement(ForumReadingBody, { view, loadAttachment }));
    // 关键：正常 PNG 必须真的出现在 DOM 里，而不是掉进下载分支。
    // 读取是异步的，因此要等它落地，而不是同步断言一个还没渲染的状态。
    const image = await screen.findByRole("img");
    expect(image.getAttribute("alt")).toBe("chart.png");
    // 内联图片必须指向真实的字节（对象 URL），而不是一个空 src。
    expect(image.getAttribute("src")).toMatch(/^blob:forum\//u);
    await waitFor(() => expect(screen.queryByRole("link", { name: "forum.read.download" })).toBeNull());
  });

  it("非白名单类型只给下载出口", async () => {
    const view: ForumReadingView = {
      node: {
        txid: "", parentTxid: null, depth: 0, authorPublicKeyHex: "", replyMasterSeedHash: null,
        tipPrice: "0", confirmedTipPrice: "0", effectiveTipPrice: "0", status: "mempool",
        blockHeight: null, blockHash: null, txIndex: null, vout: 0, hasChildren: false,
      },
      content: { seedHashHex: SEED_HASH, state: "verified", verifiedBytes: "10", localCopy: true },
      markdown: "![alt](msfile:" + SEED_HASH + ")",
      attachments: [{ seedHashHex: SEED_HASH, state: "verified" }],
      offline: false,
    };
    renderForum(createElement(ForumReadingBody, {
      view,
      loadAttachment: async () => ({
        seedHashHex: SEED_HASH,
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        byteLength: "4",
        mediaType: "application/pdf",
        fileName: "paper.pdf",
      }),
    }));
    await screen.findByRole("link", { name: "forum.read.download" });
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("图片 MIME 判断", () => {
  it("白名单类型与带参数的变体都算图片", () => {
    expect(isInlineImageMime("image/png")).toBe(true);
    expect(isInlineImageMime("image/jpeg")).toBe(true);
    expect(isInlineImageMime("image/webp")).toBe(true);
    expect(isInlineImageMime("image/svg+xml")).toBe(false);
    expect(isInlineImageMime("image/png; charset=binary")).toBe(true);
    expect(isInlineImageMime(" IMAGE/PNG ")).toBe(true);
    expect(isInlineImageMime(undefined)).toBe(false);
    expect(isInlineImageMime("application/pdf")).toBe(false);
  });
});
