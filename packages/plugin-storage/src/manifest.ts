import type { I18nPluginResources, PluginManifest, ResourceRegistry, StorageService, SystemSettingsRegistry, SessionCoordinatorClient } from "@keymaster/contracts";
import { RESOURCE_REGISTRY_CAPABILITY, STORAGE_SERVICE_CAPABILITY, SESSION_COORDINATOR_CLIENT_CAPABILITY } from "@keymaster/contracts";
import { StorageSettings } from "./StorageSettings.js";
import { StorageServiceProxy } from "./storageServiceProxy.js";
import type { StorageResourceSnapshot } from "./storageService.js";

export const STORAGE_PLUGIN_ID = "storage";

const resources: I18nPluginResources = {
  namespace: "common",
  resources: {
    en: {
      "storage.settings.group": "S3 Storage", "storage.settings.provider": "Provider", "storage.settings.accountId": "Account ID", "storage.settings.endpointVariant": "Endpoint variant", "storage.settings.endpoint": "HTTPS endpoint", "storage.settings.forcePathStyle": "Force path style", "storage.settings.bucket": "Bucket", "storage.settings.region": "Region", "storage.settings.prefix": "Root prefix", "storage.settings.credentialsConfigured": "Credentials are configured. They are never displayed.", "storage.settings.credentialsRequired": "Enter credentials to configure storage.", "storage.settings.replaceCredentials": "Replace credentials", "storage.settings.accessKeyId": "Access key ID", "storage.settings.secretAccessKey": "Secret access key", "storage.settings.status": "Status", "storage.settings.test": "Test connection", "storage.settings.cancel": "Cancel probe", "storage.settings.save": "Save and activate", "storage.settings.clear": "Clear", "storage.settings.clearConfirm": "Clear S3 Storage configuration? Storage APIs will stop immediately.", "storage.settings.saved": "Storage is ready.", "storage.settings.probeOk": "Provider probe succeeded.", "storage.settings.cleared": "Storage configuration cleared.", "storage.settings.failed": "Storage operation failed.", "storage.settings.locked": "Unlock the Vault to edit S3 Storage.", "storage.settings.cors": "Provider CORS must allow this app origin, GET/PUT/DELETE/POST/HEAD, Content-Type, If-Match, If-None-Match, Range and x-amz-* headers, and expose ETag, Last-Modified, Content-Range, Content-Length and x-amz-request-id.", "storage.settings.probeScope": "Connection test performs only a bounded List request; it does not prove PUT, multipart, or CORS header exposure.", "storage.settings.copyCors": "Copy CORS template", "storage.settings.corsCopied": "CORS template copied", "storage.settings.capability": "Detect write capability", "storage.settings.capabilityWarning": "This sends PUT, HEAD, DELETE and multipart requests. It may incur provider fees and retain object versions depending on lifecycle settings.", "storage.settings.capabilityUnknown": "Unknown", "storage.settings.capabilityNative": "Native atomic condition", "storage.settings.capabilityBestEffort": "Best-effort HEAD then write (not atomic)", "storage.settings.capabilityAutomatic": "Automatic", "storage.settings.capabilityManual": "Manual", "storage.settings.capabilityPut": "Conditional PUT", "storage.settings.capabilityComplete": "Multipart Complete", "storage.settings.capabilityInconclusive": "Inconclusive; previous state retained", "storage.settings.capabilityBusy": "Capability detection in progress", "storage.settings.capabilityDone": "Write capability detection completed.", "storage.settings.capabilityCleanupWarning": "Detection completed, but cleanup reported a warning."
    },
    "zh-CN": {
      "storage.settings.group": "S3 存储", "storage.settings.provider": "Provider", "storage.settings.accountId": "Account ID", "storage.settings.endpointVariant": "Endpoint 变体", "storage.settings.endpoint": "HTTPS Endpoint", "storage.settings.forcePathStyle": "强制 Path Style", "storage.settings.bucket": "Bucket", "storage.settings.region": "Region", "storage.settings.prefix": "根 Prefix", "storage.settings.credentialsConfigured": "凭据已配置，不会回显。", "storage.settings.credentialsRequired": "请输入凭据以配置存储。", "storage.settings.replaceCredentials": "替换凭据", "storage.settings.accessKeyId": "Access Key ID", "storage.settings.secretAccessKey": "Secret Access Key", "storage.settings.status": "状态", "storage.settings.test": "测试连接", "storage.settings.cancel": "取消 Probe", "storage.settings.save": "保存并激活", "storage.settings.clear": "清除", "storage.settings.clearConfirm": "清除 S3 存储配置？Storage API 将立即停止。", "storage.settings.saved": "Storage 已就绪。", "storage.settings.probeOk": "Provider Probe 成功。", "storage.settings.cleared": "Storage 配置已清除。", "storage.settings.failed": "Storage 操作失败。", "storage.settings.locked": "请先解锁 Vault 才能编辑 S3 存储。", "storage.settings.cors": "Provider CORS 必须允许当前 App Origin、GET/PUT/DELETE/POST/HEAD，以及 Content-Type、If-Match、If-None-Match、Range、x-amz-* 请求头，并暴露 ETag、Last-Modified、Content-Range、Content-Length、x-amz-request-id。", "storage.settings.probeScope": "连接测试只执行有界 List 请求，不能证明 PUT、multipart 或 CORS 响应头暴露配置正确。", "storage.settings.copyCors": "复制 CORS 模板", "storage.settings.corsCopied": "CORS 模板已复制", "storage.settings.capability": "检测写入能力", "storage.settings.capabilityWarning": "此操作会发送 PUT、HEAD、DELETE 和 multipart 请求，可能产生 Provider 费用；根据生命周期设置，历史版本可能保留。", "storage.settings.capabilityUnknown": "未知", "storage.settings.capabilityNative": "原生原子条件写入", "storage.settings.capabilityBestEffort": "Best-effort HEAD 后写入（非原子）", "storage.settings.capabilityAutomatic": "自动", "storage.settings.capabilityManual": "手动", "storage.settings.capabilityPut": "条件 PUT", "storage.settings.capabilityComplete": "Multipart Complete", "storage.settings.capabilityInconclusive": "无法确定；保留之前状态", "storage.settings.capabilityBusy": "写入能力检测进行中", "storage.settings.capabilityDone": "写入能力检测完成。", "storage.settings.capabilityCleanupWarning": "检测完成，但清理时出现警告。"
    }
  }
};

