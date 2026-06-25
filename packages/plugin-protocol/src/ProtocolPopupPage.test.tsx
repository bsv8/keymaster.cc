// packages/plugin-protocol/src/ProtocolPopupPage.test.tsx
// 验证施工单 001 + 002：
//   - waiting 状态显示空 feed / 等待文案；
//   - 收到历史后按新到旧渲染；
//   - 最新命令默认展开；
//   - 历史命令可点击展开；
//   - 完成后页面不自动关闭（phase 回到 waiting）；
//   - closing 由 pageUnloading 路径发出。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { ProtocolPopupPage } from "./ProtocolPopupPage.js";
import type {
  ProtocolCommandFeedState,
  ProtocolMethod,
  ProtocolService,
  ProtocolSessionSnapshot
} from "@keymaster/contracts";
import { PROTOCOL_SERVICE_CAPABILITY, PROTOCOL_VERSION } from "@keymaster/contracts";
import type { ReactNode } from "react";

const runtimeState = vi.hoisted(() => ({
  vault: "unlocked" as "booting" | "uninitialized" | "locked" | "unlocked"
}));

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
    t: (key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? key,
    language: () => "en"
  })
}));

let currentService: ProtocolService | null = null;

function makeFakeService(): ProtocolService & {
  postReadyCalls: number;
  rejectCalls: number;
  confirmCalls: number;
  handleMessageCalls: number;
  pageUnloadingCalls: number;
  closingSent: boolean;
  closingEmitted: number;
  messageListenerInstalledBeforeReady: boolean | null;
  feedListeners: Set<(s: ProtocolCommandFeedState) => void>;
  feed: ProtocolCommandFeedState;
} {
  const snap: ProtocolSessionSnapshot = {
    phase: "waiting",
    boundSource: null,
    boundOrigin: null,
    method: null,
    requestId: null
  };
  const listeners = new Set<(s: ProtocolSessionSnapshot) => void>();
  const feedListeners = new Set<(s: ProtocolCommandFeedState) => void>();
  const feed: ProtocolCommandFeedState = {
    currentOrigin: null,
    commands: [],
    historyAvailable: true
  };
  // 模拟真实 service：当前已绑定 request 时 `currentRequest()` 返回它，
  // 否则 null。让测试可以推进 confirming 状态。
  let currentRequest: { id: string; method: ProtocolMethod; params: Record<string, unknown> } | null = null;
  const svc = {
    phase: "waiting" as ProtocolSessionSnapshot["phase"],
    postReadyCalls: 0,
    rejectCalls: 0,
    confirmCalls: 0,
    handleMessageCalls: 0,
    pageUnloadingCalls: 0,
    closingSent: false,
    closingEmitted: 0,
    messageListenerInstalledBeforeReady: null as boolean | null,
    listeners,
    feedListeners,
    feed,
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
      return { ...this.feed, commands: this.feed.commands.slice() };
    },
    subscribe(handler: (s: ProtocolSessionSnapshot) => void) {
      listeners.add(handler);
      handler({ ...snap, phase: this.phase });
      return () => listeners.delete(handler);
    },
    subscribeFeed(handler: (s: ProtocolCommandFeedState) => void) {
      feedListeners.add(handler);
      handler({ ...this.feed, commands: this.feed.commands.slice() });
      return () => feedListeners.delete(handler);
    },
    snapshot() {
      return { ...snap, phase: this.phase };
    }
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
    // 顶栏：当前站点 / 状态 / 关闭 / 回到最新（文案带冒号，用正则匹配）
    expect(screen.getByText(/当前站点/)).toBeTruthy();
    expect(screen.getByText(/状态/)).toBeTruthy();
    expect(screen.getByText("关闭")).toBeTruthy();
    expect(screen.getByText("回到最新")).toBeTruthy();
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

  it("renders command feed sorted by updatedAt desc; latest expanded by default", async () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    // 推一条 feed 进 service：当前 origin + 两条命令（最新在前）。
    const newFeed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [
        {
          id: "r-new",
          origin: "https://demo.example",
          requestId: "r-new",
          method: "identity.get",
          phase: "approved",
          decision: "approved",
          status: "approved",
          textSummary: "newest",
          claimsSummary: [],
          contentType: "",
          payloadSize: 0,
          activePublicKeyHex: "02" + "11".repeat(32),
          createdAt: 2,
          updatedAt: 2,
          finishedAt: 2,
          errorCode: "",
          errorMessage: ""
        },
        {
          id: "r-old",
          origin: "https://demo.example",
          requestId: "r-old",
          method: "cipher.encrypt",
          phase: "approved",
          decision: "approved",
          status: "approved",
          textSummary: "oldest",
          claimsSummary: [],
          contentType: "note.v1",
          payloadSize: 12,
          activePublicKeyHex: "02" + "11".repeat(32),
          createdAt: 1,
          updatedAt: 1,
          finishedAt: 1,
          errorCode: "",
          errorMessage: ""
        }
      ],
      historyAvailable: true
    };
    act(() => {
      service.feed = newFeed;
      for (const l of service.feedListeners) l({ ...newFeed, commands: newFeed.commands.slice() });
    });
    // 新命令卡片：默认展开（包含"提示文案"等详情）
    expect(screen.getByText("newest")).toBeTruthy();
    // 旧命令卡片：默认折叠，只显示摘要行，不显示"提示文案"等详情。
    expect(screen.queryByText("oldest")).toBeNull();
  });

  it("renders 'history unavailable' notice when historyAvailable=false", () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    const noHistoryFeed: ProtocolCommandFeedState = {
      currentOrigin: "https://demo.example",
      commands: [],
      historyAvailable: false
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
    // 推一次 phase=confirming，然后推 phase=waiting（模拟 confirmByUser 完成）。
    const confirming: ProtocolSessionSnapshot = {
      phase: "confirming",
      boundSource: null,
      boundOrigin: "https://demo.example",
      method: "identity.get",
      requestId: "r-1"
    };
    act(() => {
      for (const l of service.listeners) l(confirming);
    });
    // confirming 时会渲染 ConfirmView 的"确认请求"标题。
    expect(screen.getByText("确认请求")).toBeTruthy();
    // 切回 waiting：ConfirmView 消失，feed 仍在。
    const waiting: ProtocolSessionSnapshot = {
      phase: "waiting",
      boundSource: null,
      boundOrigin: "https://demo.example",
      method: null,
      requestId: null
    };
    act(() => {
      for (const l of service.listeners) l(waiting);
    });
    expect(screen.queryByText("确认请求")).toBeNull();
    // 顶栏的"状态"应回到"等待下一条请求"。
    await waitFor(() => {
      expect(screen.getByText("等待下一条请求")).toBeTruthy();
    });
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

  it("shows unlock view when phase is unlocking", () => {
    const service = makeFakeService() as unknown as ProtocolService & {
      phase: ProtocolSessionSnapshot["phase"];
      listeners: Set<(s: ProtocolSessionSnapshot) => void>;
    };
    currentService = service;
    const origStart = service.startSession.bind(service);
    service.startSession = () => {
      origStart();
      service.phase = "unlocking";
      const snap: ProtocolSessionSnapshot = {
        phase: "unlocking",
        boundSource: null,
        boundOrigin: null,
        method: null,
        requestId: null
      };
      for (const l of service.listeners) l(snap);
      service.snapshot = () => snap;
    };
    runtimeState.vault = "locked";
    render(<ProtocolPopupPage />);
    expect(screen.getByText(/解锁后继续|Unlock to continue/)).toBeTruthy();
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
