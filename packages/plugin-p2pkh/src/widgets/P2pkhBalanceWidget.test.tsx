import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { createFixtureHost as createPluginHost } from "@keymaster/runtime/test-support";
// packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.test.tsx
// P2PKH 余额 widget 测试：
//   1. onDataChanged 后重新读取余额
//   2. 账户切换时旧请求不覆盖
//   3. 卸载后不再更新

// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import { BSV_PRICE_READER_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY, I18N_SERVICE_CAPABILITY, defineRuntimeUnitDependencies, type ResourceRegistry } from "@keymaster/contracts";
import type { VaultLifecycleSnapshot, VaultWalletState } from "@keymaster/contracts";
import { P2PKH_CAPABILITY, type P2pkhBalance, type P2pkhService } from "../p2pkhContracts.js";
import { p2pkhResources } from "../manifest.js";
import { bindP2pkhUi } from "../P2pkhResourceContext.js";
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
  getAssetBalance?: (assetId: string) => Promise<P2pkhBalance>;
  includeTestnet?: boolean;
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
        if (overrides?.getAssetBalance) return overrides.getAssetBalance(assetId);
        return { total: assetId === "bsv" ? 1000 : 200, available: true };
      }),
      getGlobalSettings: () => ({ includeTestnet: overrides?.includeTestnet ?? false }),
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

function makeFakeWalletState(activePublicKeyHex?: string) {
  const activeListeners = new Set<(s: VaultLifecycleSnapshot) => void>();
  return {
    walletState: {
      snapshot: () => walletStateFixtureSnapshot((() => ({ activePublicKeyHex: activePublicKeyHex ?? ACTIVE_PK }))()),
      subscribe: (h: (s: VaultLifecycleSnapshot) => void) => {
        activeListeners.add(h);
        return () => activeListeners.delete(h);
      },
      isInitializing: () => false,
      onInitializationChange: () => () => {},
    } as unknown as VaultWalletState,
    setActiveKey(pk: string) {
      activePublicKeyHex = pk;
      for (const l of activeListeners) l(walletStateFixtureSnapshot({ activePublicKeyHex: pk }));
    },
  };
}

