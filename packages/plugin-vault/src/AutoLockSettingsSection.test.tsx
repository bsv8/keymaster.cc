// packages/plugin-vault/src/AutoLockSettingsSection.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutoLockSettingsSection } from "./AutoLockSettingsSection.js";
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
  it("缺省 5 分钟高亮并显示当前状态，自定义输入默认隐藏", () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    const btn5 = screen.getByRole("button", { name: "5 分钟" });
    expect(btn5.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/无操作 5 分钟后自动锁定/)).toBeTruthy();
    // 自定义折叠态：输入框隐藏，只见自定义入口。
    expect(screen.queryByPlaceholderText(/例如/)).toBeNull();
    expect(screen.getByRole("button", { name: "自定义" })).toBeTruthy();
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
    hostState.settings = { timeoutMs: 0 };
  });

  it("点自定义后收起快捷选项并显示输入框，返回 icon 可回到快捷选项", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    // 快捷选项收起。
    expect(screen.queryByRole("button", { name: "2 分钟" })).toBeNull();
    expect(screen.queryByRole("button", { name: "永不" })).toBeNull();
    const input = screen.getByPlaceholderText(/例如/) as HTMLInputElement;
    expect(input).toBeTruthy();
    // 返回 icon 回到快捷选项。
    fireEvent.click(screen.getByRole("button", { name: "返回快捷选项" }));
    expect(await screen.findByRole("button", { name: "2 分钟" })).toBeTruthy();
    expect(screen.queryByPlaceholderText(/例如/)).toBeNull();
  });

  it("自定义输入点应用才保存，输入过程不打断", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    const input = screen.getByPlaceholderText(/例如/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });
    // 未点应用：不保存，输入框保持可用。
    expect(fake.calls).toEqual([]);
    expect(input.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() => expect(fake.calls).toEqual([10 * 60 * 1000]));
  });

  it("回车等同于点应用", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    const input = screen.getByPlaceholderText(/例如/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", charCode: 13 });
    await waitFor(() => expect(fake.calls).toEqual([12 * 60 * 1000]));
  });

  it("非法输入点应用才提示且不保存", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    const input = screen.getByPlaceholderText(/例如/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0" } });
    // 输入过程只清错误、不打断；点应用才校验。
    expect(screen.queryByText(/至少 1 分钟/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(await screen.findByText(/至少 1 分钟/)).toBeTruthy();
    expect(fake.calls).toEqual([]);
  });

  it("返回丢弃未保存的草稿", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    const input = screen.getByPlaceholderText(/例如/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "13" } });
    fireEvent.click(screen.getByRole("button", { name: "返回快捷选项" }));
    expect(await screen.findByRole("button", { name: "2 分钟" })).toBeTruthy();
    expect(fake.calls).toEqual([]);
  });

  it("候选含 24 小时，点击即生效并显示小时", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    const btn24 = screen.getByRole("button", { name: "24小时" });
    expect(btn24.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn24);
    await waitFor(() => expect(fake.calls).toEqual([24 * 60 * 60 * 1000]));
  });

  it("已有 24 小时显示 24 小时而非 1440 分钟", () => {
    hostState.settings = { timeoutMs: 24 * 60 * 60 * 1000 };
    const fake = makeFakeService(24 * 60 * 60 * 1000);
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    expect(screen.getByText(/无操作 24 小时后自动锁定/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "24小时" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("自定义 1440 分钟点应用可保存，1441 分钟被拦", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    const input = screen.getByPlaceholderText(/例如/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1441" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(await screen.findByText(/最多 24 小时/)).toBeTruthy();
    expect(fake.calls).toEqual([]);
    fireEvent.change(input, { target: { value: "1440" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() => expect(fake.calls).toEqual([24 * 60 * 60 * 1000]));
  });

  it("自定义值为 10 分钟时自动展开并高亮自定义入口", () => {
    hostState.settings = { timeoutMs: 10 * 60 * 1000 };
    const fake = makeFakeService(10 * 60 * 1000);
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    expect(screen.getByText(/无操作 10 分钟后自动锁定/)).toBeTruthy();
    // 自动展开自定义行。
    expect(screen.getByPlaceholderText(/例如/)).toBeTruthy();
  });

  it("已有自定义值异步到达时自动切到自定义 UI", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    const { rerender } = render(<AutoLockSettingsSection />);
    // 初值命中候选 → 快捷行。
    expect(screen.getByRole("button", { name: "2 分钟" })).toBeTruthy();
    // 跨 tab / 异步加载到达自定义值 → 收敛到自定义行。
    hostState.settings = { timeoutMs: 10 * 60 * 1000 };
    rerender(<AutoLockSettingsSection />);
    expect(await screen.findByPlaceholderText(/例如/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "2 分钟" })).toBeNull();
  });

  it("保存失败回滚并提示", async () => {
    const fake = makeFakeService();
    fake.failNext();
    activeService.service = fake.service;
    render(<AutoLockSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "15 分钟" }));
    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
  });
});
