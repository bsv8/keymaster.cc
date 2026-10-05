import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { bindTestContactsUi, createContactsTestHost as createPluginHost } from "./contactsUi.testSupport.js";
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  CONTACTS_SERVICE_CAPABILITY,
  CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY,
  VAULT_WALLET_STATE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  type VaultLifecycleSnapshot,
  type Contact,
  type ContactsService,
  type ContactPresenceMap,
  type VaultWalletState,
  type PluginManifest,
  type PluginSetup,
  type ResourceRegistry,
} from "@keymaster/contracts";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import { ContactsPage } from "./ContactsPage.js";
import { contactsResources } from "./manifest.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTACT: Contact = {
  publicKeyHex: "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Bob", tags: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};

function walletState(): VaultWalletState {
  const state: VaultLifecycleSnapshot = walletStateFixtureSnapshot({ activePublicKeyHex: OWNER });
  return {
    snapshot: () => walletStateFixtureSnapshot((() => state)(), () => ({ publicKeyHex: OWNER, label: "test", capabilities: [], createdAt: "now" })),

    subscribe: () => () => undefined
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
    const host = createPluginHost({  initialI18nResources: [contactsResources] });
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState()));
    host.provide(CONTACTS_SERVICE_CAPABILITY, contacts());
    const OwnedPage = await bindTestContactsUi(host, ContactsPage, resources => {
    resources.register({
      id: "contacts.list", scope: "active-key", key: (_args: readonly string[], context) => ["contacts.list", context.activePublicKeyHex ?? "none"],
      load: async () => [CONTACT], subscribe: () => () => undefined, invalidation: "immediate"
    });
    registerPresenceResource(resources);
    });
    window.history.pushState({}, "", "/contacts");

    render(<PluginHostProvider host={host}><OwnedPage /></PluginHostProvider>);
    fireEvent.click(await screen.findByRole("link", { name: "Bob" }));

    await waitFor(() => expect(window.location.pathname).toBe(`/contacts/${CONTACT.publicKeyHex}`));
  });

  it("updates contact actions on contributor revocation and retry", async () => {
    const setups = new Map<string, PluginSetup>();
    const host = createPluginHost({

      initialI18nResources: [contactsResources],
      runtimeUnitImplementationRegistry: { get: (pluginId) => setups.get(pluginId) },
    });
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState()));
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
    const OwnedPage = await bindTestContactsUi(host, ContactsPage, resources => {
    resources.register({
      id: "contacts.list", scope: "active-key", key: (_args: readonly string[], context) => ["contacts.list", context.activePublicKeyHex ?? "none"],
      load: async () => [CONTACT], subscribe: () => () => undefined, invalidation: "immediate"
    });
    registerPresenceResource(resources);
    });

    render(<PluginHostProvider host={host}><OwnedPage /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Transfer" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Message" })).toBeTruthy();

    await host.revoke("message", "test revocation");
    expect(host.contactPublicKeyActions.get("message.to-contact")).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Message" })).toBeNull());
    expect(screen.getByRole("button", { name: "Transfer" })).toBeTruthy();

    await host.retry("message");
    await waitFor(() => expect(screen.getByRole("button", { name: "Message" })).toBeTruthy());
    await host.unregister("message");
    expect(host.contactPublicKeyActions.get("message.to-contact")).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Message" })).toBeNull());
    expect(screen.getByRole("button", { name: "Transfer" })).toBeTruthy();
  });
});
