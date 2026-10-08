// Forum 正文规范与 Markdown 投影。
//
// 正文定义为 UTF-8 Markdown、无 BOM；新建内容发布时统一换行为 LF。发布后原始
// 字节冻结，读取时不通过换行或 Unicode 归一化重新定义内容 hash——那会让同一个
// seed hash 对应两份不同的正文。
//
// 投影（标题/摘要）绑定内容 hash 与解析版本，可重建；它不是内容真值，正文真值
// 只有 MSFile 里那一份已验证字节。
//
// 安全：关闭 raw HTML 与脚本执行；链接采用协议白名单；不得因远程 Markdown 自动
// 请求任意 HTTP 图片。正文中的 MSFile 附件用 `msfile:<64 字符小写 seedhash>`
// 引用，该语法是客户端内容约定，不改变 Forum 链上协议。

import type { ForumAttachmentRef, ForumContentProjection, ForumContentState } from "@keymaster/contracts";
import { FORUM_ATTACHMENT_SCHEME, FORUM_MARKDOWN_MAX_BYTES, parseForumAttachmentReference } from "@keymaster/contracts";

/** 解析版本；规则变化时递增，旧投影随之失效而不是被复用。 */
export const MARKDOWN_PARSER_VERSION = 1;

/** 链接协议白名单；其余一律降级为纯文本。 */
export const FORUM_ALLOWED_LINK_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

const BOM = 0xef;

/** 正文解码结果；`markdown` 只有在 `accepted` 为 true 时才有值。 */
export interface DecodedForumMarkdown {
  readonly accepted: boolean;
  readonly markdown?: string;
  readonly bytes: string;
  /** 超限时给出文件入口，正文不送入 renderer。 */
  readonly oversize?: { readonly bytes: string; readonly limitBytes: string };
  readonly failureCode?: "bom" | "not-utf8" | "oversize" | "empty";
}

/**
 * 解码正文并执行体积限制。
 *
 * 读取前和读取过程中都要执行体积限制：这里在解码前按字节数拒绝，解码后再核对
 * 解码长度，避免超大正文先被完整读进内存。
 */
