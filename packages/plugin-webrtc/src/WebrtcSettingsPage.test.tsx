// packages/plugin-webrtc/src/WebrtcSettingsPage.test.tsx
// 设置页：blur 自动保存 / 非法回滚 / 删除 / 批量测试。
//
// 说明：本测试使用一个轻量级 in-memory 渲染宿主，避免复杂 plugin host 装配。
// 我们走 `@keymaster/runtime` 的 `useCapability` 实现 mock；service 通过
// globalThis 注入。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent, screen, waitFor } from "@testing-library/react";
import { WebrtcSettingsPage } from "./WebrtcSettingsPage.js";
import { createMemoryWebrtcConfigStore } from "./webrtcConfig.js";
import { WEBRTC_SERVICE_CAPABILITY } from "./constants.js";
import type {
  StunDiagnosticResult,
  WebrtcService
} from "./webrtcService.js";

interface ActiveTestService {
  service: WebrtcService;
  applied: string[] | null;
}

const activeTestService: ActiveTestService = {
  service: undefined as unknown as WebrtcService,
  applied: null
};

function makeFakeService(
  initial: { stunServers: string[] },
  overrides: Partial<WebrtcService> = {}
): WebrtcService {
  let cfg = { stunServers: [...initial.stunServers] };
  const subs: Array<(c: { stunServers: string[] }) => void> = [];
  const fake: WebrtcService = {
    isReady: () => true,
    snapshot: () => ({
      phase: "idle",
      remotePublicKeyHex: null,
      direction: null,
      mode: null,
      hasLocalStream: false,
      hasRemoteStream: false,
      remoteNotice: null,
      serviceReady: true,
      lastError: null
    }),
    subscribe: (h) => {
      h(fake.snapshot());
      subs.push(h as never);
      return () => undefined;
    },
    startCall: vi.fn(async () => undefined),
    acceptIncoming: vi.fn(async () => undefined),
    rejectIncoming: vi.fn(async () => undefined),
    hangup: vi.fn(async () => undefined),
    consumeRemoteNotice: () => undefined,
    runStunDiagnostics: async (): Promise<StunDiagnosticResult[]> => [],
    getStunServers: () => cfg.stunServers.slice(),
    applyStunServers: async (input) => {
      cfg = { stunServers: [...input] };
      activeTestService.applied = [...input];
      for (const s of subs) s({ stunServers: [...cfg.stunServers] });
    },
    attachToVideo: (_direction: "local" | "remote", _videoEl: HTMLVideoElement) => {
      return () => undefined;
    },
    dispose: () => undefined,
    ...overrides
  };
  return fake;
}

vi.mock("@keymaster/runtime", async () => {
  const actual =
    await vi.importActual<typeof import("@keymaster/runtime")>("@keymaster/runtime");
  return {
    ...actual,
    useCapability: <T,>(_key: string): T =>
      activeTestService.service as unknown as T,
    useI18n: () => ({
      t: (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? _key,
      text: (input: unknown) =>
        typeof input === "string"
          ? input
          : (input as { fallback?: string })?.fallback ?? "",
      language: () => "en" as const,
      mode: () => "manual" as const,
      setLanguage: async () => undefined,
      setAuto: async () => undefined
    })
  };
});

describe("WebrtcSettingsPage", () => {
  beforeEach(() => {
    cleanup();
    activeTestService.applied = null;
  });
  afterEach(() => cleanup());

  it("renders STUN inputs and bound config", () => {
    activeTestService.service = makeFakeService({
      stunServers: ["stun:stun.l.google.com:19302"]
    });
    render(<WebrtcSettingsPage />);
    expect(screen.getByDisplayValue("stun:stun.l.google.com:19302")).toBeTruthy();
  });

  it("blur-save persists to service.applyStunServers", async () => {
    activeTestService.service = makeFakeService(
      { stunServers: ["stun:stun.l.google.com:19302"] },
      {
        applyStunServers: async (xs) => {
          activeTestService.applied = [...xs];
        }
      }
    );
    render(<WebrtcSettingsPage />);
    const input = screen.getAllByDisplayValue("stun:stun.l.google.com:19302")[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "stun:new.example.com:3478" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(activeTestService.applied).not.toBeNull();
    });
    expect(activeTestService.applied).toEqual(["stun:new.example.com:3478"]);
  });

  it("invalid URL on blur triggers rollback and does not apply", async () => {
    activeTestService.service = makeFakeService(
      { stunServers: ["stun:stun.l.google.com:19302"] },
      {
        applyStunServers: async (xs) => {
          activeTestService.applied = [...xs];
        }
      }
    );
    render(<WebrtcSettingsPage />);
    const input = screen.getAllByDisplayValue("stun:stun.l.google.com:19302")[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "turn:bad.example.com:3478" } });
    fireEvent.blur(input);
    await new Promise((r) => setTimeout(r, 50));
    expect(activeTestService.applied).toBeNull();
  });

  it("remove row updates list", async () => {
    activeTestService.service = makeFakeService(
      { stunServers: ["stun:a.example.com:3478", "stun:b.example.com:3478"] },
      {
        applyStunServers: async (xs) => {
          activeTestService.applied = [...xs];
        }
      }
    );
    render(<WebrtcSettingsPage />);
    const removeBtns = screen.getAllByLabelText("Remove");
    fireEvent.click(removeBtns[0]!);
    await waitFor(() => {
      expect(activeTestService.applied).not.toBeNull();
    });
    expect(activeTestService.applied).toEqual(["stun:b.example.com:3478"]);
  });

  it("Test all STUN runs diagnostics and renders rows", async () => {
    activeTestService.service = makeFakeService(
      { stunServers: ["stun:a.example.com:3478", "stun:b.example.com:3478"] },
      {
        runStunDiagnostics: async (): Promise<StunDiagnosticResult[]> => [
          { url: "stun:a.example.com:3478", status: "ok" },
          { url: "stun:b.example.com:3478", status: "timeout" }
        ]
      }
    );
    render(<WebrtcSettingsPage />);
    const buttons = screen.getAllByText("Test all STUN");
    fireEvent.click(buttons[0]!);
    await waitFor(() => {
      expect(screen.getAllByText("stun:a.example.com:3478").length).toBeGreaterThan(0);
    });
  });
});
