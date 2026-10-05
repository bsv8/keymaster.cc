import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginConsumerProvider } from "webloom-framework/react";
import { CONTACTS_SERVICE_CAPABILITY, CONTACTS_EDITOR_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY,
  PAGE_UI_RENDERER_CAPABILITY, CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY, CONTACTS_PRESENCE_READER_CAPABILITY,
  type ContactPresenceMap,
  defineRuntimeUnitDependencies, type PluginContext, type PluginManifest } from "@keymaster/contracts";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";
import { contactsPlugin, contactsSetup } from "@keymaster/plugin-contacts";

import { createInMemoryModuleFileStore } from "@keymaster/runtime/storage";

const OWNER = "02" + "11".repeat(32);
const CONTACT = "03" + "22".repeat(32);
const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { cleanup(); await Promise.all(hosts.splice(0).map(host => host.dispose())); });
async function fixture() {
  const stores: ReturnType<typeof createInMemoryModuleFileStore>[] = [];
  let caller!: PluginContext;
  let presence: ContactPresenceMap = {};
  const topicListeners = new Map<string, Set<() => void>>();
  const callerPlugin: PluginManifest = { id: "contacts-caller", name: "Contacts caller",
    units: [{ id: "contacts-caller.window", runtime: "window-main", scopeKind: "owner-session",
      dependencies: defineRuntimeUnitDependencies([{ capability: CONTACTS_EDITOR_CAPABILITY }, { capability: CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY }]),
    }],
  };
  const host = createKeymasterPluginHost({ fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry", "contacts.public-key-action.registry"], runtime: "window-main",
    initialRuntimeIdentity: { vaultStatus: "unlocked", ownerPublicKeyHex: OWNER, sessionEpoch: "contacts:1", walletGeneration: "contacts:1" },
    coordinatorForPlugin: id => id === "contacts" ? {
      contactsPresenceSnapshot: async () => ({ status: "ok", value: presence }),
      subscribeTopic: (topic: string, listener: () => void) => {
        const listeners = topicListeners.get(topic) ?? new Set<() => void>();
        topicListeners.set(topic, listeners); listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    } : undefined,
    storageBindingAuthority: {
      openOwnerAppStore: async () => { throw new Error("No K-V in contacts fixture"); },
      openOwnerFileStore: async () => { const files = createInMemoryModuleFileStore(); stores.push(files); return files; },
      openPlatformStore: async () => { throw new Error("No platform store in contacts fixture"); },
      clearStorageRoot: async () => {},
    },
    runtimeUnitImplementationRegistry: { get: id => id === "page" ? pageSetup : id === "contacts" ? contactsSetup : ctx => { caller = ctx; } },
  });
  hosts.push(host);
  host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess({ snapshot: () => walletStateFixtureSnapshot((() => ({ activePublicKeyHex: OWNER }))(), () => ({ publicKeyHex: OWNER, label: "Owner", capabilities: [], createdAt: "now" })),
     subscribe: () => () => {},
  }));
  await host.registerAll([callerPlugin, contactsPlugin, pagePlugin]);
  expect(host.state("contacts").kind).toBe("enabled");
  expect(host.state("contacts-caller").kind).toBe("enabled");
  return { host, stores, caller, setPresence: (next: ContactPresenceMap) => { presence = next; for (const listener of topicListeners.get("contacts.presence") ?? []) listener(); }, presenceListenerCount: () => topicListeners.get("contacts.presence")?.size ?? 0, service: host.capabilities.get(CONTACTS_SERVICE_CAPABILITY), pages: host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY) };
}

