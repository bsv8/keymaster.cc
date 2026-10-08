import { describe, expect, it } from "vitest";

import { FORUM_MARKDOWN_MAX_BYTES } from "@keymaster/contracts";

import {
  decodeForumMarkdown,
  extractForumAttachments,
  FORUM_ALLOWED_LINK_PROTOCOLS,
  MARKDOWN_PARSER_VERSION,
  normalizeForumMarkdownForPublish,
  projectForumMarkdown,
  renderForumMarkdown,
} from "./markdown.js";

const SEED = "ab".repeat(32);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("正文解码与体积限制", () => {
  it("接受 UTF-8 无 BOM 正文，原样返回", () => {
    const decoded = decodeForumMarkdown(utf8("# 标题\n\n正文"));
    expect(decoded.accepted).toBe(true);
    expect(decoded.markdown).toBe("# 标题\n\n正文");
    expect(decoded.bytes).toBe(String(utf8("# 标题\n\n正文").byteLength));
  });

  it("拒绝带 BOM 的正文：BOM 会成为标题的一部分", () => {
    const decoded = decodeForumMarkdown(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("# 标题")]));
    expect(decoded.accepted).toBe(false);
    expect(decoded.failureCode).toBe("bom");
  });

  it("拒绝非法 UTF-8 与空正文", () => {
    expect(decodeForumMarkdown(Uint8Array.from([0xff, 0xfe, 0x00])).failureCode).toBe("not-utf8");
    expect(decodeForumMarkdown(new Uint8Array(0)).failureCode).toBe("empty");
  });

  it("读取前执行 1 MiB 上限：超限给出文件入口而不是正文", () => {
    expect(FORUM_MARKDOWN_MAX_BYTES).toBe(1024 * 1024);
    const over = new Uint8Array(FORUM_MARKDOWN_MAX_BYTES + 1);
    const decoded = decodeForumMarkdown(over);
    expect(decoded.accepted).toBe(false);
    expect(decoded.markdown).toBeUndefined();
    expect(decoded.failureCode).toBe("oversize");
    expect(decoded.oversize).toEqual({ bytes: String(FORUM_MARKDOWN_MAX_BYTES + 1), limitBytes: String(FORUM_MARKDOWN_MAX_BYTES) });
    // 正好在上限之内必须接受。
    expect(decodeForumMarkdown(new Uint8Array(FORUM_MARKDOWN_MAX_BYTES)).accepted).toBe(true);
    // 自定义上限同样生效。
    expect(decodeForumMarkdown(utf8("0123456789"), 5).accepted).toBe(false);
  });
});

describe("发布前归一化", () => {
  it("统一换行为 LF 并去掉 BOM；已发布字节不再改动", () => {
    // 结尾的孤立 CR 也是一次换行，因此结果保留末尾换行。
    expect(new TextDecoder().decode(normalizeForumMarkdownForPublish("\ufeff# a\r\nb\r\nc\r"))).toBe("# a\nb\nc\n");
    expect(new TextDecoder().decode(normalizeForumMarkdownForPublish("\ufeff# a\r\nb"))).toBe("# a\nb");
    // 已经是 LF 的内容不被改写。
    expect(new TextDecoder().decode(normalizeForumMarkdownForPublish("# a\nb"))).toBe("# a\nb");
  });

  it("归一化只发生一次：第二次是幂等的", () => {
    const once = normalizeForumMarkdownForPublish("\ufeffa\r\nb");
    const twice = normalizeForumMarkdownForPublish(new TextDecoder().decode(once));
    expect(Array.from(twice)).toEqual(Array.from(once));
  });
});

describe("标题与摘要投影", () => {
  it("取首个一级标题", () => {
    expect(projectForumMarkdown("# 真实标题\n\n正文", SEED).title).toBe("真实标题");
    // 二级标题不是一级标题，但会作为回退的首个非空行，且记号被剥掉。
    expect(projectForumMarkdown("## 二级\n\n正文", SEED).title).toBe("二级");
  });

  it("缺失标题时用首个非空文本行的截断投影", () => {
    const projection = projectForumMarkdown("这是第一行 **加粗** 内容。\n\n第二段", SEED);
    expect(projection.title).toBe("这是第一行 加粗 内容。");
  });

  it("再缺失时用短 seed hash", () => {
    expect(projectForumMarkdown("   \n\n\t\n", SEED).title).toBe(`${SEED.slice(0, 8)}…`);
  });

  it("投影绑定内容 hash 与解析版本", () => {
    const projection = projectForumMarkdown("# t", SEED);
    expect(projection.seedHashHex).toBe(SEED);
    expect(projection.parserVersion).toBe(MARKDOWN_PARSER_VERSION);
    expect(projection.bytes).toBe(String(utf8("# t").byteLength));
  });

  it("超长标题被截断而不是换行", () => {
    const projection = projectForumMarkdown(`# ${"x".repeat(500)}`, SEED);
    expect(projection.title.length).toBeLessThanOrEqual(120);
    expect(projection.title.endsWith("…")).toBe(true);
  });

  it("摘要跳过标题本身、列表与引用", () => {
    const projection = projectForumMarkdown("# 标题\n\n这是摘要的第一句。\n\n- 列表项\n", SEED);
    expect(projection.summary).toBe("这是摘要的第一句。");
  });

  it("代码围栏内的 # 不被当作标题", () => {
    expect(projectForumMarkdown("```\n# 不是标题\n```\n", SEED).title).toBe(`${SEED.slice(0, 8)}…`);
  });
});

