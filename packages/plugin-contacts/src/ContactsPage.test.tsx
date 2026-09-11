// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  CONTACTS_SERVICE_CAPABILITY,
  CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  type ActiveKeyState,
  type Contact,
  type ContactsService,
  type ContactPresenceMap,
  type KeyspaceService,
  type PluginManifest,
  type PluginSetup,
  type ResourceRegistry,
} from "@keymaster/contracts";
import { createKeymasterPluginHost as createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import { ContactsPage } from "./ContactsPage.js";
import { contactsResources } from "./manifest.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTACT: Contact = {
  id: "contact-1", publicKeyHex: "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Bob", tags: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};

function keyspace(): KeyspaceService {
  const state: ActiveKeyState = { activePublicKeyHex: OWNER };
  return {
    listKeys: async () => [], getKey: async () => undefined, active: () => state,
    selected: () => state.activePublicKeyHex,
    setActive: async () => undefined,
    requireActiveKey: () => ({ publicKeyHex: OWNER, label: "test", capabilities: [], createdAt: "now" }),
    onActiveKeyChanged: () => () => undefined, prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined, isInitializing: () => false, onInitializationChange: () => () => undefined
  };
}

function contacts(): ContactsService {
  return {
    listContacts: async () => [CONTACT], addContact: async () => CONTACT, updateContact: async () => CONTACT,
    removeContact: async () => undefined, findByPublicKeyHex: async () => CONTACT,
    findByPublicKeyHexes: async () => [CONTACT], onChange: () => () => undefined
  };
}

function registerPresenceResource(resources: ResourceRegistry): void {
  resources.register<ContactPresenceMap, readonly string[]>({
    id: "contacts.presence",
    scope: "active-key",
    key: (_args, context) => ["contacts.presence", context.activePublicKeyHex ?? "none"],
    load: async () => ({}),
    subscribe: () => () => undefined,
    invalidation: "immediate"
  });
}

describe("ContactsPage public-key actions", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("opens the contact detail page when the contact name is clicked", async () => {
    const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [contactsResources] });
    host.provide(KEYSPACE_SERVICE_CAPABILITY, keyspace());
    host.provide(CONTACTS_SERVICE_CAPABILITY, contacts());
    const resources = host.capabilities.get(RESOURCE_REGISTRY_CAPABILITY);
    resources.register({
      id: "contacts.list", scope: "active-key", key: (_args: readonly string[], context) => ["contacts.list", context.activePublicKeyHex ?? "none"],
      load: async () => [CONTACT], subscribe: () => () => undefined, invalidation: "immediate"
    });
    registerPresenceResource(resources);
    window.history.pushState({}, "", "/contacts");

    render(<PluginHostProvider host={host}><ContactsPage /></PluginHostProvider>);
    fireEvent.click(await screen.findByRole("link", { name: "Bob" }));

    await waitFor(() => expect(window.location.pathname).toBe("/contacts/contact-1"));
  });

  it("shows Message only while message is enabled, while Transfer remains after its owner is removed", async () => {
    const setups = new Map<string, PluginSetup>();
    const host = createPluginHost({
      disableConfigPersistence: true,
      initialI18nResources: [contactsResources],
      runtimeUnitImplementationRegistry: { get: (pluginId) => setups.get(pluginId) },
    });
    host.provide(KEYSPACE_SERVICE_CAPABILITY, keyspace());
    host.provide(CONTACTS_SERVICE_CAPABILITY, contacts());
    const actionPlugin = (id: string, actionId: string, label: string, order: number): PluginManifest => {
      const setup: PluginSetup = (ctx) => {
        ctx.capability(CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY).register({
          id: actionId, label, order, run: () => undefined
        });
      };
      setups.set(id, setup);
      return {
        id, name: id,
        kind: "business", startup: "optional", defaultEnabled: true, canDisable: true,
        bootstrapStage: "owner-apps-ready", displayGroup: "business",
        units: [{
          id,
          runtime: "window-main",
          scopeKind: "root",
          dependencies: [{ capability: CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "register contact action" }],
        }],
      };
    };
    await host.register(actionPlugin("transfer", "transfer.to-contact", "Transfer", 10));
    await host.register(actionPlugin("message", "message.to-contact", "Message", 20));
    const resources = host.capabilities.get(RESOURCE_REGISTRY_CAPABILITY);
    resources.register({
      id: "contacts.list", scope: "active-key", key: (_args: readonly string[], context) => ["contacts.list", context.activePublicKeyHex ?? "none"],
      load: async () => [CONTACT], subscribe: () => () => undefined, invalidation: "immediate"
    });
    registerPresenceResource(resources);

    render(<PluginHostProvider host={host}><ContactsPage /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Transfer" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Message" })).toBeTruthy();

    await host.disable("message");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Message" })).toBeNull());
    expect(screen.getByRole("button", { name: "Transfer" })).toBeTruthy();

    await host.enable("message");
    await waitFor(() => expect(screen.getByRole("button", { name: "Message" })).toBeTruthy());
    await host.unregister("message");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Message" })).toBeNull());
    expect(screen.getByRole("button", { name: "Transfer" })).toBeTruthy();
  });
});
