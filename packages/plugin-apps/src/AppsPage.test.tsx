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
  PROTOCOL_SERVICE_CAPABILITY,
  type LaunchAppViewInput,
  type LaunchAppViewResult,
  type ProtocolService
} from "@keymaster/contracts";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import { AppsPage } from "./AppsPage.js";
import { appsPlugin } from "./manifest.js";

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
  it("点击 Open App → 调 launchAppView，参数与 catalog 一致", async () => {
    const handle = mount();
    const button = screen.getByTestId("apps-open-justnote") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(handle.service.launchAppViewCalls.length).toBe(1);
    expect(handle.service.launchAppViewCalls[0]).toEqual({
      appId: "justnote",
      appOrigin: "https://justnote.apps.bsv8.com",
      appUrl: "https://justnote.apps.bsv8.com/",
      claims: []
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
    await waitFor(() => {
      const err = screen.getByTestId("apps-card-error-justnote");
      expect(err).toBeTruthy();
      // 内部字符串不能漏到 UI
      expect(err.textContent).not.toMatch(/totally unexpected internal error/);
    });
  });
});
