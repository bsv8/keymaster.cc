// 浏览页纯逻辑的测试：目录折叠、分页状态机、JSON 树化、受限 Markdown 与文本处理。
//
// 这些是页面最容易写错、又最难靠肉眼验收的部分，因此直接测：
//   F02/F03/F04 折叠、去重、跨页继续加载、同名文件与目录
//   P04 不可信 Markdown：HTML 不执行、危险协议不产生跳转、图片只占位
//   P02/P06 严格 UTF-8、截断边界回退、有界渲染

import { describe, expect, it } from "vitest";
import type { StorageBrowseEntry } from "@keymaster/contracts";
import {
  applyBrowsePage,
  emptyDirectoryState,
  isDirectoryComplete,
} from "./storageBrowseState.js";
import {
  BROWSE_ROOT_DIRECTORY,
  directoryChildPrefix,
  displayDirectory,
  foldDirectoryEntries,
  joinDirectory,
  mergeDirectoryChildren,
  parentDirectory,
} from "./storageBrowseTree.js";
import {
  buildJsonTree,
  jsonChildrenOf,
  jsonHiddenChildren,
  jsonNodeCount,
  JSON_DEFAULT_EXPAND_DEPTH,
  JSON_MAX_CHILDREN,
} from "./storageBrowseJson.js";
import {
  MARKDOWN_MAX_BLOCKS,
  parseSafeMarkdown,
  safeMarkdownHref,
} from "./storageBrowseMarkdown.js";
import { browseDisplayPage, BROWSE_DISPLAY_PAGE_SIZE } from "./storageBrowseDisplay.js";
import {
  abbreviateName,
  decodePreviewText,
  decodeUtf8Strict,
  formatBytes,
  formatTimestamp,
} from "./storageBrowseText.js";

const DIRECTORY_CONTENT_TYPE = "application/x-directory";
const ENCODER = new TextEncoder();

function file(path: string, extra: Partial<StorageBrowseEntry> = {}): StorageBrowseEntry {
  return { path, size: 10, lastModified: "2026-10-01T00:00:00.000Z", revision: "1", ...extra };
}

function marker(path: string): StorageBrowseEntry {
  return file(path, { size: 0, contentType: DIRECTORY_CONTENT_TYPE });
}

describe("foldDirectoryEntries (F02/F04)", () => {
  it("folds a directory marker into the directory it describes", () => {
    const result = foldDirectoryEntries("", [
      marker("apps/empty/.dir"),
      marker("apps/full/.dir"),
      file("apps/full/notes.txt"),
    ]);
    // 逻辑根只列出第一层；.dir 不是文件，而是「这个目录存在」的证据。
    expect(result.children.map((child) => child.path)).toEqual(["apps"]);
    expect(result.children.every((child) => child.kind === "directory")).toBe(true);
    expect(result.marker).toBeUndefined();

    // 走进 apps 之后，两个标记目录都成为子项，且都不是文件。
    const inside = foldDirectoryEntries("apps", [
      marker("apps/empty/.dir"),
      marker("apps/full/.dir"),
      file("apps/full/notes.txt"),
    ]);
    expect(inside.children.map((child) => child.path)).toEqual(["apps/empty", "apps/full"]);
    expect(inside.children.some((child) => child.name === ".dir")).toBe(false);
  });

  it("keeps a file and a directory that share the same name", () => {
    const result = foldDirectoryEntries("root", [
      file("root/data"),
      marker("root/data/.dir"),
      file("root/data/inner.json"),
    ]);
    expect(result.children.map((child) => child.kind + ":" + child.path)).toEqual([
      "directory:root/data",
      "file:root/data",
    ]);
  });

  it("records the current directory's own marker for the properties pane", () => {
    const result = foldDirectoryEntries("apps/empty", [marker("apps/empty/.dir")]);
    expect(result.marker).toEqual({
      path: "apps/empty/.dir",
      size: 0,
      lastModified: "2026-10-01T00:00:00.000Z",
      revision: "1",
      contentType: DIRECTORY_CONTENT_TYPE,
    });
    // 空目录不会因此凭空多出一个文件节点。
    expect(result.children).toEqual([]);
  });

  it("lists directories before files and ignores deeper levels (F02)", () => {
    const result = foldDirectoryEntries("", [
      file("b.txt"),
      file("a.txt"),
      file("z/deep/very/deeper.json"),
      file("z/shallow.json"),
    ]);
    expect(result.children.map((child) => child.path)).toEqual(["z", "a.txt", "b.txt"]);
    // 深层对象不直接产出节点：它们的内容要点进去才按前缀加载。
    expect(result.children[0]).toEqual({ path: "z", name: "z", kind: "directory" });
  });

  it("ignores entries outside the requested directory", () => {
    const result = foldDirectoryEntries("apps/a", [file("apps/b/x.txt"), file("apps/a/y.txt")]);
    // 节点身份是完整逻辑路径，不是展示名。
    expect(result.children.map((child) => child.path)).toEqual(["apps/a/y.txt"]);
    expect(result.children.map((child) => child.name)).toEqual(["y.txt"]);
  });
});

