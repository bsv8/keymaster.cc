// packages/plugin-background/src/backgroundService.test.ts
// 后台任务平台单测：
//   - runNow/trigger 不并发：同 task id 第二次 trigger 合并为 rerun。
//   - cancel abort 当前运行并等待旧实例退出。
//   - canRun 返回 blocked 时任务进入 blocked 状态。
//   - 失败后自动回到 idle，保留错误信息。
//   - interval 触发不会补跑。
//   - 跨 tab leader 选举：BC 路径下,先到 leader 不会被后到 tab 抢；
//     follower 的 runNow 必须转发到 leader（不能本地 fork 第二实例）。
//
// 浏览器环境模拟：node 测试默认 typeof window === "undefined",
// backgroundService 会短路成"单进程自任 leader"。要测试真正的 leader
// 选举,必须 stub window / document / navigator(无 locks)三个全局,
// 让 start() 走 BroadcastChannel 选举路径。stubGlobal 在 vi.useRealTimers
// 之后 afterEach 自动 unstubAll。

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

/**
 * 把 node 环境装扮成"浏览器但没有 Web Locks"——backgroundService
 * 在这种环境下会走 BroadcastChannel 选举路径,正好是我们要验证的。
 * 设计缘由：旧测试不 stub 这些,两个 service 都会直接 isLeader=true,
 * 选举逻辑根本没被覆盖,断言只能是软的"aRuns + bRuns ≥ 1"。
 */
function installFakeBrowserNoLocks() {
  const listeners: Array<() => void> = [];
  const win = {
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  const doc = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible" as const
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", {} as Navigator);
  return {
    cleanup() {
      for (const l of listeners) l();
      vi.unstubAllGlobals();
    }
  };
}

/** Web Locks 可用、但 BroadcastChannel 被运行时禁用的真实降级场景。 */
function installFakeBrowserWithLocksWithoutBroadcastChannel() {
  const listeners = new Map<string, Set<(event: StorageEvent) => void>>();
  let lockTaken = false;
  const win = {
    addEventListener(type: string, listener: (event: StorageEvent) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: StorageEvent) => void) {
      listeners.get(type)?.delete(listener);
    }
  };
  const doc = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible" as const
  };
  const locks = {
    request(_name: string, callback: () => Promise<unknown>) {
      if (!lockTaken) {
        lockTaken = true;
        return callback();
      }
      // 第二个 tab 作为 follower 保持排队，直到测试结束。
      return new Promise<undefined>(() => {});
    }
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { locks } as Navigator);
  vi.stubGlobal("BroadcastChannel", class {
    constructor() {
      throw new Error("BroadcastChannel unavailable");
    }
  });
  return {
    dispatchStorage(key: string, newValue: string) {
      for (const listener of listeners.get("storage") ?? []) {
        listener({ key, newValue } as StorageEvent);
      }
    },
    cleanup() {
      vi.unstubAllGlobals();
    }
  };
}

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
    const snap = service.listSnapshots().find((s) => s.id === "t2")!;
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
    const snap = service.listSnapshots().find((s) => s.id === "t3")!;
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
    const snap = service.listSnapshots().find((s) => s.id === "t4")!;
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
    const snap = service.listSnapshots().find((s) => s.id === "t6")!;
    expect(snap.state).toBe("idle");
    service.dispose();
  });
});

