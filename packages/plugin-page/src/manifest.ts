import { bsvChainResources } from "./settings/bsvChainResources.js";
import { HomePage } from "./HomePage.js";
import { homeResources } from "./homeResources.js";
import { settingsResources } from "./settings/resources.js";
import { setupSettingsPages } from "./settings/setupSettingsPages.js";
import { RUNTIME_DIAGNOSTICS_CAPABILITY } from "@keymaster/contracts";
import { createInstanceRegistry, createInstanceRegistryService } from "@keymaster/runtime";
import { createBreadcrumbRegistry } from "./registries/breadcrumbRegistry.js";
import { createBusinessFeatureRegistry } from "./registries/businessFeatureRegistry.js";
import { createNoticeRegistry } from "./registries/noticeRegistry.js";
import { AppShell } from "./shell/AppShell.js";
import { bindPageUi } from "./PageResourceContext.js";
import { OWNED_RESOURCE_ACCESS_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, BREADCRUMB_REGISTRY_CAPABILITY, NOTICE_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { createElement } from "react";
import { OnboardingShell } from "./shell/OnboardingShell.js";
import { I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { PAGE_UI_REGISTRY_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, type PluginManifest, type PluginSetup } from "@keymaster/contracts";
import { createPageRegistry } from "./pageRegistry.js";
const pagePluginDefinition = {
  id: "page", name: "Page", description: "Owns UI contributions and renders each with its contributing instance.",
  units: [{ id: "page.window", runtime: "window-main", scopeKind: "root",
    provides: [BREADCRUMB_REGISTRY_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, NOTICE_REGISTRY_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY], dependencies: [
      ...[OWNED_RESOURCE_ACCESS_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY].map(capability => ({ capability, sourceRuntime: "window-main" as const })),
      { capability: RUNTIME_DIAGNOSTICS_CAPABILITY, sourceRuntime: "window-main", reason: "Page 内部插件依赖图与实例恢复" },
      { capability: I18N_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "布局语言" }],
  }],
  i18n: { namespace: "common", resources: {
    en: { ...bsvChainResources.resources.en, ...settingsResources.resources.en, ...Object.fromEntries(Object.entries(homeResources.resources.en ?? {}).filter(([key]) => /home\.(domain|route|menu|page|business)\./.test(key))) },
    "zh-CN": { ...bsvChainResources.resources["zh-CN"], ...settingsResources.resources["zh-CN"], ...Object.fromEntries(Object.entries(homeResources.resources["zh-CN"] ?? {}).filter(([key]) => /home\.(domain|route|menu|page|business)\./.test(key))) },
  } },
} satisfies PluginManifest;
export const pagePlugin = pagePluginDefinition;
export const pageSetup: PluginSetup = ctx => {
  ctx.provide(BREADCRUMB_REGISTRY_CAPABILITY, createInstanceRegistryService(createBreadcrumbRegistry(), BREADCRUMB_REGISTRY_CAPABILITY, undefined, ctx.scope));
  ctx.provide(BUSINESS_REGISTRY_CAPABILITY, createInstanceRegistryService(createBusinessFeatureRegistry(), BUSINESS_REGISTRY_CAPABILITY, { name: BUSINESS_REGISTRY_CAPABILITY.id, registrations: [{ method: "register", idArgument: 1, unregisterMethod: "unregisterDomain", unregisterArgument: 0, bindPluginIdArgument: 0 }, { method: "registerFeature", idArgument: 2, unregisterMethod: "unregisterFeature", unregisterArgument: 0, bindPluginIdArgument: 0 }] }, ctx.scope));
  const noticeRegistry = createInstanceRegistry(createNoticeRegistry(), NOTICE_REGISTRY_CAPABILITY, { name: NOTICE_REGISTRY_CAPABILITY.id, registrations: [{ method: "upsert", idArgument: 0, unregisterMethod: "dismiss", ownerPluginIdProperty: "sourcePluginId" }] }, ctx.scope);
  ctx.provide(NOTICE_REGISTRY_CAPABILITY, noticeRegistry.service);
  const noticeControls = {
    isCurrent(notice: import("@keymaster/contracts").NoticeRecord) { ctx.scope.assertActive(); return noticeRegistry.privateView.list().includes(notice); },
    dismiss(notice: import("@keymaster/contracts").NoticeRecord) { if (this.isCurrent(notice)) noticeRegistry.privateView.dismiss(notice.id); },
  };

  const page = createPageRegistry(label => ctx.capability(I18N_SERVICE_CAPABILITY).text(label));
  const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
  resources.register({ id: "page.home", scope: "global", key: () => ["page.home"], load: async () => page.renderer.revision(), subscribe: (_args, _context, invalidate) => page.renderer.subscribe(invalidate), invalidation: "immediate" });
  const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
  const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
  const notices = ctx.capability(NOTICE_REGISTRY_CAPABILITY);
  resources.register({ id: "page.navigation", scope: "global", key: () => ["page.navigation"], load: async () => business.listDomains(), subscribe: (_args, _context, invalidate) => business.subscribe(invalidate), invalidation: "immediate" });
  resources.register({ id: "page.breadcrumbs", scope: "global", key: args => ["page.breadcrumbs", args[0] ?? "/"], load: async args => breadcrumbs.match(args[0] ?? "/")?.resolve(args[0] ?? "/") ?? [], invalidation: "immediate" });
  resources.register({ id: "page.notices", scope: "global", key: () => ["page.notices"], load: async () => notices.list(), subscribe: (_args, _context, invalidate) => notices.subscribe(invalidate), invalidation: "immediate" });
  ctx.provide(PAGE_UI_REGISTRY_CAPABILITY, page.registry);
  ctx.provide(PAGE_UI_RENDERER_CAPABILITY, page.renderer);
  const Shell = bindPageUi(ctx, AppShell, noticeControls);
  page.registry.bind(ctx.consumer, ctx.scope).view.register({ kind: "frame", slot: "unlocked-shell", id: "page.shell", label: "Page", render: () => createElement(Shell) });
  page.registry.bind(ctx.consumer, ctx.scope).view.register({ kind: "frame", slot: "onboarding", id: "page.onboarding", label: "Onboarding",
    render: location => createElement(OnboardingShell, { width: location.width, children: location.children }) });
  const Home = bindPageUi(ctx, HomePage);
  page.registry.bind(ctx.consumer, ctx.scope).view.register({ id: "home.overview", kind: "page", path: "/", label: { key: "home.route.label", fallback: "Home" }, render: () => createElement(Home) });
  business.register("page", { id: "home", label: { key: "home.domain.label", fallback: "Overview" }, order: 0,
    features: [{ id: "home.overview", label: { key: "home.menu.label", fallback: "Home" }, order: 0, icon: "Home", entry: { path: "/", routeId: "home.overview" } }] });
  business.register("page", { id: "assets", label: { key: "assets.domain.label", fallback: "Wallet" }, order: 20, features: [] });
  setupSettingsPages(ctx);
  ctx.scope.onRevoke(() => page.dispose());
  return () => page.dispose();
};
