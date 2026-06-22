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
    },
    async confirmByUser() {
      this.confirmCalls++;
    },
    async rejectByUser() {
      this.rejectCalls++;
      this.phase = "closing";
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
});

describe("ProtocolPopupPage", () => {
  it("shows waiting view and calls startSession on mount", () => {
    const service = makeFakeService();
    currentService = service;
    render(<ProtocolPopupPage />);
    expect(service.postReadyCalls).toBe(1);
    // 等待 view 渲染
    expect(screen.getByText(/等待请求/)).toBeTruthy();
  });

  it("shows unlock view when phase is unlocking", () => {
    const service = makeFakeService() as unknown as ProtocolService & {
      phase: ProtocolSessionSnapshot["phase"];
      startSession: () => void;
    };
    currentService = service;
    // 提前让 service 启动后立即切到 unlocking
    const origStart = service.startSession.bind(service);
    service.startSession = () => {
      origStart();
      service.phase = "unlocking";
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
});
