// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ActiveKeyState,
  AppMsgEndpointService,
  AppMsgEndpointServiceRegistry,
  AppMsgSendInput,
  Contact,
  KeyspaceService,
  ResourceRegistry,
  WebrtcMessageService
} from "@keymaster/contracts";
import { APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
// 跨插件端到端测试专用：production package 仍不建立 message -> contacts 依赖。
import { ContactPublicKeyActions } from "../../plugin-contacts/src/ContactPublicKeyActions.js";
import { MessageDetailPage } from "./MessageDetailPage.js";
import { messagePlatformPlugin } from "./manifest.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECIPIENT = "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

function webrtc(): WebrtcMessageService {
  return {
    checkPeerOnline: async () => "unknown",
    snapshot: () => ({ phase: "idle", remotePublicKeyHex: null }),
    subscribe: () => () => undefined,
    listHistoryForPeer: async () => [],
    startCall: async () => undefined,
    sendImage: async () => undefined,
    sendFile: async () => undefined,
    acceptIncoming: async () => undefined,
    rejectIncoming: async () => undefined,
    hangup: async () => undefined
  } as unknown as WebrtcMessageService;
}

function contact(): Contact {
  return {
    id: "contact-1", publicKeyHex: RECIPIENT, name: "Bob", tags: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("contact message action integration", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("uses the real message manifest to open a canonical conversation and send its first message", async () => {
    const sent: AppMsgSendInput[] = [];
    const endpoint: AppMsgEndpointService = {
      endpoint: { kind: "plugin", id: "keymaster.message" },
      isReady: () => true,
      checkOnline: async () => ({ kind: "unknown" }),
      listMessages: async () => ({ items: [], hasMore: false }),
      getMessage: async () => null,
      sendMessage: async (input) => {
        sent.push(input);
        return { messageId: "message-1", createdAtMs: 0 };
      },
      subscribeMessages: () => () => undefined
    };
    const endpoints: AppMsgEndpointServiceRegistry = {
      forEndpoint: () => endpoint,
      releaseEndpoint: () => undefined,
      listEndpoints: () => []
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    host.provide("keyspace.service", keyspace());
    host.provide("webrtc.service", webrtc());
    host.provide(APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY, endpoints);
    await host.register(messagePlatformPlugin);

    const resources = host.capabilities.get<ResourceRegistry>("resource.registry");
    resources.register({
      id: "webrtc.session", scope: "global", key: () => ["webrtc.session"],
      load: async () => ({ phase: "idle", remotePublicKeyHex: null }),
      subscribe: () => () => undefined, invalidation: "immediate"
    });
    resources.register({
      id: "webrtc.peer-history", scope: "global", key: (args: readonly string[]) => ["webrtc.peer-history", args[0] ?? ""],
      load: async () => [], subscribe: () => () => undefined, invalidation: "immediate"
    });

    const actionView = render(
      <PluginHostProvider host={host}>
        <ContactPublicKeyActions contact={contact()} />
      </PluginHostProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Message" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/message/${RECIPIENT}`));
    actionView.unmount();

    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    const body = await screen.findByLabelText("Body");
    fireEvent.change(body, { target: { value: "first message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.recipientPublicKeyHex).toBe(RECIPIENT);
  });
});
