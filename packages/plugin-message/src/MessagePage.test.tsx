// packages/plugin-message/src/MessagePage.test.tsx
// 消息首页契约测试。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  ActiveKeyState,
  AppMsgMessage,
  I18nService,
  I18nText,
  I18nValues,
  KeyspaceService,
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
const KEYSPACE_SERVICE_CAPABILITY = "keyspace.service";

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

function makeFakeKeyspace(): KeyspaceService {
  const listeners = new Set<(state: ActiveKeyState) => void>();
  let active: ActiveKeyState = { activePublicKeyHex: OWNER };
  return {
    listKeys: async () => [],
    getKey: async () => undefined,
    active: () => active,
    setActive: async (publicKeyHex: string) => {
      active = { activePublicKeyHex: publicKeyHex };
      for (const listener of listeners) listener(active);
    },
    requireActiveKey: () => ({ publicKeyHex: OWNER, label: "fake", capabilities: [], createdAt: "" }),
    onActiveChange: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    openKeyStorage: async () => {
      throw new Error("not implemented");
    },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
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

function makeFakeHost(service: MessageService | null) {
  const providers: Record<string, unknown> = {
    [I18N_SERVICE_CAPABILITY]: makeFakeI18n(),
    [KEYSPACE_SERVICE_CAPABILITY]: makeFakeKeyspace()
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

  it("renders conversation list and peer body", async () => {
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
      expect(screen.getByText("message.page.title")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("real rendered body")).toBeTruthy();
      expect(screen.getByText("02aa...aaaa")).toBeTruthy();
    });
    expect(screen.queryByText("message.page.send.label")).toBeNull();
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
      expect(screen.getByText("message.page.title")).toBeTruthy();
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
      expect(screen.getByText("message.page.noClient")).toBeTruthy();
    });
  });
});

void vi;
