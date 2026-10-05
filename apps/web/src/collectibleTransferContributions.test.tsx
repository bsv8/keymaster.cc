import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { CONTACTS_SERVICE_CAPABILITY, type ContactsService } from "@keymaster/contracts";
import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
// @vitest-environment jsdom
import { createElement, useSyncExternalStore } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { defineCapability } from "webloom-framework";
import { PluginConsumerProvider, usePluginCapability } from "webloom-framework/react";
import { COLLECTIBLE_REGISTRY_CAPABILITY, COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY,
  defineRuntimeUnitDependencies, type CollectibleDetail, type CollectibleTransferWidgetProps, type PluginContext, type PluginManifest } from "@keymaster/contracts";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";
import { collectiblesPlugin, collectiblesSetup } from "@keymaster/plugin-collectibles";
import { PluginHostProvider } from "@keymaster/runtime/assembly";

const own = defineCapability<string>({ kind: "local", id: "fixture.collectible-transfer", version: "1" });
const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { cleanup(); await Promise.all(hosts.splice(0).map(host => host.dispose())); });
const detail: CollectibleDetail = { summary: { providerId: "fixture", collectibleId: "tx:0", name: "Fixture collectible", status: "ready" } };
async function fixture(load = vi.fn(async (): Promise<CollectibleDetail | undefined> => detail)) {
  let invalidate = () => {};
  let collectiblesContext!: PluginContext;
  let handlerContext!: PluginContext;
  function Widget({ collectibleRef, recipientPublicKeyHex }: CollectibleTransferWidgetProps) {
    return <div data-testid="own-transfer">{usePluginCapability(own)}:{collectibleRef.collectibleId}:{recipientPublicKeyHex}</div>;
  }
  const manifest: PluginManifest = { id: "transfer-fixture", name: "Transfer fixture", units: [{ id: "transfer-fixture.window", runtime: "window-main", scopeKind: "owner-session",
    provides: [own], dependencies: defineRuntimeUnitDependencies([{ capability: COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY }]),
  }] };
  const host = createKeymasterPluginHost({ fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry", "asset.registry", "token.registry", "collectible.registry", "collectible-transfer.registry", "transfer.registry", "asset.dataNotifier"], runtime: "window-main",
    initialRuntimeIdentity: { vaultStatus: "unlocked", ownerPublicKeyHex: "02" + "11".repeat(32), sessionEpoch: "transfer:1", walletGeneration: "transfer:1" },
    runtimeUnitImplementationRegistry: { get: id => id === "page" ? pageSetup : id === "collectibles" ? ctx => { collectiblesContext = ctx; return collectiblesSetup(ctx); } : ctx => {
      handlerContext = ctx;
      ctx.provide(own, "Handler instance");
      function OwnedWidget(props: CollectibleTransferWidgetProps) {
        const status = useSyncExternalStore(ctx.consumer.subscribe, () => ctx.consumer.status, () => ctx.consumer.status);
        return status === "active" ? createElement(PluginConsumerProvider, { consumer: ctx.consumer, children: createElement(Widget, props) }) : null;
      }
      ctx.capability(COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY).register({ id: "fixture.transfer", name: "Fixture transfer", order: 1, component: OwnedWidget,
        supports: ref => ref.providerId === "fixture", supportsRecipientPublicKeyHex: () => true,
      });
    } },
  });
  hosts.push(host);
  host.provide(CONTACTS_SERVICE_CAPABILITY, {} as ContactsService);
  host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess({ snapshot: () => walletStateFixtureSnapshot((() => ({ activePublicKeyHex: "02" + "11".repeat(32) }))(), () => { throw new Error("unused"); }),  subscribe: () => () => {} }));
  await host.registerAll([collectiblesPlugin, pagePlugin, manifest]);
  collectiblesContext.capability(COLLECTIBLE_REGISTRY_CAPABILITY).register({ id: "fixture", name: "Fixture provider", listCollectibles: async () => [], getCollectible: load,
    listActivity: async () => [], sync: async () => {}, onChange: callback => { invalidate = callback; return () => { invalidate = () => {}; }; },
  });
  expect(host.state("collectibles").kind).toBe("enabled");
  const pages = host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY);
  const recipient = "03" + "22".repeat(32);
  const node = pages.renderPage(`/collectibles/transfer?providerId=fixture&collectibleId=tx%3A0&recipientPublicKeyHex=${recipient}`);
  render(<PluginHostProvider host={host}>{node}</PluginHostProvider>);
  return { host, pages, load, recipient, handlerContext, invalidate: () => invalidate() };
}

it("loads through Collectibles resources and renders the handler with its contributing consumer", async () => {
  const { host, pages, load, recipient, handlerContext, invalidate } = await fixture();
  await waitFor(() => expect(screen.getByTestId("own-transfer").textContent).toBe(`Handler instance:tx:0:${recipient}`));
  expect(load).toHaveBeenCalledWith("tx:0");
  expect(host.routes.byPath("/collectibles/transfer")).toBeUndefined();
  expect(handlerContext.consumer.pluginId).toBe("transfer-fixture");
  await act(() => host.revoke("transfer-fixture", "handler removed"));
  expect(screen.queryByTestId("own-transfer")).toBeNull();
  expect(pages.hasPage("/collectibles/transfer")).toBe(true);
  load.mockResolvedValue(undefined);
  act(invalidate);
  await waitFor(() => expect(screen.getByText("This collectible is unavailable")).toBeTruthy());
  await act(() => host.revoke("collectibles", "collectibles removed"));
  expect(screen.queryByText("This collectible is unavailable")).toBeNull();
  expect(pages.hasPage("/collectibles/transfer")).toBe(false);
});
it("shows a final unavailable state for a collectible removed by WOC", async () => {
  const load = vi.fn(async (): Promise<CollectibleDetail | undefined> => undefined);
  await fixture(load);
  await waitFor(() => expect(screen.getByText("This collectible is unavailable")).toBeTruthy());
  expect(load).toHaveBeenCalledWith("tx:0");
});
it("shows a resource loading failure", async () => {
  await fixture(vi.fn(async () => { throw new Error("fixture load failed"); }));
  await waitFor(() => expect(screen.getByText("Failed to load collectible")).toBeTruthy());
  expect(screen.getByText("fixture load failed")).toBeTruthy();
});
it("does not restore a cached transfer page when a detail load finishes after revocation", async () => {
  let finish!: (value: CollectibleDetail) => void;
  const pending = new Promise<CollectibleDetail>(resolve => { finish = resolve; });
  const load = vi.fn(() => pending);
  const { host } = await fixture(load);
  await waitFor(() => expect(load).toHaveBeenCalled());
  await act(() => host.revoke("collectibles", "session ended"));
  await act(async () => { finish(detail); await pending; });
  expect(screen.queryByTestId("own-transfer")).toBeNull();
  expect(document.querySelector(".collectible-transfer-page")).toBeNull();
});
