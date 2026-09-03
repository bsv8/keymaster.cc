// AppShell notice rail 契约测试。
//
// 关键不变量：
//   - notice rail 不再只展示前 3 条；
//   - 点击 notice 本体时，如果带 routeTo，shell 统一负责跳转。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import {
  createMemoryWebrtcConfigStore,
  createWebrtcService,
  type WebrtcEnvironment
} from "@keymaster/plugin-webrtc";
import type {
  ActiveKeyState,
  ChannelRuntime,
  KeyspaceService,
  NoticeRecord,
  NoticeRegistry,
  VaultService,
  VaultStatus
} from "@keymaster/contracts";
import { SHELL_RESOURCES } from "../i18n/resources.js";
import { registerShellResources } from "./shellResources.js";
import { AppShell } from "./AppShell.js";
import { newSessionID } from "bsv8-channel-protocol";

const OWNER = "02".padEnd(66, "a");

const OTHER = "02".padEnd(66, "c");

const TRANSFER_SENDER = "03".padEnd(66, "b");

beforeEach(() => {
  if (typeof window.matchMedia === "function") return;
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        media: query,
        matches: false,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false
      }) as MediaQueryList
  );
});

function makeVault(): VaultService {
  const statusHandlers = new Set<(status: VaultStatus) => void>();
  const lifecycleHandlers = new Set<(snapshot: { status: VaultStatus }) => void>();
  return {
    status: () => "unlocked",
    getLifecycleSnapshot: () => ({ status: "unlocked" as const, sessionEpoch: "test-epoch", vaultLifecycleRevision: 1 }),
    onLifecycleChange: (handler: (snapshot: { status: VaultStatus }) => void) => { lifecycleHandlers.add(handler); return () => lifecycleHandlers.delete(handler); },
    onStatusChange: (handler: (status: VaultStatus) => void) => {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    getInitialActivationNotice: () => null,
    clearInitialActivationNotice: () => undefined,
    onInitialActivationNoticeChange: () => () => undefined,
    hasVault: async () => true,
    lock: async () => ({ status: "accepted" as const }),
    recoverEmptyVaultToUninitialized: async () => undefined
  } as unknown as VaultService;
}

function makeKeyspace(): KeyspaceService {
  return {
    active: () => ({ activePublicKeyHex: OWNER } satisfies ActiveKeyState),
    onActiveKeyChanged: (_handler: (state: ActiveKeyState) => void) => () => undefined,
    listKeys: async () => []
  } as unknown as KeyspaceService;
}

function createHost() {
  const host = createPluginHost({
    disableConfigPersistence: true,
    initialI18nResources: [SHELL_RESOURCES]
  });
  registerShellResources(host.capabilities.get("resource.registry"));
  host.capabilities.provide<VaultService>("vault.service", makeVault());
  host.capabilities.provide<KeyspaceService>("keyspace.service", makeKeyspace());
  host.capabilities.provide("session-coordinator.client", {
    getIsConnected: () => true,
    sendActivity: () => undefined
  });
  host.routes.register({
    id: "test.messages.list",
    path: "/messages",
    label: { key: "test.messages.list", fallback: "Messages" },
    component: () => <div data-testid="messages-route">Messages route</div>
  });
  host.routes.register({
    id: "test.messages.detail",
    path: "/messages/:publicKeyHex",
    label: { key: "test.messages.detail", fallback: "Conversation" },
    component: () => <div data-testid="messages-detail-route">Messages detail route</div>
  });
  host.routes.register({
    id: "test.message.detail.alias",
    path: "/message/:publicKeyHex",
    label: { key: "test.message.detail.alias", fallback: "Conversation alias" },
    component: () => <div data-testid="message-detail-alias-route">Message alias route</div>
  });
  return host;
}

function makeWebrtcNoticeFixture(noticeRegistry: NoticeRegistry) {
  let ownerPublicKeyHex = OWNER;
  type PrivateMessageHandler = Parameters<NonNullable<ChannelRuntime["subscribePrivate"]>>[0];
  type ActiveKeyChangedHandler = Parameters<KeyspaceService["onActiveKeyChanged"]>[0];
  let privateHandler: PrivateMessageHandler | undefined;
  const ownerChangedHandlers = new Set<ActiveKeyChangedHandler>();
  const hashRequests: Array<{ hash: string; locator: "webrtc-sdp" }> = [];
  const channel: ChannelRuntime = {
    isReady: () => true,
    publish: async () => ({ messageId: "public-message" }),
    publishHashRequest: async (input) => {
      hashRequests.push(input);
      return { messageId: "hash-request-message" };
    },
    publishPrivate: async () => ({ messageId: "private-message" }),
    subscriptionSet: async (channels) => ({ channels }),
    subscribe: () => () => undefined,
    subscribePrivate: (handler) => {
      privateHandler = handler;
      return () => { privateHandler = undefined; };
    }
  };
  const keyspace = {
    active: () => ({ activePublicKeyHex: ownerPublicKeyHex }),
    onActiveKeyChanged: (handler: ActiveKeyChangedHandler) => {
      ownerChangedHandlers.add(handler);
      return () => ownerChangedHandlers.delete(handler);
    }
  } as unknown as KeyspaceService;
  const env: WebrtcEnvironment = {
    createPeerConnection: () => { throw new Error("peer_not_expected"); },
    getUserMedia: async () => { throw new Error("media_not_expected"); },
    now: () => Date.now(),
    delay: async () => undefined
  };
  const service = createWebrtcService({
    channel,
    keyspace,
    configStore: createMemoryWebrtcConfigStore(),
    noticeRegistry,
    env,
    isTransferSenderAllowed: () => true
  });
  return {
    service,
    hashRequests,
    setOwner(nextOwnerPublicKeyHex: string) {
      ownerPublicKeyHex = nextOwnerPublicKeyHex;
      for (const handler of ownerChangedHandlers) {
        handler({ activePublicKeyHex: nextOwnerPublicKeyHex } as ActiveKeyState);
      }
    },
    deliverForOwner(recipientOwnerPublicKeyHex: string, sessionId: string, hash: string) {
      privateHandler?.({
        channel: `bsv8.inbox.${recipientOwnerPublicKeyHex}`,
        publisherPublicKeyHex: TRANSFER_SENDER,
        messageId: "incoming-private-message",
        protocol: "bsv8.message.v1",
        content: {
          type: "keymaster.webrtc.transfer.request",
          session_id: sessionId,
          hash,
          kind: "file",
          byte_length: 1
        }
      });
    }
  };
}

function makeNotice(id: string, routeTo?: string): NoticeRecord {
  const createdAtMs = Number(id);
  return {
    id,
    sourcePluginId: "notice-test",
    priority: 1,
    title: `Notice ${id}`,
    body: `Body ${id}`,
    createdAtMs: Number.isNaN(createdAtMs) ? Date.now() : createdAtMs,
    routeTo,
    actions: []
  };
}

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
});

