import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS, CHANNEL_RUNTIME_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, type ChannelRuntime } from "@keymaster/contracts";
import { createInMemoryKeyValueStore, withTestStorageBinding } from "@keymaster/runtime";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";
import { bsvPricePlugin, bsvPriceSetup, BSV_PRICE_SERVICE_CAPABILITY } from "@keymaster/plugin-bsv-price";
const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { cleanup(); await Promise.all(hosts.splice(0).map(host => host.dispose())); });
it("mounts the real price pages and widget under their contributor and removes cached UI on revocation", async () => {
  const channel: ChannelRuntime = {
    isReady: () => false,
    publish: async () => ({ messageId: "unused" }),
    publishPrivate: async () => ({ messageId: "unused" }),
    subscriptionSet: async channels => ({ channels }),
    subscriptionStatus: channel => ({ channel, phase: "idle", errorCode: null, errorMessage: null, updatedAtMs: 0 }),
    subscribeSubscriptionStatus: () => () => {},
    subscribe: () => () => {}, subscribePrivate: () => () => {},
  };
  const host = createKeymasterPluginHost({ fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry"], runtime: "window-main",
    initialRuntimeIdentity: { vaultStatus: "unlocked", ownerPublicKeyHex: "02" + "11".repeat(32), sessionEpoch: "price-ui:1", walletGeneration: "price-ui:1" },
    storageBindingAuthority: {
      openOwnerAppStore: async () => createInMemoryKeyValueStore(withTestStorageBinding(CENTRAL_STORAGE_DECLARATIONS.bsvPrice)),
      openOwnerFileStore: async () => { throw new Error("No file store in this fixture"); },
      openPlatformStore: async () => { throw new Error("No platform store in this fixture"); },
      clearStorageRoot: async () => {},
    },
    runtimeUnitImplementationRegistry: { get: id => id === "page" ? pageSetup : id === "bsv-price" ? bsvPriceSetup : undefined },
  });
  hosts.push(host);
  host.provide(CHANNEL_RUNTIME_CAPABILITY, { forPlugin: () => channel, forSystem: () => channel });
  await host.registerAll([bsvPricePlugin, pagePlugin]);
  expect(host.state("bsv-price").kind).toBe("enabled");
  const pages = host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY);
  expect(pages.hasPage("/bsv-price")).toBe(true);
  expect(pages.hasPage("/settings/bsv-price")).toBe(true);
  expect(host.routes.byPath("/bsv-price")).toBeUndefined();
  expect(host.routes.byPath("/settings/bsv-price")).toBeUndefined();
  const widget = pages.renderHome("aside", true);
  const cached = pages.renderPage("/bsv-price");
  render(<PluginHostProvider host={host}>{cached}{pages.renderPage("/settings/bsv-price")}{widget}</PluginHostProvider>);
  expect(document.querySelector('[data-bsv-price-page="active"]')).toBeTruthy();
  expect(document.querySelector('[data-bsv-price-settings="main"]')).toBeTruthy();
  await act(async () => { await host.capabilities.get(BSV_PRICE_SERVICE_CAPABILITY).addServer({ name: "New publisher", publisherPublicKeyHex: "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5" }); });
  await waitFor(() => expect(screen.getAllByText(/New publisher/).length).toBeGreaterThan(0));
  await act(() => host.revoke("bsv-price", "owner removed"));
  expect(pages.hasPage("/bsv-price")).toBe(false);
  expect(document.querySelector('[data-bsv-price-page]')).toBeNull();
  expect(document.querySelector('[data-bsv-price-settings]')).toBeNull();
  expect(document.querySelector('[data-bsv-price-home-widget]')).toBeNull();
});
