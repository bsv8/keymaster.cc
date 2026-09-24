// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AutoLockSettingsPage, AutoLockSettingsSection } from "./AutoLockSettingsSection.js";
import type { AutoLockService, AutoLockSettings } from "@keymaster/contracts";

const hostState: { settings: AutoLockSettings } = { settings: { timeoutMs: 5 * 60 * 1000 } };
const activeService: { service: AutoLockService | undefined } = { service: undefined };

vi.mock("@keymaster/runtime", async () => {
  const actual = await vi.importActual<typeof import("@keymaster/runtime")>("@keymaster/runtime");
  return {
    ...actual,
    usePluginHost: () => ({ resourceStore: {} }),
    useI18n: () => ({
      t: (key: string, opts?: { defaultValue?: string; minutes?: number; hours?: number }) => {
        let fallback = opts?.defaultValue ?? key;
        if (typeof opts?.minutes === "number") fallback = fallback.replace("{{minutes}}", String(opts.minutes));
        if (typeof opts?.hours === "number") fallback = fallback.replace("{{hours}}", String(opts.hours));
        return fallback;
      },
      text: (input: unknown) => (typeof input === "string" ? input : (input as { fallback?: string })?.fallback ?? ""),
      language: () => "zh-CN" as const,
      mode: () => "manual" as const,
      setLanguage: async () => undefined,
      setAuto: async () => undefined,
    }),
    useOptionalResourceSelector: (
      _store: unknown,
      _id: string,
      _args: unknown,
      selector: (snapshot: { data: AutoLockSettings }) => AutoLockSettings,
      fallback: AutoLockSettings
    ): AutoLockSettings => selector({ data: hostState.settings }) ?? fallback,
  };
});

vi.mock("webloom-framework/react", () => ({
  useOptionalCapability: <T,>(): T | undefined => activeService.service as unknown as T,
}));

function makeFakeService(initialMs = 5 * 60 * 1000) {
  let current = initialMs;
  const calls: number[] = [];
  let shouldFail = false;
  const service = {
    getSettings: () => ({ timeoutMs: current }),
    onSettingsChanged: (handler: (s: AutoLockSettings) => void) => {
      handler({ timeoutMs: current });
      return () => undefined;
    },
    updateSettings: async (next: AutoLockSettings) => {
      calls.push(next.timeoutMs);
      if (shouldFail) return { status: "error" as const, message: "boom" };
      current = next.timeoutMs;
      hostState.settings = { timeoutMs: current };
      return { status: "accepted" as const };
    },
  } as unknown as AutoLockService;
  return {
    service,
    calls,
    failNext: () => { shouldFail = true; },
    succeedNext: () => { shouldFail = false; },
  };
}

afterEach(() => {
  cleanup();
  hostState.settings = { timeoutMs: 5 * 60 * 1000 };
  activeService.service = undefined;
});

describe("AutoLockSettingsSection", () => {
  it("独立设置页显示自动锁屏标题", () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsPage />);
    expect(screen.getByRole("heading", { name: "自动锁屏" })).toBeTruthy();
  });

  it("显示当前策略，并高亮默认的 5 分钟选项", () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    expect(screen.getByRole("button", { name: "5 分钟" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/无操作 5 分钟后自动锁定/)).toBeTruthy();
    expect(screen.getByText("当前策略")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("点击 2 分钟预设立即生效", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "2 分钟" }));
    await waitFor(() => expect(fake.calls).toEqual([2 * 60 * 1000]));
  });

  it("永不表示一直不锁", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "永不" }));
    await waitFor(() => expect(fake.calls).toEqual([0]));
  });

  it("自定义在弹窗中编辑，取消不会保存", () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    const editor = screen.getByRole("dialog");
    fireEvent.change(within(editor).getByPlaceholderText(/例如/), { target: { value: "10" } });
    fireEvent.click(within(editor).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("自定义输入点应用才保存", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    const editor = screen.getByRole("dialog");
    const input = within(editor).getByPlaceholderText(/例如/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });
    expect(fake.calls).toEqual([]);
    expect(input.disabled).toBe(false);
    fireEvent.click(within(editor).getByRole("button", { name: "应用" }));
    await waitFor(() => expect(fake.calls).toEqual([10 * 60 * 1000]));
  });

  it("回车等同于点应用", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    const input = within(screen.getByRole("dialog")).getByPlaceholderText(/例如/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", charCode: 13 });
    await waitFor(() => expect(fake.calls).toEqual([12 * 60 * 1000]));
  });

  it("非法输入点应用才提示且不保存", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    const editor = screen.getByRole("dialog");
    fireEvent.change(within(editor).getByPlaceholderText(/例如/), { target: { value: "0" } });
    expect(screen.queryByText(/至少 1 分钟/)).toBeNull();
    fireEvent.click(within(editor).getByRole("button", { name: "应用" }));
    expect(await within(editor).findByText(/至少 1 分钟/)).toBeTruthy();
    expect(fake.calls).toEqual([]);
  });

  it("候选含 24 小时，点击即生效并显示小时", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    const button = screen.getByRole("button", { name: "24 小时" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    await waitFor(() => expect(fake.calls).toEqual([24 * 60 * 60 * 1000]));
  });

  it("已有 24 小时时概览显示小时", () => {
    hostState.settings = { timeoutMs: 24 * 60 * 60 * 1000 };
    const fake = makeFakeService(24 * 60 * 60 * 1000);
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    expect(screen.getByText(/无操作 24 小时后自动锁定/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "24 小时" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("自定义 1440 分钟可保存，1441 分钟被拦截", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    const editor = screen.getByRole("dialog");
    const input = within(editor).getByPlaceholderText(/例如/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1441" } });
    fireEvent.click(within(editor).getByRole("button", { name: "应用" }));
    expect(await within(editor).findByText(/最多 24 小时/)).toBeTruthy();
    expect(fake.calls).toEqual([]);
    fireEvent.change(input, { target: { value: "1440" } });
    fireEvent.click(within(editor).getByRole("button", { name: "应用" }));
    await waitFor(() => expect(fake.calls).toEqual([24 * 60 * 60 * 1000]));
  });

  it("已有自定义值时高亮自定义选项但不自动打开弹窗", () => {
    hostState.settings = { timeoutMs: 10 * 60 * 1000 };
    const fake = makeFakeService(10 * 60 * 1000);
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    expect(screen.getByRole("button", { name: "自定义" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/无操作 10 分钟后自动锁定/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("异步到达自定义值时更新当前选择", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    const { rerender } = render(<AutoLockSettingsSection />);
    expect(screen.getByRole("button", { name: "2 分钟" })).toBeTruthy();
    hostState.settings = { timeoutMs: 10 * 60 * 1000 };
    rerender(<AutoLockSettingsSection />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "自定义" }).getAttribute("aria-pressed")).toBe("true");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("保存失败时显示错误", async () => {
    const fake = makeFakeService();
    fake.failNext();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "15 分钟" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("boom"));
  });
});
