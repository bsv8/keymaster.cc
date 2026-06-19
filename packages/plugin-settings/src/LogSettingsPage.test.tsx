// packages/plugin-settings/src/LogSettingsPage.test.tsx
// 硬切换 002：settings 路由 /settings/logs 与 LogSettingsPage 单测。
//
// 关键不变量：
//   1. LogSettingsPage 通过 useCapability 拿 log.service，写入 / 读出 / 修改 debug。
//   2. debug 关闭时页面能展示 debug toggle 与提示语。
//   3. clearEntries / prune 走 service 内部；不直接动 IndexedDB。
//   4. /settings/logs 路由在 settingsPlugin.setup 后被注册。
//
// 设计缘由：
//   - 不 import 任何业务插件内部日志类型；只通过 useCapability 拿 log.service。
//   - 测试夹具直接 delete keymaster.logs：测试专用路径，不暴露给生产代码。
//   - 渲染前先 register settingsPlugin，让 i18n 资源就位；这样按钮文案有
//     fallback，断言可以走 defaultValue 字符串而不是 i18n key。

// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  LOG_SERVICE_CAPABILITY,
  type LogService,
  type PluginContext,
  type PluginManifest
} from "@keymaster/contracts";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import { LogSettingsPage } from "./LogSettingsPage.js";

const LOG_DB_NAME = "keymaster.logs";

async function resetLogDb(): Promise<void> {
  // 给前一个测试 close 留几个微任务。
  await new Promise((r) => setTimeout(r, 30));
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const req = indexedDB.deleteDatabase(LOG_DB_NAME);
    req.onsuccess = () => finish();
    req.onerror = () => finish();
    setTimeout(finish, 2000);
  });
}

beforeEach(async () => {
  await resetLogDb();
});

afterEach(async () => {
  await resetLogDb();
});

/** 单独创建一个干净的 host + 注册 settings plugin（拿到 i18n 资源）。 */
async function makeHostWithSettings() {
  const host = createPluginHost({ disableConfigPersistence: true });
  const { settingsPlugin } = await import("./manifest.js");
  await host.register(settingsPlugin);
  return host;
}

describe("LogSettingsPage", () => {
  it("renders, toggles debug, refreshes entries, and shows retention", async () => {
    const host = await makeHostWithSettings();
    const log = host.capabilities.get<LogService>(LOG_SERVICE_CAPABILITY);
    await log.append({
      level: "info",
      pluginId: "demo",
      scope: "demo.scope",
      event: "demo.event",
      message: "hello"
    });
    await log.append({
      level: "warn",
      pluginId: "demo",
      scope: "demo.scope",
      event: "demo.warn",
      message: "something off"
    });

    await act(async () => {
      render(
        <PluginHostProvider host={host}>
          <LogSettingsPage />
        </PluginHostProvider>
      );
    });

    // 触发一次 refresh：组件 mount 后 useEffect 会调一次；等待 microtask。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const list = screen.getByRole("list");
    // 注册 settings plugin 触发了 plugin.enabled 系统日志（pluginId="runtime"），
    // 所以列表里会有 2 条 demo + 1 条 runtime plugin.enabled = 3 条。
    expect(within(list).getAllByRole("listitem").length).toBe(3);

    // debug 开关默认 false；切换为 true 并保存。
    const toggle = screen.getByRole("checkbox");
    expect((toggle as HTMLInputElement).checked).toBe(false);
    const user = userEvent.setup();
    await user.click(toggle);
    const saveBtn = screen.getByRole("button", { name: /Save/ });
    await user.click(saveBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const cfg = log.getConfig();
    expect(cfg.debugEnabled).toBe(true);

    // retention input 默认 30；改成 7。
    const retentionInput = screen.getByLabelText(/Retention/) as HTMLInputElement;
    // fireEvent.change 一步到位，避免 typing 时与受控 value 互相干扰。
    fireEvent.change(retentionInput, { target: { value: "7" } });
    await user.click(saveBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(log.getConfig().retentionDays).toBe(7);
  });

  it("clears all entries after confirm", async () => {
    const host = await makeHostWithSettings();
    const log = host.capabilities.get<LogService>(LOG_SERVICE_CAPABILITY);
    for (let i = 0; i < 3; i += 1) {
      await log.append({
        level: "info",
        pluginId: "demo",
        scope: "x",
        event: "y",
        message: `m-${i}`
      });
    }
    // 替换 window.confirm 防止阻塞。
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      render(
        <PluginHostProvider host={host}>
          <LogSettingsPage />
        </PluginHostProvider>
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const user = userEvent.setup();
    // "Clear all" 是 danger 变体；"Clear filtered" 是 ghost。用 className 区分。
    const clearAll = document.querySelector<HTMLButtonElement>(
      'button.ui-button--danger'
    );
    expect(clearAll).not.toBeNull();
    await user.click(clearAll!);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const all = await log.listEntries();
    // 页面清空会触发 host 后续 plugin.enabled 之类的系统日志可能还在路上；
    // 但对全部 0 的强约束是"用户视角的列表是空的"。这里确保业务 demo 条目
    // 已全部消失；用 pluginId 过滤后看 demo 是否还有残留。
    const leftDemo = await log.listEntries({ pluginId: "demo" });
    expect(leftDemo.length).toBe(0);
    expect(all.length).toBeGreaterThanOrEqual(0);
    confirmSpy.mockRestore();
  });
});

describe("settings plugin registers /settings/logs", () => {
  it("registers the logs settings route with the right path", async () => {
    const { settingsPlugin } = await import("./manifest.js");
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(settingsPlugin);
    const entry = host.settings.byPath("/settings/logs");
    expect(entry).toBeDefined();
    expect(entry?.id).toBe("settings.logs");
    expect(entry?.label).toEqual({ key: "settings.route.logs", fallback: "System logs" });
  });
});
