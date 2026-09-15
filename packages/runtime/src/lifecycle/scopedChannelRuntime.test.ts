import { describe, expect, it, vi } from "vitest";
import type { ChannelRuntime } from "@keymaster/contracts";
import { createLifecycleScope } from "webloom-framework";
import { createScopedChannelRuntime } from "./scopedChannelRuntime.js";

function createBaseRuntime() {
  const publicHandlers = new Set<(event: { channel: string; publisherPublicKeyHex: string; messageId: string; content: null }) => void>();
  const privateHandlers = new Set<(event: { channel: string; publisherPublicKeyHex: string; messageId: string; protocol: string; content: null }) => void>();
  const statusHandlers = new Set<(status: { channel: string; phase: "idle"; errorCode: null; errorMessage: null; updatedAtMs: number }) => void>();
  const subscriptionSet = vi.fn(async (channels: string[]) => ({ channels }));
  const base: ChannelRuntime = {
    isReady: () => true,
    publish: vi.fn(async () => ({ messageId: "message-1" })),
    publishPrivate: vi.fn(async () => ({ messageId: "message-2" })),
    subscriptionSet,
    subscriptionStatus: (channel) => ({ channel, phase: "idle", errorCode: null, errorMessage: null, updatedAtMs: 0 }),
    subscribeSubscriptionStatus: vi.fn((handler) => {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    }),
    subscribe: vi.fn((handler) => {
      publicHandlers.add(handler);
      return () => publicHandlers.delete(handler);
    }),
    subscribePrivate: vi.fn((handler) => {
      privateHandlers.add(handler);
      return () => privateHandlers.delete(handler);
    }),
  };
  return { base, publicHandlers, privateHandlers, statusHandlers, subscriptionSet };
}

describe("createScopedChannelRuntime", () => {
  it("撤权时同步隐藏回调，并阻止旧实例继续接收事件", async () => {
    const scope = createLifecycleScope({ kind: "plugin-instance" });
    const { base, publicHandlers } = createBaseRuntime();
    const runtime = createScopedChannelRuntime(base, scope);
    const handler = vi.fn();

    runtime.subscribe(handler);
    for (const callback of publicHandlers) callback({ channel: "topic", publisherPublicKeyHex: "02", messageId: "1", content: null });
    expect(handler).toHaveBeenCalledTimes(1);

    scope.revoke("plugin disabled");
    expect(publicHandlers.size).toBe(0);
    for (const callback of publicHandlers) callback({ channel: "topic", publisherPublicKeyHex: "02", messageId: "2", content: null });
    expect(handler).toHaveBeenCalledTimes(1);
    await scope.dispose();
  });

  it("把调用 signal 传到 Coordinator，并在撤权时提交一次空订阅", async () => {
    const scope = createLifecycleScope({ kind: "plugin-instance" });
    const { base, subscriptionSet } = createBaseRuntime();
    const runtime = createScopedChannelRuntime(base, scope);
    const callerController = new AbortController();

    await runtime.subscriptionSet(["topic"]);
    await runtime.publish({ channel: "topic", content: null }, callerController.signal);
    expect(base.publish).toHaveBeenCalledWith(
      { channel: "topic", content: null },
      expect.any(AbortSignal),
    );

    scope.revoke("page closed");
    expect(base.subscriptionSet).toHaveBeenCalledTimes(2);
    expect(base.subscriptionSet).toHaveBeenLastCalledWith([]);
    await scope.dispose();
    expect(base.subscriptionSet).toHaveBeenCalledTimes(2);
  });

  it("清空后重新订阅会建立新的释放 generation", async () => {
    const scope = createLifecycleScope({ kind: "plugin-instance" });
    const { base, subscriptionSet } = createBaseRuntime();
    const runtime = createScopedChannelRuntime(base, scope);

    await runtime.subscriptionSet(["a"]);
    await runtime.subscriptionSet([]);
    await runtime.subscriptionSet(["b"]);
    scope.revoke("owner changed");
    await scope.dispose();

    expect(subscriptionSet.mock.calls.map(([channels]) => channels)).toEqual([
      ["a"],
      [],
      ["b"],
      []
    ]);
  });

  it("清理失败后不会永久缓存 rejected Promise", async () => {
    const scope = createLifecycleScope({ kind: "plugin-instance" });
    const { base, subscriptionSet } = createBaseRuntime();
    let emptyCalls = 0;
    subscriptionSet.mockImplementation(async (channels) => {
      if (channels.length === 0 && emptyCalls++ === 0) throw new Error("temporary cleanup failure");
      return { channels };
    });
    const runtime = createScopedChannelRuntime(base, scope);

    await runtime.subscriptionSet(["topic"]);
    scope.revoke("owner changed");
    await scope.dispose();

    expect(subscriptionSet.mock.calls.filter(([channels]) => channels.length === 0)).toHaveLength(2);
  });

  it("撤权时解除物理订阅状态监听并丢弃迟到状态", async () => {
    const scope = createLifecycleScope({ kind: "plugin-instance" });
    const { base, statusHandlers } = createBaseRuntime();
    const runtime = createScopedChannelRuntime(base, scope);
    const received: string[] = [];
    runtime.subscribeSubscriptionStatus((status) => received.push(status.phase));
    for (const handler of statusHandlers) handler({ channel: "topic", phase: "idle", errorCode: null, errorMessage: null, updatedAtMs: 1 });
    expect(received).toEqual(["idle"]);
    scope.revoke("owner changed");
    expect(statusHandlers.size).toBe(0);
    for (const handler of statusHandlers) handler({ channel: "topic", phase: "idle", errorCode: null, errorMessage: null, updatedAtMs: 2 });
    expect(received).toEqual(["idle"]);
    await scope.dispose();
  });

  it("未建立订阅时不会为了 dispose 重新创建一个空 caller", async () => {
    const scope = createLifecycleScope({ kind: "plugin-instance" });
    const { base } = createBaseRuntime();
    const runtime = createScopedChannelRuntime(base, scope);

    await runtime.subscriptionSet([]);
    await scope.dispose();
    expect(base.subscriptionSet).not.toHaveBeenCalled();
  });

  it("撤权后只允许旧 teardown 释放订阅，不允许重新订阅", async () => {
    const scope = createLifecycleScope({ kind: "plugin-instance" });
    const { base } = createBaseRuntime();
    const runtime = createScopedChannelRuntime(base, scope);

    await runtime.subscriptionSet(["topic"]);
    scope.revoke("owner changed");
    await expect(runtime.subscriptionSet(["other"])).rejects.toThrow("revoked");
    await expect(runtime.subscriptionSet([])).resolves.toEqual({ channels: [] });
    await scope.dispose();
  });
});
