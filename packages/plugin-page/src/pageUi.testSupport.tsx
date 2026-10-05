import { createElement, type ReactNode, type ComponentType } from "react";
import { BREADCRUMB_REGISTRY_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, I18N_SERVICE_CAPABILITY, NOTICE_REGISTRY_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, type PluginContext, type PluginSetup } from "@keymaster/contracts";
import { createFixtureHost } from "@keymaster/runtime/test-support";
import type { FixtureHost as PluginHost } from "@keymaster/runtime/test-support";
import { bindPageUi } from "./PageResourceContext.js";
import { matchPagePath } from "./pagePath.js";
const implementations = new WeakMap<PluginHost, Map<string, PluginSetup>>();
export function createPageTestHost(options: Parameters<typeof createFixtureHost>[0] = {}) {
  const setups = new Map<string, PluginSetup>();
  const host = createFixtureHost({ ...options, runtimeUnitImplementationRegistry: { get: (id, unitId) => setups.get(id) ?? options.runtimeUnitImplementationRegistry?.get(id, unitId) } });
  const renderer = { revision: () => 0, subscribe: () => () => {}, renderHeader: () => null, renderHome: () => null, renderFrame: (_slot: string, children?: ReactNode) => children,
    hasPage: (path: string) => host.routes.list().some(route => !!matchPagePath(route.path, path)), hasSettings: () => false, renderSettings: () => null,
    renderPage: (path: string) => { const Component = host.routes.list().find(route => !!matchPagePath(route.path, path))?.component; return Component ? createElement(Component) : null; },
  };
  host.provide(PAGE_UI_RENDERER_CAPABILITY, renderer);
  implementations.set(host, setups); return host;
}
export async function bindTestPageUi<P extends object>(host: PluginHost, Component: ComponentType<P>) {
  let context!: PluginContext;
  implementations.get(host)!.set("page-ui-fixture", ctx => {
    context = ctx;
    const registry = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
    const notices = ctx.capability(NOTICE_REGISTRY_CAPABILITY);
    registry.register({ id: "page.navigation", scope: "global", key: () => ["nav"], load: async () => business.listDomains(), invalidation: "immediate" });
    registry.register({ id: "page.breadcrumbs", scope: "global", key: args => ["page.breadcrumbs", ...args], load: async args => breadcrumbs.match(args[0] ?? "/")?.resolve(args[0] ?? "/") ?? [], invalidation: "immediate" });
    registry.register({ id: "page.notices", scope: "global", key: () => ["notices"], load: async () => notices.list(), subscribe: (_args, _ctx, invalidate) => notices.subscribe(invalidate), invalidation: "immediate" });
  });
  await host.register({ id: "page-ui-fixture", name: "Page UI fixture", units: [{ id: "page-ui-fixture.window", runtime: "window-main", scopeKind: "root", dependencies: [OWNED_RESOURCE_ACCESS_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, I18N_SERVICE_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, BREADCRUMB_REGISTRY_CAPABILITY, NOTICE_REGISTRY_CAPABILITY].map(capability => ({ capability, sourceRuntime: "window-main" as const })) }] });
  if (host.state("page-ui-fixture").kind !== "enabled") throw new Error(JSON.stringify(host.state("page-ui-fixture")));
  return bindPageUi(context, Component, { isCurrent: notice => host.notice.list().includes(notice), dismiss: notice => { if (host.notice.list().includes(notice)) host.notice.dismiss(notice.id); } });
}
