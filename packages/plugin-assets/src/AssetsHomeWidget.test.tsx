// packages/plugin-assets/src/AssetsHomeWidget.test.tsx
// 首页统一持仓 widget 集成测试：
//   硬切换 003 后，并发保护职责已移至 Resource Store。
//   本测试验证 widget 正确读取 Resource Store 快照并渲染。

// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      "assets.homeWidget.empty": "No assets",
      "assets.homeWidget.address": "Address",
      "assets.homeWidget.copy": "Copy",
      "assets.homeWidget.copied": "Copied",
      "assets.homeWidget.mainnet": "Mainnet",
      "assets.homeWidget.testnet": "Testnet",
      "assets.homeWidget.holdings": "Assets",
      "assets.homeWidget.itemCount": "{{count}} items"
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
  tokenReg: TokenRegistry,
  activePublicKeyHex?: string
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
    id: "assets.active-context",
    scope: "active-key",
    key: () => ["assets.active-context"],
    load: async () => activePublicKeyHex ? {
      publicKeyHex: activePublicKeyHex,
      label: "Test key",
      capabilities: ["p2pkh"],
      createdAt: "2026-01-01T00:00:00.000Z"
    } : null,
    equals: (prev: { publicKeyHex?: string } | null | undefined, next: { publicKeyHex?: string } | null | undefined) => prev?.publicKeyHex === next?.publicKeyHex,
    invalidation: "immediate"
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

  it("展示当前钱包地址并支持拷贝", async () => {
    const host = createAssetsTestHost();
    const publicKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    host.assets.register(makeAssetProvider("p2pkh", "P2PKH", () => Promise.resolve([
      { assetId: "bsv", providerId: "p2pkh", kind: "coin", label: "BSV", network: "main", status: "ready", balance: { amount: 100, unit: "sats" } },
      { assetId: "bsvtest", providerId: "p2pkh", kind: "coin", label: "BSV Testnet", network: "test", status: "ready", balance: { amount: 200, unit: "sats" } }
    ])));
    registerHoldingsResource(host, host.assets, host.tokens, publicKeyHex);

    const { container } = render(
      <PluginHostProvider host={host}>
        <AssetsHomeWidget />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH")).toBeTruthy();
      expect(screen.getByText("mrCDrCybB6J1vRfbwM5hemdJz73FwDBC8r")).toBeTruthy();
      expect(screen.queryByText("ready")).toBeNull();
    });
    const widget = within(container);
    const mainnetAccount = widget.getByRole("region", { name: "Mainnet" });
    const testnetAccount = widget.getByRole("region", { name: "Testnet" });
    expect(within(mainnetAccount).getByText("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH")).toBeTruthy();
    expect(within(mainnetAccount).getByText("100 sats")).toBeTruthy();
    expect(within(testnetAccount).getByText("mrCDrCybB6J1vRfbwM5hemdJz73FwDBC8r")).toBeTruthy();
    expect(within(testnetAccount).getByText("200 sats")).toBeTruthy();
    fireEvent.click(within(testnetAccount).getByRole("button", { name: "Copy" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("mrCDrCybB6J1vRfbwM5hemdJz73FwDBC8r");
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    });
  });
});