describe("AppShell notice rail", () => {
  it("renders notices after mount when the registry is updated later", async () => {
    const host = createHost();

    render(
      <PluginHostProvider host={host}>
        <AppShell />
      </PluginHostProvider>
    );

    for (let index = 1; index <= 5; index += 1) {
      host.notice.upsert(makeNotice(String(index)));
    }

    await waitFor(() => {
      expect(document.querySelectorAll("[data-notice-id]").length).toBe(5);
    });
    expect(screen.getByText("Notice 5")).toBeTruthy();
    expect(screen.getByText("Notice 1")).toBeTruthy();
  });

  it("navigates when notice body is clicked and routeTo exists", async () => {
    const host = createHost();
    host.notice.upsert(makeNotice("route", "/settings/vault"));

    render(
      <PluginHostProvider host={host}>
        <AppShell />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Notice route")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Notice route"));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings/vault");
    });
  });

  it("navigates to the singular /message route when an action provides navigateTo", async () => {
    const host = createHost();
    host.notice.upsert({
      ...makeNotice("action"),
      actions: [
        {
          id: "accept",
          label: "Accept",
          variant: "primary",
          run: async () => undefined,
          navigateTo: "/message/peer",
          autoDismiss: true
        }
      ]
    });

    render(
      <PluginHostProvider host={host}>
        <AppShell />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Accept")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Accept"));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/message/peer");
    });
  });

  it("旧 WebRTC notice 动作完成后不关闭新 owner 的同 session 通知，并可继续接受", async () => {
    const host = createHost();
    const fixture = makeWebrtcNoticeFixture(host.notice);
    const sessionId = newSessionID();
    const noticeId = `webrtc-transfer-${sessionId}`;

    render(
      <PluginHostProvider host={host}>
        <AppShell />
      </PluginHostProvider>
    );

    fixture.deliverForOwner(OWNER, sessionId, "a".repeat(64));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reject transfer" })).toBeTruthy();
    });

    // 旧按钮已进入 Shell 的异步执行流程；在 Shell 继续执行自动关闭逻辑前切 owner，
    // 并让新 owner 生成相同 notice id 的请求。
    fireEvent.click(screen.getByRole("button", { name: "Reject transfer" }));
    fixture.setOwner(OTHER);
    fixture.deliverForOwner(OTHER, sessionId, "b".repeat(64));

    await waitFor(() => {
      expect(host.notice.list().some((notice) => notice.id === noticeId)).toBe(true);
      expect(screen.getByRole("button", { name: "Accept transfer" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Accept transfer" }));
    await waitFor(() => expect(fixture.hashRequests).toHaveLength(1));
    await waitFor(() => expect(host.notice.list().some((notice) => notice.id === noticeId)).toBe(false));
    fixture.service.dispose();
  });

  it("shows the same notice under the /messages route", async () => {
    const host = createHost();
    window.history.pushState({}, "", "/messages");

    render(
      <PluginHostProvider host={host}>
        <AppShell />
      </PluginHostProvider>
    );

    host.notice.upsert(makeNotice("messages", "/messages/peer"));

    await waitFor(() => {
      expect(screen.getByText("Notice messages")).toBeTruthy();
    });
    expect(screen.getByTestId("messages-route")).toBeTruthy();
  });

  it("shows the same notice under the /messages/:publicKeyHex route", async () => {
    const host = createHost();
    window.history.pushState({}, "", "/messages/peer");

    render(
      <PluginHostProvider host={host}>
        <AppShell />
      </PluginHostProvider>
    );

    host.notice.upsert(makeNotice("detail", "/messages/peer"));

    await waitFor(() => {
      expect(screen.getByText("Notice detail")).toBeTruthy();
    });
    expect(screen.getByTestId("messages-detail-route")).toBeTruthy();
  });

  it("shows the same notice under the /message/:publicKeyHex route", async () => {
    const host = createHost();
    window.history.pushState({}, "", "/message/peer");

    render(
      <PluginHostProvider host={host}>
        <AppShell />
      </PluginHostProvider>
    );

    host.notice.upsert(makeNotice("alias", "/message/peer"));

    await waitFor(() => {
      expect(screen.getByText("Notice alias")).toBeTruthy();
    });
    expect(screen.getByTestId("message-detail-alias-route")).toBeTruthy();
  });
});
