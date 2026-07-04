// packages/plugin-appmsg/src/HubMsgPage.test.tsx
// HubMsg 管理页契约测试（施工单 2026-07-03 002 硬切换 + 文件级修改意见 §10）。
//
// 验证：
//   - 渲染连接区 / 同步区 / 统计区 / 浏览区四个区块；
//   - 统计**同时覆盖** sender 与 recipient 两端 endpoint；
//   - 手动同步失败时显示失败反馈；
//   - 页面根类名与 styles.css 契约一致（`appmsg-system-page`）；
//   - capability 缺失时显示降级空态。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { APPMESSAGE_CORE_CAPABILITY, I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { PluginHostProvider } from "@keymaster/runtime";
import type { PluginHost } from "@keymaster/runtime";

const OWNER = "02aaaa".padEnd(66, "a");

/**
 * 最小 I18nService stub：满足 useI18n() 真实需要的全部方法。
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

interface FakeCoreHandles {
  core: AppMsgCore;
  calls: { triggerSync: number };
}

function makeFakeCore(opts?: {
  snapshot?: AppMsgLocalDbSnapshot;
  messages?: AppMsgMessage[];
  targets?: AppMsgTargetSyncState[];
  triggerSyncBehavior?: () => Promise<void>;
}): FakeCoreHandles {
  const snapshot: AppMsgLocalDbSnapshot = opts?.snapshot ?? {
    state: "open",
    ownerPublicKeyHex: OWNER,
    lastInsertedAtMs: 0,
    lastError: null
  };
  const messages = opts?.messages ?? [];
  const targets = opts?.targets ?? [];
  const calls = { triggerSync: 0 };
  return {
    core: {
      connectForOwner: async () => undefined,
      disconnect: async () => undefined,
      inspectLocalDb: () => snapshot,
      openLocalDb: async () => null,
      sendScopedMessage: async () => ({ messageId: "0", createdAtMs: 0 }),
      listScopedMessages: async () => ({ items: [], hasMore: false }),
      getScopedMessage: async () => null,
      subscribeScopedMessages: () => () => undefined,
      subscribeUnfilteredMessages: () => () => undefined,
      listUnfilteredMessages: async () => ({ items: messages, hasMore: false }),
      createMessageScopedClient: (() => {
        throw new Error("not used in this test");
      }) as never,
      triggerSync: async () => {
        calls.triggerSync += 1;
        if (opts?.triggerSyncBehavior) {
          await opts.triggerSyncBehavior();
        }
      },
      listTargetSyncStates: async () => targets,
      checkOnline: async (hexes: string[]): Promise<AppMsgOnlineResult> => {
        const out: AppMsgOnlineResult = {};
        for (const h of hexes) out[h] = "online";
        return out;
      }
    } as unknown as AppMsgCore,
    calls
  };
}

function makeFakeHost(core: AppMsgCore | null): PluginHost {
  const providers: Record<string, unknown> = {
    [I18N_SERVICE_CAPABILITY]: makeFakeI18n()
  };
  if (core) {
    providers[APPMESSAGE_CORE_CAPABILITY] = core;
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

describe("HubMsgPage in PluginHostProvider", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders root container with appmsg-system-page class (smoke + 样式契约)", async () => {
    const { core } = makeFakeCore({ messages: [] });
    const host = makeFakeHost(core);
    const { HubMsgPage } = await import("./HubMsgPage.js");
    const { container } = render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );
    // 根 section 用 appmsg-system-page；这是与 styles.css 的契约点。
    await waitFor(() => {
      const root = container.querySelector("section.appmsg-system-page");
      expect(root).toBeTruthy();
    });
  });

  it("renders connection / sync / stats / browse 四个区块", async () => {
    const { core } = makeFakeCore({ messages: [] });
    const host = makeFakeHost(core);
    const { HubMsgPage } = await import("./HubMsgPage.js");
    const { container } = render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );
    // 通过 modifier class 验证四个区块都在——modifier class 是与 styles.css
    // 唯一对齐的契约点，**不**用 i18n 文案（避免与未来文案变更耦合）。
    await waitFor(() => {
      expect(
        container.querySelector(".appmsg-system-page__card--sync")
      ).toBeTruthy();
      expect(
        container.querySelector(".appmsg-system-page__card--stats")
      ).toBeTruthy();
      expect(
        container.querySelector(".appmsg-system-page__card--online")
      ).toBeTruthy();
      expect(
        container.querySelector(".appmsg-system-page__card--browse")
      ).toBeTruthy();
      // 连接区是默认 `.appmsg-system-page__card`，不带 modifier；至少要有 1 个。
      const connectionCards = container.querySelectorAll(
        ".appmsg-system-page__card:not([class*='--'])"
      );
      expect(connectionCards.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("统计覆盖 sender 与 recipient 两端 endpoint", async () => {
    // 这条消息：sender 是 appId:a.legacy，recipient 是 origin:https://b.example:443
    // ——统计应当同时给出两条 key。
    const m = msg({
      messageId: "m-endpoints",
      senderPublicKeyHex: OWNER,
      senderAppId: "a.legacy",
      recipientPublicKeyHex: OWNER,
      recipientOrigin: "https://b.example:443",
      body: "x",
      createdAtMs: 1,
      insertedAtMs: 1
    });
    const { core } = makeFakeCore({ messages: [m] });
    const host = makeFakeHost(core);
    const { HubMsgPage } = await import("./HubMsgPage.js");
    const { container } = render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      // 统计 card 用 `.appmsg-system-page__card--stats` 锁定，避免与 browse
      // filter <option> 的同名文本撞上。
      const statsCard = container.querySelector(".appmsg-system-page__card--stats");
      expect(statsCard).toBeTruthy();
      expect(statsCard?.textContent).toContain("appId:a.legacy");
      expect(statsCard?.textContent).toContain("origin:https://b.example:443");
    });
  });

  it("过滤选项同时列出 sender 与 recipient endpoint key", async () => {
    const m = msg({
      messageId: "m-filter",
      senderAppId: "a.outbound",
      recipientOrigin: "https://c.example:443",
      body: "y"
    });
    const { core } = makeFakeCore({ messages: [m] });
    const host = makeFakeHost(core);
    const { HubMsgPage } = await import("./HubMsgPage.js");
    render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      // select 的 option 包含两侧 endpoint。
      expect(screen.getByRole("option", { name: "appId:a.outbound" })).toBeTruthy();
      expect(
        screen.getByRole("option", { name: "origin:https://c.example:443" })
      ).toBeTruthy();
    });
  });

  it("手动同步失败时显示失败反馈", async () => {
    const { core } = makeFakeCore({
      messages: [],
      triggerSyncBehavior: async () => {
        throw new Error("hub not bound");
      }
    });
    const host = makeFakeHost(core);
    const { HubMsgPage } = await import("./HubMsgPage.js");
    render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("hubmsg.page.sync")).toBeTruthy();
    });
    const button = screen.getByRole("button", { name: "hubmsg.page.sync.trigger" });
    fireEvent.click(button);
    await waitFor(() => {
      // 失败反馈带 messageId data attribute = "fail"
      const node = document.querySelector('[data-hubmsg-sync="fail"]');
      expect(node).toBeTruthy();
      expect(node?.textContent).toMatch(/hub not bound/);
    });
  });

  it("手动同步成功时显示 ok 反馈", async () => {
    const { core, calls } = makeFakeCore({ messages: [] });
    const host = makeFakeHost(core);
    const { HubMsgPage } = await import("./HubMsgPage.js");
    render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("hubmsg.page.sync")).toBeTruthy();
    });
    const button = screen.getByRole("button", { name: "hubmsg.page.sync.trigger" });
    fireEvent.click(button);
    await waitFor(() => {
      const node = document.querySelector('[data-hubmsg-sync="ok"]');
      expect(node).toBeTruthy();
    });
    expect(calls.triggerSync).toBe(1);
  });

  it("capability 缺失时显示降级空态", async () => {
    const host = makeFakeHost(null);
    const { HubMsgPage } = await import("./HubMsgPage.js");
    const { container } = render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      const root = container.querySelector('[data-hubmsg-page="missing-core"]');
      expect(root).toBeTruthy();
    });
  });

  it("sender == recipient 时 endpoint key 不会重复计数（去重契约）", async () => {
    // 这条消息两端都是 `appId:keymaster.message`（自发自收场景）。
    // 去重后统计表里 `appId:keymaster.message` 应当出现**1 次**，count = 1。
    const m = msg({
      messageId: "m-self",
      senderPublicKeyHex: OWNER,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: OWNER,
      recipientAppId: "keymaster.message",
      body: "self"
    });
    const { core } = makeFakeCore({ messages: [m] });
    const host = makeFakeHost(core);
    const { HubMsgPage, collectMessageEndpoints } = await import("./HubMsgPage.js");
    const { container } = render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );

    // 函数级断言：去重集合语义。
    expect(collectMessageEndpoints(m)).toEqual(["appId:keymaster.message"]);

    // DOM 级断言：统计表里 `appId:keymaster.message` 恰好出现 1 次（不在
    // browse filter 的 `<option>` 里——本测试用 statsCard 锁定）。
    await waitFor(() => {
      const statsCard = container.querySelector(".appmsg-system-page__card--stats");
      expect(statsCard).toBeTruthy();
      const codes = statsCard?.querySelectorAll("tbody code") ?? [];
      const matches = Array.from(codes).filter(
        (el) => el.textContent === "appId:keymaster.message"
      );
      expect(matches.length).toBe(1);
      // 同一行右侧 count 也应当是 1。
      const countCell = matches[0]?.parentElement?.nextElementSibling;
      expect(countCell?.textContent).toBe("1");
    });
  });

  it("sender == recipient 是同 origin 时也只计一次", async () => {
    const m = msg({
      messageId: "m-self-origin",
      senderPublicKeyHex: OWNER,
      senderOrigin: "https://a.example:443",
      recipientPublicKeyHex: OWNER,
      recipientOrigin: "https://a.example:443",
      body: "self"
    });
    const { core } = makeFakeCore({ messages: [m] });
    const host = makeFakeHost(core);
    const { HubMsgPage, collectMessageEndpoints } = await import("./HubMsgPage.js");
    const { container } = render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );
    expect(collectMessageEndpoints(m)).toEqual(["origin:https://a.example:443"]);
    await waitFor(() => {
      const statsCard = container.querySelector(".appmsg-system-page__card--stats");
      const codes = statsCard?.querySelectorAll("tbody code") ?? [];
      const matches = Array.from(codes).filter(
        (el) => el.textContent === "origin:https://a.example:443"
      );
      expect(matches.length).toBe(1);
    });
  });

  it("连接状态 open → 状态节点带 is-ok", async () => {
    const { core } = makeFakeCore({
      snapshot: {
        state: "open",
        ownerPublicKeyHex: OWNER,
        lastInsertedAtMs: 0,
        lastError: null
      }
    });
    const host = makeFakeHost(core);
    const { HubMsgPage } = await import("./HubMsgPage.js");
    const { container } = render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      const node = container.querySelector('[data-hubmsg-state="open"]');
      expect(node).toBeTruthy();
      expect(node?.classList.contains("is-ok")).toBe(true);
      expect(node?.classList.contains("appmsg-system-page__status")).toBe(true);
    });
  });

  it("连接状态 closed → 状态节点带 is-failed", async () => {
    const { core } = makeFakeCore({
      snapshot: {
        state: "closed",
        ownerPublicKeyHex: null,
        lastInsertedAtMs: 0,
        lastError: "no signer"
      }
    });
    const host = makeFakeHost(core);
    const { HubMsgPage } = await import("./HubMsgPage.js");
    const { container } = render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      const node = container.querySelector('[data-hubmsg-state="closed"]');
      expect(node).toBeTruthy();
      expect(node?.classList.contains("is-failed")).toBe(true);
    });
  });

  it("连接状态 idle → 状态节点带 is-partial", async () => {
    const { core } = makeFakeCore({
      snapshot: {
        state: "idle",
        ownerPublicKeyHex: null,
        lastInsertedAtMs: 0,
        lastError: null
      }
    });
    const host = makeFakeHost(core);
    const { HubMsgPage } = await import("./HubMsgPage.js");
    const { container } = render(
      <PluginHostProvider host={host}>
        <HubMsgPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      const node = container.querySelector('[data-hubmsg-state="idle"]');
      expect(node).toBeTruthy();
      expect(node?.classList.contains("is-partial")).toBe(true);
    });
  });

  it("connectionStatusClass 工具函数：raw state → 抽象色类", async () => {
    const { connectionStatusClass } = await import("./HubMsgPage.js");
    expect(connectionStatusClass("open")).toBe("is-ok");
    expect(connectionStatusClass("closed")).toBe("is-failed");
    expect(connectionStatusClass("idle")).toBe("is-partial");
  });
});

void vi;