// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { usePluginCapability } from "webloom-framework/react";
import { defineCapability } from "webloom-framework";
import { createFixtureHost } from "@keymaster/runtime/test-support";
import { observeOptionalCapability } from "@keymaster/runtime";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";
import { scanPlugin, scanSetup } from "@keymaster/plugin-scan";
import { URI_ACTION_REGISTRY_CAPABILITY, URI_ACTION_RESOLVER_CAPABILITY, SCAN_UI_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, defineRuntimeUnitDependencies, type PluginContext, type PluginManifest, type UriActionHandler } from "@keymaster/contracts";
const hosts: ReturnType<typeof createFixtureHost>[] = [];
afterEach(async () => { cleanup(); await Promise.all(hosts.splice(0).map(host => host.dispose())); });
const own = defineCapability<string>({ kind: "local", id: "fixture.uri.identity", version: "1" });
function Business() { const identity = usePluginCapability(own); return <div data-testid="uri-business">{identity}</div>; }
async function fixture(optionalHandler = false) {
 const contexts = new Map<string, PluginContext>();
 const host = createFixtureHost({ runtime: "window-main", fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry"], runtimeUnitImplementationRegistry: {
   get: id => ctx => { contexts.set(id, ctx); if (id === "page") return pageSetup(ctx); if (id === "scan") return scanSetup(ctx); if (id === "handler") ctx.provide(own, "handler instance"); },
 } }); hosts.push(host);
 const manifest = (id: string, capabilities: (typeof URI_ACTION_REGISTRY_CAPABILITY)[]): PluginManifest => ({ id, name: id, units: [{ id: id + ".window", runtime: "window-main", scopeKind: "root", dependencies: defineRuntimeUnitDependencies(capabilities.map(capability => ({ capability, optional: optionalHandler && id === "handler" }))) }] });
 await host.registerAll([pagePlugin, scanPlugin,
   { ...manifest("handler", [URI_ACTION_REGISTRY_CAPABILITY]), units: [{ ...manifest("handler", [URI_ACTION_REGISTRY_CAPABILITY]).units![0]!, provides: [own] }] },
   { id: "caller", name: "caller", units: [{ id: "caller.window", runtime: "window-main", scopeKind: "root", dependencies: defineRuntimeUnitDependencies([{ capability: URI_ACTION_RESOLVER_CAPABILITY }, { capability: SCAN_UI_CAPABILITY }]) }] },
   { id: "second", name: "second", units: [{ id: "second.window", runtime: "window-main", scopeKind: "root", dependencies: defineRuntimeUnitDependencies([{ capability: URI_ACTION_RESOLVER_CAPABILITY }]) }] }, manifest("outsider", []),
 ]);
 expect(host.state("scan"), host.state("scan").error).toMatchObject({ kind: "enabled" });
 const handler = contexts.get("handler")!, caller = contexts.get("caller")!, second = contexts.get("second")!, outsider = contexts.get("outsider")!;
 const registry = handler.capability(URI_ACTION_REGISTRY_CAPABILITY).bind(handler.consumer, handler.scope);
 const resolver = caller.capability(URI_ACTION_RESOLVER_CAPABILITY).bind(caller.consumer, caller.scope);
 const otherResolver = second.capability(URI_ACTION_RESOLVER_CAPABILITY).bind(second.consumer, second.scope);
 const entry: UriActionHandler = { id: "fixture.action", resolve: input => input === "secret input" ? [{ id: "first", label: "First action" }, { id: "second", label: "Second action" }] : [], render: () => <Business /> };
 registry.view.register(entry);
 const pages = host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY);
 return { host, contexts, handler, caller, outsider, registry, resolver, otherResolver, entry, pages };
}
it("returns only frozen summaries, keeps multiple actions and renders under the provider consumer", async () => {
 const { host, resolver, pages } = await fixture();
 const result = resolver.resolve("secret input");
 expect(result.candidates.map(item => item.label)).toEqual(["First action", "Second action"]);
 expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.candidates[0])).toBe(true);
 expect(JSON.stringify(result)).not.toContain("secret input");
 expect(result.candidates[0]).not.toHaveProperty("render");
 expect(result.candidates[0]).not.toHaveProperty("resolve");
 render(<PluginHostProvider host={host}>{pages.renderFrame("uri-action")}</PluginHostProvider>);
 act(() => resolver.activate(result.id, result.candidates[0]!.id));
 expect(screen.getByTestId("uri-business").textContent).toBe("handler instance");
 await act(() => host.revoke("handler", "handler removed"));
 expect(screen.queryByTestId("uri-business")).toBeNull();
 expect(() => resolver.activate(result.id, result.candidates[0]!.id)).toThrow();
});
it("rejects foreign instances, undeclared consumers, forged Scope and cached revoked access", async () => {
 const { host, caller, handler, outsider, resolver, otherResolver } = await fixture();
 const access = caller.capability(URI_ACTION_RESOLVER_CAPABILITY);
 expect(() => access.bind(outsider.consumer, outsider.scope)).toThrow();
 expect(() => access.bind(caller.consumer, handler.scope)).toThrow();
 expect(() => access.bind({ ...caller.consumer }, caller.scope)).toThrow();
 const result = resolver.resolve("secret input");
 expect(() => otherResolver.activate(result.id, result.candidates[0]!.id)).toThrow(/another instance/);
 expect(() => otherResolver.release(result.id)).toThrow();
 await host.revoke("caller", "caller removed");
 expect(() => resolver.resolve("secret input")).toThrow();
 expect(() => resolver.activate(result.id, result.candidates[0]!.id)).toThrow();
});
it("isolates bad handlers, limits input and evicts/releases ephemeral resolutions", async () => {
 const { registry, resolver } = await fixture();
 registry.view.register({ id: "throws", resolve: () => { throw new Error("bad handler"); }, render: () => null });
 expect(resolver.resolve("secret input").candidates).toHaveLength(2);
 expect(resolver.resolve("unknown").candidates).toHaveLength(0);
 expect(() => resolver.resolve("")).toThrow(); expect(() => resolver.resolve("x".repeat(16385))).toThrow();
 const first = resolver.resolve("secret input");
 for (let i = 0; i < 16; i++) resolver.resolve("secret input");
 expect(() => resolver.activate(first.id, first.candidates[0]!.id)).toThrow(/expired/);
 const next = resolver.resolve("secret input"); resolver.release(next.id);
 expect(() => resolver.activate(next.id, next.candidates[0]!.id)).toThrow(/expired/);
});
it("does not revive old tokens when a handler is removed and registered with the same id", async () => {
 const { registry, resolver, entry } = await fixture();
 const result = resolver.resolve("secret input");
 registry.view.unregister(entry.id); registry.view.register(entry);
 expect(() => resolver.activate(result.id, result.candidates[0]!.id)).toThrow();
 expect(resolver.resolve("secret input").candidates).toHaveLength(2);
});
it("opens from another plugin without camera access, and caller revocation closes its UI", async () => {
 const { host, caller, pages } = await fixture();
 const scan = caller.capability(SCAN_UI_CAPABILITY).bind(caller.consumer, caller.scope);
 render(<PluginHostProvider host={host}>{pages.renderFrame("uri-action")}</PluginHostProvider>);
 act(() => scan.open("secret input"));
 expect(screen.getByRole("button", { name: "First action" })).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "First action" }));
 expect(screen.getByTestId("uri-business")).toBeTruthy();
 await act(() => host.revoke("caller", "origin removed"));
 expect(screen.queryByTestId("uri-business")).toBeNull();
});

