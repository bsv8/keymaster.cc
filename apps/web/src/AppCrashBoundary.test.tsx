// apps/web/src/AppCrashBoundary.test.tsx
// 顶级 React fatal boundary 的关键不变量测试（施工单 2026-06-30 001）。
//
// 覆盖：
//   1. 子组件 render 抛错 -> componentDidCatch 调 reportFatalError。
//   2. 已经在 fatal 状态时不再二次上报。
//   3. fallback 不渲染业务 UI（返回 null）。
//
// 测试环境：jsdom（vitest project = "jsdom"）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  getFatalError,
  reportFatalError,
  resetFatalErrorForTest
} from "@keymaster/runtime";
import { AppCrashBoundary } from "./AppCrashBoundary.js";

function Boom(): never {
  throw new Error("child-render-explode");
}

beforeEach(() => {
  resetFatalErrorForTest();
});

afterEach(() => {
  resetFatalErrorForTest();
});

describe("AppCrashBoundary", () => {
  it("reports fatal via store when child render throws", () => {
    expect(getFatalError()).toBeNull();
    render(
      <AppCrashBoundary>
        <Boom />
      </AppCrashBoundary>
    );
    const fatal = getFatalError();
    expect(fatal).not.toBeNull();
    expect(fatal?.phase).toBe("react.render");
    expect(fatal?.scope).toBe("app-root");
    expect(fatal?.message).toContain("child-render-explode");
  });

  it("does not re-report when fatal is already active", () => {
    // 先手动报告一次 fatal,模拟上游已经接管的状态。
    const first = reportFatalError({
      phase: "vault.bootstrap",
      scope: "vault-service",
      message: "earlier-fatal"
    });
    render(
      <AppCrashBoundary>
        <Boom />
      </AppCrashBoundary>
    );
    // 当前 fatal 仍是先报告的那条,没有被 AppCrashBoundary 覆盖。
    const fatal = getFatalError();
    expect(fatal?.id).toBe(first.id);
    expect(fatal?.message).toBe("earlier-fatal");
  });

  it("renders null in fallback (does not display complex React error UI)", () => {
    const { container } = render(
      <AppCrashBoundary>
        <Boom />
      </AppCrashBoundary>
    );
    // fallback 应该是 null,容器是空的(没有子 DOM)。
    expect(container.innerHTML).toBe("");
  });
});
