// packages/plugin-bsv-price/src/bsvPriceService.test.ts
// BSV Price service 动态订阅测试。
//
// 关键不变量：
//   - 首次启动优先读 localStorage；
//   - localStorage 为空时才用 seed；
//   - 保存成功后立即切换到新频道；
//   - 清空配置会取消订阅并回到 not_configured；
//   - 旧频道消息不会在切换后继续污染当前快照。

import { beforeEach, describe, expect, it } from "vitest";
import type {
  BroadcastCore,
  BroadcastMessage,
  BroadcastSubscribeInput,
  BroadcastUnsubscribe
} from "@keymaster/contracts";
import { PRICECAST_PROTOCOL_ID, buildPriceChannelId } from "./constants.js";
import { createBsvPriceService } from "./bsvPriceService.js";

class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

class FakeBroadcastCore implements BroadcastCore {
  subscribeCalls: BroadcastSubscribeInput[] = [];
  private messageHandlers = new Set<(msg: BroadcastMessage) => void>();
  private stateHandlers = new Set<() => void>();
  private snapshotState: "idle" | "connecting" | "bound" | "closed" = "bound";
  private lastError: string | null = null;
  private activeProviderId: string | null = "fake-provider";

  providers(): never {
    throw new Error("not used");
  }
  async connectForOwner(): Promise<never> {
    throw new Error("not used");
  }
  async disconnect(): Promise<void> {}
  markStructurallyOffline(): void {}
  setNextReconnectAtMs(): void {}
  getNextReconnectAtMs(): null {
    return null;
  }
  isReady(): boolean {
    return true;
  }
  async publish(): Promise<BroadcastMessage> {
    throw new Error("not used");
  }
  subscribe(input: BroadcastSubscribeInput): BroadcastUnsubscribe {
    this.subscribeCalls.push(input);
    this.messageHandlers.add(input.handler);
    return () => {
      this.messageHandlers.delete(input.handler);
    };
  }
  listSubscribedChannels(): string[] {
    return [...new Set(this.subscribeCalls.flatMap((x) => [...x.channelIds]))];
  }
  inspect() {
    return {
      state: this.snapshotState,
      providerId: this.activeProviderId,
      ownerPublicKeyHex: "02".padEnd(66, "a"),
      lastError: this.lastError,
      subscribedChannels: this.listSubscribedChannels(),
      nextReconnectAtMs: null
    };
  }
  onStateChange(handler: () => void): BroadcastUnsubscribe {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }
  currentHandle(): null {
    return null;
  }
  setActiveProviderId(): Promise<void> {
    return Promise.resolve();
  }
  getActiveProviderId(): string | null {
    return this.activeProviderId;
  }

  emit(msg: BroadcastMessage): void {
    for (const handler of this.messageHandlers) {
      handler(msg);
    }
  }

  setState(
    state: "idle" | "connecting" | "bound" | "closed",
    lastError: string | null = null
  ): void {
    this.snapshotState = state;
    this.lastError = lastError;
    for (const handler of this.stateHandlers) {
      handler();
    }
  }
}

beforeEach(() => {
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});

function makeMessage(channelId: string, price = "100.00"): BroadcastMessage {
  return {
    channelId,
    protocolId: PRICECAST_PROTOCOL_ID,
    clientMessageId: "m1",
    createdAtMs: 1000,
    bodyBytes: new TextEncoder().encode(
      JSON.stringify({ quotes: [{ exchange: "gate", price }] })
    ),
    publisherPublicKeyHex: "02".padEnd(66, "a")
  };
}

describe("createBsvPriceService", () => {
  it("starts from stored config and subscribes exact channel", () => {
    const ls = new FakeStorage();
    ls.setItem(
      "bsv-price.settings",
      JSON.stringify({
        pricePublisherPublicKeyHex:
          "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        savedAtMs: 1
      })
    );
    const core = new FakeBroadcastCore();
    const service = createBsvPriceService(core, {
      localStorage: ls,
      seedPublisherPublicKeyHex:
        "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });

    expect(service.configured()).toBe(true);
    expect(service.getPublisherPublicKeyHex()).toBe(
      "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    expect(core.subscribeCalls).toHaveLength(1);
    expect(core.subscribeCalls[0]?.channelIds).toEqual([
      buildPriceChannelId(
        "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      )
    ]);
  });

  it("seed is used when localStorage is empty and then persisted", () => {
    const ls = new FakeStorage();
    const core = new FakeBroadcastCore();
    const service = createBsvPriceService(core, {
      localStorage: ls,
      seedPublisherPublicKeyHex:
        "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });

    expect(service.getPublisherPublicKeyHex()).toBe(
      "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    expect(JSON.parse(ls.getItem("bsv-price.settings") ?? "{}")).toMatchObject({
      pricePublisherPublicKeyHex:
        "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });
  });

  it("save rebinds to the new channel and clears stale snapshot", () => {
    const ls = new FakeStorage();
    const core = new FakeBroadcastCore();
    const service = createBsvPriceService(core, {
      localStorage: ls,
      seedPublisherPublicKeyHex:
        "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    core.emit(
      makeMessage(
        buildPriceChannelId(
          "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ),
        "100.01"
      )
    );
    expect(service.snapshot().snapshot?.quotes[0]?.price).toBe("100.01");

    service.savePublisherPublicKeyHex(
      "03cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    );

    expect(service.getPublisherPublicKeyHex()).toBe(
      "03cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    );
    expect(service.snapshot().snapshot).toBeNull();
    expect(service.snapshot().lastError).toBeNull();
    expect(core.subscribeCalls).toHaveLength(2);
    expect(core.subscribeCalls[1]?.channelIds).toEqual([
      buildPriceChannelId(
        "03cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      )
    ]);

    core.emit(
      makeMessage(
        buildPriceChannelId(
          "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ),
        "999.99"
      )
    );
    expect(service.snapshot().snapshot).toBeNull();

    core.emit(
      makeMessage(
        buildPriceChannelId(
          "03cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        ),
        "101.23"
      )
    );
    expect(service.snapshot().snapshot?.quotes[0]?.price).toBe("101.23");
  });

  it("saving empty string clears the subscription and enters not_configured", () => {
    const core = new FakeBroadcastCore();
    const service = createBsvPriceService(core, {
      localStorage: new FakeStorage(),
      seedPublisherPublicKeyHex:
        "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    service.savePublisherPublicKeyHex("");

    expect(service.configured()).toBe(false);
    expect(service.snapshot().status).toBe("not_configured");
    expect(service.snapshot().channelId).toBe("(not configured)");
    expect(core.subscribeCalls).toHaveLength(1);
  });

  it("invalid save throws and keeps current config", () => {
    const core = new FakeBroadcastCore();
    const service = createBsvPriceService(core, {
      localStorage: new FakeStorage(),
      seedPublisherPublicKeyHex:
        "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(() => service.savePublisherPublicKeyHex("bad")).toThrow("invalid_length");
    expect(service.getPublisherPublicKeyHex()).toBe(
      "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });
});
