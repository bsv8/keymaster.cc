import type { BreadcrumbProvider, BreadcrumbRegistry, I18nPluginResources, PluginManifest, SessionCoordinatorClient, SystemSettingsRegistry } from "@keymaster/contracts";
import { SESSION_COORDINATOR_CLIENT_CAPABILITY } from "@keymaster/contracts";
import { JungleBusSettingsPage } from "./pages/JungleBusSettingsPage.js";

export const jungleBusResources: I18nPluginResources = {
  namespace: "junglebus",
  resources: {
    en: { "junglebus.name": "JungleBus", "junglebus.description": "Confirmed transaction sync provider for ordinary BSV/P2PKH.", "junglebus.settings.title": "JungleBus settings", "junglebus.settings.description": "Configure the worker-owned JungleBus endpoints and request policy.", "junglebus.crumb.settings": "Settings", "junglebus.crumb.junglebus": "JungleBus", "junglebus.settings.endpoint": "JungleBus endpoint", "junglebus.settings.mainEndpoint": "JungleBus mainnet endpoint", "junglebus.settings.testEndpoint": "JungleBus testnet endpoint", "junglebus.settings.rate": "Requests per second", "junglebus.settings.timeout": "Request timeout (ms)", "junglebus.settings.retries": "429 retries", "junglebus.settings.note": "JungleBus is confirmed-sync only. Subscription, WebSocket, and broadcast settings are intentionally unavailable." },
    "zh-CN": { "junglebus.name": "JungleBus", "junglebus.description": "普通 BSV/P2PKH 的已确认交易同步供应商。", "junglebus.settings.title": "JungleBus 设置", "junglebus.settings.description": "配置由 Worker 持有的 JungleBus 双网络 endpoint 与请求策略。", "junglebus.crumb.settings": "设置", "junglebus.crumb.junglebus": "JungleBus", "junglebus.settings.endpoint": "JungleBus endpoint", "junglebus.settings.mainEndpoint": "JungleBus 主网 endpoint", "junglebus.settings.testEndpoint": "JungleBus 测试网 endpoint", "junglebus.settings.rate": "每秒请求数", "junglebus.settings.timeout": "请求超时（毫秒）", "junglebus.settings.retries": "429 重试次数", "junglebus.settings.note": "JungleBus 仅提供确认同步；订阅、WebSocket 与广播设置不可用。" }
  }
};

export const jungleBusPlugin: PluginManifest = {
  id: "junglebus", name: "JungleBus", description: "Confirmed transaction sync provider; no broadcast or subscription capability.",
  meta: { kind: "platform", startup: "optional", defaultEnabled: true, canDisable: true, providesCapabilities: [], displayGroup: "platform" },
  i18n: jungleBusResources,
  dependencies: [
    { capability: SESSION_COORDINATOR_CLIENT_CAPABILITY, reason: "通过 Coordinator RPC 管理 Worker 可读的 provider 配置" },
    { capability: "system-settings.registry", reason: "注册 JungleBus provider 设置页" },
    { capability: "breadcrumb.registry", reason: "注册 JungleBus 设置面包屑" }
  ],
  setup(ctx) {
    const coordinator = ctx.get<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY);
    // The worker uses this durable flag to mirror the host plugin lifecycle;
    // a disabled optional plugin must not leave its provider executable.
    void coordinator.p2pkhProviderConfigUpdate("junglebus", { enabled: true });
    const settings = ctx.get<SystemSettingsRegistry>("system-settings.registry");
    settings.register({ id: "junglebus.system-settings.connection", group: { id: "junglebus", label: { key: "junglebus.crumb.junglebus", fallback: "JungleBus" }, order: 45 }, label: { key: "junglebus.settings.title", fallback: "JungleBus settings" }, description: { key: "junglebus.settings.description", fallback: "Worker-owned JungleBus endpoint and request policy." }, component: JungleBusSettingsPage, order: 10, visibleWhen: ({ unlocked }) => unlocked });
    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    const provider: BreadcrumbProvider = { id: "junglebus.crumbs", order: 255, match: (path) => path === "/settings/junglebus", resolve: () => [{ label: { key: "junglebus.crumb.settings", fallback: "Settings" } }, { label: { key: "junglebus.crumb.junglebus", fallback: "JungleBus" } }] };
    breadcrumbs.register(provider);
    return () => { void coordinator.p2pkhProviderConfigUpdate("junglebus", { enabled: false }); };
  }
};