describe("mergeDirectoryChildren (F03)", () => {
  it("dedupes across pages by kind and full path", () => {
    const first = foldDirectoryChildren(["z/one.json", "z/two.json"]);
    const second = foldDirectoryChildren(["z/two.json", "z/three.json"]);
    const merged = mergeDirectoryChildren(first, second);
    // 节点身份是完整逻辑路径，两页的 z/two.json 因此合并成一个节点。
    expect(merged.children.map((child) => child.path)).toEqual([
      "z/one.json",
      "z/three.json",
      "z/two.json",
    ]);
    // 第二页真正新增的只有一个。
    expect(merged.addedCount).toBe(1);
  });
});

function foldDirectoryChildren(paths: string[]): ReturnType<typeof foldDirectoryEntries>["children"] {
  return paths.map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file" as const }));
}

describe("directory paging state (F03/U01)", () => {
  it("is complete only when there is no cursor, not when a page adds nothing", () => {
    const state = emptyDirectoryState();
    expect(isDirectoryComplete(state)).toBe(true);

    // 一整页都折叠成同一个子目录：没有新增节点，但仍有游标 => 未扫完。
    const page = applyBrowsePage(state, "", {
      entries: [file("deep/one.json"), file("deep/two.json"), file("deep/three.json")],
      nextCursor: "cursor-1",
    }, false);
    expect(page.children.map((child) => child.path)).toEqual(["deep"]);
    expect(isDirectoryComplete(page)).toBe(false);

    const last = applyBrowsePage(page, "", { entries: [file("deep/four.json")] }, true);
    expect(last.children.map((child) => child.path)).toEqual(["deep"]);
    expect(isDirectoryComplete(last)).toBe(true);
    expect(last.loading).toBe(false);
  });

  it("replaces children and drops the stale cursor when a directory is listed again", () => {
    const first = applyBrowsePage(emptyDirectoryState(), "", {
      entries: [file("a.json"), file("b.json")],
      nextCursor: "cursor-1",
    }, false);
    const refreshed = applyBrowsePage(first, "", { entries: [file("a.json")] }, false);
    // 继续加载必须用新会话发出的游标，因此重新列举会清掉旧的。
    expect(refreshed.children.map((child) => child.path)).toEqual(["a.json"]);
    expect(refreshed.cursor).toBeUndefined();
  });

  it("keeps a marker that only appears on the first page", () => {
    const first = applyBrowsePage(emptyDirectoryState(), "apps/empty", {
      entries: [marker("apps/empty/.dir")],
      nextCursor: "cursor-1",
    }, false);
    expect(first.marker?.path).toBe("apps/empty/.dir");
    const second = applyBrowsePage(first, "apps/empty", { entries: [] }, true);
    expect(second.marker?.path).toBe("apps/empty/.dir");
  });

  it("keeps the explicit display root and directory paths (F01)", () => {
    expect(displayDirectory(BROWSE_ROOT_DIRECTORY)).toBe("/");
    expect(displayDirectory("apps/a")).toBe("apps/a");
    expect(directoryChildPrefix(BROWSE_ROOT_DIRECTORY)).toBeUndefined();
    expect(joinDirectory("apps", "a")).toBe("apps/a");
    expect(joinDirectory(BROWSE_ROOT_DIRECTORY, "apps")).toBe("apps");
    expect(parentDirectory("apps/a")).toBe("apps");
    expect(parentDirectory("apps")).toBeUndefined();
  });
});

