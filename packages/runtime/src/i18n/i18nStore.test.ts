// packages/runtime/src/i18n/i18nStore.test.ts
// i18nStore 单元测试：覆盖订阅、auto / manual 切换与浏览器语言解析。
//
// 语言偏好不再落 localStorage:跨客户端偏好由远端设置负责。

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

describe("i18nStore", () => {
  beforeEach(() => {
    // applyInitialLanguage() 会读取浏览器语言;测试必须与运行机器的 locale 无关。
    vi.stubGlobal("navigator", { languages: ["en-US"], language: "en-US" });
    __resetForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetForTest();
  });

  it("applyInitialLanguage() defaults to en when nothing stored", () => {
    applyInitialLanguage();
    expect(getLanguage()).toBe("en");
    expect(getLanguageMode()).toBe("auto");
  });

  it("setLanguage switches to manual selection", () => {
    applyInitialLanguage();
    setLanguage("zh-CN");
    expect(getLanguage()).toBe("zh-CN");
    expect(getLanguageMode()).toBe("manual");
  });

  it("setAutoLanguage reverts to auto and resolves browser language", () => {
    applyInitialLanguage();
    setLanguage("zh-CN");
    expect(getLanguageMode()).toBe("manual");
    setAutoLanguage();
    expect(getLanguageMode()).toBe("auto");
    expect(getLanguage()).toBe("en");
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

});
