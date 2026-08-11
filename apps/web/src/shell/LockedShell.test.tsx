// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import type { KeyspaceService, VaultService } from "@keymaster/contracts";
import { SHELL_RESOURCES } from "../i18n/resources.js";
import { registerShellResources } from "./shellResources.js";
import { LockedShell } from "./LockedShell.js";

const SELECTED = "02".padEnd(66, "a");

afterEach(() => cleanup());

function createLockedHost(input?: { selected?: string; deleteKey?: KeyspaceService["deleteKey"]; exportKeyBackup?: VaultService["exportKeyBackup"] }) {
  const keyspace: KeyspaceService = {
    active: () => ({ activePublicKeyHex: undefined }),
    selected: () => input?.selected,
    listKeys: async () => [],
    getKey: async (publicKeyHex) => publicKeyHex === SELECTED ? { publicKeyHex, label: "Primary", capabilities: [], createdAt: "now" } : undefined,
    deleteKey: input?.deleteKey ?? (async () => undefined),
    setActive: async () => undefined,
    requireActiveKey: () => ({ publicKeyHex: SELECTED, label: "Primary", capabilities: [], createdAt: "now" }),
    onActiveKeyChanged: () => () => undefined,
    openKeyStorage: async () => { throw new Error("not used"); },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    onInitializationChange: () => () => undefined,
    isInitializing: () => false
  };
  const vault: VaultService = {
    status: () => "locked",
    getLifecycleSnapshot: () => ({ status: "locked", sessionEpoch: "e", vaultLifecycleRevision: 1 }),
    onLifecycleChange: (handler) => { handler({ status: "locked", sessionEpoch: "e", vaultLifecycleRevision: 1 }); return () => undefined; },
    getInitialActivationNotice: () => null,
    clearInitialActivationNotice: () => undefined,
    onInitialActivationNoticeChange: () => () => undefined,
    hasVault: async () => true,
    createVault: async () => undefined,
    createVaultWithInitialKey: async () => ({ publicKeyHex: SELECTED, label: "Primary", address: "", network: "main", format: "generated", capabilities: [], createdAt: "now" }),
    createVaultWithImportedKey: async () => ({ publicKeyHex: SELECTED, label: "Primary", address: "", network: "main", format: "import", capabilities: [], createdAt: "now" }),
    unlock: vi.fn(async () => ({ status: "accepted" as const })),
    lock: async () => ({ status: "accepted" as const }),
    changePassword: async () => undefined,
    verifyPassword: vi.fn(async () => undefined),
    finalizeEmptyVaultAfterLastKeyDeletion: async () => undefined,
    recoverEmptyVaultToUninitialized: async () => undefined,
    importPrivateKey: async () => ({ publicKeyHex: SELECTED, label: "Primary", address: "", network: "main", format: "import", capabilities: [], createdAt: "now" }),
    generateKey: async () => ({ publicKeyHex: SELECTED, label: "Primary", address: "", network: "main", format: "generated", capabilities: [], createdAt: "now" }),
    deleteKeyMaterial: async () => undefined,
    removeKey: async () => undefined,
    getKey: async (publicKeyHex: string) => publicKeyHex === SELECTED ? { publicKeyHex, label: "Primary", address: "", network: "main" as const, format: "keyhold-v2", capabilities: [], createdAt: "now" } : undefined,
    listKeys: async () => [],
    exportKeyBackup: input?.exportKeyBackup ?? vi.fn(async () => JSON.stringify({ format: "keymaster", version: 2 })),
    exportCurrentKeyBackup: vi.fn(async () => JSON.stringify({ format: "keymaster", version: 2 })),
    createActiveKeyCrypto: async () => { throw new Error("not used"); },
    createAppViewSession: async () => { throw new Error("not used"); },
    disposeAppViewSession: () => undefined,
    disposeAllAppViewSessions: () => undefined,
    activateKey: async () => ({ status: "accepted" as const }),
    activateKeyWithPasskey: async () => ({ status: "accepted" as const }),
    listPasskeysForKey: async () => [],
    listCurrentKeyPasskeys: async () => [],
    addPasskeyToCurrentKey: async () => ({ id: "id", label: "", credentialIdB64: "", rpId: "", createdAt: "", transports: [] }),
    removePasskeyFromCurrentKey: async () => undefined
  };
  const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [SHELL_RESOURCES] });
  registerShellResources(host.capabilities.get("resource.registry"));
  host.capabilities.provide<VaultService>("vault.service", vault);
  host.capabilities.provide<KeyspaceService>("keyspace.service", keyspace);
  return { host, vault, keyspace };
}

describe("LockedShell selected key controls", () => {
  it("shows selected summary and cold-export action without unlocking", async () => {
    const { host, vault } = createLockedHost({ selected: SELECTED });
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText(/Primary/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Export private key" }));
    await waitFor(() => expect(vault.exportKeyBackup).toHaveBeenCalledWith(SELECTED));
    expect(vault.unlock).not.toHaveBeenCalled();
    expect(vault.verifyPassword).not.toHaveBeenCalled();
  });

  it("keeps delete modal open when label authorization fails", async () => {
    const deleteKey = vi.fn(async () => { throw new Error("Key label mismatch"); });
    const { host, keyspace } = createLockedHost({ selected: SELECTED, deleteKey });
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText(/Primary/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete private key" }));
    const deleteLabel = screen.getByRole("dialog").querySelector("input[type='text']");
    if (!deleteLabel) throw new Error("delete label input missing");
    fireEvent.change(deleteLabel, { target: { value: "Primary" } });
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(deleteKey).toHaveBeenCalledWith({ publicKeyHex: SELECTED, confirmationLabel: "Primary" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(keyspace.selected()).toBe(SELECTED);
  });

  it("does not render selected controls when no selected key exists", async () => {
    const { host } = createLockedHost();
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.queryByText("Selected private key")).toBeNull());
    expect(screen.queryByRole("button", { name: "Export private key" })).toBeNull();
  });

  it("shows export errors while keeping selected delete controls usable", async () => {
    const exportKeyBackup = vi.fn(async () => { throw new Error("Unsupported key storage version"); });
    const { host } = createLockedHost({ selected: SELECTED, exportKeyBackup });
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText(/Primary/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Export private key" }));
    await waitFor(() => expect(screen.getByText("Unsupported key storage version")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Delete private key" })).toBeTruthy();
  });

  it("passes only selected public key and exact label to keyspace delete", async () => {
    const deleteKey = vi.fn(async () => undefined);
    const { host, vault } = createLockedHost({ selected: SELECTED, deleteKey });
    render(<PluginHostProvider host={host}><LockedShell /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText(/Primary/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete private key" }));
    const input = screen.getByRole("dialog").querySelector("input[type='text']");
    if (!input) throw new Error("delete label input missing");
    fireEvent.change(input, { target: { value: "Primary" } });
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(deleteKey).toHaveBeenCalledWith({ publicKeyHex: SELECTED, confirmationLabel: "Primary" }));
    expect(vault.unlock).not.toHaveBeenCalled();
    expect(vault.verifyPassword).not.toHaveBeenCalled();
  });
});