describe("safe Markdown (P03/P04)", () => {
  it("only allows http, https and mailto targets to become clickable", () => {
    expect(safeMarkdownHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeMarkdownHref("HTTP://example.com")).toBe("HTTP://example.com");
    expect(safeMarkdownHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    for (const target of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//evil.example.com",
      "#anchor",
      "/settings/storage",
      "relative/path",
      "",
    ]) {
      expect(safeMarkdownHref(target), target).toBeUndefined();
    }
  });

  it("never turns embedded HTML, scripts or iframes into markup (P04)", () => {
    const document = parseSafeMarkdown([
      "<script>window.__pwned = 1</script>",
      "<img src=x onerror=alert(1)>",
      "<iframe src=evil></iframe>",
      "Plain **bold** text.",
    ].join("\n\n"));
    // HTML 不被识别为标签：它原样留在文本里，因此不可能被执行。
    const rendered = JSON.stringify(document);
    expect(rendered).toContain("<script>");
    // 解析结果只有文本类 token：没有 raw HTML、没有 code span 误判，也没有任何
    // 会变成元素的种类。渲染层拿到的就是纯文本。
    const inlineKinds = new Set<string>();
    for (const block of document.blocks) {
      const inlines = block.kind === "paragraph" || block.kind === "heading" || block.kind === "quote"
        ? block.inlines
        : block.kind === "list" ? block.items.flat()
        : [];
      for (const inline of inlines) inlineKinds.add(inline.kind);
    }
    expect([...inlineKinds].sort()).toEqual(["strong", "text"]);
    expect(JSON.stringify(document)).toContain("__pwned");
  });

  it("keeps images as placeholders and never carries a loadable source (P04)", () => {
    const document = parseSafeMarkdown("![logo](https://tracker.example.com/pixel.png)");
    const first = document.blocks[0];
    const image = first?.kind === "paragraph" ? first.inlines[0] : undefined;
    expect(image?.kind).toBe("image");
    if (image?.kind === "image") {
      // 没有 src 属性：预览不会因为打开文档而产生任何网络请求。
      expect("src" in image).toBe(false);
      expect(image.rawTarget).toBe("https://tracker.example.com/pixel.png");
    }
  });

  it("marks safe links clickable and unsafe or relative ones as plain text (P04)", () => {
    const document = parseSafeMarkdown("[ok](https://example.com) [bad](javascript:alert(1)) [rel](../secret)");
    const first = document.blocks[0];
    const inlines = first?.kind === "paragraph" ? first.inlines : [];
    const links = inlines.filter((inline) => inline.kind === "link");
    expect(links.map((link) => (link.kind === "link" ? link.href : "missing"))).toEqual([
      "https://example.com",
      undefined,
      undefined,
    ]);
  });

  it("renders the common block structure with bounded work", () => {
    const document = parseSafeMarkdown([
      "# Heading",
      "",
      "A paragraph with `code` and *emphasis*.",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "",
      "> quoted",
      "",
      "```",
      "const x = 1;",
      "```",
      "",
      "---",
    ].join("\n"));
    expect(document.blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "quote",
      "code",
      "rule",
    ]);
    expect(document.truncated).toBe(false);
    const list = document.blocks[2];
    expect(list?.kind === "list" && list.ordered).toBe(false);
    const ordered = document.blocks[3];
    expect(ordered?.kind === "list" && ordered.ordered).toBe(true);
    const code = document.blocks[5];
    expect(code?.kind === "code" && code.text).toBe("const x = 1;");
  });

  it("caps a pathological document instead of freezing the page (P06)", () => {
    const huge = Array.from({ length: MARKDOWN_MAX_BLOCKS + 500 }, (_, index) => "line " + index).join("\n\n");
    const document = parseSafeMarkdown(huge);
    expect(document.truncated).toBe(true);
    expect(document.blocks.length).toBeLessThanOrEqual(MARKDOWN_MAX_BLOCKS);
  });
});

