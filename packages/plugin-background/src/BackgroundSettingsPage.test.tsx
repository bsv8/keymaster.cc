// packages/plugin-background/src/BackgroundSettingsPage.test.tsx
// 智能调度设置页交互测试：
//   - 保存失败时回滚乐观更新，不显示未生效的值；
//   - 保存期间串行化，避免不同任务并发保存用旧快照互相覆盖；
//   - 保存成功后保留新值，并提交合并后的任务间隔。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BackgroundSettingsPage } from "./BackgroundSettingsPage.js";
import type {
  BackgroundCommandResult,
  BackgroundService,
  BackgroundSyncSettings
} from "@keymaster/contracts";

/** 测试用 i18n 文案：只覆盖断言需要的 key，其余回落到 defaultValue。 */
const I18N: Record<string, string> = {
  "background.settings.option.30s": "30 秒",
  "background.settings.option.1min": "1 分钟",
  "background.settings.option.5min": "5 分钟",
  "background.settings.option.off": "关闭"
};

const hostState: { settings: BackgroundSyncSettings } = { settings: { taskIntervals: {} } };
const activeService: { service: BackgroundService | undefined } = { service: undefined };

vi.mock("@keymaster/runtime", async () => {
  const actual = await vi.importActual<typeof import("@keymaster/runtime")>("@keymaster/runtime");
  return {
    ...actual,
    usePluginHost: () => ({ resourceStore: {} }),
    useI18n: () => ({
      t: (key: string, opts?: { defaultValue?: string }) => I18N[key] ?? opts?.defaultValue ?? key,
      text: (input: unknown) => (typeof input === "string" ? input : (input as { fallback?: string })?.fallback ?? ""),
      language: () => "zh-CN" as const,
      mode: () => "manual" as const,
      setLanguage: async () => undefined,
      setAuto: async () => undefined
    }),
    // 资源快照只在跨标签同步时变化；本测试用固定快照驱动初始值。
    useOptionalResourceSelector: (
      _store: unknown,
      _id: string,
      _args: unknown,
      selector: (snapshot: { data: BackgroundSyncSettings }) => BackgroundSyncSettings,
      fallback: BackgroundSyncSettings
    ): BackgroundSyncSettings => selector({ data: hostState.settings }) ?? fallback
  };
});

vi.mock("webloom-framework/react", () => ({
  useOptionalCapability: <T,>(): T | undefined => activeService.service as unknown as T
}));

interface FakeService {
  service: BackgroundService;
  calls: BackgroundSyncSettings[];
  /** 让下一次 update 挂起，直到 resolvePending。 */
  deferNext(): void;
  resolvePending(result: BackgroundCommandResult): void;
}

function makeFakeService(): FakeService {
  let persisted: BackgroundSyncSettings = { taskIntervals: {} };
  let deferred = false;
  let pending: ((result: BackgroundCommandResult) => void) | undefined;
  const calls: BackgroundSyncSettings[] = [];
  const service = {
    getScheduleSettings: () => structuredClone(persisted),
    updateScheduleSettings: async (next: BackgroundSyncSettings): Promise<BackgroundCommandResult> => {
      calls.push(structuredClone(next));
      if (deferred) {
        deferred = false;
        return await new Promise<BackgroundCommandResult>((resolve) => { pending = resolve; });
      }
      return { status: "accepted" };
    }
  } as unknown as BackgroundService;
  return {
    service,
    calls,
    deferNext: () => { deferred = true; },
    resolvePending: (result) => { pending?.(result); pending = undefined; }
  };
}

function taskRow(taskId: string): HTMLElement {
  const label = screen.getByText(taskId);
  const row = label.closest("li");
  if (!row) throw new Error(`task row not found: ${taskId}`);
  return row as HTMLElement;
}

function optionButton(taskId: string, label: string): HTMLButtonElement {
  return within(taskRow(taskId)).getByRole("button", { name: label }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  hostState.settings = { taskIntervals: {} };
  activeService.service = undefined;
});

