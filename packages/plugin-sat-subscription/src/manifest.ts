// SatSubscription 平台插件清单。
//
// SatSubscription 只提供 SSP/SPI 管理能力；Channel runtime 的唯一实例在
// SharedWorker Coordinator 中，通过受控 capability 暴露给业务插件。

import type {
  ChannelRuntimeFactory,
  I18nPluginResources,
  PluginContext,
  PluginManifest,
  ResourceRegistry,
  SatSubscriptionAdminService,
  SatSubscriptionSpiService,
  SatSubscriptionSettingsSnapshot,
  SessionCoordinatorClient,
  SystemSettingsRegistry,
  SystemStatusRegistry,
  WindowP2pExecutorLaneRegistry
} from "@keymaster/contracts";
import {
  CHANNEL_RUNTIME_CAPABILITY,
  SAT_SUBSCRIPTION_PLUGIN_ID,
  SAT_SUBSCRIPTION_SERVICE_CAPABILITY,
  SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY,
  SAT_COORDINATOR_CONTROL_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  type SatCoordinatorControl,
  WINDOW_P2P_EXECUTOR_CAPABILITY
} from "@keymaster/contracts";

export { SAT_SUBSCRIPTION_PLUGIN_ID } from "@keymaster/contracts";
import { SatSubscriptionSettings } from "./SatSubscriptionSettings.js";
import { SatWindowP2pLane } from "./satWindowLane.js";
import { createSatWorkerAdminService, createSatWorkerChannelRuntime, createSatWorkerSpiService } from "./satWorkerProxy.js";

export const SAT_SUBSCRIPTION_ROUTE_PATH = "/settings/system";

const resources: I18nPluginResources = {
  namespace: "common",
  resources: {
    en: {
      "sat.settings.title": "SatSubscription",
      "sat.settings.description": "Multi-supplier SSP subscriptions and SPI account management.",
      "sat.settings.suppliers": "Suppliers",
      "sat.settings.identity": "Authenticated public key",
      "sat.settings.connection": "Connection",
      "sat.settings.actions": "Actions",
      "sat.settings.edit": "Edit",
      "sat.settings.editing": "Editing supplier",
      "sat.settings.enable": "Enable",
      "sat.settings.disable": "Disable",
      "sat.settings.enabled": "Enabled",
      "sat.settings.disabled": "Disabled",
      "sat.settings.enabledField": "Enable supplier",
      "sat.settings.desired": "Desired subscriptions",
      "sat.settings.observed": "Remote observed",
      "sat.settings.none": "none",
      "sat.settings.subscriptions.refresh": "Refresh remote subscriptions",
      "sat.settings.subscriptions.refreshed": "Remote subscriptions refreshed.",
      "sat.settings.default": "Use for new Publish",
      "sat.settings.receive.on": "Enable receive (may charge)",
      "sat.settings.receive.off": "Disable receive",
      "sat.settings.delete": "Delete",
      "sat.settings.deleteConfirm": "Delete this supplier? Its balance will not be collected automatically.",
      "sat.settings.deleted": "Supplier deleted; its balance was not collected.",
      "sat.settings.empty": "No suppliers configured.",
      "sat.settings.add": "Add or update supplier",
      "sat.settings.id": "Supplier id",
      "sat.settings.name": "Display name",
      "sat.settings.key": "Supplier public key",
      "sat.settings.addresses": "libp2p addresses",
      "sat.settings.save": "Save supplier",
      "sat.settings.saved": "Supplier configuration saved.",
      "sat.settings.audit": "Recent SSP charges",
      "sat.settings.unknown": "unknown",
      "sat.settings.spi.refresh": "Refresh SPI balance",
      "sat.settings.spi.topupAmount": "Top-up satoshis",
      "sat.settings.spi.collectAmount": "Collect satoshis",
      "sat.settings.spi.prepare": "Prepare top-up",
      "sat.settings.spi.confirm": "Confirm and broadcast",
      "sat.settings.spi.cancel": "Cancel",
      "sat.settings.spi.collect": "Collect balance",
      "sat.settings.spi.preview": "Top-up preview"
    },
    "zh-CN": {
      "sat.settings.title": "SatSubscription",
      "sat.settings.description": "多供应商 SSP 订阅与 SPI 账户管理。",
      "sat.settings.suppliers": "供应商",
      "sat.settings.identity": "认证公钥",
      "sat.settings.connection": "连接状态",
      "sat.settings.actions": "操作",
      "sat.settings.edit": "编辑",
      "sat.settings.editing": "正在编辑供应商",
      "sat.settings.enable": "启用",
      "sat.settings.disable": "停用",
      "sat.settings.enabled": "已启用",
      "sat.settings.disabled": "已停用",
      "sat.settings.enabledField": "启用供应商",
      "sat.settings.desired": "期望订阅",
      "sat.settings.observed": "远端观察",
      "sat.settings.none": "无",
      "sat.settings.subscriptions.refresh": "刷新远端订阅",
      "sat.settings.subscriptions.refreshed": "已刷新远端订阅",
      "sat.settings.default": "设为新消息默认发布",
      "sat.settings.receive.on": "启用接收（可能收费）",
      "sat.settings.receive.off": "关闭接收",
      "sat.settings.delete": "删除",
      "sat.settings.deleteConfirm": "确认删除该供应商？删除不会自动回收供应商余额。",
      "sat.settings.deleted": "供应商已删除；余额不会自动回收。",
      "sat.settings.empty": "尚未配置供应商。",
      "sat.settings.add": "新增或更新供应商",
      "sat.settings.id": "供应商编号",
      "sat.settings.name": "显示名称",
      "sat.settings.key": "供应商公钥",
      "sat.settings.addresses": "libp2p 地址",
      "sat.settings.save": "保存供应商",
      "sat.settings.saved": "供应商配置已保存。",
      "sat.settings.audit": "最近 SSP 扣费",
      "sat.settings.unknown": "未知",
      "sat.settings.spi.refresh": "刷新 SPI 余额",
      "sat.settings.spi.topupAmount": "充值 satoshis",
      "sat.settings.spi.collectAmount": "回收 satoshis",
      "sat.settings.spi.prepare": "生成充值预览",
      "sat.settings.spi.confirm": "确认并广播",
      "sat.settings.spi.cancel": "取消",
      "sat.settings.spi.collect": "回收余额",
      "sat.settings.spi.preview": "充值预览"
    }
  }
};