export function decodeForumMarkdown(bytes: Uint8Array, limitBytes: number = FORUM_MARKDOWN_MAX_BYTES): DecodedForumMarkdown {
  if (bytes.byteLength > limitBytes) {
    return {
      accepted: false,
      bytes: bytes.byteLength.toString(),
      oversize: { bytes: bytes.byteLength.toString(), limitBytes: limitBytes.toString() },
      failureCode: "oversize",
    };
  }
  if (bytes.byteLength === 0) {
    return { accepted: false, bytes: "0", failureCode: "empty" };
  }
  // 无 BOM 是内容规范的一部分：带 BOM 时前面的 U+FEFF 会成为标题的一部分。
  if (bytes[0] === BOM && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { accepted: false, bytes: bytes.byteLength.toString(), failureCode: "bom" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { accepted: false, bytes: bytes.byteLength.toString(), failureCode: "not-utf8" };
  }
  // 解码后的字符数不会超过字节数，但显式核对可以在解码器行为变化时立刻失败。
  if (new TextEncoder().encode(text).byteLength !== bytes.byteLength) {
    return { accepted: false, bytes: bytes.byteLength.toString(), failureCode: "not-utf8" };
  }
  return { accepted: true, markdown: text, bytes: bytes.byteLength.toString() };
}

/**
 * 发布前归一化：统一换行为 LF，并去掉 BOM。
 *
 * 只在**新建**内容时执行。已存字节不做任何归一化，否则内容 hash 会变。
 */
export function normalizeForumMarkdownForPublish(source: string): Uint8Array {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return new TextEncoder().encode(withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
}

/** 首个一级标题；缺失时用首个非空文本行的截断投影；再缺失时用短 txid。 */
export function projectForumMarkdown(markdown: string, seedHashHex: string): ForumContentProjection {
  const lines = markdown.split("\n");
  // 标题扫描必须跟踪代码围栏：围栏里的 `#` 是示例内容而不是标题。
  let title = "";
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#\s+(.*\S)\s*$/u.exec(line);
    if (match?.[1] !== undefined) {
      title = match[1];
      break;
    }
  }
  if (title === "") {
    inFence = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        inFence = !inFence;
        continue;
      }
      if (inFence || trimmed === "") continue;
      // 回退到首个非空文本行；行首的标题记号与行内语法一并剥掉。
      title = stripInlineMarkdown(trimmed.replace(/^#{1,6}\s+/u, ""));
      if (title !== "") break;
    }
  }
  if (title === "") {
    title = `${seedHashHex.slice(0, 8)}…`;
  }
  const summary = summarize(markdown, lines);
  return {
    seedHashHex,
    title: clampTitle(title),
    summary,
    parserVersion: MARKDOWN_PARSER_VERSION,
    bytes: new TextEncoder().encode(markdown).byteLength.toString(),
  };
}

function clampTitle(title: string): string {
  // 列表项一行放得下才有意义；超长标题被截断而不是换行。
  return title.length <= 120 ? title : `${title.slice(0, 119)}…`;
}

function summarize(markdown: string, lines: readonly string[]): string {
  const collected: string[] = [];
  let inFence = false;
  let closedHeading = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed === "") continue;
    // 摘要跳过一级标题本身，正文第一句更有信息量。
    if (!closedHeading && /^#\s+/u.test(trimmed)) {
      closedHeading = true;
      continue;
    }
    if (/^#{1,6}\s+/u.test(trimmed)) continue;
    if (/^([-*+]|\d+\.)\s+/u.test(trimmed)) continue;
    if (/^>\s?/u.test(trimmed)) continue;
    collected.push(stripInlineMarkdown(trimmed));
    if (collected.join(" ").length >= 200) break;
  }
  const text = collected.join(" ").trim();
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/(\*\*|__)(.*?)\1/gu, "$2")
    .replace(/(\*|_)(.*?)\1/gu, "$2")
    .replace(/~~(.*?)~~/gu, "$1")
    .trim();
}

/** 提取正文中的 MSFile 附件引用；只认严格的小写 seed hash。 */
export function extractForumAttachments(markdown: string): ForumAttachmentRef[] {
  const found = new Map<string, ForumAttachmentRef>();
  // 只扫描行内图片与链接的目标部分，避免把正文里提到的 `msfile:` 字面量当成附件。
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  for (const match of markdown.matchAll(pattern)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const seedHashHex = parseForumAttachmentReference(raw);
    if (seedHashHex === undefined) continue;
    if (!found.has(seedHashHex)) {
      found.set(seedHashHex, { seedHashHex, reference: `${FORUM_ATTACHMENT_SCHEME}${seedHashHex}`, state: "not-fetched" });
    }
  }
  return [...found.values()];
}

/**
 * 渲染前净化。
 *
 * 三件事必须在这里做完：raw HTML 与脚本不执行、危险 URL 降级、远程图片不自动
 * 请求。返回的是可以直接交给 renderer 的受限 HTML 片段，页面不需要再做一遍
 * 过滤。
 */
export interface ForumRenderNode {
  readonly kind: "text" | "code" | "heading" | "paragraph" | "list" | "quote" | "attachment" | "image";
  readonly text?: string;
  readonly level?: number;
  readonly ordered?: boolean;
  readonly items?: readonly ForumRenderNode[];
  /** 只有协议白名单内的链接才带 href。 */
  readonly href?: string;
  readonly seedHashHex?: string;
  /** 原始目标写法：附件或未自动加载的远程图片都靠它给出显式入口。 */
  readonly reference?: string;
}

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/u;
const LINK_LINE = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/u;
const HEADING_LINE = /^(#{1,6})\s+(.*\S)\s*$/u;
const UNORDERED_LINE = /^[-*+]\s+(.*\S)\s*$/u;
const ORDERED_LINE = /^\d+[.)]\s+(.*\S)\s*$/u;
const QUOTE_LINE = /^>\s?(.*)$/u;

