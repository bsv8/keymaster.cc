// packages/plugin-appmsg/src/AppMsgPage.test.tsx
// AppMsg 管理页契约测试（施工单 2026-07-04 001 硬切换）。
//
// 验证：
//   - 渲染 active provider 区块 + provider 列表 + 连接区 / 同步区 /
//     统计区 / 浏览区 / 在线查询区共 7 个区块；
//   - 手动同步失败时显示失败反馈；
//   - 页面根类名与 styles.css 契约一致（`appmsg-system-page`）；
//   - capability 缺失时显示降级空态；
//   - "未选择消息服务"空态：activeProvider.providerId === null。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ActiveMessageProviderSnapshot,
  AppMsgCore,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgOnlineResult,
  AppMsgTargetSyncState,
  I18nService,
  I18nText,
  I18nValues,
  LanguageMode,
  SupportedLanguage,
  SupportedLanguageDescriptor
} from "@keymaster/contracts";
import { APPMESSAGE_CORE_CAPABILITY, I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { PluginHostProvider } from "@keymaster/runtime";
import type { PluginHost } from "@keymaster/runtime";

const OWNER = "02aaaa".padEnd(66, "a");

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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeCoreHandle {
  host: PluginHost;
  snapshot: AppMsgLocalDbSnapshot;
  activeProvider: ActiveMessageProviderSnapshot;
  messages: AppMsgMessage[];
  targets: AppMsgTargetSyncState[];
  triggerSyncImpl: () => Promise<void>;
  setActiveProviderImpl: (id: string | null) => Promise<void>;
  listProvidersImpl: () => Array<{ id: string; displayName: string }>;
  checkOnlineImpl: (input: string[]) => Promise<AppMsgOnlineResult>;
}

function makeFakeCore(opts?: {
  snapshot?: AppMsgLocalDbSnapshot;
  activeProvider?: ActiveMessageProviderSnapshot;
  messages?: AppMsgMessage[];
  targets?: AppMsgTargetSyncState[];
  triggerSyncImpl?: () => Promise<void>;
  setActiveProviderImpl?: (id: string | null) => Promise<void>;
  listProviders?: Array<{
    id: string;
    displayName: string;
    health?: () => { isHealthy: boolean; lastError: string | null; lastConnectedAtMs: number };
  }>;
  checkOnlineImpl?: (input: string[]) => Promise<AppMsgOnlineResult>;
  providers?: () => unknown;
  onStateChangeImpl?: (handler: () => void) => () => void;
}): FakeCoreHandle {
  const snapshot = opts?.snapshot ?? {
    state: "open" as const,
    ownerPublicKeyHex: OWNER,
    lastInsertedAtMs: 1,
    lastError: null,
    nextReconnectAtMs: null
  };
  const activeProvider =
    opts?.activeProvider ?? {
      providerId: "hubmsg",
      displayName: "HubMsg",
      isHealthy: true,
      lastError: null
    };
  const messages = opts?.messages ?? [];
  const targets = opts?.targets ?? [];
  const triggerSyncImpl =
    opts?.triggerSyncImpl ?? (async () => undefined);
  const setActiveProviderImpl =
    opts?.setActiveProviderImpl ?? (async () => undefined);
  const listProviders = (opts?.listProviders ?? [{ id: "hubmsg", displayName: "HubMsg" }]).map(
    (provider) => ({
      ...provider,
      health:
        provider.health ??
        (() => ({
          isHealthy: activeProvider.isHealthy,
          lastError: activeProvider.lastError,
          lastConnectedAtMs: activeProvider.lastConnectedAtMs ?? 0
        }))
    })
  );

  const core = {
    inspectLocalDb: () => ({ ...snapshot }),
    activeProviderSnapshot: () => ({ ...activeProvider }),
    listUnfilteredMessages: async () => ({ items: messages, hasMore: false }),
    listTargetSyncStates: async () => targets,
    triggerSync: triggerSyncImpl,
    checkOnline: opts?.checkOnlineImpl ?? (async () => ({})),
    subscribeUnfilteredMessages: () => () => undefined,
    onStateChange: opts?.onStateChangeImpl ?? (() => () => undefined),
    providers: opts?.providers ?? (() => ({
      list: () => listProviders,
      activeSnapshot: () => activeProvider,
      setActive: setActiveProviderImpl,
      active: () => listProviders.find((p) => p.id === activeProvider.providerId),
      onActiveChange: () => () => undefined
    }))
  } as unknown as AppMsgCore;

  const providers: Record<string, unknown> = {
    [I18N_SERVICE_CAPABILITY]: makeFakeI18n(),
    [APPMESSAGE_CORE_CAPABILITY]: core
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
    graph: () => ({ plugins: [], dependencies: {}, provides: {}, reverse: {} }),
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
  return {
    host: host as unknown as PluginHost,
    snapshot,
    activeProvider,
    messages,
    targets,
    triggerSyncImpl,
    setActiveProviderImpl,
    listProvidersImpl: () => listProviders,
    checkOnlineImpl: opts?.checkOnlineImpl ?? (async () => ({}))
  };
}

describe("AppMsgPage in PluginHostProvider", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders title and seven section titles", async () => {
    const h = makeFakeCore();
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    expect(screen.getByText("appmsg.page.provider.active")).toBeTruthy();
    expect(screen.getByText("appmsg.page.providers.title")).toBeTruthy();
    expect(screen.getByText("appmsg.page.connection")).toBeTruthy();
    expect(screen.getByText("appmsg.page.sync")).toBeTruthy();
    expect(screen.getByText("appmsg.page.stats")).toBeTruthy();
    expect(screen.getByText("appmsg.page.online.label")).toBeTruthy();
    expect(screen.getByText("appmsg.page.browse")).toBeTruthy();
  });

  it("renders active provider id / name when one is selected", async () => {
    const h = makeFakeCore({
      activeProvider: {
        providerId: "hubmsg",
        displayName: "HubMsg",
        isHealthy: true,
        lastError: null
      }
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      // 用 getAllByText 因为 id "hubmsg" 既在 active provider 块也在
      // providers 列表的 code 块出现；断言**至少**有一处。
      const matches = screen.getAllByText("hubmsg");
      expect(matches.length).toBeGreaterThan(0);
    });
    // displayName 也可能多处出现（active provider 块 + providers 列表
    // 的 name 列）；同样用 getAllByText 断言至少一处。
    const names = screen.getAllByText("HubMsg");
    expect(names.length).toBeGreaterThan(0);
  });

  it("lets the user explicitly select the SatSubscription provider", async () => {
    const setActiveProvider = vi.fn(async () => undefined);
    const h = makeFakeCore({
      setActiveProviderImpl: setActiveProvider,
      listProviders: [
        { id: "hubmsg", displayName: "HubMsg" },
        { id: "sat-subscription", displayName: "SatSubscription" }
      ]
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );

    await waitFor(() => expect(screen.getAllByText("SatSubscription").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "appmsg.page.providers.activate" }));
    await waitFor(() => expect(setActiveProvider).toHaveBeenCalledWith("sat-subscription"));
  });

  it("renders 'no active provider' empty state when active is null", async () => {
    const h = makeFakeCore({
      activeProvider: {
        providerId: null,
        displayName: null,
        isHealthy: false,
        lastError: null
      },
      listProviders: []
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.provider.none")).toBeTruthy();
    });
  });

  it("renders missing-core empty state when capability is missing", async () => {
    const providers: Record<string, unknown> = {
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
      graph: () => ({ plugins: [], dependencies: {}, provides: {}, reverse: {} }),
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
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={host as unknown as PluginHost}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    expect(screen.getByText(/appmsg.core capability is not available/)).toBeTruthy();
  });

  it("statistics cover sender and recipient endpoints both", async () => {
    const m1 = msg({
      messageId: "m1",
      senderAppId: "keymaster.message",
      recipientOrigin: "https://a.example:443"
    });
    const m2 = msg({
      messageId: "m2",
      senderOrigin: "https://b.example:443",
      recipientAppId: "keymaster.message"
    });
    const h = makeFakeCore({ messages: [m1, m2] });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    // 两条消息分别贡献两个 endpoint key。select 应包含 origin:a.example / origin:b.example / appId:keymaster.message
    await waitFor(() => {
      const select = document.querySelector("select");
      expect(select).toBeTruthy();
      const opts = Array.from(select!.querySelectorAll("option")).map((o) => o.textContent);
      expect(opts).toContain("appId:keymaster.message");
    });
  });

  it("manual sync failure shows failure feedback", async () => {
    const triggerSyncImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const h = makeFakeCore({ triggerSyncImpl });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    const button = screen.getByText("appmsg.page.sync.trigger");
    fireEvent.click(button);
    // 失败反馈可能跨多个文本节点：用 function matcher 找包含 "boom" 的元素。
    await waitFor(() => {
      const nodes = Array.from(document.querySelectorAll("*")).filter((el) => {
        return el.children.length === 0 && (el.textContent ?? "").includes("boom");
      });
      expect(nodes.length).toBeGreaterThan(0);
    });
    expect(triggerSyncImpl).toHaveBeenCalledTimes(1);
  });

  it("online query shows validation error for invalid hex and clears old error on success", async () => {
    const gate = deferred<AppMsgOnlineResult>();
    const checkOnlineImpl = vi.fn(async () => gate.promise);
    const h = makeFakeCore({ checkOnlineImpl });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    const input = screen.getByPlaceholderText("appmsg.page.online.placeholder");
    const button = screen.getByText("appmsg.page.online.check");

    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("appmsg.page.online.fail.invalidHex")).toBeTruthy();
    });
    expect(checkOnlineImpl).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: OWNER } });
    fireEvent.click(button);

    await waitFor(() => {
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(screen.getByText("appmsg.page.online.loading")).toBeTruthy();
    });

    gate.resolve({ [OWNER]: "offline" });

    await waitFor(() => {
      expect(screen.getByText("appmsg.page.online.offline")).toBeTruthy();
    });
    expect(document.querySelector("[data-appmsg-online-result=\"offline\"]")).toBeTruthy();
    expect(document.querySelector("[data-appmsg-online-phase=\"success\"]")).toBeTruthy();
    expect(screen.queryByText("appmsg.page.online.fail.invalidHex")).toBeNull();
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(checkOnlineImpl).toHaveBeenCalledTimes(1);
  });

  it("online query shows explicit failure when appmsg is not ready", async () => {
    const checkOnlineImpl = vi.fn(async () => ({}));
    const h = makeFakeCore({
      activeProvider: {
        providerId: null,
        displayName: null,
        isHealthy: false,
        lastError: null
      },
      snapshot: {
        state: "closed",
        ownerPublicKeyHex: null,
        lastInsertedAtMs: 1,
        lastError: null,
        nextReconnectAtMs: null
      },
      checkOnlineImpl
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    const input = screen.getByPlaceholderText("appmsg.page.online.placeholder");
    const button = screen.getByText("appmsg.page.online.check");

    fireEvent.change(input, { target: { value: OWNER } });
    fireEvent.click(button);

    await waitFor(() => {
      const feedback = document.querySelector(
        "[data-appmsg-online-feedback][data-appmsg-online-phase=\"error\"]"
      );
      expect(feedback).toBeTruthy();
      expect((feedback?.textContent ?? "")).toContain("appmsg.page.online.fail.notReady");
    });
    expect(screen.getByText("appmsg.page.provider.none")).toBeTruthy();
    expect(checkOnlineImpl).not.toHaveBeenCalled();
  });

  it("online query shows unknown as visible partial feedback", async () => {
    const checkOnlineImpl = vi.fn(async () => ({ [OWNER]: "unknown" as const }));
    const h = makeFakeCore({ checkOnlineImpl });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    const input = screen.getByPlaceholderText("appmsg.page.online.placeholder");
    const button = screen.getByText("appmsg.page.online.check");

    fireEvent.change(input, { target: { value: OWNER } });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("appmsg.page.online.unknown")).toBeTruthy();
    });
    expect(document.querySelector("[data-appmsg-online-feedback][data-appmsg-online-phase=\"success\"]")).toBeTruthy();
    expect(document.querySelector("[data-appmsg-online-result=\"unknown\"]")).toBeTruthy();
    expect(checkOnlineImpl).toHaveBeenCalledTimes(1);
  });

  it("online query shows success feedback for explicit online result", async () => {
    const checkOnlineImpl = vi.fn(async () => ({ [OWNER]: "online" as const }));
    const h = makeFakeCore({ checkOnlineImpl });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    const input = screen.getByPlaceholderText("appmsg.page.online.placeholder");
    const button = screen.getByText("appmsg.page.online.check");

    fireEvent.change(input, { target: { value: OWNER } });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("appmsg.page.online.online")).toBeTruthy();
    });
    expect(document.querySelector("[data-appmsg-online-feedback][data-appmsg-online-phase=\"success\"]")).toBeTruthy();
    expect(document.querySelector("[data-appmsg-online-result=\"online\"]")).toBeTruthy();
    expect(checkOnlineImpl).toHaveBeenCalledTimes(1);
  });

  it("online query shows failure context when core degrades provider error to unknown", async () => {
    const h = makeFakeCore({
      checkOnlineImpl: async (_input: string[]) => {
        h.snapshot.lastError = "provider connection lost";
        return { [OWNER]: "unknown" as const };
      }
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    const input = screen.getByPlaceholderText("appmsg.page.online.placeholder");
    const button = screen.getByText("appmsg.page.online.check");

    fireEvent.change(input, { target: { value: OWNER } });
    fireEvent.click(button);

    await waitFor(() => {
      const feedback = document.querySelector(
        "[data-appmsg-online-feedback][data-appmsg-online-phase=\"error\"]"
      );
      expect(feedback).toBeTruthy();
      expect((feedback?.textContent ?? "")).toContain("appmsg.page.online.fail.queryFailed");
      expect((feedback?.textContent ?? "")).toContain("provider connection lost");
    });
    expect(document.querySelector("[data-appmsg-online-result=\"unknown\"]")).toBeNull();
  });
});

