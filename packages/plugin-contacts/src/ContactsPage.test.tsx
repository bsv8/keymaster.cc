// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  ActiveKeyState,
  Contact,
  ContactsService,
  KeyspaceService,
  PluginManifest,
  ResourceRegistry
} from "@keymaster/contracts";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
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
    setActive: async () => undefined,
    requireActiveKey: () => ({ publicKeyHex: OWNER, label: "test", capabilities: [], createdAt: "now" }),
    onActiveKeyChanged: () => () => undefined, openKeyStorage: async () => { throw new Error("unused"); },
    registerPluginStorage: () => undefined, listPluginStorages: () => [], prepareDeleteKey: async () => undefined,
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

describe("ContactsPage public-key actions", () => {
  afterEach(cleanup);

  it("shows Message only while message is enabled, while Transfer remains after its owner is removed", async () => {
    const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [contactsResources] });
    host.provide("keyspace.service", keyspace());
    host.provide("contacts.service", contacts());
    const actionPlugin = (id: string, actionId: string, label: string, order: number): PluginManifest => ({
      id, name: id,
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true, displayGroup: "business" },
      dependencies: [{ capability: "contacts.public-key-action.registry", reason: "register contact action" }],
      setup(ctx) {
        ctx.get<import("@keymaster/contracts").ContactPublicKeyActionRegistry>("contacts.public-key-action.registry").register({
          id: actionId, label, order, run: () => undefined
        });
      }
    });
    await host.register(actionPlugin("transfer", "transfer.to-contact", "Transfer", 10));
    await host.register(actionPlugin("message", "message.to-contact", "Message", 20));
    const resources = host.capabilities.get<ResourceRegistry>("resource.registry");
    resources.register({
      id: "contacts.list", scope: "active-key", key: (_args: readonly string[], context) => ["contacts.list", context.activePublicKeyHex ?? "none"],
      load: async () => [CONTACT], subscribe: () => () => undefined, invalidation: "immediate"
    });

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
