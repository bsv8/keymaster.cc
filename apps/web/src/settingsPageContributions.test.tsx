import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PAGE_UI_RENDERER_CAPABILITY, RUNTIME_DIAGNOSTICS_CAPABILITY, type PluginContext, type PluginManifest } from "@keymaster/contracts";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";
const hosts: ReturnType<typeof createKeymasterPluginHost>[] = [];
afterEach(async () => { cleanup(); await Promise.all(hosts.splice(0).map(host => host.dispose())); });
it("renders scoped plugin diagnostics, retries a real failed instance and revokes its view with Page", async () => {
  let recovered = false;
  const contexts = new Map<string, PluginContext>();
  const host = createKeymasterPluginHost({ fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry"], runtime: "window-main", runtimeUnitImplementationRegistry: {
    get: id => ctx => {
      contexts.set(id, ctx);
      if (id === "page") return pageSetup(ctx);
      if (id === "p2pkh" && !recovered) throw new Error("diagnostic fixture failure");
    },
  } });
  hosts.push(host);
  const failed: PluginManifest = { id: "p2pkh", name: "Recoverable fixture", units: [{ id: "p2pkh.window", runtime: "window-main", scopeKind: "root" }] };
  await host.registerAll([failed, { ...failed, id: "outsider", name: "Undeclared diagnostics", units: [{ id: "outsider.window", runtime: "window-main", scopeKind: "root" }] }, pagePlugin]);
  const pages = host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY);
  expect(host.state("page"), host.state("page").error).toMatchObject({ kind: "enabled" });
  expect(host.routes.byPath("/settings/plugins")).toBeUndefined();
  expect(pages.hasPage("/settings/plugins")).toBe(true);
  const settings = contexts.get("page")!, outsider = contexts.get("outsider")!;
  const access = settings.capability(RUNTIME_DIAGNOSTICS_CAPABILITY);
  expect(() => access.bind(outsider.consumer, outsider.scope)).toThrow();
  const view = access.bind(settings.consumer, settings.scope);
  expect(view.snapshot().plugins.find(plugin => plugin.id === "page")).not.toHaveProperty("setup");
  const cached = pages.renderPage("/settings/plugins");
  render(<PluginHostProvider host={host}>{cached}</PluginHostProvider>);
  fireEvent.click(document.querySelector('[data-plugin-id="p2pkh"]')!);
  expect(screen.getAllByText(/diagnostic fixture failure/).length).toBeGreaterThan(0);
  recovered = true;
  fireEvent.click(screen.getByRole("button", { name: /^Retry$|^重试$/ }));
  await waitFor(() => expect(host.state("p2pkh").kind).toBe("enabled"));
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Retry$|^重试$/ })).toBeNull());
  await expect(view.retry("unknown")).rejects.toThrow();
  await act(() => host.revoke("page", "page removed"));
  expect(() => pages.hasPage("/settings/plugins")).toThrow(/disposed/);
  expect(document.querySelector(".plugin-manager")).toBeNull();
  expect(() => view.snapshot()).toThrow();
  await expect(view.retry("p2pkh")).rejects.toThrow();
});
