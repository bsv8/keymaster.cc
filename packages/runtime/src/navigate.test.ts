// packages/runtime/src/navigate.test.ts
// 硬切换 007：navigateTo 必须按完整 path (pathname + search + hash) 比较与推送，
// 否则同一 pathname 下换 ?query 会静默 no-op。
//
// useCurrentPath 已在文件里内联说明：nav version 计数器强制重渲染。这一行为
// 在 node 测试环境里需要 jsdom 才能挂载 React，仓库目前没装；本测试只覆盖
// navigateTo / subscribePath 行为。useCurrentPath 行为由 review + 手测兜底。

import { describe, expect, it, beforeEach, vi } from "vitest";
import { currentLocationPath, currentPath, navigateTo, router, subscribePath } from "./navigate.js";

interface FakeLocation {
  pathname: string;
  search: string;
  hash: string;
  href: string;
  origin: string;
  assign: (url: string) => void;
}

function makeWindow(initial: { pathname: string; search?: string; hash?: string; origin?: string }) {
  const location: FakeLocation = {
    pathname: initial.pathname,
    search: initial.search ?? "",
    hash: initial.hash ?? "",
    href: "",
    origin: initial.origin ?? "https://app.example.com",
    assign: () => {
      // no-op for tests
    }
  };
  location.href = `${location.origin}${location.pathname}${location.search}${location.hash}`;

  const historyCalls: string[] = [];
  const history = {
    get state() {
      return null;
    },
    pushState: (_state: unknown, _title: string, url: string) => {
      historyCalls.push(url);
      // 模拟浏览器更新 location
      const u = new URL(url, location.origin);
      location.pathname = u.pathname;
      location.search = u.search;
      location.hash = u.hash;
      location.href = u.href;
    }
  };

  // 安装到 globalThis
  (globalThis as { window: unknown }).window = {
    location,
    history,
    addEventListener: () => {
      // no-op
    },
    removeEventListener: () => {
      // no-op
    }
  };

  return { location: location as unknown as Location, history, historyCalls };
}

describe("navigateTo", () => {
  beforeEach(() => {
    makeWindow({ pathname: "/" });
  });

  it("pushes the new path with search and hash", () => {
    const { historyCalls } = makeWindow({ pathname: "/" });
    const spy = vi.fn();
    const off = subscribePath(spy);
    navigateTo("/p2pkh?assetId=abc#section");
    expect(historyCalls).toEqual(["/p2pkh?assetId=abc#section"]);
    expect(currentLocationPath()).toBe("/p2pkh?assetId=abc#section");
    expect(spy).toHaveBeenCalledTimes(1);
    off();
  });

  it("no-ops when current full path equals the target", () => {
    const { historyCalls } = makeWindow({ pathname: "/p2pkh", search: "?assetId=abc" });
    const spy = vi.fn();
    const off = subscribePath(spy);
    navigateTo("/p2pkh?assetId=abc");
    expect(historyCalls).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    off();
  });

  it("updates URL when only the search changes on the same pathname", () => {
    const { historyCalls } = makeWindow({ pathname: "/p2pkh", search: "?assetId=abc" });
    const spy = vi.fn();
    const off = subscribePath(spy);
    navigateTo("/p2pkh?assetId=xyz");
    expect(historyCalls).toEqual(["/p2pkh?assetId=xyz"]);
    expect(currentLocationPath()).toBe("/p2pkh?assetId=xyz");
    expect(spy).toHaveBeenCalledTimes(1);
    off();
  });

  it("updates URL when only the hash changes on the same pathname", () => {
    const { historyCalls } = makeWindow({ pathname: "/p2pkh", search: "?assetId=abc" });
    navigateTo("/p2pkh?assetId=abc#section");
    expect(historyCalls).toEqual(["/p2pkh?assetId=abc#section"]);
    expect(currentLocationPath()).toBe("/p2pkh?assetId=abc#section");
  });

  it("clears the search when navigateTo is called with bare pathname", () => {
    const { historyCalls } = makeWindow({ pathname: "/p2pkh", search: "?assetId=abc" });
    navigateTo("/p2pkh");
    expect(historyCalls).toEqual(["/p2pkh"]);
    expect(currentLocationPath()).toBe("/p2pkh");
  });

  it("router.push delegates to navigateTo with full path support", () => {
    const { historyCalls } = makeWindow({ pathname: "/p2pkh", search: "?assetId=abc" });
    router.push("/p2pkh?assetId=xyz");
    expect(historyCalls).toEqual(["/p2pkh?assetId=xyz"]);
    expect(currentLocationPath()).toBe("/p2pkh?assetId=xyz");
  });

  it("currentPath still returns only pathname for backward compat", () => {
    makeWindow({ pathname: "/p2pkh", search: "?assetId=abc", hash: "#x" });
    expect(currentPath()).toBe("/p2pkh");
  });
});
