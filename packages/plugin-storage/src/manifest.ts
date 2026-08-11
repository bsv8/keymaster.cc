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
      "storage.settings.group": "S3 Storage", "storage.settings.provider": "Provider", "storage.settings.accountId": "Account ID", "storage.settings.endpointVariant": "Endpoint variant", "storage.settings.endpoint": "HTTPS endpoint", "storage.settings.forcePathStyle": "Force path style", "storage.settings.bucket": "Bucket", "storage.settings.region": "Region", "storage.settings.credentialsConfigured": "Credentials are configured. They are never displayed.", "storage.settings.credentialsRequired": "Enter credentials to configure storage.", "storage.settings.replaceCredentials": "Replace credentials", "storage.settings.accessKeyId": "Access key ID", "storage.settings.secretAccessKey": "Secret access key", "storage.settings.status": "Status", "storage.settings.test": "Test connection", "storage.settings.cancel": "Cancel probe", "storage.settings.clear": "Clear", "storage.settings.clearConfirm": "Clear S3 Storage configuration? Storage APIs will stop immediately.", "storage.settings.probeOk": "Provider probe succeeded.", "storage.settings.cleared": "Storage configuration cleared.", "storage.settings.failed": "Storage operation failed.", "storage.settings.locked": "Unlock the Vault to edit S3 Storage.", "storage.settings.cors": "Provider CORS must allow this app origin, GET/PUT/DELETE/POST/HEAD, Content-Type, If-Match, If-None-Match, Range and x-amz-* headers, and expose ETag, Last-Modified, Content-Range, Content-Length and x-amz-request-id.", "storage.settings.probeScope": "Connection test performs only a bounded List request; it does not prove PUT, multipart, or CORS header exposure.", "storage.settings.copyCors": "Copy CORS template", "storage.settings.corsCopied": "CORS template copied", "storage.settings.capability": "Detect write capability", "storage.settings.capabilityWarning": "This sends PUT, HEAD, DELETE and multipart requests. It may incur provider fees and retain object versions depending on lifecycle settings.", "storage.settings.capabilityUnknown": "Unknown", "storage.settings.capabilityNative": "Native atomic condition", "storage.settings.capabilityBestEffort": "Best-effort HEAD then write (not atomic)", "storage.settings.capabilityAutomatic": "Automatic", "storage.settings.capabilityManual": "Manual", "storage.settings.capabilityPut": "Conditional PUT", "storage.settings.capabilityComplete": "Multipart Complete", "storage.settings.capabilityInconclusive": "Inconclusive; previous state retained", "storage.settings.capabilityBusy": "Capability detection in progress", "storage.settings.capabilityDone": "Write capability detection completed.", "storage.settings.capabilityCleanupWarning": "Detection completed, but cleanup reported a warning."
    },
    "zh-CN": {
      "storage.settings.group": "S3 存储", "storage.settings.provider": "Provider", "storage.settings.accountId": "Account ID", "storage.settings.endpointVariant": "Endpoint 变体", "storage.settings.endpoint": "HTTPS Endpoint", "storage.settings.forcePathStyle": "强制 Path Style", "storage.settings.bucket": "Bucket", "storage.settings.region": "Region", "storage.settings.credentialsConfigured": "凭据已配置，不会回显。", "storage.settings.credentialsRequired": "请输入凭据以配置存储。", "storage.settings.replaceCredentials": "替换凭据", "storage.settings.accessKeyId": "Access Key ID", "storage.settings.secretAccessKey": "Secret Access Key", "storage.settings.status": "状态", "storage.settings.test": "测试连接", "storage.settings.cancel": "取消 Probe", "storage.settings.clear": "清除", "storage.settings.clearConfirm": "清除 S3 存储配置？Storage API 将立即停止。", "storage.settings.probeOk": "Provider Probe 成功。", "storage.settings.cleared": "Storage 配置已清除。", "storage.settings.failed": "Storage 操作失败。", "storage.settings.locked": "请先解锁 Vault 才能编辑 S3 存储。", "storage.settings.cors": "Provider CORS 必须允许当前 App Origin、GET/PUT/DELETE/POST/HEAD，以及 Content-Type、If-Match、If-None-Match、Range、x-amz-* 请求头，并暴露 ETag、Last-Modified、Content-Range、Content-Length、x-amz-request-id。", "storage.settings.probeScope": "连接测试只执行有界 List 请求，不能证明 PUT、multipart 或 CORS 响应头暴露配置正确。", "storage.settings.copyCors": "复制 CORS 模板", "storage.settings.corsCopied": "CORS 模板已复制", "storage.settings.capability": "检测写入能力", "storage.settings.capabilityWarning": "此操作会发送 PUT、HEAD、DELETE 和 multipart 请求，可能产生 Provider 费用；根据生命周期设置，历史版本可能保留。", "storage.settings.capabilityUnknown": "未知", "storage.settings.capabilityNative": "原生原子条件写入", "storage.settings.capabilityBestEffort": "Best-effort HEAD 后写入（非原子）", "storage.settings.capabilityAutomatic": "自动", "storage.settings.capabilityManual": "手动", "storage.settings.capabilityPut": "条件 PUT", "storage.settings.capabilityComplete": "Multipart Complete", "storage.settings.capabilityInconclusive": "无法确定；保留之前状态", "storage.settings.capabilityBusy": "写入能力检测进行中", "storage.settings.capabilityDone": "写入能力检测完成。", "storage.settings.capabilityCleanupWarning": "检测完成，但清理时出现警告。"
    }
  }
};

