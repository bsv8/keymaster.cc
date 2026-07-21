// packages/plugin-message/src/MessagePage.test.tsx
// 消息首页契约测试。

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
    onActiveKeyChanged: (handler: (state: ActiveKeyState) => void) => {
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

  // 创建资源注册表和资源存储
  const resourceDefinitions = new Map<string, any>();
  const resourceRegistry = {
    register: (def: any) => resourceDefinitions.set(def.id, def),
    unregister: (id: string) => resourceDefinitions.delete(id),
    get: (id: string) => resourceDefinitions.get(id),
    _ids: () => Array.from(resourceDefinitions.keys())
  };

  // 注册 message.conversations 资源定义
  const keyspace = providers[KEYSPACE_SERVICE_CAPABILITY] as KeyspaceService;
  resourceRegistry.register({
    id: "message.conversations",
    scope: "active-key",
    key: (_args: readonly string[], context: { activePublicKeyHex?: string }) =>
      ["message.conversations", context.activePublicKeyHex ?? "none"],
    load: async () => {
      const messages = service ? await service.listMessages({ limit: 10_000 }) : [];
      return { messages, contactsByPeer: {} };
    },
    subscribe: (_args: readonly string[], _ctx: unknown, invalidate: () => void) => {
      if (!service) return () => {};
      return service.subscribeMessages(invalidate);
    },
    equals: (prev: any, next: any) => {
      if (!prev || !next) return prev === next;
      if (prev.messages.length !== next.messages.length) return false;
      return true;
    },
    invalidation: "microtask"
  });

  // 创建简单的 resourceStore
  const records = new Map<string, any>();
  const resourceStore = {
    ensure: <T,>(definitionId: string, args: readonly string[]) => {
      const def = resourceDefinitions.get(definitionId);
      if (!def) throw new Error(`Resource definition "${definitionId}" not found`);
      const context = { activePublicKeyHex: keyspace.active().activePublicKeyHex };
      const key = def.key(args, context);
      const rk = `${definitionId}::${key.join("::")}`;
      let record = records.get(rk);
      if (!record) {
        record = {
          snapshot: { key, status: "pending", data: undefined, revision: 0 },
          inFlight: null,
          subscribers: new Set()
        };
        records.set(rk, record);
        // 开始加载
        record.inFlight = def.load(args, context, new AbortController().signal);
        record.inFlight.then((data: any) => {
          record.snapshot = { key, status: "ready", data, revision: 1 };
          record.inFlight = null;
          for (const sub of record.subscribers) sub();
        }).catch(() => {
          record.snapshot = { key, status: "error", data: undefined, revision: 1 };
          record.inFlight = null;
          for (const sub of record.subscribers) sub();
        });
      }
      return record.snapshot as T;
    },
    subscribe: (definitionId: string, args: readonly string[], callback: () => void) => {
      const def = resourceDefinitions.get(definitionId);
      if (!def) return () => {};
      const context = { activePublicKeyHex: keyspace.active().activePublicKeyHex };
      const key = def.key(args, context);
      const rk = `${definitionId}::${key.join("::")}`;
      let record = records.get(rk);
      if (!record) {
        record = {
          snapshot: { key, status: "pending", data: undefined, revision: 0 },
          inFlight: null,
          subscribers: new Set()
        };
        records.set(rk, record);
      }
      record.subscribers.add(callback);
      return () => record.subscribers.delete(callback);
    },
    read: <T,>(definitionId: string, args: readonly string[]) => {
      const def = resourceDefinitions.get(definitionId);
      if (!def) return undefined;
      const context = { activePublicKeyHex: keyspace.active().activePublicKeyHex };
      const key = def.key(args, context);
      const rk = `${definitionId}::${key.join("::")}`;
      return records.get(rk)?.snapshot as T | undefined;
    },
    invalidate: () => {},
    disposeOwner: () => {}
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
    resourceStore,
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

  it("opens the new chat modal and navigates to the detail route", async () => {
    const service = makeFakeService({ messages: [] });
    const { host } = makeFakeHost(service);
    const { MessagePage } = await import("./MessagePage.js");
    window.history.pushState({}, "", "/messages");
    render(
      <PluginHostProvider host={host}>
        <MessagePage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("message.page.title")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "message.page.newChat.open" }));

    const input = screen.getByLabelText("message.page.newChat.label");
    fireEvent.change(input, { target: { value: OWNER } });
    fireEvent.click(screen.getByRole("button", { name: "message.page.newChat.submit" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/message/${OWNER}`);
    });
  });

  it("rejects invalid publicKeyHex in the new chat modal", async () => {
    const service = makeFakeService({ messages: [] });
    const { host } = makeFakeHost(service);
    const { MessagePage } = await import("./MessagePage.js");
    window.history.pushState({}, "", "/messages");
    render(
      <PluginHostProvider host={host}>
        <MessagePage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("message.page.title")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "message.page.newChat.open" }));
    fireEvent.change(screen.getByLabelText("message.page.newChat.label"), {
      target: { value: "abc" }
    });
    fireEvent.click(screen.getByRole("button", { name: "message.page.newChat.submit" }));

    expect(screen.getByText("message.page.newChat.error.invalid")).toBeTruthy();
    expect(window.location.pathname).toBe("/messages");
  });
});

void vi;
