import { describe, expect, it, vi } from "vitest";
import { ChannelSubscriptionMux } from "./channelSubscriptionMux.js";

describe("ChannelSubscriptionMux", () => {
  it("保留逻辑订阅意图，并在物理订阅失败后重试", async () => {
    let shouldFail = true;
    const subscribe = vi.fn(async (_channel: string) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("temporary Supplier failure");
      }
    });
    const mux = new ChannelSubscriptionMux({
      driver: { subscribe, unsubscribe: vi.fn(async () => undefined) }
    });

    await expect(mux.set("app", ["topic"])).resolves.toEqual(["topic"]);
    expect(mux.callerChannels("app")).toEqual(["topic"]);
    expect(mux.physicalChannels()).toEqual([]);

    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(mux.physicalChannels()).toEqual(["topic"]);
  });

  it("物理退订失败不会被吞掉，并会按当前 union 重试", async () => {
    let shouldFail = true;
    const unsubscribe = vi.fn(async (_channel: string) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("temporary unsubscribe failure");
      }
    });
    const mux = new ChannelSubscriptionMux({
      driver: {
        subscribe: vi.fn(async () => undefined),
        unsubscribe
      }
    });

    await mux.set("app", ["topic"]);
    await mux.release("app");

    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(mux.callerChannels("app")).toEqual([]);
    expect(mux.physicalChannels()).toEqual([]);
  });

  it("同频道的新 caller 复用当前状态，并在退订失败后重新确认远端订阅", async () => {
    let shouldFailUnsubscribe = true;
    const subscribe = vi.fn(async () => undefined);
    const unsubscribe = vi.fn(async () => {
      if (shouldFailUnsubscribe) {
        shouldFailUnsubscribe = false;
        throw new Error("temporary unsubscribe failure");
      }
    });
    const mux = new ChannelSubscriptionMux({ driver: { subscribe, unsubscribe } });

    await mux.set("first", ["topic"]);
    await mux.set("second", ["topic"]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(mux.subscriptionStatus("topic")).toMatchObject({ phase: "subscribed" });

    await mux.release("first");
    await mux.release("second");
    expect(mux.subscriptionStatus("topic")).toMatchObject({ phase: "retrying", errorCode: "unknown_result" });

    await mux.set("second", ["topic"]);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(mux.subscriptionStatus("topic")).toMatchObject({ phase: "subscribed", errorCode: null, errorMessage: null });
  });

  it("退订进行中重新出现逻辑需求时不会丢掉重绑定", async () => {
    let resolveUnsubscribe: (() => void) | undefined;
    const subscribe = vi.fn(async () => undefined);
    const unsubscribe = vi.fn(() => new Promise<void>((resolve) => {
      resolveUnsubscribe = resolve;
    }));
    const mux = new ChannelSubscriptionMux({ driver: { subscribe, unsubscribe } });

    await mux.set("first", ["topic"]);
    const release = mux.release("first");
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));

    const rebind = mux.set("second", ["topic"]);
    expect(mux.subscriptionStatus("topic")).toMatchObject({ phase: "subscribing" });
    resolveUnsubscribe?.();
    await Promise.all([release, rebind]);

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(mux.callerChannels("second")).toEqual(["topic"]);
    expect(mux.physicalChannels()).toEqual(["topic"]);
    expect(mux.subscriptionStatus("topic")).toMatchObject({ phase: "subscribed" });
  });

  it("透传稳定业务错误并在下一次物理成功后清除错误", async () => {
    let shouldFail = true;
    const statusEvents: Array<{ phase: string; errorCode: string | null; errorMessage: string | null }> = [];
    const mux = new ChannelSubscriptionMux({
      driver: {
        subscribe: vi.fn(async () => {
          if (shouldFail) {
            shouldFail = false;
            const error = new Error(`${"x".repeat(600)}\nstack`) as Error & { code: string };
            error.code = "balance";
            throw error;
          }
        }),
        unsubscribe: vi.fn(async () => undefined)
      }
    });
    mux.subscribeSubscriptionStatus((status) => statusEvents.push({
      phase: status.phase,
      errorCode: status.errorCode,
      errorMessage: status.errorMessage
    }));

    await expect(mux.set("app", ["topic"])).resolves.toEqual(["topic"]);
    expect(mux.subscriptionStatus("topic")).toMatchObject({ phase: "blocked", errorCode: "balance" });
    expect(mux.subscriptionStatus("topic").errorMessage).toHaveLength(512);
    expect(statusEvents.some((event) => event.phase === "blocked" && event.errorCode === "balance")).toBe(true);

    await mux.set("app", ["topic"]);
    expect(mux.subscriptionStatus("topic")).toMatchObject({ phase: "subscribed", errorCode: null, errorMessage: null });
    await mux.release("app");
    expect(mux.subscriptionStatus("topic")).toMatchObject({ phase: "idle", errorCode: null, errorMessage: null });
  });

  it("拒绝通配符和非法频道查询", () => {
    const mux = new ChannelSubscriptionMux({ driver: { subscribe: vi.fn(), unsubscribe: vi.fn() } });
    expect(() => mux.subscriptionStatus("*")).toThrow();
    expect(() => mux.subscriptionStatus("\u0000bad")).toThrow();
  });

  it("释放后不保留 idle 快照，历史频道不会撑大 baseline", async () => {
    const mux = new ChannelSubscriptionMux({
      driver: {
        subscribe: vi.fn(async () => undefined),
        unsubscribe: vi.fn(async () => undefined),
      },
    });

    for (let index = 0; index < 2_049; index += 1) {
      const channel = `historical-${index}`;
      const callerId = `caller-${index}`;
      await mux.set(callerId, [channel]);
      await mux.release(callerId);
    }

    expect(mux.subscriptionStatuses()).toEqual([]);
  });
});
