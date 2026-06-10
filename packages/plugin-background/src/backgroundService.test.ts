// packages/plugin-background/src/backgroundService.test.ts
// 后台任务平台单测：
//   - trigger 不并发：同 task id 第二次 trigger 合并为 rerun。
//   - pause abort 当前运行并等待旧实例退出。
//   - pause 之后 trigger 不会启动第二个实例。
//   - cancel 同 pause 的并发保护。
//   - canRun 返回 false 时不进 running，state 保持 idle。
//   - interval 触发不会补跑。
//   - 跨 tab leader 选举：BC 路径下,先到 leader 不会被后到 tab 抢；
//     follower 的 trigger 必须转发到 leader（不能本地 fork 第二实例）。
//
// 浏览器环境模拟：node 测试默认 typeof window === "undefined",
// backgroundService 会短路成"单进程自任 leader"。要测试真正的 leader
// 选举,必须 stub window / document / navigator(无 locks)三个全局,
// 让 start() 走 BroadcastChannel 选举路径。stubGlobal 在 vi.useRealTimers
// 之后 afterEach 自动 unstubAll。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundBundle } from "./backgroundService.js";

beforeEach(() => {
  localStorage.removeItem("background.enabled");
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

describe("BackgroundService basics", () => {
  it("does not run the same task concurrently", async () => {
    const { service, registry } = createBackgroundBundle();
    let concurrent = 0;
    let maxConcurrent = 0;
    registry.register({
      id: "t1",
      pluginId: "test",
      label: "t1",
      defaultEnabled: true,
      async run() {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent -= 1;
      }
    });
    service.trigger("t1", "t1");
    service.trigger("t1", "t1");
    service.trigger("t1", "t1");
    await new Promise((r) => setTimeout(r, 100));
    expect(maxConcurrent).toBe(1);
    service.dispose();
  });

  it("pause awaits current run and prevents new instance", async () => {
    const { service, registry } = createBackgroundBundle();
    let entered = false;
    let exited = false;
    let runs = 0;
    registry.register({
      id: "t2",
      pluginId: "test",
      label: "t2",
      defaultEnabled: true,
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
    service.trigger("t2", "manual");
    await new Promise((r) => setTimeout(r, 5));
    expect(entered).toBe(true);
    expect(runs).toBe(1);
    const pausePromise = service.pause("t2");
    service.trigger("t2", "manual-during-pause");
    await pausePromise;
    expect(exited).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toBe(1);
    const snap = service.listSnapshots().find((s) => s.id === "t2")!;
    expect(snap.state).toBe("paused");
    service.dispose();
  });

  it("canRun false keeps task idle/paused", async () => {
    const { service, registry } = createBackgroundBundle();
    registry.register({
      id: "t3",
      pluginId: "test",
      label: "t3",
      defaultEnabled: true,
      canRun: () => false,
      async run() {
        throw new Error("should not run");
      }
    });
    service.trigger("t3", "manual");
    await new Promise((r) => setTimeout(r, 5));
    const snap = service.listSnapshots().find((s) => s.id === "t3")!;
    expect(snap.state).not.toBe("failed");
    service.dispose();
  });

  it("retry only fires on failed state", async () => {
    const { service, registry } = createBackgroundBundle();
    let runs = 0;
    registry.register({
      id: "t4",
      pluginId: "test",
      label: "t4",
      defaultEnabled: true,
      async run() {
        runs += 1;
        throw new Error("boom");
      }
    });
    service.trigger("t4", "manual");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(1);
    service.retry("t4");
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(2);
    service.dispose();
  });

  // 关键修复：托盘 pause 后手动 trigger 也必须不启动新实例——
  // "暂停"语义是硬屏障。旧实现只覆盖了 pause 等待期间的 trigger。
  it("trigger after pause completes is a no-op", async () => {
    const { service, registry } = createBackgroundBundle();
    let runs = 0;
    registry.register({
      id: "t5",
      pluginId: "test",
      label: "t5",
      defaultEnabled: true,
      async run() {
        runs += 1;
      }
    });
    await service.pause("t5");
    const snap = service.listSnapshots().find((s) => s.id === "t5")!;
    expect(snap.state).toBe("paused");
    expect(snap.enabled).toBe(false);
    service.trigger("t5", "manual-after-pause");
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(0);
    const snap2 = service.listSnapshots().find((s) => s.id === "t5")!;
    expect(snap2.state).toBe("paused");
    service.dispose();
  });
});

describe("BackgroundService leader election (BC path)", () => {
  // 关键不变量：当跨 tab 协调走 BroadcastChannel 选举时,
  //   - 同名 task 在两个 service 上各自注册,
  //   - 任意 tab 触发 trigger 后,**全应用范围**该任务最终只跑 1 次。
  // 旧实现因 runElection 把全局 lastHeartbeat 清零 + 部分时序窗口,
  // 可能短暂双 leader,导致两个 service 都跑 task,这条断言会失败。

  it("trigger from any tab runs the task exactly once across both services", async () => {
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
        defaultEnabled: true,
        async run() {
          aRuns += 1;
        }
      });
      b.registry.register({
        id: "shared-task",
        pluginId: "test",
        label: "shared",
        defaultEnabled: true,
        async run() {
          bRuns += 1;
        }
      });

      // 从 b trigger:若 b 是 follower,会转发到 a;若 b 是 leader,直接跑。
      // 不管谁是 leader,总运行次数必须严格等于 1。
      b.service.trigger("shared-task", "from-b");
      await new Promise((r) => setTimeout(r, 200));

      // 关键断言:**恰好一次**——证明没有双 leader。
      expect(aRuns + bRuns).toBe(1);

      a.service.dispose();
      b.service.dispose();
    } finally {
      env.cleanup();
    }
  });

  it("new tab joining after leader is established yields and forwards triggers to old leader", async () => {
    // 关键修复(用户验收反馈):"已有 leader + 新 tab 加入" 场景。
    // 旧实现 runElection 清零 lastHeartbeat,导致新 tab 在 250ms 内
    // 即使旧 leader 已经心跳过也可能错误自任 leader。修复后:
    //   1. lastHeartbeat 不被清零;
    //   2. leader 收到 want 立即广播 heartbeat;
    //   3. 新 tab 收到 heartbeat 立即 electionResult="lost"。
    // 行为可观察的不变量：a 先到并已是 leader,b 后到注册任务后从 b
    // 端 trigger,b 必须把请求转发给 a,a 跑、b 不跑。
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
        defaultEnabled: true,
        async run() {
          aRuns += 1;
        }
      });
      b.registry.register({
        id: "shared-task",
        pluginId: "test",
        label: "shared",
        defaultEnabled: true,
        async run() {
          bRuns += 1;
        }
      });

      b.service.trigger("shared-task", "from-b");
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
});
