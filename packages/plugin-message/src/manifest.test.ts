import { describe, expect, it } from "vitest";
import { createPluginHost } from "@keymaster/runtime";
import type {
  AppMsgEndpointService,
  AppMsgEndpointServiceRegistry,
  ActiveKeyState,
  Contact,
  ContactsService,
  KeyspaceService,
  ResourceSnapshot
} from "@keymaster/contracts";
import { APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { messagePlatformPlugin, type MessageConversationsData } from "./manifest.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function keyspace(): KeyspaceService {
  const state: ActiveKeyState = { activePublicKeyHex: OWNER };
  return {
    listKeys: async () => [], getKey: async () => undefined, active: () => state, selected: () => state.activePublicKeyHex,
    setActive: async () => undefined, requireActiveKey: () => ({ publicKeyHex: OWNER, label: "test", capabilities: [], createdAt: "now" }),
    onActiveKeyChanged: () => () => undefined, openKeyStorage: async () => { throw new Error("unused"); },
    registerPluginStorage: () => undefined, listPluginStorages: () => [], prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined, isInitializing: () => false, onInitializationChange: () => () => undefined
  };
}

function endpoint(): AppMsgEndpointService {
  return {
    endpoint: { kind: "plugin", id: "keymaster.message" },
    isReady: () => false,
    checkOnline: async () => ({ kind: "unknown" }),
    listMessages: async () => ({ items: [], hasMore: false }),
    getMessage: async () => null,
    sendMessage: async () => ({ messageId: "test-message", createdAtMs: 0 }),
    subscribeMessages: () => () => undefined
  } as AppMsgEndpointService;
}

describe("messagePlatformPlugin contact action", () => {
  it("registers the real manifest action and recovers it on unregister", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    host.provide("keyspace.service", keyspace());
    host.provide("webrtc.service", {});
    const endpoints: AppMsgEndpointServiceRegistry = {
      forEndpoint: () => endpoint(), releaseEndpoint: () => undefined, listEndpoints: () => []
    };
    host.provide(APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY, endpoints);
    const lifecycleManifest = { ...messagePlatformPlugin, meta: { ...messagePlatformPlugin.meta, canDisable: true } };
    await host.register(lifecycleManifest);
    expect(host.state("message").kind).toBe("enabled");
    expect(host.contactPublicKeyActions.get("message.to-contact")?.label).toEqual({ key: "message.action.toContact", fallback: "发消息" });
    await host.unregister("message");
    expect(host.contactPublicKeyActions.get("message.to-contact")).toBeUndefined();
  });

  it("queries contacts when the contacts service is provided after message setup", async () => {
    const peer = "03BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const normalizedPeer = peer.toLowerCase();
    const contact: Contact = {
      id: "contact-bob",
      publicKeyHex: normalizedPeer,
      name: "Bob",
      tags: [],
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z"
    };
    const queriedKeys: string[][] = [];
    const messageEndpoint: AppMsgEndpointService = {
      ...endpoint(),
      listMessages: async () => ({
        items: [{
          messageId: "message-from-bob",
          clientMessageId: "client-from-bob",
          senderPublicKeyHex: peer,
          senderAppId: "keymaster.message",
          recipientPublicKeyHex: OWNER,
          recipientAppId: "keymaster.message",
          contentType: "text/plain",
          body: "hello",
          createdAtMs: 1,
          insertedAtMs: 1
        }],
        hasMore: false
      })
    } as AppMsgEndpointService;
    const endpoints: AppMsgEndpointServiceRegistry = {
      forEndpoint: () => messageEndpoint,
      releaseEndpoint: () => undefined,
      listEndpoints: () => []
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    host.provide("keyspace.service", keyspace());
    host.provide("webrtc.service", {});
    host.provide(APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY, endpoints);

    // 复现生产启动顺序：message 先 setup，contacts.service 后提供。
    await host.register(messagePlatformPlugin);
    const contacts: ContactsService = {
      addContact: async () => contact,
      updateContact: async () => contact,
      removeContact: async () => undefined,
      listContacts: async () => [contact],
      findByPublicKeyHex: async (publicKeyHex) => publicKeyHex.toLowerCase() === normalizedPeer ? contact : undefined,
      findByPublicKeyHexes: async (publicKeyHexes) => {
        queriedKeys.push(publicKeyHexes.slice());
        return publicKeyHexes.includes(normalizedPeer) ? [contact] : [];
      },
      onChange: () => () => undefined
    };
    host.provide("contacts.service", contacts);

    const ready = new Promise<ResourceSnapshot<MessageConversationsData>>((resolve) => {
      const off = host.resourceStore.subscribe("message.conversations", [], () => {
        const snapshot = host.resourceStore.read<MessageConversationsData>("message.conversations", []);
        if (snapshot?.status !== "ready") return;
        off();
        resolve(snapshot);
      });
    });
    host.resourceStore.ensure<MessageConversationsData>("message.conversations", []);
    const snapshot = await ready;

    expect(queriedKeys).toEqual([[normalizedPeer]]);
    expect(snapshot.data?.contactsByPeer[normalizedPeer]?.name).toBe("Bob");
  });
});
