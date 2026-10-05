// 预览格式判定与纯解码。
//
// 这里没有任何 I/O，也不碰 DOM：Worker 与页面共用同一份判定，因此同一个对象
// 在任何一处都会得到同样的 format。截断内容一律降级成 truncated，不做结构化解析：
// 截掉的 JSON、K-V 信封或 Markdown 都无法给出可信结果。

import type { StoragePreviewFormat } from "./storageBrowseTypes.js";
import {
  kvDecodePayloadShape,
  kvDecodeValueObject,
  kvStartsWithBytes,
  KV_VALUE_OBJECT_HEADER_PREFIX,
} from "../kv-engine/kvValueCodec.js";

const TEXT_CONTENT_PREFIX = "text/";
const MARKDOWN_CONTENT_TYPES = new Set(["text/markdown", "text/x-markdown"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const JSON_CONTENT_TYPES = new Set(["application/json"]);
const JSON_EXTENSIONS = new Set([".json"]);
const TEXT_EXTENSIONS = new Set([".txt", ".text", ".log", ".csv", ".tsv", ".yaml", ".yml", ".toml", ".ini", ".env"]);

export interface BrowsePreviewDetection {
  format: StoragePreviewFormat;
  /** 严格 UTF-8 解码后的文本；仅文本类格式出现。 */
  text?: string;
  /** K-V 解码结果。 */
  kvPayload?: {
    valueId: string;
    partition: string;
    payloadFingerprint: string;
    json: boolean;
    jsonText?: string;
  };
  /** K-V 信封被拒的原因。 */
  kvError?: "envelope-invalid" | "version-unsupported" | "hash-mismatch" | "payload-unsupported";
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** 内容类型只取 type/subtype，忽略参数与大小写。 */
function baseContentType(contentType: string | undefined): string {
  if (contentType === undefined) return "";
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

/** 内容类型是否明确表示二进制，例如 image/* 或 application/octet-stream。 */
function isBinaryContentType(contentType: string): boolean {
  if (contentType === "") return false;
  if (contentType.startsWith(TEXT_CONTENT_PREFIX)) return false;
  if (JSON_CONTENT_TYPES.has(contentType) || MARKDOWN_CONTENT_TYPES.has(contentType)) return false;
  if (contentType.endsWith("+json") || contentType.endsWith("+xml")) return false;
  return true;
}

/**
 * 严格 UTF-8 解码。
 *
 * fatal 让非法字节变成错误而不是 U+FFFD：替换字符会让用户以为文件里真的有
 * 一个替换符，而它其实来自编码损坏。TextDecoder 按惯例吞掉 UTF-8 BOM，
 * 因此带 BOM 的 JSON 仍能正常解析，不会被误判成损坏。
 */
function decodeUtf8Strict(bytes: Uint8Array): { ok: true; text: string } | { ok: false } {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}

/**
 * 完整 JSON 语法解析。
 *
 * `JSON.parse` 接受的是 JSON 全部文法：对象、数组，以及 `123`、`true`、`null`、
 * `"hello"` 这类顶层标量。因此「必须以 { 或 [ 开头」既不是 JSON 的要求，也是一种
 * 会把合法标量文件误判成二进制的错误约束。
 */
function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * 无声明时的内容检测：只把确凿的 JSON 对象/数组当 JSON。
 *
 * 顶层标量在这里不构成证据：既没有扩展名也没有内容类型时，一个文件里只有 `123`
 * 并不说明它想表达 JSON。而文件已经声明自己是 JSON（扩展名、application/json 或
 * +json）时不用这条，标量按完整语法处理。
 */
function detectJsonContent(text: string): boolean {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return false;
  return parseJsonText(trimmed).ok;
}

/** 已知会以 JSON 写入、但既无扩展名也无内容类型的路径。 */
function isKnownJsonShapeName(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "current" || name === "meta";
}

function extensionImpliesJson(path: string, contentType: string | undefined): boolean {
  if (JSON_EXTENSIONS.has(extensionOf(path))) return true;
  const base = baseContentType(contentType);
  // 写入方声明的 application/json 是比扩展名更强的信号：即使文件叫 .txt，
  // 内容也确实是 JSON。这条必须与下面的 +json 保持一致，否则同一个内容会
  // 因内容类型的写法不同而得到不同的呈现。
  if (JSON_CONTENT_TYPES.has(base)) return true;
  if (base.endsWith("+json")) return true;
  // 无扩展名也无内容类型时，只认确实写成 JSON 的名字，其余交给内容检测。
  return base === "" && isKnownJsonShapeName(path);
}

export interface DetectBrowsePreviewInput {
  path: string;
  contentType?: string;
  /** 实际返回的字节；已被 Worker 按上限截断。 */
  bytes: Uint8Array;
  /** 截断时不得做任何结构化解析。 */
  truncated: boolean;
}

/**
 * 判定预览格式。顺序即优先级：K-V 信封 → 空 → 截断 → 内容类型/扩展名 → 有限检测。
 */
export function detectBrowsePreview(input: DetectBrowsePreviewInput): BrowsePreviewDetection {
  const { bytes, truncated, path } = input;
  const contentType = input.contentType;

  if (kvStartsWithBytes(bytes, KV_VALUE_OBJECT_HEADER_PREFIX)) {
    // 截断的 K-V 信封无法完成哈希校验，不能声称已解码成功。
    if (truncated) return { format: "truncated" };
    const decoded = kvDecodeValueObject(bytes);
    if (!decoded.ok) return { format: "kv-invalid", kvError: decoded.error };
    const header = {
      valueId: decoded.record.valueId,
      partition: decoded.record.partition,
      payloadFingerprint: decoded.record.valueHash,
    };
    try {
      const shape = kvDecodePayloadShape(decoded.record.payload);
      if (shape.kind === "binary") {
        // 载荷已通过信封与哈希校验，但字节不是文本；属性仍然可用。
        return { format: "kv-invalid", kvError: "payload-unsupported", kvPayload: { ...header, json: false } };
      }
      return { format: "kv-value", kvPayload: { ...header, json: true, jsonText: shape.text } };
    } catch {
      return { format: "kv-invalid", kvError: "payload-unsupported", kvPayload: { ...header, json: false } };
    }
  }

  if (bytes.byteLength === 0) return { format: "empty" };
  // 截断后再判定只会给出错误结论：半个 JSON、半个 Markdown 都不是它自己。
  if (truncated) return { format: "truncated" };

  const extension = extensionOf(path);
  const base = baseContentType(contentType);
  const wantsMarkdown = MARKDOWN_EXTENSIONS.has(extension) || MARKDOWN_CONTENT_TYPES.has(base);

  // 明确的二进制内容类型优先于扩展名：.txt 不改变 image/png 的性质。
  if (isBinaryContentType(base)) return { format: "binary" };

  if (wantsMarkdown) {
    const decoded = decodeUtf8Strict(bytes);
    return decoded.ok ? { format: "markdown", text: decoded.text } : { format: "binary" };
  }

  if (extensionImpliesJson(path, contentType)) {
    const decoded = decodeUtf8Strict(bytes);
    if (!decoded.ok) return { format: "binary" };
    // 声明了就是 JSON：按完整语法解析，顶层标量与对象/数组同等对待。
    if (parseJsonText(decoded.text).ok) return { format: "json", text: decoded.text };
    // 声称是 JSON 却解析失败：展示原文与失败提示，绝不显示成空数据，也不因为
    // 「不以 { 或 [ 开头」就改判成二进制——那正是 not JSON 这类损坏内容看不到的原因。
    return { format: "json-broken", text: decoded.text };
  }

  const wantsText = base.startsWith(TEXT_CONTENT_PREFIX) || TEXT_EXTENSIONS.has(extension);
  if (!wantsText) {
    // 没有声明也没有扩展名时才做有限内容检测，且只把确凿的文本当文本。
    const decoded = decodeUtf8Strict(bytes);
    if (!decoded.ok) return { format: "binary" };
    if (detectJsonContent(decoded.text)) return { format: "json", text: decoded.text };
    return { format: "binary" };
  }

  const decoded = decodeUtf8Strict(bytes);
  if (!decoded.ok) return { format: "binary" };
  return { format: "text", text: decoded.text };
}
