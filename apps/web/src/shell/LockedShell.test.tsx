// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createKeymasterPluginHost as createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import {
  KEYSPACE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  type KeyspaceService,
  type VaultLifecycleSnapshot,
  type VaultService,
  type VaultStatus,
  type WalletInitializePlan,
} from "@keymaster/contracts";
import { SHELL_RESOURCES } from "../i18n/resources.js";
import { registerShellResources } from "./shellResources.js";
import { LockedShell } from "./LockedShell.js";

const PUBLIC_KEY = "02".padEnd(66, "a");

afterEach(() => cleanup());

/**
 * 壳层测试固定用 en 语言包：文案断言读的是真实 i18n 资源，defaultValue
 * 只有在 key 缺失时才生效，两者混用会让断言随语言包变化而漂移。
 */
const EN = SHELL_RESOURCES.resources.en;

function lockedSnapshot(): VaultLifecycleSnapshot {
  return {
    status: "locked",
    activePublicKeyHex: undefined,
    sessionEpoch: "epoch-1",
    runGeneration: "run-1",
    vaultLifecycleRevision: 1,
    walletGeneration: "wallet-1",
  };
}

function createHost(input: {
  status?: VaultStatus;
  currentKey?: string | undefined;
  unlock?: VaultService["unlock"];
  initialize?: (plan: WalletInitializePlan) => Promise<never> | Promise<unknown>;
}) {
  const status = input.status ?? "locked";
  const snapshot: VaultLifecycleSnapshot = status === "uninitialized"
    ? { ...lockedSnapshot(), status, activePublicKeyHex: undefined, walletGeneration: "" }
    : { ...lockedSnapshot(), status };
  const vault = {
    status: () => status,
    getLifecycleSnapshot: () => snapshot,
    onLifecycleChange: (handler: (next: VaultLifecycleSnapshot) => void) => {
      handler(snapshot);
      return () => undefined;
    },
    getCurrentKey: async () => {
      if (input.currentKey === undefined || input.currentKey === undefined) {
        return { publicKeyHex: PUBLIC_KEY, label: input.currentKey ?? "Primary", format: "generated", capabilities: ["p2pkh"], createdAt: "2026-09-08T00:00:00.000Z" };
      }
      return undefined;
    },
    hasVault: async () => status !== "uninitialized",
    initialize: input.initialize ?? vi.fn(async (plan: WalletInitializePlan) => ({
      publicKeyHex: PUBLIC_KEY,
      label: "我的钱包",
      capabilities: ["p2pkh"],
      createdAt: "2026-09-08T00:00:00.000Z",
      plan,
    })),
    unlock: input.unlock ?? vi.fn(async () => ({ status: "accepted" as const })),
    lock: async () => ({ status: "accepted" as const }),
    changePassword: async () => undefined,
    renameKey: async () => undefined,
    exportKeyHold: async () => new Uint8Array([1, 2, 3]),
    verifyPassword: async () => undefined,
    resetWallet: async () => ({ walletGeneration: "wallet-2", clearedAt: "2026-09-08T00:00:00.000Z" }),
    createActiveKeyCrypto: async () => { throw new Error("not used"); },
    createAppViewSession: async () => { throw new Error("not used"); },
    disposeAppViewSession: () => undefined,
    disposeAllAppViewSessions: () => undefined,
  } as unknown as VaultService;
  const keyspace: KeyspaceService = {
    active: () => ({ activePublicKeyHex: status === "unlocked" ? PUBLIC_KEY : undefined }),
    requireActiveKey: () => ({ publicKeyHex: PUBLIC_KEY, label: "Primary", capabilities: ["p2pkh"], createdAt: "2026-09-08T00:00:00.000Z" }),
    onActiveKeyChanged: () => () => undefined,
  };
  const host = createPluginHost({
    disableConfigPersistence: true,
    initialI18nResources: [{ ...SHELL_RESOURCES, resources: { en: EN } }],
  });
  registerShellResources(host.capabilities.get(RESOURCE_REGISTRY_CAPABILITY));
  host.provide(VAULT_SERVICE_CAPABILITY, vault);
  host.provide(KEYSPACE_SERVICE_CAPABILITY, keyspace);
  return { host, vault };
}

