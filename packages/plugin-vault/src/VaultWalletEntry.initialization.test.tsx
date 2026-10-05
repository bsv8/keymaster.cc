import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { bindTestVaultUi, createVaultTestHost as createPluginHost } from "./vaultUi.testSupport.js";
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import {
  VAULT_WALLET_STATE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  type VaultWalletState,
  type VaultLifecycleSnapshot,
  type VaultService,
} from "@keymaster/contracts";
import { SHELL_TEST_RESOURCES as SHELL_RESOURCES } from "@keymaster/runtime/test-support";
import { VaultWalletEntry } from "./VaultWalletEntry.js";

const EN = SHELL_RESOURCES.resources.en;

afterEach(() => cleanup());

async function createHost(status: "uninitialized" | "locked") {
  const snapshot: VaultLifecycleSnapshot = status === "uninitialized"
    ? { status, sessionEpoch: "epoch-1", runGeneration: "run-1", vaultLifecycleRevision: 1, walletGeneration: "" }
    : { status, sessionEpoch: "epoch-1", runGeneration: "run-1", vaultLifecycleRevision: 1, walletGeneration: "wallet-1" };
  const vault = {
    status: () => status,
    walletSnapshot: () => snapshot,
    subscribeWalletState: (handler: (next: VaultLifecycleSnapshot) => void) => {
      handler(snapshot);
      return () => undefined;
    },
    getCurrentKey: async () => (status === "locked"
      ? { publicKeyHex: "02".padEnd(66, "a"), label: "Primary", format: "generated", capabilities: ["p2pkh"], createdAt: "2026-09-08T00:00:00.000Z" }
      : undefined),
    hasVault: async () => status !== "uninitialized",
    initialize: async () => { throw new Error("not reached"); },
    unlock: async () => ({ status: "accepted" as const }),
    lock: async () => ({ status: "accepted" as const }),
    changePassword: async () => undefined,
    renameKey: async () => undefined,
    exportKeyHold: async () => new Uint8Array([1]),
    verifyPassword: async () => undefined,
    resetWallet: async () => ({ walletGeneration: "wallet-2", clearedAt: "2026-09-08T00:00:00.000Z" }),
    createActiveKeyCrypto: async () => { throw new Error("not used"); },
    createAppViewSession: async () => { throw new Error("not used"); },
    disposeAppViewSession: () => undefined,
    disposeAllAppViewSessions: () => undefined,
  } as unknown as VaultService;
  const walletState: VaultWalletState = {
    snapshot: () => walletStateFixtureSnapshot((() => ({}))(), () => { throw new Error("no wallet Key yet"); }),
    
    subscribe: () => () => undefined,
  };
  const host = createPluginHost({

    initialI18nResources: [{ ...SHELL_RESOURCES, resources: { en: EN } }],
  });
  host.provide(VAULT_SERVICE_CAPABILITY, vault);
  host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState));
  const Entry = await bindTestVaultUi(host, VaultWalletEntry);
  return { host, Entry };
}

/**
 * InitialSetupPage 只是 App 启动门禁保留的调用名，实际渲染 LockedShell。
 *
 * 这里锁住的不变量是「旧调用点不会绕开单 Key 初始化」：uninitialized 必须
 * 落在创建/导入两条路径上，页面不引入任何桶或远端存储入口；locked 时也
 * 不会回到创建入口。
 */
describe("InitialSetupPage", () => {
  it("renders the LockedShell welcome flow for an uninitialized wallet", async () => {
    const { host, Entry } = await createHost("uninitialized");
    render(<PluginHostProvider host={host}><Entry /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: /New wallet/u })).toBeTruthy());
    expect(screen.getByRole("button", { name: /Import a wallet Key/u })).toBeTruthy();
    expect(screen.queryByText(/S3/u)).toBeNull();
    expect(screen.queryByText(/bucket/iu)).toBeNull();
  });

  it("renders only the unlock form when the wallet is already locked", async () => {
    const { host, Entry } = await createHost("locked");
    render(<PluginHostProvider host={host}><Entry /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /New wallet/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Import a wallet Key/u })).toBeNull();
  });
});
