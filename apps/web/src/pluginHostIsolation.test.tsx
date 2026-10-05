// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useContext } from "react";
import { defineCapability } from "webloom-framework";
import { WebLoomContext } from "webloom-framework/react";
import { PluginHostContext, PluginHostProvider, usePluginHost } from "@keymaster/runtime/assembly";
import { createFixtureHost } from "@keymaster/runtime/test-support";
import { PAGE_UI_REGISTRY_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, defineRuntimeUnitDependencies, type PluginContext } from "@keymaster/contracts";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";
afterEach(cleanup);
it("isolates raw Host/App Context across every Page contribution surface while trusted siblings retain Host", async () => {
  const secret = defineCapability<object>({ kind: "local", id: "fixture.host.secret", version: "1" });
  let consumerContext!: PluginContext;
  function Probe() {
    const host = useContext(PluginHostContext), app = useContext(WebLoomContext);
    expect(() => consumerContext.consumer.capability(secret)).toThrow();
    expect(() => usePluginHost()).toThrow("PluginHostContext is missing");
    return <span data-testid="isolated">{String(host === undefined && app === undefined)}</span>;
  }
  function Trusted() { return <span data-testid="trusted">{String(usePluginHost().capabilities.get(secret) === value)}</span>; }
  const value = {};
  const host = createFixtureHost({ runtime: "window-main", fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry"], runtimeUnitImplementationRegistry: { get: id => ctx => {
    if (id === "page") return pageSetup(ctx);
    if (id === "secret") ctx.provide(secret, value);
    if (id === "contributor") {
      consumerContext = ctx;
      const registry = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view;
      const shared = { label: "Probe", render: () => <Probe /> };
      registry.register({ ...shared, id: "probe.page", kind: "page", path: "/probe" });
      registry.register({ ...shared, id: "probe.settings", kind: "settings-block", path: "/probe" });
      registry.register({ ...shared, id: "probe.header", kind: "header", slot: "topbar" });
      registry.register({ ...shared, id: "probe.home", kind: "home", slot: "main" });
      registry.register({ ...shared, id: "probe.frame", kind: "frame", slot: "uri-action" });
    }
  } } });
  try {
    await host.registerAll([pagePlugin, { id: "secret", name: "Secret", units: [{ id: "secret.window", runtime: "window-main", scopeKind: "root", provides: [secret] }] },
      { id: "contributor", name: "Contributor", units: [{ id: "contributor.window", runtime: "window-main", scopeKind: "root", dependencies: defineRuntimeUnitDependencies([{ capability: PAGE_UI_REGISTRY_CAPABILITY }]) }] }]);
    const pages = host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY);
    render(<PluginHostProvider host={host}><Trusted />{pages.renderPage("/probe")}{pages.renderSettings("/probe")}{pages.renderHeader("topbar")}{pages.renderHome("main", true)}{pages.renderFrame("uri-action")}</PluginHostProvider>);
    expect(screen.getByTestId("trusted").textContent).toBe("true");
    expect(screen.getAllByTestId("isolated")).toHaveLength(6);
    expect(screen.getAllByTestId("isolated").every(node => node.textContent === "true")).toBe(true);
  } finally { cleanup(); await host.dispose(); }
});
it("does not export trusted Host assembly through the business runtime entry", async () => {
  const runtime = await import("@keymaster/runtime");
  for (const name of ["PluginHostContext", "PluginHostProvider", "usePluginHost", "useHost", "usePluginRuntime", "createKeymasterPluginHost", "getWebLoomHost", "bindWebLoomHost", "attachKeymasterRemoteRuntime"]) expect(runtime).not.toHaveProperty(name);
});
