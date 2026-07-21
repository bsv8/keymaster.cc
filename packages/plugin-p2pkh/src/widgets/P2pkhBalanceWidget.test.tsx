// packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.test.tsx
// P2PKH 余额 widget 测试：
//   1. onDataChanged 后重新读取余额
//   2. 账户切换时旧请求不覆盖
//   3. 卸载后不再更新

// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import type { ActiveKeyState, KeyspaceService, ResourceRegistry } from "@keymaster/contracts";
import { RESOURCE_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import type { P2pkhBalance, P2pkhService } from "../p2pkhContracts.js";
import { p2pkhResources } from "../manifest.js";
import { P2pkhBalanceWidget } from "./P2pkhBalanceWidget.js";

const ACTIVE_PK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeFakeService(overrides?: {
  getAssetBalance?: () => Promise<P2pkhBalance>;
}) {
  const syncListeners = new Set<(s: string) => void>();
  const dataListeners = new Set<() => void>();
  const settingsListeners = new Set<(s: { includeTestnet: boolean }) => void>();
  let callCount = 0;

  return {
    service: {
      syncStatus: () => "idle",
      onSyncStatusChange: (h: (s: string) => void) => {
        syncListeners.add(h);
        return () => syncListeners.delete(h);
      },
      onDataChanged: (h: () => void) => {
        dataListeners.add(h);
        return () => dataListeners.delete(h);
      },
      getAssetBalance: vi.fn(async (assetId: string) => {
        callCount++;
        if (overrides?.getAssetBalance) return overrides.getAssetBalance();
        return { total: assetId === "bsv" ? 1000 : 200 };
      }),
      getGlobalSettings: () => ({ includeTestnet: false }),
      onGlobalSettingsChange: (h: (s: { includeTestnet: boolean }) => void) => {
        settingsListeners.add(h);
        return () => settingsListeners.delete(h);
      },
    } as unknown as P2pkhService,
    emitDataChanged() {
      for (const l of [...dataListeners]) l();
    },
    get callCount() {
      return callCount;
    },
  };
}

function makeFakeKeyspace(activePublicKeyHex?: string) {
  const activeListeners = new Set<(s: ActiveKeyState) => void>();
  return {
    keyspace: {
      active: () => ({ activePublicKeyHex: activePublicKeyHex ?? ACTIVE_PK }),
      onActiveKeyChanged: (h: (s: ActiveKeyState) => void) => {
        activeListeners.add(h);
        return () => activeListeners.delete(h);
      },
      isInitializing: () => false,
      onInitializationChange: () => () => {},
    } as unknown as KeyspaceService,
    setActiveKey(pk: string) {
      activePublicKeyHex = pk;
      for (const l of activeListeners) l({ activePublicKeyHex: pk });
    },
  };
}

/** 在 host 上注册 p2pkh 资源定义。 */
function registerP2pkhResources(host: ReturnType<typeof createPluginHost>, service: P2pkhService) {
  const resourceRegistry = host.capabilities.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY)!;

  // p2pkh.balance
  resourceRegistry.register({
    id: "p2pkh.balance",
    scope: "active-key",
    key: (_args: readonly string[], context: { activePublicKeyHex?: string }) =>
      ["p2pkh.balance", context.activePublicKeyHex ?? "none"],
    load: async () => {
      const include = service.getGlobalSettings().includeTestnet;
      const calls = [service.getAssetBalance("bsv")];
      if (include) calls.push(service.getAssetBalance("bsvtest"));
      const results = await Promise.all(calls);
      return { bsv: results[0] ?? null, bsvtest: include ? (results[1] ?? null) : null };
    },
    subscribe: (_args: readonly string[], _ctx: unknown, invalidate: () => void) => {
      const offData = service.onDataChanged(invalidate);
      const offSettings = service.onGlobalSettingsChange(invalidate);
      return () => { offData(); offSettings(); };
    },
    equals: (prev: any, next: any) => {
      if (!prev || !next) return prev === next;
      return prev.bsv?.total === next.bsv?.total && prev.bsvtest?.total === next.bsvtest?.total;
    },
    invalidation: "microtask"
  });

  // p2pkh.settings
  resourceRegistry.register({
    id: "p2pkh.settings",
    scope: "global",
    key: () => ["p2pkh.settings"],
    load: async () => service.getGlobalSettings(),
    subscribe: (_args: readonly string[], _ctx: unknown, invalidate: () => void) => service.onGlobalSettingsChange(invalidate),
    equals: (prev: any, next: any) => {
      if (!prev || !next) return prev === next;
      return prev.includeTestnet === next.includeTestnet;
    },
    invalidation: "immediate"
  });

  resourceRegistry.register({
    id: "p2pkh.readiness",
    scope: "active-key",
    key: (_args: readonly string[], context: { activePublicKeyHex?: string }) =>
      ["p2pkh.readiness", context.activePublicKeyHex ?? "none"],
    load: async () => "ready",
    subscribe: (_args: readonly string[], _ctx: unknown, invalidate: () => void) => {
      return () => { void invalidate; };
    },
    invalidation: "immediate"
  });

  resourceRegistry.register({
    id: "p2pkh.sync-status",
    scope: "global",
    key: () => ["p2pkh.sync-status"],
    load: async () => service.syncStatus(),
    subscribe: (_args: readonly string[], _ctx: unknown, invalidate: () => void) => service.onSyncStatusChange(invalidate),
    invalidation: "immediate"
  });
}