/**
 * 最小 Markdown → 节点树渲染。
 *
 * 刻意只支持安全子集（标题、段落、列表、引用、代码围栏、行内代码、链接、
 * 图片、`msfile:` 附件）。raw HTML 一律作为文本输出而不是被解析，因此不存在
 * 「关闭 raw HTML 后还有一条漏网路径」的问题。
 */
export function renderForumMarkdown(markdown: string): ForumRenderNode[] {
  const lines = markdown.split("\n");
  const root: ForumRenderNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    // 代码围栏：内容原样输出，不解析其中的 Markdown。
    const fence = /^(```|~~~)(.*)$/u.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] as string).startsWith(marker)) {
        body.push(lines[index] as string);
        index += 1;
      }
      index += 1;
      root.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      root.push({ kind: "heading", level: (heading[1] as string).length, text: inline(heading[2] as string) });
      index += 1;
      continue;
    }
    if (UNORDERED_LINE.test(line) || ORDERED_LINE.test(line)) {
      const ordered = ORDERED_LINE.test(line);
      const items: ForumRenderNode[] = [];
      const pattern = ordered ? ORDERED_LINE : UNORDERED_LINE;
      while (index < lines.length) {
        const current = lines[index] as string;
        const match = pattern.exec(current);
        if (!match) break;
        items.push({ kind: "text", text: inline(match[1] as string) });
        index += 1;
      }
      root.push({ kind: "list", ordered, items });
      continue;
    }
    const quote = QUOTE_LINE.exec(line);
    if (quote) {
      root.push({ kind: "quote", text: inline((quote[1] as string).trim()) });
      index += 1;
      continue;
    }
    const image = IMAGE_LINE.exec(line.trim());
    if (image) {
      root.push(toMediaNode(image[2] as string, image[1] as string, true));
      index += 1;
      continue;
    }
    const link = LINK_LINE.exec(line.trim());
    if (link) {
      root.push(toMediaNode(link[2] as string, link[1] as string, false));
      index += 1;
      continue;
    }
    root.push({ kind: "paragraph", text: inline(line) });
    index += 1;
  }
  return root;
}

function toMediaNode(target: string, alt: string, isImage: boolean): ForumRenderNode {
  const seedHashHex = parseForumAttachmentReference(target);
  if (seedHashHex !== undefined) {
    // 附件与图片统一经 MSFile 获取与读取，Forum 不自己取字节。
    return { kind: isImage ? "image" : "attachment", seedHashHex, text: alt, reference: target };
  }
  const url = safeExternalUrl(target);
  if (isImage) {
    // 远程图片不自动请求：只保留 alt，界面给出显式的打开入口。
    return { kind: "image", text: alt, reference: target, href: url };
  }
  if (url === undefined) {
    return { kind: "text", text: alt };
  }
  return { kind: "text", text: alt, href: url };
}

function safeExternalUrl(target: string): string | undefined {
  if (target === "" || /[\u0000-\u001f<>]/u.test(target)) return undefined;
  const trimmed = target.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  // 协议白名单之外的（javascript:、data:、file:）一律不产生 href。
  if (!FORUM_ALLOWED_LINK_PROTOCOLS.has(parsed.protocol)) return undefined;
  return parsed.toString();
}

/** 行内语法 → 纯文本片段数组；链接与附件作为独立节点给出。 */
function inline(text: string): string {
  return stripInlineMarkdown(text);
}

/** 把附件状态合并进引用列表，供界面分别展示。 */
export function mergeAttachmentStates(
  refs: readonly ForumAttachmentRef[],
  statuses: ReadonlyMap<string, ForumContentState>,
): ForumAttachmentRef[] {
  return refs.map((ref) => ({ ...ref, state: statuses.get(ref.seedHashHex) ?? ref.state }));
}