describe("LockedShell locked mode", () => {
  it("shows only the unlock form and never offers create or import", async () => {
    const { host } = createHost({ status: "locked" });
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /New wallet/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Import a wallet Key/u })).toBeNull();
    // 旧多 Key 模型的导出/删除私钥入口在单 Key 模式下不存在。
    expect(screen.queryByRole("button", { name: "Export private key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete private key" })).toBeNull();
  });

  it("unlocks with the entered Key password", async () => {
    const unlock = vi.fn(async () => ({ status: "accepted" as const }));
    const { host } = createHost({ status: "locked", unlock });
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Key password"), { target: { value: "wallet-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(unlock).toHaveBeenCalledWith("wallet-password-1"));
  });

  it("surfaces a rejected unlock without leaving the form", async () => {
    const unlock = vi.fn(async () => ({ status: "error" as const, message: "密码不正确" }));
    const { host } = createHost({ status: "locked", unlock });
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Key password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(screen.getByText("密码不正确")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy();
  });

  it("still unlocks when the locked Key label cannot be read", async () => {
    const { host } = createHost({ status: "locked" });
    const vault = host.capabilities.get(VAULT_SERVICE_CAPABILITY);
    vault.getCurrentKey = async () => undefined;
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy());
    expect(screen.queryByText("Primary")).toBeNull();
  });
});

describe("LockedShell uninitialized mode", () => {
  it("offers exactly two paths: create a wallet key or import one", async () => {
    const { host } = createHost({ status: "uninitialized" });
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: /New wallet/u })).toBeTruthy());
    expect(screen.getByRole("button", { name: /Import a wallet Key/u })).toBeTruthy();
    // 存储类型、桶配置、连接已有远程空间都不是本产品的入口。
    expect(screen.queryByText(/S3/u)).toBeNull();
    expect(screen.queryByText(/Bucket/u)).toBeNull();
  });

  it("creates the wallet through one atomic initialize plan", async () => {
    const initialize = vi.fn(async (plan: WalletInitializePlan) => ({
      publicKeyHex: PUBLIC_KEY,
      label: "我的钱包",
      capabilities: ["p2pkh"],
      createdAt: "2026-09-08T00:00:00.000Z",
      plan,
    }));
    const { host } = createHost({ status: "uninitialized", initialize });
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: /New wallet/u })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /New wallet/u }));
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "wallet-password-1" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "wallet-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    const plan = initialize.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(plan).toMatchObject({
      transactionId: expect.any(String),
      firstKey: { kind: "generate", label: "My Wallet", capabilities: ["p2pkh"], password: "wallet-password-1" },
    });
    expect(plan.bucketLabel).toBeUndefined();
    expect(plan.backend).toBeUndefined();
    expect(plan.connection).toBeUndefined();
  });

  it("rejects mismatched or too-short passwords before calling initialize", async () => {
    const initialize = vi.fn(async () => { throw new Error("not reached"); });
    const { host } = createHost({ status: "uninitialized", initialize });
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: /New wallet/u })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /New wallet/u }));
    // TextInput 把 error 渲染在 <label> 内部，出错后 label 的可访问文本就变了；
    // 一次性取到两个输入框，后续断言不再依赖 label 文本。
    const passwordInputs = screen.getAllByLabelText(
      /^(New password|Confirm password)$/u,
      { selector: "input" },
    ) as HTMLElement[];
    const [newPassword, confirmPassword] = passwordInputs as [HTMLElement, HTMLElement];
    fireEvent.change(newPassword, { target: { value: "short" } });
    fireEvent.change(confirmPassword, { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByText("Password must be at least 8 characters")).toBeTruthy());

    fireEvent.change(newPassword, { target: { value: "wallet-password-1" } });
    fireEvent.change(confirmPassword, { target: { value: "wallet-password-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByText("Passwords do not match")).toBeTruthy());
    expect(initialize).not.toHaveBeenCalled();
  });

  it("reports initialization failure and stays on the form", async () => {
    const initialize = vi.fn(async () => { throw new Error("IndexedDB transaction aborted"); });
    const { host } = createHost({ status: "uninitialized", initialize });
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: /New wallet/u })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /New wallet/u }));
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "wallet-password-1" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "wallet-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByText("IndexedDB transaction aborted")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });
});
