// packages/plugin-message/src/MessagePage.test.tsx
// 系统消息应用页面契约测试（feedback §"测试未真正 render 页面"）。
//
// 关键验证点：
//   - MessagePage 在 PluginHostProvider 下能真渲染；
//   - 页面契约至少呈现：标题、一条消息 body、同步状态区域；
//   - **不**走 window.__keymaster_appmsg_core__ fallback 路径；
//   - I18nService 类型 / capability key 都从 @keymaster/contracts 拿。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  AppMsgCore,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgOnlineResult,
  AppMsgTargetSyncState,
  I18nService,
  I18nText,
  I18nValues,
  SupportedLanguage,
  LanguageMode,
  SupportedLanguageDescriptor
} from "@keymaster/contracts";
import {
  APPMESSAGE_CORE_CAPABILITY,
  I18N_SERVICE_CAPABILITY,
  KEYMASTER_MESSAGE_APP_ID
} from "@keymaster/contracts";
import { PluginHostProvider } from "@keymaster/runtime";
import type { PluginHost } from "@keymaster/runtime";

const OWNER = "02bbbb".padEnd(66, "b");

/**
 * 最小可用 I18nService stub：满足 useI18n() 真实需要的全部方法。
 *
 * 注意：这里直接以"contracts"为准，**不**使用 `@keymaster/runtime`
 * 暴露的 I18nService——以确保 capability stub 契约保持正确。
 */
function makeFakeI18n(): I18nService {
  return {
    mode: (): LanguageMode => "manual",
    language: (): SupportedLanguage => "en",
    supported: (): readonly SupportedLanguageDescriptor[] => [],
    t: (key: string, _values?: I18nValues): string => key,
    text: (input: I18nText | undefined): string => {
      if (!input) return "";
      if (typeof input === "string") return input;
      return input.fallback ?? input.key;
    },
    setLanguage: async (_l: SupportedLanguage): Promise<void> => undefined,
    setAuto: async (): Promise<void> => undefined,
    registerResources: () => undefined,
    unregisterResources: () => undefined,
    onChange: () => () => undefined
  };
}

function makeFakeCore(opts?: {
  messages?: AppMsgMessage[];
  targets?: AppMsgTargetSyncState[];
  snapshot?: AppMsgLocalDbSnapshot;
}): AppMsgCore {
  const messages = opts?.messages ?? [];
  const targets = opts?.targets ?? [];
  const snap: AppMsgLocalDbSnapshot = opts?.snapshot ?? {
    state: "open",
    ownerPublicKeyHex: OWNER,
    lastInsertedAtMs: 1,
    lastError: null
  };
  return {
    connectForOwner: async () => undefined,
    disconnect: async () => undefined,
    inspectLocalDb: () => snap,
    openLocalDb: async () => null,
    sendScopedMessage: async () => ({ messageId: "0", createdAtMs: 0 }),
    listUnfilteredMessages: async () => ({ items: messages, hasMore: false }),
    getScopedMessage: async () => null,
    listScopedMessages: async () => ({ items: [], hasMore: false }),
    subscribeScopedMessages: () => () => undefined,
    subscribeUnfilteredMessages: () => () => undefined,
    triggerSync: async () => undefined,
    listTargetSyncStates: async () => targets,
    checkOnline: async (hexes): Promise<AppMsgOnlineResult> => {
      const out: AppMsgOnlineResult = {};
      for (const h of hexes) out[h] = "online";
      return out;
    },
    createMessageScopedClient: () => {
      throw new Error("not used in this test");
    },
    createSystemMessageClient: () => ({
      sendMessage: async () => ({ messageId: "0", createdAtMs: 0 }),
      listMessages: async () => ({ items: messages, hasMore: false }),
      getMessage: async () => messages[0] ?? null,
      subscribeMessages: () => () => undefined,
      checkOnline: async (hexes: string[]) => {
        const out: AppMsgOnlineResult = {};
        for (const h of hexes) out[h] = "online";
        return out;
      }
    })
  };
}

/**
 * 最小 pluginHost stub：仅满足 useCapability 与 useI18n 需要的接口。
 */
