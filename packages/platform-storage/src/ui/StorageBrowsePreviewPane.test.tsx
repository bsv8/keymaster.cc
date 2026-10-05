// 预览面板的两类边界测试：
//   P04 Markdown 外链必须由用户主动点击才打开，并且不能把 opener 交出去；危险协议、
//   相对链接与图片都不产生跳转或网络请求。
//   P01/P06 JSON 树必须真按需展开：超深文档不崩、原文切换始终可达、超宽容器的
//   剩余成员可继续生成。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StorageBrowsePreview } from "../runtime/storageBrowseTypes.js";
import { PreviewPane, type BrowsePreviewState, type BrowseTranslate } from "./StorageBrowsePreviewPane.js";
import { JSON_MAX_CHILDREN } from "./storageBrowseJson.js";

const ENCODER = new TextEncoder();

/** 直接用 defaultValue 当文案：这里只关心渲染行为，不关心 i18n 资源。 */
const t: BrowseTranslate = (key, values) => {
  const defaults: Record<string, string> = {
    "storage.browse.md.image": "[image: {{target}}]",
    "storage.browse.md.render": "Rendered",
    "storage.browse.md.source": "Source",
    "storage.browse.json.source": "Original text",
    "storage.browse.jsonCount": "{{type}} · {{count}}",
    "storage.browse.jsonScalar": "{{type}}",
    "storage.browse.jsonMore": "Show more members ({{hidden}} remaining)",
  };
  const template = defaults[key] ?? key;
  return Object.entries(values ?? {}).reduce(
    (text, [name, value]) => text.replaceAll("{{" + name + "}}", String(value)),
    template,
  );
};

function markdownPreview(body: string): StorageBrowsePreview {
  const bytes = ENCODER.encode(body);
  return {
    path: "docs/readme.md",
    format: "markdown",
    bytes,
    totalSize: bytes.byteLength,
    returnedSize: bytes.byteLength,
    truncated: false,
    revision: "rev-1",
    lastModified: "2026-10-01T00:00:00.000Z",
    contentType: "text/markdown",
  };
}

function renderMarkdown(body: string) {
  return render(
    <PreviewPane
      state={{ path: "docs/readme.md", status: "ready", preview: markdownPreview(body) }}
      locale="en"
      translate={t}
      wrapText={false}
      onToggleWrap={() => undefined}
      rawJson={false}
      onToggleRawJson={() => undefined}
      markdownSource={false}
      onToggleMarkdownSource={() => undefined}
      kvRaw={false}
      onToggleKvRaw={() => undefined}
    />,
  );
}

function jsonState(body: string): BrowsePreviewState {
  const bytes = ENCODER.encode(body);
  return {
    path: "data/config.json",
    status: "ready",
    preview: {
      path: "data/config.json",
      format: "json",
      bytes,
      totalSize: bytes.byteLength,
      returnedSize: bytes.byteLength,
      truncated: false,
      revision: "rev-1",
      lastModified: "2026-10-01T00:00:00.000Z",
      contentType: "application/json",
    },
  };
}

function renderJson(body: string, options: { rawJson?: boolean; onToggleRawJson?: () => void } = {}) {
  return render(
    <PreviewPane
      state={jsonState(body)}
      locale="en"
      translate={t}
      wrapText
      onToggleWrap={() => undefined}
      rawJson={options.rawJson ?? false}
      onToggleRawJson={options.onToggleRawJson ?? (() => undefined)}
      markdownSource={false}
      onToggleMarkdownSource={() => undefined}
      kvRaw={false}
      onToggleKvRaw={() => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PreviewPane Markdown links (P04)", () => {
  it("opens a safe link only on click and never hands over the opener", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderMarkdown("See [the docs](https://example.com/docs). ");

    const link = screen.getByRole("link", { name: "the docs" });
    // 渲染本身不得打开任何窗口，也不得产生网络请求。
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(link);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]).toEqual(["https://example.com/docs", "_blank", "noopener,noreferrer"]);
  });

  it("renders dangerous and relative links as plain text", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderMarkdown(
      [
        "[a](javascript:alert(1))",
        "[b](data:text/html,<script>alert(1)</script>)",
        "[c](../secrets.txt)",
        "[d](#anchor)",
      ].join("\n\n"),
    );

    // 没有可点击的链接，因此完全没有 role=link 的元素。
    expect(screen.queryByRole("link")).toBeNull();
    for (const label of ["a", "b", "c", "d"]) {
      expect(screen.getByText(label, { selector: ".storage-browse__md-link-plain" })).toBeTruthy();
    }
    fireEvent.click(screen.getByText("a", { selector: ".storage-browse__md-link-plain" }));
    expect(open).not.toHaveBeenCalled();
  });

  it("never renders image markup or fetches a remote resource", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = renderMarkdown("![logo](https://example.com/logo.png)");

    // 图片只留占位说明：不产生 img 元素，自然也没有 src 或网络请求。
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("[image: https://example.com/logo.png]")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not execute inline HTML or scripts from the document", () => {
    const hostile = '<script>window.__pwned = true</script>\n\n<img src=x onerror="window.__pwned = true">';
    const { container } = renderMarkdown(hostile);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // HTML 只能以文本出现，而不是被解析成节点。
    expect(container.textContent).toContain("<script>");
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});

