// packages/runtime/src/i18n/languageMap.test.ts
// languageMap 单元测试：覆盖施工单中的关键场景。

import { describe, expect, it } from "vitest";
import {
  mapBrowserLanguage,
  normalizeLanguageTag,
  resolveBrowserLanguage
} from "./languageMap.js";

describe("normalizeLanguageTag", () => {
  it("normalizes en-US style tags", () => {
    expect(normalizeLanguageTag("en-US")).toBe("en-US");
    expect(normalizeLanguageTag("en_us")).toBe("en-US");
  });

  it("keeps base language when no region", () => {
    expect(normalizeLanguageTag("en")).toBe("en");
    expect(normalizeLanguageTag("ZH")).toBe("zh");
  });

  it("returns null for empty / invalid input", () => {
    expect(normalizeLanguageTag("")).toBeNull();
    expect(normalizeLanguageTag("   ")).toBeNull();
    expect(normalizeLanguageTag("123")).toBeNull();
    expect(normalizeLanguageTag(null)).toBeNull();
    expect(normalizeLanguageTag(undefined)).toBeNull();
  });
});

describe("mapBrowserLanguage", () => {
  it("exact matches", () => {
    expect(mapBrowserLanguage("en")).toBe("en");
    expect(mapBrowserLanguage("zh-CN")).toBe("zh-CN");
  });

  it("english regions map to en", () => {
    expect(mapBrowserLanguage("en-US")).toBe("en");
    expect(mapBrowserLanguage("en-GB")).toBe("en");
    expect(mapBrowserLanguage("en-AU")).toBe("en");
  });

  it("chinese variants map to zh-CN", () => {
    expect(mapBrowserLanguage("zh-Hans")).toBe("zh-CN");
    expect(mapBrowserLanguage("zh-Hans-CN")).toBe("zh-CN");
    expect(mapBrowserLanguage("zh-SG")).toBe("zh-CN");
    expect(mapBrowserLanguage("zh-TW")).toBe("zh-CN");
    expect(mapBrowserLanguage("zh-HK")).toBe("zh-CN");
    expect(mapBrowserLanguage("zh-MO")).toBe("zh-CN");
  });

  it("unsupported locales return undefined (resolveBrowserLanguage does the fallback)", () => {
    // mapBrowserLanguage 只负责"映射到支持语言"；兜底 en 由 resolveBrowserLanguage 处理。
    expect(mapBrowserLanguage("fr-FR")).toBeUndefined();
    expect(mapBrowserLanguage("de")).toBeUndefined();
  });

  it("returns undefined for unmapped languages", () => {
    expect(mapBrowserLanguage("klingon")).toBeUndefined();
  });
});

describe("resolveBrowserLanguage", () => {
  it("returns the first mappable candidate", () => {
    expect(resolveBrowserLanguage(["fr-FR", "zh-Hans-CN", "en-US"])).toBe("zh-CN");
    expect(resolveBrowserLanguage(["fr-FR", "en-GB"])).toBe("en");
  });

  it("falls back to en when nothing maps", () => {
    expect(resolveBrowserLanguage(["klingon", "elvish"])).toBe("en");
    expect(resolveBrowserLanguage(["fr-FR", "de"])).toBe("en");
  });

  it("treats empty array as fallback", () => {
    expect(resolveBrowserLanguage([])).toBe("en");
  });

  it("ignores null / undefined candidates", () => {
    expect(resolveBrowserLanguage([null, undefined, "zh-CN"])).toBe("zh-CN");
  });
});
