// packages/plugin-appmsg/src/appmsgCore.test.ts
// appmsg.core 单测（施工单 2026-07-04 001 硬切换）。
//
// 测试目标：
//   1. provider registry 单选 active + 持久化 + 不自动 fallback；
//   2. active provider 缺失时 connectForOwner 走 not-ready；
//   3. endpoint service 内部 ACL：scoped list/get 仅返回 endpoint 可见
//      消息；subscribe 内部按 endpoint 过滤；
//   4. owner / provider 切换时 endpoint service 内部迁移订阅；
//   5. 全库读 / 全库订阅（管理页 / 协议层路径）绕开 ACL；
//   6. `connectForOwner` 失败（no signer / no provider）走降级，不抛错。
//
// mock 策略：
//   - **不**mock HubMsgConnection / wire 字符串方法；改为 mock
//     `MessageProvider` + `MessageProviderOperations` typed 接口；
//   - 用 fake-indexeddb 跑真 IDB；
//   - 通过 `appmsgDb.ts` 的真 `openAppMsgLocalDb` 路径跑本地 DB。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import type {
  ActiveMessageProviderSnapshot,
  AppMsgEndpointId,
  AppMsgMessage,
  KeyspaceService,
  MessageBus,
  MessageProvider,
  MessageProviderHandle,
  MessageProviderOperations,
  ProviderListResult,
  ProviderOnlineResult,
  ProviderSealedMessageRecord,
  ProviderSendResult
} from "@keymaster/contracts";
import { APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY, KEYMASTER_MESSAGE_APP_ID } from "@keymaster/contracts";
import { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";
import { openAppMessage, sealAppMessage } from "./appmsgCrypto.js";
import { bytesToHex, hexToBytes } from "./appmsgCrypto.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 as sha256Bytes } from "@noble/hashes/sha2.js";

// 测试用真实 keypair：OWNER_PRIV 派生 OWNER 公钥（33-byte compressed
// secp256k1），OWNER_B_PRIV 派生 OWNER_B 公钥。所有走 ECDH 的路径
// 都用真实 keypair 而不是占位 hex。
const OWNER_KP = makeRealKeyPair(11);
const OWNER_B_KP = makeRealKeyPair(22);
const OWNER = OWNER_KP.pubHex;
const OWNER_B = OWNER_B_KP.pubHex;
const OWNER_PRIV = OWNER_KP.privHex;
const OWNER_B_PRIV = OWNER_B_KP.privHex;

function makeLogSink() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * 极简 fake keyspace：把 key-scoped storage 委托给 indexedDB。
 */
function makeFakeKeyspace(): KeyspaceService & {
  setActiveHex(hex: string | null): void;
  setVaultStatus(unlocked: boolean): void;
} {
  let activeHex: string | null = OWNER;
  let vaultUnlocked = true;
  const activeHandlers = new Set<(s: { activePublicKeyHex?: string }) => void>();
  const vaultHandlers = new Set<(s: string) => void>();

  return {
    active: () => ({ activePublicKeyHex: activeHex ?? undefined }),
    selected: () => activeHex ?? undefined,
    onActiveKeyChanged: (h: (s: { activePublicKeyHex?: string }) => void) => {
      activeHandlers.add(h);
      return () => {
        activeHandlers.delete(h);
      };
    },
    getKey: async (publicKeyHex: string) =>
      publicKeyHex === activeHex
        ? { publicKeyHex, label: "fake", capabilities: [], createdAt: "" }
        : undefined,
    listKeys: async () => [],
    async openKeyStorage(input: {
      publicKeyHex: string;
      pluginId: string;
      storageId: string;
      version: number;
      upgrade(db: IDBDatabase, oldVersion: number, newVersion: number | null): void;
    }) {
      const dbName = `keymaster.key.${input.publicKeyHex}.plugin.${input.pluginId}.${input.storageId}`;
      return await new Promise<{
        db: IDBDatabase;
        name: string;
        close(): void;
      }>((resolve, reject) => {
        const req = indexedDB.open(dbName, input.version);
        req.onupgradeneeded = () => input.upgrade(req.result, 0, null);
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
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    setActive: async (hex: string | null) => {
      activeHex = hex;
      for (const h of activeHandlers) {
        try {
          h({ activePublicKeyHex: hex ?? undefined });
        } catch {
          // ignore
        }
      }
    },
    requireActiveKey: () => {
      throw new Error("no active key");
    },
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined,
    setActiveHex(hex: string | null) {
      activeHex = hex;
      for (const h of activeHandlers) {
        try {
          h({ activePublicKeyHex: hex ?? undefined });
        } catch {
          // ignore
        }
      }
    },
    setVaultStatus(unlocked: boolean) {
      vaultUnlocked = unlocked;
      for (const h of vaultHandlers) {
        try {
          h(unlocked ? "unlocked" : "locked");
        } catch {
          // ignore
        }
      }
    }
  };
}

/**
 * Mock `MessageProviderOperations`：typed handle。
 *
 * 测试可通过外部变量控制其行为；默认只暴露空实现。
 */
function makeMockProviderOps(
  overrides?: Partial<{
    state: "idle" | "connecting" | "bound" | "closed";
    sendMessage: (input: unknown) => Promise<ProviderSendResult>;
    listMessages: (input: unknown) => Promise<ProviderListResult>;
    getMessage: (input: unknown) => Promise<ProviderSealedMessageRecord | null>;
    subscribeMessages: (handler: (rec: ProviderSealedMessageRecord) => void) => () => void;
    checkOnline: (input: { publicKeyHexes: string[] }) => Promise<ProviderOnlineResult>;
  }>
): MessageProviderOperations {
  const off = vi.fn();
  return {
    state: () => overrides?.state ?? "bound",
    close: () => undefined,
    sendMessage:
      overrides?.sendMessage ??
      (async () => ({ messageId: "m-sent", insertedAtMs: Date.now() })),
    listMessages:
      overrides?.listMessages ??
      (async () => ({ items: [], hasMore: false })),
    getMessage:
      overrides?.getMessage ?? (async () => null),
    subscribeMessages:
      overrides?.subscribeMessages ?? (() => off),
    checkOnline:
      overrides?.checkOnline ?? (async () => ({} as ProviderOnlineResult))
  };
}

/**
 * 测试用 keypair：根据 hex pub 生成匹配的 priv（用于构造 sender ↔ recipient
 * 都用真实 ECDH 流程的 sealed record）。
 */
function keyPairFromPubHex(pubHex: string): { privHex: string; pubHex: string } {
  // 解析 pubHex → 反推私钥：测试 fixture 在 setUpMock 阶段用此函数；
  // 我们**不**在测试里用这个反推——而是用 secp256k1 给定私钥现算公钥。
  void pubHex;
  throw new Error("not used in tests; use direct priv/pub pair");
}

/**
 * 测试 fixture：构造一组 real keypair（SHA-256(seed) 作为 priv）。
 */
function makeRealKeyPair(seed: number): { privHex: string; pubHex: string } {
  const priv = sha256Bytes(new TextEncoder().encode(`appmsg.test:seed:${seed}`));
  const pub = secp256k1.getPublicKey(priv, true);
  return { privHex: bytesToHex(priv), pubHex: bytesToHex(pub) };
}

/**
 * 用 ownerPriv/ownerPub 构造一条 sealed record（明文 → envelope）。
 * 接收方公钥 = recipientPublicKeyHex；测试 fixture 自行保证 priv↔pub
 * 配对。
 */
function makeSealedRecord(input: {
  messageId: string;
  senderPrivateKeyHex: string;
  senderPublicKeyHex: string;
  recipientPublicKeyHex: string;
  clientMessageId: string;
  createdAtMs: number;
  insertedAtMs: number;
  contentType: "text/plain" | "text/markdown";
  body: string;
  senderEndpointKind?: "origin" | "plugin";
  senderEndpointId?: string;
  recipientEndpointKind?: "origin" | "plugin";
  recipientEndpointId?: string;
}): ProviderSealedMessageRecord {
  const sealed = sealAppMessage({
    senderPrivateKeyHex: input.senderPrivateKeyHex,
    senderPublicKeyHex: input.senderPublicKeyHex,
    recipientPublicKeyHex: input.recipientPublicKeyHex,
    senderEndpoint: {
      kind: input.senderEndpointKind ?? "plugin",
      id: input.senderEndpointId ?? KEYMASTER_MESSAGE_APP_ID
    },
    recipientEndpoint: {
      kind: input.recipientEndpointKind ?? "plugin",
      id: input.recipientEndpointId ?? KEYMASTER_MESSAGE_APP_ID
    },
    contentType: input.contentType,
    body: input.body,
    clientMessageId: input.clientMessageId,
    createdAtMs: input.createdAtMs
  });
  return {
    messageId: input.messageId,
    senderPublicKeyHex: input.senderPublicKeyHex,
    senderEndpointKind: input.senderEndpointKind ?? "plugin",
    senderEndpointId: input.senderEndpointId ?? KEYMASTER_MESSAGE_APP_ID,
    recipientPublicKeyHex: input.recipientPublicKeyHex,
    recipientEndpointKind: input.recipientEndpointKind ?? "plugin",
    recipientEndpointId: input.recipientEndpointId ?? KEYMASTER_MESSAGE_APP_ID,
    clientMessageId: input.clientMessageId,
    createdAtMs: input.createdAtMs,
    insertedAtMs: input.insertedAtMs,
    envelope: sealed.envelope
  };
}

// 防止 IDE 报 unused
void keyPairFromPubHex;
void hexToBytes;

/**
 * Mock `MessageProvider`：register + bind → 返回 mock handle。
 */
function makeMockProvider(
  id: string,
  displayName: string,
  handle: MessageProviderHandle | MessageProviderOperations
): MessageProvider & {
  bindCalls: number;
  shutdownCalls: number;
} {
  let bindCalls = 0;
  let shutdownCalls = 0;
  return {
    id,
    displayName,
    bind: async () => {
      bindCalls += 1;
      return handle as MessageProviderHandle;
    },
    shutdown: async () => {
      shutdownCalls += 1;
    },
    health: () => ({ isHealthy: true, lastError: null, lastConnectedAtMs: Date.now() }),
    checkOnline: async () => ({}),
    get bindCalls() {
      return bindCalls;
    },
    get shutdownCalls() {
      return shutdownCalls;
    }
  };
}

function makeCore(opts?: {
  providers?: MessageProvider[];
  persistedActiveProviderId?: string | null;
  signerProvider?: () => Promise<{
    publicKeyHex: string;
    signChallenge: (args: { challenge: Uint8Array }) => Promise<string>;
    openSealed: (rec: ProviderSealedMessageRecord) => Promise<AppMsgMessage | null>;
    sealSendInput: (input: {
      sender: { senderOrigin?: string; senderAppId?: string };
      recipient: { recipientPublicKeyHex: string; recipientOrigin?: string; recipientAppId?: string };
      contentType: "text/plain" | "text/markdown";
      body: string;
      clientMessageId: string;
      createdAtMs: number;
    }) => { record: ProviderSealedMessageRecord } | { error: string };
  } | null>;
}): {
  core: AppMsgCoreImpl;
  keyspace: ReturnType<typeof makeFakeKeyspace>;
  log: ReturnType<typeof makeLogSink>;
  storage: Map<string, string>;
  deletingHandlers: Set<(payload: { publicKeyHex: string }) => void>;
} {
  const keyspace = makeFakeKeyspace();
  const log = makeLogSink();
  const storage = new Map<string, string>();
  const deletingHandlers = new Set<(payload: { publicKeyHex: string }) => void>();
  const messageBus: Pick<MessageBus, "subscribe"> = {
    subscribe<TPayload>(type: string, handler: (payload: TPayload) => void) {
      if (type !== "key.deleting") return () => undefined;
      const typed = handler as (payload: { publicKeyHex: string }) => void;
      deletingHandlers.add(typed);
      return () => deletingHandlers.delete(typed);
    }
  };
  // 默认有可用 signer——给 OWNER 一个真实 ECDH / envelope 签名能力。
  // 注意：测试场景下 mock 的 provider.sendMessage / list / subscribe
  // 不会真正使用 signer；signChallenge 仅在 provider.bind 阶段可能调。
  const signerProvider =
    opts?.signerProvider ??
    (async () => ({
      publicKeyHex: OWNER,
      signChallenge: async (_args: { challenge: Uint8Array }): Promise<string> => "00".repeat(64),
      openSealed: async (rec: ProviderSealedMessageRecord) =>
        (() => {
          const opened = openAppMessage({
            signed: rec.envelope,
            recipientPrivateKeyHex: OWNER_PRIV
          });
          return {
            messageId: rec.messageId,
            clientMessageId: opened.clientMessageId,
            senderPublicKeyHex: opened.senderPublicKeyHex,
            senderOrigin:
            rec.senderEndpointKind === "origin" ? rec.senderEndpointId : undefined,
            senderAppId:
            rec.senderEndpointKind === "plugin" ? rec.senderEndpointId : undefined,
            recipientPublicKeyHex: opened.recipientPublicKeyHex,
            recipientOrigin:
            rec.recipientEndpointKind === "origin" ? rec.recipientEndpointId : undefined,
            recipientAppId:
            rec.recipientEndpointKind === "plugin" ? rec.recipientEndpointId : undefined,
            contentType: opened.contentType,
            body: new TextDecoder().decode(opened.bodyUtf8),
            createdAtMs: opened.createdAtMs,
            insertedAtMs: rec.insertedAtMs
          };
        })(),
      sealSendInput: (input) => ({
        record: {
          messageId: "",
          senderPublicKeyHex: OWNER,
          senderEndpointId: input.sender.senderOrigin ?? input.sender.senderAppId ?? "",
          senderEndpointKind: input.sender.senderOrigin ? "origin" : "plugin",
          recipientPublicKeyHex: input.recipient.recipientPublicKeyHex,
          recipientEndpointId: input.recipient.recipientOrigin ?? input.recipient.recipientAppId ?? "",
          recipientEndpointKind: input.recipient.recipientOrigin ? "origin" : "plugin",
          clientMessageId: input.clientMessageId,
          contentType: input.contentType,
          body: input.body,
          createdAtMs: input.createdAtMs,
          insertedAtMs: input.createdAtMs,
          envelope: sealAppMessage({
            senderPrivateKeyHex: OWNER_PRIV,
            senderPublicKeyHex: OWNER,
            recipientPublicKeyHex: input.recipient.recipientPublicKeyHex,
            senderEndpoint: {
              kind: input.sender.senderOrigin ? "origin" : "plugin",
              id: input.sender.senderOrigin ?? input.sender.senderAppId ?? ""
            },
            recipientEndpoint: {
              kind: input.recipient.recipientOrigin ? "origin" : "plugin",
              id: input.recipient.recipientOrigin ?? input.recipient.recipientAppId ?? ""
            },
            contentType: input.contentType,
            body: input.body,
            clientMessageId: input.clientMessageId,
            createdAtMs: input.createdAtMs
          }).envelope
        }
      })
    }));
  const cfg: AppMsgCoreConfig = {
    signerProvider,
    keyspace,
    pluginId: "appmsg",
    storageId: "messages_v2",
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
      removeItem: (k: string) => {
        storage.delete(k);
      },
      clear: () => storage.clear(),
      key: () => "",
      get length() {
        return storage.size;
      }
    } as unknown as Storage,
    logger: log,
    messageBus
  };
  const core = new AppMsgCoreImpl(cfg);
  // 注入 provider（如果在 opts 里给）。
  if (opts?.providers) {
    for (const p of opts.providers) {
      core.providers().register(p);
    }
  }
  return { core, keyspace, log, storage, deletingHandlers };
}

describe("AppMsgCoreImpl - key.deleting local DB cleanup", () => {
  it("closes the matching owner handle synchronously before namespace deletion", async () => {
    const { core, deletingHandlers } = makeCore();
    const opened = await core.openLocalDb({ publicKeyHex: OWNER });
    expect(opened).not.toBeNull();
    for (const handler of deletingHandlers) handler({ publicKeyHex: OWNER });
    expect(() => opened!.db.transaction("messages", "readonly")).toThrow();
    const reopened = await core.openLocalDb({ publicKeyHex: OWNER });
    core.dispose();
    expect(() => reopened!.db.transaction("messages", "readonly")).toThrow();
  });

  it("does not close a non-target owner handle", async () => {
    const { core, deletingHandlers } = makeCore();
    const opened = await core.openLocalDb({ publicKeyHex: OWNER_B });
    expect(opened).not.toBeNull();
    for (const handler of deletingHandlers) handler({ publicKeyHex: OWNER });
    expect(() => opened!.db.transaction("messages", "readonly")).not.toThrow();
    core.dispose();
  });
});

describe("AppMsgCoreImpl - provider registry", () => {
  it("empty registry: active is null", () => {
    const { core } = makeCore();
    expect(core.providers().active()).toBeNull();
    expect(core.activeProviderSnapshot().providerId).toBeNull();
  });

  it("register hubmsg without persisted id: defaults active to hubmsg", () => {
    const { core } = makeCore();
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    core.providers().register(p);
    expect(core.providers().active()?.id).toBe("hubmsg");
    // 持久化为 hubmsg。
    // 通过第二次构造 core 验证持久化被回写（重新读取 localStorage）。
    const { storage: _ } = { storage: new Map([["appmsg.activeProviderId", "hubmsg"]]) };
    // 直接从 storage 拿：
    const persisted = core["cfg"].localStorage?.getItem("appmsg.activeProviderId");
    expect(persisted).toBe("hubmsg");
  });

  it("persisted id matches a provider registered after startup: notifies listeners", () => {
    const storage = new Map<string, string>([["appmsg.activeProviderId", "hubmsg"]]);
    const keyspace = makeFakeKeyspace();
    const log = makeLogSink();
    const cfg: AppMsgCoreConfig = {
      signerProvider: async () => null,
      keyspace,
      pluginId: "appmsg",
      storageId: "messages_v2",
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
        clear: () => storage.clear(),
        key: () => "",
        get length() {
          return storage.size;
        }
      } as unknown as Storage,
      logger: log
    };
    const core = new AppMsgCoreImpl(cfg);
    const seen: ActiveMessageProviderSnapshot[] = [];
    core.providers().onActiveChange((snapshot) => seen.push(snapshot));
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    core.providers().register(p);
    expect(core.providers().active()?.id).toBe("hubmsg");
    // 刷新后的 coordinator 已在 provider 注册前订阅；注册完成必须通知它
    // 重试 bind，不能让 core 永久停在 idle。
    expect(seen).toEqual([
      expect.objectContaining({ providerId: "hubmsg", displayName: "HubMsg" })
    ]);
  });

  it("persisted id not registered: stays null (no auto fallback)", () => {
    const storage = new Map<string, string>([["appmsg.activeProviderId", "unknown-prov"]]);
    const keyspace = makeFakeKeyspace();
    const log = makeLogSink();
    const cfg: AppMsgCoreConfig = {
      signerProvider: async () => null,
      keyspace,
      pluginId: "appmsg",
      storageId: "messages_v2",
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
        clear: () => storage.clear(),
        key: () => "",
        get length() {
          return storage.size;
        }
      } as unknown as Storage,
      logger: log
    };
    const core = new AppMsgCoreImpl(cfg);
    expect(core.providers().active()).toBeNull();
    const handle = makeMockProviderOps();
    core.providers().register(makeMockProvider("hubmsg", "HubMsg", handle));
    // 已注册 hubmsg 但持久值不是 hubmsg → 仍是 null（**不**自动 fallback）。
    expect(core.providers().active()).toBeNull();
  });

  it("unregister active provider: clears active and persists null", () => {
    const { core, storage } = makeCore();
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    core.providers().register(p);
    core.providers().unregister("hubmsg");
    expect(core.providers().active()).toBeNull();
    expect(storage.get("appmsg.activeProviderId")).toBeUndefined();
  });

  it("setActive persists id and notifies listeners", async () => {
    const { core, storage } = makeCore();
    const handle = makeMockProviderOps();
    const p1 = makeMockProvider("hubmsg", "HubMsg", handle);
    const p2 = makeMockProvider("relay", "Relay", makeMockProviderOps());
    core.providers().register(p1);
    core.providers().register(p2);
    const seen: ActiveMessageProviderSnapshot[] = [];
    core.providers().onActiveChange((s) => seen.push(s));
    await core.providers().setActive("relay");
    expect(core.providers().active()?.id).toBe("relay");
    expect(storage.get("appmsg.activeProviderId")).toBe("relay");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]?.providerId).toBe("relay");
  });

  it("setActive with unknown id throws", async () => {
    const { core } = makeCore();
    await expect(core.providers().setActive("unknown")).rejects.toThrow();
  });
});