describe("BackgroundService leader election (BC path)", () => {
  // 关键不变量：当跨 tab 协调走 BroadcastChannel 选举时,
  //   - 同名 task 在两个 service 上各自注册,
  //   - 任意 tab 触发 runNow 后,**全应用范围**该任务最终只跑 1 次。
  // 旧实现因 runElection 把全局 lastHeartbeat 清零 + 部分时序窗口,
  // 可能短暂双 leader,导致两个 service 都跑 task,这条断言会失败。

  it("runNow from any tab runs the task exactly once across both services", async () => {
    const env = installFakeBrowserNoLocks();
    try {
      const a = createBackgroundBundle();
      const b = createBackgroundBundle();
      // 等两个 service 完成选举:每边 250ms,合起来给 600ms 缓冲。
      await new Promise((r) => setTimeout(r, 600));

      let aRuns = 0;
      let bRuns = 0;
      a.registry.register({
        id: "shared-task",
        pluginId: "test",
        label: "shared",
        async run() {
          aRuns += 1;
        }
      });
      b.registry.register({
        id: "shared-task",
        pluginId: "test",
        label: "shared",
        async run() {
          bRuns += 1;
        }
      });

      // 从 b runNow:若 b 是 follower,会转发到 a;若 b 是 leader,直接跑。
      // 不管谁是 leader,总运行次数必须严格等于 1。
      b.service.runNow("shared-task");
      await new Promise((r) => setTimeout(r, 200));

      // 关键断言:**恰好一次**——证明没有双 leader。
      expect(aRuns + bRuns).toBe(1);

      a.service.dispose();
      b.service.dispose();
    } finally {
      env.cleanup();
    }
  });

  it("new tab joining after leader is established yields and forwards runNow to old leader", async () => {
    // 关键修复(用户验收反馈):"已有 leader + 新 tab 加入" 场景。
    // 旧实现 runElection 清零 lastHeartbeat,导致新 tab 在 250ms 内
    // 即使旧 leader 已经心跳过也可能错误自任 leader。修复后:
    //   1. lastHeartbeat 不被清零;
    //   2. leader 收到 want 立即广播 heartbeat;
    //   3. 新 tab 收到 heartbeat 立即 electionResult="lost"。
    // 行为可观察的不变量：a 先到并已是 leader,b 后到注册任务后从 b
    // 端 runNow,b 必须把请求转发给 a,a 跑、b 不跑。
    const env = installFakeBrowserNoLocks();
    try {
      const a = createBackgroundBundle();
      // 等 a 完成选举并稳定为 leader（至少跨过一个选举窗口 + 一个心跳）。
      await new Promise((r) => setTimeout(r, 350));

      const b = createBackgroundBundle();
      // 等 b 的选举周期结束（250ms + 一点缓冲让 onMessage 处理完）。
      await new Promise((r) => setTimeout(r, 400));

      let aRuns = 0;
      let bRuns = 0;
      a.registry.register({
        id: "shared-task",
        pluginId: "test",
        label: "shared",
        async run() {
          aRuns += 1;
        }
      });
      b.registry.register({
        id: "shared-task",
        pluginId: "test",
        label: "shared",
        async run() {
          bRuns += 1;
        }
      });

      b.service.runNow("shared-task");
      await new Promise((r) => setTimeout(r, 200));

      // a 先成为 leader,b 必须认输并转发——a 跑、b 不跑是确定性结果。
      expect(aRuns).toBe(1);
      expect(bRuns).toBe(0);

      a.service.dispose();
      b.service.dispose();
    } finally {
      env.cleanup();
    }
  });

  it("replays a runNow sent before leader election finishes", async () => {
    const env = installFakeBrowserNoLocks();
    try {
      const a = createBackgroundBundle();
      const b = createBackgroundBundle();
      let aRuns = 0;
      let bRuns = 0;
      a.registry.register({
        id: "election-race-task",
        pluginId: "test",
        label: "race",
        async run() {
          aRuns += 1;
        }
      });
      b.registry.register({
        id: "election-race-task",
        pluginId: "test",
        label: "race",
        async run() {
          bRuns += 1;
        }
      });

      // 两个 tab 都还未成为 leader 时，旧实现会直接忽略这条 action。
      b.service.runNow("election-race-task");
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(aRuns + bRuns).toBe(1);
      a.service.dispose();
      b.service.dispose();
    } finally {
      env.cleanup();
    }
  });

  it("runs manual sync in the unlocked follower instead of a locked leader", async () => {
    const env = installFakeBrowserNoLocks();
    try {
      const leader = createBackgroundBundle();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const unlockedFollower = createBackgroundBundle();
      await new Promise((resolve) => setTimeout(resolve, 400));
      let leaderRuns = 0;
      let followerRuns = 0;
      leader.registry.register({
        id: "vault-session-task",
        pluginId: "test",
        label: "session",
        canRun: () => ({ ready: false, reason: { key: "background.blocked.unlock", fallback: "等待解锁" }, retryOn: "unlock" }),
        async run() {
          leaderRuns += 1;
        }
      });
      unlockedFollower.registry.register({
        id: "vault-session-task",
        pluginId: "test",
        label: "session",
        canRun: () => ({ ready: true }),
        async run() {
          followerRuns += 1;
        }
      });

      unlockedFollower.service.runNow("vault-session-task");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(followerRuns).toBe(1);
      expect(leaderRuns).toBe(0);
      leader.service.dispose();
      unlockedFollower.service.dispose();
    } finally {
      env.cleanup();
    }
  });
});

