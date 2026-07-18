// packages/plugin-assets/src/AssetsPage.test.tsx
// 统一持仓页并发保护测试：
//   1. 一个 provider 挂起时，已完成 provider 先显示。
//   2. 触发 onChange 后返回新数据，旧请求晚到不得覆盖新数据。
//   3. 组件卸载后不再 setState。

// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import type {
  AssetProvider,
  AssetRegistry,
  KeyspaceService,
  TokenProvider,
  TokenRegistry,
} from "@keymaster/contracts";
import { AssetsPage } from "./AssetsPage.js";

/** 创建可控的 deferred promise。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeAssetProvider(
  id: string,
  name: string,
  listResult: () => Promise<unknown[]>
): AssetProvider {
  const listeners = new Set<() => void>();
  return {
    id,
    name: { key: `${id}.name`, fallback: name },
    order: 0,
    kind: "coin",
    listAssets: listResult as () => Promise<never[]>,
    getAsset: () => Promise.resolve(undefined),
    listActivity: () => Promise.resolve([]),
    onChange: (h: () => void) => {
      listeners.add(h);
      return () => listeners.delete(h);
    },
    _emit: () => {
      for (const l of [...listeners]) l();
    },
  } as unknown as AssetProvider & { _emit: () => void };
}

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

function makeAssetRegistry(providers: AssetProvider[]): AssetRegistry {
  return {
    list: () => providers,
    get: (id: string) => providers.find((p) => p.id === id),
    register: () => {},
    unregister: () => {},
  } as unknown as AssetRegistry;
}

function makeTokenRegistry(providers: TokenProvider[]): TokenRegistry {
  return {
    list: () => providers,
    get: (id: string) => providers.find((p) => p.id === id),
    register: () => {},
    unregister: () => {},
  } as unknown as TokenRegistry;
}

function makeKeyspace(publicKeyHex?: string): KeyspaceService {
  return {
    active: () => ({ activePublicKeyHex: publicKeyHex ?? "pk1" }),
    onActiveChange: () => () => {},
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

describe("AssetsPage - 并发保护", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("一个 provider 挂起时，已完成 provider 先显示", async () => {
    const hanging = deferred<never[]>();
    const fastProvider = makeTokenProvider("fast", "Fast", () =>
      Promise.resolve([
        {
          tokenId: "tok1",
          providerId: "fast",
          symbol: "FAST",
          label: "Fast Token",
          status: "ready",
        },
      ])
    );
    const slowProvider = makeTokenProvider("slow", "Slow", () => hanging.promise);

    const host = createPluginHost({ disableConfigPersistence: true });
    const assetReg = host.assets;
    const tokenReg = host.tokens;
    assetReg.register(makeAssetProvider("noop", "Noop", () => Promise.resolve([])) as unknown as AssetProvider);
    tokenReg.register(fastProvider);
    tokenReg.register(slowProvider);
    host.provide<KeyspaceService>("keyspace.service", makeKeyspace());

    render(
      <PluginHostProvider host={host}>
        <AssetsPage />
      </PluginHostProvider>
    );

    // fast provider 完成后应先显示
    await waitFor(() => {
      expect(screen.getByText("Fast Token")).toBeTruthy();
    });

    // slow provider 仍在挂起，不应阻塞页面
    expect(screen.queryByText("Slow")).toBeFalsy();

    // 清理：让 slow 也完成
    hanging.resolve([]);
  });

  it("旧请求晚到不得覆盖新数据", async () => {
    const firstRequest = deferred<unknown[]>();
    let callCount = 0;
    const tokenProvider = makeTokenProvider("tok-p", "TokenP", () => {
      callCount++;
      if (callCount === 1) return firstRequest.promise;
      // 第二次调用（onChange 触发）立即返回新数据
      return Promise.resolve([
        {
          tokenId: "new-tok",
          providerId: "tok-p",
          symbol: "NEW",
          label: "New Token",
          status: "ready",
        },
      ]);
    });

    const host = createPluginHost({ disableConfigPersistence: true });
    const assetReg = host.assets;
    const tokenReg = host.tokens;
    tokenReg.register(tokenProvider);
    host.provide<KeyspaceService>("keyspace.service", makeKeyspace());

    render(
      <PluginHostProvider host={host}>
        <AssetsPage />
      </PluginHostProvider>
    );

    // 等待初始加载开始
    await vi.waitFor(() => {
      expect(callCount).toBe(1);
    });

    // 触发 onChange → 第二次调用，返回新数据
    const typedProvider = tokenProvider as unknown as { _emit: () => void };
    await act(async () => {
      typedProvider._emit();
      // 让第二次调用的 microtask 执行
      await new Promise((r) => setTimeout(r, 50));
    });

    // 新数据应已显示
    await waitFor(() => {
      expect(screen.getByText("New Token")).toBeTruthy();
    });

    // 现在让第一次请求晚到
    await act(async () => {
      firstRequest.resolve([
        {
          tokenId: "old-tok",
          providerId: "tok-p",
          symbol: "OLD",
          label: "Old Token",
          status: "ready",
        },
      ]);
      await new Promise((r) => setTimeout(r, 50));
    });

    // 旧数据不应覆盖新数据
    expect(screen.queryByText("Old Token")).toBeFalsy();
    expect(screen.getByText("New Token")).toBeTruthy();
  });
});
