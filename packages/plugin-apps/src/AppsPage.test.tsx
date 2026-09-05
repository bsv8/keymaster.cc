// packages/plugin-apps/src/AppsPage.test.tsx
// AppsPage 页面级验收测试（施工单 2026-06-29 002 硬切换 + 用户反馈）。
//
// 关键不变量（页面层）：
//   1. 渲染本地 appsCatalog.json 的 ok 记录，每条带 Open App 按钮。
//   2. 点击 Open App 会调 `protocol.service.launchAppView(...)`，参数与
//      catalog 项严格一致。
//   3. 校验失败 / id 重复的记录走 invalid 列表，**不**打崩 host：
//      页面**不**渲染它们的 Open App 按钮。
//   4. 启动失败：按 `LaunchAppViewError.code` 映射到 i18n 文案，**不**
//      把内部 `err.message` 字符串（如"vault not unlocked"）直接暴露给
//      用户。
//   5. 启动成功：不显示错误。

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  LaunchAppViewError,
  KEYSPACE_SERVICE_CAPABILITY,
  PROTOCOL_SERVICE_CAPABILITY,
  type LaunchAppViewInput,
  type LaunchAppViewResult,
  type KeyIdentity,
  type KeyspaceService,
  type ProtocolService
} from "@keymaster/contracts";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import { AppsPage } from "./AppsPage.js";
import { appsPlugin } from "./manifest.js";

// 页面交互测试使用与协议测试同源的签名 fixture；生产内嵌 catalog 的
// proof 真值由 catalog.test 覆盖，未签名占位条目必须 fail closed。
vi.mock("./catalog.js", async () => {
  const actual = await vi.importActual<typeof import("./catalog.js")>("./catalog.js");
  return {
    ...actual,
    loadCatalog: () => ({
      ok: [{
        id: "justnote",
        name: "Justnote",
        summary: "Encrypted notes powered by Keymaster.",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/",
        claims: [],
        appIdentity: {
          version: 1 as const,
          publisherPublicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
          app: { id: "justnote", name: "Justnote", description: "Encrypted notes." },
          requirements: [] as ("private-key" | "storage")[],
          signature: "607c8f550f7242c6a6d27e5cfdcc7d11791c49a9ac8067defd2b68dc3bd92ab7139bcff3a1b1afe9441dd4b12822a8a600a2e463084b076fc79027bacced1019"
        }
      }],
      invalid: [],
      duplicates: []
    })
  };
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

interface MountHandle {
  service: ProtocolService & {
    launchAppViewCalls: LaunchAppViewInput[];
    /** 模拟下一次 launchAppView 抛错。 */
    failWith?: unknown;
  };
  host: ReturnType<typeof createPluginHost>;
  unmount(): void;
}

const TEST_PUB_HEX = "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798";

function makeKeyspaceService(): KeyspaceService {
  const key: KeyIdentity = {
    publicKeyHex: TEST_PUB_HEX,
    label: "Key A",
    capabilities: ["p2pkh"],
    createdAt: new Date().toISOString()
  };
  return {
    listKeys: async () => [key],
    getKey: async (publicKeyHex: string) => (publicKeyHex === TEST_PUB_HEX ? key : undefined),
    active: () => ({ activePublicKeyHex: TEST_PUB_HEX }),
    setActive: async () => undefined,
    requireActiveKey: () => key,
    onActiveChange: () => () => undefined,
    openOwnerAppStore: async () => ({ db: {} as IDBDatabase, name: "x", close: () => undefined }),
    registerStorageDeclaration: () => undefined,
    listOwnerStorageDeclarations: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  } as unknown as KeyspaceService;
}

function makeService(): ProtocolService & {
  launchAppViewCalls: LaunchAppViewInput[];
} {
  const launchAppViewCalls: LaunchAppViewInput[] = [];
  return {
    launchAppViewCalls,
    launchAppView: async (input: LaunchAppViewInput) => {
      launchAppViewCalls.push(input);
      return {
        sessionWindowOpened: true,
        connectSessionId: "sess-test",
        launchToken: "launch-test",
        appUrl: `${input.appUrl}?launchToken=launch-test`
      } satisfies LaunchAppViewResult;
    }
    // 其他接口测试不直接用，留空。
  } as unknown as ProtocolService & { launchAppViewCalls: LaunchAppViewInput[] };
}

function mount(): MountHandle {
  const service = makeService();
  const host = createPluginHost({
    initialI18nResources: appsPlugin.i18n ? [appsPlugin.i18n] : []
  });
  host.provide(PROTOCOL_SERVICE_CAPABILITY, service);
  host.provide(KEYSPACE_SERVICE_CAPABILITY, makeKeyspaceService());
  const renderResult = render(
    <PluginHostProvider host={host}>
      <AppsPage />
    </PluginHostProvider>
  );
  return {
    service,
    host,
    unmount: renderResult.unmount
  };
}

describe("AppsPage - 渲染 ok 记录", () => {
  it("渲染 justnote 卡片，含 Open App 按钮与 origin", () => {
    mount();
    const card = screen.getByTestId("apps-card-justnote");
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("Justnote");
    expect(screen.getByTestId("apps-card-origin-justnote").textContent).toBe(
      "https://justnote.apps.bsv8.com"
    );
    expect(screen.getByTestId("apps-open-justnote")).toBeTruthy();
  });
});

describe("AppsPage - 点击启动", () => {
  it("点击 Open App → 打开授权 modal，提交后调 launchAppView", async () => {
    const handle = mount();
    const button = screen.getByTestId("apps-open-justnote") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      expect(screen.getByTestId("app-launch-modal")).toBeTruthy();
    });
    const password = screen.getByLabelText(/vault password/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(password, { target: { value: "vault-password" } });
    });
    const confirm = screen.getByTestId("app-launch-confirm") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(handle.service.launchAppViewCalls.length).toBe(1);
    expect(handle.service.launchAppViewCalls[0]).toEqual({
      appId: "justnote",
      appIdentity: expect.any(Object),
      appOrigin: "https://justnote.apps.bsv8.com",
      appUrl: "https://justnote.apps.bsv8.com/",
      claims: [],
      publicKeyHex: TEST_PUB_HEX,
      password: "vault-password"
    });
  });

  it("启动成功：UI 不显示错误", async () => {
    mount();
    const button = screen.getByTestId("apps-open-justnote") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("apps-card-error-justnote")).toBeNull();
    });
  });
});