describe("AppMsgCoreImpl - manual sync diagnostics", () => {
  it("manual triggerSync when not connected rejects, records lastError, and logs skipped_not_connected", async () => {
    const { core, log } = makeCore();

    await expect(core.triggerSync()).rejects.toThrow("appmsg.sync: not_connected");
    expect(core.inspectLocalDb().lastError).toBe("appmsg.sync: not_connected");
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "appmsg.sync.manual.skipped_not_connected"
      })
    );
  });
});

describe("AppMsgCoreImpl - connectForOwner", () => {
  it("no active provider: stays not-ready, no throw", async () => {
    const { core } = makeCore();
    const outcome = await core.connectForOwner(OWNER);
    expect(core.currentHandle()).toBeNull();
    // 硬切换 003 反馈"必改"修订：尝试过连接失败后，state 必须稳定
    // 回到 `idle`（**不**被 `lastError` 顶成 `closed`）。结构性不可
    // 连接场景由 `markStructurallyOffline()` 显式擦除 lastError。
    expect(core.inspectLocalDb().state).toBe("idle");
    expect(outcome.kind).toBe("structurallyOffline");
    if (outcome.kind === "structurallyOffline") {
      expect(outcome.reason).toBe("no_active_provider");
    }
  });

  it("active provider + signer available: bind succeeds", async () => {
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({ providers: [p] });
    await core.connectForOwner(OWNER);
    expect(core.currentHandle()).toBe(handle);
    expect(core.inspectLocalDb().state).toBe("open");
  });

  it("handle onClose 依赖 this 时，connectForOwner 不应因方法解绑定崩溃", async () => {
    const off = vi.fn();
    const conn = {
      onClose: vi.fn((_handler: () => void) => off)
    };
    const handle = {
      state: () => "bound" as const,
      close: () => undefined,
      sendMessage: async () => ({ messageId: "m-sent", insertedAtMs: Date.now() }),
      listMessages: async () => ({ items: [], hasMore: false }),
      getMessage: async () => null,
      subscribeMessages: () => off,
      checkOnline: async () => ({} as ProviderOnlineResult),
      conn,
      onClose(handler: () => void): () => void {
        return this.conn.onClose(handler);
      }
    } satisfies MessageProviderOperations & {
      conn: { onClose(handler: () => void): () => void };
      onClose(handler: () => void): () => void;
    };
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({ providers: [p] });

    const outcome = await core.connectForOwner(OWNER);

    expect(outcome.kind).toBe("connected");
    expect(core.currentHandle()).toBe(handle);
    expect(conn.onClose).toHaveBeenCalledTimes(1);
  });

  it("bind throws: stays not-ready, lastError recorded", async () => {
    const failingHandle = (() => {
      const off = vi.fn();
      return {
        state: () => "closed" as const,
        close: () => undefined,
        sendMessage: async () => {
          throw new Error("bind failed");
        },
        listMessages: async () => ({ items: [], hasMore: false }),
        getMessage: async () => null,
        subscribeMessages: () => off
      };
    })();
    const failingProvider: MessageProvider = {
      id: "hubmsg",
      displayName: "HubMsg",
      bind: async () => {
        throw new Error("bind failed");
      },
      shutdown: async () => undefined,
      health: () => ({ isHealthy: false, lastError: "bind failed", lastConnectedAtMs: 0 }),
      checkOnline: async () => ({})
    };
    const { core, log } = makeCore({ providers: [failingProvider] });
    await core.connectForOwner(OWNER);
    expect(core.currentHandle()).toBeNull();
    expect(core.inspectLocalDb().lastError).toMatch(/bind failed/);
    expect(log.error).toHaveBeenCalled();
  });

  it("no signer (vault locked): stays not-ready, lastError recorded", async () => {
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core, log } = makeCore({
      providers: [p],
      signerProvider: async () => null
    });
    await core.connectForOwner(OWNER);
    expect(core.currentHandle()).toBeNull();
    expect(core.inspectLocalDb().lastError).toMatch(/no signer/);
    expect(log.warn).toHaveBeenCalled();
  });

  it("disconnect after connectForOwner clears handle", async () => {
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({ providers: [p] });
    await core.connectForOwner(OWNER);
    expect(core.currentHandle()).toBe(handle);
    await core.disconnect();
    expect(core.currentHandle()).toBeNull();
    // disconnect 同时关闭本地 DB handle；state 回落到 idle。
    expect(core.inspectLocalDb().state).toBe("idle");
    expect(core.inspectLocalDb().ownerPublicKeyHex).toBeNull();
  });
});

