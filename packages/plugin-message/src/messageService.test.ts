// packages/plugin-message/src/messageService.test.ts
// 消息业务 service 单测（施工单 2026-07-04 001 硬切换）。
//
// 验证：
//   - 4 个最小方法（listMessages / getMessage / sendTextMessage /
//     subscribeMessages）直接转发到稳定长寿 endpoint service；
//   - sendTextMessage 固定带 `recipientAppId = keymaster.message`；
//   - 不再使用 `subscriptionSource` / `createSystemMessageClient` 旧接口。

import { describe, expect, it, vi } from "vitest";
import type {
  AppMsgEndpointService,
  AppMsgMessage,
  AppMsgOnlineResult
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

function makeFakeEndpointService(): {
  service: AppMsgEndpointService;
  calls: { method: string; args: unknown }[];
} {
  const calls: { method: string; args: unknown }[] = [];
  const service: AppMsgEndpointService = {
    endpoint: { kind: "plugin", id: "keymaster.message" },
    isReady: () => true,
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
      calls.push({
        method: "subscribeMessages",
        args: { handlerPresent: typeof handler === "function" }
      });
      return () => undefined;
    }),
    subscribeLocalChanges: vi.fn((handler) => {
      calls.push({
        method: "subscribeLocalChanges",
        args: { handlerPresent: typeof handler === "function" }
      });
      return () => undefined;
    }),
    checkOnline: vi.fn(async (hexes): Promise<AppMsgOnlineResult> => {
      const out: AppMsgOnlineResult = {};
      for (const h of hexes) out[h] = "online";
      return out;
    })
  };
  return { service, calls };
}

describe("createMessageService (stable endpoint service)", () => {
  it("isReady delegates to endpoint service", () => {
    const { service } = makeFakeEndpointService();
    const ms = createMessageService(service);
    expect(ms.isReady()).toBe(true);
  });

  it("isReady reflects endpoint service not-ready", () => {
    const service: AppMsgEndpointService = {
      endpoint: { kind: "plugin", id: "keymaster.message" },
      isReady: () => false,
      sendMessage: async () => ({ messageId: "", createdAtMs: 0 }),
      listMessages: async () => ({ items: [], hasMore: false }),
      getMessage: async () => null,
      subscribeMessages: () => () => undefined,
      checkOnline: async () => ({})
    };
    const ms = createMessageService(service);
    expect(ms.isReady()).toBe(false);
  });

  it("listMessages delegates to endpoint service", async () => {
    const { service, calls } = makeFakeEndpointService();
    const ms = createMessageService(service);
    const items = await ms.listMessages({ limit: 50 });
    expect(items.length).toBe(1);
    expect(calls.some((c) => c.method === "listMessages")).toBe(true);
  });

  it("getMessage delegates to endpoint service", async () => {
    const { service, calls } = makeFakeEndpointService();
    const ms = createMessageService(service);
    const got = await ms.getMessage("42");
    expect(got?.messageId).toBe("1");
    const lastGet = [...calls].reverse().find((c) => c.method === "getMessage");
    expect((lastGet?.args as { messageId: string }).messageId).toBe("42");
  });

  it("sendTextMessage pins recipientAppId = keymaster.message", async () => {
    const { service, calls } = makeFakeEndpointService();
    const ms = createMessageService(service);
    await ms.sendTextMessage({
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

  it("rejects an invalid contact public key before invoking the provider", async () => {
    const { service, calls } = makeFakeEndpointService();
    const ms = createMessageService(service);
    await expect(ms.sendTextMessage({
      recipientPublicKeyHex: "not-a-compressed-public-key",
      body: "hello"
    })).rejects.toThrow("invalid_target");
    expect(calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  it("sendTextMessage propagates not_ready error from endpoint service", async () => {
    const service: AppMsgEndpointService = {
      endpoint: { kind: "plugin", id: "keymaster.message" },
      isReady: () => false,
      sendMessage: async () => {
        throw new Error("not_ready: no current owner");
      },
      listMessages: async () => ({ items: [], hasMore: false }),
      getMessage: async () => null,
      subscribeMessages: () => () => undefined,
      checkOnline: async () => ({})
    };
    const ms = createMessageService(service);
    await expect(
      ms.sendTextMessage({ recipientPublicKeyHex: OWNER, body: "x" })
    ).rejects.toThrow(/not_ready/);
  });

  it("subscribeMessages forwards handler to endpoint service", () => {
    const { service, calls } = makeFakeEndpointService();
    const ms = createMessageService(service);
    const handler = vi.fn();
    const off = ms.subscribeMessages(handler);
    expect(typeof off).toBe("function");
    expect(calls.some((c) => c.method === "subscribeMessages")).toBe(true);
  });

  it("subscribeChanges uses local projection changes instead of replaying sync as live messages", () => {
    const { service, calls } = makeFakeEndpointService();
    const ms = createMessageService(service);
    const off = ms.subscribeChanges(vi.fn());
    expect(typeof off).toBe("function");
    expect(calls.some((c) => c.method === "subscribeLocalChanges")).toBe(true);
  });

  // endpoint service 内部已自动迁移订阅；本 service **不**暴露
  // subscriptionSource / subscription token。
});
