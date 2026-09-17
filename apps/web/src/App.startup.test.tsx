// apps/web/src/App.startup.test.tsx
// App 启动判定回归：ResourceSnapshot 的 status/data 必须决定是否可以进入
// 首次设置或业务 shell。尤其不能把 pending/no-data 当作 uninitialized。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import type { ApplicationBootstrapSnapshot, VaultStatus } from "@keymaster/contracts";
import { App } from "./App.js";

type ResourceStatus = "pending" | "ready" | "stale" | "error" | "blocked";
type TestResourceSnapshot = {
  key: readonly string[];
  status: ResourceStatus;
  data: ApplicationBootstrapSnapshot | undefined;
  error?: { code: string; message: string };
  revision: number;
};

const testState = vi.hoisted(() => ({
  resourceDefined: true,
  storageStatusResourceDefined: true,
  hasStorageController: true,
  hasVaultService: true,
  hasKeyspaceService: true,
  vaultStatus: "locked" as VaultStatus,
  runtimeVault: "locked" as VaultStatus,
  runtimeReady: true,
  setupMounts: 0,
  setupRecoveryReads: 0,
  resourceReads: 0,
  invalidateCalls: 0,
  retryCalls: 0,
  resource: undefined as TestResourceSnapshot | undefined
}));

function bootstrapSnapshot(overrides: Partial<ApplicationBootstrapSnapshot> = {}): ApplicationBootstrapSnapshot {
  return {
    phase: "vault-selection",
    storageReady: true,
    vaultCapabilityReady: true,
    hasUnlockedActiveKey: false,
    vaultSelectionReady: true,
    ownerAppsReady: false,
    connectAppsReady: false,
    assetWorkspaceReady: false,
    ...overrides
  };
}

function setResource(status: ResourceStatus, data?: ApplicationBootstrapSnapshot, error?: { code: string; message: string }): void {
  testState.resource = {
    key: ["shell.application-bootstrap"],
    status,
    data,
    ...(error ? { error } : {}),
    revision: (testState.resource?.revision ?? 0) + 1
  };
}

function setPath(path: string): void {
  window.history.replaceState(null, "", path);
}

function resetState(): void {
  setPath("/");
  testState.resourceDefined = true;
  testState.storageStatusResourceDefined = true;
  testState.hasStorageController = true;
  testState.hasVaultService = true;
  testState.hasKeyspaceService = true;
  testState.vaultStatus = "locked";
  testState.runtimeVault = "locked";
  testState.runtimeReady = true;
  testState.setupMounts = 0;
  testState.setupRecoveryReads = 0;
  testState.resourceReads = 0;
  testState.invalidateCalls = 0;
  testState.retryCalls = 0;
  setResource("pending");
}

const host = {
  resourceStore: {
    invalidate: () => { testState.invalidateCalls += 1; }
  },
  resourceRegistry: {
    get: (id: string) => {
      if (id === "shell.application-bootstrap") return testState.resourceDefined ? {} : undefined;
      if (id === "storage.status") return testState.storageStatusResourceDefined ? {} : undefined;
      return {};
    }
  }
};

vi.mock("@keymaster/runtime", () => ({
  usePluginHost: () => host,
  useHostVersion: () => 1,
  useCurrentPath: () => {
    const [path, setPathState] = useState(window.location.pathname);
    useEffect(() => {
      const update = () => setPathState(window.location.pathname);
      window.addEventListener("popstate", update);
      return () => window.removeEventListener("popstate", update);
    }, []);
    return path;
  },
  useRuntimeStatus: () => ({ vault: testState.runtimeVault, ready: testState.runtimeReady }),
  useI18n: () => ({
    t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? "正在准备存储…",
    language: () => "zh-CN"
  })
}));

