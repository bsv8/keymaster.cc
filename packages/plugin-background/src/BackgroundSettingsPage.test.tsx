// packages/plugin-background/src/BackgroundSettingsPage.test.tsx
// 智能调度设置页交互测试：
//   - 每个任务都缺省按自己的间隔显示（区块链高度 2 分钟，其余 5 分钟）；
//   - 预设只是快捷入口，自定义可提交任意合法整秒间隔；
//   - 保存失败时回滚乐观更新，不显示未生效的值；
//   - 保存期间串行化，避免不同任务并发保存用旧快照互相覆盖；
//   - 保存成功后保留新值，并提交合并后的任务间隔。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BackgroundSettingsPage } from "./BackgroundSettingsPage.js";
import { BACKGROUND_MANAGED_SYNC_TASK_IDS, CHAIN_HEIGHT_SYNC_TASK_ID } from "@keymaster/contracts";
import type {
  BackgroundCommandResult,
  BackgroundService,
  BackgroundSyncSettings,
  ChainHeightSnapshot
} from "@keymaster/contracts";

/** 测试用 i18n 文案：只覆盖断言需要的 key，其余回落到 defaultValue。 */
const I18N: Record<string, string> = {
  "background.settings.option.30s": "30 秒",
  "background.settings.option.1min": "1 分钟",
  "background.settings.option.2min": "2 分钟",
  "background.settings.option.5min": "5 分钟",
  "background.settings.option.off": "关闭",
  "background.settings.option.custom": "自定义"
};

const hostState: {
  settings: BackgroundSyncSettings;
  chainHeight: ChainHeightSnapshot;
} = {
  settings: { taskIntervals: {} },
  chainHeight: { height: 0, network: "main", available: false, revision: 0 }
};
const activeService: { service: BackgroundService | undefined } = { service: undefined };

