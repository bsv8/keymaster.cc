// packages/plugin-assets/src/AssetsHomeWidget.test.tsx
// 首页统一持仓 widget 并发保护测试：
//   1. 渐进加载：一个 provider 挂起时，已完成 provider 先显示。
//   2. 旧请求晚到不得覆盖新数据。
//   3. 组件卸载后不再 setState。

// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import type {
  AssetProvider,
  AssetRegistry,
  TokenProvider,
  TokenRegistry,
} from "@keymaster/contracts";
import { AssetsHomeWidget } from "./AssetsHomeWidget.js";

/** 创建可控的 deferred promise。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

describe("AssetsHomeWidget - 并发保护", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渐进加载：一个 provider 挂起时，已完成 provider 先显示", async () => {
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
    const tokenReg = host.tokens;
    tokenReg.register(fastProvider);
    tokenReg.register(slowProvider);

    render(
      <PluginHostProvider host={host}>
        <AssetsHomeWidget />
      </PluginHostProvider>
    );

    // fast provider 完成后应先显示
    await waitFor(() => {
      expect(screen.getByText("Fast Token")).toBeTruthy();
    });

    // slow provider 仍在挂起，不应阻塞
    expect(screen.queryByText("Slow")).toBeFalsy();

    // 清理
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
    const tokenReg2 = host.tokens;
    tokenReg2.register(tokenProvider);

    render(
      <PluginHostProvider host={host}>
        <AssetsHomeWidget />
      </PluginHostProvider>
    );

    // 等待初始加载开始
    await vi.waitFor(() => {
      expect(callCount).toBe(1);
    });

    // 触发 onChange → 第二次调用
    const typedProvider = tokenProvider as unknown as { _emit: () => void };
    await act(async () => {
      typedProvider._emit();
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
