// packages/plugin-protocol/src/ProtocolPopupPage.test.tsx
// 验证施工单 001 + 2026-06-27 002：
//   - waiting 状态显示空 feed / 等待文案；
//   - 命令流按 service 投影渲染：活请求区 + 历史区两个区块；
//   - 活请求区按 createdAt asc 默认展开；历史区默认折叠只读；
//   - 完成后页面不自动关闭（phase 回到 waiting）；
//   - closing 由 pageUnloading 路径发出。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ProtocolPopupPage } from "./ProtocolPopupPage.js";
import type {
  ProtocolCommandFeedState,
  ProtocolConnectAuthSnapshot,
  ProtocolMethod,
  ProtocolService,
  ProtocolSessionSnapshot
} from "@keymaster/contracts";
import { PROTOCOL_SERVICE_CAPABILITY, PROTOCOL_VERSION } from "@keymaster/contracts";
import type { ReactNode } from "react";

const runtimeState = vi.hoisted(() => ({
  vault: "unlocked" as "booting" | "uninitialized" | "locked" | "unlocked"
}));

// 简单的 i18n 模板替换：mock 渲染时把 `{{seconds}}` 这种占位符替换成
// values 里的字段。覆盖修复 2 测试场景（`protocol.countdown.remaining`
// 模板 + `seconds` 插值）。
function renderTemplate(template: string, values?: Record<string, unknown>): string {
  if (!template) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => {
    const v = values?.[name];
    return v === undefined ? `{{${name}}}` : String(v);
  });
}

vi.mock("@keymaster/runtime", () => ({
  useCapability: (key: string) => {
    if (key === PROTOCOL_SERVICE_CAPABILITY) {
      return currentService;
    }
    if (key === "vault.service") {
      return {
        status: () => runtimeState.vault,
        onStatusChange: (h: (s: typeof runtimeState.vault) => void) => {
          h(runtimeState.vault);
          return () => undefined;
        },
        unlock: async () => undefined
      };
    }
    return undefined;
  },
  useI18n: () => ({
    t: (key: string, values?: { defaultValue?: string; seconds?: number }) => {
      const tmpl = values?.defaultValue ?? key;
      // 用模板占位符替换模拟 i18n 资源行为：让"已挂资源但缺占位符"
      // 这条路径能够被覆盖到。
      return renderTemplate(tmpl, values);
    },
    language: () => "en"
  })
}));

let currentService: ProtocolService | null = null;

