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
    mux.release("app");

    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(mux.callerChannels("app")).toEqual([]);
    expect(mux.physicalChannels()).toEqual([]);
  });
});
