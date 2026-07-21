// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActiveKeyState, CollectibleProvider, CollectibleSummary, CollectibleTransferHandler, KeyspaceService, PluginManifest, TransferOffer, TransferProvider } from "@keymaster/contracts";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import { createTransferFeatureCapability } from "./transferFeature.js";
import { TransferPage } from "./TransferPage.js";
import { transferPlugin } from "./manifest.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fakeKeyspace(): KeyspaceService {
  const state: ActiveKeyState = { activePublicKeyHex: OWNER };
  return {
    listKeys: async () => [], getKey: async () => undefined, active: () => state,
    setActive: async () => undefined, requireActiveKey: () => ({ publicKeyHex: OWNER, label: "test", capabilities: [], createdAt: "now" }),
    onActiveKeyChanged: () => () => undefined, openKeyStorage: async () => { throw new Error("unused"); },
    registerPluginStorage: () => undefined, listPluginStorages: () => [], prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined, isInitializing: () => false, onInitializationChange: () => () => undefined
  };
}

function offer(id: string, section: TransferOffer["recipientTargetSection"]): TransferOffer {
  return { id, providerId: "test", assetProviderId: "test", assetId: id, label: id, status: "ready", recipientTargetSection: section };
}

function provider(offers: TransferOffer[]): TransferProvider {
  return {
    id: "test", name: { key: "test", fallback: "Test" }, component: () => null,
    listOffers: async () => offers, onChange: () => () => undefined,
    supportsRecipientPublicKeyHex: () => true
  };
}

function renderPage(offers: TransferOffer[] = [], collectibles: CollectibleSummary[] = [], registerInitialHandler = true, withContactPicker = false) {
  const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [transferPlugin.i18n!] });
  host.provide("keyspace.service", fakeKeyspace());
  host.provide("feature.transfer", createTransferFeatureCapability());
  if (withContactPicker) {
    host.provide("contacts.picker", ({ onChange }: { value?: string; onChange: (publicKeyHex: string) => void }) => (
      <label>Contacts<select aria-label="Contacts" onChange={(event) => onChange(event.currentTarget.value)}><option value="">Select a contact</option><option value={OWNER}>Alice</option></select></label>
    ));
  }
  host.transfers.register(provider(offers));
  if (collectibles.length > 0) {
    const collectibleProvider: CollectibleProvider = {
      id: "collectibles-test", name: { key: "collectibles-test", fallback: "Collectibles test" },
      listCollectibles: async () => collectibles, getCollectible: async () => undefined,
      listActivity: async () => [], sync: async () => undefined, onChange: () => () => undefined
    };
    const handler: CollectibleTransferHandler = {
      id: "collectible-handler-test", name: { key: "handler-test", fallback: "Handler" }, order: 1,
      supports: () => true, supportsRecipientPublicKeyHex: () => true, component: () => null
    };
    host.collectibles.register(collectibleProvider);
    if (registerInitialHandler) host.collectibleTransfer.register(handler);
  }
  const resources = host.capabilities.get<import("@keymaster/contracts").ResourceRegistry>("resource.registry");
  resources.register<TransferOffer[], readonly string[]>({ id: "transfer.offers", scope: "global", key: () => ["transfer.offers"], load: async () => offers, subscribe: () => () => undefined, invalidation: "immediate" });
  resources.register<ActiveKeyState, readonly string[]>({ id: "transfer.active-key", scope: "global", key: () => ["transfer.active-key"], load: async () => ({ activePublicKeyHex: OWNER }), subscribe: () => () => undefined, invalidation: "immediate" });
  resources.register<Array<{ providerId: string; items: CollectibleSummary[] }>, readonly string[]>({ id: "transfer.recipient-collectibles", scope: "active-key", key: (_args, context) => ["transfer.recipient-collectibles", context.activePublicKeyHex ?? "none"], load: async () => collectibles.length > 0 ? [{ providerId: "collectibles-test", items: collectibles }] : [], subscribe: () => () => undefined, invalidation: "immediate" });
  return { host, ...render(<PluginHostProvider host={host}><TransferPage /></PluginHostProvider>) };
}

