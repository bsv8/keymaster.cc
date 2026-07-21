// packages/plugin-assets/src/AssetsPage.test.tsx
// 统一持仓页集成测试：
//   硬切换 003 后，并发保护职责已移至 Resource Store。
//   本测试验证页面正确读取 Resource Store 快照并渲染。

// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import type {
  AssetProvider,
  AssetRegistry,
  KeyspaceService,
  I18nPluginResources,
  TokenProvider,
  TokenRegistry,
} from "@keymaster/contracts";
import {
  RESOURCE_REGISTRY_CAPABILITY,
  ASSET_DATA_NOTIFIER_CAPABILITY
} from "@keymaster/contracts";
import { AssetsPage } from "./AssetsPage.js";
import { loadAllHoldings } from "./holdingsFlow.js";

const ASSETS_PAGE_TEST_I18N: I18nPluginResources = {
  namespace: "common",
  resources: { en: {
    "assets.context.loading": "Loading…",
    "assets.context.noKey": "No key",
    "assets.context.unnamed": "Unnamed",
    "assets.context.identityMissing": "Identity unavailable",
    "assets.page.title": "Assets",
    "assets.page.loading": "Loading assets…",
    "assets.page.descriptionPrefix": "Assets",
    "assets.table.col.name": "Name",
    "assets.table.col.kind": "Kind",
    "assets.table.col.provider": "Provider",
    "assets.table.col.network": "Network",
    "assets.table.col.balance": "Balance",
    "assets.table.col.status": "Status",
    "assets.table.col.detail": "Detail",
    "assets.page.error.load": "Failed to load assets",
    "assets.page.empty.assets.title": "No assets",
    "assets.page.empty.assets.desc": "No assets found"
  } }
};

function makeTokenProvider(
  id: string,
  name: string,
  listResult: () => Promise<unknown[]>
): TokenProvider {
  const listeners = new Set<() => void>();
  return {
    id,
    name: { key: `${id}.name`, fallback: name },
    order: 0,
    listTokens: listResult as () => Promise<never[]>,
    getToken: () => Promise.resolve(undefined),
    listActivity: () => Promise.resolve([]),
    onChange: (h: () => void) => {
      listeners.add(h);
      return () => listeners.delete(h);
    },
    _emit: () => {
      for (const l of [...listeners]) l();
    },
  } as unknown as TokenProvider & { _emit: () => void };
}

function makeAssetProvider(
  id: string,
  name: string,
  listResult: () => Promise<unknown[]>
): AssetProvider {
  return {
    id,
    name: { key: `${id}.name`, fallback: name },
    order: 0,
    kind: "coin",
    listAssets: listResult as () => Promise<never[]>,
    getAsset: () => Promise.resolve(undefined),
    listActivity: () => Promise.resolve([]),
    onChange: (h: () => void) => {
      return () => {};
    },
  } as unknown as AssetProvider;
}

function makeKeyspace(publicKeyHex?: string): KeyspaceService {
  return {
    active: () => ({ activePublicKeyHex: publicKeyHex ?? "pk1" }),
    onActiveKeyChanged: () => () => {},
    isInitializing: () => false,
    onInitializationChange: () => () => {},
    getKey: async () => ({
      publicKeyHex: publicKeyHex ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      label: "test-key",
      capabilities: [],
      createdAt: "2024-01-01T00:00:00Z",
    }),
    listKeys: async () => [],
    setActive: async () => undefined,
    requireActiveKey: () => ({
      publicKeyHex: publicKeyHex ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      label: "test-key",
      capabilities: [],
      createdAt: "2024-01-01T00:00:00Z",
    }),
    openKeyStorage: async () => { throw new Error("not used"); },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    attachBackgroundService: () => undefined,
  } as unknown as KeyspaceService;
}

/** 在 host 上注册 holdings 资源定义。 */
function registerHoldingsResource(
  host: ReturnType<typeof createPluginHost>,
  assetReg: AssetRegistry,
  tokenReg: TokenRegistry
) {
  const resourceRegistry = host.capabilities.get<any>(RESOURCE_REGISTRY_CAPABILITY);
  const notifier = host.capabilities.get<any>(ASSET_DATA_NOTIFIER_CAPABILITY);
  resourceRegistry.register({
    id: "assets.holdings",
    scope: "active-key",
    key: (_args: readonly string[], context: { activePublicKeyHex?: string }) =>
      ["assets.holdings", context.activePublicKeyHex ?? "none"],
    load: async (_args: readonly string[], _context: unknown, _signal: AbortSignal) => {
      return loadAllHoldings(assetReg, tokenReg);
    },
    subscribe: (_args: readonly string[], _context: unknown, invalidate: () => void) => {
      return notifier.subscribe(() => {
        invalidate();
      });
    },
    equals: (prev: unknown, next: unknown) => {
      if (!prev || !next) return prev === next;
      return JSON.stringify(prev) === JSON.stringify(next);
    },
    invalidation: "microtask"
  });
  resourceRegistry.register({
    id: "assets.active-context", scope: "active-key",
    key: (_args: readonly string[], context: { activePublicKeyHex?: string }) => ["assets.active-context", context.activePublicKeyHex ?? "none"],
    load: async () => {
      const keyspace = host.capabilities.get<KeyspaceService>("keyspace.service");
      const active = keyspace.active().activePublicKeyHex;
      return active ? (await keyspace.getKey(active)) ?? null : null;
    },
    subscribe: (_args: readonly string[], _context: unknown, invalidate: () => void) => host.capabilities.get<KeyspaceService>("keyspace.service").onActiveKeyChanged(invalidate),
    invalidation: "immediate"
  });
}

describe("AssetsPage - Resource Store 集成", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染来自 Resource Store 的资产数据", async () => {
    const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [ASSETS_PAGE_TEST_I18N] });
    const tokenReg = host.tokens;
    tokenReg.register(makeTokenProvider("tok1", "Token1", () =>
      Promise.resolve([
        {
          tokenId: "tok1",
          providerId: "tok1",
          symbol: "TK1",
          label: "Test Token",
          status: "ready",
        },
      ])
    ));
    host.provide<KeyspaceService>("keyspace.service", makeKeyspace());
    registerHoldingsResource(host, host.assets, tokenReg);

    render(
      <PluginHostProvider host={host}>
        <AssetsPage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Test Token")).toBeTruthy();
    });
  });

  it("provider 失败时显示错误信息", async () => {
    const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [ASSETS_PAGE_TEST_I18N] });
    const tokenReg = host.tokens;
    tokenReg.register(makeTokenProvider("fail-p", "FailP", () =>
      Promise.reject(new Error("load failed"))
    ));
    host.provide<KeyspaceService>("keyspace.service", makeKeyspace());
    registerHoldingsResource(host, host.assets, tokenReg);

    render(
      <PluginHostProvider host={host}>
        <AssetsPage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/load failed/)).toBeTruthy();
    });
  });
});