describe("JSON tree bounds (P01/P06)", () => {
  it("expands only the first levels and leaves deeper nodes on demand", () => {
    const tree = buildJsonTree({ a: { b: { c: { d: 1 } } } });
    expect(tree.expandable).toBe(true);
    const a = tree.children?.[0];
    expect(a?.children?.[0]?.children?.[0]).toBeUndefined();
    expect(a?.children?.[0]).toMatchObject({ key: "/a/b", expandable: true });
  });

  it("caps the width of a single container and reports the rest as reachable", () => {
    const total = JSON_MAX_CHILDREN + 250;
    const wide = Object.fromEntries(Array.from({ length: total }, (_, index) => ["k" + index, index]));
    const tree = buildJsonTree(wide);
    expect(tree.size).toBe(total);
    expect(tree.children).toHaveLength(JSON_MAX_CHILDREN);
    // 窗口外的成员必须可见可达：点「更多成员」拿更大的窗口就能生成出来。
    expect(jsonHiddenChildren(tree, tree.children?.length ?? 0)).toBe(250);
    expect(jsonChildrenOf(tree, JSON_MAX_CHILDREN * 3)).toHaveLength(total);
    expect(jsonHiddenChildren(tree, total)).toBe(0);
  });

  it("generates deeper levels on demand instead of recursing to the document depth (P06)", () => {
    let deep: unknown = 1;
    for (let index = 0; index < 10_000; index += 1) deep = { deep };
    // 10,000 层只有 20 KB：远低于 1 MiB 上限，JSON.parse 也正常返回。任何
    // 「先递归到底再按深度丢弃」的写法都会在这里 RangeError。
    const tree = buildJsonTree(deep);
    expect(jsonNodeCount(tree)).toBe(JSON_DEFAULT_EXPAND_DEPTH + 1);
    // 逐层展开：每层只生成一次，深度恒为 1。
    let node = tree;
    for (let depth = 0; depth < 10_000; depth += 1) {
      const children = jsonChildrenOf(node);
      expect(children).toHaveLength(1);
      node = children[0]!;
    }
    expect(node.scalar).toBe("1");
  });

  it("bounds the total node count for a deeply nested document", () => {
    let deep: unknown = 1;
    for (let index = 0; index < 60; index += 1) deep = { deep };
    const tree = buildJsonTree(deep);
    // 自动展开深度限制了预生成的节点规模，深层仍可按需展开。
    expect(jsonNodeCount(tree)).toBeLessThan(1_000);
  });

  it("describes scalars without losing type information", () => {
    const tree = buildJsonTree({ s: "text", n: 1, b: true, z: null });
    const scalars = tree.children?.map((child) => child.scalar);
    expect(scalars).toEqual(['"text"', "1", "true", "null"]);
  });

  it("treats a top-level scalar as a complete JSON value (P01)", () => {
    expect(buildJsonTree(123)).toMatchObject({ expandable: false, scalar: "123" });
    expect(buildJsonTree(null)).toMatchObject({ expandable: false, scalar: "null" });
    expect(buildJsonTree("hello")).toMatchObject({ expandable: false, scalar: '"hello"' });
    const empty = buildJsonTree({});
    expect(empty.expandable).toBe(false);
    expect(empty.size).toBeUndefined();
    expect(jsonChildrenOf(empty)).toEqual([]);
  });
});

