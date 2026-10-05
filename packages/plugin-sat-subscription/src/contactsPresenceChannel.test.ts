import { describe, expect, it, vi } from "vitest";
import { createContactsPresenceChannel } from "./contactsPresenceChannel.js";

describe("contacts presence channel", () => {
  it("rejects application protocols and foreign inbox subscriptions before transport", async () => {
    const publishPrivate = vi.fn(async () => ({ messageId: "ping" }));
    const subscriptionSet = vi.fn(async () => ({ channels: [], statuses: [] }));
    const channel = createContactsPresenceChannel({ assertActive() {}, owner: () => "owner", isReady: () => true, publishPrivate, subscriptionSet });
    await expect(channel.publishPrivate({ recipientPublicKeyHex: "recipient", protocol: "bsv8.message.v1", content: {} })).rejects.toThrow("Ping/Pong");
    await expect(channel.subscriptionSet(["bsv8.inbox.other"])).rejects.toThrow("owner inbox");
    expect(publishPrivate).not.toHaveBeenCalled();
    expect(subscriptionSet).not.toHaveBeenCalled();
  });
  it("rejects a response that finishes after the provider Scope was revoked", async () => {
    let active = true;
    let finish!: () => void;
    const channel = createContactsPresenceChannel({ assertActive() { if (!active) throw new Error("Scope revoked"); }, owner: () => "owner", isReady: () => true, publishPrivate: () => new Promise(resolve => { finish = () => resolve({ messageId: "ping" }); }), subscriptionSet: async () => ({ channels: [], statuses: [] }) });
    const pending = channel.publishPrivate({ recipientPublicKeyHex: "recipient", protocol: "bsv8.ping.v1", content: {} });
    active = false;
    finish();
    await expect(pending).rejects.toThrow("Scope revoked");
  });
});