it("registers Contacts pages only through Page and keeps CRUD, detail and actions reactive without an App provider", async () => {
  const { host, stores, service, pages, caller } = await fixture();
  expect(host.routes.byPath("/contacts")).toBeUndefined();
  expect(host.routes.byPath("/contacts/:id")).toBeUndefined();
  const list = pages.renderPage("/contacts");
  const detail = pages.renderPage(`/contacts/${CONTACT}?source=transfer`);
  render(<>{list}{detail}</>);
  await waitFor(() => expect(screen.getByRole("button", { name: "New" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  await screen.findByRole("button", { name: "Save" });
  fireEvent.change(screen.getByLabelText("Contact publicKeyHex"), { target: { value: CONTACT } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Bob" })).toBeTruthy());
  expect(await screen.findByRole("link", { name: "Bob" })).toBeTruthy();
  expect(stores).toHaveLength(1);
  expect(stores.some(store => store.snapshot().has(`${CONTACT}.json`))).toBe(true);
  const actions = caller.capability(CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY);
  const runAction = vi.fn();
  act(() => actions.register({ id: "fixture.action", label: "Fixture action", order: 1, run: runAction }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Fixture action" })).toHaveLength(2));
  const cachedButton = screen.getAllByRole("button", { name: "Fixture action" })[0]!;
  fireEvent.click(cachedButton);
  await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(cachedButton.hasAttribute("disabled")).toBe(false));
  runAction.mockClear();
  act(() => {
    actions.unregister("fixture.action");
    // Exercise the old snapshot before the asynchronous resource reload completes.
    fireEvent.click(cachedButton);
  });
  expect(runAction).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Fixture action" })).toBeNull());
  await act(() => service.removeContact(CONTACT));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Bob" })).toBeNull());
  expect(await screen.findByText("Contact not found")).toBeTruthy();
  await act(() => host.revoke("contacts", "owner removed"));
  expect(pages.hasPage("/contacts")).toBe(false);
  expect(pages.hasPage(`/contacts/${CONTACT}`)).toBe(false);
  expect(document.querySelector(".contacts-page")).toBeNull();
  expect(document.querySelector(".contact-detail")).toBeNull();
});

it("exports an editor bound to Contacts rather than the caller's undeclared service and removes cached UI on revoke", async () => {
  const { host, caller, service } = await fixture();
  expect(() => caller.capability(CONTACTS_SERVICE_CAPABILITY)).toThrow();
  const Editor = caller.capability(CONTACTS_EDITOR_CAPABILITY);
  let saved: ReactNode = null;
  render(createElement(PluginConsumerProvider, { consumer: caller.consumer,
    children: <Editor open mode="create" onClose={() => {}} onSaved={contact => { saved = contact.name; }} />,
  }));
  await screen.findByRole("button", { name: "Save" });
  fireEvent.change(screen.getByLabelText("Contact publicKeyHex"), { target: { value: CONTACT } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "External editor" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toBe("External editor"));
  expect((await service.listContacts())[0]?.name).toBe("External editor");
  await act(() => host.revoke("contacts", "contacts unavailable"));
  expect(screen.queryByLabelText("Contact publicKeyHex")).toBeNull();
  expect(caller.consumer.status).not.toBe("active");
});

it("publishes a read-only Worker presence projection filtered to saved contacts and fences its old reader", async () => {
  const { host, caller, service, setPresence, presenceListenerCount } = await fixture();
  await service.addContact({ publicKeyHex: CONTACT, name: "Peer" });
  const unknown = "03" + "33".repeat(32);
  const reader = host.capabilities.get(CONTACTS_PRESENCE_READER_CAPABILITY);
  expect(() => caller.capability(CONTACTS_PRESENCE_READER_CAPABILITY)).toThrow();
  expect(Object.keys(reader).sort()).toEqual(["snapshot", "subscribe"]);
  const changed = vi.fn();
  const off = reader.subscribe(changed);
  setPresence({ [CONTACT]: { publicKeyHex: CONTACT, state: "online" }, [unknown]: { publicKeyHex: unknown, state: "online" } });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(await reader.snapshot()).toEqual({ [CONTACT]: { publicKeyHex: CONTACT, state: "online" } });
  expect(presenceListenerCount()).toBe(1);
  await host.revoke("contacts", "presence owner ended");
  expect(presenceListenerCount()).toBe(0);
  await expect(reader.snapshot()).rejects.toThrow();
  expect(() => reader.subscribe(() => {})).toThrow();
  expect(() => off()).not.toThrow();
});