/* ============== 硬切换 003：连接区倒计时展示 ============== */

describe("AppMsgPage - reconnect countdown display", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not render reconnect row when nextReconnectAtMs is null", async () => {
    const h = makeFakeCore({
      snapshot: {
        state: "open",
        ownerPublicKeyHex: OWNER,
        lastInsertedAtMs: 1,
        lastError: null,
        nextReconnectAtMs: null
      }
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    expect(document.querySelector("[data-appmsg-reconnect-row]")).toBeNull();
  });

  it("renders reconnect row with remaining seconds when nextReconnectAtMs is set", async () => {
    const h = makeFakeCore({
      snapshot: {
        state: "closed",
        ownerPublicKeyHex: OWNER,
        lastInsertedAtMs: 1,
        lastError: "boom",
        nextReconnectAtMs: Date.now() + 5000
      }
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    // 倒计时行必须存在，且剩余秒数 data 属性 >= 1。
    const row = document.querySelector("[data-appmsg-reconnect-row]");
    expect(row).toBeTruthy();
    const remaining = document.querySelector("[data-appmsg-reconnect-remaining]");
    expect(remaining).toBeTruthy();
    const n = Number(remaining!.getAttribute("data-appmsg-reconnect-remaining"));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(5);
  });

  it("subscribes to onStateChange and refreshes the connection snapshot", async () => {
    const listeners: Array<() => void> = [];
    const dynamicSnapshot: AppMsgLocalDbSnapshot = {
      state: "open",
      ownerPublicKeyHex: OWNER,
      lastInsertedAtMs: 1,
      lastError: null,
      nextReconnectAtMs: null
    };
    const onStateChangeImpl = (handler: () => void) => {
      listeners.push(handler);
      return () => {
        const i = listeners.indexOf(handler);
        if (i >= 0) listeners.splice(i, 1);
      };
    };
    const h = makeFakeCore({
      snapshot: dynamicSnapshot,
      onStateChangeImpl
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    // 订阅已挂上。
    expect(listeners.length).toBe(1);
    // 没有 nextReconnectAtMs → 不显示倒计时行。
    expect(document.querySelector("[data-appmsg-reconnect-row]")).toBeNull();
    // 改 snapshot 并通知 → 页面应立即刷新。
    dynamicSnapshot.state = "closed";
    dynamicSnapshot.lastError = "net down";
    dynamicSnapshot.nextReconnectAtMs = Date.now() + 5000;
    for (const l of listeners) {
      try {
        l();
      } catch {
        // ignore
      }
    }
    await waitFor(() => {
      const row = document.querySelector("[data-appmsg-reconnect-row]");
      expect(row).toBeTruthy();
    });
  });

  it("refreshes provider health diagnostics on a core state change", async () => {
    const listeners: Array<() => void> = [];
    const health: {
      isHealthy: boolean;
      lastError: string | null;
      lastConnectedAtMs: number;
    } = {
      isHealthy: false,
      lastError: "initial provider snapshot",
      lastConnectedAtMs: 0
    };
    const h = makeFakeCore({
      snapshot: {
        state: "open",
        ownerPublicKeyHex: OWNER,
        lastInsertedAtMs: 1,
        lastError: null,
        nextReconnectAtMs: null
      },
      activeProvider: {
        providerId: "hubmsg",
        displayName: "HubMsg",
        isHealthy: false,
        lastError: health.lastError
      },
      listProviders: [
        {
          id: "hubmsg",
          displayName: "HubMsg",
          health: () => health
        }
      ],
      onStateChangeImpl: (handler) => {
        listeners.push(handler);
        return () => undefined;
      }
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(
        document.querySelector('[data-appmsg-provider-health="unhealthy"]')
      ).toBeTruthy();
    });
    health.isHealthy = true;
    health.lastError = null;
    health.lastConnectedAtMs = 123;
    h.activeProvider.isHealthy = true;
    h.activeProvider.lastError = null;
    for (const listener of listeners) listener();
    await waitFor(() => {
      expect(
        document.querySelector('[data-appmsg-provider-health="healthy"]')
      ).toBeTruthy();
      expect(
        document.querySelector('[data-appmsg-connection-assessment="ok"]')
      ).toBeTruthy();
    });
  });

  it("shows a mismatch explicitly when core is connected but the provider is unhealthy", async () => {
    const h = makeFakeCore({
      snapshot: {
        state: "open",
        ownerPublicKeyHex: OWNER,
        lastInsertedAtMs: 0,
        lastError: null,
        nextReconnectAtMs: null
      },
      activeProvider: {
        providerId: "hubmsg",
        displayName: "HubMsg",
        isHealthy: false,
        lastError: "provider closed"
      },
      listProviders: [
        {
          id: "hubmsg",
          displayName: "HubMsg",
          health: () => ({
            isHealthy: false,
            lastError: "provider closed",
            lastConnectedAtMs: 0
          })
        }
      ]
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(
        document.querySelector(
          '[data-appmsg-connection-assessment="coreOpenProviderUnhealthy"]'
        )
      ).toBeTruthy();
    });
    expect(screen.getByText("appmsg.page.connection.providers")).toBeTruthy();
    expect(screen.getAllByText("provider closed").length).toBeGreaterThan(0);
  });

  it("state=idle + lastError 残留时不显示倒计时", async () => {
    // 反馈"必改"测试：page 不应被 `lastError` 残留顶出 closed 倒计时。
    const h = makeFakeCore({
      snapshot: {
        state: "idle",
        ownerPublicKeyHex: null,
        lastInsertedAtMs: 0,
        lastError: "an old error from a previous failed attempt",
        nextReconnectAtMs: null
      }
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    // state=idle 区块文案展示。
    expect(
      screen.getByText("appmsg.page.connection.state.idle")
    ).toBeTruthy();
    // 不显示倒计时行。
    expect(document.querySelector("[data-appmsg-reconnect-row]")).toBeNull();
    // lastError 仍在 lastError 行展示（信息不丢）。
    expect(
      screen.getByText("an old error from a previous failed attempt")
    ).toBeTruthy();
  });

  it("nextReconnectAtMs 不在 closed 时不显示倒计时（防止语义漂移）", async () => {
    // 反馈"必改"测试：仅在 `state === "closed"` 才显示倒计时。
    const h = makeFakeCore({
      snapshot: {
        // 异常态：nextReconnectAtMs 有值但 state 不是 closed——不应显示。
        state: "open",
        ownerPublicKeyHex: OWNER,
        lastInsertedAtMs: 0,
        lastError: null,
        nextReconnectAtMs: Date.now() + 5000
      }
    });
    const { AppMsgPage } = await import("./AppMsgPage.js");
    render(
      <PluginHostProvider host={h.host}>
        <AppMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("appmsg.page.title")).toBeTruthy();
    });
    expect(document.querySelector("[data-appmsg-reconnect-row]")).toBeNull();
  });
});
