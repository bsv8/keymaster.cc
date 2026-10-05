import { walletStateFixtureAccess, walletStateFixtureSnapshot } from "@keymaster/runtime/test-support";
import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BUSINESS_REGISTRY_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, PROTOCOL_SERVICE_CAPABILITY, defineRuntimeUnitDependencies, type PluginManifest, type VaultWalletState, type ProtocolService } from "@keymaster/contracts";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import { appsPlugin, appsSetup } from "@keymaster/plugin-apps";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";
const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { cleanup(); await Promise.all(hosts.splice(0).map(host => host.dispose())); });
it("mounts the real Apps page and home projection with the Apps consumer and removes cached UI on revocation", async () => {
  const host = createKeymasterPluginHost({ fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry"], runtime: "window-main", runtimeUnitImplementationRegistry: {
    get: id => id === "apps" ? appsSetup : id === "page" ? pageSetup : id === "home-fixture" ? ctx => {
    } : undefined,
  } });
  hosts.push(host);
  const launch = vi.fn();
  host.provide(PROTOCOL_SERVICE_CAPABILITY, { launchAppView: launch } as unknown as ProtocolService);
  host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess({ snapshot: () => walletStateFixtureSnapshot({}), subscribe: () => () => {} } as unknown as VaultWalletState));
  const home: PluginManifest = { id: "home-fixture", name: "Home fixture", units: [{
    id: "home-fixture.window", runtime: "window-main", scopeKind: "root",
    dependencies: defineRuntimeUnitDependencies([{ capability: BUSINESS_REGISTRY_CAPABILITY }]),
  }] };
  await host.registerAll([appsPlugin, pagePlugin, home]);
  expect(host.state("apps").kind).toBe("enabled");
  const pages = host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY);
  expect(pages.hasPage("/apps")).toBe(true);
  expect(host.routes.byPath("/apps")).toBeUndefined();
  const widget = pages.renderHome("main", true);
  const cached = pages.renderPage("/apps");
  render(<PluginHostProvider host={host}>{cached}{widget}</PluginHostProvider>);
  expect(screen.getByTestId("apps-list")).toBeTruthy();
  expect(screen.getByTestId("apps-home-widget")).toBeTruthy();
  expect(launch).not.toHaveBeenCalled();
  await act(() => host.revoke("apps", "apps removed"));
  expect(pages.hasPage("/apps")).toBe(false);
  expect(screen.queryByTestId("apps-list")).toBeNull();
  expect(screen.queryByTestId("apps-home-widget")).toBeNull();
});
