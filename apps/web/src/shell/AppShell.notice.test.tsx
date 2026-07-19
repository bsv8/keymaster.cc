// AppShell notice rail 契约测试。
//
// 关键不变量：
//   - notice rail 不再只展示前 3 条；
//   - 点击 notice 本体时，如果带 routeTo，shell 统一负责跳转。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import type {
  ActiveKeyState,
  KeyspaceService,
  NoticeRecord,
  VaultService,
  VaultStatus
} from "@keymaster/contracts";
import { SHELL_RESOURCES } from "../i18n/resources.js";
import { AppShell } from "./AppShell.js";

const OWNER = "02".padEnd(66, "a");

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
  return {
    status: () => "unlocked",
    onStatusChange: (handler: (status: VaultStatus) => void) => {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    getInitialActivationNotice: () => null,
    clearInitialActivationNotice: () => undefined,
    onInitialActivationNoticeChange: () => () => undefined,
    hasVault: async () => true,
    lock: async () => undefined,
    recoverEmptyVaultToUninitialized: async () => undefined
  } as unknown as VaultService;
}

function makeKeyspace(): KeyspaceService {
  return {
    active: () => ({ activePublicKeyHex: OWNER } satisfies ActiveKeyState),
    onActiveChange: (_handler: (state: ActiveKeyState) => void) => () => undefined,
    listKeys: async () => []
  } as unknown as KeyspaceService;
}

function createHost() {
  const host = createPluginHost({
    disableConfigPersistence: true,
    initialI18nResources: [SHELL_RESOURCES]
  });
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