vi.mock("webloom-framework/react", () => ({
  useHasCapability: (capability: { id: string }) => {
    if (capability.id === "storage.runtime-controller") return testState.hasStorageController;
    if (capability.id === "vault.service") return testState.hasVaultService;
    if (capability.id === "keyspace.service") return testState.hasKeyspaceService;
    return true;
  },
  useOptionalCapability: (capability: { id: string }) => {
    if (capability.id === "vault.service" && testState.hasVaultService) {
      return { status: () => testState.vaultStatus };
    }
    if (capability.id === "application-bootstrap.ready") {
      return { retry: async () => { testState.retryCalls += 1; } };
    }
    return undefined;
  },
  useResource: () => {
    testState.resourceReads += 1;
    if (!testState.resource) throw new Error("test resource was not initialized");
    return testState.resource;
  }
}));

vi.mock("@keymaster/platform-storage", () => ({
  readStorageBootstrap: () => null,
  StorageUnavailableGuard: ({ children }: { children: ReactNode }) => children
}));

vi.mock("./shell/InitialSetupPage.js", () => ({
  InitialSetupPage: () => {
    testState.setupMounts += 1;
    // 这个 mock 把真实页面 mount 时的 recovery queue 读取建模出来，
    // 便于证明 pending 首帧没有触发初始化恢复读取。
    testState.setupRecoveryReads += 1;
    return <div data-testid="initial-setup">setup</div>;
  }
}));

vi.mock("./shell/StorageAuthenticationPage.js", () => ({
  StorageAuthenticationPage: () => <div data-testid="storage-authentication">authentication</div>
}));

vi.mock("./shell/LockedShell.js", () => ({
  LockedShell: () => <div data-testid="locked-shell">locked</div>
}));

vi.mock("./shell/UnlockedShell.js", () => ({
  UnlockedShell: () => <div data-testid="unlocked-shell">unlocked</div>
}));

