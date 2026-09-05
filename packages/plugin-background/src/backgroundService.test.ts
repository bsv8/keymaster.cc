// packages/plugin-background/src/backgroundService.test.ts
// 后台任务平台单测：
//   - runNow/trigger 不并发：同 task id 第二次 trigger 合并为 rerun。
//   - cancel abort 当前运行并等待旧实例退出。
//   - canRun 返回 blocked 时任务进入 blocked 状态。
//   - 失败后自动回到 idle，保留错误信息。
//   - interval 触发不会补跑。
//
// 施工单 002：删除 leader 选举测试，由 Coordinator 统一管理。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundRunEligibility } from "@keymaster/contracts";
import { createBackgroundBundle } from "./backgroundService.js";

beforeEach(() => {
  localStorage.removeItem("background.enabled");
  localStorage.removeItem("background.sync.settings");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BackgroundService basics", () => {
  it("does not run the same task concurrently", async () => {
    const { service, registry } = createBackgroundBundle();
    let concurrent = 0;
    let maxConcurrent = 0;
    registry.register({
      id: "t1",
      pluginId: "test",
      label: "t1",
      async run() {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent -= 1;
      }
    });
    service.runNow("t1");
    service.runNow("t1");
    service.runNow("t1");
    await new Promise((r) => setTimeout(r, 100));
    expect(maxConcurrent).toBe(1);
    service.dispose();
  });

  it("cancel awaits current run and returns to idle", async () => {
    const { service, registry } = createBackgroundBundle();
    let entered = false;
    let exited = false;
    let runs = 0;
    registry.register({
      id: "t2",
      pluginId: "test",
      label: "t2",
      async run(ctx) {
        runs += 1;
        entered = true;
        try {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 50);
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve();
            });
          });
        } finally {
          exited = true;
        }
      }
    });
    service.runNow("t2");
    await new Promise((r) => setTimeout(r, 5));
    expect(entered).toBe(true);
    expect(runs).toBe(1);
    await service.cancel("t2");
    expect(exited).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toBe(1);
    const snap = service.listTaskSnapshots().find((s) => s.id === "t2")!;
    expect(snap.state).toBe("idle");
    service.dispose();
  });

  it("canRun returning blocked sets blocked state", async () => {
    const { service, registry } = createBackgroundBundle();
    registry.register({
      id: "t3",
      pluginId: "test",
      label: "t3",
      canRun: () => ({ ready: false, reason: { key: "test.blocked", fallback: "Test blocked" }, retryOn: "unlock" }),
      async run() {
        throw new Error("should not run");
      }
    });
    service.runNow("t3");
    await new Promise((r) => setTimeout(r, 5));
    const snap = service.listTaskSnapshots().find((s) => s.id === "t3")!;
    expect(snap.state).toBe("blocked");
    expect(snap.blockedReason).toEqual({ key: "test.blocked", fallback: "Test blocked" });
    service.dispose();
  });

  it("failed task returns to idle with error preserved", async () => {
    const { service, registry } = createBackgroundBundle();
    let runs = 0;
    registry.register({
      id: "t4",
      pluginId: "test",
      label: "t4",
      async run() {
        runs += 1;
        throw new Error("boom");
      }
    });
    service.runNow("t4");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(1);
    const snap = service.listTaskSnapshots().find((s) => s.id === "t4")!;
    // 施工单 001：失败不是稳态，自动回到 idle
    expect(snap.state).toBe("idle");
    expect(snap.error).toBe("boom");
    // 可以再次 runNow
    service.runNow("t4");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(2);
    service.dispose();
  });

  it("runNow bypasses cooldown", async () => {
    const { service, registry } = createBackgroundBundle();
    let runs = 0;
    registry.register({
      id: "t5",
      pluginId: "test",
      label: "t5",
      async run() {
        runs += 1;
      }
    });
    // 第一次运行
    service.runNow("t5");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(1);
    // 立即再次运行：runNow 应该绕过冷却
    service.runNow("t5");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(2);
    service.dispose();
  });

  it("cancel during queued state returns to idle", async () => {
    const { service, registry } = createBackgroundBundle();
    let runs = 0;
    registry.register({
      id: "t6",
      pluginId: "test",
      label: "t6",
      async run() {
        runs += 1;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    // 触发第一次运行
    service.runNow("t6");
    await new Promise((r) => setTimeout(r, 5));
    // 再次触发：会标记 rerunRequested
    service.runNow("t6");
    await new Promise((r) => setTimeout(r, 5));
    // 取消：应清除 rerunRequested
    await service.cancel("t6");
    await new Promise((r) => setTimeout(r, 150));
    // 只运行了一次
    expect(runs).toBe(1);
    const snap = service.listTaskSnapshots().find((s) => s.id === "t6")!;
    expect(snap.state).toBe("idle");
    service.dispose();
  });
});


describe("BackgroundService cancel semantics", () => {
  it("任务正常 resolve 前 signal 被 abort：状态为 idle，lastCompletedAt 不更新", async () => {
    const { service, registry } = createBackgroundBundle();
    let resolveRun: (() => void) | undefined;
    registry.register({
      id: "t-cancel-resolve",
      pluginId: "test",
      label: "t-cancel-resolve",
      async run(ctx) {
        // 任务内部在 abort 后仍正常 resolve（模拟业务层返回 cancelled）
        await new Promise<void>((resolve) => {
          resolveRun = resolve;
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    });
    service.runNow("t-cancel-resolve");
    await new Promise((r) => setTimeout(r, 5));
    // 任务正在运行中
    const snapRunning = service.listTaskSnapshots().find((s) => s.id === "t-cancel-resolve")!;
    expect(snapRunning.state).toBe("running");
    const startedAt = snapRunning.lastStartedAt;

    // 取消：abort signal，但 run() 内部 abort listener 会 resolve（不抛错）
    await service.cancel("t-cancel-resolve");

    const snapAfter = service.listTaskSnapshots().find((s) => s.id === "t-cancel-resolve")!;
    // 关键断言：状态应为 idle，不是 failed
    expect(snapAfter.state).toBe("idle");
    // 关键断言：lastCompletedAt 不应被更新——取消不是"完成"
    expect(snapAfter.lastCompletedAt).toBeUndefined();
    // lastStartedAt 保持不变
    expect(snapAfter.lastStartedAt).toBe(startedAt);
    service.dispose();
  });

  it("任务 run() 抛错前 signal 已 abort：走取消分支而非 failed", async () => {
    const { service, registry } = createBackgroundBundle();
    let rejectRun: ((err: Error) => void) | undefined;
    registry.register({
      id: "t-cancel-throw",
      pluginId: "test",
      label: "t-cancel-throw",
      async run(ctx) {
        await new Promise<void>((_resolve, reject) => {
          rejectRun = reject;
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    });
    service.runNow("t-cancel-throw");
    await new Promise((r) => setTimeout(r, 5));

    // cancel 触发 abort → run() 抛出 AbortError
    await service.cancel("t-cancel-throw");

    const snap = service.listTaskSnapshots().find((s) => s.id === "t-cancel-throw")!;
    // 走取消分支，不是 failed
    expect(snap.state).toBe("idle");
    expect(snap.error).toBeUndefined();
    expect(snap.lastCompletedAt).toBeUndefined();
    service.dispose();
  });
});

describe("BackgroundService hard switch", () => {
  it("不读取也不删除旧的 background.enabled 偏好", () => {
    // 新统一存储路径不读取、不迁移旧浏览器键。
    localStorage.setItem("background.enabled", JSON.stringify({ "task1": false, "task2": true }));
    const { service, registry } = createBackgroundBundle();
    expect(localStorage.getItem("background.enabled")).toBe(JSON.stringify({ "task1": false, "task2": true }));
    // 所有任务默认持续启用
    registry.register({
      id: "task1",
      pluginId: "test",
      label: "task1",
      async run() {}
    });
    const snap = service.listTaskSnapshots().find((s) => s.id === "task1")!;
    expect(snap.state).toBe("idle");
    service.dispose();
  });
});

describe("BackgroundService trigger vs runNow", () => {
  it("普通 trigger 受冷却控制，runNow 绕过冷却", async () => {
    const { service, registry } = createBackgroundBundle();
    let runs = 0;
    registry.register({
      id: "t-cooldown",
      pluginId: "test",
      label: "t-cooldown",
      intervalMs: 60_000,
      async run() {
        runs += 1;
      }
    });

    // 第一次运行
    service.trigger("t-cooldown", "interval");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(1);

    // 立即再次 trigger：应被冷却阻止
    service.trigger("t-cooldown", "interval");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(1);

    // runNow 应绕过冷却
    service.runNow("t-cooldown");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(2);

    service.dispose();
  });

  it("领域事件 trigger 使用普通冷却", async () => {
    const { service, registry } = createBackgroundBundle();
    let runs = 0;
    registry.register({
      id: "t-domain",
      pluginId: "test",
      label: "t-domain",
      intervalMs: 60_000,
      async run() {
        runs += 1;
      }
    });

    // 第一次运行
    service.trigger("t-domain", "resource-ready");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(1);

    // 立即再次 trigger：应被冷却阻止
    service.trigger("t-domain", "settings-change");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(1);

    // runNow 应绕过冷却
    service.runNow("t-domain");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(2);

    service.dispose();
  });
});

describe("BackgroundService blocked task recheck", () => {
  it("blocked 任务到期后重新检查 eligibility", async () => {
    vi.useFakeTimers();
    const { service, registry } = createBackgroundBundle();
    let runs = 0;
    let canRunResult: BackgroundRunEligibility = { ready: false, reason: { key: "test.blocked", fallback: "Test blocked" }, retryOn: "interval" };
    registry.register({
      id: "t-blocked-recheck",
      pluginId: "test",
      label: "t-blocked-recheck",
      intervalMs: 60_000,
      canRun: () => canRunResult,
      async run() {
        runs += 1;
      }
    });

    // 触发任务：应进入 blocked 状态
    service.runNow("t-blocked-recheck");
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toBe(0);
    const snap1 = service.listTaskSnapshots().find((s) => s.id === "t-blocked-recheck")!;
    expect(snap1.state).toBe("blocked");

    // 1 分钟后：仍在 blocked
    await vi.advanceTimersByTimeAsync(60_000);
    const snap2 = service.listTaskSnapshots().find((s) => s.id === "t-blocked-recheck")!;
    expect(snap2.state).toBe("blocked");

    // 修改 canRun 为 ready
    canRunResult = { ready: true };

    // 再过 1 分钟（总计 2 分钟）：应重新检查并运行
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(1);
    const snap3 = service.listTaskSnapshots().find((s) => s.id === "t-blocked-recheck")!;
    expect(snap3.state).toBe("idle");

    service.dispose();
    vi.useRealTimers();
  });
});

describe("BackgroundService cancel reschedules", () => {
  it("取消后 nextRunAt 和 lastScheduledAt 从取消时刻重新计算", async () => {
    vi.useFakeTimers();
    const { service, registry } = createBackgroundBundle();
    registry.register({
      id: "t-cancel-reschedule",
      pluginId: "test",
      label: "t-cancel-reschedule",
      intervalMs: 60_000,
      async run(ctx) {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
          // 永不主动完成
        });
      }
    });

    // 触发任务
    service.runNow("t-cancel-reschedule");
    await vi.advanceTimersByTimeAsync(10);

    // 快进 30 秒后取消
    await vi.advanceTimersByTimeAsync(30_000);
    await service.cancel("t-cancel-reschedule");

    const snap = service.listTaskSnapshots().find((s) => s.id === "t-cancel-reschedule")!;
    // nextRunAt 应该从取消时刻开始计算（60 秒后）
    const nextRun = new Date(snap.nextRunAt!).getTime();
    const now = Date.now();
    // 允许 1 秒误差
    expect(nextRun - now).toBeGreaterThanOrEqual(59_000);
    expect(nextRun - now).toBeLessThanOrEqual(61_000);

    service.dispose();
    vi.useRealTimers();
  });
});
