// packages/plugin-appmsg/src/AppMsgSystemPage.test.tsx
// AppMsgSystemPage 单测（施工单 2026-07-02 001 §6.2.5）。
//
// 覆盖：
//   1. 路由注册：manifest setup 后 /system/messages 路由在 route.registry。
//   2. 菜单挂载：菜单项 group === "system"、path === "/system/messages"。
//   3. 锁定态：刷新按钮 disabled；连接卡显示 disconnected / no owner。
//   4. 单 channel 失败：其余行继续展示数据（不"全失败"）。
//   5. 页面不渲染任何 message body / markdown / 明细。
//
// 不覆盖（依赖真 WebSocket / 真 HubMsg，不在本单范围）：
//   - 已 bound 时 inspectConnection 跨 page load 刷新（依赖 e2e 联调）。
//   - 跨仓 logDiagnosticsRefreshFailed 的真日志落库（由 /settings/logs
//     跨仓联调覆盖）。
//
// 关键不变量：
//   - 不接真 WebSocket / 真 HubMsg：用 fakeAppMsgCore 模拟 `appmsg.core`
//     capability；vault 用 unlockableFakeVault。
//   - 渲染前 register appmsgPlatformPlugin；让 i18n 资源 / 路由 / 菜单就位。

// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  APPMESSAGE_CORE_CAPABILITY,
  type AppMsgAddress,
  type AppMsgChannelCountBox,
  type AppMsgConnectionSnapshot,
  type AppMsgCore,
  type MenuItem,
  type VaultService,
  type VaultStatus
} from "@keymaster/contracts";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import { AppMsgSystemPage } from "./AppMsgSystemPage.js";
import { appmsgPlatformPlugin } from "./manifest.js";

/* ============== fake AppMsgCore ============== */

interface FakeAppMsgCoreOptions {
  initialSnap: AppMsgConnectionSnapshot;
  pluginEndpoints?: string[];
  origins?: string[];
  countsByKey?: Map<string, { inbox: number; sent: number; all: number }>;
  /**
   * 强制把对应 key 的 scope 标为失败。key 形如 `kind::id`。
   */
  failKeys?: Set<string>;
  /**
   * 在 listKnownOrigins 抛错（模拟 list_known_origins 阶段失败）。
   */
  listOriginsThrow?: Error;
  /** 模拟 reconnectIfNeeded 应当 setConn 触发 bound 的延迟。 */
  simulateReconnect?: boolean;
  /**
   * 注入到 `logDiagnosticsRefreshFailed` 的 spy；用于断言 page-level
   * 失败日志在锁定 / list_known_origins 失败时被正确调用。
   */
  logSpy?: ReturnType<typeof vi.fn>;
}

function makeFakeCore(opts: FakeAppMsgCoreOptions): AppMsgCore & { __setSnap: (s: AppMsgConnectionSnapshot) => void; __snap: () => AppMsgConnectionSnapshot } {
  let currentSnap: AppMsgConnectionSnapshot = opts.initialSnap;
  const setSnap = (s: AppMsgConnectionSnapshot): void => {
    currentSnap = s;
  };
  const core: AppMsgCore = {
    async connectForOwner(_owner: string): Promise<void> {
      // 不真接 HubMsg；触发可选的 "reconnect 之后变 bound"。
      if (opts.simulateReconnect) {
        currentSnap = {
          state: "bound",
          ownerPublicKeyHex: currentSnap.ownerPublicKeyHex ?? "02aa",
          url: currentSnap.url,
          lastBoundAtMs: Date.now(),
          lastError: null,
          lastReceivedAtMs: currentSnap.lastReceivedAtMs
        };
      }
    },
    async disconnect(): Promise<void> {
      /* no-op */
    },
    async list(_input: unknown): Promise<{ items: never[]; hasMore: false }> {
      return { items: [], hasMore: false };
    },
    async get(_input: unknown): Promise<null> {
      return null;
    },
    async send(_input: unknown): Promise<{ messageId: string; createdAtMs: number }> {
      return { messageId: "1", createdAtMs: Date.now() };
    },
    subscribeInboxDirty: ((_handler: unknown) => () => undefined) as AppMsgCore["subscribeInboxDirty"],
    subscribeMessageReceived: ((_handler: unknown) => () => undefined) as AppMsgCore["subscribeMessageReceived"],
    createPluginScopedClient(endpointId: string): never {
      throw new Error("not used in page test");
    },
    reconnectIfNeeded(): Promise<void> {
      return Promise.resolve();
    },
    inspectConnection(): AppMsgConnectionSnapshot {
      return currentSnap;
    },
    listKnownPluginEndpoints(): string[] {
      return opts.pluginEndpoints ?? [];
    },
    async listKnownOrigins(): Promise<string[]> {
      if (opts.listOriginsThrow) throw opts.listOriginsThrow;
      return opts.origins ?? [];
    },
    async countScopes(scopes: AppMsgAddress[]): Promise<AppMsgChannelCountBox[]> {
      return scopes.map((s) => {
        const k = `${s.endpoint.kind}::${s.endpoint.id}`;
        if (opts.failKeys?.has(k)) {
          return { scope: s, counts: null, error: "fake_failure" };
        }
        const counts = opts.countsByKey?.get(k);
        if (!counts) {
          return { scope: s, counts: { inbox: 0, sent: 0, all: 0 }, error: null };
        }
        return { scope: s, counts, error: null };
      });
    },
    async logDiagnosticsRefreshFailed(input: { stage: string; err: string; durationMs: number }): Promise<void> {
      if (opts.logSpy) opts.logSpy(input);
    }
  };
  return Object.assign(core, {
    __setSnap: setSnap,
    __snap: () => currentSnap
  });
}

