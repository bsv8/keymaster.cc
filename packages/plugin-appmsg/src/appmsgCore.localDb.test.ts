// packages/plugin-appmsg/src/appmsgCore.localDb.test.ts
// 硬切换 003 反馈"必改"第二轮：`local_db_unavailable` 分支单测。
//
// 通过 vi.mock 把 `openAppMsgLocalDb` 替换为返回 null，验证 core 内
// `connectForOwner` 命中"本地 DB 不可用"路径返回
// `{ kind: "structurallyOffline", reason: "local_db_unavailable" }`，
// 且**不**继续走 `provider.bind`。

import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import type {
  KeyspaceService,
  MessageProvider,
  MessageProviderHandle,
  MessageProviderOperations,
  ProviderListResult,
  ProviderOnlineResult,
  ProviderSendResult,
  AppMsgMessage
} from "@keymaster/contracts";
import { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";

const OWNER = "02aaaa".padEnd(66, "a");

// 关键 mock：在 `appmsgCore` import 之前替换 `appmsgDb` 模块的导出。
vi.mock("./appmsgDb.js", () => ({
  openAppMsgLocalDb: async () => null,
  disposeAppMsgLocalDb: () => undefined,
  createAppMsgLocalDbOps: () => {
    throw new Error("createAppMsgLocalDbOps should not be called when openAppMsgLocalDb returns null");
  },
  senderProjectionToScope: (sender: { senderPublicKeyHex: string; senderAppId?: string; senderOrigin?: string }) => ({
    ownerPublicKeyHex: sender.senderPublicKeyHex,
    kind: "plugin" as const,
    id: sender.senderAppId ?? sender.senderOrigin ?? ""
  }),
  targetIdFromMessage: (m: AppMsgMessage) => m.recipientAppId ?? m.recipientOrigin ?? null,
  syncAllScopes: async () => undefined
}));

function makeFakeKeyspace(): KeyspaceService {
  return {
    active: () => ({ activePublicKeyHex: OWNER }),
    onActiveChange: () => () => undefined,
    getKey: async () => ({ publicKeyHex: OWNER, label: "x", capabilities: [], createdAt: "" }),
    listKeys: async () => [],
    setActive: async () => undefined,
    requireActiveKey: () => ({ publicKeyHex: OWNER, label: "x", capabilities: [], createdAt: "" }) as never,
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined,
    openKeyStorage: async () => ({}) as never,
    registerPluginStorage: () => undefined,
    listPluginStorages: () => []
  } as unknown as KeyspaceService;
}

function makeProvider(id: string): MessageProvider {
  let bindCalls = 0;
  const off = vi.fn();
  const handle: MessageProviderOperations = {
    state: () => "bound",
    close: () => undefined,
    sendMessage: async () => ({ messageId: "m", insertedAtMs: 0 } as ProviderSendResult),
    listMessages: async () => ({ items: [], hasMore: false } as ProviderListResult),
    getMessage: async () => null as AppMsgMessage | null,
    subscribeMessages: () => off,
    checkOnline: async () => ({}) as ProviderOnlineResult
  } as unknown as MessageProviderOperations;
  return {
    id,
    displayName: id,
    bind: async () => {
      bindCalls += 1;
      return handle as MessageProviderHandle;
    },
    shutdown: async () => undefined,
    health: () => ({ isHealthy: true, lastError: null, lastConnectedAtMs: 0 }),
    checkOnline: async () => ({})
  } as MessageProvider;
}

describe("AppMsgCoreImpl - local db unavailable", () => {
  it("openLocalDb 失败时返回 structurallyOffline(local_db_unavailable)，不调 provider.bind", async () => {
    // 重新 import 以让 vi.mock 生效。
    const { AppMsgCoreImpl: Core } = await import("./appmsgCore.js");
    const keyspace = makeFakeKeyspace();
    const p = makeProvider("hubmsg");
    let bindCalls = 0;
    const provider: MessageProvider = {
      ...p,
      bind: async () => {
        bindCalls += 1;
        return (p as unknown as { bind: () => Promise<MessageProviderHandle> }).bind();
      }
    };
    const cfg: AppMsgCoreConfig = {
      signerProvider: async () => ({ publicKeyHex: OWNER, privateKeyHex: "00".repeat(32), signChallenge: async () => "00".repeat(64) }),
      keyspace,
      pluginId: "appmsg",
      storageId: "messages_v2",
      localStorage: null,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    };
    const core = new Core(cfg);
    core.providers().register(provider);
    const out = await core.connectForOwner(OWNER);
    expect(out.kind).toBe("structurallyOffline");
    if (out.kind === "structurallyOffline") {
      expect(out.reason).toBe("local_db_unavailable");
    }
    // 关键：provider.bind 不应被调用。
    expect(bindCalls).toBe(0);
    expect(core.currentHandle()).toBeNull();
    // 状态稳定 idle（lastError 被结构性离线擦除后，state 走 `nextReconnectAtMs=null && currentBoundOwner=null` → idle）。
    const snap = core.inspectLocalDb();
    expect(snap.state).toBe("idle");
  });
});
