import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CHANNEL_RUNTIME_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, MESSAGE_SERVICE_CAPABILITY,
  OWNED_RESOURCE_ACCESS_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY,
  CONTACTS_PRESENCE_READER_CAPABILITY, CONTACTS_SERVICE_CAPABILITY, WEBRTC_SERVICE_CAPABILITY,
  type ChannelRuntime, type PluginContext, type PluginManifest, type WebrtcMessageService,
  type WebrtcSessionSnapshot, type WebrtcHistoryItem } from "@keymaster/contracts";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";
import { contactsPlugin, contactsSetup } from "@keymaster/plugin-contacts";
import { messagePlatformPlugin, messageSetup } from "@keymaster/plugin-message";

import { createInMemoryModuleFileStore } from "@keymaster/runtime/storage";
const OWNER = "02" + "11".repeat(32);
const PEER = "03" + "22".repeat(32);
const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { cleanup(); await Promise.all(hosts.splice(0).map(host => host.dispose())); });
async function fixture() {
  let context!: PluginContext;
  let online = true;
  const presenceListeners = new Set<() => void>();
  const rtcListeners = new Set<(snapshot: WebrtcSessionSnapshot) => void>();
  const snapshot: WebrtcSessionSnapshot = { phase: "idle", remotePublicKeyHex: null, direction: null, mode: null,
    hasLocalStream: false, hasRemoteStream: false, remoteNotice: null, serviceReady: true, lastError: null };
  let history: WebrtcHistoryItem[] = [];
  const loadHistory = vi.fn(async () => history);
  const rtc: WebrtcMessageService = { snapshot: () => snapshot,
    subscribe: listener => { rtcListeners.add(listener); return () => { rtcListeners.delete(listener); }; },
    listHistoryForPeer: loadHistory, getTransferBlob: async () => null, startCall: vi.fn(async () => {}),
    sendImage: async () => {}, sendFile: async () => {}, acceptIncoming: async () => {}, rejectIncoming: async () => {},
    hangup: async () => {}, attachToVideo: () => () => {},
  };
  const presence: PluginManifest = { id: "presence-fixture", name: "Presence fixture", units: [{ id: "presence-fixture.window",
    runtime: "window-main", scopeKind: "root", provides: [CONTACTS_PRESENCE_READER_CAPABILITY] }] };
  const webrtc: PluginManifest = { id: "rtc-fixture", name: "RTC fixture", units: [{ id: "rtc-fixture.window",
    runtime: "window-main", scopeKind: "root", provides: [WEBRTC_SERVICE_CAPABILITY] }] };
  const channel = { isReady: () => true, subscribePrivate: () => () => {}, subscriptionSet: async () => ({}) } as unknown as ChannelRuntime;
  const host = createKeymasterPluginHost({ fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry"], runtime: "window-main",
    initialRuntimeIdentity: { vaultStatus: "unlocked", ownerPublicKeyHex: OWNER, sessionEpoch: "message:1", walletGeneration: "message:1" },
    coordinatorForPlugin: id => id === "contacts" ? { contactsPresenceSnapshot: async () => ({ status: "ok", value: {} }), subscribeTopic: () => () => {} } : undefined,
    storageBindingAuthority: { openOwnerFileStore: async () => createInMemoryModuleFileStore(),
      openOwnerAppStore: async () => { throw new Error("No K-V in message fixture"); },
      openPlatformStore: async () => { throw new Error("No platform storage in message fixture"); }, clearStorageRoot: async () => {},
    }, runtimeUnitImplementationRegistry: { get: id => id === "page" ? pageSetup : id === "contacts" ? contactsSetup : id === "message" ? ctx => {
      context = ctx; return messageSetup(ctx);
    } : id === "presence-fixture" ? ctx => { ctx.provide(CONTACTS_PRESENCE_READER_CAPABILITY, {
      snapshot: async () => ({ [PEER]: { publicKeyHex: PEER, state: online ? "online" : "offline" } }),
      subscribe: listener => { presenceListeners.add(listener); return () => { presenceListeners.delete(listener); }; },
    }); } : ctx => { ctx.provide(WEBRTC_SERVICE_CAPABILITY, rtc); } },
  });
  hosts.push(host);
  host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess({ snapshot: () => walletStateFixtureSnapshot((() => ({ activePublicKeyHex: OWNER }))(), () => ({ publicKeyHex: OWNER, label: "Owner", capabilities: [], createdAt: "now" })),
     subscribe: () => () => {},
  }));
  host.provide(CHANNEL_RUNTIME_CAPABILITY, { forPlugin: () => channel, forSystem: () => channel });
  const foreignLoad = vi.fn(async () => { throw new Error("Message must not read another plugin's resource"); });
  for (const id of ["contacts.presence", "webrtc.session", "webrtc.peer-history"]) {
    host.capabilities.get(RESOURCE_REGISTRY_CAPABILITY).register({ id, scope: "global", key: () => [id], load: foreignLoad, invalidation: "immediate" });
  }
  await host.registerAll([messagePlatformPlugin, pagePlugin]);
  expect(host.state("message").kind).toBe("enabled");
  const pages = host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY);
  const resources = context.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(context.consumer, context.scope);
  return { host, pages, context, resources, rtc, foreignLoad, presence, webrtc, loadHistory,
    changePresence: (next: boolean) => { online = next; for (const listener of presenceListeners) listener(); },
    changeHistory: (next: WebrtcHistoryItem[]) => { history = next; for (const listener of rtcListeners) listener(snapshot); },
    counts: () => [presenceListeners.size, rtcListeners.size],
  };
}

