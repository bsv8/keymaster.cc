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
  it("renders all notices instead of clipping to 3", async () => {
    const host = createHost();
    for (let index = 1; index <= 5; index += 1) {
      host.notice.upsert(makeNotice(String(index)));
    }

    render(
      <PluginHostProvider host={host}>
        <AppShell />
      </PluginHostProvider>
    );

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
});
