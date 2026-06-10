// packages/runtime/src/i18n/i18nStore.test.ts
// i18nStore 单元测试：覆盖 localStorage 写入失败、订阅、auto / manual 切换语义。
//
// 注意：vitest.setup.ts 注入了 fake localStorage；这里仅测试 store 自身行为。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetForTest,
  applyInitialLanguage,
  getLanguage,
  getLanguageMode,
  setAutoLanguage,
  setLanguage,
  subscribe
} from "./i18nStore.js";

const STORAGE_KEY = "keymaster.languageMode";

describe("i18nStore", () => {
  beforeEach(() => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // 忽略
      }
    }
    __resetForTest();
  });

  afterEach(() => {
    __resetForTest();
  });

  it("applyInitialLanguage() defaults to en when nothing stored", () => {
    applyInitialLanguage();
    expect(getLanguage()).toBe("en");
    expect(getLanguageMode()).toBe("auto");
  });

  it("setLanguage persists manual selection", () => {
    applyInitialLanguage();
    setLanguage("zh-CN");
    expect(getLanguage()).toBe("zh-CN");
    expect(getLanguageMode()).toBe("manual");
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) {
      expect(ls.getItem(STORAGE_KEY)).toBe("zh-CN");
    }
  });

  it("setAutoLanguage reverts to auto", () => {
    applyInitialLanguage();
    setLanguage("zh-CN");
    expect(getLanguageMode()).toBe("manual");
    setAutoLanguage();
    expect(getLanguageMode()).toBe("auto");
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) {
      // auto 模式：key 写为 "auto"
      expect(ls.getItem(STORAGE_KEY)).toBe("auto");
    }
  });

  it("applyInitialLanguage reads stored manual language", () => {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) {
      ls.setItem(STORAGE_KEY, "zh-CN");
    }
    applyInitialLanguage();
    expect(getLanguage()).toBe("zh-CN");
    expect(getLanguageMode()).toBe("manual");
  });

  it("subscribe receives changes", () => {
    applyInitialLanguage();
    const seen: Array<{ mode: string; language: string }> = [];
    const off = subscribe((s) => seen.push({ mode: s.mode, language: s.language }));
    setLanguage("zh-CN");
    off();
    setLanguage("en");
    // 至少收到 setLanguage("zh-CN") 的 emit；off 之后的 setLanguage 不会触发。
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toEqual({ mode: "manual", language: "zh-CN" });
  });

  it("localStorage write failure does not break in-memory state", () => {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return;
    applyInitialLanguage();
    const setItemSpy = vi
      .spyOn(ls, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceeded");
      });
    try {
      // 不抛错
      setLanguage("zh-CN");
      expect(getLanguage()).toBe("zh-CN");
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it("localStorage read failure uses default", () => {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return;
    const getItemSpy = vi
      .spyOn(ls, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      applyInitialLanguage();
      expect(getLanguage()).toBe("en");
    } finally {
      getItemSpy.mockRestore();
    }
  });
});
