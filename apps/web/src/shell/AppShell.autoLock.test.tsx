// apps/web/src/shell/AppShell.autoLock.test.tsx
// 验证 AppShell 的自动锁定生命周期。
//
// 关键不变量：
//   - unlocked 后 5 分钟无活动会调用 vault.lock()；
//   - 用户活动应重置计时器，避免误锁。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import type {
  ActiveKeyState,
  KeyspaceService,
  VaultService,
  VaultStatus
} from "@keymaster/contracts";
import { SHELL_RESOURCES } from "../i18n/resources.js";
import { AppShell } from "./AppShell.js";

const OWNER = "02".padEnd(66, "a");
let visibilityState: DocumentVisibilityState = "visible";

function setVisibilityState(state: DocumentVisibilityState): void {
  visibilityState = state;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState
  });
}

function makeVault(lockSpy = vi.fn(async () => undefined)): VaultService & {
  lock: typeof lockSpy;
} {
  const statusHandlers = new Set<(status: VaultStatus) => void>();
  return {
    status: () => "unlocked",
    onStatusChange: (handler: (status: VaultStatus) => void) => {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    getInitialActivationNotice: () => null,
    clearInitialActivationNotice: () => undefined,
    onInitialActivationNoticeChange: () => () => undefined,
    hasVault: async () => true,
    lock: lockSpy,
    recoverEmptyVaultToUninitialized: async () => undefined
  } as unknown as VaultService & { lock: typeof lockSpy };
}

function makeKeyspace(): KeyspaceService {
  return {
    active: () => ({ activePublicKeyHex: OWNER } satisfies ActiveKeyState),
    onActiveChange: (_handler: (state: ActiveKeyState) => void) => () => undefined,
    listKeys: async () => []
  } as unknown as KeyspaceService;
}

function createHost(vault: VaultService) {
  const host = createPluginHost({
    disableConfigPersistence: true,
    initialI18nResources: [SHELL_RESOURCES]
  });
  host.capabilities.provide<VaultService>("vault.service", vault);
  host.capabilities.provide<KeyspaceService>("keyspace.service", makeKeyspace());
  host.routes.register({
    id: "test.home",
    path: "/",
    label: { key: "test.home", fallback: "Home" },
    component: () => <div data-testid="home-route">Home route</div>
  });
  return host;
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibilityState("visible");
  if (typeof window.matchMedia === "function") return;
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        media: query,
        matches: false,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false
      }) as MediaQueryList
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.pushState({}, "", "/");
});

describe("AppShell auto-lock", () => {
  it("locks after 5 minutes of inactivity", async () => {
    const lock = vi.fn(async () => undefined);
    const vault = makeVault(lock);
    const host = createHost(vault);

    render(
      <PluginHostProvider host={host}>
        <AppShell />
      </PluginHostProvider>
    );

    expect(document.querySelector("[data-testid='home-route']")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59 * 1000);
    expect(lock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it("resets the idle timer on user activity", async () => {
    const lock = vi.fn(async () => undefined);
    const vault = makeVault(lock);
    const host = createHost(vault);

    render(
      <PluginHostProvider host={host}>
        <AppShell />
      </PluginHostProvider>
    );

    expect(document.querySelector("[data-testid='home-route']")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    fireEvent.pointerDown(window);
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59 * 1000);
    expect(lock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it("reschedules the idle timer when the document becomes visible again", async () => {
    const lock = vi.fn(async () => undefined);
    const vault = makeVault(lock);
    const host = createHost(vault);

    render(
      <PluginHostProvider host={host}>
        <AppShell />
      </PluginHostProvider>
    );

    expect(document.querySelector("[data-testid='home-route']")).toBeTruthy();

    setVisibilityState("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59 * 1000);
    expect(lock).not.toHaveBeenCalled();

    setVisibilityState("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59 * 1000);
    expect(lock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(lock).toHaveBeenCalledTimes(1);
  });
});
