// packages/plugin-vault/src/KeySwitchWidget.test.tsx
// 顶栏 key switch widget 回归测试。
//
// 关键不变量：
//   - 选择其他 key 时先弹密码确认框，而不是直接 setActive；
//   - 取消不会改变 active；
//   - 密码正确后才调用 vault.activateKey({ publicKeyHex, password })。

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import type {
  ActiveKeyState,
  KeyIdentity,
  KeyspaceService,
  MessageBus,
  VaultService,
  VaultStatus
} from "@keymaster/contracts";
import { KeySwitchWidget } from "./KeySwitchWidget.js";

const KEY_A = "02".padEnd(66, "a");
const KEY_B = "03".padEnd(66, "b");

function makeMessageBus(): MessageBus {
  const subscriptions = new Map<string, Set<(payload: unknown) => void>>();
  return {
    publish(event: string, payload: unknown) {
      const bucket = subscriptions.get(event);
      if (bucket) {
        for (const handler of [...bucket]) handler(payload);
      }
      return event;
    },
    subscribe(event, handler) {
      let bucket = subscriptions.get(event);
      if (!bucket) {
        bucket = new Set();
        subscriptions.set(event, bucket);
      }
      bucket.add(handler as (payload: unknown) => void);
      return () => {
        bucket?.delete(handler as (payload: unknown) => void);
      };
    },
    dispatch: () => "",
    request: () => Promise.reject(new Error("not used")),
    handle: () => () => undefined,
    snapshot: () => ({ total: 0, queued: 0, inFlight: 0, completed: 0, failed: 0, canceled: 0, byTarget: {} }),
    onSnapshot: (h) => {
      h({ total: 0, queued: 0, inFlight: 0, completed: 0, failed: 0, canceled: 0, byTarget: {} });
      return () => undefined;
    }
  };
}

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
    activateKeyWithPasskey: async () => ({ status: "accepted" as const }),
    listPasskeysForKey: async () => [],
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
  return {
    active: () => active,
    onActiveKeyChanged: (handler: (state: ActiveKeyState) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    onInitializationChange: () => () => undefined,
    isInitializing: () => false,
    listKeys: async () => identities,
    setActive: vi.fn(async (publicKeyHex: string) => {
      active = { activePublicKeyHex: publicKeyHex };
      for (const handler of [...listeners]) handler(active);
    })
  } as unknown as KeyspaceService & { setActive: ReturnType<typeof vi.fn> };
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
        <KeySwitchWidget />
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

describe("KeySwitchWidget", () => {
  it("requires password confirmation before switching active key", async () => {
    const { keyspace, vault } = mount();
    const user = (await import("@testing-library/user-event")).default.setup();

    await user.click(screen.getByRole("button", { name: /切换 key|Switch key/ }));
    await user.click(screen.getByRole("button", { name: /Beta/ }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
    expect((keyspace.setActive as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /Cancel|取消/ }));
    expect((keyspace.setActive as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((vault.activateKey as typeof vault.activateKey).mock.calls).toHaveLength(0);
    expect(keyspace.active().activePublicKeyHex).toBe(KEY_A);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("verifies the password before committing the active key change", async () => {
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

    const user = (await import("@testing-library/user-event")).default.setup();
    render(
      <PluginHostProvider host={host}>
        <KeySwitchWidget />
      </PluginHostProvider>
    );

    await user.click(screen.getByRole("button", { name: /切换 key|Switch key/ }));
    await user.click(screen.getByRole("button", { name: /Beta/ }));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
    await user.type(screen.getByLabelText(/Vault password|Vault 密码/i), "correct-horse-battery-staple");
    await user.click(screen.getByRole("button", { name: /Unlock with password|使用密码解锁/ }));

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

  it("lets the user choose one of multiple passkeys by id", async () => {
    const keyspace = makeKeyspace();
    const vault = makeVault();
    const activateKeyWithPasskey = vi.fn(async () => ({ status: "accepted" as const }));
    vault.listPasskeysForKey = async () => [
      {
        id: "passkey-phone",
        label: "iPhone",
        rpId: "keymaster.cc",
        createdAt: "2026-07-17T00:00:00.000Z"
      },
      {
        id: "passkey-laptop",
        label: "MacBook Touch ID",
        rpId: "keymaster.cc",
        createdAt: "2026-07-18T00:00:00.000Z"
      }
    ];
    vault.activateKeyWithPasskey = activateKeyWithPasskey;
    const host = createPluginHost({ disableConfigPersistence: true });
    host.capabilities.provide<VaultService>("vault.service", vault);
    host.capabilities.provide<KeyspaceService>("keyspace.service", keyspace);
    registerVaultKeyState(host, keyspace, vault);

    const user = (await import("@testing-library/user-event")).default.setup();
    render(
      <PluginHostProvider host={host}>
        <KeySwitchWidget />
      </PluginHostProvider>
    );

    await user.click(screen.getByRole("button", { name: /切换 key|Switch key/ }));
    await user.click(screen.getByRole("button", { name: /Beta/ }));
    await user.click(await screen.findByRole("button", { name: "MacBook Touch ID" }));

    expect(activateKeyWithPasskey).toHaveBeenCalledTimes(1);
    expect(activateKeyWithPasskey).toHaveBeenCalledWith({ passkeyId: "passkey-laptop" });
    expect(vault.activateKey).not.toHaveBeenCalled();
  });
});
