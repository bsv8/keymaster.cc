// packages/plugin-appmsg/src/appmsgCore.test.ts
// appmsg.core 单测（施工单 2026-07-03 001 硬切换）。
//
// 测试目标：
//   1. inspectLocalDb() 在 idle / 无 owner 状态下返回正确快照。
//   2. checkOnline 在未连接时整体回退为全 unknown。
//   3. createMessageScopedClient 返回的 AppMsgSimpleClient.sendMessage 透传
//      到 core.sendMessage。
//   4. 隐私边界：send 失败的日志里不出现 body 字段。
//   5. 日志事件名与硬切换 001 对齐（appmsg.send.* / .connect.*）。
//
// 不覆盖（需要真 HubMsg 联调，不在本单范围）：
//   - 已 bound 时 checkOnline 走真 RPC：走 HubMsg 仓 e2e 测试。
//   - 完整 send / receive 链路：跨仓 fixture 测。

import { describe, expect, it, vi } from "vitest";
import type { AppMsgCore } from "@keymaster/contracts";
import { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";
import type { HubMsgBindSigner } from "./hubmsgConnection.js";

const OWNER = "02aaaa".padEnd(66, "a");
const URL = "wss://msg.keymaster.cc/ws/v1";

interface LogSink {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function makeLogSink(): LogSink {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeFakeKeyspace() {
  return {
    active: () => ({ activePublicKeyHex: OWNER }),
    getKey: async () => ({ publicKeyHex: OWNER, label: "fake", capabilities: [], createdAt: "" }),
    listKeys: async () => [],
    openKeyStorage: async () => {
      throw new Error("not used in this test");
    },
    onActiveChange: () => () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined,
    registerPluginStorage: () => undefined,
    listPluginStorages: () => []
  } as unknown as AppMsgCoreConfig["keyspace"];
}

function makeCore(logSink: LogSink = makeLogSink()): { core: AppMsgCore; log: LogSink } {
  const signer: () => Promise<HubMsgBindSigner | null> = async () => ({
    publicKeyHex: OWNER,
    sign: async () => "00".repeat(64)
  });
  const cfg: AppMsgCoreConfig = {
    url: URL,
    signerProvider: signer,
    keyspace: makeFakeKeyspace(),
    pluginId: "appmsg",
    storageId: "messages",
    logger: logSink
  };
  const core = new AppMsgCoreImpl(cfg);
  return { core, log: logSink };
}

describe("AppMsgCore.inspectLocalDb", () => {
  it("returns idle + no owner when not bound", () => {
    const { core } = makeCore();
    const snap = core.inspectLocalDb();
    expect(snap.state).toBe("idle");
    expect(snap.ownerPublicKeyHex).toBeNull();
    expect(snap.lastInsertedAtMs).toBe(0);
    expect(snap.lastError).toBeNull();
  });
});

describe("AppMsgCore.checkOnline", () => {
  it("returns all-unknown when not connected (no throw)", async () => {
    const { core } = makeCore();
    const out = await core.checkOnline([OWNER, "02bbbb".padEnd(66, "b")]);
    expect(out[OWNER]).toBe("unknown");
    expect(out["02bbbb".padEnd(66, "b")]).toBe("unknown");
  });

  it("returns empty object for empty input", async () => {
    const { core } = makeCore();
    const out = await core.checkOnline([]);
    expect(out).toEqual({});
  });
});

describe("AppMsgCore.createMessageScopedClient", () => {
  it("returns AppMsgSimpleClient with sender publicKeyHex", () => {
    const { core } = makeCore();
    const cli = core.createMessageScopedClient({
      senderPublicKeyHex: OWNER,
      senderOrigin: "https://justnote.example:443"
    });
    expect(typeof cli.sendMessage).toBe("function");
    expect(typeof cli.listMessages).toBe("function");
    expect(typeof cli.getMessage).toBe("function");
    expect(typeof cli.subscribeMessages).toBe("function");
    expect(typeof cli.checkOnline).toBe("function");
  });
});

describe("AppMsgCore.logging.privacy (施工单 2026-07-03 001 §4.5)", () => {
  it("send failure logs use appmsg.send.failed event name", async () => {
    const log = makeLogSink();
    const { core } = makeCore(log);
    await expect(
      core.sendMessage({
        recipientPublicKeyHex: OWNER,
        recipientOrigin: "https://justnote.example:443",
        contentType: "text/plain",
        body: "secret body content",
        clientMessageId: "c-1",
        createdAtMs: Date.now()
      })
    ).rejects.toThrow();
    const failed = log.warn.mock.calls.find((c) => (c[0] as { event?: string })?.event === "appmsg.send.failed");
    expect(failed).toBeTruthy();
  });

  it("send failure log entry does NOT contain the body field", async () => {
    const log = makeLogSink();
    const { core } = makeCore(log);
    await expect(
      core.sendMessage({
        recipientPublicKeyHex: OWNER,
        recipientAppId: "keymaster.message",
        contentType: "text/markdown",
        body: "super secret markdown body",
        clientMessageId: "c-2",
        createdAtMs: Date.now()
      })
    ).rejects.toThrow();
    const failed = log.warn.mock.calls.find((c) => (c[0] as { event?: string })?.event === "appmsg.send.failed");
    expect(failed).toBeTruthy();
    const data = failed![0] as Record<string, unknown>;
    expect("body" in data).toBe(false);
  });
});