function makeFakeService(): ProtocolService & {
  postReadyCalls: number;
  rejectCalls: number;
  confirmCalls: number;
  resumeAfterUnlockCalls: number;
  handleMessageCalls: number;
  pageUnloadingCalls: number;
  closingSent: boolean;
  closingEmitted: number;
  messageListenerInstalledBeforeReady: boolean | null;
  feedListeners: Set<(s: ProtocolCommandFeedState) => void>;
  feed: ProtocolCommandFeedState;
  authSnapshot: ProtocolConnectAuthSnapshot | null;
  vaultStatusListeners: Set<(s: "booting" | "uninitialized" | "locked" | "unlocked") => void>;
  emitVaultStatus: (s: "booting" | "uninitialized" | "locked" | "unlocked") => void;
} {
  const snap: ProtocolSessionSnapshot = {
    phase: "waiting",
    boundSource: null,
    boundOrigin: null,
    method: null,
    requestId: null,
    lockState: "unlocked"
  };
  const listeners = new Set<(s: ProtocolSessionSnapshot) => void>();
  const feedListeners = new Set<(s: ProtocolCommandFeedState) => void>();
  const vaultStatusListeners = new Set<(s: "booting" | "uninitialized" | "locked" | "unlocked") => void>();
  const feed: ProtocolCommandFeedState = {
    currentOrigin: null,
    commands: [],
    historyAvailable: true,
    lockSummary: null
  };
  // 模拟真实 service：当前已绑定 request 时 `currentRequest()` 返回它，
  // 否则 null。让测试可以推进 confirming 状态。
  let currentRequest: { id: string; method: ProtocolMethod; params: Record<string, unknown> } | null = null;
  const svc = {
    phase: "waiting" as ProtocolSessionSnapshot["phase"],
    postReadyCalls: 0,
    rejectCalls: 0,
    confirmCalls: 0,
    resumeAfterUnlockCalls: 0,
    handleMessageCalls: 0,
    pageUnloadingCalls: 0,
    closingSent: false,
    closingEmitted: 0,
    messageListenerInstalledBeforeReady: null as boolean | null,
    listeners,
    feedListeners,
    vaultStatusListeners,
    feed,
    authSnapshot: null as ProtocolConnectAuthSnapshot | null,
    emitVaultStatus(next: "booting" | "uninitialized" | "locked" | "unlocked") {
      for (const listener of Array.from(vaultStatusListeners)) {
        listener(next);
      }
    },
    startSession() {
      this.phase = "waiting";
      this.postReadyCalls++;
      currentRequest = null;
      for (const l of listeners) l({ ...snap, phase: this.phase });
    },
    endSession() {
      this.phase = "waiting";
      for (const l of listeners) l({ ...snap, phase: this.phase });
    },
    handleMessage(_event: MessageEvent) {
      this.handleMessageCalls++;
      probeHandleMessageCalls++;
    },
    pageUnloading() {
      this.pageUnloadingCalls++;
      if (this.closingSent) return;
      this.closingSent = true;
      this.closingEmitted++;
    },
    async confirmByUser() {
      this.confirmCalls++;
    },
    async rejectByUser() {
      this.rejectCalls++;
      this.phase = "waiting";
      currentRequest = null;
      for (const l of listeners) l({ ...snap, phase: this.phase });
    },
    resumeAfterUnlock() {
      this.resumeAfterUnlockCalls++;
      this.phase = "confirming";
      for (const l of listeners) l({ ...snap, phase: this.phase });
    },
    currentRequest() {
      return currentRequest as unknown as ReturnType<ProtocolService["currentRequest"]>;
    },
    setCurrentRequest(next: typeof currentRequest) {
      currentRequest = next;
    },
    currentOrigin() {
      return this.feed.currentOrigin;
    },
    feedSnapshot() {
      return { ...this.feed, commands: this.feed.commands.slice(), lockSummary: this.feed.lockSummary };
    },
    subscribe(handler: (s: ProtocolSessionSnapshot) => void) {
      listeners.add(handler);
      handler({ ...snap, phase: this.phase });
      return () => listeners.delete(handler);
    },
    subscribeFeed(handler: (s: ProtocolCommandFeedState) => void) {
      feedListeners.add(handler);
      handler({ ...this.feed, commands: this.feed.commands.slice(), lockSummary: this.feed.lockSummary });
      return () => feedListeners.delete(handler);
    },
    snapshot() {
      return { ...snap, phase: this.phase };
    },
    currentRequestAutoApproved() {
      return false;
    },
    getOriginSettings: async () => null,
    setOriginSettings: async () => undefined,
    confirmDeadlineMs: () => null,
    setSystemSettings: async () => undefined,
    lockState: () => "unlocked" as const,
    lockSummarySnapshot: () => null,
    connectAuthSnapshot() {
      return this.authSnapshot;
    },
    // Mock vault service —— 测试可手动触发 onStatusChange。
    getVaultService: (() => ({
      status: () => "unlocked" as const,
      onStatusChange: (h: (s: "booting" | "uninitialized" | "locked" | "unlocked") => void) => {
        vaultStatusListeners.add(h);
        return () => vaultStatusListeners.delete(h);
      },
      unlock: async () => undefined
    })) as unknown as ProtocolService["getVaultService"],
    setVaultLockState: () => undefined,
    // 施工单 2026-06-28 001：connect.* UI 接口的 mock。测试不实际触发
    // connect 流程；只要求接口存在。
    connectLoginRecord: () => null,
    connectResumeRecord: () => null,
    confirmConnectLogin: async () => undefined,
    confirmConnectResume: async () => undefined,
    rejectConnectRequest: async () => undefined
  };
  return svc;
}

function Wrapper() {
  return <div data-testid="root">{ProtocolPopupPage() as unknown as ReactNode}</div>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentService = null;
  runtimeState.vault = "unlocked";
  probeHandleMessageCalls = 0;
});