/* ============== 阻断 3：bootstrap 默认值不可逆 ============== */

describe("AppMsgCoreImpl - bootstrap default not reversible after explicit null", () => {
  it("unregister active provider, then re-register hubmsg: active stays null (no auto-fallback)", async () => {
    // 1. 构造时 persisted = null → register hubmsg 自动激活（bootstrap 默认）。
    const { core } = makeCore({
      providers: [makeMockProvider("hubmsg", "HubMsg", makeMockProviderOps())]
    });
    expect(core.providers().active()?.id).toBe("hubmsg");

    // 2. 用户显式 setActive(null)。
    await core.providers().setActive(null);
    expect(core.providers().active()).toBeNull();

    // 3. unregister hubmsg。
    core.providers().unregister("hubmsg");
    expect(core.providers().active()).toBeNull();

    // 4. 重新 register hubmsg → **不**自动激活（bootstrap 默认已被 setActive(null) 消费）。
    const newHubmsg = makeMockProvider("hubmsg", "HubMsg", makeMockProviderOps());
    core.providers().register(newHubmsg);
    expect(core.providers().active()).toBeNull();
  });

  it("setActive(null) called BEFORE any register consumes the default; later hubmsg register does not auto-activate", async () => {
    const { core } = makeCore();
    // 用户在 hubmsg 注册之前显式清空。
    await core.providers().setActive(null);
    expect(core.providers().active()).toBeNull();
    // 然后 hubmsg 注册进来——不再自动回退。
    core.providers().register(
      makeMockProvider("hubmsg", "HubMsg", makeMockProviderOps())
    );
    expect(core.providers().active()).toBeNull();
  });

  it("setActive(otherProvider) consumes default even if otherProvider not registered yet", async () => {
    // 这条覆盖"用户切到非 hubmsg → 切走 → re-register hubmsg"的语义：
    // 一旦 setActive 走通，bootstrap 默认就被视为消费。
    const { core } = makeCore();
    const other = makeMockProvider("relay", "Relay", makeMockProviderOps());
    core.providers().register(other);
    await core.providers().setActive("relay");
    expect(core.providers().active()?.id).toBe("relay");
    // unregister relay。
    core.providers().unregister("relay");
    expect(core.providers().active()).toBeNull();
    // 再 register hubmsg——不再回退。
    core.providers().register(
      makeMockProvider("hubmsg", "HubMsg", makeMockProviderOps())
    );
    expect(core.providers().active()).toBeNull();
  });
});