describe("P2pkhBalanceWidget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("onDataChanged 后重新读取余额", async () => {
    const fake = makeFakeService();
    const keyspace = makeFakeKeyspace();
    const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [p2pkhResources] });
    host.provide<P2pkhService>("p2pkh.service", fake.service);
    host.provide<KeyspaceService>("keyspace.service", keyspace.keyspace);
    registerP2pkhResources(host, fake.service);

    render(
      <PluginHostProvider host={host}>
        <P2pkhBalanceWidget />
      </PluginHostProvider>
    );

    // 初始加载完成
    await waitFor(() => {
      expect(screen.getByText(/1,000/)).toBeTruthy();
    });

    const initialCalls = (fake.service.getAssetBalance as ReturnType<typeof vi.fn>).mock.calls.length;

    // 触发 dataChanged
    await act(async () => {
      fake.emitDataChanged();
      await new Promise((r) => setTimeout(r, 50));
    });

    // 应重新读取余额
    await waitFor(() => {
      expect((fake.service.getAssetBalance as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it("账户切换时旧请求不覆盖", async () => {
    const firstRequest = deferred<P2pkhBalance>();
    let callCount = 0;
    const fake = makeFakeService({
      getAssetBalance: () => {
        callCount++;
        if (callCount === 1) return firstRequest.promise;
        // 第二次调用（账户切换后）立即返回新余额
        return Promise.resolve({ total: 9999 });
      },
    });
    const keyspace = makeFakeKeyspace();
    const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [p2pkhResources] });
    host.provide<P2pkhService>("p2pkh.service", fake.service);
    host.provide<KeyspaceService>("keyspace.service", keyspace.keyspace);
    registerP2pkhResources(host, fake.service);

    render(
      <PluginHostProvider host={host}>
        <P2pkhBalanceWidget />
      </PluginHostProvider>
    );

    // 等待第一次调用开始
    await vi.waitFor(() => {
      expect(callCount).toBe(1);
    });

    // 切换账户 → 触发第二次调用
    await act(async () => {
      keyspace.setActiveKey("new-public-key-hex-abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567");
      await new Promise((r) => setTimeout(r, 50));
    });

    // 第二次调用返回的新余额应已显示
    await waitFor(() => {
      expect(screen.getByText(/9,999/)).toBeTruthy();
    });

    // 现在让第一次请求晚到
    await act(async () => {
      firstRequest.resolve({ total: 1111 });
      await new Promise((r) => setTimeout(r, 50));
    });

    // 旧余额不应覆盖新余额
    expect(screen.queryByText(/1,111/)).toBeFalsy();
    expect(screen.getByText(/9,999/)).toBeTruthy();
  });

  it("卸载后不再更新", async () => {
    const fake = makeFakeService();
    const keyspace = makeFakeKeyspace();
    const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [p2pkhResources] });
    host.provide<P2pkhService>("p2pkh.service", fake.service);
    host.provide<KeyspaceService>("keyspace.service", keyspace.keyspace);
    registerP2pkhResources(host, fake.service);

    const { unmount } = render(
      <PluginHostProvider host={host}>
        <P2pkhBalanceWidget />
      </PluginHostProvider>
    );

    // 等待初始加载
    await waitFor(() => {
      expect(screen.getByText(/1,000/)).toBeTruthy();
    });

    // 卸载
    unmount();

    // 卸载后触发 dataChanged，不应报错（no-op）
    expect(() => {
      fake.emitDataChanged();
    }).not.toThrow();
  });
});
