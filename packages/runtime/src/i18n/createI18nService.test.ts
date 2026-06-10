// packages/runtime/src/i18n/createI18nService.test.ts
// I18nService 单元测试：覆盖 key 解析、I18nText 处理、namespace、setLanguage 热切换。

import { describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE, type I18nPluginResources } from "@keymaster/contracts";
import { createI18nService } from "./createI18nService.js";

const sampleResources: I18nPluginResources = {
  namespace: "sample",
  resources: {
    en: {
      "sample.greet": "Hello",
      "sample.greetNamed": "Hello, {{name}}",
      "sample.fallbackTest": "Should not show fallback"
    },
    "zh-CN": {
      "sample.greet": "你好",
      "sample.greetNamed": "你好，{{name}}"
    }
  }
};

describe("createI18nService", () => {
  it("starts with default language (en) and serves common resources", () => {
    const svc = createI18nService({ debug: false });
    expect(svc.language()).toBe(DEFAULT_LANGUAGE);
    expect(svc.t("common.action.save")).toBe("Save");
  });

  it("t() returns key when missing", () => {
    const svc = createI18nService({ debug: false });
    expect(svc.t("nonexistent.key")).toBe("nonexistent.key");
  });

  it("text() handles string passthrough", () => {
    const svc = createI18nService({ debug: false });
    expect(svc.text("plain")).toBe("plain");
    expect(svc.text(undefined)).toBe("");
  });

  it("text() returns fallback when key missing", () => {
    const svc = createI18nService({ debug: false });
    expect(svc.text({ key: "missing.key", fallback: "FALLBACK" })).toBe("FALLBACK");
  });

  it("text() interpolates values", () => {
    const svc = createI18nService({ debug: false });
    svc.registerResources("test", sampleResources);
    expect(svc.text({ key: "sample.greetNamed", fallback: "FALLBACK", values: { name: "Alice" } })).toBe("Hello, Alice");
  });

  it("registerResources merges same namespace", () => {
    const svc = createI18nService({ debug: false });
    svc.registerResources("a", sampleResources);
    svc.registerResources("a", {
      namespace: "sample",
      resources: {
        en: { "sample.greet": "Hi (overridden)" }
      }
    });
    expect(svc.t("sample.greet")).toBe("Hi (overridden)");
  });

  it("setLanguage hot-switches the active language", async () => {
    const svc = createI18nService({ debug: false });
    svc.registerResources("test", sampleResources);
    expect(svc.t("sample.greet")).toBe("Hello");
    await svc.setLanguage("zh-CN");
    expect(svc.language()).toBe("zh-CN");
    expect(svc.t("sample.greet")).toBe("你好");
    // 缺 zh-CN 资源时回退到 en；en 也没时回退到 fallback
    expect(svc.text({ key: "sample.fallbackTest", fallback: "F" })).toBe("Should not show fallback");
    // 真正缺资源时回退到 fallback
    expect(svc.text({ key: "sample.absentKey", fallback: "F" })).toBe("F");
  });

  it("onChange fires when language changes", async () => {
    const svc = createI18nService({ debug: false });
    const seen: string[] = [];
    const off = svc.onChange((l) => seen.push(l));
    await svc.setLanguage("zh-CN");
    await svc.setAuto();
    off();
    // setLanguage 之前语言是 en；setAuto 切回 en（默认）。两次都会触发。
    expect(seen).toContain("zh-CN");
    expect(seen).toContain("en");
  });

  it("supported() returns the descriptor list", () => {
    const svc = createI18nService({ debug: false });
    const supported = svc.supported();
    expect(supported.length).toBe(2);
    expect(supported[0]?.code).toBe("en");
    expect(supported[1]?.code).toBe("zh-CN");
  });

  it("mode() returns current mode", async () => {
    const svc = createI18nService({ debug: false });
    expect(svc.mode()).toBe("auto");
    await svc.setLanguage("zh-CN");
    expect(svc.mode()).toBe("manual");
    await svc.setAuto();
    expect(svc.mode()).toBe("auto");
  });
});
