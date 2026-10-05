import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { bindTestContactsUi, createContactsTestHost as createPluginHost } from "./contactsUi.testSupport.js";
// packages/plugin-contacts/src/ContactsEditor.test.tsx
// 联系人编辑器回归测试。
//
// 目标：
//   - 编辑器打开后若 active key 切换，保存必须拒绝；
//   - 不允许把联系人写进新的 active key 对应数据库；
//   - 这是这次硬切换里最容易被消息页 capability 路径绕开的保护点。

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  CONTACTS_SERVICE_CAPABILITY,
  VAULT_WALLET_STATE_CAPABILITY,
  type VaultLifecycleSnapshot,
  type Contact,
  type ContactsService,
  type VaultWalletState,
} from "@keymaster/contracts";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import type { PluginHost } from "@keymaster/runtime";
import { ContactsEditor } from "./ContactsEditor.js";
import { contactsResources } from "./manifest.js";

const INITIAL_KEY = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEXT_KEY = "02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type TestWalletState = VaultWalletState & { setActive(publicKeyHex: string): void };

function makeFakeWalletState(): TestWalletState {
  let active: VaultLifecycleSnapshot = walletStateFixtureSnapshot({ activePublicKeyHex: INITIAL_KEY });
  const listeners = new Set<(state: VaultLifecycleSnapshot) => void>();
  const setActive = (publicKeyHex: string) => {
    active = walletStateFixtureSnapshot({ activePublicKeyHex: publicKeyHex });
    for (const listener of listeners) listener(active);
  };
  return {
    snapshot: () => walletStateFixtureSnapshot((() => active)(), () => ({
      publicKeyHex: INITIAL_KEY,
      label: "test",
      capabilities: [],
      createdAt: "2024-01-01T00:00:00.000Z"
    })),

    subscribe: (handler: (state: VaultLifecycleSnapshot) => void) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    // 单 Key 钱包没有切换入口；这个私有钩子只用来模拟「当前唯一 Key 换成了
    // 另一个身份」，验证编辑中的联系人页面会丢弃草稿。
    setActive,
  } as unknown as TestWalletState;
}

function makeFakeContactsService() {
  const addContact = vi.fn(async (input: { publicKeyHex: string; name: string; note?: string; tags?: string[] }): Promise<Contact> => ({
    publicKeyHex: input.publicKeyHex,
    name: input.name,
    note: input.note,
    tags: input.tags ?? [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z"
  }));
  return {
    listContacts: vi.fn(async () => []),
    addContact,
    updateContact: vi.fn(async (_id: string, _input: { publicKeyHex: string; name: string; note?: string; tags?: string[] }) => {
      throw new Error("not used in test");
    }),
    removeContact: vi.fn(async () => undefined),
    findByPublicKeyHex: vi.fn(async () => undefined),
    findByPublicKeyHexes: vi.fn(async () => []),
    onChange: () => () => undefined
  } as unknown as ContactsService;
}

function makeHost(service: ContactsService, walletState: VaultWalletState): PluginHost {
  const host = createPluginHost({

    initialI18nResources: [contactsResources]
  });
  host.provide(CONTACTS_SERVICE_CAPABILITY, service);
  host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState));
  return host;
}

describe("ContactsEditor", () => {
  afterEach(() => {
    cleanup();
  });

  it("在打开期间切换 active key 时立即关闭并清空", async () => {
    const service = makeFakeContactsService();
    const walletState = makeFakeWalletState();
    const host = makeHost(service, walletState);
    const onSaved = vi.fn();
    const onClose = vi.fn();

    const OwnedEditor = await bindTestContactsUi(host, ContactsEditor);
    function Wrapper() {
      const [open, setOpen] = useState(true);
      return (
        <OwnedEditor
          open={open}
          mode="create"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          onSaved={onSaved}
        />
      );
    }

    render(
      <PluginHostProvider host={host}>
        <Wrapper />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Contact publicKeyHex")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("Contact publicKeyHex"), {
      target: { value: "02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Alice" }
    });

    await act(async () => {
      walletState.setActive(NEXT_KEY);
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByText("Contact publicKeyHex")).toBeNull();
    });
    expect(service.addContact).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
  it("ignores a save completion after the contributing editor instance is revoked", async () => {
    const service = makeFakeContactsService();
    let finish!: (contact: Contact) => void;
    const pending = new Promise<Contact>(resolve => { finish = resolve; });
    const add = vi.fn(() => pending);
    service.addContact = add;
    const host = makeHost(service, makeFakeWalletState());
    const OwnedEditor = await bindTestContactsUi(host, ContactsEditor);
    const onSaved = vi.fn();
    render(<OwnedEditor open mode="create" onClose={() => {}} onSaved={onSaved} />);
    await screen.findByRole("button", { name: "Save" });
    const publicKeyHex = "03" + "cc".repeat(32);
    fireEvent.change(screen.getByLabelText("Contact publicKeyHex"), { target: { value: publicKeyHex } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pending contact" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(add).toHaveBeenCalledTimes(1);
    await act(() => host.revoke("contacts-ui-fixture", "editor revoked"));
    expect(screen.queryByLabelText("Contact publicKeyHex")).toBeNull();
    await act(async () => {
      finish({ publicKeyHex, name: "Pending contact", tags: [], createdAt: "now", updatedAt: "now" });
      await pending;
    });
    expect(onSaved).not.toHaveBeenCalled();
    await host.dispose();
  });

});