describe("附件引用", () => {
  it("只认严格的 msfile:<64 字符小写 seedhash>", () => {
    const good = "cd".repeat(32);
    expect(extractForumAttachments(`![图](msfile:${good})`)).toEqual([
      { seedHashHex: good, reference: `msfile:${good}`, state: "not-fetched" },
    ]);
    // 大写不是合法形态。
    expect(extractForumAttachments(`![](msfile:${good.toUpperCase()})`)).toEqual([]);
    // 长度不对。
    expect(extractForumAttachments("![](msfile:abcd)")).toEqual([]);
    // 其它协议不是附件。
    expect(extractForumAttachments("![](https://example.com/a.png)")).toEqual([]);
  });

  it("同一个 hash 只出现一次；图片与链接都算附件", () => {
    const good = "ef".repeat(32);
    const refs = extractForumAttachments(`[a](msfile:${good}) ![b](msfile:${good}) [c](msfile:${good})`);
    expect(refs).toHaveLength(1);
  });

  it("正文里提到的字面量不被当作附件", () => {
    const good = "ef".repeat(32);
    expect(extractForumAttachments(`正文里写了 msfile:${good} 但不是引用`)).toEqual([]);
  });
});

describe("渲染安全", () => {
  it("raw HTML 与脚本不执行：只作为文本节点，不产生任何标签节点", () => {
    const nodes = renderForumMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    // 节点种类里没有能承载 HTML 标签的形态：只有 paragraph/text/image/attachment 等。
    expect(nodes.every((node) => ["text", "code", "heading", "paragraph", "list", "quote", "attachment", "image"].includes(node.kind))).toBe(true);
    // `<img src=x onerror=...>` 不是 Markdown 图片语法，因此不产生带 reference 的 image 节点，
    // 也就没有任何可被浏览器当标签解析的字段。
    expect(nodes.some((node) => node.kind === "image")).toBe(false);
    // 字面文本被完整保留，由 React 转义后展示，不解释为 HTML。
    expect(nodes[0]?.text).toBe("<script>alert(1)</script>");
    expect(nodes[1]?.text).toBe("<img src=x onerror=alert(1)>");
  });

  it("链接采用协议白名单：javascript: 与 data: 不产生 href", () => {
    const nodes = renderForumMarkdown("[x](javascript:alert(1))\n\n[y](data:text/html,<script>)\n\n[z](https://ok.example)");
    const withHref = nodes.filter((node) => node.href !== undefined);
    expect(withHref).toHaveLength(1);
    expect(withHref[0]?.href).toContain("https://ok.example/");
    expect(JSON.stringify(nodes)).not.toContain("javascript:");
    expect(JSON.stringify(nodes)).not.toContain("data:");
  });

  it("外链由用户打开而不是在应用内导航", () => {
    expect(FORUM_ALLOWED_LINK_PROTOCOLS.has("https:")).toBe(true);
    expect(FORUM_ALLOWED_LINK_PROTOCOLS.has("http:")).toBe(true);
    expect(FORUM_ALLOWED_LINK_PROTOCOLS.has("mailto:")).toBe(true);
    expect(FORUM_ALLOWED_LINK_PROTOCOLS.has("javascript:")).toBe(false);
  });

  it("远程图片不自动加载：只保留 alt 与显式入口", () => {
    const [image] = renderForumMarkdown("![说明](https://tracker.example/pixel.png)");
    expect(image?.kind).toBe("image");
    expect(image?.reference).toBe("https://tracker.example/pixel.png");
    // 没有直接的图片 URL 字段可供 <img src> 使用；界面只展示 reference。
    expect(image).not.toHaveProperty("src");
  });

  it("msfile 附件渲染成 attachment 节点，正文里的字节不由 Forum 取", () => {
    const good = "12".repeat(32);
    const [image] = renderForumMarkdown(`![附件](msfile:${good})`);
    expect(image?.kind).toBe("image");
    expect(image?.seedHashHex).toBe(good);
    expect(image?.reference).toBe(`msfile:${good}`);
  });

  it("代码围栏内容原样输出，不解析其中的 Markdown", () => {
    const nodes = renderForumMarkdown("```\n# 不是标题\n[不是链接](x)\n```");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "code" });
    expect(nodes[0]?.text).toBe("# 不是标题\n[不是链接](x)");
  });

  it("标题、列表与引用渲染成对应的节点", () => {
    const nodes = renderForumMarkdown("# h1\n## h2\n\n- a\n- b\n\n1. one\n\n> quote\n\n段落");
    const kinds = nodes.map((node) => node.kind);
    expect(kinds).toEqual(["heading", "heading", "list", "list", "quote", "paragraph"]);
    expect(nodes[1]?.level).toBe(2);
    expect(nodes[2]?.ordered).toBe(false);
    expect(nodes[2]?.items).toHaveLength(2);
    expect(nodes[3]?.ordered).toBe(true);
  });

  it("行内语法被降级为纯文本，不产生可执行标记", () => {
    const [paragraph] = renderForumMarkdown("**加粗** 和 `代码` 与 [链接](https://a.example)");
    expect(paragraph?.kind).toBe("paragraph");
    expect(paragraph?.text).toBe("加粗 和 代码 与 链接");
    expect(paragraph?.href).toBeUndefined();
  });
});