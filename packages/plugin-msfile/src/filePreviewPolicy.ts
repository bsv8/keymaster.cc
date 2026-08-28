// packages/plugin-msfile/src/filePreviewPolicy.ts
// 首页文件预览策略：只允许明确的 MIME 白名单和有限文件大小。
//
// MIME / 文件名都来自供应商，不能把扩展名当作类型，也不能把未知的
// `text/*` 当作安全文本。HTML 预览相关函数只生成隔离 iframe 的 Blob 内容，
// 不会把不可信 HTML 写入 Keymaster DOM。

import {
  MSFILE_BLOCK_SIZE_BYTES,
  type MsFileSatoshiAmount,
} from "@keymaster/contracts";
import { parseMsFileUint64 } from "./fileAssembly.js";

/** 自动预览资源保护线：32 MiB（含边界）。 */
export const MSFILE_HOME_AUTO_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;
/** 普通 Blob 下载保护线：256 MiB（含边界）。 */
export const MSFILE_HOME_BLOB_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;

export const MSFILE_HOME_PREVIEW_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/flac",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "text/plain",
  "application/pdf",
  "text/html",
] as const;

const PREVIEW_MIME_TYPES = new Set<string>(MSFILE_HOME_PREVIEW_MIME_TYPES);

export type MsFileHomePreviewKind =
  | "image"
  | "audio"
  | "video"
  | "text"
  | "pdf"
  | "html";

export type MsFileHomePreviewReason =
  | "allowed"
  | "unsupported-media-type"
  | "preview-size-limit"
  | "invalid-file-size";

export interface MsFileHomePreviewDecision {
  normalizedMediaType: string;
  kind: MsFileHomePreviewKind | null;
  canAutoPreview: boolean;
  canBlobDownload: boolean;
  reason: MsFileHomePreviewReason;
}

/** 规范化供应商 MIME：只取分号前主类型并转为小写。 */
export function normalizeMsFileMediaType(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.split(";", 1)[0]!.trim().toLowerCase();
}

function previewKindOf(normalizedMediaType: string): MsFileHomePreviewKind | null {
  if (normalizedMediaType.startsWith("image/")) return "image";
  if (normalizedMediaType.startsWith("audio/")) return "audio";
  if (normalizedMediaType.startsWith("video/")) return "video";
  if (normalizedMediaType === "text/plain") return "text";
  if (normalizedMediaType === "application/pdf") return "pdf";
  if (normalizedMediaType === "text/html") return "html";
  return null;
}

/**
 * 比较边界使用 BigInt；Stat 的十进制文件大小不在安全范围内时也不会
 * 先转成 JS number。无效大小直接禁止两种读取。
 */
export function decideMsFileHomePreview(
  mediaType: unknown,
  fileSizeInput: MsFileSatoshiAmount | unknown,
): MsFileHomePreviewDecision {
  const normalizedMediaType = normalizeMsFileMediaType(mediaType);
  const kind = previewKindOf(normalizedMediaType);
  let fileSizeBytes: bigint;
  try {
    fileSizeBytes = parseMsFileUint64(fileSizeInput);
  } catch {
    return {
      normalizedMediaType,
      kind,
      canAutoPreview: false,
      canBlobDownload: false,
      reason: "invalid-file-size",
    };
  }

  const canBlobDownload = fileSizeBytes <= BigInt(MSFILE_HOME_BLOB_DOWNLOAD_MAX_BYTES);
  const canAutoPreview =
    canBlobDownload &&
    fileSizeBytes <= BigInt(MSFILE_HOME_AUTO_PREVIEW_MAX_BYTES) &&
    PREVIEW_MIME_TYPES.has(normalizedMediaType);
  return {
    normalizedMediaType,
    kind,
    canAutoPreview,
    canBlobDownload,
    reason: canAutoPreview
      ? "allowed"
      : !canBlobDownload
        ? "preview-size-limit"
        : !PREVIEW_MIME_TYPES.has(normalizedMediaType)
          ? "unsupported-media-type"
          : "preview-size-limit",
  };
}

