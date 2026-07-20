// packages/plugin-assets/src/AssetsHomeWidget.test.tsx
// 首页统一持仓 widget 集成测试：
//   硬切换 003 后，并发保护职责已移至 Resource Store。
//   本测试验证 widget 正确读取 Resource Store 快照并渲染。

// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  getRenderCount,
  PluginHostProvider,
  resetRenderCounters,
  createPluginHost
} from "@keymaster/runtime";
import type {
  AssetProvider,
  AssetRegistry,
  I18nPluginResources,
  TokenProvider,
  TokenRegistry,
} from "@keymaster/contracts";
import {
  RESOURCE_REGISTRY_CAPABILITY,
  ASSET_DATA_NOTIFIER_CAPABILITY
} from "@keymaster/contracts";
import { AssetsHomeWidget } from "./AssetsHomeWidget.js";
import { loadAllHoldings } from "./holdingsFlow.js";

const ASSETS_TEST_I18N: I18nPluginResources = {
  namespace: "common",
  resources: {
    en: {
      "assets.home.overview": "Assets",
      "assets.homeWidget.empty": "No assets"
    }
  }
};

function createAssetsTestHost() {
  return createPluginHost({
    disableConfigPersistence: true,
    initialI18nResources: [ASSETS_TEST_I18N]
  });
}

function makeTokenProvider(
  id: string,
  name: string,
  listResult: () => Promise<unknown[]>
): TokenProvider {
  return {
    id,
    name: { key: `${id}.name`, fallback: name },
    order: 0,
    listTokens: listResult as () => Promise<never[]>,
    getToken: () => Promise.resolve(undefined),
    listActivity: () => Promise.resolve([]),
    onChange: (_h: () => void) => () => {},
  } as unknown as TokenProvider;
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
    onChange: (_h: () => void) => () => {},
  } as unknown as AssetProvider;
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
}

describe("AssetsHomeWidget - Resource Store 集成", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染来自 Resource Store 的资产数据", async () => {
    resetRenderCounters();
    const host = createAssetsTestHost();
    const tokenReg = host.tokens;
    tokenReg.register(makeTokenProvider("tok1", "Tok1", () =>
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
    registerHoldingsResource(host, host.assets, tokenReg);

    render(
      <PluginHostProvider host={host}>
        <AssetsHomeWidget />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Test Token")).toBeTruthy();
    });
  });

  it("多个 provider 的数据正确聚合显示", async () => {
    const host = createAssetsTestHost();
    host.assets.register(makeAssetProvider("a1", "Coin1", () =>
      Promise.resolve([
        {
          assetId: "coin1",
          providerId: "a1",
          kind: "coin",
          label: "BSV",
          status: "ready",
          balance: { amount: 100, unit: "sats" },
        },
      ])
    ));
    host.tokens.register(makeTokenProvider("t1", "Token1", () =>
      Promise.resolve([
        {
          tokenId: "tok1",
          providerId: "t1",
          symbol: "TK1",
          label: "My Token",
          status: "ready",
          balance: { amount: 50, unit: "TK1" },
        },
      ])
    ));
    registerHoldingsResource(host, host.assets, host.tokens);

    render(
      <PluginHostProvider host={host}>
        <AssetsHomeWidget />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("BSV")).toBeTruthy();
      expect(screen.getByText("My Token")).toBeTruthy();
    });
  });

  it("无资产时显示空态", async () => {
    const host = createAssetsTestHost();
    registerHoldingsResource(host, host.assets, host.tokens);

    render(
      <PluginHostProvider host={host}>
        <AssetsHomeWidget />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("No assets")).toBeTruthy();
    });
  });
});