vi.mock("@keymaster/runtime", async () => {
  const actual = await vi.importActual<typeof import("@keymaster/runtime")>("@keymaster/runtime");
  return {
    ...actual,
    usePluginHost: () => ({ resourceStore: {} }),
    useI18n: () => ({
      t: (key: string, opts?: { defaultValue?: string; [key: string]: unknown }) =>
        I18N[key] ?? String(opts?.defaultValue ?? key).replace(/{{(\w+)}}/g, (_m, name: string) => String(opts?.[name] ?? "")),
      text: (input: unknown) => (typeof input === "string" ? input : (input as { fallback?: string })?.fallback ?? ""),
      language: () => "zh-CN" as const,
      mode: () => "manual" as const,
      setLanguage: async () => undefined,
      setAuto: async () => undefined
    }),
    // 资源快照只在跨标签同步时变化；本测试用固定快照驱动初始值。
    useOptionalResourceSelector: (
      _store: unknown,
      id: string,
      _args: unknown,
      selector: (snapshot: { data: unknown }) => unknown,
      fallback: unknown
    ): unknown => {
      if (id === "chain.height") return selector({ data: hostState.chainHeight }) ?? fallback;
      return selector({ data: hostState.settings }) ?? fallback;
    }
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

/** 自定义弹窗里的秒数输入框。 */
function customSecondsInput(): HTMLInputElement {
  return within(screen.getByTestId("background-custom-interval-editor")).getByLabelText(/自定义间隔/u) as HTMLInputElement;
}

function customEditorAction(name: string): HTMLButtonElement {
  return within(screen.getByTestId("background-custom-interval-editor")).getByRole("button", { name }) as HTMLButtonElement;
}

function customEditorAlert(): HTMLElement {
  return within(screen.getByTestId("background-custom-interval-editor")).getByRole("alert");
}

afterEach(() => {
  cleanup();
  hostState.settings = { taskIntervals: {} };
  hostState.chainHeight = { height: 0, network: "main", available: false, revision: 0 };
  activeService.service = undefined;
});

describe("BackgroundSettingsPage 同步管理", () => {
  it("独立设置页显示智能调度标题", () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);
    expect(screen.getByRole("heading", { name: "智能调度" })).toBeTruthy();
  });

  it("区块链高度同步缺省 2 分钟，其余任务缺省 5 分钟", () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    expect(optionButton(CHAIN_HEIGHT_SYNC_TASK_ID, "2 分钟").getAttribute("aria-pressed")).toBe("true");
    expect(optionButton(CHAIN_HEIGHT_SYNC_TASK_ID, "5 分钟").getAttribute("aria-pressed")).toBe("false");
    expect(optionButton("p2pkh.transactions-sync", "5 分钟").getAttribute("aria-pressed")).toBe("true");
    expect(optionButton("token-bsv21.sync", "2 分钟").getAttribute("aria-pressed")).toBe("false");
  });

  it("区块链高度同步可以手动改为 2 分钟以外的值并提交 120 秒", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    fireEvent.click(optionButton(CHAIN_HEIGHT_SYNC_TASK_ID, "1 分钟"));
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]?.taskIntervals).toEqual({ [CHAIN_HEIGHT_SYNC_TASK_ID]: 60_000 });

    // 显式选择 2 分钟也必须落盘为 120_000，而不是被当成「缺省」而省略。
    fireEvent.click(optionButton(CHAIN_HEIGHT_SYNC_TASK_ID, "2 分钟"));
    await waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(fake.calls[1]?.taskIntervals).toEqual({ [CHAIN_HEIGHT_SYNC_TASK_ID]: 120_000 });
  });

  it("每个同步任务都提供手动间隔选项", () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    for (const taskId of BACKGROUND_MANAGED_SYNC_TASK_IDS) {
      const row = taskRow(taskId);
      for (const label of ["30 秒", "1 分钟", "2 分钟", "5 分钟", "关闭"]) {
        expect(within(row).getByRole("button", { name: label })).toBeTruthy();
      }
    }
  });

  it("展示当前区块链高度，尚未同步时显示等待文案", () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    hostState.chainHeight = { height: 912_345, network: "main", available: true, updatedAtMs: 1, revision: 3 };
    render(<BackgroundSettingsPage />);
    expect(screen.getByText("主网高度 912,345")).toBeTruthy();
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

  it("每个任务都提供自定义入口，弹窗按任务缺省间隔回填", () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    for (const taskId of BACKGROUND_MANAGED_SYNC_TASK_IDS) {
      expect(within(taskRow(taskId)).getByRole("button", { name: "自定义" }).getAttribute("aria-pressed")).toBe("false");
    }

    fireEvent.click(optionButton(CHAIN_HEIGHT_SYNC_TASK_ID, "自定义"));
    // 链高度缺省 2 分钟，回填的是秒而不是毫秒。
    expect(customSecondsInput().value).toBe("120");
  });

  it("自定义间隔提交任意合法整秒值，并接管该任务的显示", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    fireEvent.click(optionButton(CHAIN_HEIGHT_SYNC_TASK_ID, "自定义"));
    fireEvent.change(customSecondsInput(), { target: { value: "45" } });
    fireEvent.click(customEditorAction("应用"));

    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]?.taskIntervals).toEqual({ [CHAIN_HEIGHT_SYNC_TASK_ID]: 45_000 });
    await waitFor(() => expect(screen.queryByTestId("background-custom-interval-editor")).toBeNull());

    // 自定义值生效后：没有任何预设按钮被选中；自定义按钮可访问名保持「自定义」，
    // 可见文本改成生效值。
    const row = taskRow(CHAIN_HEIGHT_SYNC_TASK_ID);
    for (const label of ["30 秒", "1 分钟", "2 分钟", "5 分钟", "关闭"]) {
      expect(within(row).getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("false");
    }
    const custom = optionButton(CHAIN_HEIGHT_SYNC_TASK_ID, "自定义");
    expect(custom.getAttribute("aria-pressed")).toBe("true");
    expect(custom.textContent).toBe("45 秒");
  });

  it("自定义间隔非法时只提示错误，不提交", () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    fireEvent.click(optionButton("token-bsv21.sync", "自定义"));
    const input = customSecondsInput();
    const apply = customEditorAction("应用");

    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(apply);
    expect(within(screen.getByTestId("background-custom-interval-editor")).getByRole("alert").textContent).toContain("至少 10 秒");
    expect(fake.calls).toHaveLength(0);

    fireEvent.change(input, { target: { value: "90000" } });
    fireEvent.click(apply);
    expect(within(screen.getByTestId("background-custom-interval-editor")).getByRole("alert").textContent).toContain("最多 24 小时");
    expect(fake.calls).toHaveLength(0);

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(apply);
    expect(within(screen.getByTestId("background-custom-interval-editor")).getByRole("alert").textContent).toContain("请输入秒数");
    expect(fake.calls).toHaveLength(0);
  });

  it("自定义保存失败时弹窗保留、弹窗内显示原因，并回滚到实际生效值", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    fireEvent.click(optionButton("p2pkh.transactions-sync", "自定义"));
    fireEvent.change(customSecondsInput(), { target: { value: "90" } });
    fake.deferNext();
    fireEvent.click(customEditorAction("应用"));
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    // 在途保存期间弹窗内显示「保存中…」。
    expect(customEditorAction("保存中…").disabled).toBe(true);
    fake.resolvePending({ status: "error", message: "boom" });

    // 失败后弹窗不关闭，用户可以改完再试；页面回滚到缺省 5 分钟。
    await waitFor(() => expect(screen.getByTestId("background-custom-interval-editor")).toBeTruthy());
    await waitFor(() => expect(optionButton("p2pkh.transactions-sync", "5 分钟").getAttribute("aria-pressed")).toBe("true"));
    // 自定义按钮的可访问名固定为「自定义」，所以只能靠可见文本证明 90 秒没生效：
    // 它既没有显示该值，也不处于选中态。
    const custom = optionButton("p2pkh.transactions-sync", "自定义");
    expect(custom.textContent).toBe("自定义");
    expect(custom.getAttribute("aria-pressed")).toBe("false");
    // 失败原因必须显示在弹窗内：页面级错误区被遮罩挡住，弹窗外看不到。
    expect(customEditorAlert().textContent).toBe("boom");
  });

  it("预设保存失败显示页面级错误，打开自定义弹窗会清掉这条陈旧提示", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    // 预设保存失败：错误落在页面级（此时没有弹窗）。
    fake.deferNext();
    fireEvent.click(optionButton("p2pkh.transactions-sync", "30 秒"));
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.resolvePending({ status: "error", message: "boom" });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("boom"));

    // 打开弹窗：陈旧错误就地清掉，弹窗与页面都不再提示，避免误导本次编辑。
    fireEvent.click(optionButton("p2pkh.transactions-sync", "自定义"));
    await waitFor(() => expect(screen.queryByTestId("background-custom-interval-editor")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();

    // 关闭弹窗后也不会复活上一条错误。
    fireEvent.click(customEditorAction("取消"));
    await waitFor(() => expect(screen.queryByTestId("background-custom-interval-editor")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("关闭态任务的自定义弹窗回填该任务缺省间隔", async () => {
    const fake = makeFakeService();
    activeService.service = fake.service;
    render(<BackgroundSettingsPage />);

    fireEvent.click(optionButton(CHAIN_HEIGHT_SYNC_TASK_ID, "关闭"));
    await waitFor(() => expect(fake.calls).toHaveLength(1));

    fireEvent.click(optionButton(CHAIN_HEIGHT_SYNC_TASK_ID, "自定义"));
    expect(customSecondsInput().value).toBe("120");
  });
});
