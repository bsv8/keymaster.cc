// packages/plugin-msfile/src/manifest.ts
// MSFile 插件清单：提供 `msfile.service`（页面侧 proxy）与 /settings/system
// 的 MSFile group。设置真值、DB 与网络都在 Coordinator SharedWorker。

import type { I18nPluginResources, PluginManifest, PluginContext, ResourceRegistry } from "@keymaster/contracts";
import {
  MSFILE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  SESSION_COORDINATOR_CLIENT_CAPABILITY,
  type SessionCoordinatorClient,
  type SystemSettingsRegistry,
} from "@keymaster/contracts";
import { MsFileServiceProxy } from "./msfileServiceProxy.js";
import { MsFileSettings } from "./MsFileSettings.js";

export const MSFILE_PLUGIN_ID = "msfile";

const resources: I18nPluginResources = {
  namespace: "common",
  resources: {
    en: {
      "msfile.settings.group": "MSFile",
      "msfile.settings.priceLimits": "Price limits",
      "msfile.settings.priceLimits.hint":
        "Maximum satoshis per single content object — per Seed or per Block, not per file.",
      "msfile.settings.seedCap": "Seed max price (satoshis)",
      "msfile.settings.blockCap": "Block max price (satoshis)",
      "msfile.settings.unlimited": "Unlimited",
      "msfile.settings.save": "Save price limits",
      "msfile.settings.saved": "Saved. New reads use the new limits immediately.",
      "msfile.settings.suppliers": "Suppliers",
      "msfile.settings.supplier.name": "Display name",
      "msfile.settings.supplier.publicKey": "Supplier public key (66 hex chars)",
      "msfile.settings.supplier.addresses": "Dialable addresses (one per line, in try order)",
      "msfile.settings.supplier.enabled": "Enabled",
      "msfile.settings.supplier.peerId": "PeerId derived from public key",
      "msfile.settings.supplier.add": "Add supplier",
      "msfile.settings.supplier.edit": "Edit",
      "msfile.settings.supplier.delete": "Delete",
      "msfile.settings.supplier.deleteConfirm": "Delete this supplier? Its pending requests will fail.",
      "msfile.settings.supplier.test": "Test connection",
      "msfile.settings.supplier.testing": "Testing…",
      "msfile.settings.supplier.testOk": "Connected and protocol negotiated",
      "msfile.settings.supplier.testFailed": "Connection failed",
      "msfile.settings.apps": "Connect App authorizations",
      "msfile.settings.apps.empty": "No Connect App has used MSFile yet.",
      "msfile.settings.apps.inherited": "Inherited from global limit",
      "msfile.settings.apps.override": "Separate override",
      "msfile.settings.apps.editOverride": "Edit overrides",
      "msfile.settings.apps.clearAll": "Restore inheritance",
      "msfile.approvals.title": "Price increase requested",
      "msfile.approvals.description": "The app hit its current spending cap for this content object.",
      "msfile.approvals.newLimit": "New maximum price (satoshis)",
      "msfile.approvals.allowOnce": "Allow once",
      "msfile.approvals.allowAlways": "Always allow up to this amount",
      "msfile.errors.msfile_not_configured": "MSFile price limits are not configured yet.",
      "msfile.errors.msfile_unavailable": "MSFile is unavailable right now.",
      "msfile.errors.default": "MSFile request failed."
    },
    "zh-CN": {
      "msfile.settings.group": "MSFile",
      "msfile.settings.priceLimits": "价格限制",
      "msfile.settings.priceLimits.hint": "单个内容对象的最高金额——按每个 Seed 或每个 Block 计，不是整个文件。",
      "msfile.settings.seedCap": "Seed 单个最高金额（聪）",
      "msfile.settings.blockCap": "Block 单个最高金额（聪）",
      "msfile.settings.unlimited": "不限金额",
      "msfile.settings.save": "保存价格限制",
      "msfile.settings.saved": "已保存。之后的 Read 立即使用新限额。",
      "msfile.settings.suppliers": "供应商配置",
      "msfile.settings.supplier.name": "显示名称",
      "msfile.settings.supplier.publicKey": "供应商公钥（66 位 hex）",
      "msfile.settings.supplier.addresses": "可拨号地址（每行一个，按尝试顺序）",
      "msfile.settings.supplier.enabled": "启用",
      "msfile.settings.supplier.peerId": "由公钥派生的 PeerId",
      "msfile.settings.supplier.add": "新增供应商",
      "msfile.settings.supplier.edit": "编辑",
      "msfile.settings.supplier.delete": "删除",
      "msfile.settings.supplier.deleteConfirm": "确认删除该供应商？其未完成请求将失败。",
      "msfile.settings.supplier.test": "测试连接",
      "msfile.settings.supplier.testing": "测试中…",
      "msfile.settings.supplier.testOk": "连接成功且协议协商通过",
      "msfile.settings.supplier.testFailed": "连接失败",
      "msfile.settings.apps": "Connect App 授权",
      "msfile.settings.apps.empty": "还没有 Connect App 使用过 MSFile。",
      "msfile.settings.apps.inherited": "继承全局额度",
      "msfile.settings.apps.override": "单独设置",
      "msfile.settings.apps.editOverride": "编辑覆盖额度",
      "msfile.settings.apps.clearAll": "恢复继承全局",
      "msfile.approvals.title": "请求提高金额上限",
      "msfile.approvals.description": "该 App 达到了此内容对象的当前金额上限。",
      "msfile.approvals.newLimit": "新的最高金额（聪）",
      "msfile.approvals.allowOnce": "仅本次允许",
      "msfile.approvals.allowAlways": "始终允许该 App 到此金额",
      "msfile.errors.msfile_not_configured": "MSFile 价格限制尚未配置。",
      "msfile.errors.msfile_unavailable": "MSFile 当前不可用。",
      "msfile.errors.default": "MSFile 请求失败。"
    }
  }
};

