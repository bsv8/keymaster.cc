// 受限 Markdown 解析。
//
// 预览必须满足：禁用内嵌 HTML、脚本、iframe 与自动加载远程资源；图片只显示
// 占位；链接过滤可执行及危险协议；相对链接不映射为存储读取或应用路由。
// 实现方式是不产生 HTML，而是产出结构化 token 由页面映射成 React 元素——
// 这样「不执行」是结构上的事实，而不是对输入的过滤承诺。

/** 行内 token。 */
export type SafeMarkdownInline =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "emphasis"; value: string }
  /** 可点击链接；href 为 undefined 时只展示文本。 */
  | { kind: "link"; value: string; href?: string; rawTarget: string }
  /** 图片占位；没有任何 src 会被加载。 */
  | { kind: "image"; value: string; rawTarget: string };

/** 块级 token。 */
export type SafeMarkdownBlock =
  | { kind: "heading"; level: number; inlines: SafeMarkdownInline[] }
  | { kind: "paragraph"; inlines: SafeMarkdownInline[] }
  | { kind: "list"; ordered: boolean; items: SafeMarkdownInline[][] }
  | { kind: "quote"; inlines: SafeMarkdownInline[] }
  | { kind: "code"; text: string }
  | { kind: "rule" };

export interface SafeMarkdownDocument {
  blocks: SafeMarkdownBlock[];
  /** 解析过程按上限截断过；页面据此提示文档过大。 */
  truncated: boolean;
}

/** 允许变成可点击 href 的协议；其余一律降级为纯文本。 */
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Markdown 渲染的硬上限：超长文档按块截断并提示，不让页面失去响应。 */
export const MARKDOWN_MAX_BLOCKS = 2_000;
/** Markdown 渲染的单块字符上限。 */
export const MARKDOWN_MAX_BLOCK_CHARS = 20_000;

/**
 * 判断链接目标能否变成可点击的 href。
 *
 * 只放行 http/https/mailto。`javascript:`、`data:`、协议相对地址
 * (`//host`)、锚点和一切相对路径都返回 undefined：预览不能因为打开一个文档就执行任何
 * 东西，也不能顺手把相对路径映射成读取钱包里的另一个对象。
 */
export function safeMarkdownHref(target: string): string | undefined {
  const trimmed = target.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("#") || trimmed.startsWith("//")) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed);
  // 没有 scheme 的都是相对链接，同样不给 href。
  if (!scheme) return undefined;
  return SAFE_LINK_PROTOCOLS.has(scheme[1]!.toLowerCase() + ":") ? trimmed : undefined;
}

const INLINE_PATTERN
  = /(!?)\[([^\]]*)\]\(([^)\s]*)\)|\x60([^\x60]+)\x60|\*\*([^*]+)\*\*|\*([^*]+)\*|__([^_]+)__|_([^_]+)_/gu;

/**
 * 行内解析：只保留链接、图片占位、行内代码、粗体和斜体。
 *
 * HTML 完全不识别：`&lt;script&gt;`、`&lt;iframe&gt;` 与任意标签会作为普通文本原样显示，
 * 因此既不会被解析成元素，也不会产生任何请求。
 */
export function parseSafeMarkdownInline(text: string): SafeMarkdownInline[] {
  const output: SafeMarkdownInline[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) output.push({ kind: "text", value: text.slice(cursor, start) });
    const [whole, bang, linkLabel, linkTarget, code, strong, em, strongU, emU] = match;
    if (linkLabel !== undefined) {
      const target = linkTarget ?? "";
      if (bang === "!") output.push({ kind: "image", value: linkLabel, rawTarget: target });
      else {
        const href = safeMarkdownHref(target);
        output.push({ kind: "link", value: linkLabel, rawTarget: target, ...(href === undefined ? {} : { href }) });
      }
    } else if (code !== undefined) output.push({ kind: "code", value: code });
    else if (strong !== undefined) output.push({ kind: "strong", value: strong });
    else if (em !== undefined) output.push({ kind: "emphasis", value: em });
    else if (strongU !== undefined) output.push({ kind: "strong", value: strongU });
    else if (emU !== undefined) output.push({ kind: "emphasis", value: emU });
    cursor = start + whole!.length;
  }
  if (cursor < text.length) output.push({ kind: "text", value: text.slice(cursor) });
  return output;
}

