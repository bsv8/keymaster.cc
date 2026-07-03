// packages/plugin-message/src/messageService.test.ts
// 系统消息应用 service 单测。

import { describe, expect, it, vi } from "vitest";
import type {
  AppMsgCore,
  AppMsgListResult,
  AppMsgMessage,
  AppMsgOnlineResult
} from "@keymaster/contracts";
import { createMessageService, onlineFallback } from "./messageService.js";

const OWNER = "02aaaa".padEnd(66, "a");

function fakeMsg(overrides: Partial<AppMsgMessage> = {}): AppMsgMessage {
  return {
    messageId: "1",
    clientMessageId: "c-1",
    senderPublicKeyHex: OWNER,
    recipientPublicKeyHex: OWNER,
    contentType: "text/plain",
    body: "hi",
    createdAtMs: 1,
    insertedAtMs: 1,
    ...overrides
  };
}

function makeFakeCore(): AppMsgCore {
  return {
    connectForOwner: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    inspectLocalDb: vi.fn(() => ({
      state: "open",
      ownerPublicKeyHex: OWNER,
      lastInsertedAtMs: 1,
      lastError: null
    })),
    openLocalDb: vi.fn(async () => null),
    listLocalMessages: vi.fn(async (_?: { limit?: number; afterMessageId?: string }): Promise<AppMsgListResult> => ({
      items: [fakeMsg()],
      hasMore: false
    })),
    getLocalMessage: vi.fn(async () => fakeMsg()),
    sendMessage: vi.fn(async () => ({ messageId: "1", createdAtMs: 1 })),
    subscribeMessages: vi.fn(() => () => undefined),
    triggerSync: vi.fn(async () => undefined),
    listTargetSyncStates: vi.fn(async () => []),
    checkOnline: vi.fn(async (hexes): Promise<AppMsgOnlineResult> => {
      const out: AppMsgOnlineResult = {};
      for (const h of hexes) out[h] = h === OWNER ? "online" : "offline";
      return out;
    }),
    createMessageScopedClient: vi.fn(() => {
      throw new Error("not used in unit tests");
    })
  };
}

describe("createMessageService", () => {
  it("listLocalMessages returns message items from core", async () => {
    const core = makeFakeCore();
    const service = createMessageService(core);
    const items = await service.listLocalMessages();
    expect(items.length).toBe(1);
    expect((core.listLocalMessages as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("getLocalMessage delegates to core with right messageId", async () => {
    const core = makeFakeCore();
    const service = createMessageService(core);
    await service.getLocalMessage("42");
    expect((core.getLocalMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({
      messageId: "42"
    });
  });

  it("triggerSync delegates to core", async () => {
    const core = makeFakeCore();
    const service = createMessageService(core);
    await service.triggerSync();
    expect((core.triggerSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("checkOnline passes hexes through", async () => {
    const core = makeFakeCore();
    const service = createMessageService(core);
    const out = await service.checkOnline([OWNER]);
    expect(out[OWNER]).toBe("online");
  });

  it("getLocalDbSnapshot exposes the local db snapshot", () => {
    const core = makeFakeCore();
    const service = createMessageService(core);
    const snap = service.getLocalDbSnapshot();
    expect(snap.state).toBe("open");
    expect(snap.ownerPublicKeyHex).toBe(OWNER);
  });

  it("onlineFallback returns unknown for each hex", () => {
    const out = onlineFallback([OWNER, "02bbbb".padEnd(66, "b")]);
    expect(out[OWNER]).toBe("unknown");
    Object.values(out).forEach((v) => expect(v).toBe("unknown"));
  });
});
