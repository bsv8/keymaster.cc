// packages/plugin-webrtc/src/WebrtcPage.test.tsx
// 工作台页面：接听后必须从 incoming UI 切到 connecting UI。

import React from "react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WebrtcPage } from "./WebrtcPage.js";
import { WEBRTC_SERVICE_CAPABILITY } from "./constants.js";
import type {
  StunDiagnosticResult,
  WebrtcService,
  WebrtcSessionSnapshot
} from "./webrtcService.js";

interface ActiveTestService {
  service: WebrtcService;
}

const activeTestService: ActiveTestService = {
  service: undefined as unknown as WebrtcService
};

vi.mock("@keymaster/runtime", async () => {
  const actual =
    await vi.importActual<typeof import("@keymaster/runtime")>("@keymaster/runtime");
  return {
    ...actual,
    useCapability: <T,>(_key: string): T =>
      activeTestService.service as unknown as T,
    usePluginHost: () => ({ resourceStore: {} }),
    useResource: () => {
      const service = activeTestService.service;
      const snapshot = useSyncExternalStore(service.subscribe, service.snapshot, service.snapshot);
      return { data: snapshot };
    },
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

function createSnapshot(partial: Partial<WebrtcSessionSnapshot>): WebrtcSessionSnapshot {
  return {
    phase: "idle",
    remotePublicKeyHex: null,
    direction: null,
    mode: null,
    hasLocalStream: false,
    hasRemoteStream: false,
    remoteNotice: null,
    serviceReady: true,
    lastError: null,
    ...partial
  };
}

function makeFakeService(): {
  service: WebrtcService;
  setSnapshot(next: WebrtcSessionSnapshot): void;
} {
  let current = createSnapshot({
    phase: "incoming",
    direction: "incoming",
    mode: "audio",
    remotePublicKeyHex: "02cccc".padEnd(66, "c"),
    hasLocalStream: true
  });
  const subs = new Set<(s: WebrtcSessionSnapshot) => void>();

  function setSnapshot(next: WebrtcSessionSnapshot): void {
    current = next;
    for (const h of subs) h(current);
  }

  const service: WebrtcService = {
    snapshot: () => current,
    subscribe: (handler) => {
      subs.add(handler);
      handler(current);
      return () => {
        subs.delete(handler);
      };
    },
    isReady: () => true,
    startCall: vi.fn(async () => undefined),
    acceptIncoming: vi.fn(async () => {
      setSnapshot(
        createSnapshot({
          phase: "connecting",
          direction: "incoming",
          mode: "audio",
          remotePublicKeyHex: "02cccc".padEnd(66, "c"),
          hasLocalStream: true
        })
      );
    }),
    rejectIncoming: vi.fn(async () => undefined),
    hangup: vi.fn(async () => undefined),
    listHistoryForPeer: vi.fn(async () => []),
    getTransferBlob: vi.fn(async () => null),
    sendImage: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => undefined),
    consumeRemoteNotice: vi.fn(() => undefined),
    attachToVideo: vi.fn(() => () => undefined),
    runStunDiagnostics: vi.fn(async (): Promise<StunDiagnosticResult[]> => []),
    getStunServers: vi.fn(() => ["stun:stun.l.google.com:19302"]),
    applyStunServers: vi.fn(async () => undefined),
    dispose: vi.fn(() => undefined)
  };

  return { service, setSnapshot };
}

describe("WebrtcPage", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it("accept click hides incoming card after phase becomes connecting", async () => {
    const fake = makeFakeService();
    activeTestService.service = fake.service;

    render(<WebrtcPage />);

    expect(screen.getByText("Accept")).toBeTruthy();
    expect(screen.getByText("Decline")).toBeTruthy();

    fireEvent.click(screen.getByText("Accept"));

    await waitFor(() => {
      expect(vi.mocked(fake.service.acceptIncoming).mock.calls.length).toBe(1);
    });

    await waitFor(() => {
      expect(screen.queryByText("Accept")).toBeNull();
      expect(screen.queryByText("Decline")).toBeNull();
    });
  });
});