export const satSubscriptionPlugin: PluginManifest = {
  id: SAT_SUBSCRIPTION_PLUGIN_ID,
  name: "SatSubscription",
  description: "SSP multi-supplier subscriptions and SPI management.",
  i18n: resources,
  meta: {
    kind: "platform",
    startup: "optional",
    bootstrapStage: "owner-apps-ready",
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: [
      SAT_SUBSCRIPTION_SERVICE_CAPABILITY,
      SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY,
      CHANNEL_RUNTIME_CAPABILITY,
      SAT_COORDINATOR_CONTROL_CAPABILITY
    ],
    displayGroup: "platform"
  },
  storage: { scope: "key", applicationStorageId: "SatSubscription", schemaVersion: 1 },
  dependencies: [
    { capability: WINDOW_P2P_EXECUTOR_CAPABILITY, reason: "Sat 只能复用 Window P2P owner 的唯一 Host" },
    { capability: RESOURCE_REGISTRY_CAPABILITY, reason: "设置页业务读取统一经过 Resource Store" },
    { capability: "system-settings.registry", reason: "注册 SatSubscription 系统设置" },
    { capability: "system-status.registry", reason: "注册 SatSubscription 运行诊断" }
  ],
  setup(ctx: PluginContext) {
    const coordinator = ctx.coordinator as SatCoordinatorControl | undefined;
    if (!coordinator) throw new Error("Sat Coordinator control is unavailable");
    ctx.provide(SAT_COORDINATOR_CONTROL_CAPABILITY, coordinator);
    const laneRegistry = ctx.get<WindowP2pExecutorLaneRegistry>(WINDOW_P2P_EXECUTOR_CAPABILITY);
    // Window 只注册网络 lane；K-V、状态、Channel crypto 和 provider handle
    // 全部由 Coordinator SharedWorker 创建，避免多 Tab 重复连接/扣费。
    const offLane = laneRegistry.register(new SatWindowP2pLane());
    const admin = createSatWorkerAdminService(coordinator);
    ctx.provide<SatSubscriptionAdminService>(SAT_SUBSCRIPTION_SERVICE_CAPABILITY, admin);
    const channelRuntimeFactory: ChannelRuntimeFactory = {
      forPlugin: (pluginId) => createSatWorkerChannelRuntime(coordinator, { kind: "plugin", pluginId }),
      forSystem: (systemId) => createSatWorkerChannelRuntime(coordinator, { kind: "system", systemId })
    };
    ctx.provide<ChannelRuntimeFactory>(CHANNEL_RUNTIME_CAPABILITY, channelRuntimeFactory);

    const resources = ctx.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY);
    const emptySettingsSnapshot = (): SatSubscriptionSettingsSnapshot => ({
      ownerPublicKeyHex: null,
      supplierGeneration: 1,
      suppliers: [],
      ownerSettings: null,
      supplierViews: [],
      feeAudit: []
    });
    resources.register<SatSubscriptionSettingsSnapshot, readonly string[]>({
      id: "sat-subscription.settings",
      scope: "active-key",
      key: (_args, context) => [
        "sat-subscription.settings",
        context.activePublicKeyHex ?? "none"
      ],
      load: async (_args, context) => {
        if (!context.activePublicKeyHex) return emptySettingsSnapshot();
        const service = context.getCapability<SatSubscriptionAdminService>(
          SAT_SUBSCRIPTION_SERVICE_CAPABILITY
        );
        if (!service) throw new Error("SatSubscription admin service is unavailable");
        return service.getSettingsSnapshot();
      },
      subscribe: (_args, _context, invalidate) => coordinator.subscribeTopic("sat.events", invalidate),
      equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      invalidation: "immediate"
    });

    const spi = createSatWorkerSpiService(coordinator);
    ctx.provide<SatSubscriptionSpiService>(SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY, spi);

    const settings = ctx.get<SystemSettingsRegistry>("system-settings.registry");
    const status = ctx.get<SystemStatusRegistry>("system-status.registry");
    const settingId = "sat-subscription.system-settings";
    const statusId = "sat-subscription.system-status";
    settings.register({
      id: settingId,
      group: { id: "sat-subscription", label: { key: "sat.settings.title", fallback: "SatSubscription" }, order: 55 },
      label: { key: "sat.settings.title", fallback: "SatSubscription" },
      description: { key: "sat.settings.description", fallback: "SSP / Channel / SPI" },
      component: SatSubscriptionSettings,
      order: 10,
      visibleWhen: ({ unlocked }) => unlocked
    });
    status.register({
      id: statusId,
      path: SAT_SUBSCRIPTION_ROUTE_PATH,
      label: { key: "sat.settings.title", fallback: "SatSubscription" },
      description: { key: "sat.settings.description", fallback: "SSP / Channel / SPI" },
      component: SatSubscriptionSettings,
      order: 25
    });

    ctx.onDispose(async () => {
      offLane();
      settings.unregister(settingId);
      status.unregister(statusId);
    });
  }
};