vi.mock("@keymaster/plugin-protocol", () => ({
  ProtocolPopupPage: () => <div data-testid="protocol-popup">protocol</div>
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  resetState();
});

describe("App startup gate", () => {
  it("shows only the startup placeholder for pending/no-data and does not read setup recovery", () => {
    render(<App />);

    expect(screen.getByRole("status").textContent).toContain("正在准备存储");
    expect(screen.queryByTestId("initial-setup")).toBeNull();
    expect(testState.setupMounts).toBe(0);
    expect(testState.setupRecoveryReads).toBe(0);
  });

  it("enters first setup only after a ready storage-onboarding snapshot", () => {
    setResource("ready", bootstrapSnapshot({
      phase: "storage-onboarding",
      storageReady: false,
      vaultCapabilityReady: false,
      vaultSelectionReady: false
    }));

    render(<App />);

    expect(screen.getByTestId("initial-setup")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(testState.setupRecoveryReads).toBeGreaterThan(0);
  });

  it("routes an existing storage authentication snapshot to the authentication page", () => {
    setResource("ready", bootstrapSnapshot({
      phase: "storage-authentication",
      storageReady: false,
      vaultCapabilityReady: false,
      vaultSelectionReady: false
    }));

    render(<App />);

    expect(screen.getByTestId("storage-authentication")).toBeTruthy();
    expect(screen.queryByTestId("initial-setup")).toBeNull();
    expect(testState.setupRecoveryReads).toBe(0);
  });

  it("enters first setup for a resolved uninitialized vault", () => {
    testState.vaultStatus = "uninitialized";
    setResource("ready", bootstrapSnapshot());

    render(<App />);

    expect(screen.getByTestId("initial-setup")).toBeTruthy();
    expect(screen.queryByTestId("locked-shell")).toBeNull();
  });

  it("does not treat a vault-selection snapshot with storageReady=false as first setup", () => {
    // This is the regression shape produced when session.state changes the
    // Vault identity before storage onboarding has completed. Only the
    // bootstrap producer may advance this to vault-selection after storage is
    // actually ready; App must fail closed if it receives the inconsistent
    // snapshot rather than mounting setup against unknown storage.
    setResource("ready", bootstrapSnapshot({ storageReady: false }));

    render(<App />);

    expect(screen.getByRole("alert").textContent).toContain("存储启动状态不一致");
    expect(screen.queryByTestId("initial-setup")).toBeNull();
    expect(testState.setupRecoveryReads).toBe(0);
  });

  it("enters the locked shell directly without an intermediate loading frame", () => {
    testState.vaultStatus = "locked";
    testState.runtimeVault = "booting";
    testState.runtimeReady = false;
    setResource("ready", bootstrapSnapshot());

    render(<App />);

    expect(screen.getByTestId("locked-shell")).toBeTruthy();
    expect(screen.queryByTestId("initial-setup")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("enters the unlocked shell for a fully ready unlocked application", () => {
    testState.vaultStatus = "unlocked";
    testState.runtimeVault = "booting";
    testState.runtimeReady = false;
    setResource("ready", bootstrapSnapshot({
      phase: "connect-apps-ready",
      hasUnlockedActiveKey: true,
      ownerAppsReady: true,
      connectAppsReady: true,
      assetWorkspaceReady: true
    }));

    render(<App />);

    expect(screen.getByTestId("unlocked-shell")).toBeTruthy();
    expect(screen.queryByTestId("initial-setup")).toBeNull();
  });

  it("keeps the startup placeholder while the vault is booting", () => {
    testState.vaultStatus = "booting";
    testState.runtimeVault = "booting";
    testState.runtimeReady = false;
    setResource("ready", bootstrapSnapshot());

    render(<App />);

    expect(screen.getByRole("status").textContent).toContain("正在准备存储");
    expect(screen.queryByTestId("initial-setup")).toBeNull();
  });

  it("keeps the startup placeholder while vault capabilities are not ready", () => {
    testState.hasVaultService = false;
    testState.hasKeyspaceService = false;
    setResource("ready", bootstrapSnapshot({ vaultCapabilityReady: false, vaultSelectionReady: false }));

    render(<App />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByTestId("initial-setup")).toBeNull();
  });

  it.each([
    ["error", { code: "resource.load_failed", message: "读取失败" }],
    ["blocked", undefined]
  ] as const)("renders an explicit recovery page for a bootstrap resource %s", (status, error) => {
    setResource(status, undefined, error);

    render(<App />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("initial-setup")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders an explicit recovery page for an application bootstrap phase error", () => {
    setResource("ready", bootstrapSnapshot({ phase: "error", error: "Vault 装配失败" }));

    render(<App />);

    expect(screen.getByRole("alert").textContent).toContain("Vault 装配失败");
    expect(screen.queryByTestId("initial-setup")).toBeNull();
  });

  it("does not mount setup when the storage status resource definition is missing", () => {
    testState.storageStatusResourceDefined = false;
    setResource("ready", bootstrapSnapshot({ phase: "storage-onboarding", storageReady: false }));

    render(<App />);

    expect(screen.getByRole("alert").textContent).toContain("存储运行时正在恢复");
    expect(screen.queryByTestId("initial-setup")).toBeNull();
  });

  it("preserves an old locked decision during a later pending refresh with data", () => {
    setResource("ready", bootstrapSnapshot());
    const view = render(<App />);
    expect(screen.getByTestId("locked-shell")).toBeTruthy();

    setResource("pending", bootstrapSnapshot());
    view.rerender(<App />);

    expect(screen.getByTestId("locked-shell")).toBeTruthy();
    expect(screen.queryByTestId("initial-setup")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("preserves the protocol popup for an uninitialized vault after startup is resolved", () => {
    testState.vaultStatus = "uninitialized";
    setPath("/protocol/v1/popup");
    setResource("ready", bootstrapSnapshot());

    render(<App />);

    expect(screen.getByTestId("protocol-popup")).toBeTruthy();
    expect(screen.queryByTestId("initial-setup")).toBeNull();
  });
});