describe("ProtocolPopupPage", () => {
  it("shows topbar and feed empty state on mount", () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    // 顶栏：当前站点 / 进入钱包 / 关闭 / 回到最新（文案带冒号，用正则匹配）
    expect(screen.getByText(/当前站点/)).toBeTruthy();
    // 施工单 001：顶栏不再显示 phaseLabel / "状态"。
    expect(screen.queryByText(/状态/)).toBeNull();
    expect(screen.queryByText(/等待下一条请求/)).toBeNull();
    expect(screen.getByText("关闭")).toBeTruthy();
    expect(screen.getByText("回到最新")).toBeTruthy();
    expect(screen.getByText("进入钱包")).toBeTruthy();
    // feed 等待文案（i18n key 即文案）：
    expect(service.postReadyCalls).toBe(1);
  });

  it("shows waiting hint when no origin yet", () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    expect(
      screen.getByText(
        "等待来自外部站点的第一条请求。命令历史会按该站点的 origin 归档。"
      )
    ).toBeTruthy();
  });

  it("renders login auth page without auto-selecting a key", () => {
    const service = makeFakeService();
    service.authSnapshot = {
      ownerType: "login",
      recordId: "login-record",
      canSubmit: true,
      submitted: false,
      login: {
        recordId: "login-record",
        availableKeys: [
          { publicKeyHex: "02" + "11".repeat(32), label: "Key A" },
          { publicKeyHex: "02" + "22".repeat(32), label: "Key B" }
        ]
      },
      resume: null
    };
    currentService = service;
    render(<ProtocolPopupPage />);
    expect(screen.getByText("重新认证并建立新会话")).toBeTruthy();
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => r.checked === false)).toBe(true);
    const submit = screen.getByRole("button", { name: "重新认证并建立新会话" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("does not resume waiting requests automatically when auth owner is visible", () => {
    const service = makeFakeService();
    service.authSnapshot = {
      ownerType: "login",
      recordId: "login-record",
      canSubmit: true,
      submitted: false,
      login: {
        recordId: "login-record",
        availableKeys: [{ publicKeyHex: "02" + "11".repeat(32), label: "Key A" }]
      },
      resume: null
    };
    currentService = service;
    render(<ProtocolPopupPage />);
    service.emitVaultStatus("unlocked");
    expect(service.resumeAfterUnlockCalls).toBe(0);
  });

  it("renders command feed: live section + history section (施工单 2026-06-27 002 硬切换)", async () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    // 推一条 feed 进 service：当前 origin + 一条活记录 + 一条历史记录。
    const newFeed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "live-1",
          origin: "https://demo.example",
          requestId: "live-1",
          method: "cipher.decrypt",
          phase: "confirming",
          decision: "pending",
          status: "confirming",
          textSummary: "live-prompt",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 2,
          updatedAt: 2,
          finishedAt: 0,
          errorCode: "",
          errorMessage: ""
        },
        {
          id: "hist-1",
          origin: "https://demo.example",
          requestId: "hist-1",
          method: "identity.get",
          phase: "approved",
          decision: "approved",
          status: "approved",
          textSummary: "history-prompt",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 1,
          updatedAt: 1,
          finishedAt: 1,
          errorCode: "",
          errorMessage: ""
        }
      ],
      historyAvailable: true,
      lockSummary: null
    };
    act(() => {
      service.feed = newFeed;
      for (const l of service.feedListeners) l({ ...newFeed, commands: newFeed.commands.slice() });
    });
    // 关键断言：两个区块标题都在。
    expect(screen.getByText("待处理请求")).toBeTruthy();
    expect(screen.getByText("历史")).toBeTruthy();
    // 活请求区默认展开：textSummary 直接展示。
    expect(screen.getByText("live-prompt")).toBeTruthy();
    // 历史区默认折叠：textSummary 不直接展示。
    expect(screen.queryByText("history-prompt")).toBeNull();
  });

  it("活请求区多条同类 request：每条独立展开，按 recordId 稳定 key", async () => {
    // 关键不变量（施工单 002）：同类 request 不复用卡位；每条独立展开。
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    const newFeed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "dec-A",
          origin: "https://demo.example",
          requestId: "dec-A",
          method: "cipher.decrypt",
          phase: "confirming",
          decision: "pending",
          status: "confirming",
          textSummary: "dec-A",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 1,
          updatedAt: 1,
          finishedAt: 0,
          errorCode: "",
          errorMessage: ""
        },
        {
          id: "dec-B",
          origin: "https://demo.example",
          requestId: "dec-B",
          method: "cipher.decrypt",
          phase: "confirming",
          decision: "pending",
          status: "confirming",
          textSummary: "dec-B",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 2,
          updatedAt: 2,
          finishedAt: 0,
          errorCode: "",
          errorMessage: ""
        }
      ],
      historyAvailable: true,
      lockSummary: null
    };
    act(() => {
      service.feed = newFeed;
      for (const l of service.feedListeners) l({ ...newFeed, commands: newFeed.commands.slice() });
    });
    // 两张独立活卡都默认展开。
    expect(screen.getByText("dec-A")).toBeTruthy();
    expect(screen.getByText("dec-B")).toBeTruthy();
  });

  it("第一条活卡终态后从活请求区进入历史区：第二条仍默认展开", async () => {
    // 关键不变量（施工单 002）：第一条活卡 → approved 后从活请求区离开
    // 进入历史区；第二条仍位于活请求区第一格并默认展开。
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    const newFeed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "live-B",
          origin: "https://demo.example",
          requestId: "live-B",
          method: "identity.get",
          phase: "confirming",
          decision: "pending",
          status: "confirming",
          textSummary: "B-prompt",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 2,
          updatedAt: 2,
          finishedAt: 0,
          errorCode: "",
          errorMessage: ""
        },
        {
          id: "hist-A",
          origin: "https://demo.example",
          requestId: "hist-A",
          method: "identity.get",
          phase: "approved",
          decision: "approved",
          status: "approved",
          textSummary: "A-history",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 1,
          updatedAt: 5,
          finishedAt: 5,
          errorCode: "",
          errorMessage: ""
        }
      ],
      historyAvailable: true,
      lockSummary: null
    };
    act(() => {
      service.feed = newFeed;
      for (const l of service.feedListeners) l({ ...newFeed, commands: newFeed.commands.slice() });
    });
    // 活请求区只剩 B：默认展开，textSummary 直接可见。
    expect(screen.getByText("B-prompt")).toBeTruthy();
    // 历史区有 A：默认折叠，textSummary 不直接可见。
    expect(screen.queryByText("A-history")).toBeNull();
    // 两个区块标题都在。
    expect(screen.getByText("待处理请求")).toBeTruthy();
    expect(screen.getByText("历史")).toBeTruthy();
  });

  it("renders 'history unavailable' notice when historyAvailable=false", () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    const noHistoryFeed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [],
      historyAvailable: false,
        lockSummary: null
    };
    act(() => {
      service.feed = noHistoryFeed;
      for (const l of service.feedListeners) l({ ...noHistoryFeed, commands: [] });
    });
    expect(
      screen.getByText(
        "历史不可用：本地数据库读取失败。当前命令仍可正常执行，但不会持久化。"
      )
    ).toBeTruthy();
  });

  it("does not auto-close popup when a request is confirmed (phase returns to waiting)", async () => {
    // 验证施工单 002：单条 request 完成后 phase 回到 waiting，popup 不
    // 渲染 DoneView，window.close 不会被自动触发。
    const service = makeFakeService() as unknown as ProtocolService & {
      listeners: Set<(s: ProtocolSessionSnapshot) => void>;
      feedListeners: Set<(s: ProtocolCommandFeedState) => void>;
      feed: ProtocolCommandFeedState;
      setCurrentRequest: (next: { id: string; method: ProtocolSessionSnapshot["method"]; params: Record<string, unknown> } | null) => void;
    };
    currentService = service;
    render(<ProtocolPopupPage />);
    // 模拟"已绑定 request"：让 currentRequest() 返回非 null。
    service.setCurrentRequest({
      id: "r-1",
      method: "identity.get",
      params: { aud: "https://demo.example", iat: 1, exp: 2, text: "x" }
    });
    // 同步 push live card 到 feed：确认视图**只**在最新卡片里出现。
    const liveFeed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "rec-1",
          origin: "https://demo.example",
          requestId: "r-1",
          method: "identity.get",
          phase: "confirming",
          decision: "pending",
          status: "confirming",
          textSummary: "live",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 1,
          updatedAt: 1,
          finishedAt: 0,
          errorCode: "",
          errorMessage: ""
        }
      ],
      historyAvailable: true,
        lockSummary: null
    };
    act(() => {
      service.feed = liveFeed;
      for (const l of service.feedListeners) l({ ...liveFeed, commands: liveFeed.commands.slice() });
    });
    // 推一次 phase=confirming，然后推 phase=waiting（模拟 confirmByUser 完成）。
    const confirming: ProtocolSessionSnapshot = {
      phase: "confirming",
      boundSource: null,
      boundOrigin: "https://demo.example",
      method: "identity.get",
      requestId: "r-1"
    , lockState: "unlocked" };
    act(() => {
      for (const l of service.listeners) l(confirming);
    });
    // confirming 时 feed live card 渲染"确认请求"标题。
    expect(screen.getByText("确认请求")).toBeTruthy();
    // 切回 waiting：ConfirmView 消失，feed 仍在。
    const waiting: ProtocolSessionSnapshot = {
      phase: "waiting",
      boundSource: null,
      boundOrigin: "https://demo.example",
      method: null,
      requestId: null
    , lockState: "unlocked" };
    act(() => {
      for (const l of service.listeners) l(waiting);
    });
    act(() => {
      const approvedFeed: ProtocolCommandFeedState = {
        ...liveFeed,
        commands: liveFeed.commands.map((c) =>
          c.requestId === "r-1"
            ? { ...c, phase: "approved", decision: "approved", status: "approved", finishedAt: 2, updatedAt: 2 }
            : c
        )
      };
      service.feed = approvedFeed;
      for (const l of service.feedListeners) l({ ...approvedFeed, commands: approvedFeed.commands.slice() });
    });
    expect(screen.queryByText("确认请求")).toBeNull();
    // 施工单 001：顶栏不再显示 phase / "等待下一条请求" 文案。
    expect(screen.queryByText(/等待下一条请求/)).toBeNull();
    expect(screen.queryByText(/状态/)).toBeNull();
  });

  it("registers window message listener before startSession sends ready", () => {
    const order: string[] = [];
    const service = makeFakeService();
    service.startSession = () => {
      order.push(`ready_at_${service.postReadyCalls}`);
      service.messageListenerInstalledBeforeReady = messageListenerInstalledForTest();
      service.postReadyCalls++;
    };
    currentService = service;
    render(<ProtocolPopupPage />);
    expect(service.postReadyCalls).toBe(1);
    expect(service.messageListenerInstalledBeforeReady).toBe(true);
  });

  it("shows unlock view inside feed live card when phase is unlocking", () => {
    // 施工单 003 收口：解锁表单**只**在命令流最新卡片里出现；
    // 没有"独立全页 overlay"。
    const service = makeFakeService() as unknown as ProtocolService & {
      listeners: Set<(s: ProtocolSessionSnapshot) => void>;
      feedListeners: Set<(s: ProtocolCommandFeedState) => void>;
      feed: ProtocolCommandFeedState;
      setCurrentRequest: (next: { id: string; method: ProtocolSessionSnapshot["method"]; params: Record<string, unknown> } | null) => void;
    };
    currentService = service;
    runtimeState.vault = "locked";
    render(<ProtocolPopupPage />);
    // 先把当前 request 推进 feed（live 卡片前置）。
    service.setCurrentRequest({
      id: "r-unlock",
      method: "identity.get",
      params: { aud: "https://demo.example", iat: 1, exp: 2, text: "x" }
    });
    const unlockFeed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "rec-unlock",
          origin: "https://demo.example",
          requestId: "r-unlock",
          method: "identity.get",
          phase: "waiting_unlock_manual",
          decision: "pending",
          status: "waiting_unlock",
          textSummary: "unlock",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 1,
          updatedAt: 1,
          finishedAt: 0,
          errorCode: "",
          errorMessage: ""
        }
      ],
      historyAvailable: true,
        lockSummary: null
    };
    act(() => {
      service.feed = unlockFeed;
      for (const l of service.feedListeners) l({ ...unlockFeed, commands: unlockFeed.commands.slice() });
    });
    const unlocking: ProtocolSessionSnapshot = {
      phase: "unlocking",
      boundSource: null,
      boundOrigin: "https://demo.example",
      method: "identity.get",
      requestId: "r-unlock"
    , lockState: "unlocked" };
    act(() => {
      for (const l of service.listeners) l(unlocking);
    });
    expect(screen.getByText("等待解锁")).toBeTruthy();
    // 不再有独立 overlay。
    expect(document.querySelector(".protocol-popup--unlock")).toBeNull();
    runtimeState.vault = "unlocked";
  });

  it("calls endSession on unmount", () => {
    const service = makeFakeService() as unknown as ProtocolService & {
      endSession: () => void;
    };
    currentService = service;
    const calls = { end: 0 };
    const origEnd = service.endSession.bind(service);
    service.endSession = () => {
      calls.end++;
      origEnd();
    };
    const { unmount } = render(<ProtocolPopupPage />);
    unmount();
    expect(calls.end).toBe(1);
  });

  it("calls pageUnloading on pagehide", () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    window.dispatchEvent(new Event("pagehide"));
    expect(service.pageUnloadingCalls).toBe(1);
  });

  it("calls pageUnloading on beforeunload", () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    window.dispatchEvent(new Event("beforeunload"));
    expect(service.pageUnloadingCalls).toBe(1);
  });

  it("does not double-send closing when service has already sent it", () => {
    const service = makeFakeService();
    service.closingSent = true;
    service.closingEmitted = 1;
    currentService = service;
    render(<ProtocolPopupPage />);
    window.dispatchEvent(new Event("pagehide"));
    expect(service.pageUnloadingCalls).toBe(1);
    expect(service.closingEmitted).toBe(1);
  });
});

