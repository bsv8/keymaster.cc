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
import type { ActiveKeyState, Contact, ContactsService, KeyspaceService } from "@keymaster/contracts";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import type { PluginHost } from "@keymaster/runtime";
import { ContactsEditor } from "./ContactsEditor.js";
import { contactsResources } from "./manifest.js";

const INITIAL_KEY = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEXT_KEY = "02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeFakeKeyspace(): KeyspaceService {
  let active: ActiveKeyState = { activePublicKeyHex: INITIAL_KEY };
  const listeners = new Set<(state: ActiveKeyState) => void>();
  return {
    listKeys: async () => [],
    getKey: async () => undefined,
    active: () => active,
    setActive: async (publicKeyHex: string) => {
      active = { activePublicKeyHex: publicKeyHex };
      for (const listener of listeners) listener(active);
    },
    requireActiveKey: () => ({
      publicKeyHex: INITIAL_KEY,
      label: "test",
      capabilities: [],
      createdAt: "2024-01-01T00:00:00.000Z"
    }),
    onActiveChange: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    openKeyStorage: async () => {
      throw new Error("not used in test");
    },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  };
}

function makeFakeContactsService() {
  const addContact = vi.fn(async (input: { publicKeyHex: string; name: string; note?: string; tags?: string[] }): Promise<Contact> => ({
    id: "contact-1",
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

function makeHost(service: ContactsService, keyspace: KeyspaceService): PluginHost {
  const host = createPluginHost({
    disableConfigPersistence: true,
    initialI18nResources: [contactsResources]
  });
  host.capabilities.provide("contacts.service", service);
  host.capabilities.provide("keyspace.service", keyspace);
  return host;
}

describe("ContactsEditor", () => {
  afterEach(() => {
    cleanup();
  });

  it("在打开期间切换 active key 时立即关闭并清空", async () => {
    const service = makeFakeContactsService();
    const keyspace = makeFakeKeyspace();
    const host = makeHost(service, keyspace);
    const onSaved = vi.fn();
    const onClose = vi.fn();

    function Wrapper() {
      const [open, setOpen] = useState(true);
      return (
        <ContactsEditor
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
      await keyspace.setActive(NEXT_KEY);
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
});
