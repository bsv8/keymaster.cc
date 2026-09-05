// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ActiveKeyState, Contact, ContactPresenceMap, KeyspaceService, ResourceRegistry } from "@keymaster/contracts";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import { ContactDetailPage } from "./ContactDetailPage.js";
import { contactsResources } from "./manifest.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTACT: Contact = {
  id: "contact-1",
  publicKeyHex: "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  name: "Bob Stone",
  note: "Trusted contact for project work.",
  tags: ["friend", "project"],
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-08-10T12:30:00.000Z"
};

function keyspace(): KeyspaceService {
  const state: ActiveKeyState = { activePublicKeyHex: OWNER };
  return {
    listKeys: async () => [], getKey: async () => undefined, active: () => state,
    selected: () => state.activePublicKeyHex, setActive: async () => undefined,
    requireActiveKey: () => ({ publicKeyHex: OWNER, label: "test", capabilities: [], createdAt: "now" }),
    onActiveKeyChanged: () => () => undefined, prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined, isInitializing: () => false, onInitializationChange: () => () => undefined
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

describe("ContactDetailPage", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("renders a structured, extensible contact info view", async () => {
    const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [contactsResources] });
    host.provide("keyspace.service", keyspace());
    const resources = host.capabilities.get<ResourceRegistry>("resource.registry");
    resources.register({
      id: "contacts.detail",
      scope: "active-key",
      key: (args: readonly string[], context) => ["contacts.detail", context.activePublicKeyHex ?? "none", args[0] ?? ""],
      load: async () => CONTACT,
      subscribe: () => () => undefined,
      invalidation: "immediate"
    });
    registerPresenceResource(resources);
    window.history.pushState({}, "", "/contacts/contact-1");

    const { container } = render(
      <PluginHostProvider host={host}>
        <ContactDetailPage />
      </PluginHostProvider>
    );

    expect(await screen.findByRole("heading", { name: "Bob Stone", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Identity", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Contact details", level: 2 })).toBeTruthy();
    expect(screen.getByText(CONTACT.publicKeyHex)).toBeTruthy();
    expect(screen.getByText("Trusted contact for project work.")).toBeTruthy();
    expect(screen.getByText("friend")).toBeTruthy();
    expect(screen.getByText("project")).toBeTruthy();
    expect(container.querySelector(`time[datetime="${CONTACT.createdAt}"]`)).toBeTruthy();
    expect(container.querySelector(`time[datetime="${CONTACT.updatedAt}"]`)).toBeTruthy();
    expect(screen.queryByText("short:")).toBeNull();
  });
});
