// apps/web/src/fatalCrashPage.test.ts
// 统一崩溃页渲染器的 fallback 语义测试（施工单 2026-06-30 001 收口）。
//
// 关键不变量：
//   - 正常 snapshot -> 渲染完整页面(标题 / 摘要 / 动作按钮)。
//   - 渲染过程任一步抛错(createElement / appendChild / 等) -> 退回
//     到 <pre data-fatal-crash="fallback"> 而**不**让 caller 拿到
//     未捕获异常。
//   - 同 snapshot 重复调用 idempotent（不堆叠）。
//
// 测试环境：jsdom（因为要操作 DOM）。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FatalErrorSnapshot } from "@keymaster/runtime";
import { renderFatalCrashPage } from "./fatalCrashPage.js";

function snapshot(over: Partial<FatalErrorSnapshot> = {}): FatalErrorSnapshot {
  return {
    id: "snap-test",
    time: "2026-06-30T00:00:00.000Z",
    phase: "vault.bootstrap",
    scope: "vault-service",
    message: "boom",
    stack: "Error: boom\n    at x (y:1:1)",
    source: "app-bundle",
    ...over
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("renderFatalCrashPage", () => {
  it("renders the full DOM (title / description / refresh button)", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderFatalCrashPage(root, snapshot());
    expect(root.querySelector("[data-fatal-crash]")).not.toBeNull();
    expect(root.textContent ?? "").toContain("启动/运行失败");
    expect(root.textContent ?? "").toContain("boom");
    const button = root.querySelector("button");
    expect(button?.textContent).toBe("刷新页面");
  });

  it("falls back to <pre> when target.appendChild throws", () => {
    // 制造一个 appendChild 抛错的容器,模拟"container 被锁定 / 内部代理
    // 节点异常"等场景。整个渲染流程必须被外层 try/catch 兜住,fallback
    // 到最原始的 <pre data-fatal-crash="fallback">。
    const root = document.createElement("div");
    const realAppend = root.appendChild.bind(root);
    // 第一次 appendChild 抛错（wrap 那次），后续 fall-through 仍由
    // fallback 接管。
    root.appendChild = ((node: Node) => {
      if (node.nodeName === "SECTION") {
        throw new Error("appendChild-blocked");
      }
      return realAppend(node);
    }) as typeof root.appendChild;
    document.body.appendChild(root);
    // 关键:调用不应抛错。
    expect(() => renderFatalCrashPage(root, snapshot())).not.toThrow();
    // body 上应当出现 fallback <pre>。
    const fallback = document.body.querySelector(
      'pre[data-fatal-crash="fallback"]'
    );
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent ?? "").toContain("启动/运行失败");
    expect(fallback?.textContent ?? "").toContain("boom");
  });

  it("falls back to <pre> when createElement throws partway", () => {
    // 模拟渲染过程中 createElement 在中途抛错（例如浏览器环境极端
    // 异常）。重点验证：所有 buildDom 内部抛错都必须被外层 try/catch
    // 完整包住,而不是让 caller 拿到未捕获异常。
    const root = document.createElement("div");
    const realCreate = document.createElement.bind(document);
    let callCount = 0;
    document.createElement = ((tag: string, options?: ElementCreationOptions) => {
      callCount += 1;
      // 第 3 次 createElement 抛错:模拟 wrap / title / desc 中第 3 个节点失败。
      if (callCount === 3) {
        throw new Error("createElement-explode");
      }
      return realCreate(tag, options);
    }) as typeof document.createElement;
    try {
      expect(() => renderFatalCrashPage(root, snapshot())).not.toThrow();
      const fallback = document.body.querySelector(
        'pre[data-fatal-crash="fallback"]'
      );
      expect(fallback).not.toBeNull();
    } finally {
      document.createElement = realCreate;
    }
  });

  it("is idempotent — calling twice with same snapshot does not stack DOM", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const s = snapshot();
    renderFatalCrashPage(root, s);
    renderFatalCrashPage(root, s);
    // 仅一份 [data-fatal-crash]（idempotent：innerHTML="" 后重建）。
    expect(root.querySelectorAll("[data-fatal-crash]").length).toBe(1);
  });

  it("works with null container by falling back to body", () => {
    renderFatalCrashPage(null, snapshot());
    const onBody = document.body.querySelector("[data-fatal-crash]");
    expect(onBody).not.toBeNull();
  });

  it("renders without stack block when snapshot.stack is empty", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderFatalCrashPage(root, snapshot({ stack: "" }));
    // 没有 stack 块:页面只剩 wrap / title / desc / dl / button。
    // 不应有两个 <pre>(一个是 wrap 内的 stack pre,另一个是 fallback pre)，
    // 因为本路径不应走 fallback。
    expect(root.querySelectorAll("pre").length).toBe(0);
  });
});