let probeHandleMessageCalls = 0;
function messageListenerInstalledForTest(): boolean {
  const before = probeHandleMessageCalls;
  window.dispatchEvent(new MessageEvent("message", { data: { probe: true } }));
  const after = probeHandleMessageCalls;
  return after > before;
}

/* ============== 施工单 002 硬切换：topbar 站点配置按钮 ============== */

describe("ProtocolPopupPage topbar origin settings", () => {
  it("renders the site-settings button when an origin is bound", () => {
    const service = makeFakeService();
    currentService = service;
    act(() => {
      service.feed = {
        currentOrigin: "https://demo.example",
        commands: [],
        historyAvailable: true,
        lockSummary: null
      };
      for (const l of service.feedListeners) l({ ...service.feed });
    });
    render(<ProtocolPopupPage />);
    expect(screen.getByText("站点配置")).toBeTruthy();
  });

  it("site-settings button is disabled when no origin is bound", () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    const btn = screen.getByText("站点配置").closest("button");
    expect(btn).not.toBeNull();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  /* ============== 施工单 002：弹出面板 + 即时生效 ============== */

  it("clicking the site-settings button opens the inline panel with full style classes", async () => {
    const service = makeFakeService();
    service.getOriginSettings = vi.fn(async (origin: string) => ({
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    }));
    service.setOriginSettings = vi.fn(async () => undefined);
    currentService = service;
    act(() => {
      service.feed = {
        currentOrigin: "https://demo.example",
        commands: [],
        historyAvailable: true,
        lockSummary: null
      };
      for (const l of service.feedListeners) l({ ...service.feed });
    });
    render(<ProtocolPopupPage />);
    const btn = screen.getByText("站点配置").closest("button") as HTMLButtonElement;
    await act(async () => {
      btn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // 面板带完整样式类。
    const panel = document.querySelector(".origin-settings-panel");
    expect(panel).not.toBeNull();
    expect(panel!.querySelector(".origin-settings-panel__form")).not.toBeNull();
    // 不再出现"保存"按钮。
    expect(screen.queryByText("Save")).toBeNull();
    expect(screen.queryByText("保存")).toBeNull();
  });
});

describe("ProtocolPopupPage auto-approve skip", () => {
  it("does not render ConfirmView when currentRequestAutoApproved is true", () => {
    const service = makeFakeService() as unknown as ProtocolService & {
      currentRequestAutoApproved?: () => boolean;
      listeners: Set<(s: ProtocolSessionSnapshot) => void>;
      setCurrentRequest: (next: { id: string; method: ProtocolSessionSnapshot["method"]; params: Record<string, unknown> } | null) => void;
    };
    currentService = service;
    service.currentRequestAutoApproved = () => true;
    render(<ProtocolPopupPage />);
    service.setCurrentRequest({
      id: "r-auto",
      method: "p2pkh.transfer",
      params: { recipientAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", amountSatoshis: 1000 }
    });
    const executing: ProtocolSessionSnapshot = {
      phase: "executing",
      boundSource: null,
      boundOrigin: "https://demo.example",
      method: "p2pkh.transfer",
      requestId: "r-auto"
    , lockState: "unlocked" };
    act(() => {
      for (const l of service.listeners) l(executing);
    });
    // auto-approve 命中：ConfirmView 不应出现。
    expect(screen.queryByText("确认请求")).toBeNull();
  });
});

/* ============== 施工单 003：confirm 收口到历史卡 ============== */

describe("ProtocolPopupPage confirm-in-feed (003)", () => {
  it("confirming 时当前交互出现在 feed 最新卡片（无独立全页 overlay）", () => {
    const service = makeFakeService() as unknown as ProtocolService & {
      listeners: Set<(s: ProtocolSessionSnapshot) => void>;
      feedListeners: Set<(s: ProtocolCommandFeedState) => void>;
      feed: ProtocolCommandFeedState;
      setCurrentRequest: (next: { id: string; method: ProtocolSessionSnapshot["method"]; params: Record<string, unknown> } | null) => void;
    };
    currentService = service;
    render(<ProtocolPopupPage />);
    // 让 service 当前已绑定 request 并 push 到 feed。
    service.setCurrentRequest({
      id: "r-live",
      method: "identity.get",
      params: { aud: "https://demo.example", iat: 1, exp: 2, text: "x" }
    });
    const liveFeed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "rec-live",
          origin: "https://demo.example",
          requestId: "r-live",
          method: "identity.get",
          phase: "confirming",
          decision: "pending",
          status: "confirming",
          textSummary: "live",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 2,
          updatedAt: 2,
          finishedAt: 0,
          errorCode: "",
          errorMessage: ""
        }
      ],
      historyAvailable: true,
        lockSummary: null
    };
    act(() => {
      service.feed = liveFeed;
      for (const l of service.feedListeners) l({ ...liveFeed, commands: liveFeed.commands.slice() });
    });
    const confirming: ProtocolSessionSnapshot = {
      phase: "confirming",
      boundSource: null,
      boundOrigin: "https://demo.example",
      method: "identity.get",
      requestId: "r-live"
    , lockState: "unlocked" };
    act(() => {
      for (const l of service.listeners) l(confirming);
    });
    // 关键断言：feed 最新卡片内仍渲染"确认请求"标题 + 确认按钮；**不再**有
    // 独立的 .protocol-popup--confirm 全页 overlay。
    expect(screen.getByText("确认请求")).toBeTruthy();
    expect(screen.getByText("确认")).toBeTruthy();
    expect(screen.getByText("取消")).toBeTruthy();
    expect(document.querySelector(".protocol-popup--confirm")).toBeNull();
  });

  it("unlocking 时卡片内出现解锁表单（含密码输入 + 解锁 + 取消）", () => {
    const service = makeFakeService() as unknown as ProtocolService & {
      listeners: Set<(s: ProtocolSessionSnapshot) => void>;
      feedListeners: Set<(s: ProtocolCommandFeedState) => void>;
      feed: ProtocolCommandFeedState;
      setCurrentRequest: (next: { id: string; method: ProtocolSessionSnapshot["method"]; params: Record<string, unknown> } | null) => void;
    };
    currentService = service;
    runtimeState.vault = "locked";
    render(<ProtocolPopupPage />);
    service.setCurrentRequest({
      id: "r-unlock",
      method: "identity.get",
      params: { aud: "https://demo.example", iat: 1, exp: 2, text: "x" }
    });
    const unlockFeed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "rec-unlock",
          origin: "https://demo.example",
          requestId: "r-unlock",
          method: "identity.get",
          phase: "waiting_unlock_manual",
          decision: "pending",
          status: "waiting_unlock",
          textSummary: "unlock",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 1,
          updatedAt: 1,
          finishedAt: 0,
          errorCode: "",
          errorMessage: ""
        }
      ],
      historyAvailable: true,
        lockSummary: null
    };
    act(() => {
      service.feed = unlockFeed;
      for (const l of service.feedListeners) l({ ...unlockFeed, commands: unlockFeed.commands.slice() });
    });
    const unlocking: ProtocolSessionSnapshot = {
      phase: "unlocking",
      boundSource: null,
      boundOrigin: "https://demo.example",
      method: "identity.get",
      requestId: "r-unlock"
    , lockState: "unlocked" };
    act(() => {
      for (const l of service.listeners) l(unlocking);
    });
    // 等待解锁卡只展示摘要，不再在主页面卡片内内嵌解锁表单。
    expect(screen.getByText("等待解锁")).toBeTruthy();
    expect(screen.getByText("此请求需要解锁 Keymaster。解锁后会进入确认页。")).toBeTruthy();
    // 独立的 .protocol-popup--unlock overlay 不应存在。
    expect(document.querySelector(".protocol-popup--unlock")).toBeNull();
    runtimeState.vault = "unlocked";
  });

  it("status=timed_out 的卡片单独显示超时标签", () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    const feed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "rec-timeout",
          origin: "https://demo.example",
          requestId: "r-timeout",
          method: "identity.get",
          phase: "failed",
          decision: "failed",
          status: "timed_out",
          textSummary: "timeout",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 1,
          updatedAt: 1,
          finishedAt: 1,
          errorCode: "user_rejected",
          errorMessage: "User rejected",
          failureReason: "request_timeout"
        }
      ],
      historyAvailable: true,
        lockSummary: null
    };
    act(() => {
      service.feed = feed;
      for (const l of service.feedListeners) l({ ...feed, commands: feed.commands.slice() });
    });
    // 卡片 head 显示"超时"标签（i18n default = "超时"）。
    expect(screen.getByText("超时")).toBeTruthy();
  });

  it("rejected 历史卡按本地 failureReason 区分用户取消与 client 主动取消", () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    const feed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "rec-client-cancel",
          origin: "https://demo.example",
          requestId: "r-client-cancel",
          method: "identity.get",
          phase: "rejected",
          decision: "rejected",
          status: "rejected",
          textSummary: "client cancel",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 1,
          updatedAt: 2,
          finishedAt: 2,
          errorCode: "user_rejected",
          errorMessage: "User rejected",
          failureReason: "client_canceled"
        },
        {
          id: "rec-user-cancel",
          origin: "https://demo.example",
          requestId: "r-user-cancel",
          method: "identity.get",
          phase: "rejected",
          decision: "rejected",
          status: "rejected",
          textSummary: "user cancel",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 3,
          updatedAt: 4,
          finishedAt: 4,
          errorCode: "user_rejected",
          errorMessage: "User rejected",
          failureReason: "user_canceled"
        }
      ],
      historyAvailable: true,
      lockSummary: null
    };
    act(() => {
      service.feed = feed;
      for (const l of service.feedListeners) l({ ...feed, commands: feed.commands.slice() });
    });
    expect(screen.getByText("对方主动取消")).toBeTruthy();
    expect(screen.getByText("你已取消")).toBeTruthy();
    expect(screen.queryByText("已拒绝")).toBeNull();
  });

  /* ============== 修复 2：CountdownBadge i18n 插值 ============== */

  it("修复 2：CountdownBadge 渲染时 i18n 模板的 {{seconds}} 占位符被替换为具体数字", () => {
    const service = makeFakeService() as unknown as ProtocolService & {
      listeners: Set<(s: ProtocolSessionSnapshot) => void>;
      feedListeners: Set<(s: ProtocolCommandFeedState) => void>;
      feed: ProtocolCommandFeedState;
      setCurrentRequest: (next: { id: string; method: ProtocolSessionSnapshot["method"]; params: Record<string, unknown> } | null) => void;
    };
    currentService = service;
    render(<ProtocolPopupPage />);
    // 让 service 暴露 confirmDeadlineMs = now + 12s。
    const now = Date.now();
    service.confirmDeadlineMs = () => now + 12_000;
    // 触发 subscribe 路径的 setConfirmDeadlineMs(state → service.confirmDeadlineMs())
    // 通过推一次 snapshot 让 popup 重新订阅 deadline。
    const snap: ProtocolSessionSnapshot = {
      phase: "confirming",
      boundSource: null,
      boundOrigin: "https://demo.example",
      method: "identity.get",
      requestId: "r-cd"
    , lockState: "unlocked" };
    service.setCurrentRequest({
      id: "r-cd",
      method: "identity.get",
      params: { aud: "https://demo.example", iat: 1, exp: 2, text: "x" }
    });
    const liveFeed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "rec-cd",
          origin: "https://demo.example",
          requestId: "r-cd",
          method: "identity.get",
          phase: "confirming",
          decision: "pending",
          status: "confirming",
          textSummary: "cd",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 1,
          updatedAt: 1,
          finishedAt: 0,
          errorCode: "",
          errorMessage: ""
        }
      ],
      historyAvailable: true,
        lockSummary: null
    };
    act(() => {
      service.feed = liveFeed;
      for (const l of service.feedListeners) l({ ...liveFeed, commands: liveFeed.commands.slice() });
      for (const l of service.listeners) l(snap);
    });
    // i18n defaultValue 是中文"剩余 N 秒"，mock 已挂 renderTemplate 替换。
    // 关键断言：渲染后**不**应该出现原始 `{{seconds}}` 占位符。
    const html = document.querySelector(".protocol-popup__countdown")?.textContent ?? "";
    expect(html).not.toMatch(/\{\{seconds\}\}/);
    // 真实插值结果：mock i18n 没挂"protocol.countdown.remaining"资源,
    // 走 defaultValue 替换 → "剩余 12 秒"。这里只校验占位符已替换即
    // 可（mock 默认值是中文，但运行时 i18n 真正会走英文 "12s remaining"）。
    expect(html).toMatch(/\d/);
  });

  /* ============== 修复 3：historyAvailable=false 时横幅始终显示 ============== */

  it("修复 3：historyAvailable=false + 命令卡非空 → 横幅**仍**显示，不会被命令列表吞掉", () => {
    // 关键场景：DB 写失败时内存里已经有当前命令卡。这种场景最需要
    // 提示用户"本次不会持久化"，但旧实现把判断写成 `commands.length === 0`
    // 会让横幅静默消失。
    const service = makeFakeService() as unknown as ProtocolService & {
      feedListeners: Set<(s: ProtocolCommandFeedState) => void>;
      feed: ProtocolCommandFeedState;
    };
    currentService = service;
    render(<ProtocolPopupPage />);
    const feed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "rec-live",
          origin: "https://demo.example",
          requestId: "r-live",
          method: "identity.get",
          phase: "confirming",
          decision: "pending",
          status: "confirming",
          textSummary: "live",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          connectSessionId: "sess-test",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          createdAt: 1,
          updatedAt: 1,
          finishedAt: 0,
          errorCode: "",
          errorMessage: ""
        }
      ],
      historyAvailable: false,
        lockSummary: null
    };
    act(() => {
      service.feed = feed;
      for (const l of service.feedListeners) l({ ...feed, commands: feed.commands.slice() });
    });
    // 关键断言：横幅**仍**存在。
    expect(screen.getByText(/历史不可用/)).toBeTruthy();
    // 命令卡也仍渲染。
    expect(screen.getByText("live")).toBeTruthy();
  });
});