/** 围栏代码块的结束标记。 */
const CODE_FENCE = "\x60\x60\x60";
const ALTERNATE_FENCE = "~~~";

/**
 * 块级解析。
 *
 * 这不是完整 CommonMark 实现：它只覆盖文档预览真正会用到的标题、段落、
 * 列表、引用、围栏代码与分隔线，其余（含 HTML）按纯文本处理。工作量与输入
 * 长度线性且处处有上限，因此不存在让页面卡死的路径。
 */
export function parseSafeMarkdown(source: string): SafeMarkdownDocument {
  const lines = source.split(/\r?\n/u);
  const blocks: SafeMarkdownBlock[] = [];
  let truncated = false;
  let index = 0;

  function push(block: SafeMarkdownBlock): boolean {
    if (blocks.length >= MARKDOWN_MAX_BLOCKS) {
      truncated = true;
      return false;
    }
    blocks.push(block);
    return true;
  }

  function clamp(value: string): string {
    if (value.length <= MARKDOWN_MAX_BLOCK_CHARS) return value;
    truncated = true;
    return value.slice(0, MARKDOWN_MAX_BLOCK_CHARS);
  }

  const LIST_ITEM = /^\s*(?:[-*+]\s+|(\d+)[.)]\s+)/u;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const trimmedEnd = line.trimEnd();
    if (trimmedEnd === "---" || trimmedEnd === "***" || trimmedEnd === "___") {
      if (!push({ kind: "rule" })) break;
      index += 1;
      continue;
    }
    if (line.trim().startsWith(CODE_FENCE) || line.trim().startsWith(ALTERNATE_FENCE)) {
      const marker = line.trim().startsWith(CODE_FENCE) ? CODE_FENCE : ALTERNATE_FENCE;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && lines[index]!.trim().startsWith(marker) === false) {
        body.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      if (!push({ kind: "code", text: clamp(body.join("\n")) })) break;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      if (!push({ kind: "heading", level: heading[1]!.length, inlines: parseSafeMarkdownInline(clamp(heading[2] ?? "")) })) break;
      index += 1;
      continue;
    }
    if (/^\s*>/u.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>/u.test(lines[index]!)) {
        body.push(lines[index]!.replace(/^\s*>\s?/u, ""));
        index += 1;
      }
      if (!push({ kind: "quote", inlines: parseSafeMarkdownInline(clamp(body.join("\n"))) })) break;
      continue;
    }
    const firstItem = LIST_ITEM.exec(line);
    if (firstItem) {
      const ordered = firstItem[1] !== undefined;
      const items: SafeMarkdownInline[][] = [];
      while (index < lines.length) {
        const item = LIST_ITEM.exec(lines[index]!);
        // 无序与有序列表不混在同一个块里，混排时另起一块。
        if (!item || (item[1] !== undefined) !== ordered) break;
        items.push(parseSafeMarkdownInline(clamp(lines[index]!.slice(item[0].length))));
        index += 1;
      }
      if (!push({ kind: "list", ordered, items })) break;
      continue;
    }
    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index]!;
      if (current.trim().length === 0) break;
      if (/^(#{1,6})\s+/u.test(current)) break;
      if (/^\s*>/u.test(current)) break;
      if (current.trim().startsWith(CODE_FENCE) || current.trim().startsWith(ALTERNATE_FENCE)) break;
      if (body.length > 0 && LIST_ITEM.test(current)) break;
      body.push(current);
      index += 1;
    }
    if (!push({ kind: "paragraph", inlines: parseSafeMarkdownInline(clamp(body.join("\n"))) })) break;
  }

  return { blocks, truncated };
}
