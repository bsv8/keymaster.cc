import { describe, expect, it } from "vitest";
import { PendingPingRegistry } from "./channelPendingPingRegistry.js";

interface TestPending {
  messageId: string;
  expiresAtMs: number;
  ownerPublicKeyHex: string;
}

describe("PendingPingRegistry", () => {
  it("accepts Pong before the network Publish promise settles", async () => {
    let now = 100;
    const registry = new PendingPingRegistry<TestPending>(4, () => now);
    registry.set({ messageId: "ping-1", expiresAtMs: 1_000, ownerPublicKeyHex: "owner-a" });

    let settlePublish!: () => void;
    const publish = new Promise<void>((resolve) => { settlePublish = resolve; });
    const pong = registry.take("ping-1", (pending) => pending.ownerPublicKeyHex === "owner-a");

    // 这里故意不 settle publish；Pong 先到也必须完成关系消费。
    expect(pong?.messageId).toBe("ping-1");
    expect(registry.size).toBe(0);
    settlePublish();
    await publish;
  });

  it("expires old entries and enforces a bounded FIFO capacity", () => {
    let now = 0;
    const registry = new PendingPingRegistry<TestPending>(2, () => now);
    registry.set({ messageId: "ping-1", expiresAtMs: 10, ownerPublicKeyHex: "owner-a" });
    registry.set({ messageId: "ping-2", expiresAtMs: 100, ownerPublicKeyHex: "owner-a" });
    registry.set({ messageId: "ping-3", expiresAtMs: 100, ownerPublicKeyHex: "owner-a" });
    expect(registry.get("ping-1")).toBeUndefined();
    expect(registry.size).toBe(2);
    now = 101;
    registry.prune();
    expect(registry.size).toBe(0);
  });
});