describe("AppsPage - 启动失败", () => {
  it("vault 未解锁：UI 显示 user-facing 文案（不暴露 err.message）", async () => {
    const handle = mount();
    // 覆盖 service 让其抛 LaunchAppViewError("vault_locked")。
    (handle.service as unknown as { launchAppView: () => Promise<LaunchAppViewResult> })
      .launchAppView = async () => {
        throw new LaunchAppViewError(
          "vault_locked",
          "launchAppView: vault not unlocked"
        );
      };
    const button = screen.getByTestId("apps-open-justnote") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    const password = screen.getByLabelText(/vault password/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(password, { target: { value: "vault-password" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("app-launch-confirm"));
    });
    await waitFor(() => {
      const err = screen.getByTestId("apps-card-error-justnote");
      expect(err).toBeTruthy();
      // 文案来自 i18n key "apps.open.error.vaultLocked"，不是 "vault not unlocked"
      // 这种内部实现细节。
      expect(err.textContent).not.toMatch(/vault not unlocked/);
      expect(err.textContent).toMatch(/unlock/i);
    });
  });

  it("弹窗被浏览器拦截：UI 显示 'openSessionWindowBlocked' 文案", async () => {
    const handle = mount();
    (handle.service as unknown as { launchAppView: () => Promise<LaunchAppViewResult> })
      .launchAppView = async () => {
        throw new LaunchAppViewError(
          "open_session_window_blocked",
          "launchAppView: window.open returned null"
        );
      };
    const button = screen.getByTestId("apps-open-justnote") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    const password = screen.getByLabelText(/vault password/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(password, { target: { value: "vault-password" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("app-launch-confirm"));
    });
    await waitFor(() => {
      const err = screen.getByTestId("apps-card-error-justnote");
      expect(err).toBeTruthy();
      expect(err.textContent).not.toMatch(/window\.open returned null/);
      // 文案应提示"允许弹窗"
      expect(err.textContent).toMatch(/popup|allow/i);
    });
  });

  it("非 typed 错误：UI 走 internal 兜底文案", async () => {
    const handle = mount();
    (handle.service as unknown as { launchAppView: () => Promise<LaunchAppViewResult> })
      .launchAppView = async () => {
        throw new Error("totally unexpected internal error");
      };
    const button = screen.getByTestId("apps-open-justnote") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    const password = screen.getByLabelText(/vault password/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(password, { target: { value: "vault-password" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("app-launch-confirm"));
    });
    await waitFor(() => {
      const err = screen.getByTestId("apps-card-error-justnote");
      expect(err).toBeTruthy();
      // 内部字符串不能漏到 UI
      expect(err.textContent).not.toMatch(/totally unexpected internal error/);
    });
  });
});