describe("TransferPage recipient target", () => {
  afterEach(() => { cleanup(); window.history.replaceState({}, "", "/transfer"); });

  it("shows the recipient before a compact, provider-declared asset type grid", async () => {
    window.history.replaceState({}, "", `/transfer?recipientPublicKeyHex=${OWNER}`);
    renderPage([offer("main", "mainnet"), offer("test", "testnet"), offer("other", "other-assets")]);
    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
    expect(screen.getByText("Recipient")).toBeTruthy();
    expect(screen.getByText("Asset type")).toBeTruthy();
    expect(screen.getByText("test")).toBeTruthy();
    expect(screen.getByText("other")).toBeTruthy();
    expect(screen.getByTestId("recipient-target").dataset.recipientPublicKeyHex).toBe(OWNER);
    expect(screen.queryByText("Collectibles")).toBeNull();
  });

  it("uses a selected contact public key as the URL recipient target before choosing an asset", async () => {
    renderPage([offer("main", "mainnet")], [], true, true);
    const recipient = await screen.findByText("Recipient");
    const assetType = screen.getByText("Asset type");
    expect(recipient.compareDocumentPosition(assetType) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Contacts"), { target: { value: OWNER } });
    expect(window.location.pathname + window.location.search).toBe(`/transfer?recipientPublicKeyHex=${OWNER}`);
  });

  it("shows target empty state and clears only the target query", async () => {
    window.history.replaceState({}, "", `/transfer?recipientPublicKeyHex=${OWNER}`);
    renderPage();
    await waitFor(() => expect(screen.getByText("No asset can transfer to this contact public key")).toBeTruthy());
    fireEvent.click(screen.getByText("Clear target and browse all assets"));
    expect(window.location.pathname + window.location.search).toBe("/transfer");
  });

  it("keeps the target public key when entering collectible transfer", async () => {
    window.history.replaceState({}, "", `/transfer?recipientPublicKeyHex=${OWNER}`);
    renderPage([], [{ collectibleId: "ordinal-1", providerId: "collectibles-test", name: "Ordinal 1", status: "ready" }]);
    await waitFor(() => expect(screen.getByText("Ordinal 1")).toBeTruthy());
    fireEvent.click(screen.getByText("Ordinal 1"));
    expect(window.location.pathname).toBe("/collectibles/transfer");
    expect(new URLSearchParams(window.location.search).get("providerId")).toBe("collectibles-test");
    expect(new URLSearchParams(window.location.search).get("collectibleId")).toBe("ordinal-1");
    expect(new URLSearchParams(window.location.search).get("recipientPublicKeyHex")).toBe(OWNER);
  });

  it("refreshes the collectible section when a handler is registered and unregistered at runtime", async () => {
    window.history.replaceState({}, "", `/transfer?recipientPublicKeyHex=${OWNER}`);
    const { host } = renderPage([offer("main", "mainnet")], [{ collectibleId: "ordinal-1", providerId: "collectibles-test", name: "Ordinal 1", status: "ready" }], false);
    await waitFor(() => expect(screen.queryByText("Collectibles")).toBeNull());
    const runtimeHandler: CollectibleTransferHandler = {
      id: "runtime-handler", name: "Runtime handler", order: 1,
      supports: () => true, supportsRecipientPublicKeyHex: () => true, component: () => null
    };
    const handlerPlugin: PluginManifest = {
      id: "runtime-handler-plugin", name: "Runtime handler plugin",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true, displayGroup: "business" },
      dependencies: [{ capability: "collectible-transfer.registry", reason: "register test handler" }],
      setup(ctx) { ctx.get<import("@keymaster/contracts").CollectibleTransferRegistry>("collectible-transfer.registry").register(runtimeHandler); }
    };
    await host.register(handlerPlugin);
    await waitFor(() => expect(screen.getByText("Ordinal 1")).toBeTruthy());
    await host.unregister("runtime-handler-plugin");
    await waitFor(() => expect(screen.queryByText("Collectibles")).toBeNull());
  });

  it("does not render a contact-target collectibles section for ordinary /transfer", async () => {
    renderPage([offer("main", "mainnet")], [{ collectibleId: "ordinal-1", providerId: "collectibles-test", name: "Ordinal 1", status: "ready" }]);
    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
    expect(screen.queryByText("Collectibles")).toBeNull();
    expect(screen.queryByText("Ordinal 1")).toBeNull();
  });
});
