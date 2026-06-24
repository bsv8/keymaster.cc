// packages/plugin-protocol/src/ProtocolPopupPage.test.tsx
// 验证施工单 001：ProtocolPopupPage 的 UI 行为。
//   - 等待 request；
//   - 锁定态显示解锁；
//   - 确认页展示来源/文案/claims/contentType；
//   - 用户拒绝返回 user_rejected；
//   - 完成后触发关闭流程（sending ready + waiting state）。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { ProtocolPopupPage } from "./ProtocolPopupPage.js";
import type { ProtocolService, ProtocolSessionSnapshot } from "@keymaster/contracts";
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
  /**
   * service 内部"本会话是否已发出过 closing"的幂等门禁镜像。
   * ProtocolPopupPage 在页面卸载路径调 pageUnloading()，但 service
   * 自己已经在 replyResult / replyError 发过 closing 时，pageUnloading()
   * 必须 no-op —— 由 service 内部门禁短路。这里用 `closingEmitted` 计数，
   * 让测试能区分"被调用的次数"与"实际触发 closing 的次数"。
   */
  closingSent: boolean;
  closingEmitted: number;
  /**
   * 测试钩子：模拟 service 内"在 startSession 之前"被外部读取过监听状态。
   * ProtocolPopupPage 必须保证 addEventListener('message') 在 startSession
   * 之前调用 —— startSession 会立刻发 ready，opener 收到 ready 后会回 request，
   * 此时如果监听未挂好，首条 request 会丢。本钩子让测试断言这个顺序。
   */
  messageListenerInstalledBeforeReady: boolean | null;
} {
  const snap: ProtocolSessionSnapshot = {
    phase: "waiting",
    boundSource: null,
    boundOrigin: null,
    method: null,
    requestId: null
  };
  const listeners = new Set<(s: ProtocolSessionSnapshot) => void>();
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
    // 暴露内部 listener 集合，让测试能在 startSession 之后补 emit，
    // 而不必依赖 subscribe 与 startSession 的相对顺序。
    listeners,
    startSession() {
      this.phase = "waiting";
      this.postReadyCalls++;
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
      // 模拟真实 service 的幂等门禁：已经发过 closing 就短路，不再触发。
      if (this.closingSent) return;
      this.closingSent = true;
      this.closingEmitted++;
    },
    async confirmByUser() {
      this.confirmCalls++;
    },
    async rejectByUser() {
      this.rejectCalls++;
      this.phase = "closing";
      // 模拟真实 service：replyError 路径发完 result 后立刻发 closing。
      if (!this.closingSent) {
        this.closingSent = true;
        this.closingEmitted++;
      }
      for (const l of listeners) l({ ...snap, phase: this.phase });
    },
    resumeAfterUnlock() {
      this.phase = "confirming";
      for (const l of listeners) l({ ...snap, phase: this.phase });
    },
    currentRequest() {
      return null;
    },
    subscribe(handler: (s: ProtocolSessionSnapshot) => void) {
      listeners.add(handler);
      handler({ ...snap, phase: this.phase });
      return () => listeners.delete(handler);
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
  it("shows waiting view and calls startSession on mount", () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    expect(service.postReadyCalls).toBe(1);
    // 等待 view 渲染：与 WaitingView 中的 PageHeader title 一致。
    expect(screen.getByText("等待外部站点请求")).toBeTruthy();
  });

  it("registers window message listener before startSession sends ready", () => {
    // 施工单 001 公共语义：ready 只能在监听安装完成后发出。
    // 这里用 startSession spy 触发时记录"addEventListener 是否已被调用"
    // 来锁定顺序约束。
    const order: string[] = [];
    const service = makeFakeService();
    service.startSession = () => {
      order.push(`ready_at_${service.postReadyCalls}`);
      // 此时检查 window 上是否已有 message 监听。
      // 由于 React Testing Library 在 render 时同步触发了 useEffect，
      // 并且我们刚刚在测试里劫持了 startSession，按修复后的实现顺序，
      // addEventListener('message') 应当已经执行过。
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
      startSession: () => void;
      /**
       * 暴露 fake 内部的 listener 集合，让 override 在 startSession 之后再补
       * 一次 phase=unlocking 的 emit —— 与 startSession 和 subscribe 的相对
       * 顺序无关。这是测试稳定性的关键：旧实现里 startSession 在 subscribe
       * 之前，subscribe 立即拿到当前 phase；新实现里反过来。新测试只信任
       * listener 集合的最终推送，不依赖实现顺序。
       */
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
      // 推一次 phase=unlocking 给 React；无论 subscribe 在前还是在后，
      // 这次 emit 都会被 React 看到。
      for (const l of service.listeners) l(snap);
      service.snapshot = () => snap;
    };
    runtimeState.vault = "locked";
    render(<ProtocolPopupPage />);
    // 解锁 view：包含"解锁后继续"或"Unlock to continue"
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
    // 模拟真实场景：service 在 replyResult / replyError 路径已经发过 closing，
    // 然后用户在确认页直接关闭 popup，触发 pagehide → pageUnloading。
    // service 内部门禁应短路，页面层不再产生第二次 closing。
    const service = makeFakeService();
    // 提前标记 service 已通过 replyResult 等路径发过 closing。
    service.closingSent = true;
    service.closingEmitted = 1;
    currentService = service;
    render(<ProtocolPopupPage />);
    window.dispatchEvent(new Event("pagehide"));
    // 页面层仍然调用了 pageUnloading（监听到了 pagehide）。
    expect(service.pageUnloadingCalls).toBe(1);
    // 但 closing 实际发出次数仍是 1，没有变成 2。
    expect(service.closingEmitted).toBe(1);
  });

  it("renders DoneView when service phase becomes closing", () => {
    // 验证 popup 正常结束后会进入 DoneView，自动 window.close() 才能挂上。
    // 这条修复的关键约束：service 必须**先**发 result + closing，再把 phase
    // 推到 closing；不能调 endSession() 把 phase 重置回 waiting，否则
    // React 会用 waiting 覆盖 closing 推送，DoneView 永远不渲染。
    const service = makeFakeService() as unknown as ProtocolService & {
      listeners: Set<(s: ProtocolSessionSnapshot) => void>;
    };
    currentService = service;
    render(<ProtocolPopupPage />);
    // 模拟 replyResult 完成：推一次 phase=closing 给所有 subscriber。
    // setSnap 必须在 act() 内同步刷新 React 状态，否则 getByText 拿到的是
    // 上一帧的 waiting 视图。
    const closingSnap: ProtocolSessionSnapshot = {
      phase: "closing",
      boundSource: null,
      boundOrigin: null,
      method: null,
      requestId: null
    };
    act(() => {
      for (const l of service.listeners) l(closingSnap);
    });
    // DoneView 渲染包含 "结果已回传" 标题。
    expect(screen.getByText("结果已回传")).toBeTruthy();
  });
});

/**
 * 检测 window 上是否已挂 message 监听。jsdom 不直接暴露"是否已注册监听"，
 * 但 addEventListener('message') 会触发现有监听 —— 所以最稳的方式是
 * 派发一条事件并记录 listener 是否被调用过。
 *
 * 测试里我们在 render 前 hook 进 startSession，在 startSession 执行前
 * 派发一条 test-only message，看是否有监听响应：
 *   - 若 ProtocolPopupPage 已经 addEventListener('message', ...) → 派发
 *     后 handleMessageCalls 自增 → 返回 true；
 *   - 否则监听未挂 → 返回 false。
 *
 * 必须在每条用例之间重置计数。
 */
let probeHandleMessageCalls = 0;
function messageListenerInstalledForTest(): boolean {
  const before = probeHandleMessageCalls;
  window.dispatchEvent(new MessageEvent("message", { data: { probe: true } }));
  const after = probeHandleMessageCalls;
  // 探测事件本身不计入业务 handleMessageCalls，避免污染其它用例。
  // 直接判断 after > before：ProtocolPopupPage 注册的 onMessage 会调
  // service.handleMessage 让 handleMessageCalls 自增。
  return after > before;
}
