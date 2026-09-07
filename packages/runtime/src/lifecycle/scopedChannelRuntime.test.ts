import { describe, expect, it, vi } from "vitest";
import type { ChannelRuntime } from "@keymaster/contracts";
import { createLifecycleScope } from "./resourceScope.js";
import { createScopedChannelRuntime } from "./scopedChannelRuntime.js";

function createBaseRuntime() {
  const publicHandlers = new Set<(event: { channel: string; publisherPublicKeyHex: string; messageId: string; content: null }) => void>();
  const privateHandlers = new Set<(event: { channel: string; publisherPublicKeyHex: string; messageId: string; protocol: string; content: null }) => void>();
  const base: ChannelRuntime = {
    isReady: () => true,
    publish: vi.fn(async () => ({ messageId: "message-1" })),
    publishPrivate: vi.fn(async () => ({ messageId: "message-2" })),
    subscriptionSet: vi.fn(async (channels) => ({ channels })),
    subscribe: vi.fn((handler) => {
      publicHandlers.add(handler);
      return () => publicHandlers.delete(handler);
    }),
    subscribePrivate: vi.fn((handler) => {
      privateHandlers.add(handler);
      return () => privateHandlers.delete(handler);
    }),
  };
  return { base, publicHandlers, privateHandlers };
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
    const { base } = createBaseRuntime();
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