describe("PreviewPane JSON tree (P01/P06)", () => {
  it("renders a pathological deep document instead of crashing on the first frame", () => {
    // 10,000 层、20 KB：远低于 1 MiB 上限。递归到底的旧实现会在这里 RangeError。
    const deep = "[".repeat(10_000) + "1" + "]".repeat(10_000);
    const { container } = renderJson(deep);
    expect(container.querySelector(".storage-browse__json-node")).not.toBeNull();
    // 首屏只有默认展开的两层，其余层等用户点开。
    expect(container.querySelectorAll(".storage-browse__json-node").length).toBeLessThanOrEqual(3);
  });

  it("expands a deeper level on demand and keeps the document reachable", () => {
    let body = "1";
    for (let index = 0; index < 4; index += 1) body = '{"deep":' + body + "}";
    const { container } = renderJson(body);
    // 第 3 层默认收起：能看到它，但没展开。
    const toggles = () => Array.from(container.querySelectorAll(".storage-browse__json-toggle"));
    expect(toggles().length).toBe(3);
    expect(toggles().at(-1)?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggles().at(-1)!);
    // 展开后多出第 4 层节点，而它自己仍然默认收起：一次只展开一层。
    expect(toggles().length).toBe(4);
    expect(toggles().at(-2)?.getAttribute("aria-expanded")).toBe("true");
    expect(toggles().at(-1)?.getAttribute("aria-expanded")).toBe("false");
  });

  it("wires the original-text toggle and shows the file text verbatim (P01)", () => {
    const body = '{"b":2,\n  "a":1}';
    const onToggle = vi.fn();
    const { container, rerender } = renderJson(body, { onToggleRawJson: onToggle });
    // 树视图里是格式化后的节点，不是原文。
    expect(container.querySelector(".storage-browse__raw")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Original text" }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <PreviewPane
        state={jsonState(body)}
        locale="en"
        translate={t}
        wrapText
        onToggleWrap={() => undefined}
        rawJson
        onToggleRawJson={onToggle}
        markdownSource={false}
        onToggleMarkdownSource={() => undefined}
        kvRaw={false}
        onToggleKvRaw={() => undefined}
      />,
    );
    // 原文视图必须是文件本来的文本：重新 stringify 会改变内容，深文档还会栈溢出。
    expect(container.querySelector(".storage-browse__raw")?.textContent).toBe(body);
  });

  it("keeps the original-text entry for a document that cannot be expanded at all", () => {
    const deep = "[".repeat(10_000) + "1" + "]".repeat(10_000);
    const { container } = renderJson(deep, { rawJson: true });
    // stringify 20 KB 深数组必然 RangeError；因此原文视图从不经过 stringify。
    expect(container.querySelector(".storage-browse__raw")?.textContent).toBe(deep);
  });

  it("generates the remaining members of a wide container on request", () => {
    const total = JSON_MAX_CHILDREN + 3;
    const body = JSON.stringify(Object.fromEntries(Array.from({ length: total }, (_, index) => ["k" + index, index])));
    const { container } = renderJson(body);
    const more = screen.getByRole("button", { name: "Show more members (3 remaining)" });
    expect(container.querySelectorAll(".storage-browse__json-leaf").length).toBe(JSON_MAX_CHILDREN);
    fireEvent.click(more);
    expect(container.querySelectorAll(".storage-browse__json-leaf").length).toBe(total);
  });

  it("shows a top-level scalar as a value instead of an empty tree", () => {
    const { container } = renderJson("123");
    expect(container.textContent).toContain("number");
    expect(container.textContent).toContain("123");
    // 标量视图不能谎称自己是 null。
    expect(container.textContent).not.toContain("null");
  });

  it("tells an empty container apart from a null scalar (P01)", () => {
    // `{}` 与 `[]` 是容器，不是标量：把它们交给标量视图会显示成 null。
    const emptyObject = renderJson("{}");
    expect(emptyObject.container.textContent).toContain("object");
    expect(emptyObject.container.textContent).toContain("0");
    expect(emptyObject.container.textContent).not.toContain("null");
    cleanup();

    const emptyArray = renderJson("[]");
    expect(emptyArray.container.textContent).toContain("array");
    expect(emptyArray.container.textContent).not.toContain("null");
    cleanup();

    // 真正的 null 标量仍然显示为 null。
    const nullRoot = renderJson("null");
    expect(nullRoot.container.textContent).toContain("null");
  });

  it("keeps the original-text toggle reachable in both directions (P01)", () => {
    const onToggle = vi.fn();
    const { container, rerender } = renderJson('{"a":1}', { onToggleRawJson: onToggle });
    // 树视图里能看到切换按钮。
    const toggle = () => screen.getByRole("button", { name: "Original text" });
    fireEvent.click(toggle());
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <PreviewPane
        state={jsonState('{"a":1}')}
        locale="en"
        translate={t}
        wrapText
        onToggleWrap={() => undefined}
        rawJson
        onToggleRawJson={onToggle}
        markdownSource={false}
        onToggleMarkdownSource={() => undefined}
        kvRaw={false}
        onToggleKvRaw={() => undefined}
      />,
    );
    // 原文视图里同一个按钮仍然存在：切到原文不能是单向操作。
    expect(container.querySelector(".storage-browse__raw")?.textContent).toBe('{"a":1}');
    fireEvent.click(toggle());
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("offers the original-text entry even when the document cannot be built", () => {
    const { container } = renderJson("123");
    expect(screen.getByRole("button", { name: "Original text" })).toBeTruthy();
    expect(container.querySelector(".storage-browse__json-leaf")).not.toBeNull();
  });
});