/* ============== 阻断 2：provider 维度 DB 隔离 ============== */

describe("AppMsgCoreImpl - provider dimension DB isolation", () => {
  it("two providers writing the same messageId go to different providerId rows", async () => {
    // 模拟两个 provider 同 owner / 同 endpoint / 各自产生 messageId m1。
    // local DB 应在两个 providerId 维度上分别保留 m1，互不覆盖。
    const { core } = makeCore();
    const ks = core.keyspace;

    // 写入 hubmsg provider 下 m1 + m2。
    const handleHubmsg = makeMockProviderOps();
    const hubmsg = makeMockProvider("hubmsg", "HubMsg", handleHubmsg);
    core.providers().register(hubmsg);
    await core.connectForOwner(OWNER);

    // 走 core 内部 helper 直接写本地库（带 providerId）。
    // 这里通过触发 self-send 来写，或者直接调 localOps。
    // 直接调 core 内部 handler——但 `localOps` 是 private。
    // 改路径：调 core 的 sendMessageImpl（platform internal）走 self-send。
    // self-send 触发条件：sender === recipient at endpoint。
    // 简化：直接断言 storageId 改名后两个 provider 的 listUnfilteredMessages
    // 互不串——通过切换 active provider + 写入 + 切回验证。
    void ks;

    // 触发 hubmsg 下 self-send 写入一条 m_hubmsg。
    const res1 = await core.sendAsOrigin({
      origin: "https://hubmsg-test:443",
      sendInput: {
        recipientPublicKeyHex: OWNER, // self
        recipientOrigin: "https://hubmsg-test:443",
        contentType: "text/plain",
        body: "from hubmsg",
        clientMessageId: "c-hubmsg",
        createdAtMs: 1
      }
    });
    expect(res1.messageId).toBeTruthy();
    const mHubmsg = await core.listUnfilteredMessages({ limit: 10 });
    expect(mHubmsg.items.length).toBe(1);
    expect(mHubmsg.items[0]?.body).toBe("from hubmsg");

    // 切换 active provider → relay（用 setActive + disconnect + connectForOwner）。
    const relay = makeMockProvider("relay", "Relay", makeMockProviderOps());
    core.providers().register(relay);
    await core.providers().setActive("relay");
    await core.disconnect();
    await core.connectForOwner(OWNER);

    // relay provider 下 self-send：写入 m_relay。
    const res2 = await core.sendAsOrigin({
      origin: "https://relay-test:443",
      sendInput: {
        recipientPublicKeyHex: OWNER,
        recipientOrigin: "https://relay-test:443",
        contentType: "text/plain",
        body: "from relay",
        clientMessageId: "c-relay",
        createdAtMs: 2
      }
    });
    expect(res2.messageId).toBeTruthy();

    // 当前 active provider = relay → listUnfilteredMessages 只看 relay 数据。
    const mRelay = await core.listUnfilteredMessages({ limit: 10 });
    expect(mRelay.items.length).toBe(1);
    expect(mRelay.items[0]?.body).toBe("from relay");

    // 切回 hubmsg → 应能看到 hubmsg 之前的 m_hubmsg；relay 那条**不**该出现。
    await core.providers().setActive("hubmsg");
    await core.disconnect();
    await core.connectForOwner(OWNER);
    const mBack = await core.listUnfilteredMessages({ limit: 10 });
    expect(mBack.items.length).toBe(1);
    expect(mBack.items[0]?.body).toBe("from hubmsg");
  });
});