describe("preview text handling (P02/P06)", () => {
  it("decodes valid UTF-8 and rejects invalid bytes without replacement characters", () => {
    expect(decodeUtf8Strict(ENCODER.encode("héllo")).ok).toBe(true);
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeUtf8Strict(latin1).ok).toBe(false);
    // 没有静默替换：损坏编码不会被显示成看起来正常的文本。
    expect(decodePreviewText(latin1, false).ok).toBe(false);
  });

  it("backs off to a character boundary when the tail was cut mid-character", () => {
    const source = ENCODER.encode("中文结尾");
    const cut = source.subarray(0, source.byteLength - 1);
    expect(decodeUtf8Strict(cut).ok).toBe(false);
    const decoded = decodePreviewText(cut, true);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.text).toBe("中文结");
  });

  it("keeps genuinely broken encodings broken even when truncation is claimed", () => {
    const broken = new Uint8Array([0xff, 0xfe, 0xfd]);
    expect(decodePreviewText(broken, true).ok).toBe(false);
  });

  it("formats sizes and keeps unparsable timestamps readable", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.00 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MiB");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatTimestamp("not-a-date", "en")).toBe("not-a-date");
    expect(formatTimestamp("2026-10-01T00:00:00.000Z", "en")).not.toBe("2026-10-01T00:00:00.000Z");
  });

  it("abbreviates long names but keeps the extension", () => {
    expect(abbreviateName("short.json")).toBe("short.json");
    const long = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798.json";
    const abbreviated = abbreviateName(long);
    expect(abbreviated.length).toBeLessThan(long.length);
    expect(abbreviated.endsWith(".json")).toBe(true);
  });
});

describe("directory display paging (F03/U01)", () => {
  it("keeps the rendered page fixed while every loaded item stays reachable", () => {
    const total = BROWSE_DISPLAY_PAGE_SIZE * 2 + 7;
    const items = Array.from({ length: total }, (_, index) => "item-" + index);
    const pages = [
      browseDisplayPage(items, 0),
      browseDisplayPage(items, 1),
      browseDisplayPage(items, 2),
    ];
    // 任一时刻最多一页的量：翻到最后一页也只剩尾页，不会越翻越多。
    expect(pages[0]?.visible).toHaveLength(BROWSE_DISPLAY_PAGE_SIZE);
    expect(pages[1]?.visible).toHaveLength(BROWSE_DISPLAY_PAGE_SIZE);
    expect(pages[2]?.visible).toHaveLength(7);
    expect(pages[0]).toMatchObject({ page: 0, pageCount: 3, hasPrevious: false, hasNext: true, firstIndex: 1 });
    expect(pages[2]).toMatchObject({ page: 2, pageCount: 3, hasNext: false, hasPrevious: true, lastIndex: total });
    // 没有一个条目因此不可达：三页拼起来正好覆盖全部。
    expect(pages.flatMap((page) => page.visible)).toEqual(items);
  });

  it("clamps an out-of-range page and tolerates an invalid page size", () => {
    const items = Array.from({ length: BROWSE_DISPLAY_PAGE_SIZE + 3 }, (_, index) => index);
    // 加载更多之后总数变小，旧页下标必须夹回最后一页而不是渲染出空白。
    expect(browseDisplayPage(items, 9)).toMatchObject({ page: 1, visible: items.slice(BROWSE_DISPLAY_PAGE_SIZE) });
    expect(browseDisplayPage(items, -3)).toMatchObject({ page: 0 });
    for (const size of [0, -1, 1.5, Number.NaN]) {
      // 非法页长退回默认页长，而不是渲染出 0 行或一次渲染全部。
      expect(browseDisplayPage(items, 0, size).visible, String(size))
        .toEqual(items.slice(0, BROWSE_DISPLAY_PAGE_SIZE));
    }
    // 空目录也有一页，只是空的。
    expect(browseDisplayPage([], 0)).toMatchObject({ total: 0, pageCount: 1, visible: [], firstIndex: 0, lastIndex: 0 });
  });
});
