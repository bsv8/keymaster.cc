// BSV 价格服务的 Channel 精确订阅测试。

import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelMessageReceivedEventData, ChannelRuntime } from "@keymaster/contracts";
import { PRICECAST_PROTOCOL_ID, buildPriceChannelId } from "./constants.js";
import { createBsvPriceService } from "./bsvPriceService.js";

class FakeStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

class FakeChannel implements ChannelRuntime {
  readonly subscriptionCalls: string[][] = [];
  private readonly handlers = new Set<(event: ChannelMessageReceivedEventData) => void>();
  isReady(): boolean { return true; }
  async publish(): Promise<{ messageId: string }> { return { messageId: "unused" }; }
  async publishPrivate(): Promise<{ messageId: string }> { return { messageId: "unused" }; }
  async subscriptionSet(channels: string[]): Promise<{ channels: string[] }> {
    this.subscriptionCalls.push([...channels]);
    return { channels: [...channels] };
  }
  subscribe(handler: (event: ChannelMessageReceivedEventData) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  subscribePrivate(): () => void { return () => undefined; }
  emit(event: ChannelMessageReceivedEventData): void {
    for (const handler of this.handlers) handler(event);
  }
}

const PUBLISHER_A = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PUBLISHER_B = "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeMessage(channel: string, price = "100.00"): ChannelMessageReceivedEventData {
  return {
    channel,
    publisherPublicKeyHex: PUBLISHER_A,
    messageId: `message-${price}`,
    content: {
      protocolId: PRICECAST_PROTOCOL_ID,
      quotes: [{ exchange: "gate", price }]
    }
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("createBsvPriceService", () => {
  it("starts from stored config and subscribes to one exact Channel", () => {
    const storage = new FakeStorage();
    storage.setItem("bsv-price.settings", JSON.stringify({ pricePublisherPublicKeyHex: PUBLISHER_A, savedAtMs: 1 }));
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, { localStorage: storage });

    expect(service.configured()).toBe(true);
    expect(service.getPublisherPublicKeyHex()).toBe(PUBLISHER_A);
    expect(channel.subscriptionCalls).toEqual([[buildPriceChannelId(PUBLISHER_A)]]);
    service.dispose();
  });

  it("uses and persists the seed when no stored config exists", () => {
    const storage = new FakeStorage();
    const service = createBsvPriceService(new FakeChannel(), {
      localStorage: storage,
      seedPublisherPublicKeyHex: PUBLISHER_B
    });
    expect(service.getPublisherPublicKeyHex()).toBe(PUBLISHER_B);
    expect(JSON.parse(storage.getItem("bsv-price.settings") ?? "{}")).toMatchObject({ pricePublisherPublicKeyHex: PUBLISHER_B });
    service.dispose();
  });

  it("switches exact subscriptions and ignores messages from the old Channel", () => {
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, { localStorage: new FakeStorage(), seedPublisherPublicKeyHex: PUBLISHER_A });
    const oldChannel = buildPriceChannelId(PUBLISHER_A);
    const newChannel = buildPriceChannelId(PUBLISHER_B);
    channel.emit(makeMessage(oldChannel, "100.01"));
    expect(service.snapshot().snapshot?.quotes[0]?.price).toBe("100.01");

    service.savePublisherPublicKeyHex(PUBLISHER_B);
    expect(channel.subscriptionCalls).toEqual([[oldChannel], [newChannel]]);
    expect(service.snapshot().snapshot).toBeNull();
    channel.emit(makeMessage(oldChannel, "999.99"));
    expect(service.snapshot().snapshot).toBeNull();
    channel.emit({ ...makeMessage(newChannel, "101.23"), publisherPublicKeyHex: PUBLISHER_B });
    expect(service.snapshot().snapshot?.quotes[0]?.price).toBe("101.23");
    service.dispose();
  });

  it("ignores a valid message from the wrong publisher on the configured Channel", () => {
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, {
      localStorage: new FakeStorage(),
      seedPublisherPublicKeyHex: PUBLISHER_A
    });
    channel.emit({
      ...makeMessage(buildPriceChannelId(PUBLISHER_A), "999.99"),
      publisherPublicKeyHex: PUBLISHER_B
    });
    expect(service.snapshot().snapshot).toBeNull();
    service.dispose();
  });

  it("clears the configured Channel and rejects invalid publisher keys", () => {
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, { localStorage: new FakeStorage(), seedPublisherPublicKeyHex: PUBLISHER_A });
    service.savePublisherPublicKeyHex("");
    expect(service.snapshot()).toMatchObject({ status: "not_configured", configured: false, channelId: "(not configured)" });
    expect(() => service.savePublisherPublicKeyHex("bad")).toThrow("invalid_length");
    service.dispose();
  });
});
