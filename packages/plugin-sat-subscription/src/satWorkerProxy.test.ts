import { describe, expect, it, vi } from "vitest";
import type {
  ChannelMessageReceivedEventData,
  SessionCoordinatorClient
} from "@keymaster/contracts";
import { createSatWorkerChannelRuntime } from "./satWorkerProxy.js";

const OWNER = "02" + "11".repeat(32);

describe("createSatWorkerChannelRuntime", () => {
  it("uses Coordinator-owned owner context and forwards Channel events", async () => {
    const eventHandlers = new Map<string, Set<(event: unknown) => void>>();
    const epoch = "epoch-a";
    const channelOperation = vi.fn(async (operation: { type: string }) => ({
      status: "ok" as const,
      value: operation.type === "subscription-set" ? { channels: ["topic"] } : { messageId: "message-1" }
    }));
    const coordinator = {
      getIsConnected: () => true,
      getBootstrapSnapshot: () => ({ activePublicKeyHex: OWNER, sessionEpoch: epoch }),
      getActivePublicKeyHex: () => OWNER,
      getSessionEpoch: () => epoch,
      channelOperation,
      subscribeTopic: (topic: string, handler: (event: unknown) => void) => {
        const handlers = eventHandlers.get(topic) ?? new Set();
        handlers.add(handler);
        eventHandlers.set(topic, handlers);
        return () => handlers.delete(handler);
      }
    } as unknown as SessionCoordinatorClient;
    const runtime = createSatWorkerChannelRuntime(coordinator, { kind: "plugin", pluginId: "message" });

    await expect(runtime.publish({ channel: "topic", content: { hello: "world" } })).resolves.toEqual({ messageId: "message-1" });
    await expect(runtime.subscriptionSet(["topic"])).resolves.toEqual({ channels: ["topic"] });
    expect(channelOperation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "publish",
      ownerPublicKeyHex: OWNER,
      channel: "topic"
    }));
    expect(channelOperation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: "subscription-set",
      ownerPublicKeyHex: OWNER,
      caller: { kind: "plugin", pluginId: "message" },
      channels: ["topic"]
    }));

    const received: ChannelMessageReceivedEventData[] = [];
    const off = runtime.subscribe((event) => received.push(event));
    for (const handler of eventHandlers.get("channel.events") ?? []) handler({ sessionEpoch: epoch, publicMessage: {
      channel: "topic",
      publisherPublicKeyHex: OWNER,
      messageId: "public-1",
      content: { ok: true }
    } });
    for (const handler of eventHandlers.get("channel.events") ?? []) handler({ sessionEpoch: epoch, publicMessage: {
      channel: "other-topic",
      publisherPublicKeyHex: OWNER,
      messageId: "public-ignored",
      content: { ok: false }
    } });
    expect(received).toEqual([expect.objectContaining({ messageId: "public-1" })]);
    off();
  });

  it("drops stale channel events across an owner session epoch change", async () => {
    const eventHandlers = new Map<string, Set<(event: unknown) => void>>();
    let epoch = "epoch-a";
    const channelOperation = vi.fn(async () => ({ status: "ok" as const, value: { channels: ["topic"] } }));
    const coordinator = {
      getIsConnected: () => true,
      getBootstrapSnapshot: () => ({ activePublicKeyHex: OWNER, sessionEpoch: epoch }),
      getActivePublicKeyHex: () => OWNER,
      getSessionEpoch: () => epoch,
      channelOperation,
      subscribeTopic: (topic: string, handler: (event: unknown) => void) => {
        const handlers = eventHandlers.get(topic) ?? new Set();
        handlers.add(handler);
        eventHandlers.set(topic, handlers);
        return () => handlers.delete(handler);
      }
    } as unknown as SessionCoordinatorClient;
    const runtime = createSatWorkerChannelRuntime(coordinator, { kind: "plugin", pluginId: "message" });
    await runtime.subscriptionSet(["topic"]);
    const received: string[] = [];
    const off = runtime.subscribe((event) => received.push(event.messageId));
    const emitChannel = (eventEpoch: string, messageId: string) => {
      for (const handler of eventHandlers.get("channel.events") ?? []) handler({
        sessionEpoch: eventEpoch,
        publicMessage: { channel: "topic", publisherPublicKeyHex: OWNER, messageId, content: null }
      });
    };
    emitChannel("epoch-a", "before-switch");
    epoch = "epoch-b";
    for (const handler of eventHandlers.get("session.state") ?? []) handler({ sessionEpoch: "epoch-b", activePublicKeyHex: OWNER });
    await runtime.subscriptionSet(["topic"]);
    emitChannel("epoch-a", "stale");
    emitChannel("epoch-b", "after-rebind");
    expect(received).toEqual(["before-switch", "after-rebind"]);
    off();
  });

  it("does not commit a delayed subscription result after the session epoch changes", async () => {
    const eventHandlers = new Map<string, Set<(event: unknown) => void>>();
    let epoch = "epoch-a";
    let resolveSubscription: ((result: { status: "ok"; value: { channels: string[] } }) => void) | undefined;
    const channelOperation = vi.fn(async (operation: { type: string }) => {
      if (operation.type === "subscription-set") {
        return new Promise<{ status: "ok"; value: { channels: string[] } }>((resolve) => {
          resolveSubscription = resolve;
        });
      }
      return { status: "ok" as const, value: { messageId: "message-1" } };
    });
    const coordinator = {
      getIsConnected: () => true,
      getBootstrapSnapshot: () => ({ activePublicKeyHex: OWNER, sessionEpoch: epoch }),
      getActivePublicKeyHex: () => OWNER,
      getSessionEpoch: () => epoch,
      channelOperation,
      subscribeTopic: (topic: string, handler: (event: unknown) => void) => {
        const handlers = eventHandlers.get(topic) ?? new Set();
        handlers.add(handler);
        eventHandlers.set(topic, handlers);
        return () => handlers.delete(handler);
      }
    } as unknown as SessionCoordinatorClient;
    const runtime = createSatWorkerChannelRuntime(coordinator, { kind: "plugin", pluginId: "message" });
    const pending = runtime.subscriptionSet(["topic"]);
    epoch = "epoch-b";
    resolveSubscription?.({ status: "ok", value: { channels: ["topic"] } });
    await expect(pending).rejects.toThrow("subscription result became stale");

    const received: string[] = [];
    const off = runtime.subscribe((event) => received.push(event.messageId));
    for (const handler of eventHandlers.get("channel.events") ?? []) handler({
      sessionEpoch: "epoch-b",
      publicMessage: { channel: "topic", publisherPublicKeyHex: OWNER, messageId: "must-not-leak", content: null }
    });
    expect(received).toEqual([]);
    off();
  });

  it("does not expose owner inbox events when Coordinator rejects the plugin subscription", async () => {
    const eventHandlers = new Map<string, Set<(event: unknown) => void>>();
    const epoch = "epoch-a";
    const ownerInbox = `bsv8.inbox.${OWNER}`;
    const channelOperation = vi.fn(async (operation: { type: string; channels?: string[] }) => {
      if (operation.type === "subscription-set" && operation.channels?.includes(ownerInbox)) {
        return { status: "error" as const, code: "unauthorized", message: "owner inbox is system-only" };
      }
      return {
        status: "ok" as const,
        value: operation.type === "subscription-set" ? { channels: ["topic"] } : { messageId: "message-1" }
      };
    });
    const coordinator = {
      getIsConnected: () => true,
      getBootstrapSnapshot: () => ({ activePublicKeyHex: OWNER, sessionEpoch: epoch }),
      getActivePublicKeyHex: () => OWNER,
      getSessionEpoch: () => epoch,
      channelOperation,
      subscribeTopic: (topic: string, handler: (event: unknown) => void) => {
        const handlers = eventHandlers.get(topic) ?? new Set();
        handlers.add(handler);
        eventHandlers.set(topic, handlers);
        return () => handlers.delete(handler);
      }
    } as unknown as SessionCoordinatorClient;
    const runtime = createSatWorkerChannelRuntime(coordinator, { kind: "plugin", pluginId: "message" });
    await runtime.subscriptionSet(["topic"]);
    const received: string[] = [];
    const off = runtime.subscribePrivate((event) => received.push(event.messageId));

    await expect(runtime.subscriptionSet([ownerInbox])).rejects.toThrow("owner inbox is system-only");
    for (const handler of eventHandlers.get("channel.events") ?? []) handler({
      sessionEpoch: epoch,
      privateMessage: {
        channel: ownerInbox,
        publisherPublicKeyHex: OWNER,
        messageId: "private-owner-message",
        protocol: "bsv8.message.v1",
        content: { secret: true }
      }
    });

    expect(received).toEqual([]);
    off();
  });
});
