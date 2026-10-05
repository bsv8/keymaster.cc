import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { CONTACTS_SERVICE_CAPABILITY, type ContactsService } from "@keymaster/contracts";
import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type AssetProvider, type CollectibleProvider, type PluginManifest,
  PAGE_UI_REGISTRY_CAPABILITY, defineRuntimeUnitDependencies, type OwnedResourceReader, type PluginContext,
  ASSET_REGISTRY_CAPABILITY, COLLECTIBLE_REGISTRY_CAPABILITY, ASSET_DATA_NOTIFIER_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY } from "@keymaster/contracts";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import { assetsPlugin, assetsSetup } from "@keymaster/plugin-assets";
import { collectiblesPlugin, collectiblesSetup } from "@keymaster/plugin-collectibles";
const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { cleanup(); await Promise.all(hosts.splice(0).map(host => host.dispose())); });
it("owns the asset home contribution and its resources, refreshes from provider events, and fences revoked readers", async () => {
  let ctx!: PluginContext, collectibleContext!: PluginContext;
  const host = createKeymasterPluginHost({ fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry", "asset.registry", "token.registry", "collectible.registry", "collectible-transfer.registry", "transfer.registry", "asset.dataNotifier"], runtime: "window-main",
    initialRuntimeIdentity: { vaultStatus: "unlocked", ownerPublicKeyHex: "02" + "11".repeat(32), sessionEpoch: "assets:1", walletGeneration: "assets:1" },
    runtimeUnitImplementationRegistry: { get: id => id === "assets" ? context => { ctx = context; return assetsSetup(context); } : id === "collectibles" ? context => { collectibleContext = context; return collectiblesSetup(context); } : id === "page" ? pageSetup : undefined },
  });
  hosts.push(host);
  host.provide(CONTACTS_SERVICE_CAPABILITY, {} as ContactsService);
  host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess({
    snapshot: () => walletStateFixtureSnapshot((() => ({ activePublicKeyHex: "02" + "11".repeat(32) }))(), () => ({ publicKeyHex: "02" + "11".repeat(32), label: "Assets key", capabilities: [], createdAt: "2026-10-03" })),
    
    subscribe: () => () => {},
  }));
  const list = vi.fn(async () => []);
  await host.registerAll([assetsPlugin, collectiblesPlugin, pagePlugin]);
  ctx.capability(ASSET_REGISTRY_CAPABILITY).register({ id: "fixture.assets", name: "Fixture assets", kind: "coin", listAssets: list,
    getAsset: async () => undefined, listActivity: async () => [], onChange: () => () => {},
  } as AssetProvider);
  collectibleContext.capability(COLLECTIBLE_REGISTRY_CAPABILITY).register({ id: "fixture.collectibles", name: "Fixture collectibles", listCollectibles: async () => [],
    getCollectible: async () => undefined, listActivity: async () => [], sync: async () => {}, onChange: () => () => {},
  } as CollectibleProvider);
  expect(host.state("assets").kind).toBe("enabled");
  const reader: OwnedResourceReader = ctx.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(ctx.consumer, ctx.scope);
  expect(() => reader.ensure("contacts.list", [])).toThrow();
  const pages = host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY);
  expect(host.routes.byPath("/assets")).toBeUndefined();
  render(<PluginHostProvider host={host}>{pages.renderHome("aside", true)}{pages.renderPage("/assets")}{pages.renderPage("/assets/detail?providerId=fixture&assetId=coin")}{pages.renderPage("/collectibles")}{pages.renderPage("/collectibles/detail?providerId=fixture&collectibleId=one")}</PluginHostProvider>);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  expect(document.querySelector(".asset-overview-home__count")?.textContent).toBe("1");
  expect(screen.getByText("fixture:coin")).toBeTruthy();
  expect(screen.getByText("fixture:one")).toBeTruthy();
  await waitFor(() => expect(screen.getByText("Fixture collectibles")).toBeTruthy());
  const collectibleReader = collectibleContext.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(collectibleContext.consumer, collectibleContext.scope);
  const collectibleData = collectibleReader.ensure<Array<{ provider: unknown }>>("collectibles.list", []).data!;
  expect(collectibleData[0]?.provider).toEqual({ id: "fixture.collectibles", name: "Fixture collectibles" });
  expect(screen.getByText(/Assets key/)).toBeTruthy();
  fireEvent.click(within(document.querySelector(".asset-overview-home") as HTMLElement).getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  act(() => host.capabilities.get(ASSET_DATA_NOTIFIER_CAPABILITY).emit({ providerId: "fixture.assets", revision: 1, kinds: ["holding"] }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  const notifier = host.capabilities.get(ASSET_DATA_NOTIFIER_CAPABILITY);
  await act(() => host.revoke("assets", "workspace removed"));
  expect(document.querySelector(".asset-overview-home")).toBeNull();
  expect(document.querySelector(".assets-page")).toBeNull();
  expect(screen.queryByText("fixture:coin")).toBeNull();
  expect(screen.queryByText("fixture:one")).not.toBeNull();
  expect(document.querySelector(".collectibles-page")).not.toBeNull();
  await act(() => host.revoke("collectibles", "collectibles removed"));
  expect(document.querySelector(".collectibles-page")).toBeNull();
  expect(pages.hasPage("/assets")).toBe(false);
  expect(host.home.list()).toEqual([]);
  expect(() => reader.ensure("assets.detail", [])).toThrow();
  act(() => notifier.emit({ providerId: "fixture.assets", revision: 2, kinds: ["holding"] }));
  expect(list).toHaveBeenCalledTimes(3);
});

it("keeps the chain settings page live as independent instance contributions arrive and revoke", async () => {
  const contexts = new Map<string, PluginContext>();
  const host = createKeymasterPluginHost({ fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry", "asset.registry", "token.registry", "collectible.registry", "collectible-transfer.registry", "transfer.registry", "asset.dataNotifier"], runtime: "window-main",
    initialRuntimeIdentity: { vaultStatus: "unlocked", ownerPublicKeyHex: "02" + "11".repeat(32), sessionEpoch: "assets:2", walletGeneration: "assets:2" },
    runtimeUnitImplementationRegistry: { get: id => id === "assets" ? assetsSetup : id === "page" ? pageSetup : ctx => { contexts.set(id, ctx); } },
  });
  hosts.push(host);
  host.provide(CONTACTS_SERVICE_CAPABILITY, {} as ContactsService);
  host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess({ snapshot: () => walletStateFixtureSnapshot((() => ({}))(), () => { throw new Error("No active key"); }),  subscribe: () => () => {} }));
  const fixture = (id: string): PluginManifest => ({ id, name: id, units: [{ id: `${id}.window`, runtime: "window-main", scopeKind: "owner-session",
    dependencies: defineRuntimeUnitDependencies([{ capability: PAGE_UI_REGISTRY_CAPABILITY }]),
  }] });
  await host.registerAll([assetsPlugin, pagePlugin, fixture("chain-first"), fixture("chain-second")]);
  const pages = host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY);
  expect(host.routes.byPath("/settings/bsv-chain")).toBeUndefined();
  render(<PluginHostProvider host={host}>{pages.renderPage("/settings/bsv-chain")}</PluginHostProvider>);
  expect(document.querySelector(".bsv-chain-page__sections")?.children).toHaveLength(0);
  for (const [id, name] of [["chain-first", "P2PKH"], ["chain-second", "WOC"]] as const) {
    const ctx = contexts.get(id)!;
    act(() => { ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view.register({ id, kind: "settings-block", path: "/settings/bsv-chain", label: name,
      render: () => <section><h2>{name}</h2></section>,
    }); });
  }
  expect(screen.getAllByRole("heading", { name: "P2PKH" })).toHaveLength(1);
  expect(screen.getAllByRole("heading", { name: "WOC" })).toHaveLength(1);
  await act(() => host.revoke("chain-first", "first module removed"));
  expect(screen.queryByRole("heading", { name: "P2PKH" })).toBeNull();
  expect(screen.getByRole("heading", { name: "WOC" })).toBeTruthy();
  expect(document.querySelector(".bsv-chain-page")).toBeTruthy();
  await act(() => host.revoke("assets", "assets removed"));
  expect(document.querySelector(".bsv-chain-page")).not.toBeNull();
  await act(() => host.revoke("page", "page removed"));
  expect(document.querySelector(".bsv-chain-page")).toBeNull();
});