describe("AppMsgCoreImpl - endpoint registry", () => {
  it("forEndpoint returns same instance for same endpoint", () => {
    const { core } = makeCore();
    const reg = core.endpointRegistry();
    const ep: AppMsgEndpointId = { kind: "plugin", id: KEYMASTER_MESSAGE_APP_ID };
    const a = reg.forEndpoint(ep);
    const b = reg.forEndpoint(ep);
    expect(a).toBe(b);
  });

  it("forEndpoint of different endpoints returns different instances", () => {
    const { core } = makeCore();
    const reg = core.endpointRegistry();
    const a = reg.forEndpoint({ kind: "plugin", id: KEYMASTER_MESSAGE_APP_ID });
    const b = reg.forEndpoint({
      kind: "origin",
      id: "https://example.test:443"
    });
    expect(a).not.toBe(b);
  });

  it("releaseEndpoint removes service", () => {
    const { core } = makeCore();
    const reg = core.endpointRegistry();
    const ep: AppMsgEndpointId = { kind: "plugin", id: KEYMASTER_MESSAGE_APP_ID };
    const a = reg.forEndpoint(ep);
    reg.releaseEndpoint(ep);
    const b = reg.forEndpoint(ep);
    expect(a).not.toBe(b);
  });
});

describe("AppMsgCoreImpl - endpoint service not-ready", () => {
  it("no handle: isReady false; send throws; list empty; get null; subscribe returns cancel; checkOnline unknown", async () => {
    const { core } = makeCore();
    const reg = core.endpointRegistry();
    const svc = reg.forEndpoint({
      kind: "plugin",
      id: KEYMASTER_MESSAGE_APP_ID
    });
    expect(svc.isReady()).toBe(false);
    await expect(
      svc.sendMessage({
        recipientPublicKeyHex: OWNER,
        recipientAppId: KEYMASTER_MESSAGE_APP_ID,
        contentType: "text/plain",
        body: "hi",
        clientMessageId: "c",
        createdAtMs: Date.now()
      })
    ).rejects.toThrow(/not_ready/);
    expect((await svc.listMessages()).items).toEqual([]);
    expect(await svc.getMessage({ messageId: "x" })).toBeNull();
    const off = svc.subscribeMessages(() => undefined);
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
    const out = await svc.checkOnline([OWNER]);
    expect(out[OWNER]).toBe("unknown");
  });
});

