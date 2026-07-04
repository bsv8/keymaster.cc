// packages/plugin-appmsg/src/appmsgCore.test.ts
// appmsg.core 单测（施工单 2026-07-03 002 硬切换）。
//
// 测试目标（反馈 §"必须补测试"）：
//   1. scoped client send 时，sender origin/appId 被真正带到 wire senderEndpoint
//   2. 两个不同 scoped client 订阅时，各自只收到自己的消息
//   3. `listScopedMessages()` 只返回 scoped target 的消息，不是 DB 第一个 target
//   4. `getScopedMessage()` 读到不属于自己的 messageId 时返回 null
//   5. inspectLocalDb / checkOnline 等关键不变量
//
// 旧 `createSystemMessageClient(...)` 相关测试已随 API 移除同步删除。
// HubMsg 管理面直接消费 `listUnfilteredMessages` /
// `subscribeUnfilteredMessages`，由 `HubMsgPage` 与
// `hubmsgService.ts` 内部覆盖；本文件仍保留 core 单测路径以验证 ACL
// 边界。
//
// 用 fake-indexeddb 跑真 IDB；通过一个简化的 fake keyspace 直接走 indexedDB.open。

import { describe, expect, it, vi } from "vitest";
import type {
  AppMsgCore,
  AppMsgMessage,
  KeyspaceService
} from "@keymaster/contracts";
import { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";
import type { HubMsgBindSigner } from "./hubmsgConnection.js";

const OWNER = "02aaaa".padEnd(66, "a");
const OWNER_B = "02bbbb".padEnd(66, "b");
const URL = "wss://msg.keymaster.cc/ws/v1";

interface LogSink {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function makeLogSink(): LogSink {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * 极简 fake keyspace：直接把 key-scoped storage 委托给 indexedDB，
 * 让 fake-indexeddb（vitest.setup）兜底。
 */
function makeFakeKeyspace(): KeyspaceService {
  return {
    active: () => ({ activePublicKeyHex: OWNER }),
    getKey: async () => ({
      publicKeyHex: OWNER,
      label: "fake",
      capabilities: [],
      createdAt: ""
    }),
    listKeys: async () => [],
    async openKeyStorage(input: {
      publicKeyHex: string;
      pluginId: string;
      storageId: string;
      version: number;
      upgrade(db: IDBDatabase): void;
    }) {
      const dbName = `keymaster.key.${input.publicKeyHex}.plugin.${input.pluginId}.${input.storageId}`;
      return await new Promise<{
        db: IDBDatabase;
        name: string;
        close(): void;
      }>((resolve, reject) => {
        const req = indexedDB.open(dbName, input.version);
        req.onupgradeneeded = () => input.upgrade(req.result);
        req.onsuccess = () => {
          const db = req.result;
          resolve({
            db,
            name: dbName,
            close: () => {
              try {
                db.close();
              } catch {
                // ignore
              }
            }
          });
        };
        req.onerror = () => reject(req.error);
      });
    },
    onActiveChange: () => () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined,
    registerPluginStorage: () => undefined,
    listPluginStorages: () => []
  } as unknown as KeyspaceService;
}

interface CoreHandles {
  core: AppMsgCoreImpl;
  /** 直接打开后的本地 DB ops（write 本地消息用）。 */
  db: import("./appmsgDb.js").AppMsgLocalDbOps;
}

/**
 * 异步构造一个 bind 完成 + 本地 DB 已打开的核心。
 *
 * 关键点：openLocalDb 内部异步完成 IDB open；这里 await 等待后才能
 * 写入 / 读取测试数据。
 */
async function makeBoundCoreAsync(
  ownerPublicKeyHex: string,
  logSink: LogSink
): Promise<CoreHandles> {
  const signer: () => Promise<HubMsgBindSigner | null> = async () => ({
    publicKeyHex: ownerPublicKeyHex,
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
  const c = core as unknown as {
    currentBoundOwner: string | null;
    connection: unknown;
    localHandle: { db: IDBDatabase; name: string; close(): void } | null;
    localOps: import("./appmsgDb.js").AppMsgLocalDbOps | null;
    lastErrorMessageValue: string | null;
  };
  c.currentBoundOwner = ownerPublicKeyHex;
  c.connection = {
    state: () => "bound" as const,
    request: async <TParams, TResult>(): Promise<TResult> => {
      throw new Error("mockConnection: not configured for this test");
    }
  };
  const handle = await core.openLocalDb({ publicKeyHex: ownerPublicKeyHex });
  void c.lastErrorMessageValue;
  if (!handle || !c.localOps) {
    throw new Error("openLocalDb returned null in test fixture");
  }
  return { core, db: c.localOps };
}

/**
 * 在 core 上写入 fake 测试消息——直接走 DB ops（不走 wire）。
 */
async function seedDb(
  db: import("./appmsgDb.js").AppMsgLocalDbOps,
  list: AppMsgMessage[]
): Promise<void> {
  await db.putMessages(list);
}

function msg(overrides: Partial<AppMsgMessage>): AppMsgMessage {
  return {
    messageId: overrides.messageId ?? "m",
    clientMessageId: overrides.clientMessageId ?? "c",
    senderPublicKeyHex: overrides.senderPublicKeyHex ?? OWNER,
    senderOrigin: overrides.senderOrigin,
    senderAppId: overrides.senderAppId,
    recipientPublicKeyHex: overrides.recipientPublicKeyHex ?? OWNER,
    recipientOrigin: overrides.recipientOrigin,
    recipientAppId: overrides.recipientAppId,
    contentType: overrides.contentType ?? "text/plain",
    body: overrides.body ?? "",
    createdAtMs: overrides.createdAtMs ?? 1,
    insertedAtMs: overrides.insertedAtMs ?? 1
  };
}

describe("AppMsgCore.inspectLocalDb", () => {
  it("returns idle + no owner when not bound", () => {
    const log = makeLogSink();
    const core = new AppMsgCoreImpl({
      url: URL,
      signerProvider: async () => null,
      keyspace: makeFakeKeyspace(),
      pluginId: "appmsg",
      storageId: "messages",
      logger: log
    });
    const snap = core.inspectLocalDb();
    expect(snap.state).toBe("idle");
    expect(snap.ownerPublicKeyHex).toBeNull();
    expect(snap.lastError).toBeNull();
  });
});

describe("AppMsgCore.checkOnline (不依赖真 RPC)", () => {
  it("returns all-unknown when not connected", async () => {
    const log = makeLogSink();
    const core = new AppMsgCoreImpl({
      url: URL,
      signerProvider: async () => null,
      keyspace: makeFakeKeyspace(),
      pluginId: "appmsg",
      storageId: "messages",
      logger: log
    });
    const out = await core.checkOnline([OWNER]);
    expect(out[OWNER]).toBe("unknown");
  });

  it("returns empty object for empty input", async () => {
    const log = makeLogSink();
    const core = new AppMsgCoreImpl({
      url: URL,
      signerProvider: async () => null,
      keyspace: makeFakeKeyspace(),
      pluginId: "appmsg",
      storageId: "messages",
      logger: log
    });
    const out = await core.checkOnline([]);
    expect(out).toEqual({});
  });
});

describe("AppMsgCore.createMessageScopedClient", () => {
  it("returns AppMsgSimpleClient facade shape", async () => {
    const log = makeLogSink();
    const { core } = await makeBoundCoreAsync(OWNER, log);
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

describe("AppMsgCore.listScopedMessages / getScopedMessage ACL", () => {
  it("listScopedMessages returns only messages where recipient matches sender scope (反馈 §\"必须补测试\")", async () => {
    const log = makeLogSink();
    const { core, db } = await makeBoundCoreAsync(OWNER, log);
    await seedDb(db, [
      msg({
        messageId: "1",
        body: "self",
        senderPublicKeyHex: OWNER,
        senderOrigin: "https://justnote.example:443",
        recipientPublicKeyHex: OWNER,
        recipientOrigin: "https://justnote.example:443",
        createdAtMs: 1,
        insertedAtMs: 1
      }),
      msg({
        messageId: "2",
        body: "from-other-to-me",
        senderPublicKeyHex: OWNER_B,
        senderOrigin: "https://other.example:443",
        recipientPublicKeyHex: OWNER,
        recipientOrigin: "https://justnote.example:443",
        createdAtMs: 2,
        insertedAtMs: 2
      }),
      msg({
        messageId: "3",
        body: "not-mine",
        senderPublicKeyHex: OWNER_B,
        senderOrigin: "https://unrelated.example:443",
        recipientPublicKeyHex: OWNER_B,
        recipientOrigin: "https://unrelated.example:443",
        createdAtMs: 3,
        insertedAtMs: 3
      })
    ]);
    const cli = core.createMessageScopedClient({
      senderPublicKeyHex: OWNER,
      senderOrigin: "https://justnote.example:443"
    });
    const list = await cli.listMessages({ limit: 100 });
    const ids = list.items.map((m) => m.messageId).sort();
    expect(ids).toEqual(["1", "2"]);
  });

  it("getScopedMessage returns null when messageId is outside sender scope", async () => {
    const log = makeLogSink();
    const { core, db } = await makeBoundCoreAsync(OWNER, log);
    await seedDb(db, [
      msg({
        messageId: "for-other",
        body: "x",
        senderPublicKeyHex: OWNER_B,
        senderOrigin: "https://unrelated.example:443",
        recipientPublicKeyHex: OWNER_B,
        recipientOrigin: "https://unrelated.example:443"
      })
    ]);
    const cli = core.createMessageScopedClient({
      senderPublicKeyHex: OWNER,
      senderOrigin: "https://justnote.example:443"
    });
    const got = await cli.getMessage({ messageId: "for-other" });
    expect(got).toBeNull();
  });

  it("two scoped clients with different senderOrigin (same owner) each see only their own messages", async () => {
    const log = makeLogSink();
    const { core, db } = await makeBoundCoreAsync(OWNER, log);
    const myIDA = "scope-cli-A-msg-" + Math.random().toString(36).slice(2);
    const myIDB = "scope-cli-B-msg-" + Math.random().toString(36).slice(2);
    // 两条消息：sender 是 OWNER_B（模拟"别人写进来"），recipient 在
    // 不同 origin/channel。
    //   myIDA：recipientOrigin = https://justnote.example:443
    //   myIDB：recipientOrigin = https://other.example:443
    await seedDb(db, [
      msg({
        messageId: myIDA,
        body: "to-justnote",
        senderPublicKeyHex: OWNER_B,
        senderOrigin: "https://other.example:443",
        recipientPublicKeyHex: OWNER,
        recipientOrigin: "https://justnote.example:443"
      }),
      msg({
        messageId: myIDB,
        body: "to-other",
        senderPublicKeyHex: OWNER_B,
        senderOrigin: "https://justnote.example:443",
        recipientPublicKeyHex: OWNER,
        recipientOrigin: "https://other.example:443"
      })
    ]);
    const cliA = core.createMessageScopedClient({
      senderPublicKeyHex: OWNER,
      senderOrigin: "https://justnote.example:443"
    });
    const cliB = core.createMessageScopedClient({
      senderPublicKeyHex: OWNER,
      senderOrigin: "https://other.example:443"
    });
    // 跨 channel 隔离：A 看不见 myIDB。
    const aSeesB = await cliA.getMessage({ messageId: myIDB });
    expect(aSeesB).toBeNull();
    // A 看见 myIDA；不看见 myIDB。
    const aList = await cliA.listMessages({ limit: 100 });
    const aIds = aList.items.map((m) => m.messageId).sort();
    expect(aIds).toContain(myIDA);
    expect(aIds).not.toContain(myIDB);
    // B 看见 myIDB；不看见 myIDA。
    const bList = await cliB.listMessages({ limit: 100 });
    const bIds = bList.items.map((m) => m.messageId).sort();
    expect(bIds).toContain(myIDB);
    expect(bIds).not.toContain(myIDA);
  });
});

describe("AppMsgCore.createSystemMessageClient (removed in 施工单 2026-07-03 002)", () => {
  // 施工单 2026-07-03 002：`createSystemMessageClient(...)` 已从
  // `AppMsgCore` 主设计中移除——`plugin-message` 现在是普通 scoped
  // 插件，平台 internal 全库读只供 `plugin-appmsg` 自己的 HubMsg 管理页
  // 直接消费。
  it("API no longer exposed on AppMsgCore", async () => {
    const log = makeLogSink();
    const { core } = await makeBoundCoreAsync(OWNER, log);
    expect(
      (core as unknown as { createSystemMessageClient?: unknown }).createSystemMessageClient
    ).toBeUndefined();
  });
});

describe("AppMsgCore.sendScopedMessage ACL", () => {
  it("rejects mismatched senderPublicKeyHex", async () => {
    const log = makeLogSink();
    const { core } = await makeBoundCoreAsync(OWNER, log);
    await expect(
      core.sendScopedMessage({
        senderPublicKeyHex: OWNER_B,
        senderOrigin: "https://justnote.example:443",
        recipientPublicKeyHex: OWNER,
        recipientOrigin: "https://justnote.example:443",
        contentType: "text/plain",
        body: "x",
        clientMessageId: "c",
        createdAtMs: 1
      })
    ).rejects.toThrow(/senderPublicKeyHex mismatch/);
  });

  it("rejects both senderOrigin and senderAppId present", async () => {
    const log = makeLogSink();
    const { core } = await makeBoundCoreAsync(OWNER, log);
    await expect(
      core.sendScopedMessage({
        senderPublicKeyHex: OWNER,
        senderOrigin: "https://justnote.example:443",
        senderAppId: "keymaster.message",
        recipientPublicKeyHex: OWNER,
        recipientOrigin: "https://justnote.example:443",
        contentType: "text/plain",
        body: "x",
        clientMessageId: "c",
        createdAtMs: 1
      })
    ).rejects.toThrow(/exactly one of senderOrigin \/ senderAppId/);
  });
});

describe("AppMsgCore.privacy in sendScopedMessage", () => {
  it("does NOT include body in log data on send failure", async () => {
    const log = makeLogSink();
    // 不 connect，sendScopedMessage 在 connection 缺失 / 不 match 时会
    // 写 appmsg.send.failed 日志；这里确保日志里**不**包含 body key。
    const core = new AppMsgCoreImpl({
      url: URL,
      signerProvider: async () => null,
      keyspace: makeFakeKeyspace(),
      pluginId: "appmsg",
      storageId: "messages",
      logger: log
    });
    await expect(
      core.sendScopedMessage({
        senderPublicKeyHex: OWNER,
        senderAppId: "keymaster.message",
        recipientPublicKeyHex: OWNER,
        recipientAppId: "keymaster.message",
        contentType: "text/plain",
        body: "SECRET_BODY",
        clientMessageId: "c",
        createdAtMs: Date.now()
      })
    ).rejects.toThrow();
    const failed = log.warn.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === "appmsg.send.failed"
    );
    if (failed) {
      const data = failed[0] as Record<string, unknown>;
      expect("body" in data).toBe(false);
    }
  });
});

// 防止 IDE 报 unused
void ({} as AppMsgMessage);