/** 仅允许首页的明确自动预览 MIME。 */
export function isMsFileHomePreviewMime(mediaType: unknown): boolean {
  return PREVIEW_MIME_TYPES.has(normalizeMsFileMediaType(mediaType));
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function hasIsoBmffBrand(bytes: Uint8Array, brands: readonly string[] = []): boolean {
  if (asciiAt(bytes, 4, 4) !== "ftyp") return false;
  const majorBrand = asciiAt(bytes, 8, 4);
  if (brands.length === 0) return true;
  if (brands.includes(majorBrand)) return true;
  for (let offset = 16; offset + 4 <= bytes.length; offset += 4) {
    if (brands.includes(asciiAt(bytes, offset, 4))) return true;
  }
  return false;
}

/**
 * 对已读内容做轻量文件签名检查。最终解码仍由浏览器元素负责；签名不明时
 * 降级为下载，不扩大预览范围。空的 text/plain / text/html 是合法内容。
 */
export function hasMsFilePreviewSignature(
  mediaType: unknown,
  firstBytes: Uint8Array,
): boolean {
  const normalized = normalizeMsFileMediaType(mediaType);
  switch (normalized) {
    case "image/png":
      return startsWithBytes(firstBytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWithBytes(firstBytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return asciiAt(firstBytes, 0, 6) === "GIF87a" || asciiAt(firstBytes, 0, 6) === "GIF89a";
    case "image/webp":
      return asciiAt(firstBytes, 0, 4) === "RIFF" && asciiAt(firstBytes, 8, 4) === "WEBP";
    case "image/avif":
      return hasIsoBmffBrand(firstBytes, ["avif", "avis"]);
    case "audio/mpeg":
      return asciiAt(firstBytes, 0, 3) === "ID3" ||
        startsWithBytes(firstBytes, [0xff, 0xfb]) ||
        startsWithBytes(firstBytes, [0xff, 0xf3]) ||
        startsWithBytes(firstBytes, [0xff, 0xf2]);
    case "audio/wav":
      return asciiAt(firstBytes, 0, 4) === "RIFF" && asciiAt(firstBytes, 8, 4) === "WAVE";
    case "audio/ogg":
    case "video/ogg":
      return asciiAt(firstBytes, 0, 4) === "OggS";
    case "audio/flac":
      return asciiAt(firstBytes, 0, 4) === "fLaC";
    case "video/mp4":
      return hasIsoBmffBrand(firstBytes);
    case "video/webm":
      return startsWithBytes(firstBytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case "application/pdf":
      return asciiAt(firstBytes, 0, 5) === "%PDF-";
    case "text/plain":
    case "text/html":
      return true;
    default:
      return false;
  }
}

/** 从有序 parts 读取少量头部，避免为签名校验复制整个文件。 */
export function firstMsFileBytes(parts: readonly Uint8Array[], limit = 64): Uint8Array {
  const maxBytes = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  let size = 0;
  for (const part of parts) {
    if (size >= maxBytes) break;
    size += Math.min(part.length, maxBytes - size);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    if (offset >= size) break;
    const take = Math.min(part.length, size - offset);
    result.set(part.subarray(0, take), offset);
    offset += take;
  }
  return result;
}

/** UTF-8 解码；fatal 模式确保异常字节不会被静默替换后展示。 */
export function decodeMsFileUtf8(parts: readonly Uint8Array[]): string | undefined {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    for (const part of parts) text += decoder.decode(part, { stream: true });
    text += decoder.decode();
    return text;
  } catch {
    return undefined;
  }
}

/** 返回一份不包含原始文件内容的隔离 HTML 文档 Blob。 */
export function createMsFileIsolatedHtmlBlobUrl(
  html: string,
  createUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): string | undefined {
  if (typeof document === "undefined" || typeof Blob === "undefined") return undefined;
  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, "text/html");
  const documentElement = parsed.documentElement;
  if (!documentElement) return undefined;

  // 先清除主动执行、外部加载、表单和可导航元素；解析发生在 detached
  // Document，不会进入 Keymaster 当前页面 DOM。
  for (const selector of [
    "script", "noscript", "object", "embed", "iframe", "frame", "frameset",
    "base", "link", "meta", "form", "input", "button", "select", "textarea",
    "option", "optgroup", "applet", "svg",
  ]) {
    for (const node of Array.from(parsed.querySelectorAll(selector))) node.remove();
  }

  for (const element of Array.from(parsed.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "download" || name === "target") {
        element.removeAttribute(attribute.name);
      }
    }

    // 所有链接都保留为不可导航的普通文本/外观元素；不保留 href。
    if (element.localName === "a" || element.localName === "area") {
      element.removeAttribute("href");
      element.removeAttribute("xlink:href");
    }

    for (const attributeName of ["src", "srcset", "poster", "action", "formaction", "cite"]) {
      const value = element.getAttribute(attributeName);
      if (value === null) continue;
      const trimmed = value.trim().toLowerCase();
      const mediaElement = element.localName === "img" || element.localName === "audio" ||
        element.localName === "video" || element.localName === "source" || element.localName === "track";
      if (!mediaElement || !(trimmed.startsWith("data:") || trimmed.startsWith("blob:"))) {
        element.removeAttribute(attributeName);
      }
    }

    const style = element.getAttribute("style");
    if (style && /url\s*\(/i.test(style)) element.removeAttribute("style");
  }
  for (const style of Array.from(parsed.querySelectorAll("style"))) {
    const css = style.textContent ?? "";
    // 内联样式可以保留；外部 @import / url() 一律移除，避免把元数据变成
    // 资源请求入口。CSP 仍然作为第二道边界禁止网络。
    if (/@import|url\s*\(/i.test(css)) style.remove();
  }

  const head = parsed.head ?? parsed.createElement("head");
  if (!parsed.head) documentElement.insertBefore(head, documentElement.firstChild);
  const csp = parsed.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute(
    "content",
    "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; " +
      "object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'; font-src 'none'; " +
      "img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  head.insertBefore(csp, head.firstChild);

  const serialized = "<!doctype html>\n" + documentElement.outerHTML;
  try {
    return createUrl(new Blob([serialized], { type: "text/html" }));
  } catch {
    return undefined;
  }
}

/** 供 UI 展示的 Block 大小说明，避免把协议常量散落到组件。 */
export const MSFILE_HOME_BLOCK_SIZE_BYTES = MSFILE_BLOCK_SIZE_BYTES;