export const msfileResources = resources;

export const msfilePlugin: PluginManifest = {
  id: MSFILE_PLUGIN_ID,
  name: "MSFile",
  description: "MSFile Proxy V1 客户端能力：多供应商 Stat/Read、价格授权与供应商配置。",
  meta: {
    kind: "platform",
    startup: "optional",
    // 001/002 完成前数据面 fail closed；003 发布验收完成前不默认启用；
    // 真实 transport 注入并留下互操作证据后再翻回 true。
    defaultEnabled: false,
    canDisable: true,
    providesCapabilities: [MSFILE_SERVICE_CAPABILITY],
    displayGroup: "platform"
  },
  dependencies: [
    { capability: SESSION_COORDINATOR_CLIENT_CAPABILITY, reason: "MSFile 设置真值与数据面都归 Coordinator SharedWorker" },
    { capability: "system-settings.registry", reason: "MSFile settings live under Settings -> System" }
  ],
  i18n: resources,
  setup(ctx: PluginContext) {
    const coordinator = ctx.get<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY);
    const service = new MsFileServiceProxy(coordinator);
    // Window executor 与插件生命周期绑定：禁用插件时立即释放 host/lease。
    // 采用动态 import，避免把 WebRTC/WSS 依赖带入 SharedWorker 或设置模块图。
    let executorCleanup: (() => void) | undefined;
    let setupActive = true;
    const spikeMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("msfileSpike");
    if (!spikeMode) {
      void import("./windowExecutor.js")
        .then(({ installMsFileWindowExecutor }) => {
          if (setupActive) executorCleanup = installMsFileWindowExecutor(coordinator);
        })
        .catch(() => undefined);
    }
    ctx.provide<import("@keymaster/contracts").MsFileService>(MSFILE_SERVICE_CAPABILITY, service);

    const resources_ = ctx.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY);
    const resourceId = "msfile.status";
    resources_.register<
      {
        status: import("@keymaster/contracts").MsFileServiceStatus;
        globalSettings: import("@keymaster/contracts").MsFileGlobalPriceSettings | null;
        approvals: import("@keymaster/contracts").MsFilePendingApprovalView[];
      },
      readonly string[]
    >({
      id: resourceId,
      scope: "global",
      key: () => [resourceId],
      load: async () => {
        let globalSettings: import("@keymaster/contracts").MsFileGlobalPriceSettings | null = null;
        try {
          globalSettings = (await service.getSettingsSnapshot()).globalSettings;
        } catch {
          // Coordinator 未就绪时按 null 展示（fail closed）。
        }
        return { status: service.status(), globalSettings, approvals: service.listPendingApprovals() };
      },
      subscribe: (_args, _context, invalidate) => service.subscribe(invalidate),
      invalidation: "immediate"
    });

    const settings = ctx.get<SystemSettingsRegistry>("system-settings.registry");
    const settingsId = "msfile.system-settings";
    settings.register({
      id: settingsId,
      group: { id: "msfile", label: { key: "msfile.settings.group", fallback: "MSFile" }, order: 65 },
      label: { key: "msfile.settings.group", fallback: "MSFile" },
      component: MsFileSettings,
      order: 10,
      visibleWhen: ({ unlocked }) => unlocked
    });

    return () => {
      setupActive = false;
      executorCleanup?.();
      executorCleanup = undefined;
      try {
        settings.unregister(settingsId);
      } catch {
        // host 可能已经回收
      }
      resources_.unregister(resourceId);
      service.dispose();
    };
  }
};