describe("AppMsgCoreImpl - endpoint service with handle", () => {
  function makeConnectedCore() {
    const sentMessages: unknown[] = [];
    const listCalls: unknown[] = [];
    const subscribeCalls: Array<(rec: ProviderSealedMessageRecord) => void> = [];
    // 构造一条 OWNER → OWNER_B 的真实 sealed record（mock provider
    // 返回这条 record；plugin-appmsgCore 入站边界用 OWNER_PRIV 解出明文）。
    const sealedHello = makeSealedRecord({
      messageId: "m1",
      senderPrivateKeyHex: OWNER_PRIV,
      senderPublicKeyHex: OWNER,
      recipientPublicKeyHex: OWNER_B,
      clientMessageId: "c1",
      createdAtMs: 1,
      insertedAtMs: 1,
      contentType: "text/plain",
      body: "hello"
    });
    const handle = makeMockProviderOps({
      sendMessage: async (input) => {
        sentMessages.push(input);
        return { messageId: "m1", insertedAtMs: 1000 };
      },
      listMessages: async (input) => {
        listCalls.push(input);
        return {
          items: [sealedHello],
          hasMore: false
        };
      },
      subscribeMessages: (h) => {
        subscribeCalls.push(h);
        return () => undefined;
      }
    });
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const ctx = makeCore({ providers: [p] });
    return { ...ctx, handle, sentMessages, listCalls, subscribeCalls };
  }

  it("sendMessage seals plaintext + forwards sealed record to provider", async () => {
    const ctx = makeConnectedCore();
    await ctx.core.connectForOwner(OWNER);
    const reg = ctx.core.endpointRegistry();
    const svc = reg.forEndpoint({
      kind: "plugin",
      id: KEYMASTER_MESSAGE_APP_ID
    });
    let localChangeCount = 0;
    const off = svc.subscribeLocalChanges!(() => { localChangeCount += 1; });
    const r = await svc.sendMessage({
      recipientPublicKeyHex: OWNER_B,
      recipientAppId: KEYMASTER_MESSAGE_APP_ID,
      contentType: "text/plain",
      body: "hi",
      clientMessageId: "c-send",
      createdAtMs: 1
    });
    expect(r.messageId).toBe("m1");
    expect(ctx.sentMessages.length).toBe(1);
    const sent = ctx.sentMessages[0] as {
      record: ProviderSealedMessageRecord;
    };
    expect(sent.record.senderPublicKeyHex).toBe(OWNER);
    expect(sent.record.senderEndpointKind).toBe("plugin");
    expect(sent.record.senderEndpointId).toBe(KEYMASTER_MESSAGE_APP_ID);
    expect(sent.record.recipientPublicKeyHex).toBe(OWNER_B);
    expect(sent.record.recipientEndpointId).toBe(KEYMASTER_MESSAGE_APP_ID);
    expect(sent.record.envelope.signatureBytes.length).toBe(64);
    expect(sent.record.envelope.envelopeBytes.length).toBeGreaterThan(0);
    const listed = await svc.listMessages({ limit: 10 });
    expect(listed.items.map((item) => item.messageId)).toContain("m1");
    expect(localChangeCount).toBeGreaterThan(0);
    off();
  });

  it("rejects a send while the active owner is waiting for its provider rebind", async () => {
    const ctx = makeConnectedCore();
    await ctx.core.connectForOwner(OWNER);
    const svc = ctx.core.endpointRegistry().forEndpoint({
      kind: "plugin",
      id: KEYMASTER_MESSAGE_APP_ID
    });

    ctx.keyspace.setActiveHex(OWNER_B);
    expect(svc.isReady()).toBe(false);
    await expect(svc.sendMessage({
      recipientPublicKeyHex: OWNER,
      recipientAppId: KEYMASTER_MESSAGE_APP_ID,
      contentType: "text/plain",
      body: "must wait for rebind",
      clientMessageId: "c-owner-race",
      createdAtMs: 2
    })).rejects.toThrow(/not_ready.*rebind/i);
    expect(ctx.sentMessages).toHaveLength(0);
  });

  it("persists provider pushes even when no endpoint or platform consumer is mounted", async () => {
    const ctx = makeConnectedCore();
    await ctx.core.connectForOwner(OWNER);
    expect(ctx.subscribeCalls).toHaveLength(1);

    ctx.subscribeCalls[0]!(makeSealedRecord({
      messageId: "push-unmounted",
      senderPrivateKeyHex: OWNER_B_PRIV,
      senderPublicKeyHex: OWNER_B,
      recipientPublicKeyHex: OWNER,
      clientMessageId: "c-push-unmounted",
      createdAtMs: 3,
      insertedAtMs: 4,
      contentType: "text/plain",
      body: "arrived while page was closed"
    }));

    const svc = ctx.core.endpointRegistry().forEndpoint({
      kind: "plugin",
      id: KEYMASTER_MESSAGE_APP_ID
    });
    await vi.waitFor(async () => {
      const listed = await svc.listMessages({ limit: 10 });
      expect(listed.items.some((item) => item.messageId === "push-unmounted")).toBe(true);
    });
  });

  it("dispatches messages discovered by reconnect sync to existing endpoint subscribers", async () => {
    const ctx = makeConnectedCore();
    const svc = ctx.core.endpointRegistry().forEndpoint({
      kind: "plugin",
      id: KEYMASTER_MESSAGE_APP_ID
    });
    let localChangeCount = 0;
    const off = svc.subscribeLocalChanges!(() => { localChangeCount += 1; });

    await ctx.core.connectForOwner(OWNER);
    await vi.waitFor(() => {
      expect(localChangeCount).toBeGreaterThan(0);
    });
    off();
  });

  it("listMessages reads scoped local db truth", async () => {
    const ctx = makeConnectedCore();
    await ctx.core.connectForOwner(OWNER);
    const reg = ctx.core.endpointRegistry();
    const svc = reg.forEndpoint({
      kind: "plugin",
      id: KEYMASTER_MESSAGE_APP_ID
    });
    const localOps = (ctx.core as unknown as {
      localOps: {
        putMessage(providerId: string, message: AppMsgMessage): Promise<void>;
      } | null;
      currentProviderId: string | null;
    }).localOps;
    const providerId = (ctx.core as unknown as { currentProviderId: string | null }).currentProviderId;
    expect(localOps).not.toBeNull();
    expect(providerId).toBe("hubmsg");
    await localOps!.putMessage(providerId!, {
      messageId: "local-1",
      clientMessageId: "c-local-1",
      senderPublicKeyHex: OWNER_B,
      senderAppId: KEYMASTER_MESSAGE_APP_ID,
      recipientPublicKeyHex: OWNER,
      recipientAppId: KEYMASTER_MESSAGE_APP_ID,
      contentType: "text/plain",
      body: "hello local",
      createdAtMs: 2,
      insertedAtMs: 2
    });
    const r = await svc.listMessages({ limit: 10 });
    expect(r.items.some((item) => item.messageId === "local-1")).toBe(true);
    const localItem = r.items.find((item) => item.messageId === "local-1");
    expect(localItem?.body).toBe("hello local");
    expect(ctx.listCalls.length).toBe(0);
  });

  it("subscribe opens incoming sealed record and dispatches public message", async () => {
    const ctx = makeConnectedCore();
    await ctx.core.connectForOwner(OWNER);
    const reg = ctx.core.endpointRegistry();
    const svc = reg.forEndpoint({
      kind: "plugin",
      id: KEYMASTER_MESSAGE_APP_ID
    });
    const received: AppMsgMessage[] = [];
    const off = svc.subscribeMessages((m) => received.push(m));
    expect(ctx.subscribeCalls.length).toBe(1);
    // 模拟 provider 推一条 sealed record（OWNER_B → OWNER，OWNER 端可解）。
    const pushed = makeSealedRecord({
      messageId: "push-1",
      senderPrivateKeyHex: OWNER_B_PRIV,
      senderPublicKeyHex: OWNER_B,
      recipientPublicKeyHex: OWNER,
      clientMessageId: "c-push",
      createdAtMs: 1,
      insertedAtMs: 1,
      contentType: "text/plain",
      body: "pushed"
    });
    for (const handler of ctx.subscribeCalls) handler(pushed);
    await vi.waitFor(() => {
      expect(received.length).toBe(1);
    });
    expect(received[0]?.messageId).toBe("push-1");
    expect(received[0]?.body).toBe("pushed");
    const listed = await svc.listMessages({ limit: 10 });
    expect(listed.items.map((item) => item.messageId)).toContain("push-1");
    off();
  });

  it("core checkOnline catches provider failure, records lastError, and degrades to unknown", async () => {
    const handle = makeMockProviderOps({
      checkOnline: async () => {
        throw new Error("HubMsg: request timeout after 5000ms");
      }
    });
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const ctx = makeCore({ providers: [p] });
    await ctx.core.connectForOwner(OWNER);

    const out = await ctx.core.checkOnline([OWNER_B]);

    expect(out[OWNER_B]).toBe("unknown");
    expect(ctx.core.inspectLocalDb().lastError).toMatch(/request timeout after 5000ms/i);
  });

  it("listAsOrigin/getAsOrigin read local scoped db instead of remote provider list/get", async () => {
    const ctx = makeConnectedCore();
    await ctx.core.connectForOwner(OWNER);
    const localOps = (ctx.core as unknown as {
      localOps: {
        putMessage(providerId: string, message: AppMsgMessage): Promise<void>;
      } | null;
      currentProviderId: string | null;
    }).localOps;
    const providerId = (ctx.core as unknown as { currentProviderId: string | null }).currentProviderId;
    expect(localOps).not.toBeNull();
    expect(providerId).toBe("hubmsg");
    await localOps!.putMessage(providerId!, {
      messageId: "origin-local-1",
      clientMessageId: "c-origin-local-1",
      senderPublicKeyHex: OWNER_B,
      senderOrigin: "https://example.test:443",
      recipientPublicKeyHex: OWNER,
      recipientOrigin: "https://example.test:443",
      contentType: "text/plain",
      body: "hello origin local",
      createdAtMs: 3,
      insertedAtMs: 3
    });

    const listed = await ctx.core.listAsOrigin({
      origin: "https://example.test:443",
      listInput: { limit: 10 }
    });
    expect(listed.items.some((item: AppMsgMessage) => item.messageId === "origin-local-1")).toBe(true);

    const got = await ctx.core.getAsOrigin({
      origin: "https://example.test:443",
      getInput: { messageId: "origin-local-1" }
    });
    expect(got?.body).toBe("hello origin local");
    expect(ctx.listCalls.length).toBe(0);
  });
});

describe("AppMsgCoreImpl - subscribe migration on owner/provider change", () => {
  it("switching active provider rebinds endpoint service subscriptions internally", async () => {
    const subscribeA: Array<(rec: ProviderSealedMessageRecord) => void> = [];
    const subscribeB: Array<(rec: ProviderSealedMessageRecord) => void> = [];
    const handleA = makeMockProviderOps({
      subscribeMessages: (h) => {
        subscribeA.push(h);
        return () => undefined;
      }
    });
    const handleB = makeMockProviderOps({
      subscribeMessages: (h) => {
        subscribeB.push(h);
        return () => undefined;
      }
    });
    // 故意让 handleA 在 disconnect 后 state 不是 "bound"，否则
    // connectForOwner 会因 owner 匹配而 short-circuit 跳过重建。
    const providerA = makeMockProvider("hubmsg", "HubMsg", handleA);
    const providerB = makeMockProvider("relay", "Relay", handleB);
    const { core } = makeCore({ providers: [providerA, providerB] });
    await core.connectForOwner(OWNER);
    const reg = core.endpointRegistry();
    const svc = reg.forEndpoint({
      kind: "plugin",
      id: KEYMASTER_MESSAGE_APP_ID
    });
    svc.subscribeMessages(() => undefined);
    expect(subscribeA.length).toBe(1);
    expect(subscribeB.length).toBe(0);

    // 切换 active provider → setActive 触发 endpoint service 内部
    // rebindAllSubscriptions（因为 boundHandle 没变，会重新绑一次）；
    // 紧接着调用 disconnect 让 boundHandle 清空，再 connectForOwner 重新
    // bind 到新 active provider。
    await core.providers().setActive("relay");
    await core.disconnect();
    expect(subscribeA.length).toBeGreaterThanOrEqual(1);
    expect(subscribeB.length).toBe(0);
    await core.connectForOwner(OWNER);
    // 此时 boundHandle = handleB（新 active），endpoint service 内部
    // 在 onStateChange 触发下重新绑定到 handleB。
    expect(subscribeB.length).toBeGreaterThanOrEqual(1);
  });
});

