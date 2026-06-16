// apps/web/src/shell/legacyHashRoute.test.ts
// legacyHashRoute 单测：
//   - parseLegacyHashPath 是纯函数，不依赖 DOM（覆盖解析规则）。
//   - normalizeLegacyHashRoute 是浏览器副作用入口：必须验证
//     history.replaceState 调用一次 / 目标 path 正确 / 普通 anchor
//     不调用 / pathname 已经匹配时不调用。
//
// 设计缘由：vitest 全局是 node 环境（无 window / history）。副作用测试
// 自己装一个最小 window shim：每个用例在 beforeEach 装、afterEach 卸，
// 不污染其它 test file。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeLegacyHashRoute,
  parseLegacyHashPath
} from "./legacyHashRoute.js";

describe("parseLegacyHashPath", () => {
  it("migrates #/settings/vault to /settings/vault", () => {
    expect(parseLegacyHashPath("/", "#/settings/vault")).toBe("/settings/vault");
  });

  it("migrates legacy #/settings to /settings/language", () => {
    // 旧 hash /settings 已不再有聚合页面；统一迁移到语言设置页（最稳定的系统级）。
    expect(parseLegacyHashPath("/", "#/settings")).toBe("/settings/language");
  });

  it("preserves hash query string", () => {
    expect(parseLegacyHashPath("/", "#/import?source=vault")).toBe(
      "/import?source=vault"
    );
  });

  it("does not migrate plain anchor (#section)", () => {
    expect(parseLegacyHashPath("/", "#section")).toBeUndefined();
  });

  it("does not migrate when pathname is not root", () => {
    expect(parseLegacyHashPath("/settings", "#/settings/vault")).toBeUndefined();
  });

  it("does not migrate double slashes", () => {
    expect(parseLegacyHashPath("/", "#//example.com")).toBeUndefined();
  });

  it("does not migrate protocol-like URLs", () => {
    expect(parseLegacyHashPath("/", "#/https://example.com")).toBeUndefined();
  });

  it("does not migrate when hash is missing", () => {
    expect(parseLegacyHashPath("/", "")).toBeUndefined();
  });

  it("does not migrate when hash does not start with #/", () => {
    expect(parseLegacyHashPath("/", "/settings/vault")).toBeUndefined();
  });
});

describe("normalizeLegacyHashRoute (side effect)", () => {
  let savedWindow: unknown;
  let savedLocation: unknown;
  let savedHistory: unknown;
  // 用闭包数组收集 replaceState 调用，比在 mock 上挂属性更直观。
  const calls: Array<{ url: string }> = [];

  function installWindow(pathname: string, hash: string) {
    calls.length = 0;
    const mockLocation = { pathname, hash } as unknown as Location;
    const mockHistory = {
      pushState: () => undefined,
      replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
        calls.push({ url: url ? String(url) : "" });
      },
      go: () => undefined,
      back: () => undefined,
      forward: () => undefined,
      length: 0,
      scrollRestoration: "auto" as const,
      state: null
    } as unknown as History;
    const mockWindow = {
      location: mockLocation,
      history: mockHistory,
      dispatchEvent: () => true
    } as unknown as Window & typeof globalThis;
    (globalThis as Record<string, unknown>).window = mockWindow;
  }

  beforeEach(() => {
    savedWindow = (globalThis as Record<string, unknown>).window;
    savedLocation = (globalThis as Record<string, unknown>).location;
    savedHistory = (globalThis as Record<string, unknown>).history;
  });

  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    g.window = savedWindow;
    g.location = savedLocation;
    g.history = savedHistory;
  });

  it("calls history.replaceState exactly once with the migrated pathname", () => {
    installWindow("/", "#/settings/vault");
    const migrated = normalizeLegacyHashRoute();
    expect(migrated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/settings/vault");
  });

  it("migrates legacy #/settings to /settings/language", () => {
    installWindow("/", "#/settings");
    const migrated = normalizeLegacyHashRoute();
    expect(migrated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/settings/language");
  });

  it("preserves query string when migrating", () => {
    installWindow("/", "#/import?source=vault");
    const migrated = normalizeLegacyHashRoute();
    expect(migrated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/import?source=vault");
  });

  it("does NOT call replaceState for plain anchor (#section)", () => {
    installWindow("/", "#section");
    const migrated = normalizeLegacyHashRoute();
    expect(migrated).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does NOT call replaceState when pathname is not root", () => {
    installWindow("/settings", "#/settings/vault");
    const migrated = normalizeLegacyHashRoute();
    expect(migrated).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does NOT call replaceState when hash is empty", () => {
    installWindow("/", "");
    const migrated = normalizeLegacyHashRoute();
    expect(migrated).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does NOT call replaceState when current pathname already matches target", () => {
    // pathname 已经是 "/settings/vault"，hash 也没有遗留的旧路由；
    // parseLegacyHashPath 返回的是 "/settings/vault" 本身，函数会因
    // `pathname === target && !hash` 早返回，不再调一次 replaceState。
    installWindow("/settings/vault", "");
    const migrated = normalizeLegacyHashRoute();
    expect(migrated).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns false when window.history is unavailable", () => {
    // 覆盖 typeof window.history === "undefined" 早返回的边界。
    // 装一个 location 有、history 缺失 的窗口。
    const g = globalThis as Record<string, unknown>;
    savedWindow && (g.window = savedWindow);
    g.window = {
      location: { pathname: "/", hash: "#/settings/vault" }
      // 没有 history
    } as unknown as Window & typeof globalThis;
    expect(normalizeLegacyHashRoute()).toBe(false);
  });
});
