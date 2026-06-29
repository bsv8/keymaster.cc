// packages/plugin-apps/src/AppsHomeWidget.test.tsx
// AppsHomeWidget 首页 widget 验收测试（施工单 2026-06-29 002 硬切换 + 用户反馈）。
//
// 关键不变量（widget 层）：
//   1. 渲染前 3 张 app 卡片（V1 唯一一条 justnote，只展示这一条）。
//   2. 点击 Open App 走 `protocol.service.launchAppView(...)`。
//   3. 启动失败：按 `LaunchAppViewError.code` 映射到 i18n 文案，**不**
//      直接暴露 `err.message`。
//   4. 启动成功：不显示错误。
//   5. 当前 V1 只有 1 条 catalog 记录，**不**渲染 "View all apps" 入口
//      （hasMore === false）。

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  LaunchAppViewError,
  PROTOCOL_SERVICE_CAPABILITY,
  type LaunchAppViewInput,
  type LaunchAppViewResult,
  type ProtocolService
} from "@keymaster/contracts";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import { AppsHomeWidget } from "./AppsHomeWidget.js";
import { appsPlugin } from "./manifest.js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

interface MountHandle {
  service: ProtocolService & { launchAppViewCalls: LaunchAppViewInput[] };
  host: ReturnType<typeof createPluginHost>;
  unmount(): void;
}

function makeService(): ProtocolService & { launchAppViewCalls: LaunchAppViewInput[] } {
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
  } as unknown as ProtocolService & { launchAppViewCalls: LaunchAppViewInput[] };
}

function mount(): MountHandle {
  const service = makeService();
  const host = createPluginHost({
    initialI18nResources: appsPlugin.i18n ? [appsPlugin.i18n] : []
  });
  host.provide(PROTOCOL_SERVICE_CAPABILITY, service);
  const r = render(
    <PluginHostProvider host={host}>
      <AppsHomeWidget />
    </PluginHostProvider>
  );
  return { service, host, unmount: r.unmount };
}

describe("AppsHomeWidget - 渲染", () => {
  it("渲染 widget 标题与 justnote 行", () => {
    mount();
    expect(screen.getByTestId("apps-home-widget")).toBeTruthy();
    expect(screen.getByTestId("apps-home-row-justnote")).toBeTruthy();
  });

  it("当前 V1 唯一 1 条记录：'View all apps' 入口不渲染", () => {
    mount();
    expect(screen.queryByText(/view all apps/i)).toBeNull();
  });
});

describe("AppsHomeWidget - 点击启动", () => {
  it("点击 Open App → 调 launchAppView，参数与 catalog 一致", async () => {
    const handle = mount();
    const button = screen.getByTestId("apps-home-open-justnote") as HTMLButtonElement;
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
    const button = screen.getByTestId("apps-home-open-justnote") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("apps-home-error-justnote")).toBeNull();
    });
  });
});

describe("AppsHomeWidget - 启动失败", () => {
  it("vault 未解锁：UI 显示 user-facing 文案，不暴露 err.message", async () => {
    const handle = mount();
    (handle.service as unknown as { launchAppView: () => Promise<LaunchAppViewResult> })
      .launchAppView = async () => {
        throw new LaunchAppViewError(
          "vault_locked",
          "launchAppView: vault not unlocked"
        );
      };
    const button = screen.getByTestId("apps-home-open-justnote") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      const err = screen.getByTestId("apps-home-error-justnote");
      expect(err).toBeTruthy();
      expect(err.textContent).not.toMatch(/vault not unlocked/);
      expect(err.textContent).toMatch(/unlock/i);
    });
  });

  it("app 配置非法：UI 显示 user-facing 文案，不暴露 err.message", async () => {
    const handle = mount();
    (handle.service as unknown as { launchAppView: () => Promise<LaunchAppViewResult> })
      .launchAppView = async () => {
        throw new LaunchAppViewError(
          "invalid_app_config",
          "launchAppView: appOrigin does not match appUrl.origin"
        );
      };
    const button = screen.getByTestId("apps-home-open-justnote") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      const err = screen.getByTestId("apps-home-error-justnote");
      expect(err).toBeTruthy();
      expect(err.textContent).not.toMatch(/appOrigin does not match/);
    });
  });

  it("非 typed 错误：UI 走 internal 兜底文案", async () => {
    const handle = mount();
    (handle.service as unknown as { launchAppView: () => Promise<LaunchAppViewResult> })
      .launchAppView = async () => {
        throw new Error("internal leaked message");
      };
    const button = screen.getByTestId("apps-home-open-justnote") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      const err = screen.getByTestId("apps-home-error-justnote");
      expect(err).toBeTruthy();
      expect(err.textContent).not.toMatch(/internal leaked message/);
    });
  });
});