describe("BackgroundSettingsPage 同步管理", () => {
  it("独立设置页显示智能调度标题", () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);
    expect(screen.getByRole("heading", { name: "智能调度" })).toBeTruthy();
  });

  it("保存失败时回滚乐观更新，并显示错误", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    // 初始：未配置 -> 5 分钟（平台缺省）。
    expect(optionButton("p2pkh.transactions-sync", "5 分钟").getAttribute("aria-pressed")).toBe("true");

    fake.deferNext();
    fireEvent.click(optionButton("p2pkh.transactions-sync", "30 秒"));
    // 乐观更新先显示 30 秒。
    expect(optionButton("p2pkh.transactions-sync", "30 秒").getAttribute("aria-pressed")).toBe("true");

    await waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.resolvePending({ status: "error", message: "boom" });

    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    // 失败后回滚到实际生效的 5 分钟，而不是继续显示未生效的 30 秒。
    expect(optionButton("p2pkh.transactions-sync", "30 秒").getAttribute("aria-pressed")).toBe("false");
    expect(optionButton("p2pkh.transactions-sync", "5 分钟").getAttribute("aria-pressed")).toBe("true");
  });

  it("保存期间禁用所有按钮，串行保存且不丢其它任务已保存的值", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    fake.deferNext();
    fireEvent.click(optionButton("p2pkh.transactions-sync", "30 秒"));
    await waitFor(() => expect(fake.calls).toHaveLength(1));

    // 第一个保存未完成：所有按钮禁用，第二次点击被忽略。
    await waitFor(() => expect(optionButton("token-bsv21.sync", "1 分钟").disabled).toBe(true));
    fireEvent.click(optionButton("token-bsv21.sync", "1 分钟"));
    expect(fake.calls).toHaveLength(1);

    // 第一个保存成功；模拟平台缓存与页面资源事件都尚未回流。
    fake.resolvePending({ status: "accepted" });
    await waitFor(() => expect(optionButton("token-bsv21.sync", "1 分钟").disabled).toBe(false));

    fireEvent.click(optionButton("token-bsv21.sync", "1 分钟"));
    await waitFor(() => expect(fake.calls).toHaveLength(2));
    // 第二次保存以平台最新设置为基准合并，不会把第一个任务的修改覆盖掉。
    expect(fake.calls[1]?.taskIntervals).toEqual({
      "p2pkh.transactions-sync": 30_000,
      "token-bsv21.sync": 60_000
    });
    expect(optionButton("token-bsv21.sync", "1 分钟").getAttribute("aria-pressed")).toBe("true");
  });

  it("同任务第一次保存成功但缓存未回流，第二次保存失败回滚到第一次的值", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    // 第一次保存成功：平台缓存与资源事件都尚未回流。
    fireEvent.click(optionButton("p2pkh.transactions-sync", "30 秒"));
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    await waitFor(() => expect(optionButton("p2pkh.transactions-sync", "30 秒").getAttribute("aria-pressed")).toBe("true"));

    // 第二次保存同一个任务但失败。
    fake.deferNext();
    fireEvent.click(optionButton("p2pkh.transactions-sync", "1 分钟"));
    await waitFor(() => expect(fake.calls).toHaveLength(2));
    fake.resolvePending({ status: "error", message: "boom" });

    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    // 回滚到第一次成功保存的 30 秒，而不是旧缺省 5 分钟。
    expect(optionButton("p2pkh.transactions-sync", "30 秒").getAttribute("aria-pressed")).toBe("true");
    expect(optionButton("p2pkh.transactions-sync", "5 分钟").getAttribute("aria-pressed")).toBe("false");
  });

  it("保存「关闭」会提交 0 并保持选中", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    fireEvent.click(optionButton("contacts.presence-probe", "关闭"));
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]?.taskIntervals).toEqual({ "contacts.presence-probe": 0 });
    await waitFor(() => expect(optionButton("contacts.presence-probe", "关闭").getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByText("保存失败，请稍后重试。")).toBeNull();
  });
});