it("mounts list and both detail paths through Page without an App provider or foreign resource reads", async () => {
  const { host, pages, context, resources, foreignLoad } = await fixture();
  expect(context.consumer.pluginId).toBe("message");
  for (const path of ["/messages", "/message/:publicKeyHex", "/messages/:publicKeyHex"]) expect(host.routes.byPath(path)).toBeUndefined();
  expect(() => resources.ensure("contacts.presence", [])).toThrow();
  expect(() => resources.ensure("webrtc.session", [])).toThrow();
  const view = render(<>{pages.renderPage("/messages")}{pages.renderPage(`/messages/${PEER}?source=contacts`)}</>);
  expect(await screen.findByRole("heading", { name: "Messages" })).toBeTruthy();
  await waitFor(() => expect(document.querySelector('[data-peer-public-key-hex]')?.getAttribute("data-peer-public-key-hex")).toBe(PEER));
  expect(screen.getByRole("button", { name: "Audio chat" }).hasAttribute("disabled")).toBe(true);
  view.rerender(<>{pages.renderPage(`/message/${PEER}?source=contacts`)}</>);
  expect(document.querySelector('[data-peer-public-key-hex]')?.getAttribute("data-peer-public-key-hex")).toBe(PEER);
  expect(foreignLoad).not.toHaveBeenCalled();
  await act(() => host.revoke("message", "owner ended"));
  expect(pages.hasPage("/messages")).toBe(false);
  expect(document.querySelector(".km-message-detail")).toBeNull();
  expect(() => resources.ensure("message.detail", [PEER])).toThrow();
});