it("withdraws and rebinds an optional handler when Scan is revoked and restarted", async () => {
 const { host, contexts, handler, registry, entry, resolver, pages } = await fixture(true);
 registry.view.unregister(entry.id);
 observeOptionalCapability(handler, URI_ACTION_REGISTRY_CAPABILITY, service => {
   const binding = service.bind(handler.consumer, handler.scope);
   binding.view.register(entry);
   return () => { try { binding.view.unregister(entry.id); } catch { /* Provider has revoked. */ } };
 });
 const result = resolver.resolve("secret input");
 const mounted = render(<PluginHostProvider host={host}>{pages.renderFrame("uri-action")}</PluginHostProvider>);
 act(() => resolver.activate(result.id, result.candidates[0]!.id));
 expect(screen.getByTestId("uri-business")).toBeTruthy();
 await act(() => host.revoke("scan", "scan withdrawn"));
 expect(screen.queryByTestId("uri-business")).toBeNull();
 expect(host.state("handler").kind).toBe("enabled");
 expect(() => resolver.resolve("secret input")).toThrow();
 await act(() => host.retry("scan"));
 const caller = contexts.get("caller")!;
 const next = caller.capability(URI_ACTION_RESOLVER_CAPABILITY).bind(caller.consumer, caller.scope);
 expect(next.resolve("secret input").candidates).toHaveLength(2);
 mounted.rerender(<PluginHostProvider host={host}>{pages.renderFrame("uri-action")}</PluginHostProvider>);
 const action = next.resolve("secret input");
 act(() => next.activate(action.id, action.candidates[0]!.id));
 expect(screen.getByTestId("uri-business").textContent).toBe("handler instance");
});

it("executes a URI render callback inside its provider consumer and without inherited Host", async () => {
 const { registry, resolver, pages, host } = await fixture();
 registry.view.register({ id: "hook-render", resolve: () => [{ id: "hook", label: "Hook action" }], render: () => {
   const identity = usePluginCapability(own);
   return <div data-testid="hook-render-identity">{identity}</div>;
 } });
 render(<PluginHostProvider host={host}>{pages.renderFrame("uri-action")}</PluginHostProvider>);
 const result = resolver.resolve("hook input");
 act(() => resolver.activate(result.id, result.candidates[0]!.id));
 expect(screen.getByTestId("hook-render-identity").textContent).toBe("handler instance");
});
