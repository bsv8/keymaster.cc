// packages/plugin-message/src/MessageDetailPage.test.tsx
// 消息详情页契约测试（施工单 2026-07-03 002 硬切换 + 文件级修改意见 §8）。
//
// 验证：
//   - `/messages/:messageId` 路由下，详情页能从 scoped service 拉到单条消息；
//   - 越权 messageId（不在 scope 内）→ 显示空态；
//   - 详情页**不**展示 HubMsg 连接态 / 同步态 / 全局统计；
//   - capability 缺失时显示降级空态——**这是唯一允许的降级路径**；
//   - **不**走任何 window 全局兜底（__kmMessageService）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type {
  AppMsgMessage,
  I18nService,
  I18nText,
  I18nValues,
  SupportedLanguage,
  LanguageMode,
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

function makeFakeService(opts?: { messages?: AppMsgMessage[] }): MessageService {
  const messages = opts?.messages ?? [];
  return {
    isReady: () => true,
    listMessages: async () => messages,
    getMessage: async (id: string) => messages.find((m) => m.messageId === id) ?? null,
    sendTextMessage: async () => undefined,
    subscribeMessages: () => () => undefined
  };
}

function makeFakeHost(service: MessageService | null): PluginHost {
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

describe("MessageDetailPage in PluginHostProvider", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders single-message body when messageId is in scope", async () => {
    const sample: AppMsgMessage = {
      messageId: "id-detail-1",
      clientMessageId: "c-detail-1",
      senderPublicKeyHex: "02aaaa".padEnd(66, "a"),
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: OWNER,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: "detail body text",
      createdAtMs: 1000,
      insertedAtMs: 2000
    };
    const service = makeFakeService({ messages: [sample] });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    render(
      <MemoryRouter initialEntries={["/messages/id-detail-1"]}>
        <PluginHostProvider host={host}>
          <Routes>
            <Route path="/messages/:messageId" element={<MessageDetailPage />} />
          </Routes>
        </PluginHostProvider>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("detail body text")).toBeTruthy();
    });
    // messageId 字段出现在 meta 区。
    await waitFor(() => {
      expect(screen.getByText("id-detail-1")).toBeTruthy();
    });
  });

  it("renders empty state when messageId is out of scope", async () => {
    const service = makeFakeService({ messages: [] });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    render(
      <MemoryRouter initialEntries={["/messages/not-in-scope"]}>
        <PluginHostProvider host={host}>
          <Routes>
            <Route path="/messages/:messageId" element={<MessageDetailPage />} />
          </Routes>
        </PluginHostProvider>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.empty")).toBeTruthy();
    });
  });

  it("renders missing-service empty state when capability is missing (唯一降级路径)", async () => {
    const host = makeFakeHost(null);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    render(
      <MemoryRouter initialEntries={["/messages/any"]}>
        <PluginHostProvider host={host}>
          <Routes>
            <Route path="/messages/:messageId" element={<MessageDetailPage />} />
          </Routes>
        </PluginHostProvider>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("message.page.noClient")).toBeTruthy();
    });
  });

  it("does NOT render sync / connection / global stat UI", async () => {
    const service = makeFakeService({ messages: [] });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    render(
      <MemoryRouter initialEntries={["/messages/x"]}>
        <PluginHostProvider host={host}>
          <Routes>
            <Route path="/messages/:messageId" element={<MessageDetailPage />} />
          </Routes>
        </PluginHostProvider>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.title")).toBeTruthy();
    });
    expect(screen.queryByText("message.page.sync.state.label")).toBeNull();
    expect(screen.queryByText("message.page.online.label")).toBeNull();
    expect(screen.queryByText("message.page.list.label")).toBeNull();
  });
});

void vi;