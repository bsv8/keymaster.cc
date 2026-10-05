import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { defineCapability, type PluginConsumer } from "webloom-framework";
import { PluginConsumerProvider, usePluginCapability } from "webloom-framework/react";
import { PAGE_UI_REGISTRY_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, defineRuntimeUnitDependencies, type PluginContext, type PluginManifest, type PageUiRegistration } from "@keymaster/contracts";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import { pagePlugin, pageSetup } from "./manifest.js";
import { bindPageUi } from "./PageResourceContext.js";
import { RouteRenderer, router } from "./shell/RouteRenderer.js";
import type { ScopedRegistryView } from "webloom-framework/advanced";
const own = defineCapability<string>({ kind: "local", id: "page-test.own", version: "1" });
function OwnContents() { return <span>{usePluginCapability(own)}</span>; }
const contexts = new Map<string, PluginContext>();
const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { cleanup(); await Promise.all(hosts.splice(0).map(host => host.dispose())); contexts.clear(); });
async function fixture() {
  const host = createKeymasterPluginHost({ fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry"], runtime: "window-main", runtimeUnitImplementationRegistry: {
    get: id => id === "page" ? ctx => { contexts.set(id, ctx); return pageSetup(ctx); }
      : ctx => { contexts.set(id, ctx); if (id === "first") ctx.provide(own, "Contributing instance"); },
  } });
  hosts.push(host);
  const manifest = (id: string): PluginManifest => ({ id, name: id, units: [{ id: `${id}.window`, runtime: "window-main", scopeKind: "root",
    provides: id === "first" ? [own] : [], dependencies: defineRuntimeUnitDependencies(id === "outsider" ? [] : [{ capability: PAGE_UI_REGISTRY_CAPABILITY }]),
  }] });
  await host.registerAll([manifest("first"), manifest("second"), manifest("outsider"), pagePlugin]);
  expect(host.state("first").kind, JSON.stringify(host.state("page"))).toBe("enabled");
  const bind = (id: string) => { const ctx = contexts.get(id)!; return ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope); };
  return { host, bind, OwnedRenderer: bindPageUi(contexts.get("page")!, RouteRenderer), renderer: host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY) };
}
describe("page contribution production adapter", () => {
  it("renders grouped home cards with their contributors and removes cached cards on revocation", async () => {
    const { host, bind, renderer } = await fixture();
    const first = bind("first");
    first.view.register({ id: "first.home", kind: "home", slot: "main", label: "Card", space: { id: "first.cards", label: "First space", order: 20 }, render: () => <OwnContents /> });
    bind("second").view.register({ id: "second.home", kind: "home", slot: "main", label: "Second", space: { id: "second.cards", label: "Second space", order: 10 }, visibleWhen: ({ unlocked }) => unlocked, render: () => <span>Second card</span> });
    expect(bind("first")).toBe(first);
    const cached = renderer.renderHome("main", true);
    render(<PluginHostProvider host={host}>{cached}</PluginHostProvider>);
    expect(screen.getAllByRole("heading").map(heading => heading.textContent)).toEqual(["Second space", "First space"]);
    expect(screen.getByText("Contributing instance")).toBeTruthy();
    await act(() => host.revoke("first", "home contributor removed"));
    expect(screen.queryByText("Contributing instance")).toBeNull();
    expect(screen.getByText("Second card")).toBeTruthy();
    cleanup();
    render(<PluginHostProvider host={host}>{renderer.renderHome("main", false)}</PluginHostProvider>);
    expect(screen.queryByText("Second card")).toBeNull();
  });
  it("rejects two owners for a frame slot and permits replacement after the owner revokes", async () => {
    const { host, bind } = await fixture();
    bind("first").view.register({ id: "first.guard", kind: "frame", slot: "wallet-guard", label: "Guard", render: () => null });
    const second = bind("second");
    expect(() => second.view.register({ id: "second.guard", kind: "frame", slot: "wallet-guard", label: "Other guard", render: () => null })).toThrow(/slot already registered/);
    await host.revoke("first", "guard removed");
    expect(() => second.view.register({ id: "second.guard", kind: "frame", slot: "wallet-guard", label: "Other guard", render: () => null })).not.toThrow();
  });
  it("moves an already displayed page to diagnostics when its contributor revokes", async () => {
    const { host, bind, OwnedRenderer } = await fixture();
    bind("first").view.register({ id: "removed.route", kind: "page", path: "/removed-page", label: "Removed", render: () => <OwnContents /> });
    window.history.replaceState(null, "", "/removed-page");
    try {
      render(<PluginHostProvider host={host}><OwnedRenderer /></PluginHostProvider>);
      expect(screen.getByText("Contributing instance")).toBeTruthy();
      await act(() => host.revoke("first", "route contributor removed"));
      expect(screen.queryByText("Contributing instance")).toBeNull();
      expect(window.location.pathname).toBe("/settings/plugins");
    } finally { window.history.replaceState(null, "", "/"); }
  });
  it("passes full locations through the production shell and updates query-only navigation", async () => {
    const { host, bind, OwnedRenderer } = await fixture();
    bind("first").view.register({ id: "shell.query", kind: "page", path: "/shell-query/:tab", label: "Shell query",
      render: location => <><OwnContents /><span>{location.path}:{location.params.tab}</span></>,
    });
    window.history.replaceState(null, "", "/shell-query/general?amount=1#review");
    try {
      render(<PluginHostProvider host={host}><OwnedRenderer /></PluginHostProvider>);
      expect(screen.getByText("/shell-query/general?amount=1#review:general")).toBeTruthy();
      act(() => router.push("/shell-query/general?amount=2#confirm"));
      expect(screen.getByText("/shell-query/general?amount=2#confirm:general")).toBeTruthy();
      expect(screen.queryByText("/shell-query/general?amount=1#review:general")).toBeNull();
      expect(screen.getAllByText("Contributing instance")).toHaveLength(1);
    } finally { window.history.replaceState(null, "", "/"); }
  });
  it("matches settings alongside query-bearing page paths and keeps the original location", async () => {
    const { host, bind, renderer } = await fixture();
    bind("first").view.register({ id: "query.page", kind: "page", path: "/query/:tab", label: "Query page", render: () => <span>Query page</span> });
    bind("second").view.register({ id: "query.settings", kind: "settings-block", path: "/query/:tab", label: "Query settings",
      render: location => <span>{location.path}:{location.params.tab}</span> });
    expect(renderer.hasSettings("/query/general?key=a#detail")).toBe(true);
    render(<PluginHostProvider host={host}>{renderer.renderPage("/query/general?key=a#detail")}</PluginHostProvider>);
    expect(screen.getAllByText("/query/general?key=a#detail:general")).toHaveLength(1);
  });

  it("matches dynamic paths deterministically and renders decoded parameters with the contributing consumer", async () => {
    const { host, bind, renderer } = await fixture();
    const first = bind("first");
    first.view.register({ id: "dynamic", kind: "page", path: "/conversation/:peer", label: "Dynamic", order: -100,
      render: location => <><OwnContents /><span>{location.params.peer}</span><span>{location.path}</span></> });
    bind("second").view.register({ id: "static", kind: "page", path: "/conversation/new", label: "Static", order: 100,
      render: () => <span>New conversation</span> });
    expect(renderer.hasPage("/conversation/alice%20bob")).toBe(true);
    expect(renderer.hasPage("/conversation/%E0%A4%A")).toBe(false);
    expect(renderer.hasPage("/conversation/")).toBe(false);
    expect(renderer.hasPage("/conversation/a/extra")).toBe(false);
    expect(renderer.hasPage("/conversation/alice?owner=another")).toBe(true);
    const cached = renderer.renderPage("/conversation/alice%20bob");
    render(<PluginHostProvider host={host}>{cached}{renderer.renderPage("/conversation/new")}</PluginHostProvider>);
    expect(screen.getByText("alice bob")).toBeTruthy();
    expect(screen.getByText("/conversation/alice%20bob")).toBeTruthy();
    expect(screen.getAllByText("Contributing instance")).toHaveLength(1);
    expect(screen.getByText("New conversation")).toBeTruthy();
    await act(() => host.revoke("first", "dynamic contributor removed"));
    expect(screen.queryByText("alice bob")).toBeNull();
    expect(renderer.hasPage("/conversation/alice")).toBe(false);
    expect(screen.getByText("New conversation")).toBeTruthy();
  });
  it("rejects ambiguous parameter shapes and malformed path declarations", async () => {
    const { bind } = await fixture();
    const first = bind("first"), second = bind("second");
    first.view.register({ id: "dynamic", kind: "page", path: "/conversation/:peer", label: "Dynamic", render: () => null });
    expect(() => second.view.register({ id: "alias", kind: "page", path: "/conversation/:another", label: "Ambiguous", render: () => null })).toThrow();
    for (const path of ["/conversation/:peer/:peer", "/conversation/:", "/conversation/:bad-name", "/conversation#hash", "conversation"]) {
      expect(() => second.view.register({ id: "invalid", kind: "page", path, label: "Invalid", render: () => null })).toThrow();
    }
  });
  it("renders pages, settings and header with the contributor rather than the page/layout consumer", async () => {
    const { host, bind, renderer } = await fixture();
    const registration = bind("first");
    registration.view.register({ id: "first.page", kind: "page", path: "/owned", label: "Owned", render: () => <OwnContents /> });
    registration.view.register({ id: "first.settings", kind: "settings-block", path: "/settings/system", label: "Owned", render: () => <OwnContents /> });
    registration.view.register({ id: "first.header", kind: "header", slot: "topbar", label: "Owned", render: () => <OwnContents /> });
    const page = contexts.get("page")!;
    expect(() => page.consumer.capability(own)).toThrow();
    expect((page.capability(PAGE_UI_REGISTRY_CAPABILITY) as unknown as { list?: unknown }).list).toBeUndefined();
    render(<PluginHostProvider host={host}><PluginConsumerProvider consumer={page.consumer}>
      {renderer.renderPage("/owned")}{renderer.renderSettings("/settings/system")}{renderer.renderHeader("topbar")}
    </PluginConsumerProvider></PluginHostProvider>);
    expect(screen.getAllByText("Contributing instance")).toHaveLength(3);
    await act(() => host.revoke("first", "contributor removed"));
    expect(screen.queryAllByText("Contributing instance")).toHaveLength(0);
    expect(renderer.hasPage("/owned")).toBe(false);
  });
  it("embeds settings contributions once, keeps their consumer, and updates an existing page as contributors revoke", async () => {
    const { host, bind, renderer } = await fixture();
    const path = "/settings/system-status";
    const cachedPage = renderer.renderPage(path);
    const view = render(<PluginHostProvider host={host}>{cachedPage}</PluginHostProvider>);
    expect(document.querySelector(".system-status-page__empty")).toBeTruthy();
    act(() => {
      bind("first").view.register({ id: "first.gateway", kind: "settings-block", path, label: "First", render: () => <OwnContents /> });
      bind("second").view.register({ id: "second.gateway", kind: "settings-block", path, label: "Second", render: () => <span>Second gateway</span> });
    });
    expect(document.querySelector(".system-status-page__empty")).toBeNull();
    expect(screen.getAllByText("Contributing instance")).toHaveLength(1);
    expect(screen.getAllByText("Second gateway")).toHaveLength(1);
    expect(document.querySelector(".system-status-page__modules")?.textContent).toContain("Contributing instance");
    await act(() => host.revoke("first", "first gateway removed"));
    expect(screen.queryByText("Contributing instance")).toBeNull();
    expect(screen.getAllByText("Second gateway")).toHaveLength(1);
    expect(renderer.hasSettings(path)).toBe(true);
    await act(() => host.revoke("second", "last gateway removed"));
    expect(renderer.hasSettings(path)).toBe(false);
    expect(document.querySelector(".system-status-page__empty")).toBeTruthy();
    view.unmount();
  });
  it("rejects counterfeit consumers/scopes, consumer substitution and self-reported ownership", async () => {
    const { bind } = await fixture();
    const first = contexts.get("first")!, second = contexts.get("second")!;
    const service = first.capability(PAGE_UI_REGISTRY_CAPABILITY);
    expect(() => service.bind({ ...first.consumer } as PluginConsumer, first.scope)).toThrow();
    expect(() => service.bind(first.consumer, { ...first.scope } as typeof first.scope)).toThrow();
    expect(() => service.bind(second.consumer, first.scope)).toThrow();
    const outsider = contexts.get("outsider")!;
    expect(() => service.bind(outsider.consumer, outsider.scope)).toThrow();
    const registered = bind("first");
    expect(() => registered.view.register({ id: "spoof", kind: "page", path: "/spoof", label: "Spoof", render: () => null,
      ownerInstanceId: second.instanceId,
    } as Parameters<PageUiRegistration["register"]>[0])).toThrow();
  });
  it("rejects cross-instance removal and conflicts; stale cleanup cannot remove a replacement", async () => {
    const { host, bind, renderer } = await fixture();
    const old = bind("first"), second = bind("second");
    const entry = { id: "same", kind: "page" as const, path: "/same", label: "Same", render: () => null };
    old.view.register(entry);
    expect(() => second.view.unregister("same")).toThrow();
    expect(() => second.view.register({ ...entry, id: "different-id" })).toThrow();
    await host.revoke("first", "replace");
    second.view.register(entry);
    expect(() => old.view.unregister("same")).toThrow();
    expect(() => old.view.register({ ...entry, id: "late" })).toThrow();
    expect(renderer.hasPage("/same")).toBe(true);
  });
  it("removes cached rendered nodes when the page scope is revoked", async () => {
    const { host, bind, renderer } = await fixture();
    bind("first").view.register({ id: "cached", kind: "page", path: "/cached", label: "Cached", render: () => <OwnContents /> });
    const cached = renderer.renderPage("/cached");
    render(<PluginHostProvider host={host}>{cached}</PluginHostProvider>);
    expect(screen.getByText("Contributing instance")).toBeTruthy();
    // 同步 Scope 失效发生在 Host 清理依赖之前，缓存的 UI 也必须立即消失。
    act(() => contexts.get("page")!.scope.revoke("page revoked"));
    expect(screen.queryByText("Contributing instance")).toBeNull();
  });
  it("hides contributor UI immediately while its revoked Scope awaits disposal", async () => {
    const { host, bind, renderer } = await fixture();
    bind("first").view.register({ id: "revoked", kind: "page", path: "/revoked", label: "Revoked", render: () => <OwnContents /> });
    const cached = renderer.renderPage("/revoked");
    render(<PluginHostProvider host={host}>{cached}</PluginHostProvider>);
    expect(screen.getByText("Contributing instance")).toBeTruthy();
    act(() => contexts.get("first")!.scope.revoke("awaiting disposal"));
    expect(screen.queryByText("Contributing instance")).toBeNull();
  });
  it("isolates observer exceptions from contribution commits and revocation cleanup", async () => {
    const { host, bind, renderer } = await fixture();
    renderer.subscribe(() => { throw new Error("Observer failed"); });
    const contribution = bind("first");
    expect(() => contribution.view.register({ id: "observed", kind: "page", path: "/observed", label: "Observed", render: () => null })).not.toThrow();
    expect(renderer.hasPage("/observed")).toBe(true);
    await host.revoke("first", "observer must not prevent cleanup");
    expect(renderer.hasPage("/observed")).toBe(false);
  });
  it("staged asynchronous registration is rejected after the contributing scope is revoked", async () => {
    const { host, bind, renderer } = await fixture();
    const registration: ScopedRegistryView<PageUiRegistration> = bind("first");
    const commit = registration.stage({ id: "late", kind: "page", path: "/late", label: "Late", render: () => null });
    await host.revoke("first", "async completion arrived late");
    await expect(commit.commit()).resolves.toBe(false);
    expect(renderer.hasPage("/late")).toBe(false);
  });
});
