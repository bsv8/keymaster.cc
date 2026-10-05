import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { bindTestVaultUi, createVaultTestHost as createPluginHost } from "./vaultUi.testSupport.js";
// apps/web/src/shell/AppShell.autoLock.test.tsx
// 验证 AppShell 的自动锁定生命周期。
//
// 关键不变量：
//   - unlocked 后 5 分钟无活动会调用 vault.lock()；
//   - 用户活动应重置计时器，避免误锁。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import type {
  VaultLifecycleSnapshot,
  VaultWalletState,
  VaultService,
  VaultStatus
} from "@keymaster/contracts";
import {
  COORDINATOR_ACTIVITY_CAPABILITY,
  VAULT_WALLET_STATE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
} from "@keymaster/contracts";
import { SHELL_TEST_RESOURCES as SHELL_RESOURCES } from "@keymaster/runtime/test-support";
import { VaultWalletGuard } from "./VaultWalletGuard.js";

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
  const lifecycleHandlers = new Set<(snapshot: { status: VaultStatus }) => void>();
  return {
    status: () => "unlocked",
    walletSnapshot: () => ({ status: "unlocked" as const, sessionEpoch: "test-epoch", vaultLifecycleRevision: 1 }),
    subscribeWalletState: (handler: (snapshot: { status: VaultStatus }) => void) => { lifecycleHandlers.add(handler); return () => lifecycleHandlers.delete(handler); },
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

function makeWalletState(): VaultWalletState {
  return {
    snapshot: () => walletStateFixtureSnapshot((() => ({ activePublicKeyHex: OWNER }))()),
    subscribe: (_handler: (state: VaultLifecycleSnapshot) => void) => () => undefined,
    listKeys: async () => []
  } as unknown as VaultWalletState;
}

async function createHost(vault: VaultService, sendActivity = vi.fn()) {
  const host = createPluginHost({

    initialI18nResources: [SHELL_RESOURCES]
  });
  host.provide(VAULT_SERVICE_CAPABILITY, vault);
  host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(makeWalletState()));
  host.provide(COORDINATOR_ACTIVITY_CAPABILITY, {
    getIsConnected: () => true,
    sendActivity
  });
  host.routes.register({
    id: "test.home",
    path: "/",
    label: { key: "test.home", fallback: "Home" },
    component: () => <div data-testid="home-route">Home route</div>
  });
  const Bound = await bindTestVaultUi(host, VaultWalletGuard, resources => {
    resources.register({ id: "vault.key-state", scope: "global", key: () => ["key-state"], load: async () => ({ status: vault.status() }), invalidation: "immediate" });
    resources.register({ id: "vault.wallet-guard", scope: "global", key: () => ["guard"], load: async () => ({ kind: "normal" }), invalidation: "immediate" });
  });
  host.resourceStore.ensure("vault.wallet-guard", []);
  host.resourceStore.ensure("vault.key-state", []);
  await vi.advanceTimersByTimeAsync(0);
  const Guard = () => <Bound sendActivity={sendActivity}><div data-testid="home-route">Home route</div></Bound>;
  return { host, Guard };
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
  it("does not perform a tab-local lock after inactivity", async () => {
    const lock = vi.fn(async () => undefined);
    const vault = makeVault(lock);
    const { host, Guard } = await createHost(vault);

    render(
      <PluginHostProvider host={host}>
        <Guard />
      </PluginHostProvider>
    );

    expect(document.querySelector("[data-testid='home-route']")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59 * 1000);
    expect(lock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(lock).not.toHaveBeenCalled();
  });

  it("resets the idle timer on user activity", async () => {
    const lock = vi.fn(async () => undefined);
    const sendActivity = vi.fn();
    const vault = makeVault(lock);
    const { host, Guard } = await createHost(vault, sendActivity);

    render(
      <PluginHostProvider host={host}>
        <Guard />
      </PluginHostProvider>
    );

    expect(document.querySelector("[data-testid='home-route']")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    fireEvent.pointerDown(window);
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59 * 1000);
    expect(lock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(lock).not.toHaveBeenCalled();
    expect(sendActivity).toHaveBeenCalledTimes(1);
  });

  it("reschedules the idle timer when the document becomes visible again", async () => {
    const lock = vi.fn(async () => undefined);
    const vault = makeVault(lock);
    const { host, Guard } = await createHost(vault);

    render(
      <PluginHostProvider host={host}>
        <Guard />
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
    expect(lock).not.toHaveBeenCalled();
  });
});
