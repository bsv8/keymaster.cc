// BSV 价格服务的 Channel 精确订阅测试。

import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import type { BorrowedKeyValueStore, ChannelMessageReceivedEventData, ChannelRuntime, ChannelSubscriptionStatus } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import { parsePublicKey } from "bsv8-channel-protocol";
import { BSV_PRICE_PROTOCOL, bsvPriceChannel } from "bsv8-channel-protocol/bsv-price";
import { createBsvPriceService } from "./bsvPriceService.js";
import { createMemoryBsvPriceSettingsStore } from "./bsvPriceSettings.js";

class FakeChannel implements ChannelRuntime {
  readonly subscriptionCalls: string[][] = [];
  private readonly handlers = new Set<(event: ChannelMessageReceivedEventData) => void>();
  private readonly statusHandlers = new Set<(status: ChannelSubscriptionStatus) => void>();
  private readonly statuses = new Map<string, ChannelSubscriptionStatus>();
  isReady(): boolean { return true; }
  async publish(): Promise<{ messageId: string }> { return { messageId: "unused" }; }
  async publishPrivate(): Promise<{ messageId: string }> { return { messageId: "unused" }; }
  async subscriptionSet(channels: string[]): Promise<{ channels: string[] }> {
    this.subscriptionCalls.push([...channels]);
    const active = new Set(channels);
    for (const channel of new Set([...this.statuses.keys(), ...channels])) {
      const status: ChannelSubscriptionStatus = {
        channel,
        phase: active.has(channel) ? "subscribed" : "idle",
        errorCode: null,
        errorMessage: null,
        updatedAtMs: Date.now(),
      };
      this.statuses.set(channel, status);
      for (const handler of this.statusHandlers) handler({ ...status });
    }
    return { channels: [...channels] };
  }
  subscriptionStatus(channel: string): ChannelSubscriptionStatus {
    return this.statuses.get(channel) ?? { channel, phase: "idle", errorCode: null, errorMessage: null, updatedAtMs: 0 };
  }
  subscribeSubscriptionStatus(handler: (status: ChannelSubscriptionStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }
  subscribe(handler: (event: ChannelMessageReceivedEventData) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  subscribePrivate(): () => void { return () => undefined; }
  emit(event: ChannelMessageReceivedEventData): void {
    for (const handler of this.handlers) handler(event);
  }
  emitStatus(status: ChannelSubscriptionStatus): void {
    this.statuses.set(status.channel, { ...status });
    for (const handler of this.statusHandlers) handler({ ...status });
  }
}

const PUBLISHER_A = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PUBLISHER_B = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

function makeMessage(channel: string, price = "100.00", snapshotAtMs = 1000): ChannelMessageReceivedEventData {
  return {
    channel,
    publisherPublicKeyHex: PUBLISHER_A,
    messageId: `message-${price}`,
    content: {
      protocol: BSV_PRICE_PROTOCOL,
      snapshot_at_ms: snapshotAtMs,
      markets: { gate: { bsvusdt: price } }
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
    expect(channel.subscriptionCalls).toEqual([[bsvPriceChannel(parsePublicKey(PUBLISHER_A))]]);
    expect(service.snapshot().status).toBe("waiting_snapshot");
    service.dispose();
  });

  it("maps SatSubscription balance/config errors instead of reporting receiving", async () => {
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, {
      seedPublisherPublicKeyHex: PUBLISHER_A,
      settingsStore: createMemoryBsvPriceSettingsStore()
    });
    await service.ready();
    const channelId = bsvPriceChannel(parsePublicKey(PUBLISHER_A));

    channel.emitStatus({ channel: channelId, phase: "blocked", errorCode: "balance", errorMessage: "No fee balance", updatedAtMs: Date.now() });
    expect(service.snapshot()).toMatchObject({ status: "sat_balance_required", subscriptionErrorCode: "balance", subscriptionErrorMessage: "No fee balance" });
    channel.emitStatus({ channel: channelId, phase: "blocked", errorCode: "config", errorMessage: "No receive Supplier", updatedAtMs: Date.now() });
    expect(service.snapshot()).toMatchObject({ status: "sat_not_configured", subscriptionErrorCode: "config" });
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
    const oldChannel = bsvPriceChannel(parsePublicKey(PUBLISHER_A));
    const newChannel = bsvPriceChannel(parsePublicKey(PUBLISHER_B));
    channel.emit(makeMessage(oldChannel, "100.01"));
    expect(service.snapshot().snapshot?.markets.gate?.bsvusdt).toBe("100.01");
    expect(service.snapshot().status).toBe("receiving");

    await service.savePublisherPublicKeyHex(PUBLISHER_B);
    expect(channel.subscriptionCalls).toEqual([[oldChannel], [newChannel]]);
    expect(service.snapshot().snapshot).toBeNull();
    channel.emit(makeMessage(oldChannel, "999.99"));
    expect(service.snapshot().snapshot).toBeNull();
    channel.emit({ ...makeMessage(newChannel, "101.23"), publisherPublicKeyHex: PUBLISHER_B });
    expect(service.snapshot().snapshot?.markets.gate?.bsvusdt).toBe("101.23");
    expect(service.snapshot().status).toBe("receiving");
    service.dispose();
  });

  it("uses snapshot_at_ms to ignore old and equal full snapshots", async () => {
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, {
      seedPublisherPublicKeyHex: PUBLISHER_A,
      settingsStore: createMemoryBsvPriceSettingsStore()
    });
    await service.ready();
    const subscribed = bsvPriceChannel(parsePublicKey(PUBLISHER_A));
    channel.emit(makeMessage(subscribed, "100.00", 1000));
    channel.emit(makeMessage(subscribed, "90.00", 999));
    channel.emit(makeMessage(subscribed, "80.00", 1000));
    expect(service.snapshot().snapshot?.markets.gate?.bsvusdt).toBe("100.00");
    channel.emit(makeMessage(subscribed, "101.00", 1001));
    expect(service.snapshot().snapshot?.markets.gate?.bsvusdt).toBe("101.00");
    service.dispose();
  });

