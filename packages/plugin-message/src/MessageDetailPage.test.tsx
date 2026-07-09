// packages/plugin-message/src/MessageDetailPage.test.tsx
// 会话详情页契约测试。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function makeFakeService(opts?: { messages?: AppMsgMessage[]; onListMessages?: (input?: { limit?: number; afterMessageId?: string }) => void }): MessageService {
  const messages = opts?.messages ?? [];
  return {
    isReady: () => true,
    listMessages: async (input) => {
      opts?.onListMessages?.(input);
      return messages;
    },
    getMessage: async (id: string) => messages.find((m) => m.messageId === id) ?? null,
    sendTextMessage: async () => undefined,
    subscribeMessages: () => () => undefined
  };
}

function makeFakeHost(service: MessageService | null): PluginHost {
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
    window.history.pushState({}, "", "/");
  });

  it("renders conversation body when peer is in scope", async () => {
    const peer = "02aaaa".padEnd(66, "a");
    const sample: AppMsgMessage = {
      messageId: "id-detail-1",
      clientMessageId: "c-detail-1",
      senderPublicKeyHex: peer,
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
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("detail body text")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getAllByText("02aaaaaa...aaaaaaaa").length).toBeGreaterThan(0);
    });
  });

  it("renders newest messages closer to the composer", async () => {
    const peer = "02eeee".padEnd(66, "e");
    const older: AppMsgMessage = {
      messageId: "id-detail-old",
      clientMessageId: "c-detail-old",
      senderPublicKeyHex: peer,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: OWNER,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: "older message",
      createdAtMs: 1000,
      insertedAtMs: 1000
    };
    const newer: AppMsgMessage = {
      messageId: "id-detail-new",
      clientMessageId: "c-detail-new",
      senderPublicKeyHex: OWNER,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: peer,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: "newer message",
      createdAtMs: 2000,
      insertedAtMs: 2000
    };
    const service = makeFakeService({ messages: [older, newer] });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("older message")).toBeTruthy();
      expect(screen.getByText("newer message")).toBeTruthy();
    });
    const bodies = screen.getAllByText(/message$/);
    expect(bodies[0]?.textContent).toBe("newer message");
    expect(bodies[1]?.textContent).toBe("older message");
  });

  it("shows 20 messages by default and loads 20 more on demand", async () => {
    const peer = "02ffff".padEnd(66, "f");
    const messages: AppMsgMessage[] = Array.from({ length: 25 }, (_, index) => ({
      messageId: `id-${index}`,
      clientMessageId: `c-${index}`,
      senderPublicKeyHex: index % 2 === 0 ? OWNER : peer,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: index % 2 === 0 ? peer : OWNER,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: `message-${index}`,
      createdAtMs: index + 1,
      insertedAtMs: index + 1
    }));
    const service = makeFakeService({ messages });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("message-24")).toBeTruthy();
    });
    expect(screen.getByText("message-5")).toBeTruthy();
    expect(screen.queryByText("message-4")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "message.page.detail.loadMore" }));
    await waitFor(() => {
      expect(screen.getByText("message-4")).toBeTruthy();
    });
  });

  it("renders empty state when peer conversation is empty", async () => {
    const peer = "02cccc".padEnd(66, "c");
    const service = makeFakeService({ messages: [] });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.empty")).toBeTruthy();
    });
  });

  it("loads a larger message window for older conversations", async () => {
    const peer = "02dddd".padEnd(66, "d");
    const seenLimits: number[] = [];
    const sample: AppMsgMessage = {
      messageId: "id-detail-window",
      clientMessageId: "c-detail-window",
      senderPublicKeyHex: peer,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: OWNER,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: "older conversation body",
      createdAtMs: 1000,
      insertedAtMs: 2000
    };
    const service = makeFakeService({
      messages: [sample],
      onListMessages: (input) => {
        seenLimits.push(input?.limit ?? 0);
      }
    });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("older conversation body")).toBeTruthy();
    });
    expect(seenLimits.some((limit) => limit >= 10_000)).toBe(true);
  });

  it("renders missing-service empty state when capability is missing (唯一降级路径)", async () => {
    const host = makeFakeHost(null);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", "/messages/any");
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("message.page.noClient")).toBeTruthy();
    });
  });

  it("does NOT render sync / connection / global stat UI", async () => {
    const service = makeFakeService({ messages: [] });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", "/messages/x");
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "x" })).toBeTruthy();
    });
    expect(screen.queryByText("message.page.sync.state.label")).toBeNull();
    expect(screen.queryByText("message.page.online.label")).toBeNull();
    expect(screen.queryByText("message.page.list.label")).toBeNull();
  });
});

void vi;
