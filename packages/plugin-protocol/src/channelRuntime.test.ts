import { describe, expect, it, vi } from "vitest";
import type { SessionCoordinatorClient } from "@keymaster/contracts";
import { createConnectChannelRuntime } from "./channelRuntime.js";

const OWNER = "02" + "aa".repeat(32);

describe("createConnectChannelRuntime", () => {
  it("carries the verified Connect caller through publish, subscription, and release", async () => {
    const channelOperation = vi.fn(async (operation: { type: string }) => {
      if (operation.type === "publish") return { status: "ok" as const, value: { messageId: "message-1" } };
      if (operation.type === "subscription-set") return { status: "ok" as const, value: { channels: ["topic"] } };
      return { status: "ok" as const, value: null };
    });
    const coordinator = { channelOperation } as unknown as SessionCoordinatorClient;
    const runtime = createConnectChannelRuntime(coordinator);
    const caller = {
      connectSessionId: "connect-session-1",
      origin: "https://app.example",
      ownerPublicKeyHex: OWNER
    };

    await expect(runtime.publish(caller, { channel: "topic", content: { hello: "world" } }))
      .resolves.toEqual({ messageId: "message-1" });
    await expect(runtime.subscriptionSet(caller, ["topic"]))
      .resolves.toEqual({ channels: ["topic"] });
    runtime.release(caller);
    await vi.waitFor(() => expect(channelOperation).toHaveBeenCalledTimes(3));

    expect(channelOperation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "publish",
      ownerPublicKeyHex: OWNER,
      caller: { kind: "connect", connectSessionId: caller.connectSessionId, origin: caller.origin }
    }));
    expect(channelOperation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: "subscription-set",
      ownerPublicKeyHex: OWNER,
      caller: { kind: "connect", connectSessionId: caller.connectSessionId, origin: caller.origin },
      channels: ["topic"]
    }));
    expect(channelOperation).toHaveBeenNthCalledWith(3, {
      type: "release",
      ownerPublicKeyHex: OWNER,
      caller: { kind: "connect", connectSessionId: caller.connectSessionId, origin: caller.origin }
    });
  });

  it("projects only public Coordinator events and keeps the session epoch", () => {
    let handler: ((event: unknown) => void) | undefined;
    const coordinator = {
      subscribeTopic: vi.fn((_topic: string, next: (event: unknown) => void) => {
        handler = next;
        return () => undefined;
      })
    } as unknown as SessionCoordinatorClient;
    const runtime = createConnectChannelRuntime(coordinator);
    const received: unknown[] = [];
    runtime.subscribe((event) => received.push(event));

    handler?.({
      sessionEpoch: "epoch-1",
      publicMessage: { channel: "topic", publisherPublicKeyHex: OWNER, messageId: "public-1", content: { ok: true } }
    });
    handler?.({
      sessionEpoch: "epoch-1",
      privateMessage: { channel: `bsv8.inbox.${OWNER}`, publisherPublicKeyHex: OWNER, messageId: "private-1", protocol: "bsv8.message.v1", content: null }
    });

    expect(received).toEqual([{
      channel: "topic",
      publisherPublicKeyHex: OWNER,
      messageId: "public-1",
      content: { ok: true },
      sessionEpoch: "epoch-1"
    }]);
  });
});
