// packages/plugin-message/src/MessagePage.test.tsx
// 消息业务页契约测试（施工单 2026-07-04 001 硬切换）。
//
// 关键验证点：
//   - MessagePage 在 PluginHostProvider 下能真渲染；
//   - 页面契约至少呈现：标题、消息 body、发送区、搜索区、列表区；
//   - **不**出现 sync state / connection / online UI；
//   - service 不可用时显示降级空态——**这是唯一允许的降级路径**；
//   - **不**走任何 window 全局兜底；
//   - **不**再依赖 `subscriptionSource()` 旧接口；订阅由 endpoint service
//     内部自动迁移，本组件**不**关心 client 引用变化。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  AppMsgEndpointService,
  AppMsgMessage,
  I18nService,
  I18nText,
  I18nValues,
  LanguageMode,
  SupportedLanguage,
  SupportedLanguageDescriptor
} from "@keymaster/contracts";
import { I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { PluginHostProvider } from "@keymaster/runtime";
import type { PluginHost } from "@keymaster/runtime";
import type { MessageService } from "./messageService.js";

const OWNER = "02bbbb".padEnd(66, "b");
const MESSAGE_SERVICE_CAPABILITY = "message.service";

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

/**
 * 构造 fake MessageService（直接传 endpoint service 引用）。
 */
function makeFakeService(opts?: {
  messages?: AppMsgMessage[];
}): MessageService {
  const messages = opts?.messages ?? [];
  const endpoint: AppMsgEndpointService = {
    endpoint: { kind: "plugin", id: "keymaster.message" },
    isReady: () => true,
    sendMessage: async () => ({ messageId: "0", createdAtMs: 0 }),
    listMessages: async () => ({ items: messages, hasMore: false }),
    getMessage: async (input: { messageId: string }) =>
      messages.find((m) => m.messageId === input.messageId) ?? null,
    subscribeMessages: () => () => undefined,
    checkOnline: async () => ({})
  };
  return {
    isReady: () => endpoint.isReady(),
    listMessages: async (input) => {
      const res = await endpoint.listMessages(input);
      return res.items;
    },
    getMessage: async (id) => endpoint.getMessage({ messageId: id }),
    sendTextMessage: async () => undefined,
    subscribeMessages: (handler) => endpoint.subscribeMessages(handler)
  };
}

function makeFakeHost(service: MessageService | null) {
  const providers: Record<string, unknown> = {
    [I18N_SERVICE_CAPABILITY]: makeFakeI18n()
  };
  if (service) {
    providers[MESSAGE_SERVICE_CAPABILITY] = service;
  }
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
  let currentVersion = 1;
  const listeners = new Set<(snap: { version: number }) => void>();
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
    graph: () => ({ plugins: [], dependencies: {}, provides: {}, reverse: {} }),
    version: () => currentVersion,
    subscribe: (l: (snap: { version: number }) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getManifest: () => undefined,
    reverseDeps: () => [],
    register: async () => undefined,
    registerAll: async () => undefined,
    enable: async () => undefined,
    disable: async () => ({ ok: true as const }),
    unregister: async () => undefined
  };
  return {
    host: host as unknown as PluginHost,
    bumpVersion: () => {
      currentVersion += 1;
      for (const l of [...listeners]) {
        try {
          l({ version: currentVersion });
        } catch {
          // ignore
        }
      }
    }
  };
}

describe("MessagePage in PluginHostProvider", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders title, send area, search area, list area and message body", async () => {
    const sampleMessage: AppMsgMessage = {
      messageId: "real-id-1",
      clientMessageId: "c-1",
      senderPublicKeyHex: "02aaaa".padEnd(66, "a"),
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: OWNER,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: "real rendered body",
      createdAtMs: 1,
      insertedAtMs: 1
    };
    const service = makeFakeService({ messages: [sampleMessage] });
    const { host } = makeFakeHost(service);
    const { MessagePage } = await import("./MessagePage.js");
    render(
      <PluginHostProvider host={host}>
        <MessagePage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      const el = screen.getByText("message.page.title");
      expect(el).toBeTruthy();
    });
    await waitFor(() => {
      const el = screen.getByText("real rendered body");
      expect(el).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("message.page.send.label")).toBeTruthy();
      expect(screen.getByText("message.page.search.label")).toBeTruthy();
      expect(screen.getByText("message.page.list.label")).toBeTruthy();
    });
  });

  it("does NOT render sync / connection / online UI", async () => {
    const service = makeFakeService({ messages: [] });
    const { host } = makeFakeHost(service);
    const { MessagePage } = await import("./MessagePage.js");
    render(
      <PluginHostProvider host={host}>
        <MessagePage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      const el = screen.getByText("message.page.title");
      expect(el).toBeTruthy();
    });
    expect(screen.queryByText("message.page.sync.state.label")).toBeNull();
    expect(screen.queryByText("message.page.checkOnline")).toBeNull();
    expect(screen.queryByText("message.page.online.label")).toBeNull();
    expect(screen.queryByText("message.page.refresh")).toBeNull();
  });

  it("renders missing-service empty state when capability is missing (唯一降级路径)", async () => {
    const { host } = makeFakeHost(null);
    const { MessagePage } = await import("./MessagePage.js");
    render(
      <PluginHostProvider host={host}>
        <MessagePage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      const empty = screen.getByText("message.page.noClient");
      expect(empty).toBeTruthy();
    });
    expect(screen.queryByText("message.page.send.label")).toBeNull();
  });

  // endpoint service 内部已自动迁移订阅；本组件**不**关心 client 引用
  // 变化。`subscriptionSource()` 旧接口已彻底删除——这里不写任何"切换
  // subscription token"的测试。
});

// 防止 IDE 报 unused
void vi;