  it("replaces the entire market snapshot instead of retaining stale markets", async () => {
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, {
      seedPublisherPublicKeyHex: PUBLISHER_A,
      settingsStore: createMemoryBsvPriceSettingsStore()
    });
    await service.ready();
    const subscribed = bsvPriceChannel(parsePublicKey(PUBLISHER_A));
    channel.emit({
      ...makeMessage(subscribed, "100.00", 1000),
      content: {
        protocol: BSV_PRICE_PROTOCOL,
        snapshot_at_ms: 1000,
        markets: {
          gate: { bsvusdt: "100.00" },
          okx: { bsvusdt: "99.50" }
        }
      }
    });
    channel.emit({
      ...makeMessage(subscribed, "101.00", 1001),
      content: {
        protocol: BSV_PRICE_PROTOCOL,
        snapshot_at_ms: 1001,
        markets: { gate: { bsvusdt: "101.00" } }
      }
    });
    expect(service.snapshot().snapshot?.markets).toEqual({ gate: { bsvusdt: "101.00" } });
    service.dispose();
  });

  it("accepts an empty full snapshot and clears all displayed markets", async () => {
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, {
      seedPublisherPublicKeyHex: PUBLISHER_A,
      settingsStore: createMemoryBsvPriceSettingsStore()
    });
    await service.ready();
    const subscribed = bsvPriceChannel(parsePublicKey(PUBLISHER_A));
    channel.emit(makeMessage(subscribed, "100.00", 1000));
    expect(service.currentMarkets()).toEqual({ gate: { bsvusdt: "100.00" } });

    channel.emit({
      ...makeMessage(subscribed, "0", 1001),
      content: {
        protocol: BSV_PRICE_PROTOCOL,
        snapshot_at_ms: 1001,
        markets: {}
      }
    });

    expect(service.snapshot().snapshot).toMatchObject({
      snapshotAtMs: 1001,
      markets: {}
    });
    expect(service.currentMarkets()).toEqual({});
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
      ...makeMessage(bsvPriceChannel(parsePublicKey(PUBLISHER_A)), "999.99"),
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

  it("rejects the retired PriceCast body shape", async () => {
    const channel = new FakeChannel();
    const service = createBsvPriceService(channel, {
      seedPublisherPublicKeyHex: PUBLISHER_A,
      settingsStore: createMemoryBsvPriceSettingsStore()
    });
    await service.ready();
    channel.emit({
      channel: bsvPriceChannel(parsePublicKey(PUBLISHER_A)),
      publisherPublicKeyHex: PUBLISHER_A,
      messageId: "legacy-message",
      content: { protocolId: "pricecast.bsv_price.v1", quotes: [{ exchange: "gate", price: "1" }] }
    });
    expect(service.snapshot().snapshot).toBeNull();
    expect(service.snapshot().lastError).toBe("invalid_body");
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
    expect(channel.subscriptionCalls).toEqual([[bsvPriceChannel(parsePublicKey(PUBLISHER_A))]]);
    fail = false;
    await service.savePublisherPublicKeyHex(PUBLISHER_B);
    expect(service.getPublisherPublicKeyHex()).toBe(PUBLISHER_B);
    service.dispose();
  });
});
