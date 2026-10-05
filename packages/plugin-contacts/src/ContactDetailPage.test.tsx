import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { bindTestContactsUi, createContactsTestHost as createPluginHost } from "./contactsUi.testSupport.js";
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  VAULT_WALLET_STATE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  type VaultLifecycleSnapshot,
  type Contact,
  type ContactPresenceMap,
  type VaultWalletState,
  type ResourceRegistry,
} from "@keymaster/contracts";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import { ContactDetailPage } from "./ContactDetailPage.js";
import { contactsResources } from "./manifest.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTACT: Contact = {
  publicKeyHex: "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  name: "Bob Stone",
  note: "Trusted contact for project work.",
  tags: ["friend", "project"],
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-08-10T12:30:00.000Z"
};

function walletState(): VaultWalletState {
  const state: VaultLifecycleSnapshot = walletStateFixtureSnapshot({ activePublicKeyHex: OWNER });
  return {
    snapshot: () => walletStateFixtureSnapshot((() => state)(), () => ({ publicKeyHex: OWNER, label: "test", capabilities: [], createdAt: "now" })),

    subscribe: () => () => undefined
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
    const host = createPluginHost({  initialI18nResources: [contactsResources] });
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState()));
    const OwnedDetail = await bindTestContactsUi(host, ContactDetailPage, resources => {
    resources.register({
      id: "contacts.detail",
      scope: "active-key",
      key: (args: readonly string[], context) => ["contacts.detail", context.activePublicKeyHex ?? "none", args[0] ?? ""],
      load: async () => CONTACT,
      subscribe: () => () => undefined,
      invalidation: "immediate"
    });
    registerPresenceResource(resources);
    });
    window.history.pushState({}, "", `/contacts/${CONTACT.publicKeyHex}`);

    const { container } = render(
      <PluginHostProvider host={host}>
        <OwnedDetail location={{ path: `/contacts/${CONTACT.publicKeyHex}`, params: { id: CONTACT.publicKeyHex } }} />
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
  it("keeps a pending detail distinct from missing data and reports a load failure", async () => {
    const host = createPluginHost({ initialI18nResources: [contactsResources] });
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess(walletState()));
    let rejectLoad!: (error: Error) => void;
    const pending = new Promise<Contact>((_resolve, reject) => { rejectLoad = reject; });
    const OwnedDetail = await bindTestContactsUi(host, ContactDetailPage, resources => {
      resources.register({ id: "contacts.detail", scope: "active-key",
        key: (args: readonly string[], context) => ["contacts.detail", context.activePublicKeyHex ?? "none", args[0] ?? ""],
        load: () => pending, invalidation: "immediate" });
      registerPresenceResource(resources);
    });
    render(<OwnedDetail location={{ path: `/contacts/${CONTACT.publicKeyHex}`, params: { id: CONTACT.publicKeyHex } }} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("Contact not found")).toBeNull();
    await act(async () => { rejectLoad(new Error("fixture storage failure")); });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Failed to load contact");
    expect(screen.queryByText("Contact not found")).toBeNull();
    expect(screen.queryByText("fixture storage failure")).toBeNull();
    await host.dispose();
  });

});
