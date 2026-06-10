// packages/runtime/src/i18n/languageMap.ts
// 浏览器语言映射模块：把 navigator.language(s) 映射到 SUPPORTED_LANGUAGES。
//
// 设计缘由：
//   - 浏览器语言检测必须受系统支持语言约束：navigator.language 原样
//     （"en-US"、"zh-Hans-CN"）直接当系统语言会出现资源缺失或重复资源目录。
//   - 不引入 i18next-browser-languagedetector；本项目要明确系统支持语言
//     映射和 `auto` 模式语义，自实现更可控。
//   - 不做 IP / 时区 / 地理位置推断；只走 BCP 47 标签语义。

import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, type SupportedLanguage } from "@keymaster/contracts";

/**
 * 规范化 BCP 47 标签：
 *   - trim、非法 / 空字符串返回 null；
 *   - 把 "_" 替换成 "-"；
 *   - 主语言子标签小写（例如 "ZH-cn" -> "zh-cn"）；
 *   - 区域子标签大写（"zh-cn" -> "zh-CN"）。
 */
export function normalizeLanguageTag(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().replace(/_/g, "-");
  if (trimmed.length === 0) return null;
  const parts = trimmed.split("-").filter(Boolean);
  if (parts.length === 0) return null;
  const primary = parts[0]!.toLowerCase();
  if (!/^[a-z]{2,3}$/.test(primary)) return null;
  if (parts.length === 1) return primary;
  const region = parts[1]!;
  if (/^[A-Z]{2}$/.test(region) || /^[0-9]{3}$/.test(region)) {
    return `${primary}-${region}`;
  }
  if (/^[a-z]{2}$/.test(region)) {
    return `${primary}-${region.toUpperCase()}`;
  }
  // 不识别的扩展直接丢弃。
  return primary;
}

/**
 * 中文别名映射。zh-Hans* 系列折到 zh-CN；zh-Hant* / zh-TW / zh-HK 在没有
 * 对应的 zh-TW 支持语言时折到 zh-CN。后续新增 zh-TW 时只要把它加入
 * SUPPORTED_LANGUAGES，下面映射会自动把 zh-TW 系列落到 zh-TW。
 */
const ZH_SIMPLIFIED: ReadonlyArray<SupportedLanguage> = ["zh-CN"];

function mapChineseScript(_tag: string): SupportedLanguage | undefined {
  // 当前系统只有 zh-CN 一个中文语言，所有中文变体都映射到 zh-CN。
  // 未来若新增 zh-TW / zh-Hant 也要在这里分流。
  return ZH_SIMPLIFIED[0];
}

/**
 * 把单个规范化后的 BCP 47 标签映射到支持语言：
 *   - 精确匹配 SUPPORTED_LANGUAGES；
 *   - 中文别名（zh-Hans、zh-Hans-CN、zh-SG、zh-TW、zh-HK 等）；
 *   - 英文区域（en-US、en-GB、en-AU 等） -> en；
 *   - 基础语言（xx 在 SUPPORTED_LANGUAGES 中） -> xx。
 * 无法映射返回 undefined。
 */
export function mapBrowserLanguage(input: string): SupportedLanguage | undefined {
  if (!input) return undefined;
  const supported = new Set<string>(SUPPORTED_LANGUAGES);
  if (supported.has(input)) return input as SupportedLanguage;
  const lower = input.toLowerCase();
  // 基础语言：xx 在 SUPPORTED_LANGUAGES 内。
  const primary = lower.split("-")[0]!;
  if (supported.has(primary)) return primary as SupportedLanguage;
  // 中文别名：所有中文变体走 mapping；当前统一映射到 zh-CN。
  if (primary === "zh") {
    return mapChineseScript(input);
  }
  // 英文区域（en-*） -> en
  if (primary === "en") {
    return "en";
  }
  return undefined;
}

/**
 * 解析多个浏览器语言候选，返回第一个能映射的 SupportedLanguage。
 * 没有任何候选能映射时返回 DEFAULT_LANGUAGE。
 */
export function resolveBrowserLanguage(candidates: ReadonlyArray<string | null | undefined>): SupportedLanguage {
  for (const raw of candidates) {
    const normalized = normalizeLanguageTag(raw);
    if (!normalized) continue;
    const mapped = mapBrowserLanguage(normalized);
    if (mapped) return mapped;
  }
  return DEFAULT_LANGUAGE;
}