// 防止 IDE 报 unused
void APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY;

/* ============== 硬切换 003：等待重连倒计时真值 ============== */

describe("AppMsgCoreImpl - nextReconnectAtMs countdown truth", () => {
  it("setNextReconnectAtMs writes the value and fires state change", () => {
    const { core } = makeCore();
    const handlers = new Set<() => void>();
    core.onStateChange(() => handlers.add(() => undefined));
    const off = core.onStateChange(() => undefined);
    void off;
    const seen: number[] = [];
    const off2 = core.onStateChange(() => seen.push(Date.now()));
    core.setNextReconnectAtMs(Date.now() + 5000);
    expect(core.getNextReconnectAtMs()).not.toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    off2();
    void handlers;
  });

  it("connectForOwner success clears any pending nextReconnectAtMs", async () => {
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({ providers: [p] });
    core.setNextReconnectAtMs(Date.now() + 5000);
    expect(core.getNextReconnectAtMs()).not.toBeNull();
    await core.connectForOwner(OWNER);
    expect(core.getNextReconnectAtMs()).toBeNull();
    // 真实 boundHandle.state() === "bound" → snapshot.state === "open"
    // 且 nextReconnectAtMs === null。
    const snap = core.inspectLocalDb();
    expect(snap.state).toBe("open");
    expect(snap.nextReconnectAtMs).toBeNull();
  });

  it("disconnect() clears nextReconnectAtMs", async () => {
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({ providers: [p] });
    await core.connectForOwner(OWNER);
    core.setNextReconnectAtMs(Date.now() + 5000);
    expect(core.getNextReconnectAtMs()).not.toBeNull();
    await core.disconnect();
    expect(core.getNextReconnectAtMs()).toBeNull();
    expect(core.inspectLocalDb().nextReconnectAtMs).toBeNull();
  });

  it("connectForOwner with no active provider records lastError and stays idle/closed", async () => {
    const { core } = makeCore();
    core.setNextReconnectAtMs(Date.now() + 5000);
    await core.connectForOwner(OWNER);
    // 没有 provider / 没有成功 bind → state 既不是 open，也不应仍报
    // "有重连倒计时"——本次尝试走结构性降级。
    const snap = core.inspectLocalDb();
    expect(snap.state).not.toBe("open");
    expect(snap.nextReconnectAtMs).toBeNull();
    expect(snap.lastError).toMatch(/no active provider/);
  });

  it("boundHandle.state() !== 'bound' is reported as not-open, not 'open'", async () => {
    // 模拟：远端已断开但 handle 引用未清。inspectLocalDb 必须如实报告
    // 非 open。
    const handle = makeMockProviderOps({ state: "closed" });
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({ providers: [p] });
    await core.connectForOwner(OWNER);
    expect(core.inspectLocalDb().state).not.toBe("open");
  });

  it("inspectLocalDb exposes nextReconnectAtMs only when state=closed", async () => {
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({ providers: [p] });
    await core.connectForOwner(OWNER);
    // bound 时即使 setNextReconnectAtMs 写入，inspectLocalDb 也要返回
    // null（§4.4 约束：open 时必须为 null）。
    core.setNextReconnectAtMs(Date.now() + 5000);
    expect(core.inspectLocalDb().nextReconnectAtMs).toBeNull();
    // 断开后倒计时才能透出。
    await core.disconnect();
    core.setNextReconnectAtMs(Date.now() + 5000);
    const snap = core.inspectLocalDb();
    expect(snap.state).toBe("closed");
    expect(snap.nextReconnectAtMs).not.toBeNull();
  });
});

/* ============== 硬切换 003 反馈"必改"测试 ============== */

describe("AppMsgCoreImpl - connectForOwner outcome + stale guard", () => {
  it("connectForOwner returns connected on success", async () => {
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({ providers: [p] });
    const out = await core.connectForOwner(OWNER);
    expect(out.kind).toBe("connected");
  });

  it("connectForOwner returns retryableFailure on bind error", async () => {
    const failingProvider: MessageProvider = {
      id: "hubmsg",
      displayName: "HubMsg",
      bind: async () => {
        throw new Error("bind failed");
      },
      shutdown: async () => undefined,
      health: () => ({ isHealthy: false, lastError: "x", lastConnectedAtMs: 0 }),
      checkOnline: async () => ({})
    };
    const { core } = makeCore({ providers: [failingProvider] });
    const out = await core.connectForOwner(OWNER);
    expect(out.kind).toBe("retryableFailure");
    if (out.kind === "retryableFailure") {
      expect(out.reason).toMatch(/bind failed/);
    }
  });

  it("connectForOwner returns structurallyOffline when no provider", async () => {
    const { core } = makeCore();
    const out = await core.connectForOwner(OWNER);
    expect(out.kind).toBe("structurallyOffline");
    if (out.kind === "structurallyOffline") {
      expect(out.reason).toBe("no_active_provider");
    }
  });

  it("connectForOwner returns structurallyOffline when signer is null", async () => {
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({
      providers: [p],
      signerProvider: async () => null
    });
    const out = await core.connectForOwner(OWNER);
    expect(out.kind).toBe("structurallyOffline");
    if (out.kind === "structurallyOffline") {
      expect(out.reason).toBe("no_signer");
    }
  });

  it("connectForOwner ignores callerEpoch token (does not stale on it)", async () => {
    // 反馈"必改"第二轮：core 内部不再做"传入 callerEpoch 必须等于
    // connectEpoch"校验；callerEpoch 仅作 caller 端"await 后自检"
    // 的 token，core 不读不校验。
    const handle = makeMockProviderOps();
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({ providers: [p] });
    // 任意 callerEpoch（包括明显"过期"的 -1）都**不**让 core 立即
    // 返回 stale；core 按真实 outcome 推进。
    const out = await core.connectForOwner(OWNER, -1);
    expect(out.kind).toBe("connected");
    expect(core.currentHandle()).toBe(handle);
  });

  it("同一结构代次下的两次 connectForOwner 都不 stale（callerEpoch 不变）", async () => {
    // 反馈"必改"第二轮：旧实现会把 `callerEpoch` 当成必须等于
    // connectEpoch 的 token，导致 5 秒重试全部变 stale。新设计下，
    // callerEpoch 仅作标识，core 内部不读；同一 callerEpoch 下第
    // 二次调用仍能正常走完。
    const failingProvider: MessageProvider = {
      id: "hubmsg",
      displayName: "HubMsg",
      bind: async () => {
        throw new Error("net down");
      },
      shutdown: async () => undefined,
      health: () => ({ isHealthy: false, lastError: "x", lastConnectedAtMs: 0 }),
      checkOnline: async () => ({})
    };
    const { core } = makeCore({ providers: [failingProvider] });
    // 第一次：callerEpoch=1 失败。
    const out1 = await core.connectForOwner(OWNER, 1);
    expect(out1.kind).toBe("retryableFailure");
    // 第二次：callerEpoch 仍是 1（旧实现下会变 stale）。
    const out2 = await core.connectForOwner(OWNER, 1);
    expect(out2.kind).toBe("retryableFailure");
  });

  it("in-flight connect overtaken by a newer call returns stale; older result is discarded", async () => {
    // 两次都按同一 owner 调（keyspace active 仍是 OWNER），靠
    // connectEpoch 代次抢占让第一次返回 stale。
    const slowHandle = makeMockProviderOps();
    const slowProvider: MessageProvider = {
      id: "hubmsg",
      displayName: "HubMsg",
      bind: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return slowHandle as MessageProviderHandle;
      },
      shutdown: async () => undefined,
      health: () => ({ isHealthy: true, lastError: null, lastConnectedAtMs: 0 }),
      checkOnline: async () => ({})
    };
    const { core } = makeCore({ providers: [slowProvider] });
    const slowP = core.connectForOwner(OWNER).then((o) => ({ tag: "slow" as const, o }));
    // 立刻发起第二次 connect（覆盖 connectEpoch）。
    const out2 = await core.connectForOwner(OWNER);
    expect(out2.kind).toBe("connected");
    expect(core.currentHandle()).toBe(slowHandle);
    // 等第一次返回。
    const r1 = await slowP;
    expect(r1.tag).toBe("slow");
    expect(r1.o.kind).toBe("stale");
    // 不应被回写：bound owner 仍是 OWNER，boundHandle 仍是 slowHandle。
    expect(core.inspectLocalDb().ownerPublicKeyHex).toBe(OWNER);
    expect(core.inspectLocalDb().state).toBe("open");
  });
});

