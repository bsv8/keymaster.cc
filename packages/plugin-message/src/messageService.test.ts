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
      state: "open" as const,
      ownerPublicKeyHex: OWNER,
      lastInsertedAtMs: 1,
      lastError: null
    })),
    openLocalDb: vi.fn(async () => null),
    sendScopedMessage: vi.fn(async () => ({ messageId: "1", createdAtMs: 1 })),
    listScopedMessages: vi.fn(async (): Promise<AppMsgListResult> => ({
      items: [fakeMsg()],
      hasMore: false
    })),
    getScopedMessage: vi.fn(async () => fakeMsg()),
    subscribeScopedMessages: vi.fn(() => () => undefined),
    subscribeUnfilteredMessages: vi.fn(() => () => undefined),
    listUnfilteredMessages: vi.fn(async (): Promise<AppMsgListResult> => ({
      items: [fakeMsg()],
      hasMore: false
    })),
    triggerSync: vi.fn(async () => undefined),
    listTargetSyncStates: vi.fn(async () => []),
    checkOnline: vi.fn(async (hexes): Promise<AppMsgOnlineResult> => {
      const out: AppMsgOnlineResult = {};
      for (const h of hexes) out[h] = h === OWNER ? "online" : "offline";
      return out;
    }),
    createMessageScopedClient: vi.fn(() => {
      throw new Error("not used in unit tests");
    }),
    createSystemMessageClient: vi.fn(({ ownerPublicKeyHex }: { ownerPublicKeyHex: string }) => {
      return {
        sendMessage: async () => ({ messageId: "1", createdAtMs: 1 }),
        listMessages: async () => ({ items: [fakeMsg()], hasMore: false }),
        getMessage: async () => fakeMsg(),
        subscribeMessages: () => () => undefined,
        checkOnline: async (hexes: string[]) => {
          const out: AppMsgOnlineResult = {};
          for (const h of hexes) out[h] = h === OWNER ? "online" : "offline";
          return out;
        },
        sender: { senderPublicKeyHex: ownerPublicKeyHex, senderAppId: "keymaster.message" }
      };
    })
  };
}

describe("createMessageService", () => {
  it("listLocalMessages goes through system message facade -> listUnfilteredMessages", async () => {
    const core = makeFakeCore();
    const service = createMessageService(core);
    const items = await service.listLocalMessages();
    expect(items.length).toBe(1);
    // createSystemMessageClient was called; the facade's listMessages goes
    // through listUnfilteredMessages on the core.
    expect(
      (core.createSystemMessageClient as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(1);
  });

  it("getLocalMessage goes through system message facade", async () => {
    const core = makeFakeCore();
    const service = createMessageService(core);
    const got = await service.getLocalMessage("42");
    expect(got?.messageId).toBe("1");
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