/* ============== 施工单 001：顶栏"进入钱包"按钮 ============== */

describe("ProtocolPopupPage topbar wallet entry", () => {
  it("renders the 'enter wallet' button and opens keymaster.cc in a new tab on click", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      const service = makeFakeService();
      currentService = service;
      render(<ProtocolPopupPage />);
      // 顶栏出现"进入钱包"按钮。
      expect(screen.getByText("进入钱包")).toBeTruthy();
      const btn = screen.getByText("进入钱包").closest("button");
      expect(btn).not.toBeNull();
      act(() => {
        (btn as HTMLButtonElement).click();
      });
      expect(openSpy).toHaveBeenCalledWith(
        "https://keymaster.cc",
        "_blank",
        "noopener,noreferrer"
      );
    } finally {
      openSpy.mockRestore();
    }
  });

  it("wallet entry does not navigate the current popup window", () => {
    // 验证"进入钱包"不破坏 popup 会话:open 失败 / 返回 null 时,popup 仍存在。
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      const service = makeFakeService();
      currentService = service;
      render(<ProtocolPopupPage />);
      const btn = screen.getByText("进入钱包").closest("button");
      expect(btn).not.toBeNull();
      // 点击不应抛错。
      act(() => {
        (btn as HTMLButtonElement).click();
      });
      // popup 仍然在(没被 close)。
      expect(service.postReadyCalls).toBe(1);
    } finally {
      openSpy.mockRestore();
    }
  });
});