function makeFakeHost(core: AppMsgCore): PluginHost {
  const providers: Record<string, unknown> = {
    [APPMESSAGE_CORE_CAPABILITY]: core,
    [I18N_SERVICE_CAPABILITY]: makeFakeI18n()
  };
  const capabilities = {
    keys: () => Object.keys(providers),
    get: <T,>(key: string): T => {
      if (key in providers) return providers[key] as T;
      throw new Error(`not provided: ${key}`);
    },
    has: (key: string) => key in providers,
    require: <T,>(key: string): T => {
      if (key in providers) return providers[key] as T;
      throw new Error(`not provided: ${key}`);
    },
    provide: <T,>(k: string, v: T) => {
      providers[k] = v;
    },
    revoke: (k: string) => {
      delete providers[k];
    }
  };
  const host = {
    capabilities,
    messageBus: {} as never,
    routes: {} as never,
    menus: {} as never,
    breadcrumbs: {} as never,
    settings: {} as never,
    home: {} as never,
    commands: {} as never,
    importers: {} as never,
    transfers: {} as never,
    assets: {} as never,
    tokens: {} as never,
    collectibles: {} as never,
    collectibleTransfer: {} as never,
    topbar: {} as never,
    i18n: makeFakeI18n(),
    log: {} as never,
    configStore: {} as never,
    installed: () => [],
    manifests: () => [],
    state: () => ({ id: "fake", kind: "enabled" }),
    graph: () => ({
      plugins: [],
      dependencies: {},
      provides: {},
      reverse: {}
    }),
    version: () => 1,
    subscribe: () => () => undefined,
    getManifest: () => undefined,
    reverseDeps: () => [],
    register: async () => undefined,
    registerAll: async () => undefined,
    enable: async () => undefined,
    disable: async () => ({ ok: true as const }),
    unregister: async () => undefined
  };
  return host as unknown as PluginHost;
}

describe("MessagePage in PluginHostProvider (feedback: 真正 render + 契约)", () => {
  beforeEach(() => {
    // 关键：清掉任何临时 fallback，确保页面只走 useCapability 路径。
    delete (window as unknown as Record<string, unknown>)[
      "__keymaster_appmsg_core__"
    ];
  });

  afterEach(() => {
    cleanup();
  });

  it("renders title, a message body and sync state area", async () => {
    const sampleMessage: AppMsgMessage = {
      messageId: "real-id-1",
      clientMessageId: "c-1",
      senderPublicKeyHex: "02aaaa".padEnd(66, "a"),
      senderOrigin: "https://justnote.example:443",
      recipientPublicKeyHex: OWNER,
      recipientOrigin: "https://justnote.example:443",
      contentType: "text/plain",
      body: "real rendered body",
      createdAtMs: 1,
      insertedAtMs: 1
    };
    const fakeCore = makeFakeCore({
      messages: [sampleMessage],
      targets: [
        {
          targetKey: `origin:https://justnote.example:443`,
          lastSyncedMessageId: "real-id-1",
          lastReceivedAtMs: 1,
          lastSyncStartedAtMs: 0,
          lastSyncCompletedAtMs: 1,
          lastSyncError: null
        }
      ],
      snapshot: {
        state: "open",
        ownerPublicKeyHex: OWNER,
        lastInsertedAtMs: 1,
        lastError: null
      }
    });
    const host = makeFakeHost(fakeCore);
    const { MessagePage } = await import("./MessagePage.js");
    render(
      <PluginHostProvider host={host}>
        <MessagePage />
      </PluginHostProvider>
    );

    // 标题：使用 i18n key fallback（i18n.t 返回 key 自身）。
    await waitFor(() => {
      const el = screen.getByText("message.platform.title");
      expect(el).toBeTruthy();
    });
    // 消息 body：fetch 完成后被渲染。
    await waitFor(() => {
      const el = screen.getByText("real rendered body");
      expect(el).toBeTruthy();
    });
    // 同步状态区域：来自 Sync state header + 同步目标列表。
    await waitFor(() => {
      const el = screen.getByText("message.page.sync.state.label");
      expect(el).toBeTruthy();
    });
    await waitFor(() => {
      // 同步目标 key 会出现在列表里。
      const el = screen.getByText("origin:https://justnote.example:443");
      expect(el).toBeTruthy();
    });
  });

  it("does NOT rely on window.__keymaster_appmsg_core__ fallback", async () => {
    const fakeCore = makeFakeCore({
      // 提供合法 open 状态 + owner，使得 createSystemMessageClient 不抛；
      // 但**不**触碰 window.__keymaster_appmsg_core__。
      snapshot: {
        state: "open",
        ownerPublicKeyHex: OWNER,
        lastInsertedAtMs: 0,
        lastError: null
      }
    });
    delete (window as unknown as Record<string, unknown>)[
      "__keymaster_appmsg_core__"
    ];
    const host = makeFakeHost(fakeCore);
    const { MessagePage } = await import("./MessagePage.js");
    render(
      <PluginHostProvider host={host}>
        <MessagePage />
      </PluginHostProvider>
    );
    // 走 useCapability 路径，页面至少 render 出标题（i18n key fallback）。
    await waitFor(() => {
      const el = screen.getByText("message.platform.title");
      expect(el).toBeTruthy();
    });
    // 全局兜底未被动过——证明这条路径**不**在依赖 window fallback。
    const w = window as unknown as Record<string, unknown>;
    expect(w["__keymaster_appmsg_core__"]).toBeUndefined();
  });

  it("exposes the system message appId constant for tooling", () => {
    expect(KEYMASTER_MESSAGE_APP_ID).toBe("keymaster.message");
    expect(APPMESSAGE_CORE_CAPABILITY).toBe("appmsg.core");
    expect(I18N_SERVICE_CAPABILITY).toBe("i18n.service");
  });
});

// 防止 IDE 报 unused
void vi;
