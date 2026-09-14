// BSV 价格服务的 Channel 精确订阅测试。

import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import type { BorrowedKeyValueStore, ChannelMessageReceivedEventData, ChannelRuntime } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import { PRICECAST_PROTOCOL_ID, buildPriceChannelId } from "./constants.js";
import { createBsvPriceService } from "./bsvPriceService.js";
import { createMemoryBsvPriceSettingsStore } from "./bsvPriceSettings.js";

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

function makeStorage() {
  return createInMemoryKeyValueStore({ ...CENTRAL_STORAGE_DECLARATIONS.bsvPrice, ownerPublicKeyHex: PUBLISHER_A, bucketId: "test", bucketGeneration: 1 });
}

describe("createBsvPriceService", () => {
  it("starts from stored config and subscribes to one exact Channel", async () => {
    const storage = makeStorage();
    await storage.put("settings", { pricePublisherPublicKeyHex: PUBLISHER_A, savedAtMs: 1 }, { partition: "settings" });
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, { storage });
    await service.ready();

    expect(service.configured()).toBe(true);
    expect(service.getPublisherPublicKeyHex()).toBe(PUBLISHER_A);
    expect(channel.subscriptionCalls).toEqual([[buildPriceChannelId(PUBLISHER_A)]]);
    service.dispose();
  });

  it("uses the seed when an explicit memory store is injected", async () => {
    const service = createBsvPriceService(new FakeChannel(), {
      seedPublisherPublicKeyHex: PUBLISHER_B,
      settingsStore: createMemoryBsvPriceSettingsStore()
    });
    await service.ready();
    expect(service.getPublisherPublicKeyHex()).toBe(PUBLISHER_B);
    service.dispose();
  });

  it("switches exact subscriptions and ignores messages from the old Channel", async () => {
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, {
      seedPublisherPublicKeyHex: PUBLISHER_A,
      settingsStore: createMemoryBsvPriceSettingsStore()
    });
    await service.ready();
    const oldChannel = buildPriceChannelId(PUBLISHER_A);
    const newChannel = buildPriceChannelId(PUBLISHER_B);
    channel.emit(makeMessage(oldChannel, "100.01"));
    expect(service.snapshot().snapshot?.quotes[0]?.price).toBe("100.01");

    await service.savePublisherPublicKeyHex(PUBLISHER_B);
    expect(channel.subscriptionCalls).toEqual([[oldChannel], [newChannel]]);
    expect(service.snapshot().snapshot).toBeNull();
    channel.emit(makeMessage(oldChannel, "999.99"));
    expect(service.snapshot().snapshot).toBeNull();
    channel.emit({ ...makeMessage(newChannel, "101.23"), publisherPublicKeyHex: PUBLISHER_B });
    expect(service.snapshot().snapshot?.quotes[0]?.price).toBe("101.23");
    service.dispose();
  });

  it("ignores a valid message from the wrong publisher on the configured Channel", async () => {
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, {
      seedPublisherPublicKeyHex: PUBLISHER_A,
      settingsStore: createMemoryBsvPriceSettingsStore()
    });
    await service.ready();
    channel.emit({
      ...makeMessage(buildPriceChannelId(PUBLISHER_A), "999.99"),
      publisherPublicKeyHex: PUBLISHER_B
    });
    expect(service.snapshot().snapshot).toBeNull();
    service.dispose();
  });

  it("clears the configured Channel and rejects invalid publisher keys", async () => {
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, {
      seedPublisherPublicKeyHex: PUBLISHER_A,
      settingsStore: createMemoryBsvPriceSettingsStore()
    });
    await service.ready();
    await service.savePublisherPublicKeyHex("");
    expect(service.snapshot()).toMatchObject({ status: "not_configured", configured: false, channelId: "(not configured)" });
    await expect(service.savePublisherPublicKeyHex("bad")).rejects.toThrow("invalid_length");
    service.dispose();
  });

  it("propagates storage failures without changing the configured publisher", async () => {
    const storage = makeStorage();
    let fail = true;
    const failingStorage = {
      ...storage,
      async put<T>(key: string, value: T, condition?: Parameters<BorrowedKeyValueStore["put"]>[2]) {
        if (fail) throw new Error("injected BSV Price storage failure");
        return storage.put(key, value, condition);
      }
    } as BorrowedKeyValueStore;
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, {
      seedPublisherPublicKeyHex: PUBLISHER_A,
      storage: failingStorage
    });
    await service.ready();
    const before = service.getPublisherPublicKeyHex();
    await expect(service.savePublisherPublicKeyHex(PUBLISHER_B))
      .rejects.toThrow("injected BSV Price storage failure");
    expect(service.getPublisherPublicKeyHex()).toBe(before);
    expect(channel.subscriptionCalls).toEqual([[buildPriceChannelId(PUBLISHER_A)]]);
    fail = false;
    await service.savePublisherPublicKeyHex(PUBLISHER_B);
    expect(service.getPublisherPublicKeyHex()).toBe(PUBLISHER_B);
    service.dispose();
  });
});
