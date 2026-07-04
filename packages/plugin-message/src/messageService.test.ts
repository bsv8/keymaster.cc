// packages/plugin-message/src/messageService.test.ts
// 消息业务 service 单测（施工单 2026-07-03 002 硬切换）。
//
// 验证：
//   - 4 个最小方法（listMessages / getMessage / sendTextMessage /
//     subscribeMessages）按预期走 scoped client；
//   - scoped client 不存在时降级空态；
//   - sendTextMessage 固定带 `recipientAppId = keymaster.message`；
//   - 不再使用 `createSystemMessageClient(...)` / `listUnfilteredMessages`。

import { describe, expect, it, vi } from "vitest";
import type {
  AppMsgMessage,
  AppMsgOnlineResult,
  AppMsgSimpleClient
} from "@keymaster/contracts";
import { createMessageService } from "./messageService.js";

const OWNER = "02aaaa".padEnd(66, "a");

function fakeMsg(overrides: Partial<AppMsgMessage> = {}): AppMsgMessage {
  return {
    messageId: "1",
    clientMessageId: "c-1",
    senderPublicKeyHex: OWNER,
    senderAppId: "keymaster.message",
    recipientPublicKeyHex: OWNER,
    recipientAppId: "keymaster.message",
    contentType: "text/plain",
    body: "hi",
    createdAtMs: 1,
    insertedAtMs: 1,
    ...overrides
  };
}

function makeFakeClient(): {
  client: AppMsgSimpleClient;
  calls: { method: string; args: unknown }[];
} {
  const calls: { method: string; args: unknown }[] = [];
  const client: AppMsgSimpleClient = {
    sendMessage: vi.fn(async (args) => {
      calls.push({ method: "sendMessage", args });
      return { messageId: "m-sent", createdAtMs: Date.now() };
    }),
    listMessages: vi.fn(async (args) => {
      calls.push({ method: "listMessages", args });
      return { items: [fakeMsg()], hasMore: false };
    }),
    getMessage: vi.fn(async (args) => {
      calls.push({ method: "getMessage", args });
      return fakeMsg();
    }),
    subscribeMessages: vi.fn((handler) => {
      calls.push({ method: "subscribeMessages", args: { handlerPresent: typeof handler === "function" } });
      return () => undefined;
    }),
    checkOnline: vi.fn(async (hexes): Promise<AppMsgOnlineResult> => {
      const out: AppMsgOnlineResult = {};
      for (const h of hexes) out[h] = "online";
      return out;
    })
  };
  return { client, calls };
}

describe("createMessageService (scoped client path)", () => {
  it("isReady reports scoped client availability", () => {
    const { client } = makeFakeClient();
    const service = createMessageService(() => client);
    expect(service.isReady()).toBe(true);
  });

  it("isReady reports not-ready when scoped client is null", () => {
    const service = createMessageService(() => null);
    expect(service.isReady()).toBe(false);
  });

  it("listMessages delegates to scoped client", async () => {
    const { client, calls } = makeFakeClient();
    const service = createMessageService(() => client);
    const items = await service.listMessages({ limit: 50 });
    expect(items.length).toBe(1);
    expect(calls.some((c) => c.method === "listMessages")).toBe(true);
  });

  it("listMessages returns empty when scoped client is null", async () => {
    const service = createMessageService(() => null);
    await expect(service.listMessages()).resolves.toEqual([]);
  });

  it("getMessage delegates to scoped client", async () => {
    const { client, calls } = makeFakeClient();
    const service = createMessageService(() => client);
    const got = await service.getMessage("42");
    expect(got?.messageId).toBe("1");
    const lastGet = [...calls].reverse().find((c) => c.method === "getMessage");
    expect((lastGet?.args as { messageId: string }).messageId).toBe("42");
  });

  it("getMessage returns null when scoped client is null", async () => {
    const service = createMessageService(() => null);
    await expect(service.getMessage("42")).resolves.toBeNull();
  });

  it("sendTextMessage pins recipientAppId = keymaster.message", async () => {
    const { client, calls } = makeFakeClient();
    const service = createMessageService(() => client);
    await service.sendTextMessage({
      recipientPublicKeyHex: "02bbbb".padEnd(66, "b"),
      body: "hello"
    });
    const sendCall = calls.find((c) => c.method === "sendMessage");
    expect(sendCall).toBeTruthy();
    const args = sendCall?.args as {
      recipientPublicKeyHex: string;
      recipientAppId?: string;
      body: string;
    };
    expect(args.recipientAppId).toBe("keymaster.message");
    expect(args.body).toBe("hello");
  });

  it("sendTextMessage throws when scoped client is null", async () => {
    const service = createMessageService(() => null);
    await expect(
      service.sendTextMessage({ recipientPublicKeyHex: OWNER, body: "x" })
    ).rejects.toThrow(/not ready/);
  });

  it("subscribeMessages forwards handler to scoped client", () => {
    const { client, calls } = makeFakeClient();
    const service = createMessageService(() => client);
    const handler = vi.fn();
    const off = service.subscribeMessages(handler);
    expect(typeof off).toBe("function");
    expect(calls.some((c) => c.method === "subscribeMessages")).toBe(true);
  });

  it("subscribeMessages returns no-op cancel when scoped client is null", () => {
    const service = createMessageService(() => null);
    const off = service.subscribeMessages(() => undefined);
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });
});