import type { BreadcrumbProvider, I18nPluginResources, PluginManifest, PluginSetup, P2pkhCoordinatorControl } from "@keymaster/contracts";
import { JUNGLEBUS_COORDINATOR_CONTROL_CAPABILITY, SYSTEM_SETTINGS_REGISTRY_CAPABILITY, BREADCRUMB_REGISTRY_CAPABILITY, capabilityDescriptor, defineRuntimeUnitDependencies } from "@keymaster/contracts";
import { JungleBusSettingsPage } from "./pages/JungleBusSettingsPage.js";

export const jungleBusResources: I18nPluginResources = {
  namespace: "junglebus",
  resources: {
    en: { "junglebus.name": "JungleBus", "junglebus.description": "Confirmed transaction sync provider for ordinary BSV/P2PKH.", "junglebus.settings.title": "JungleBus settings", "junglebus.settings.description": "Configure the worker-owned JungleBus endpoints and request policy.", "junglebus.crumb.settings": "Settings", "junglebus.crumb.junglebus": "JungleBus", "junglebus.settings.endpoint": "JungleBus endpoint", "junglebus.settings.mainEndpoint": "JungleBus mainnet endpoint", "junglebus.settings.testEndpoint": "JungleBus testnet endpoint", "junglebus.settings.rate": "Requests per second", "junglebus.settings.timeout": "Request timeout (ms)", "junglebus.settings.retries": "429 retries", "junglebus.settings.note": "JungleBus is confirmed-sync only. Subscription, WebSocket, and broadcast settings are intentionally unavailable.", "junglebus.settings.unavailable": "Wallet is locked or the JungleBus service is temporarily unavailable; unlock to continue configuring." },
    "zh-CN": { "junglebus.name": "JungleBus", "junglebus.description": "普通 BSV/P2PKH 的已确认交易同步供应商。", "junglebus.settings.title": "JungleBus 设置", "junglebus.settings.description": "配置由 Worker 持有的 JungleBus 双网络 endpoint 与请求策略。", "junglebus.crumb.settings": "设置", "junglebus.crumb.junglebus": "JungleBus", "junglebus.settings.endpoint": "JungleBus endpoint", "junglebus.settings.mainEndpoint": "JungleBus 主网 endpoint", "junglebus.settings.testEndpoint": "JungleBus 测试网 endpoint", "junglebus.settings.rate": "每秒请求数", "junglebus.settings.timeout": "请求超时（毫秒）", "junglebus.settings.retries": "429 重试次数", "junglebus.settings.note": "JungleBus 仅提供确认同步；订阅、WebSocket 与广播设置不可用。", "junglebus.settings.unavailable": "钱包已锁定或 JungleBus 服务暂不可用；解锁后可继续配置。" }
  }
};

const jungleBusPluginDefinition = {
  id: "junglebus", name: "JungleBus", description: "Confirmed transaction sync provider; no broadcast or subscription capability.",
  kind: "platform", startup: "optional", bootstrapStage: "owner-apps-ready", defaultEnabled: true, canDisable: true, displayGroup: "platform",
  units: [{
    id: "junglebus.window",
    runtime: "window-main",
    scopeKind: "owner-session",
    provides: [capabilityDescriptor(JUNGLEBUS_COORDINATOR_CONTROL_CAPABILITY)],
    dependencies: defineRuntimeUnitDependencies([
      { capability: SYSTEM_SETTINGS_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册 JungleBus provider 设置页" },
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册 JungleBus 设置面包屑" },
    ]),
  }, {
    id: "junglebus.coordinator-worker",
    runtime: "shared-worker",
    scopeKind: "owner-session",
  }],
  i18n: jungleBusResources,
  setup(ctx) {
    const coordinator = ctx.coordinator as P2pkhCoordinatorControl | undefined;
    if (!coordinator) throw new Error("JungleBus Coordinator control is unavailable");
    ctx.provide(JUNGLEBUS_COORDINATOR_CONTROL_CAPABILITY, coordinator);
    // The worker uses this durable flag to mirror the host plugin lifecycle;
    // a disabled optional plugin must not leave its provider executable.
    void coordinator.p2pkhProviderConfigUpdate("junglebus", { enabled: true });
    const settings = ctx.capability(SYSTEM_SETTINGS_REGISTRY_CAPABILITY);
    settings.register({ id: "junglebus.system-settings.connection", group: { id: "junglebus", label: { key: "junglebus.crumb.junglebus", fallback: "JungleBus" }, order: 45 }, label: { key: "junglebus.settings.title", fallback: "JungleBus settings" }, description: { key: "junglebus.settings.description", fallback: "Worker-owned JungleBus endpoint and request policy." }, component: JungleBusSettingsPage, order: 10, visibleWhen: ({ unlocked }) => unlocked });
    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
    const provider: BreadcrumbProvider = { id: "junglebus.crumbs", order: 255, match: (path) => path === "/settings/junglebus", resolve: () => [{ label: { key: "junglebus.crumb.settings", fallback: "Settings" } }, { label: { key: "junglebus.crumb.junglebus", fallback: "JungleBus" } }] };
    breadcrumbs.register(provider);
    return () => { void coordinator.p2pkhProviderConfigUpdate("junglebus", { enabled: false }); };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: jungleBusSetup, ...jungleBusPlugin } = jungleBusPluginDefinition;
export { jungleBusSetup, jungleBusPlugin };
