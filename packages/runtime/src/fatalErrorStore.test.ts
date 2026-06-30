// packages/runtime/src/fatalErrorStore.test.ts
// 共享 fatal store 的关键不变量测试（施工单 2026-06-30 001）。
//
// 覆盖：
//   1. 首次 report 生效并通知订阅者。
//   2. 重复 report 不反复覆盖当前 fatal；仅追加到 tail。
//   3. subscribe 正常通知（同步 + 二次 subscribe 立即看到当前值）。
//   4. 订阅者抛错不影响其它订阅者。
//   5. resetFatalErrorForTest 重置后,新的 report 重新生效。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFatalError,
  getFatalTail,
  reportFatalError,
  resetFatalErrorForTest,
  subscribeFatalError,
  type FatalErrorSnapshot
} from "./fatalErrorStore.js";

beforeEach(() => {
  resetFatalErrorForTest();
});

afterEach(() => {
  resetFatalErrorForTest();
});

describe("fatalErrorStore: first-wins semantics", () => {
  it("first report takes effect and notifies subscribers", () => {
    const seen: FatalErrorSnapshot[] = [];
    const unsub = subscribeFatalError((s) => {
      seen.push(s);
    });
    const first = reportFatalError({
      phase: "vault.bootstrap",
      scope: "vault-service",
      message: "boom"
    });
    expect(getFatalError()?.id).toBe(first.id);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe("boom");
    expect(seen[0]?.phase).toBe("vault.bootstrap");
    unsub();
  });

  it("subsequent reports do not overwrite the current fatal, only append to tail", () => {
    const seen: FatalErrorSnapshot[] = [];
    subscribeFatalError((s) => seen.push(s));
    const first = reportFatalError({
      phase: "vault.bootstrap",
      scope: "vault-service",
      message: "first"
    });
    const second = reportFatalError({
      phase: "react.render",
      scope: "app-root",
      message: "second"
    });
    // 订阅者只被通知一次。
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe(first.id);
    // 当前 fatal 仍是第一条。
    expect(getFatalError()?.id).toBe(first.id);
    expect(getFatalError()?.message).toBe("first");
    // 第二条进入 tail。
    expect(getFatalTail()).toHaveLength(1);
    expect(getFatalTail()[0]?.id).toBe(second.id);
    expect(getFatalTail()[0]?.message).toBe("second");
  });

  it("newly subscribed listener receives current fatal immediately", () => {
    const first = reportFatalError({
      phase: "pre-bootstrap.plugins",
      scope: "app-root",
      message: "boot-failed"
    });
    const seen: FatalErrorSnapshot[] = [];
    subscribeFatalError((s) => seen.push(s));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe(first.id);
  });

  it("subscriber throwing does not block other subscribers", () => {
    const seen: FatalErrorSnapshot[] = [];
    subscribeFatalError(() => {
      throw new Error("subscriber-bomb");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen2: FatalErrorSnapshot[] = [];
    subscribeFatalError((s) => seen2.push(s));
    reportFatalError({
      phase: "global.error",
      scope: "browser",
      message: "boom"
    });
    // 第二个订阅者仍被通知；第一个的 throw 走 console.error。
    expect(seen2).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("resetFatalErrorForTest lets a new report take effect again", () => {
    // 第一阶段：旧 fatal 上报。
    const seen: FatalErrorSnapshot[] = [];
    subscribeFatalError((s) => seen.push(s));
    reportFatalError({
      phase: "vault.bootstrap",
      scope: "vault-service",
      message: "old"
    });
    expect(seen).toHaveLength(1);
    // reset 会同时清掉 listeners 与当前/历史 fatal；测试夹具用同一份
    // listener 看不到 reset 之后的事件，是预期行为。
    resetFatalErrorForTest();
    expect(getFatalError()).toBeNull();
    expect(getFatalTail()).toHaveLength(0);
    // 第二阶段：重新订阅 + 新 fatal 上报,新的 listener 应当收到事件。
    const seen2: FatalErrorSnapshot[] = [];
    subscribeFatalError((s) => seen2.push(s));
    reportFatalError({
      phase: "vault.bootstrap",
      scope: "vault-service",
      message: "new"
    });
    expect(seen2).toHaveLength(1);
    expect(getFatalError()?.message).toBe("new");
  });

  it("normalizes message and stack from cause Error", () => {
    const err = new Error("decrypt failed");
    const snap = reportFatalError({
      phase: "vault.persist",
      scope: "vault-service",
      message: err.message,
      cause: err
    });
    expect(snap.message).toBe("decrypt failed");
    // stack 来自 cause。
    expect(snap.stack).toContain("decrypt failed");
    expect(snap.cause).toBe(err);
  });

  it("unsub stops receiving new fatals after reset", () => {
    const seen: FatalErrorSnapshot[] = [];
    const unsub = subscribeFatalError((s) => seen.push(s));
    reportFatalError({
      phase: "vault.bootstrap",
      scope: "vault-service",
      message: "first"
    });
    expect(seen).toHaveLength(1);
    unsub();
    resetFatalErrorForTest();
    reportFatalError({
      phase: "vault.bootstrap",
      scope: "vault-service",
      message: "second"
    });
    expect(seen).toHaveLength(1);
  });
});