describe("BackgroundService action delivery fallback", () => {
  it("forwards runNow through the storage mailbox when Web Locks exist but BroadcastChannel does not", async () => {
    const env = installFakeBrowserWithLocksWithoutBroadcastChannel();
    try {
      const leader = createBackgroundBundle();
      const follower = createBackgroundBundle();
      let leaderRuns = 0;
      let followerRuns = 0;
      leader.registry.register({
        id: "shared-storage-task",
        pluginId: "test",
        label: "shared",
        async run() {
          leaderRuns += 1;
        }
      });
      follower.registry.register({
        id: "shared-storage-task",
        pluginId: "test",
        label: "shared",
        async run() {
          followerRuns += 1;
        }
      });

      follower.service.runNow("shared-storage-task");
      // runNow 先异步确认本 tab 是否具备 Vault 会话资格；无资格才写邮箱转发。
      await Promise.resolve();
      const actionKey = Array.from({ length: localStorage.length }, (_unused, index) => localStorage.key(index))
        .find((key) => key?.startsWith("background.leader.action."));
      expect(actionKey).toBeTruthy();
      env.dispatchStorage(actionKey!, localStorage.getItem(actionKey!)!);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(leaderRuns).toBe(1);
      expect(followerRuns).toBe(0);
      expect(localStorage.getItem(actionKey!)).toBeNull();
      leader.service.dispose();
      follower.service.dispose();
    } finally {
      env.cleanup();
    }
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
    const snapRunning = service.listSnapshots().find((s) => s.id === "t-cancel-resolve")!;
    expect(snapRunning.state).toBe("running");
    const startedAt = snapRunning.lastStartedAt;

    // 取消：abort signal，但 run() 内部 abort listener 会 resolve（不抛错）
    await service.cancel("t-cancel-resolve");

    const snapAfter = service.listSnapshots().find((s) => s.id === "t-cancel-resolve")!;
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

    const snap = service.listSnapshots().find((s) => s.id === "t-cancel-throw")!;
    // 走取消分支，不是 failed
    expect(snap.state).toBe("idle");
    expect(snap.error).toBeUndefined();
    expect(snap.lastCompletedAt).toBeUndefined();
    service.dispose();
  });
});

describe("BackgroundService migration", () => {
  it("清除旧的 background.enabled 偏好", () => {
    // 设置旧的 background.enabled
    localStorage.setItem("background.enabled", JSON.stringify({ "task1": false, "task2": true }));
    const { service, registry } = createBackgroundBundle();
    // 创建服务后，旧偏好应被清除
    expect(localStorage.getItem("background.enabled")).toBeNull();
    // 所有任务默认持续启用
    registry.register({
      id: "task1",
      pluginId: "test",
      label: "task1",
      async run() {}
    });
    const snap = service.listSnapshots().find((s) => s.id === "task1")!;
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
    const snap1 = service.listSnapshots().find((s) => s.id === "t-blocked-recheck")!;
    expect(snap1.state).toBe("blocked");

    // 1 分钟后：仍在 blocked
    await vi.advanceTimersByTimeAsync(60_000);
    const snap2 = service.listSnapshots().find((s) => s.id === "t-blocked-recheck")!;
    expect(snap2.state).toBe("blocked");

    // 修改 canRun 为 ready
    canRunResult = { ready: true };

    // 再过 1 分钟（总计 2 分钟）：应重新检查并运行
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(1);
    const snap3 = service.listSnapshots().find((s) => s.id === "t-blocked-recheck")!;
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

    const snap = service.listSnapshots().find((s) => s.id === "t-cancel-reschedule")!;
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
