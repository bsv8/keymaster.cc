// packages/plugin-appmsg/src/appmsgCore.test.ts
// appmsg.core 单测（施工单 2026-07-02 001）。
//
// 覆盖（不依赖真 WebSocket / 真 HubMsg server）：
//   1. inspectConnection() 在 idle / 无 owner 状态下返回正确快照。
//   2. createPluginScopedClient(endpointId) 登记 → listKnownPluginEndpoints()
//      列出，重复登记幂等。
//   3. countScopes() 在未连接时：每个 scope 都返回 error=not connected。
//   4. countScopes([]) 直接返回空数组（不发请求）。
//   5. listKnownOrigins() 在未连接时 reject。
//   6. 隐私边界：send 失败的日志里不出现 body 字段。
//   7. 日志事件名：与施工单 7.x 命名对齐（appmsg.send.* / .connect.*）。
//
// 不覆盖（需要真 HubMsg 联调，不在本单范围）：
//   - 已 bound 时 countScopes 走真 RPC：走 HubMsg 仓 e2e 测试。
//   - 已 bound 时 listKnownOrigins 走真 RPC：同上。
//   - 完整 send / receive 链路：跨仓 fixture 测。
import { describe, expect, it, vi } from "vitest";
import {
  APPMESSAGE_CORE_CAPABILITY,
  type AppMsgCore
} from "@keymaster/contracts";
import { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";
import type { HubMsgBindSigner } from "./hubmsgConnection.js";

const OWNER = "02aaaa".padEnd(66, "a");
const URL = "wss://msg.keymaster.cc/ws/v1";
const SAMPLE_EP_ORIGIN = { kind: "origin" as const, id: "https://justnote.example:443" };
const SAMPLE_EP_PLUGIN = { kind: "plugin" as const, id: "keymaster.test.plugin" };

interface LogSink {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function makeLogSink(): LogSink {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCore(logSink: LogSink = makeLogSink()): { core: AppMsgCore; log: LogSink } {
  const signer: () => Promise<HubMsgBindSigner | null> = async () => ({
    publicKeyHex: OWNER,
    sign: async () => "00".repeat(64)
  });
  const cfg: AppMsgCoreConfig = {
    url: URL,
    signerProvider: signer,
    logger: logSink
  };
  const core = new AppMsgCoreImpl(cfg);
  return { core, log: logSink };
}

describe("AppMsgCore.inspectConnection (施工单 2026-07-02 001)", () => {
  it("returns idle + no owner + zero timestamps when not bound", () => {
    const { core } = makeCore();
    const snap = core.inspectConnection();
    expect(snap.state).toBe("idle");
    expect(snap.ownerPublicKeyHex).toBeNull();
    expect(snap.url).toBe(URL);
    expect(snap.lastBoundAtMs).toBe(0);
    expect(snap.lastError).toBeNull();
    expect(snap.lastReceivedAtMs).toBe(0);
  });

  it("exposes the HubMsg URL from config", () => {
    const { core } = makeCore();
    const snap = core.inspectConnection();
    expect(snap.url).toBe(URL);
  });
});

describe("AppMsgCore.pluginEndpointRegistry (施工单 2026-07-02 001)", () => {
  it("listKnownPluginEndpoints returns empty set initially", () => {
    const { core } = makeCore();
    expect(core.listKnownPluginEndpoints()).toEqual([]);
  });

  it("createPluginScopedClient registers endpoint ids idempotently", () => {
    const { core } = makeCore();
    core.createPluginScopedClient("keymaster.poker");
    core.createPluginScopedClient("keymaster.collectibles");
    // 重复登记幂等
    core.createPluginScopedClient("keymaster.poker");
    expect([...core.listKnownPluginEndpoints()].sort()).toEqual([
      "keymaster.collectibles",
      "keymaster.poker"
    ]);
  });
});

describe("AppMsgCore.countScopes (施工单 2026-07-02 001)", () => {
  it("returns [] for empty input without sending any request", async () => {
    const { core } = makeCore();
    const out = await core.countScopes([]);
    expect(out).toEqual([]);
  });

  it("when not connected: every scope gets error, no counts", async () => {
    const { core } = makeCore();
    const scopes = [
      { ownerPublicKeyHex: OWNER, endpoint: SAMPLE_EP_ORIGIN },
      { ownerPublicKeyHex: OWNER, endpoint: SAMPLE_EP_PLUGIN }
    ];
    const out = await core.countScopes(scopes);
    expect(out).toHaveLength(2);
    const first = out[0]!;
    const second = out[1]!;
    expect(first.counts).toBeNull();
    expect(first.error).toMatch(/not connected/i);
    expect(first.scope).toEqual(scopes[0]);
    expect(second.counts).toBeNull();
    expect(second.error).toMatch(/not connected/i);
    expect(second.scope).toEqual(scopes[1]);
  });

  it("input order is preserved in result", async () => {
    const { core } = makeCore();
    const a = { ownerPublicKeyHex: OWNER, endpoint: SAMPLE_EP_ORIGIN };
    const b = { ownerPublicKeyHex: OWNER, endpoint: SAMPLE_EP_PLUGIN };
    const out = await core.countScopes([a, b]);
    expect(out.map((o) => o.scope)).toEqual([a, b]);
  });
});

describe("AppMsgCore.listKnownOrigins (施工单 2026-07-02 001)", () => {
  it("rejects when not connected", async () => {
    const { core } = makeCore();
    await expect(core.listKnownOrigins()).rejects.toThrow(/not connected/i);
  });
});

describe("AppMsgCore.logging.privacy (施工单 2026-07-02 001 §4.5)", () => {
  it("send failure logs use appmsg.send.failed event name (NOT the level name)", async () => {
    const log = makeLogSink();
    const { core } = makeCore(log);
    await expect(
      core.send({
        sender: { ownerPublicKeyHex: OWNER, endpoint: SAMPLE_EP_PLUGIN },
        recipientOwnerPublicKeyHex: OWNER,
        recipientEndpoint: SAMPLE_EP_ORIGIN,
        contentType: "text/plain",
        body: "secret body content",
        clientMessageId: "c-1",
        createdAtMs: Date.now()
      })
    ).rejects.toThrow();
    // 关键：必须用真实业务事件 appmsg.send.failed，**不**是 warn 自身。
    const failed = log.warn.mock.calls.find((c) => c[0]?.event === "appmsg.send.failed");
    expect(failed, "expected appmsg.send.failed to be logged").toBeTruthy();
  });

  it("send failure log entry does NOT contain the body field", async () => {
    const log = makeLogSink();
    const { core } = makeCore(log);
    await expect(
      core.send({
        sender: { ownerPublicKeyHex: OWNER, endpoint: SAMPLE_EP_PLUGIN },
        recipientOwnerPublicKeyHex: OWNER,
        recipientEndpoint: SAMPLE_EP_ORIGIN,
        contentType: "text/markdown",
        body: "super secret markdown body",
        clientMessageId: "c-2",
        createdAtMs: Date.now()
      })
    ).rejects.toThrow();
    const failed = log.warn.mock.calls.find((c) => c[0]?.event === "appmsg.send.failed");
    expect(failed).toBeTruthy();
    const data = failed![0] as Record<string, unknown>;
    expect("body" in data).toBe(false);
  });
});

describe("AppMsgCore.diagnostics.refresh logging (施工单 2026-07-02 001 §7.4)", () => {
  it("logDiagnosticsRefreshFailed emits appmsg.diagnostics.refresh.failed with stage", async () => {
    const log = makeLogSink();
    const { core } = makeCore(log);
    await core.logDiagnosticsRefreshFailed({
      stage: "list_known_origins",
      err: "some failure",
      durationMs: 42
    });
    const err = log.error.mock.calls.find(
      (c) => c[0]?.event === "appmsg.diagnostics.refresh.failed"
    );
    expect(err, "expected appmsg.diagnostics.refresh.failed to be logged").toBeTruthy();
    const data = err![0] as Record<string, unknown>;
    expect(data.stage).toBe("list_known_origins");
    expect(data.err).toBe("some failure");
    expect(data.durationMs).toBe(42);
  });

  it("logDiagnosticsRefreshFailed does not throw even if logger throws", async () => {
    // 模拟 logger 抛错的极端情况：核心方法必须不冒泡
    const badLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => {
        throw new Error("logger boom");
      }
    };
    const signer: () => Promise<HubMsgBindSigner | null> = async () => ({
      publicKeyHex: OWNER,
      sign: async () => "00".repeat(64)
    });
    const core = new AppMsgCoreImpl({
      url: URL,
      signerProvider: signer,
      logger: badLogger
    });
    // 不应抛错
    await expect(
      core.logDiagnosticsRefreshFailed({ stage: "x", err: "y", durationMs: 1 })
    ).resolves.toBeUndefined();
  });
});

describe("AppMsgCore.loggerBridge (施工单 2026-07-02 001 — manifest bridge 保留 event)", () => {
  // 这个测试套件测 manifest 里 logger bridge 的关键不变量：
  // 当 core 内部 emitLog 输出 { event: "appmsg.send.failed", ... } 时，
  // bridge 必须把 ctx.logger.warn 的顶层 event 字段写成 "appmsg.send.failed"，
  // **不**是 "warn"。这是 /settings/logs 按 event 检索能命中业务事件的前提。
  //
  // 实际 bridge 在 manifest.ts 里；这里通过构造一个同形 bridge 验证
  // 形状契约。
  it("bridge-shaped function passes through the original event name", () => {
    // 模拟 manifest bridge 的形状
    const captured: Array<{ event: string; data: Record<string, unknown> }> = [];
    const fakeLogger = {
      info: (i: Record<string, unknown>) =>
        captured.push({ event: String(i.event), data: i }),
      warn: (i: Record<string, unknown>) =>
        captured.push({ event: String(i.event), data: i }),
      error: (i: Record<string, unknown>) =>
        captured.push({ event: String(i.event), data: i })
    };
    // 复刻 manifest bridge 的逻辑
    const bridge = {
      info: (input: unknown) => {
        const obj = (input ?? {}) as Record<string, unknown>;
        const ev = typeof obj.event === "string" ? obj.event : "info";
        fakeLogger.info({ scope: "x", event: ev, message: "", data: obj });
      },
      warn: (input: unknown) => {
        const obj = (input ?? {}) as Record<string, unknown>;
        const ev = typeof obj.event === "string" ? obj.event : "warn";
        fakeLogger.warn({ scope: "x", event: ev, message: "", data: obj });
      },
      error: (input: unknown) => {
        const obj = (input ?? {}) as Record<string, unknown>;
        const ev = typeof obj.event === "string" ? obj.event : "error";
        fakeLogger.error({ scope: "x", event: ev, message: "", data: obj });
      }
    };

    bridge.warn({ event: "appmsg.send.failed", reason: "not_connected" });
    bridge.error({ event: "appmsg.diagnostics.refresh.failed", stage: "list_known_origins" });
    bridge.info({ event: "appmsg.connect.bound", ownerPublicKeyHex: "x" });

    // 关键断言：每个 captured 都有正确的 event 字段
    const events = captured.map((c) => c.event);
    expect(events).toContain("appmsg.send.failed");
    expect(events).toContain("appmsg.diagnostics.refresh.failed");
    expect(events).toContain("appmsg.connect.bound");
    // 反向断言：没有任何 event 字段被覆盖成 "info" / "warn" / "error"
    // （除非业务事件本身就叫这个名）
    const fallbacks = captured.filter(
      (c) => c.event === "warn" || c.event === "error" || c.event === "info"
    );
    expect(fallbacks).toHaveLength(0);
  });

  it("bridge falls back to level name when input has no event field", () => {
    const captured: Array<{ event: string }> = [];
    const fakeLogger = {
      info: (i: Record<string, unknown>) => captured.push({ event: String(i.event) }),
      warn: (i: Record<string, unknown>) => captured.push({ event: String(i.event) }),
      error: (i: Record<string, unknown>) => captured.push({ event: String(i.event) })
    };
    const bridge = {
      warn: (input: unknown) => {
        const obj = (input ?? {}) as Record<string, unknown>;
        const ev = typeof obj.event === "string" ? obj.event : "warn";
        fakeLogger.warn({ event: ev });
      }
    };
    bridge.warn({ reason: "no event field" });
    const captured0 = captured[0]!;
    expect(captured0.event).toBe("warn");
  });
});

describe("AppMsgCore.capability (contracts surface)", () => {
  it("exposes appmsg.core capability key", () => {
    expect(APPMESSAGE_CORE_CAPABILITY).toBe("appmsg.core");
  });
});
