import { describe, expect, it } from "vitest";
import { createPluginHost } from "@keymaster/runtime";
import type { AppMsgEndpointService, AppMsgEndpointServiceRegistry, ActiveKeyState, KeyspaceService } from "@keymaster/contracts";
import { APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { messagePlatformPlugin } from "./manifest.js";

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
});
