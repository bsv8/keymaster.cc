import { bindPageUi } from "../PageResourceContext.js";
import { BsvChainSettingsPage } from "./BsvChainSettingsPage.js";
import { createElement } from "react";
import { PAGE_UI_REGISTRY_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, BREADCRUMB_REGISTRY_CAPABILITY, RUNTIME_DIAGNOSTICS_CAPABILITY, type PluginContext } from "@keymaster/contracts";
import { SettingsDiagnosticsProvider } from "./SettingsDiagnosticsContext.js";
import { PluginManagerPage } from "./PluginManagerPage.js";
import { SystemStatusPage } from "./SystemStatusPage.js";
const settingsBusiness: import("@keymaster/contracts").PluginBusinessContribution = {
  domains: [{
    id: "settings",
    label: { key: "settings.business.domain", fallback: "Settings" },
    order: 900,
    features: [{
      id: "settings.plugins",
      label: { key: "settings.business.plugins", fallback: "Plugin settings" },
      order: 40,
      icon: "Puzzle",
      entry: { path: "/settings/plugins", routeId: "settings.plugins.page" }
    }, {
      id: "settings.system-status",
      label: { key: "settings.systemStatus.title", fallback: "Broadcast gateway" },
      order: 50,
      icon: "Activity",
      entry: { path: "/settings/system-status", routeId: "settings.system-status.page" }
    }]
  }]
};

/** Page 自己持有通用设置容器和诊断视图；贡献块仍由业务提供方渲染。 */
export function setupSettingsPages(ctx: PluginContext) {



    ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view.register({
      id: "settings.system-status.page", path: "/settings/system-status",
      kind: "page", settingsPlacement: "embedded",
      label: { key: "settings.systemStatus.title", fallback: "Broadcast gateway" }, render: () => createElement(SystemStatusPage),
    });
    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
    for (const domain of settingsBusiness.domains) business.register("page", domain);
  const ChainSettings = bindPageUi(ctx, BsvChainSettingsPage);
  ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view.register({ id: "settings.bsv-chain", kind: "page", path: "/settings/bsv-chain", settingsPlacement: "embedded",
    label: { key: "bsvChain.menu", fallback: "BSV Chain" }, render: () => createElement(ChainSettings),
  });
  ctx.capability(BUSINESS_REGISTRY_CAPABILITY).registerFeature("page", "settings", {
    id: "settings.bsv-chain", label: { key: "bsvChain.menu", fallback: "BSV Chain" }, order: 20, icon: "Network",
    entry: { path: "/settings/bsv-chain", routeId: "settings.bsv-chain", visibleWhen: ({ unlocked }) => unlocked },
  });
  ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY).register({
    id: "settings.bsv-chain.crumbs", order: 190, match: path => path === "/settings/bsv-chain",
    resolve: () => [{ label: { key: "bsvChain.crumb.settings", fallback: "Settings" } }, { label: { key: "bsvChain.page.title", fallback: "BSV Chain" } }],
  });
    const diagnostics = ctx.capability(RUNTIME_DIAGNOSTICS_CAPABILITY).bind(ctx.consumer, ctx.scope);
    ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view.register({
      id: "settings.plugins.page", kind: "page", path: "/settings/plugins",
      label: { key: "settings.route.plugins", fallback: "Plugins" },
      render: () => createElement(SettingsDiagnosticsProvider, { view: diagnostics, isActive: () => ctx.scope.state === "active" && ctx.consumer.status === "active", children: createElement(PluginManagerPage) }),
    });
    // 面包屑：当前路径匹配时第一段固定为不可点击的"设置"分类节点。
    // 这样 plugin 的 settings breadcrumb 不再回指不存在的 /settings，
    // 同时与 /settings/example 等其它设置详情页保持一致的第一段样式。
    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
    breadcrumbs.register({
      id: "settings.plugins.crumbs",
      order: 5,
      match: (path) => path === "/settings/plugins",
      resolve: () => [
        // 第一段：不可点击"设置"分类节点（无 path）。
        { label: { key: "settings.crumb.settings", fallback: "Settings" } },
        { label: { key: "settings.crumb.plugins", fallback: "Plugins" } }
      ]
    });
}
