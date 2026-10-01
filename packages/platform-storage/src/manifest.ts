// Storage 平台插件 manifest（单钱包本地存储）。
//
// 相对旧实现，这里没有任何存储配置面：没有桶目录、没有 Provider 选择、
// 没有 endpoint/region/凭据表单、没有条件写能力探测、没有 multipart 上传。
// setup 只做两件事：
//   1. 把 Worker 的存储控制 RPC 包成页面侧受限控制器并注册为 capability；
//   2. 注册只读的 storage.status 资源，供设置页与 Vault 展示本地状态。
//
// 钱包生命周期（创建/导入/解锁/锁定/改密/改名/导出 KeyHold/重置）的权威实现
// 在 Worker 侧的 WalletLifecycleService 里，页面只通过控制 RPC 驱动它。
import type {
  I18nPluginResources,
  PluginManifest,
  PluginSetup,
  StorageCoordinatorControl,
} from "@keymaster/contracts";
import {
  RESOURCE_REGISTRY_CAPABILITY,
  STORAGE_RUNTIME_CONTROLLER_CAPABILITY,
  capabilityDescriptor,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import { StorageRpcProxy } from "./coordinator/storageRpcProxy.js";

export const STORAGE_PLATFORM_PLUGIN_ID = "storage";

const resources: I18nPluginResources = {
  namespace: "common",
  resources: {
    en: {
      "storage.status.title": "Local storage",
      "storage.status.medium": "Wallet data is kept in this browser only. It is not a backup and is not synced between devices.",
      "storage.status.uninitialized": "No wallet Key yet",
      "storage.status.locked": "Locked. Enter the Key password to unlock.",
      "storage.status.ready": "Ready",
      "storage.status.corrupt": "Local wallet data is incomplete and cannot be read.",
      "storage.status.unsupported": "Local data was written by a newer version and cannot be read here.",
      "storage.status.degraded": "Local storage is temporarily unavailable.",
      "storage.status.persisted": "The browser granted persistent storage. This still is not a backup.",
      "storage.status.notPersisted": "The browser may clear this data. Export the encrypted KeyHold if you need to keep it.",
      "storage.status.usage": "Usage",
    },
    "zh-CN": {
      "storage.status.title": "本地存储",
      "storage.status.medium": "钱包数据只保存在当前浏览器中；这不是备份，也不会跨设备同步。",
      "storage.status.uninitialized": "还没有钱包 Key",
      "storage.status.locked": "已锁定，请输入 Key 密码解锁。",
      "storage.status.ready": "已就绪",
      "storage.status.corrupt": "本地钱包数据不完整，无法读取。",
      "storage.status.unsupported": "本地数据由更新版本写入，当前版本无法读取。",
      "storage.status.degraded": "本地存储暂时不可用。",
      "storage.status.persisted": "浏览器已授予持久存储权限；这仍然不是备份。",
      "storage.status.notPersisted": "浏览器可能清理这些数据；如需保留请导出加密 KeyHold。",
      "storage.status.usage": "已用容量",
    },
  },
};

const storagePlatformPluginDefinition = {
  id: STORAGE_PLATFORM_PLUGIN_ID,
  name: "Storage",
  description: "本 Origin 的单钱包本地存储与统一文件存储能力。",
  kind: "platform" as const,
  startup: "required" as const,
  bootstrapStage: "storage-onboarding" as const,
  defaultEnabled: true,
  canDisable: false,
  displayGroup: "platform" as const,
  units: [{
    id: "storage.window",
    runtime: "window-main" as const,
    scopeKind: "storage" as const,
    provides: [capabilityDescriptor(STORAGE_RUNTIME_CONTROLLER_CAPABILITY)],
    dependencies: defineRuntimeUnitDependencies([]),
  }, {
    id: "storage.coordinator-worker",
    runtime: "shared-worker" as const,
    scopeKind: "storage" as const,
  }],
  i18n: resources,
  async setup(ctx) {
    const coordinator = ctx.coordinator as StorageCoordinatorControl | undefined;
    if (!coordinator) throw new Error("Storage Coordinator control is unavailable");
    const service = new StorageRpcProxy(coordinator);
    ctx.provide(STORAGE_RUNTIME_CONTROLLER_CAPABILITY, service);
    const resourceRegistry = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
    const resourceId = "storage.status";
    resourceRegistry.register({
      id: resourceId,
      scope: "global",
      key: () => [resourceId],
      load: async () => {
        const summary = await service.summary();
        return { status: service.status(), summary };
      },
      subscribe: (_args, _context, invalidate) => service.subscribe(invalidate),
      invalidation: "immediate",
    });
    // scoped registry 会随 Storage 插件 scope 一起被精确回收；teardown 只负责
    // 释放页面侧的订阅与控制器状态。
    return () => {
      service.dispose();
    };
  },
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: storagePlatformSetup, ...storagePlatformPlugin } = storagePlatformPluginDefinition;

export { storagePlatformPlugin, storagePlatformSetup };