/** 在 host 上注册 p2pkh 资源定义。 */
function registerDefinitions(resourceRegistry: ResourceRegistry, service: P2pkhService) {

  // p2pkh.balance
  resourceRegistry.register({
    id: "p2pkh.balance",
    scope: "active-key",
    key: (_args: readonly string[], context: { activePublicKeyHex?: string }) =>
      ["p2pkh.balance", context.activePublicKeyHex ?? "none"],
    load: async (_args: readonly string[], context: { activePublicKeyHex?: string }) => {
      const include = service.getGlobalSettings().includeTestnet;
      const calls = [service.getAssetBalance("bsv")];
      if (include) calls.push(service.getAssetBalance("bsvtest"));
      const results = await Promise.all(calls);
      return {
        publicKeyHex: context.activePublicKeyHex ?? ACTIVE_PK,
        includeTestnet: include,
        balances: {
          ...(results[0] ? { mainnet: results[0] } : {}),
          ...(include && results[1] ? { testnet: results[1] } : {}),
        },
        revision: 1,
      };
    },
    subscribe: (_args: readonly string[], _ctx: unknown, invalidate: () => void) => {
      const offData = service.onDataChanged(invalidate);
      const offSettings = service.onGlobalSettingsChange(invalidate);
      return () => { offData(); offSettings(); };
    },
    equals: (prev: any, next: any) => JSON.stringify(prev) === JSON.stringify(next),
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

const hosts: ReturnType<typeof createPluginHost>[] = [];
const widgets = new WeakMap<ReturnType<typeof createPluginHost>, ReturnType<typeof bindP2pkhUi>>();
function createWidgetHost() {
  const host = createPluginHost({ initialI18nResources: [p2pkhResources], runtimeUnitImplementationRegistry: {
    get: () => ctx => {
      registerDefinitions(ctx.capability(RESOURCE_REGISTRY_CAPABILITY), ctx.capability(P2PKH_CAPABILITY));
      widgets.set(host, bindP2pkhUi(ctx, P2pkhBalanceWidget));
    },
  } });
  hosts.push(host); return host;
}
async function registerP2pkhResources(host: ReturnType<typeof createPluginHost>, _service: P2pkhService) {
  await host.register({ id: "p2pkh-widget-fixture", name: "P2PKH widget fixture", units: [{
    id: "p2pkh-widget-fixture.window", runtime: "window-main", scopeKind: "root",
    dependencies: defineRuntimeUnitDependencies([
      { capability: RESOURCE_REGISTRY_CAPABILITY }, { capability: OWNED_RESOURCE_ACCESS_CAPABILITY },
      { capability: I18N_SERVICE_CAPABILITY }, { capability: P2PKH_CAPABILITY },
      { capability: BSV_PRICE_READER_CAPABILITY, optional: true },
    ]),
  }] });
}
function FixtureWidget({ host }: { host: ReturnType<typeof createPluginHost> }) {
  const Widget = widgets.get(host)!; return <Widget />;
}

describe("P2pkhBalanceWidget", () => {
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await Promise.all(hosts.splice(0).map(host => host.dispose()));
  });

  it("onDataChanged 后重新读取余额", async () => {
    const fake = makeFakeService();
    const walletState = makeFakeWalletState();
    const host = createWidgetHost();
    host.provide(P2PKH_CAPABILITY, fake.service);
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState.walletState));
    await registerP2pkhResources(host, fake.service);

    render(
      <PluginHostProvider host={host}>
        <FixtureWidget host={host} />
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
    const walletState = makeFakeWalletState();
    const host = createWidgetHost();
    host.provide(P2PKH_CAPABILITY, fake.service);
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState.walletState));
    await registerP2pkhResources(host, fake.service);

    render(
      <PluginHostProvider host={host}>
        <FixtureWidget host={host} />
      </PluginHostProvider>
    );

    // 等待第一次调用开始
    await vi.waitFor(() => {
      expect(callCount).toBe(1);
    });

    // 切换账户 → 触发第二次调用
    await act(async () => {
      const owner = "new-public-key-hex-abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
      walletState.setActiveKey(owner);
      await host.transitionRuntimeIdentity({ vaultStatus: "unlocked", ownerPublicKeyHex: owner, sessionEpoch: "new-epoch", runGeneration: "run", walletGeneration: "wallet" });
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
    const walletState = makeFakeWalletState();
    const host = createWidgetHost();
    host.provide(P2PKH_CAPABILITY, fake.service);
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState.walletState));
    await registerP2pkhResources(host, fake.service);

    const { unmount } = render(
      <PluginHostProvider host={host}>
        <FixtureWidget host={host} />
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

  it("shows the sats / price display when the price reader is available", async () => {
    const fake = makeFakeService({ getAssetBalance: async () => ({ total: 100_000_000 }) });
    const walletState = makeFakeWalletState();
    const host = createWidgetHost();
    host.provide(P2PKH_CAPABILITY, fake.service);
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState.walletState));
    host.provide(BSV_PRICE_READER_CAPABILITY, {
      get: () => ({ amount: "45.12", unit: "USDT", updatedAtMs: 1 }),
      subscribe: () => () => undefined
    });
    await registerP2pkhResources(host, fake.service);

    render(
      <PluginHostProvider host={host}>
        <FixtureWidget host={host} />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("100,000,000 sats / 45.12 USDT")).toBeTruthy();
    });
  });

  it("shows — when the balance is unavailable", async () => {
    const fake = makeFakeService({ getAssetBalance: async () => ({ total: 0, available: false }) });
    const walletState = makeFakeWalletState();
    const host = createWidgetHost();
    host.provide(P2PKH_CAPABILITY, fake.service);
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState.walletState));
    await registerP2pkhResources(host, fake.service);

    render(
      <PluginHostProvider host={host}>
        <FixtureWidget host={host} />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("—")).toBeTruthy();
    });
    expect(screen.queryByText(/1,000/)).toBeNull();
  });

  it("shows known balance with confirmed + spendable breakdown", async () => {
    const fake = makeFakeService({
      getAssetBalance: async () => ({
        total: 5000,
        available: true,
        breakdown: { confirmed: 1000, unconfirmed: 200, spendable: 1200 },
      }),
    });
    const walletState = makeFakeWalletState();
    const host = createWidgetHost();
    host.provide(P2PKH_CAPABILITY, fake.service);
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState.walletState));
    await registerP2pkhResources(host, fake.service);

    render(
      <PluginHostProvider host={host}>
        <FixtureWidget host={host} />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/5,000/)).toBeTruthy();
    });
    expect(screen.getByText("Confirmed")).toBeTruthy();
    expect(screen.getByText("1,000 sats")).toBeTruthy();
    expect(screen.getByText("Spendable")).toBeTruthy();
    expect(screen.getByText("1,200 sats")).toBeTruthy();
  });

  it("hides the testnet row when testnet is disabled", async () => {
    const fake = makeFakeService({ includeTestnet: false });
    const walletState = makeFakeWalletState();
    const host = createWidgetHost();
    host.provide(P2PKH_CAPABILITY, fake.service);
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState.walletState));
    await registerP2pkhResources(host, fake.service);

    const { unmount } = render(
      <PluginHostProvider host={host}>
        <FixtureWidget host={host} />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/1,000/)).toBeTruthy();
    });
    expect(screen.queryByText("BSV Testnet (test)")).toBeNull();
    unmount();
  });

  it("shows the testnet row when testnet is enabled", async () => {
    const fake = makeFakeService({
      includeTestnet: true,
      getAssetBalance: async (assetId: string) => ({
        total: assetId === "bsv" ? 1000 : 200,
        available: true,
      }),
    });
    const walletState = makeFakeWalletState();
    const host = createWidgetHost();
    host.provide(P2PKH_CAPABILITY, fake.service);
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState.walletState));
    await registerP2pkhResources(host, fake.service);

    render(
      <PluginHostProvider host={host}>
        <FixtureWidget host={host} />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("BSV Testnet (test)")).toBeTruthy();
    });
    expect(screen.getByText(/200/)).toBeTruthy();
  });
});
