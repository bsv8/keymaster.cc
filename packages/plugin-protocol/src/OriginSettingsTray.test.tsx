// packages/plugin-protocol/src/OriginSettingsTray.test.tsx
// 验证施工单 002 硬切换：
//   - 站点配置面板带有完整样式类；
//   - 不再出现"保存"按钮 / "已保存"提示；
//   - 复选框点击立即提交；
//   - 数字输入 onChange 不提交；blur / Enter 才提交；
//   - 提交失败回滚到旧真值；
//   - 非法数字输入规范化成 0；
//   - 切换 origin 重读真值，丢弃旧编辑态。

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OriginSettingsTrayInline } from "./OriginSettingsTray.js";
import {
  PROTOCOL_SERVICE_CAPABILITY,
  type ProtocolOriginSettingsRecord,
  type ProtocolService
} from "@keymaster/contracts";

let currentService: ProtocolService | null = null;

vi.mock("@keymaster/runtime", () => ({
  useCapability: (key: string) => {
    if (key === PROTOCOL_SERVICE_CAPABILITY) {
      return currentService;
    }
    return undefined;
  },
  useI18n: () => ({
    t: (key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? key,
    language: () => "en"
  })
}));

interface MockService extends ProtocolService {
  getOriginSettingsImpl: (origin: string) => Promise<ProtocolOriginSettingsRecord | null>;
  setOriginSettingsImpl: (record: ProtocolOriginSettingsRecord) => Promise<void>;
  setOriginSettingsCalls: ProtocolOriginSettingsRecord[];
  getOriginSettingsCalls: number;
}

function makeMockService(): MockService {
  const calls: ProtocolOriginSettingsRecord[] = [];
  const svc: MockService = {
    getOriginSettingsCalls: 0,
    setOriginSettingsCalls: calls,
    getOriginSettingsImpl: async (_origin: string) => null,
    setOriginSettingsImpl: async (_record: ProtocolOriginSettingsRecord) => undefined,
    async getOriginSettings(origin) {
      this.getOriginSettingsCalls++;
      return this.getOriginSettingsImpl(origin);
    },
    async setOriginSettings(record) {
      calls.push(record);
      return this.setOriginSettingsImpl(record);
    },
    // 兼容完整 ProtocolService 接口（施工单 2026-06-27 001 后增字段）。
    startSession: () => undefined,
    endSession: () => undefined,
    handleMessage: () => undefined,
    confirmByUser: async () => undefined,
    rejectByUser: async () => undefined,
    resumeAfterUnlock: () => undefined,
    pageUnloading: () => undefined,
    currentRequest: () => null,
    currentRequestAutoApproved: () => false,
    subscribe: () => () => undefined,
    snapshot: () => ({
      phase: "waiting" as const,
      boundSource: null,
      boundOrigin: null,
      method: null,
      requestId: null,
      lockState: "unlocked" as const
    }),
    currentOrigin: () => null,
    feedSnapshot: () => ({
      currentOrigin: null,
      commands: [],
      historyAvailable: true,
      lockSummary: null
    }),
    subscribeFeed: () => () => undefined,
    confirmDeadlineMs: () => null,
    lockState: () => "unlocked" as const,
    lockSummarySnapshot: () => null,
    // 测试不直接用 vault；MockService 只需要 getVaultService 接口存在。
    // 用最小骨架 + 类型断言避免触发 VaultService 全字段检查。
    getVaultService: (() => ({
      status: () => "unlocked" as const,
      onStatusChange: (_h: (s: "booting" | "uninitialized" | "locked" | "unlocked") => void) => () => undefined,
      unlock: async () => undefined
    })) as unknown as MockService["getVaultService"],
    setVaultLockState: () => undefined,
    // 施工单 2026-06-28 001：connect.* UI 接口的 mock。origin settings
    // 测试不实际触发 connect 流程；只要求接口存在。
    connectAuthSnapshot: () => null,
    connectLoginRecord: () => null,
    connectResumeRecord: () => null,
    confirmConnectLogin: async () => undefined,
    confirmConnectResume: async () => undefined,
    rejectConnectRequest: async () => undefined,
    // 施工单 2026-06-29 001 硬切换：Session Window / storage 公共 API。
    bootMode: () => "connect",
    appViewContext: () => null,
    bootstrapFailed: () => false,
    bootstrapFailureReason: () => null,
    awaitLauncherBootstrap: () => undefined,
    openClientApp: () => null,
    async getStorageProviderConfig() { return null; },
    async setStorageProviderConfig() { return; },
    async clearStorageProviderConfig() { return; }
  };
  return svc;
}

/** 找面板内第一个 type=number 的输入（用于复选框 input 区分）。 */
function findNumberInputByLabel(labelText: RegExp): HTMLInputElement {
  const labels = Array.from(
    document.querySelectorAll(".origin-settings-panel__field-label")
  );
  const label = labels.find((el) => labelText.test(el.textContent ?? ""));
  if (!label) {
    throw new Error(`number input not found for label: ${labelText}`);
  }
  const field = label.closest(".origin-settings-panel__field");
  if (!field) throw new Error("field not found");
  const input = field.querySelector('input[type="number"]') as HTMLInputElement | null;
  if (!input) throw new Error("input not found");
  return input;
}

/** 找面板内第一个 type=checkbox 的输入。 */
function findCheckboxByLabel(labelText: RegExp): HTMLInputElement {
  const labels = Array.from(
    document.querySelectorAll(".origin-settings-panel__field--inline span")
  );
  const label = labels.find((el) => labelText.test(el.textContent ?? ""));
  if (!label) {
    throw new Error(`checkbox input not found for label: ${labelText}`);
  }
  const field = label.closest(".origin-settings-panel__field--inline");
  if (!field) throw new Error("inline field not found");
  const input = field.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  if (!input) throw new Error("checkbox input not found");
  return input;
}

function flushMicrotasks(): Promise<void> {
  // 把当前 microtask queue + setTimeout(0) 都跑完，确保 useEffect / promise chain 完成。
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentService = null;
});