/* ============== fake VaultService ============== */

interface FakeVaultOptions {
  initialStatus: VaultStatus;
}

function makeFakeVault(opts: FakeVaultOptions): VaultService & { __setStatus: (s: VaultStatus) => void } {
  let statusValue: VaultStatus = opts.initialStatus;
  const listeners = new Set<(s: VaultStatus) => void>();
  return {
    status: () => statusValue,
    onStatusChange: (cb: (s: VaultStatus) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async unlock(): Promise<void> {
      throw new Error("not used");
    },
    async lock(): Promise<void> {
      throw new Error("not used");
    },
    async verifyPassword(): Promise<boolean> {
      return true;
    },
    __setStatus(s: VaultStatus) {
      statusValue = s;
      for (const cb of listeners) cb(s);
    }
  } as unknown as VaultService & { __setStatus: (s: VaultStatus) => void };
}

/* ============== test fixtures ============== */

const URL = "wss://msg.keymaster.cc/ws/v1";
const OWNER = "02aaaa".padEnd(66, "a");

const SNAP_BOUND: AppMsgConnectionSnapshot = {
  state: "bound",
  ownerPublicKeyHex: OWNER,
  url: URL,
  lastBoundAtMs: 1700000000000,
  lastError: null,
  lastReceivedAtMs: 1700000000500
};

const SNAP_DISCONNECTED: AppMsgConnectionSnapshot = {
  state: "closed",
  ownerPublicKeyHex: null,
  url: URL,
  lastBoundAtMs: 0,
  lastError: null,
  lastReceivedAtMs: 0
};

async function makeHost(opts: {
  core?: AppMsgCore;
  vaultStatus: VaultStatus;
  registerAppmsgPlugin?: boolean;
}) {
  const host = createPluginHost({ disableConfigPersistence: true });
  host.provide<VaultService>("vault.service", makeFakeVault({ initialStatus: opts.vaultStatus }));
  // keyspace.service 是 appmsg 依赖；测试给个最小 fake
  host.provide("keyspace.service", {
    active: () => ({ activePublicKeyHex: null }),
    onActiveChange: () => () => undefined,
    getKey: async () => null,
    listKeys: async () => []
  });
  if (opts.registerAppmsgPlugin !== false) {
    // 关键：appmsg.core 由 manifest 自身 provide，**不**预先 provide，
    // 否则 manifest 内部 ctx.provide 会抛 "already provided"。
    // 拿到真 core 后用 vi.spyOn 替换 inspectConnection / listKnownPluginEndpoints
    // / listKnownOrigins / countScopes / logDiagnosticsRefreshFailed。
    await host.register(appmsgPlatformPlugin);
    try {
      await host.enable("appmsg");
    } catch {
      /* already enabled */
    }
    if (opts.core) {
      // 直接覆盖方法：避免 vi.spyOn 在 test 间互相干扰。
      const real = host.capabilities.get<AppMsgCore>(APPMESSAGE_CORE_CAPABILITY);
      (real as { inspectConnection: typeof opts.core.inspectConnection }).inspectConnection = opts.core.inspectConnection;
      (real as { listKnownPluginEndpoints: typeof opts.core.listKnownPluginEndpoints }).listKnownPluginEndpoints = opts.core.listKnownPluginEndpoints;
      (real as { listKnownOrigins: typeof opts.core.listKnownOrigins }).listKnownOrigins = opts.core.listKnownOrigins;
      (real as { countScopes: typeof opts.core.countScopes }).countScopes = opts.core.countScopes;
      (real as { logDiagnosticsRefreshFailed: typeof opts.core.logDiagnosticsRefreshFailed }).logDiagnosticsRefreshFailed = opts.core.logDiagnosticsRefreshFailed;
    }
  }
  return host;
}

afterEach(() => {
  cleanup();
});

/* ============== 测试 ============== */

describe("AppMsgSystemPage — manifest integration (施工单 §6.2.5)", () => {
  it("registers /system/messages route in route.registry", async () => {
    const core = makeFakeCore({ initialSnap: SNAP_BOUND });
    const host = await makeHost({ core, vaultStatus: "unlocked" });
    const routes = host.capabilities.get<{ byPath: (p: string) => unknown }>("route.registry");
    const route = routes.byPath("/system/messages") as { id: string; menuGroup?: string } | undefined;
    expect(route).toBeTruthy();
    expect(route?.id).toBe("appmsg.system.messages");
    expect(route?.menuGroup).toBe("system");
  });

  it("registers a menu item with group === 'system' pointing to /system/messages", async () => {
    const core = makeFakeCore({ initialSnap: SNAP_BOUND });
    const host = await makeHost({ core, vaultStatus: "unlocked" });
    const menus = host.capabilities.get<{ list: () => MenuItem[] }>("menu.registry");
    const menuItems = menus.list();
    const item = menuItems.find((m: MenuItem) => m.path === "/system/messages");
    expect(item, "menu item for /system/messages not found").toBeTruthy();
    expect(item?.group).toBe("system");
  });
});

describe("AppMsgSystemPage — locked state (施工单 §6.2.5)", () => {
  it("shows no-owner state and disables refresh button when vault is locked", async () => {
    const core = makeFakeCore({ initialSnap: SNAP_DISCONNECTED });
    const host = await makeHost({ core, vaultStatus: "locked" });
    await act(async () => {
      render(
        <PluginHostProvider host={host}>
          <AppMsgSystemPage />
        </PluginHostProvider>
      );
    });
    // 让初始 load() 跑完（locked 路径会走 stale 分支，但不会发请求）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    // 刷新按钮存在且 disabled
    const refreshBtn = screen.getByRole("button", { name: /refresh/i });
    expect((refreshBtn as HTMLButtonElement).disabled).toBe(true);
    // 状态标签显示 "no owner" 翻译
    expect(screen.getAllByText(/no owner/i).length).toBeGreaterThan(0);
  });
});

describe("AppMsgSystemPage — unlocked / refresh (施工单 §6.2.5)", () => {
  it("renders rows for known origins and plugin endpoints on success", async () => {
    const origins = [
      "https://justnote.example:443",
      "https://demo.example:8443"
    ];
    const plugins = ["keymaster.poker"];
    const countsByKey = new Map<string, { inbox: number; sent: number; all: number }>([
      ["origin::https://justnote.example:443", { inbox: 3, sent: 1, all: 4 }],
      ["origin::https://demo.example:8443", { inbox: 0, sent: 2, all: 2 }],
      ["plugin::keymaster.poker", { inbox: 5, sent: 0, all: 5 }]
    ]);
    const core = makeFakeCore({
      initialSnap: SNAP_BOUND,
      origins,
      pluginEndpoints: plugins,
      countsByKey
    });
    const host = await makeHost({ core, vaultStatus: "unlocked" });
    await act(async () => {
      render(
        <PluginHostProvider host={host}>
          <AppMsgSystemPage />
        </PluginHostProvider>
      );
    });
    // 等首屏 load
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // 行数 = 2 origin + 1 plugin = 3
    const rows = screen.getAllByRole("row");
    // 表格 head + body = 1 + 3 = 4
    expect(rows.length).toBe(4);
    // 计数正确：行内 cell 顺序 [kind, channel, source, inbox, sent, all, lastRefreshed, status]
    const bodyRows = rows.slice(1);
    // 找到 justnote 行
    const justnoteRow = bodyRows.find((r) => within(r).queryByText(/justnote\.example/) !== null);
    expect(justnoteRow).toBeTruthy();
    const justnoteCells = within(justnoteRow!).getAllByRole("cell");
    expect(justnoteCells[3]?.textContent).toBe("3");
    expect(justnoteCells[4]?.textContent).toBe("1");
    expect(justnoteCells[5]?.textContent).toBe("4");
  });

  it("renders partial failure: failed rows show error, other rows keep counts", async () => {
    const origins = ["https://justnote.example:443", "https://broken.example:9999"];
    const plugins: string[] = [];
    const countsByKey = new Map<string, { inbox: number; sent: number; all: number }>([
      ["origin::https://justnote.example:443", { inbox: 2, sent: 1, all: 3 }]
    ]);
    const failKeys = new Set(["origin::https://broken.example:9999"]);
    const core = makeFakeCore({
      initialSnap: SNAP_BOUND,
      origins,
      pluginEndpoints: plugins,
      countsByKey,
      failKeys
    });
    const host = await makeHost({ core, vaultStatus: "unlocked" });
    await act(async () => {
      render(
        <PluginHostProvider host={host}>
          <AppMsgSystemPage />
        </PluginHostProvider>
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.length).toBe(2);
    // 失败行：cell[7] (status) 含 "failed: fake_failure"
    const failedRow = rows.find((r) => {
      const cells = within(r).getAllByRole("cell");
      return cells[7]?.textContent?.includes("fake_failure") ?? false;
    });
    expect(failedRow, "expected a row whose status cell contains 'fake_failure'").toBeTruthy();
    // 成功行：cell 0=kind, 1=channel, 2=source, 3=inbox, 4=sent, 5=all
    const okRow = rows.find((r) => within(r).queryByText(/justnote\.example/) !== null);
    expect(okRow).toBeTruthy();
    const okCells = within(okRow!).getAllByRole("cell");
    expect(okCells[3]?.textContent).toBe("2");
    expect(okCells[4]?.textContent).toBe("1");
    expect(okCells[5]?.textContent).toBe("3");
  });

  it("manual refresh re-fetches and updates rows", async () => {
    const origins = ["https://justnote.example:443"];
    const countsByKey = new Map<string, { inbox: number; sent: number; all: number }>([
      ["origin::https://justnote.example:443", { inbox: 7, sent: 0, all: 7 }]
    ]);
    const core = makeFakeCore({
      initialSnap: SNAP_BOUND,
      origins,
      pluginEndpoints: [],
      countsByKey
    });
    const host = await makeHost({ core, vaultStatus: "unlocked" });
    await act(async () => {
      render(
        <PluginHostProvider host={host}>
          <AppMsgSystemPage />
        </PluginHostProvider>
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // 第一次 load：rows[1] cell[3] (inbox) = 7
    let rows = screen.getAllByRole("row").slice(1);
    const firstCells = within(rows[0]!).getAllByRole("cell");
    expect(firstCells[3]?.textContent).toBe("7");
    // 改 mock counts 然后手动点 refresh
    countsByKey.set("origin::https://justnote.example:443", { inbox: 99, sent: 0, all: 99 });
    const refreshBtn = screen.getByRole("button", { name: /refresh/i });
    expect((refreshBtn as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(refreshBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    rows = screen.getAllByRole("row").slice(1);
    const newCells = within(rows[0]!).getAllByRole("cell");
    expect(newCells[3]?.textContent).toBe("99");
  });
});

describe("AppMsgSystemPage — content privacy (施工单 §6.2.5 + §4.5)", () => {
  it("never renders message body / markdown / message-id content", async () => {
    const origins = ["https://justnote.example:443"];
    const countsByKey = new Map<string, { inbox: number; sent: number; all: number }>([
      ["origin::https://justnote.example:443", { inbox: 1, sent: 0, all: 1 }]
    ]);
    const core = makeFakeCore({
      initialSnap: SNAP_BOUND,
      origins,
      pluginEndpoints: [],
      countsByKey
    });
    const host = await makeHost({ core, vaultStatus: "unlocked" });
    await act(async () => {
      render(
        <PluginHostProvider host={host}>
          <AppMsgSystemPage />
        </PluginHostProvider>
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // 把整页 HTML 拍出来
    const html = document.body.textContent ?? "";
    // 关键：页面上**不**应该出现任何真正的消息正文或消息级元数据
    // (description 文案里会含 "body" / "markdown" 字样——这是说明文字，
    // 不是真消息正文。判定的语义是"页面上没有 message list / detail /
    // body 内容",这里我们断言不出现"任意长度的真实正文"特征)。
    // 真实正文会带 createdAtMs / insertedAtMs / clientMessageId /
    // messageId 等行内 metadata；只要这些不存在就说明没把消息正文
    // 渲染到页面上。
    expect(html).not.toMatch(/createdatms/i);
    expect(html).not.toMatch(/insertedatms/i);
    expect(html).not.toMatch(/clientmessageid/i);
    expect(html).not.toMatch(/\bmessageid\b/i);
    // 表格里只有 kind / channel / source / inbox / sent / all /
    // lastRefreshed / status 8 列。
    const headers = within(screen.getByRole("table")).getAllByRole("columnheader");
    const headerTexts = headers.map((h) => h.textContent?.toLowerCase() ?? "");
    expect(headerTexts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("kind"),
        expect.stringContaining("channel"),
        expect.stringContaining("source"),
        expect.stringContaining("inbox"),
        expect.stringContaining("sent"),
        expect.stringContaining("all"),
        expect.stringContaining("last refreshed"),
        expect.stringContaining("status")
      ])
    );
  });
});

describe("AppMsgSystemPage — diagnostics logging on failure (施工单 §6.2.5 + §7.4)", () => {
  it("calls logDiagnosticsRefreshFailed when vault is locked", async () => {
    const errorSpy = vi.fn();
    const core = makeFakeCore({
      initialSnap: SNAP_DISCONNECTED,
      logSpy: errorSpy
    });
    const host = await makeHost({ core, vaultStatus: "locked" });
    await act(async () => {
      render(
        <PluginHostProvider host={host}>
          <AppMsgSystemPage />
        </PluginHostProvider>
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(errorSpy).toHaveBeenCalled();
    const call = errorSpy.mock.calls[0]?.[0];
    expect(call?.stage).toBe("locked_or_no_owner");
    expect(call?.err).toMatch(/vault locked/i);
  });

  it("calls logDiagnosticsRefreshFailed when listKnownOrigins throws", async () => {
    // 注意：useRuntimeStatus 初始 state = "booting"（useEffect 之后才
    // 同步到 vault.status()），所以 page 第一次 load() 会走 locked
    // 路径（stage = "locked_or_no_owner"）；等 status 翻到 unlocked
    // 后第二次 load() 才会真正走到 listKnownOrigins。这里取 mock.calls
    // 末尾的"list_known_origins"那条做断言。
    const errorSpy = vi.fn();
    const core: AppMsgCore = {
      async connectForOwner(): Promise<void> {
        /* no-op */
      },
      async disconnect(): Promise<void> {
        /* no-op */
      },
      async list(): Promise<{ items: never[]; hasMore: false }> {
        return { items: [], hasMore: false };
      },
      async get(): Promise<null> {
        return null;
      },
      async send(): Promise<{ messageId: string; createdAtMs: number }> {
        return { messageId: "1", createdAtMs: 0 };
      },
      subscribeInboxDirty(): () => void {
        return () => undefined;
      },
      subscribeMessageReceived(): () => void {
        return () => undefined;
      },
      createPluginScopedClient(): never {
        throw new Error("nope");
      },
      async reconnectIfNeeded(): Promise<void> {
        /* no-op */
      },
      inspectConnection(): AppMsgConnectionSnapshot {
        return SNAP_BOUND;
      },
      listKnownPluginEndpoints(): string[] {
        return [];
      },
      async listKnownOrigins(): Promise<string[]> {
        throw new Error("list_known_origins_boom");
      },
      async countScopes(): Promise<AppMsgChannelCountBox[]> {
        return [];
      },
      async logDiagnosticsRefreshFailed(input: { stage: string; err: string; durationMs: number }): Promise<void> {
        errorSpy(input);
      }
    };
    const host = await makeHost({ core, vaultStatus: "unlocked" });
    await act(async () => {
      render(
        <PluginHostProvider host={host}>
          <AppMsgSystemPage />
        </PluginHostProvider>
      );
    });
    // 等 vault status useEffect 把 state 翻到 unlocked，让第二次
    // load() 跑完；然后再断言。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    // 找 stage === "list_known_origins" 的那次调用
    const listKnownOriginsCall = errorSpy.mock.calls
      .map((c) => c[0])
      .find((c: { stage?: string } | undefined) => c?.stage === "list_known_origins");
    expect(listKnownOriginsCall, "expected a logDiagnosticsRefreshFailed call with stage=list_known_origins").toBeTruthy();
    expect((listKnownOriginsCall as { err: string }).err).toMatch(/list_known_origins_boom/);
  });
});