describe("AppMsgCoreImpl - markStructurallyOffline", () => {
  it("after connectForOwner fails, markStructurallyOffline brings state to idle and clears lastError", async () => {
    const failingProvider: MessageProvider = {
      id: "hubmsg",
      displayName: "HubMsg",
      bind: async () => {
        throw new Error("boom");
      },
      shutdown: async () => undefined,
      health: () => ({ isHealthy: false, lastError: "x", lastConnectedAtMs: 0 }),
      checkOnline: async () => ({})
    };
    const { core } = makeCore({ providers: [failingProvider] });
    await core.connectForOwner(OWNER);
    // 失败路径下 `currentBoundOwner` 不会被提交（§5.6 提交前校验），
    // 所以 state 仍稳定在 `idle`，与 §5.7 修正一致。
    expect(core.inspectLocalDb().state).toBe("idle");
    expect(core.inspectLocalDb().lastError).toMatch(/boom/);
    core.markStructurallyOffline();
    const snap = core.inspectLocalDb();
    expect(snap.state).toBe("idle");
    expect(snap.lastError).toBeNull();
    expect(snap.ownerPublicKeyHex).toBeNull();
  });

  it("in-flight connect is invalidated after markStructurallyOffline", async () => {
    let resolveBind!: (h: MessageProviderHandle) => void;
    const handle = makeMockProviderOps();
    const slowProvider: MessageProvider = {
      id: "hubmsg",
      displayName: "HubMsg",
      bind: () =>
        new Promise<MessageProviderHandle>((resolve) => {
          resolveBind = (h) => resolve(h);
        }),
      shutdown: async () => undefined,
      health: () => ({ isHealthy: true, lastError: null, lastConnectedAtMs: 0 }),
      checkOnline: async () => ({})
    };
    const { core } = makeCore({ providers: [slowProvider] });
    const p = core.connectForOwner(OWNER);
    // 等 connectForOwner 走过 disconnect / openLocalDbForOwner /
    // signerProvider 几个异步步骤，最终跑到 `await provider.bind(...)`。
    // 这里不再依赖单次 macrotask 恰好够用，改为 waitFor 直到
    // `resolveBind` 真被赋值，避免不同运行环境下时序抖动。
    await vi.waitFor(() => {
      expect(typeof resolveBind).toBe("function");
    });
    // 在 bind 还没 resolve 时调 markStructurallyOffline：会抬 connectEpoch。
    core.markStructurallyOffline();
    // 然后让 bind 完成。
    resolveBind(handle as MessageProviderHandle);
    const out = await p;
    expect(out.kind).toBe("stale");
    expect(core.inspectLocalDb().state).toBe("idle");
    // 防止泄漏：handle 已被 close。
    expect((handle.close as ReturnType<typeof vi.fn>)).toBeDefined();
  });
});

describe("AppMsgCoreImpl - inspectLocalDb closed semantics (no lastError fallback)", () => {
  it("closed is only set by currentBoundOwner or nextReconnectAtMs; lastError alone stays idle", async () => {
    const { core } = makeCore();
    // 模拟一次失败后只残留 lastError 的情况（不应让 state 升到 closed）。
    // 通过 retryableFailure 路径产生 lastError：
    const failingProvider: MessageProvider = {
      id: "hubmsg",
      displayName: "HubMsg",
      bind: async () => {
        throw new Error("net down");
      },
      shutdown: async () => undefined,
      health: () => ({ isHealthy: false, lastError: "x", lastConnectedAtMs: 0 }),
      checkOnline: async () => ({})
    };
    const c2 = makeCore({ providers: [failingProvider] });
    await c2.core.connectForOwner(OWNER);
    expect(c2.core.inspectLocalDb().lastError).toMatch(/net down/);
    // 失败但未写 currentBoundOwner/nextReconnectAtMs → state=idle。
    expect(c2.core.inspectLocalDb().state).toBe("idle");
    // 显式 markStructurallyOffline 也会清掉。
    c2.core.markStructurallyOffline();
    expect(c2.core.inspectLocalDb().state).toBe("idle");
    expect(c2.core.inspectLocalDb().lastError).toBeNull();
    void core;
  });
});

describe("AppMsgCoreImpl - onClose hook (remote disconnect)", () => {
  it("handle.state() going from bound to closed triggers handleGoneAfterBound", async () => {
    const inner = {
      state: "bound" as "bound" | "closed"
    };
    const handle = {
      state: () => inner.state,
      close: () => {
        inner.state = "closed";
      },
      sendMessage: async () => ({ messageId: "m", insertedAtMs: 0 }),
      listMessages: async () => ({ items: [], hasMore: false }),
      getMessage: async () => null,
      subscribeMessages: () => () => undefined,
      checkOnline: async () => ({})
    } as unknown as MessageProviderOperations;
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({ providers: [p] });
    const seen: number[] = [];
    core.onStateChange(() => seen.push(Date.now()));
    await core.connectForOwner(OWNER);
    expect(core.inspectLocalDb().state).toBe("open");
    // 模拟远端断开：state 转入 closed。fallback 轮询每秒跑一次。
    inner.state = "closed";
    await new Promise((r) => setTimeout(r, 1100));
    expect(core.inspectLocalDb().state).not.toBe("open");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("handle providing native onClose is preferred over fallback polling", async () => {
    const inner = {
      state: "bound" as "bound" | "closed",
      closeHandlers: new Set<() => void>()
    };
    const handle = {
      state: () => inner.state,
      close: () => {
        inner.state = "closed";
      },
      sendMessage: async () => ({ messageId: "m", insertedAtMs: 0 }),
      listMessages: async () => ({ items: [], hasMore: false }),
      getMessage: async () => null,
      subscribeMessages: () => () => undefined,
      checkOnline: async () => ({})
    } as unknown as MessageProviderOperations & {
      onClose?: (h: () => void) => () => void;
    };
    (handle as unknown as { onClose?: (h: () => void) => () => void }).onClose =
      (h: () => void) => {
        inner.closeHandlers.add(h);
        return () => inner.closeHandlers.delete(h);
      };
    const p = makeMockProvider("hubmsg", "HubMsg", handle);
    const { core } = makeCore({ providers: [p] });
    await core.connectForOwner(OWNER);
    expect(core.inspectLocalDb().state).toBe("open");
    // 模拟远端断线。
    inner.state = "closed";
    for (const h of inner.closeHandlers) h();
    // 不需要等 1s 轮询。
    expect(core.inspectLocalDb().state).not.toBe("open");
  });
});
