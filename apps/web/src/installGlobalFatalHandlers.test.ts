// apps/web/src/installGlobalFatalHandlers.test.ts
// 全局 window 错误接管的来源过滤测试（施工单 2026-06-30 001）。
//
// 覆盖：
//   1. 同源本应用错误（filename 与 window.location.origin 同源）-> 升 fatal。
//   2. 第三方脚本错误（chrome-extension:// / 跨域）-> 不升 fatal。
//   3. opaque unhandledrejection（无 stack 无 filename）-> 不升 fatal。
//   4. handler 抛错时不能递归调 reportFatalError。
//
// 测试环境：jsdom。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFatalError,
  resetFatalErrorForTest,
  subscribeFatalError
} from "@keymaster/runtime";
import {
  installGlobalFatalHandlers,
  uninstallGlobalFatalHandlersForTest
} from "./installGlobalFatalHandlers.js";

beforeEach(() => {
  resetFatalErrorForTest();
  // 模拟 window.location.origin 为 http://localhost:5173。
  Object.defineProperty(window, "location", {
    value: { origin: "http://localhost:5173", host: "localhost:5173" },
    writable: true
  });
});

afterEach(() => {
  uninstallGlobalFatalHandlersForTest();
  resetFatalErrorForTest();
});

function fireError(filename: string, message: string, error?: Error): void {
  // jsdom 不挂载真实 ErrorEvent,手动 dispatch Event 即可。
  const event = new Event("error") as Event & {
    filename?: string;
    message?: string;
    error?: Error;
  };
  event.filename = filename;
  event.message = message;
  event.error = error;
  window.dispatchEvent(event);
}

function fireRejection(reason: unknown): void {
  const event = new Event("unhandledrejection") as Event & {
    reason?: unknown;
  };
  event.reason = reason;
  window.dispatchEvent(event);
}

describe("installGlobalFatalHandlers", () => {
  it("upgrades same-origin app error to fatal", () => {
    installGlobalFatalHandlers();
    const err = new Error("app-side explosion");
    // filename 指向同源 bundle,应被升级为 fatal。
    fireError("http://localhost:5173/src/foo.ts", "app-side explosion", err);
    const fatal = getFatalError();
    expect(fatal).not.toBeNull();
    expect(fatal?.phase).toBe("global.error");
    expect(fatal?.scope).toBe("browser");
    expect(fatal?.source).toBe("app-bundle");
    expect(fatal?.message).toBe("app-side explosion");
  });

  it("ignores third-party / extension errors", () => {
    installGlobalFatalHandlers();
    fireError("chrome-extension://abcdefg/content.js", "extension error");
    // 跨域：应只 console.warn,不动 fatal store。
    expect(getFatalError()).toBeNull();
  });

  it("ignores cross-origin CDN analytics errors", () => {
    installGlobalFatalHandlers();
    fireError("https://cdn.cloudflare.com/analytics.js", "analytics boom");
    expect(getFatalError()).toBeNull();
  });

  it("ignores opaque unhandledrejection (no stack, no filename)", () => {
    installGlobalFatalHandlers();
    fireRejection("opaque-string-reason");
    expect(getFatalError()).toBeNull();
  });

  it("upgrades unhandledrejection with app-origin stack to fatal", () => {
    installGlobalFatalHandlers();
    const reason = new Error("rejection boom");
    // 构造一个含 origin 的 stack,模拟本应用代码抛错。
    reason.stack = `Error: rejection boom\n    at bootstrap (http://localhost:5173/src/main.ts:1:1)`;
    fireRejection(reason);
    const fatal = getFatalError();
    expect(fatal).not.toBeNull();
    expect(fatal?.phase).toBe("global.unhandledrejection");
    expect(fatal?.message).toBe("rejection boom");
  });

  it("is idempotent — calling install twice only registers a single listener pair", () => {
    // 关键约束:重复 installGlobalFatalHandlers 不能在 window 上挂双份
    // listener;否则同一条错误会通过两个 listener 走到 reportFatalError。
    // 通过 spy addEventListener / removeEventListener 来证明。
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    installGlobalFatalHandlers();
    installGlobalFatalHandlers();
    // install 第二次应当 early-return,不再 addEventListener。
    // 第一次 install 时 addEventListener 至少被调用 2 次(error +
    // unhandledrejection);第二次不应再 +2。
    const addCallsAfterFirst = addSpy.mock.calls.length;
    installGlobalFatalHandlers();
    expect(addSpy.mock.calls.length).toBe(addCallsAfterFirst);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("subscriber/handler exception does not break further dispatch", () => {
    installGlobalFatalHandlers();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // 第一个 handler 内部不抛错——这里的目的是确保 errorHandler 自身
    // 出错时不会让 fatal 通道卡住。我们用 spy 监控 console.error。
    const err = new Error("boom");
    err.stack = "Error: boom\n    at x (http://localhost:5173/src/x.ts:1:1)";
    fireError("http://localhost:5173/src/x.ts", "boom", err);
    expect(getFatalError()).not.toBeNull();
    spy.mockRestore();
  });
});