it("rebinds late optional providers, updates online gating and history, and removes their projections on revoke", async () => {
  const { host, pages, presence, webrtc, changePresence, changeHistory, counts, resources } = await fixture();
  render(<>{pages.renderPage(`/message/${PEER}`)}</>);
  const audio = screen.getByRole("button", { name: "Audio chat" });
  expect(audio.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Preserve this draft" } });
  await act(() => host.registerAll([presence, webrtc]));
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Preserve this draft");
  await waitFor(() => expect(audio.hasAttribute("disabled")).toBe(false));
  act(() => changePresence(false));
  await waitFor(() => expect(audio.hasAttribute("disabled")).toBe(true));
  act(() => changePresence(true));
  await waitFor(() => expect(audio.hasAttribute("disabled")).toBe(false));
  const item: WebrtcHistoryItem = { itemType: "transfer", recordId: "fixture:file", ownerPublicKeyHex: OWNER,
    peerPublicKeyHex: PEER, kind: "file", direction: "incoming", status: "completed", startedAtMs: 1, fileName: "Fixture attachment" };
  act(() => changeHistory([item]));
  expect((await screen.findAllByText("Fixture attachment")).length).toBeGreaterThan(0);
  await act(() => host.revoke("presence-fixture", "presence unavailable"));
  await waitFor(() => expect(audio.hasAttribute("disabled")).toBe(true));
  expect(counts()[0]).toBe(0);
  await act(() => host.revoke("rtc-fixture", "RTC unavailable"));
  await waitFor(() => expect(screen.queryAllByText("Fixture attachment")).toHaveLength(0));
  await waitFor(() => expect(resources.ensure("message.webrtc-history", [PEER]).data).toEqual([]));
  expect(counts()[1]).toBe(0);
  expect(host.state("message").kind).toBe("enabled");
  await act(() => host.retry("rtc-fixture"));
  expect((await screen.findAllByText("Fixture attachment")).length).toBeGreaterThan(0);
});

it("ignores a pending send completion after switching the detail peer", async () => {
  const { host, pages } = await fixture();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const service = host.capabilities.get(MESSAGE_SERVICE_CAPABILITY);
  const send = vi.fn(() => pending);
  service.sendTextMessage = send;
  const view = render(<>{pages.renderPage(`/message/${PEER}`)}</>);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "First peer draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(send).toHaveBeenCalledWith({ recipientPublicKeyHex: PEER, body: "First peer draft" });
  const nextPeer = "03" + "33".repeat(32);
  view.rerender(<>{pages.renderPage(`/message/${nextPeer}`)}</>);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Second peer draft" } });
  await act(async () => { finish(); await pending; });
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Second peer draft");
});

it("discards a late history result after its optional provider is revoked", async () => {
  const { host, pages, presence, webrtc, loadHistory, resources } = await fixture();
  let finish!: (items: WebrtcHistoryItem[]) => void;
  const pending = new Promise<WebrtcHistoryItem[]>(resolve => { finish = resolve; });
  loadHistory.mockImplementation(() => pending);
  await host.registerAll([presence, webrtc]);
  render(<>{pages.renderPage(`/message/${PEER}`)}</>);
  await waitFor(() => expect(loadHistory).toHaveBeenCalled());
  await act(() => host.revoke("rtc-fixture", "RTC removed while loading"));
  await act(async () => {
    finish([{ itemType: "transfer", recordId: "late", ownerPublicKeyHex: OWNER, peerPublicKeyHex: PEER,
      kind: "file", direction: "incoming", status: "completed", startedAtMs: 1, fileName: "Late attachment" }]);
    await pending;
  });
  expect(screen.queryAllByText("Late attachment")).toHaveLength(0);
  await waitFor(() => expect(resources.ensure("message.webrtc-history", [PEER]).data).toEqual([]));
});

it("updates the conversation contact name without requiring a message count change", async () => {
  const { host, pages } = await fixture();
  render(<>{pages.renderPage(`/message/${PEER}`)}</>);
  host.capabilities.get(RESOURCE_REGISTRY_CAPABILITY).unregister("contacts.presence");
  host.capabilities.revoke((await import("@keymaster/contracts")).CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY);
  await act(() => host.register(contactsPlugin));
  expect(host.state("contacts").kind).toBe("enabled");
  const contacts = host.capabilities.get(CONTACTS_SERVICE_CAPABILITY);
  await act(() => contacts.addContact({ publicKeyHex: PEER, name: "Initial peer name" }));
  expect(await screen.findByRole("heading", { name: "Initial peer name" })).toBeTruthy();
  await act(() => contacts.updateContact(PEER, { publicKeyHex: PEER, name: "Updated peer name" }));
  expect(await screen.findByRole("heading", { name: "Updated peer name" })).toBeTruthy();
  await act(() => host.revoke("contacts", "optional contacts removed"));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Updated peer name" })).toBeNull());
  expect(host.state("message").kind).toBe("enabled");
});