(resources.resources.en as Record<string, string>)["storage.settings.capabilityScope"] = "This checks only the currently saved and active configuration; unsaved edits are not used.";
(resources.resources["zh-CN"] as Record<string, string>)["storage.settings.capabilityScope"] = "此检测只使用当前已保存并激活的配置；未保存的编辑不会用于检测。";

export const storagePlugin: PluginManifest = {
  id: STORAGE_PLUGIN_ID,
  name: "Storage",
  description: "隔离的 Connect S3-compatible object storage capability.",
  meta: { kind: "platform", startup: "optional", defaultEnabled: true, canDisable: true, providesCapabilities: [STORAGE_SERVICE_CAPABILITY], displayGroup: "platform" },
  dependencies: [
    { capability: SESSION_COORDINATOR_CLIENT_CAPABILITY, reason: "Storage runtime is owned by the Coordinator SharedWorker" },
    { capability: "system-settings.registry", reason: "Storage settings live under Settings -> System" }
  ],
  i18n: resources,
  async setup(ctx) {
    const coordinator = ctx.get<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY);
    const service = new StorageServiceProxy(coordinator);
    ctx.provide<StorageService>(STORAGE_SERVICE_CAPABILITY, service);
    const resources = ctx.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY);
    const resourceId = "storage.status";
    resources.register<StorageResourceSnapshot, readonly string[]>({
      id: resourceId,
      scope: "global",
      key: () => [resourceId],
    load: async () => ({ status: service.status(), summary: await service.getProviderSummary(), capabilities: service.getConditionalCapabilities() }),
      subscribe: (_args, _context, invalidate) => service.subscribe(invalidate),
      invalidation: "immediate"
    });
    const settings = ctx.get<SystemSettingsRegistry>("system-settings.registry");
    const settingsId = "storage.system-settings.provider";
    settings.register({ id: settingsId, group: { id: "storage", label: { key: "storage.settings.group", fallback: "S3 Storage" }, order: 60 }, label: { key: "storage.settings.provider", fallback: "Provider" }, component: StorageSettings, order: 10, visibleWhen: ({ unlocked }) => unlocked });
    return () => { try { settings.unregister(settingsId); } catch { /* already reclaimed */ } resources.unregister(resourceId); service.dispose(); };
  }
};