describe("OriginSettingsTray — 面板样式（施工单 002）", () => {
  it("renders full style classes after async getOriginSettings resolves", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    currentService = service;
    render(<OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />);
    // 等 getOriginSettings 异步完成。
    await act(async () => {
      await flushMicrotasks();
    });
    const panel = document.querySelector(".origin-settings-panel");
    expect(panel).not.toBeNull();
    expect(panel!.querySelector(".origin-settings-panel__form")).not.toBeNull();
    expect(panel!.querySelector(".origin-settings-panel__close")).not.toBeNull();
    expect(panel!.querySelectorAll(".origin-settings-panel__field").length).toBeGreaterThan(0);
  });

  it("does not render Save button nor Saved hint", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    currentService = service;
    render(<OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.queryByText("Save")).toBeNull();
    expect(screen.queryByText("保存")).toBeNull();
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.queryByText("已保存")).toBeNull();
  });
});

describe("OriginSettingsTray — 复选框即时提交（施工单 002）", () => {
  it("calls setOriginSettings immediately on checkbox click", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    currentService = service;
    render(<OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const checkbox = findCheckboxByLabel(/Auto-approve p2pkh/);
    expect(checkbox.checked).toBe(false);
    await act(async () => {
      fireEvent.click(checkbox);
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
    expect(service.setOriginSettingsCalls[0]!.p2pkhAutoApproveEnabled).toBe(true);
  });

  it("rolls back checkbox state when setOriginSettings rejects", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    service.setOriginSettingsImpl = async () => {
      throw new Error("DB unavailable");
    };
    currentService = service;
    render(<OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const checkbox = findCheckboxByLabel(/Auto-approve p2pkh/);
    await act(async () => {
      fireEvent.click(checkbox);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
    // 失败：UI 回滚到旧值（unchecked）+ 显示错误。
    expect(checkbox.checked).toBe(false);
    expect(screen.getByText("DB unavailable")).toBeTruthy();
  });
});

describe("OriginSettingsTray — 数字输入编辑态 + blur/Enter 提交（施工单 002）", () => {
  it("does not submit on number input change; submits on blur", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    currentService = service;
    render(<OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const input = findNumberInputByLabel(/Max satoshis for auto-approve/);
    // onChange → 仅更新编辑态，不提交。
    await act(async () => {
      fireEvent.change(input, { target: { value: "123" } });
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(0);
    // blur → 提交。
    await act(async () => {
      fireEvent.blur(input);
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
    expect(service.setOriginSettingsCalls[0]!.p2pkhAutoApproveMaxSatoshis).toBe(123);
  });

  it("submits on Enter key in number input", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    currentService = service;
    render(<OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const input = findNumberInputByLabel(/Max satoshis for auto-approve/);
    await act(async () => {
      fireEvent.change(input, { target: { value: "456" } });
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(0);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
    expect(service.setOriginSettingsCalls[0]!.p2pkhAutoApproveMaxSatoshis).toBe(456);
  });

  it("rolls back number input value when submission rejects", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 100,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    service.setOriginSettingsImpl = async () => {
      throw new Error("DB unavailable");
    };
    currentService = service;
    render(<OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const input = findNumberInputByLabel(/Max satoshis for auto-approve/);
    expect(input.value).toBe("100");
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "500" } });
      fireEvent.blur(input);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
    // 失败：input 显示回旧值 100。
    expect(input.value).toBe("100");
    expect(screen.getByText("DB unavailable")).toBeTruthy();
  });

  it("normalizes invalid number input to 0 and persists it", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    currentService = service;
    render(<OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const input = findNumberInputByLabel(/Max satoshis for auto-approve/);
    // 负数 → 0：触发 0 → 0 幂等不写库。所以这里先改 record.p2pkhAutoApproveMaxSatoshis 让首次 blur 真正落库。
    await act(async () => {
      fireEvent.change(input, { target: { value: "1" } });
      fireEvent.blur(input);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
    expect(service.setOriginSettingsCalls[0]!.p2pkhAutoApproveMaxSatoshis).toBe(1);
    // 再输入负数 → 规范化为 0 → 提交 0。
    await act(async () => {
      fireEvent.change(input, { target: { value: "-5" } });
      fireEvent.blur(input);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(2);
    expect(service.setOriginSettingsCalls[1]!.p2pkhAutoApproveMaxSatoshis).toBe(0);
    expect(input.value).toBe("0");
  });

  it("treats repeated blur/Enter with same normalized value as idempotent", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    currentService = service;
    render(<OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const input = findNumberInputByLabel(/Max satoshis for auto-approve/);
    // 第一次：0 → 50，落库。
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "50" } });
      fireEvent.blur(input);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
    // 第二次 blur 不再 change，规范化值 50 === record 真值 50，幂等不写库。
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.blur(input);
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
  });
});

describe("OriginSettingsTray — origin 切换（施工单 002）", () => {
  it("discards local edit state and reloads record when origin changes", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    currentService = service;
    const { rerender } = render(
      <OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />
    );
    await act(async () => {
      await flushMicrotasks();
    });
    const input = findNumberInputByLabel(/Max satoshis for auto-approve/);
    // 用户在 demo origin 输入 "777" 但不提交 → 仍是编辑态。
    await act(async () => {
      fireEvent.change(input, { target: { value: "777" } });
      await flushMicrotasks();
    });
    expect(input.value).toBe("777");
    expect(service.setOriginSettingsCalls.length).toBe(0);
    // 切到 other origin + 不同的真值 → 编辑态丢弃，按新真值渲染。
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: true,
      p2pkhAutoApproveMaxSatoshis: 999,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    await act(async () => {
      rerender(
        <OriginSettingsTrayInline origin="https://other.example" onClose={() => undefined} />
      );
      await flushMicrotasks();
    });
    const newInput = findNumberInputByLabel(/Max satoshis for auto-approve/);
    expect(newInput.value).toBe("999");
  });
});

/* ============== 施工单 002 反馈：origin 切换 in-flight commit 隔离 ==============
 *
 * 旧实现只在 useEffect cleanup 里用 cancelled 标志挡住 `getOriginSettings`
 * 的 then 回调；`commit()` 内部 post-await 的 setRecord(prev) / setError /
 * setSaving(false) / setEdits 都没经过 generation 门禁。结果：用户在 origin A
 * 点复选框进入 commit，commit 在 await setOriginSettings 期间 origin 切到 B，
 * 旧 commit 失败时 setRecord(prev) 把新 origin 的 record 改回 origin A 的
 * prev；setError(...) 把 origin A 的报错挂在新 origin 面板上。
 *
 * 下面的测试覆盖这条 in-flight 竞态。
 */

interface ControllableSet {
  resolve: () => void;
  reject: (err: Error) => void;
}

/** 让 setOriginSettingsImpl 返回一个测试可手动 resolve/reject 的 Promise。 */
function makeControllableSetter(): ControllableSet {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    resolve: () => {
      resolve();
    },
    reject: (err: Error) => {
      reject(err);
    },
    // 把 promise 暴露出去给 impl 用。
    // 这里直接由 service.setOriginSettingsImpl 闭包捕获。
  };
}

describe("OriginSettingsTray — in-flight commit 跨 origin 切换（施工单 002 反馈）", () => {
  it("does not roll back new-origin record when an in-flight checkbox commit fails after origin switches", async () => {
    const service = makeMockService();
    // demo origin 的初始真值。
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    // 让 setOriginSettings 阻塞在测试手动 resolve/reject。
    let rejectSet!: (err: Error) => void;
    service.setOriginSettingsImpl = () =>
      new Promise<void>((_resolve, reject) => {
        rejectSet = reject;
      });
    currentService = service;
    const { rerender } = render(
      <OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />
    );
    await act(async () => {
      await flushMicrotasks();
    });
    // demo origin：点复选框 → commit 进入 await。
    const checkbox = findCheckboxByLabel(/Auto-approve p2pkh/);
    await act(async () => {
      fireEvent.click(checkbox);
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
    // 切到 other origin，配置为 p2pkhAutoApproveEnabled=true。
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: true,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    await act(async () => {
      rerender(
        <OriginSettingsTrayInline origin="https://other.example" onClose={() => undefined} />
      );
      await flushMicrotasks();
    });
    // 新 origin 面板就位（真值 checked=true）。
    const newCheckbox = findCheckboxByLabel(/Auto-approve p2pkh/);
    expect(newCheckbox.checked).toBe(true);
    // 现在旧 commit reject → 如果 generation gate 不存在，会把 record
    // 回滚到 demo origin 的 prev（p2pkhAutoApproveEnabled=false），并
    // 把 demo origin 的报错显示在新 origin 面板上。
    await act(async () => {
      rejectSet(new Error("DB unavailable"));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    // 关键断言：旧 commit 的失败**不**污染新 origin。
    expect(newCheckbox.checked).toBe(true);
    expect(screen.queryByText("DB unavailable")).toBeNull();
  });

  it("does not pollute new-origin state when an in-flight checkbox commit succeeds after origin switches", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    let resolveSet!: () => void;
    service.setOriginSettingsImpl = () =>
      new Promise<void>((resolve) => {
        resolveSet = resolve;
      });
    currentService = service;
    const { rerender } = render(
      <OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />
    );
    await act(async () => {
      await flushMicrotasks();
    });
    const checkbox = findCheckboxByLabel(/Auto-approve p2pkh/);
    await act(async () => {
      fireEvent.click(checkbox);
      await flushMicrotasks();
    });
    // 切到 other origin。
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: true,
      p2pkhAutoApproveMaxSatoshis: 123,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    await act(async () => {
      rerender(
        <OriginSettingsTrayInline origin="https://other.example" onClose={() => undefined} />
      );
      await flushMicrotasks();
    });
    const newCheckbox = findCheckboxByLabel(/Auto-approve p2pkh/);
    const newInput = findNumberInputByLabel(/Max satoshis for auto-approve/);
    expect(newCheckbox.checked).toBe(true);
    expect(newInput.value).toBe("123");
    // 旧 commit 成功 resolve → 旧 commit finally 不应触发任何污染新 origin 的 setState。
    await act(async () => {
      resolveSet();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    // 新 origin 状态保持不变。
    expect(newCheckbox.checked).toBe(true);
    expect(newInput.value).toBe("123");
    expect(screen.queryByText("DB unavailable")).toBeNull();
  });

  it("does not roll back new-origin number field when an in-flight number commit fails after origin switches", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    let rejectSet!: (err: Error) => void;
    service.setOriginSettingsImpl = () =>
      new Promise<void>((_resolve, reject) => {
        rejectSet = reject;
      });
    currentService = service;
    const { rerender } = render(
      <OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />
    );
    await act(async () => {
      await flushMicrotasks();
    });
    // demo origin：在数字输入里输入 500 然后 blur → commit 进入 await。
    const input = findNumberInputByLabel(/Max satoshis for auto-approve/);
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "500" } });
      fireEvent.blur(input);
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
    expect(input.value).toBe("500");
    // 切到 other origin + 不同真值。
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 888,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    await act(async () => {
      rerender(
        <OriginSettingsTrayInline origin="https://other.example" onClose={() => undefined} />
      );
      await flushMicrotasks();
    });
    const newInput = findNumberInputByLabel(/Max satoshis for auto-approve/);
    expect(newInput.value).toBe("888");
    // 旧 commit reject → 不应把新 origin 数字字段回滚到 demo origin 的 0，
    // 也不应显示错误。
    await act(async () => {
      rejectSet(new Error("DB unavailable"));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(newInput.value).toBe("888");
    expect(screen.queryByText("DB unavailable")).toBeNull();
  });
});

/* ============== 施工单 003：confirmTimeoutSeconds 字段 ============== */

describe("OriginSettingsTray — confirmTimeoutSeconds (003)", () => {
  it("提交合法正整数会落库", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    });
    currentService = service;
    render(<OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const input = findNumberInputByLabel(/确认超时|Confirmation timeout/);
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "15" } });
      fireEvent.blur(input);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
    expect(service.setOriginSettingsCalls[0]!.confirmTimeoutSeconds).toBe(15);
  });

  it("空串 / 0 / 负数 / 非整数 → 规范化 30 并落库", async () => {
    const service = makeMockService();
    service.getOriginSettingsImpl = async (origin) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 100,
      updatedAt: 0
    });
    currentService = service;
    render(<OriginSettingsTrayInline origin="https://demo.example" onClose={() => undefined} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const input = findNumberInputByLabel(/确认超时|Confirmation timeout/);
    // 空串 → 30。
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(service.setOriginSettingsCalls.length).toBe(1);
    expect(service.setOriginSettingsCalls[0]!.confirmTimeoutSeconds).toBe(30);
    expect(input.value).toBe("30");
  });
});