(resources.resources.en as Record<string, string>)["storage.settings.capabilityScope"] = "This checks the active configuration after automatic saving has completed.";
(resources.resources["zh-CN"] as Record<string, string>)["storage.settings.capabilityScope"] = "此检测会在自动保存和激活完成后，使用当前生效的配置。";

Object.assign(resources.resources.en as Record<string, string>, {
  "storage.settings.backend": "Storage backend",
  "storage.settings.notActivated": "Not activated",
  "storage.settings.providerTitle": "Provider",
  "storage.settings.providerDescription": "Choose the object storage service for this Bucket.",
  "storage.settings.parametersTitle": "Parameters",
  "storage.settings.parametersDescription": "Connect directly to the Bucket root. App data is isolated automatically.",
  "storage.settings.connectionTitle": "Connection",
  "storage.settings.connectionDescription": "Choose a provider and enter its bucket location.",
  "storage.settings.credentialsTitle": "Credentials",
  "storage.settings.credentialsSealed": "Stored in the encrypted Vault and never displayed.",
  "storage.settings.browserAccessTitle": "Browser access",
  "storage.settings.r2Cors": "R2 must allow this exact app origin before browser requests can reach the bucket.",
  "storage.settings.corsOriginExact": "The scheme, hostname and port must match exactly.",
  "storage.settings.showCors": "Show CORS policy",
  "storage.settings.r2CorsDocs": "Cloudflare R2 CORS guide",
  "storage.settings.endpointPreview": "S3 endpoint",
  "storage.settings.verificationTitle": "Verification",
  "storage.settings.capabilityRequiresReady": "Complete the required parameters and wait for automatic activation before detecting write capability.",
  "storage.settings.networkOrCors": "The browser request was blocked by network or CORS. Apply this page's CORS template to the Bucket and make sure AllowedOrigins contains {{origin}} exactly, then retry.",
  "storage.settings.authenticationFailed": "Storage authentication failed. Check that you entered an R2 S3 access key ID and secret access key, not an account API token.",
  "storage.settings.forbidden": "The storage provider denied this operation. Check the key's bucket permissions.",
  "storage.settings.autoSaveIdle": "Changes save automatically",
  "storage.settings.autoSaveWaiting": "Waiting to save…",
  "storage.settings.autoSaveIncomplete": "Complete the required parameters to save automatically.",
  "storage.settings.autoSaveSaving": "Saving and activating…",
  "storage.settings.autoSaveSaved": "Saved and active",
  "storage.settings.autoSaveError": "Not saved — fix the error and retry",
  "storage.settings.statusReady": "Ready",
  "storage.settings.statusUnconfigured": "Not configured",
  "storage.settings.statusDegraded": "Needs attention",
  "storage.settings.statusReconfiguring": "Reconfiguring"
});

Object.assign(resources.resources["zh-CN"] as Record<string, string>, {
  "storage.settings.backend": "存储后端",
  "storage.settings.notActivated": "尚未激活",
  "storage.settings.providerTitle": "Provider",
  "storage.settings.providerDescription": "选择这个 Bucket 使用的对象存储服务。",
  "storage.settings.parametersTitle": "各项参数",
  "storage.settings.parametersDescription": "直接连接 Bucket 根目录，系统会自动隔离每个 App 的数据。",
  "storage.settings.connectionTitle": "连接配置",
  "storage.settings.connectionDescription": "选择存储服务并填写 Bucket 位置。",
  "storage.settings.credentialsTitle": "访问凭据",
  "storage.settings.credentialsSealed": "已加密保存在 Vault 中，不会回显。",
  "storage.settings.browserAccessTitle": "浏览器访问",
  "storage.settings.r2Cors": "浏览器访问 R2 前，Bucket 必须允许当前应用的精确 Origin。",
  "storage.settings.corsOriginExact": "协议、主机名和端口必须完全一致。",
  "storage.settings.showCors": "查看 CORS 配置",
  "storage.settings.r2CorsDocs": "Cloudflare R2 CORS 文档",
  "storage.settings.endpointPreview": "S3 Endpoint",
  "storage.settings.verificationTitle": "连接验证",
  "storage.settings.capabilityRequiresReady": "请填写完整的必填参数，并等待自动激活完成后再检测写入能力。",
  "storage.settings.networkOrCors": "浏览器请求被网络或 CORS 拦截。请将本页 CORS 模板配置到 Bucket，并确认 AllowedOrigins 精确包含 {{origin}} 后重试。",
  "storage.settings.authenticationFailed": "存储身份验证失败。请确认填写的是 R2 的 S3 Access Key ID 和 Secret Access Key，而不是账户 API Token。",
  "storage.settings.forbidden": "存储服务拒绝了此操作，请检查该密钥的 Bucket 权限。",
  "storage.settings.autoSaveIdle": "修改会自动保存",
  "storage.settings.autoSaveWaiting": "等待自动保存…",
  "storage.settings.autoSaveIncomplete": "填写完整的必填参数后将自动保存。",
  "storage.settings.autoSaveSaving": "正在保存并激活…",
  "storage.settings.autoSaveSaved": "已保存并激活",
  "storage.settings.autoSaveError": "尚未保存，请修正错误后重试",
  "storage.settings.statusReady": "已就绪",
  "storage.settings.statusUnconfigured": "未配置",
  "storage.settings.statusDegraded": "需要处理",
  "storage.settings.statusReconfiguring": "正在重新配置"
});

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
