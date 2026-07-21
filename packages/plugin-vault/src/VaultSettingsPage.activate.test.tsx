// packages/plugin-vault/src/VaultSettingsPage.activate.test.tsx
// Key 管理页激活 key 的确认流程回归测试。
//
// 关键不变量：
//   - 点击“设为 active”先弹密码确认框；
//   - 取消不切换；
//   - 确认后直接调用 vault.activateKey({ publicKeyHex, password })。

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import type {
  ActiveKeyState,
  KeyIdentity,
  KeyspaceService,
  VaultService,
  VaultStatus
} from "@keymaster/contracts";
import { VaultSettingsPage } from "./VaultSettingsPage.js";

const KEY_A = "02".padEnd(66, "a");
const KEY_B = "03".padEnd(66, "b");

function makeVault(activateKey = vi.fn(async () => ({ status: "accepted" as const }))): VaultService & {
  activateKey: typeof activateKey;
} {
  return {
    status: () => "unlocked" as VaultStatus,
    onStatusChange: () => () => undefined,
    getSessionState: () => null,
    getInitialActivationNotice: () => null,
    clearInitialActivationNotice: () => undefined,
    onInitialActivationNoticeChange: () => () => undefined,
    hasVault: async () => true,
    createVault: async () => undefined,
    createVaultWithInitialKey: async () => ({ publicKeyHex: KEY_A, label: "A", format: "hex", capabilities: ["p2pkh"], createdAt: new Date().toISOString() }),
    createVaultWithImportedKey: async () => ({ publicKeyHex: KEY_A, label: "A", format: "hex", capabilities: ["p2pkh"], createdAt: new Date().toISOString() }),
    unlock: async () => ({ status: "accepted" as const }),
    lock: async () => ({ status: "accepted" as const }),
    changePassword: async () => undefined,
    dispose: () => undefined,
    activateKey,
    finalizeEmptyVaultAfterLastKeyDeletion: async () => undefined,
    recoverEmptyVaultToUninitialized: async () => undefined,
    listKeys: async () => [],
    getKey: async () => undefined,
    importPrivateKey: async () => ({ publicKeyHex: KEY_A, label: "A", format: "hex", capabilities: ["p2pkh"], createdAt: new Date().toISOString() }),
    generateKey: async () => ({ publicKeyHex: KEY_A, label: "A", format: "hex", capabilities: ["p2pkh"], createdAt: new Date().toISOString() }),
    removeKey: async () => undefined,
    deleteKeyMaterial: async () => undefined,
    exportKeyBackup: async () => "",
    importKeyBackup: async () => ({ publicKeyHex: KEY_A, label: "A", format: "hex", capabilities: ["p2pkh"], createdAt: new Date().toISOString() }),
    createActiveKeyCrypto: async () => {
      throw new Error("not used");
    }
  } as unknown as VaultService & { activateKey: typeof activateKey };
}

function makeKeyspace() {
  const listeners = new Set<(state: ActiveKeyState) => void>();
  const identities: KeyIdentity[] = [
    { publicKeyHex: KEY_A, label: "Alpha", capabilities: ["p2pkh"], createdAt: "2026-07-17T00:00:00.000Z" },
    { publicKeyHex: KEY_B, label: "Beta", capabilities: ["p2pkh"], createdAt: "2026-07-17T00:00:00.000Z" }
  ];
  let active = { activePublicKeyHex: KEY_A } satisfies ActiveKeyState;
  const setActive = vi.fn(async (publicKeyHex: string) => {
    active = { activePublicKeyHex: publicKeyHex };
    for (const handler of [...listeners]) handler(active);
  });
  return {
    active: () => active,
    onActiveKeyChanged: (handler: (state: ActiveKeyState) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    onInitializationChange: () => () => undefined,
    isInitializing: () => false,
    listKeys: async () => identities,
    setActive
  } as unknown as KeyspaceService & { setActive: typeof setActive };
}

function mount() {
  const host = createPluginHost({ disableConfigPersistence: true });
  const vault = makeVault();
  const keyspace = makeKeyspace();
  host.capabilities.provide<VaultService>("vault.service", vault);
  host.capabilities.provide<KeyspaceService>("keyspace.service", keyspace);
  registerVaultKeyState(host, keyspace, vault);
  return {
    vault,
    keyspace,
    ...render(
      <PluginHostProvider host={host}>
        <VaultSettingsPage />
      </PluginHostProvider>
    )
  };
}

function registerVaultKeyState(host: ReturnType<typeof createPluginHost>, keyspace: KeyspaceService, vault: VaultService): void {
  const registry = host.capabilities.get<any>("resource.registry");
  registry.register({
    id: "vault.key-state", scope: "global", key: () => ["vault.key-state"],
    load: async () => ({ keys: await keyspace.listKeys(), active: keyspace.active(), initializing: keyspace.isInitializing(), notice: vault.getInitialActivationNotice?.() ?? null }),
    subscribe: (_args: readonly string[], _context: unknown, invalidate: () => void) => {
      const off = keyspace.onActiveKeyChanged(invalidate);
      const init = keyspace.onInitializationChange(invalidate);
      return () => { off(); init(); };
    }, invalidation: "immediate"
  });
}

afterEach(() => {
  cleanup();
});

describe("VaultSettingsPage active switching", () => {
  it("asks for password before switching active key", async () => {
    const { keyspace, vault } = mount();
    const user = userEvent.setup();

    const switchButtons = await screen.findAllByRole("button", { name: /设为 active|Set active/ });
    const switchButton = switchButtons[0]!;
    await user.click(switchButton);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
    await user.click(screen.getByRole("button", { name: /取消|Cancel/ }));
    expect((keyspace.setActive as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((vault.activateKey as typeof vault.activateKey).mock.calls).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(keyspace.active().activePublicKeyHex).toBe(KEY_A);
  });

  it("verifies the password before committing the switch", async () => {
    const keyspace = makeKeyspace();
    const activateKey = vi.fn(async ({ publicKeyHex }: { publicKeyHex: string; password: string }) => {
      await keyspace.setActive(publicKeyHex);
      return { status: "accepted" as const };
    });
    const vault = makeVault(activateKey);
    const host = createPluginHost({ disableConfigPersistence: true });
    host.capabilities.provide<VaultService>("vault.service", vault);
    host.capabilities.provide<KeyspaceService>("keyspace.service", keyspace);
    registerVaultKeyState(host, keyspace, vault);

    render(
      <PluginHostProvider host={host}>
        <VaultSettingsPage />
      </PluginHostProvider>
    );

    const user = userEvent.setup();
    const switchButtons = await screen.findAllByRole("button", { name: /设为 active|Set active/ });
    const switchButton = switchButtons[0]!;
    await user.click(switchButton);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
    await user.type(screen.getByLabelText(/密码|Password/), "correct-horse-battery-staple");
    await user.click(screen.getByRole("button", { name: /确认|Confirm/ }));

    await waitFor(() => {
      expect(activateKey).toHaveBeenCalledWith({
        publicKeyHex: KEY_B,
        password: "correct-horse-battery-staple"
      });
    });
    expect((keyspace.setActive as ReturnType<typeof vi.fn>).mock.calls).toEqual([[KEY_B]]);
    expect(keyspace.active().activePublicKeyHex).toBe(KEY_B);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
