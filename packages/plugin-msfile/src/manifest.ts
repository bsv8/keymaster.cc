// packages/plugin-msfile/src/manifest.ts
// MSFile 插件清单：提供 `msfile.service`（页面侧 proxy）与 /settings/system
// 的 MSFile group。设置真值、DB 与网络都在 Coordinator SharedWorker。

import type { I18nPluginResources, PluginManifest, PluginContext, ResourceRegistry, RouteRegistry } from "@keymaster/contracts";
import {
  type BusinessFeatureRegistry,
  type KeyspaceService,
  KEYSPACE_SERVICE_CAPABILITY,
  MSFILE_READ_CONCURRENCY_RECOMMENDED,
  MSFILE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  SESSION_COORDINATOR_CLIENT_CAPABILITY,
  type SessionCoordinatorClient,
  type SystemSettingsRegistry,
} from "@keymaster/contracts";
import { MsFileServiceProxy } from "./msfileServiceProxy.js";
import { isLegacyExecutorHarnessMode } from "./spikeMode.js";
import { MsFileHomeFileWidget } from "./MsFileHomeFileWidget.js";
import { MsFileSettings } from "./MsFileSettings.js";
import { disposeAllMsFileMediaSessions, registerMsFileMediaResource } from "./msfileMediaResource.js";

export const MSFILE_PLUGIN_ID = "msfile";

const resources: I18nPluginResources = {
  namespace: "common",
  resources: {
    en: {
      "msfile.settings.group": "MSFile",
      "msfile.settings.priceLimits": "Price limits",
      "msfile.settings.priceLimits.hint":
        "Maximum satoshis per single content object — per Seed or per Block, not per file.",
      "msfile.settings.readConcurrency": "Read concurrency and resources",
      "msfile.settings.readConcurrency.hint": "These are transport concurrency limits, not prefetch or cache counts. Higher values may improve throughput on high-bandwidth devices, but increase network, memory, Supplier pressure, and simultaneous payment requests; lower values save resources but may increase waiting.",
      "msfile.settings.readConcurrency.media": "Per-media-session Block reads",
      "msfile.settings.readConcurrency.seed": "Global Seed reads",
      "msfile.settings.readConcurrency.block": "Global Block reads",
      "msfile.settings.readConcurrency.stat": "Global Stat query concurrency",
      "msfile.settings.readConcurrency.stat.hint": "Number of Stat query tasks Keymaster processes at the same time. Each query still asks every enabled Supplier.",
      "msfile.settings.readConcurrency.save": "Save concurrency",
      "msfile.settings.readConcurrency.saved": "Concurrency saved. New media sessions use the media value; queued reads use the global values.",
      "msfile.settings.readConcurrency.reset": "Restore recommended values",
      "msfile.settings.readConcurrency.estimate": "Estimated worst-case media bytes in flight: {{bytes}} (Seed concurrency × 16 MiB + Block concurrency × 256 KiB).",
      "msfile.settings.readConcurrency.validation": "Enter safe integer values ≥ 1; media concurrency cannot exceed global Block concurrency.",
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
      "msfile.errors.default": "MSFile request failed.",
      "msfile.home.space": "MSFile files",
      "msfile.home.title": "Get a file by Seed",
      "msfile.home.description": "Enter a Seed Hash to query suppliers and safely preview or download the original file.",
      "msfile.home.seedHash.label": "Seed Hash",
      "msfile.home.seedHash.hint": "Only 64 lowercase hexadecimal characters are accepted; the input is not rewritten.",
      "msfile.home.fetch": "Find file",
      "msfile.home.querying": "Working…",
      "msfile.home.cancel": "Cancel",
      "msfile.home.settings": "Open MSFile settings",
      "msfile.home.config.loading": "Reading MSFile configuration…",
      "msfile.home.config.unavailable": "MSFile is unavailable right now. Try again later.",
      "msfile.home.config.priceMissing": "Save the global Seed and Block price limits before fetching.",
      "msfile.home.config.supplierMissing": "Enable at least one supplier before fetching.",
      "msfile.home.suppliers": "Supplier results",
      "msfile.home.status.available": "Available",
      "msfile.home.status.quoted": "Quoted",
      "msfile.home.status.absent": "No file",
      "msfile.home.status.discovering": "Discovering",
      "msfile.home.status.networkError": "Temporarily unavailable",
      "msfile.home.absentDetail": "This supplier does not have the file.",
      "msfile.home.discoveringDetail": "The supplier is discovering this Seed. Try again later.",
      "msfile.home.discoveringRetry": "Retry status: available after {{ms}} ms.",
      "msfile.home.networkDetail": "The supplier is temporarily unavailable; this is not an absent result.",
      "msfile.home.chooseSupplier": "Choose a supplier. Seed and all Blocks will use the same supplier.",
      "msfile.home.selectSupplier": "Use this supplier",
      "msfile.home.fileName": "File name",
      "msfile.home.fileSize": "File size",
      "msfile.home.mediaType": "Media type",
      "msfile.home.quote": "Quote",
      "msfile.home.selectedFile": "Selected file",
      "msfile.home.preview.tooLarge": "Files over 32 MiB are not automatically previewed. Click download.",
      "msfile.home.preview.unsupported": "This file type is not automatically previewed. Click download to open it.",
      "msfile.home.preview.unconfirmed": "The browser could not confirm a safe decode, so the file is available as a download.",
      "msfile.home.preview.text": "Text preview",
      "msfile.home.preview.htmlSafe": "Safe static preview: scripts, network access, forms, and navigation are disabled.",
      "msfile.home.preview.htmlTitle": "HTML safe static preview",
      "msfile.home.preview.pdfTitle": "PDF preview",
      "msfile.home.download": "Download",
      "msfile.home.download.tooLarge": "Files over 256 MiB need streaming download support in a later browser version; this file will not be read.",
      "msfile.home.media.play": "Play with native Range",
      "msfile.home.media.playing": "Playing",
      "msfile.home.media.pause": "Paused",
      "msfile.home.media.readingSeed": "Reading Seed",
      "msfile.home.media.parsing": "Parsing media header",
      "msfile.home.media.buffering": "Buffering",
      "msfile.home.media.ended": "Ended",
      "msfile.home.media.cancelled": "Playback cancelled",
      "msfile.home.media.stopped": "Playback stopped",
      "msfile.home.media.idle": "Ready to play",
      "msfile.home.media.failed": "Native Range playback failed; download remains available.",
      "msfile.home.media.disposed": "Player released",
      "msfile.home.media.buffered": "Buffered ahead: {{seconds}} s",
      "msfile.home.media.window": "In-flight Blocks: {{used}} / {{limit}} (media concurrency)",
      "msfile.home.media.readBlocks": "Blocks read: {{count}}",
      "msfile.home.media.notSupported": "This media combination is not supported by the browser; use download.",
      "msfile.home.media.debug.title": "Media Debug (enabled by default)",
      "msfile.home.media.debug.count": "Latest {{count}} events",
      "msfile.home.media.debug.copy": "Copy Debug log",
      "msfile.home.media.debug.copied": "Copied",
      "msfile.home.media.debug.empty": "Waiting for media actions…",
      "msfile.home.progress.blocks": "Verified Blocks: {{done}} / {{total}}",
      "msfile.home.progress.bytes": "Verified bytes: {{done}} / {{total}}",
      "msfile.home.diagnostic": "Diagnostic code",
      "msfile.home.cancelled": "File fetching was cancelled.",
      "msfile.home.retry": "Retry",
      "msfile.home.errors.invalidHash": "Seed Hash must be 64 lowercase hexadecimal characters.",
      "msfile.home.errors.notConfigured": "MSFile is not configured. Set global price limits and enable a supplier first.",
      "msfile.home.errors.unavailable": "MSFile is unavailable right now. Try again later.",
      "msfile.home.errors.supplierChanged": "The selected supplier changed. Query the Seed again.",
      "msfile.home.errors.priceLimit": "The read exceeds the global price limit. Open MSFile settings to adjust it; this page will not raise it temporarily.",
      "msfile.home.errors.integrity": "File integrity validation failed; all content was discarded.",
      "msfile.home.errors.contentNotFound": "The supplier did not find the requested content.",
      "msfile.home.errors.rateLimited": "The supplier is temporarily rate-limiting requests. Try again later.",
      "msfile.home.errors.supplier": "The supplier could not complete the request. Try again later.",
      "msfile.home.errors.protocol": "The supplier returned an invalid protocol response; the file was not used.",
      "msfile.home.errors.transport": "The supplier is temporarily unavailable. Try again later.",
      "msfile.home.errors.rejected": "The read request was not approved.",
      "msfile.home.errors.download": "The browser could not create a download file.",
      "msfile.home.errors.default": "File fetching failed. Try again."
    },
    "zh-CN": {
      "msfile.settings.group": "MSFile",
      "msfile.settings.priceLimits": "价格限制",
      "msfile.settings.priceLimits.hint": "单个内容对象的最高金额——按每个 Seed 或每个 Block 计，不是整个文件。",
      "msfile.settings.readConcurrency": "读取并发与资源",
      "msfile.settings.readConcurrency.hint": "这些字段是读取运输层并发上限，不是预取数或缓存数。调高可能提升高带宽设备的吞吐，但会增加网络、内存、Supplier 压力以及同时付款请求；调低会节约资源，但可能增加等待。",
      "msfile.settings.readConcurrency.media": "单个媒体 Session 的 Block 读取数",
      "msfile.settings.readConcurrency.seed": "全局 Seed 读取数",
      "msfile.settings.readConcurrency.block": "全局 Block 读取数",
      "msfile.settings.readConcurrency.stat": "全局 Stat 查询并发数",
      "msfile.settings.readConcurrency.stat.hint": "Keymaster 同时处理的 Stat 查询任务数量。每个查询仍会询问所有已启用的 Supplier。",
      "msfile.settings.readConcurrency.save": "保存并发设置",
      "msfile.settings.readConcurrency.saved": "并发设置已保存。新媒体 Session 使用媒体值；之后排队的读取使用全局值。",
      "msfile.settings.readConcurrency.reset": "恢复建议值",
      "msfile.settings.readConcurrency.estimate": "媒体最坏在途字节估算：{{bytes}}（Seed 并发 × 16 MiB + Block 并发 × 256 KiB）。",
      "msfile.settings.readConcurrency.validation": "请输入大于等于 1 的安全整数；媒体并发不能大于全局 Block 并发。",
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
      "msfile.errors.default": "MSFile 请求失败。",
      "msfile.home.space": "MSFile 文件",
      "msfile.home.title": "通过 Seed 获取文件",
      "msfile.home.description": "输入 Seed Hash，查询供应商并安全预览或下载原文件。",
      "msfile.home.seedHash.label": "Seed Hash",
      "msfile.home.seedHash.hint": "只接受 64 位小写十六进制字符，不会自动修改输入。",
      "msfile.home.fetch": "查询文件",
      "msfile.home.querying": "处理中…",
      "msfile.home.cancel": "取消",
      "msfile.home.settings": "打开 MSFile 设置",
      "msfile.home.config.loading": "正在读取 MSFile 配置…",
      "msfile.home.config.unavailable": "MSFile 当前不可用，请稍后重试。",
      "msfile.home.config.priceMissing": "请先保存全局 Seed 和 Block 金额上限。",
      "msfile.home.config.supplierMissing": "请先启用至少一个供应商。",
      "msfile.home.suppliers": "供应商结果",
      "msfile.home.status.available": "可获取",
      "msfile.home.status.quoted": "有报价",
      "msfile.home.status.absent": "没有文件",
      "msfile.home.status.discovering": "发现中",
      "msfile.home.status.networkError": "暂时不可用",
      "msfile.home.absentDetail": "该供应商没有此文件。",
      "msfile.home.discoveringDetail": "供应商正在发现该 Seed，可稍后重试。",
      "msfile.home.discoveringRetry": "可重试状态：约 {{ms}} ms 后重试。",
      "msfile.home.networkDetail": "供应商暂时不可用，这不是 absent 结果。",
      "msfile.home.chooseSupplier": "请选择一个供应商；Seed 与所有 Block 将固定使用同一供应商。",
      "msfile.home.selectSupplier": "选择此供应商",
      "msfile.home.fileName": "文件名",
      "msfile.home.fileSize": "文件大小",
      "msfile.home.mediaType": "媒体类型",
      "msfile.home.quote": "报价",
      "msfile.home.selectedFile": "已选择文件",
      "msfile.home.preview.tooLarge": "超过 32 MiB 的文件不会自动预览，请点击下载。",
      "msfile.home.preview.unsupported": "该文件类型不会自动预览，请点击下载后使用。",
      "msfile.home.preview.unconfirmed": "无法确认浏览器可安全解码该内容，已降级为下载。",
      "msfile.home.preview.text": "文本预览",
      "msfile.home.preview.htmlSafe": "安全静态预览：脚本、网络、表单和导航已禁用。",
      "msfile.home.preview.htmlTitle": "HTML 安全静态预览",
      "msfile.home.preview.pdfTitle": "PDF 预览",
      "msfile.home.download": "下载",
      "msfile.home.download.tooLarge": "超过 256 MiB 的文件需要后续流式下载支持，当前不会读取。",
      "msfile.home.media.play": "使用浏览器原生 Range 播放",
      "msfile.home.media.playing": "播放中",
      "msfile.home.media.pause": "已暂停",
      "msfile.home.media.readingSeed": "正在读取 Seed",
      "msfile.home.media.parsing": "正在解析媒体头",
      "msfile.home.media.buffering": "缓冲中",
      "msfile.home.media.ended": "已结束",
      "msfile.home.media.cancelled": "播放已取消",
      "msfile.home.media.stopped": "播放已停止",
      "msfile.home.media.idle": "等待播放",
      "msfile.home.media.failed": "原生 Range 播放失败，仍可单独下载。",
      "msfile.home.media.disposed": "播放器已释放",
      "msfile.home.media.buffered": "前方已缓冲：{{seconds}} 秒",
      "msfile.home.media.window": "在途 Block：{{used}} / {{limit}}（本媒体并发）",
      "msfile.home.media.readBlocks": "已读取 Block：{{count}}",
      "msfile.home.media.notSupported": "当前浏览器不支持该媒体组合，请使用下载。",
      "msfile.home.media.debug.title": "媒体 Debug（默认开启）",
      "msfile.home.media.debug.count": "最近 {{count}} 条事件",
      "msfile.home.media.debug.copy": "复制 Debug 日志",
      "msfile.home.media.debug.copied": "已复制",
      "msfile.home.media.debug.empty": "等待媒体动作…",
      "msfile.home.progress.blocks": "已验证 Block：{{done}} / {{total}}",
      "msfile.home.progress.bytes": "已验证字节：{{done}} / {{total}}",
      "msfile.home.diagnostic": "诊断代码",
      "msfile.home.cancelled": "文件获取已取消。",
      "msfile.home.retry": "重试",
      "msfile.home.errors.invalidHash": "Seed Hash 必须是 64 位小写十六进制字符。",
      "msfile.home.errors.notConfigured": "MSFile 尚未完成配置，请先设置全局金额上限并启用供应商。",
      "msfile.home.errors.unavailable": "MSFile 当前不可用，请稍后重试。",
      "msfile.home.errors.supplierChanged": "所选供应商已变化，请重新查询。",
      "msfile.home.errors.priceLimit": "读取金额超过全局上限，请前往 MSFile 设置调整；首页不会临时提高额度。",
      "msfile.home.errors.integrity": "文件完整性校验失败，已丢弃全部内容。",
      "msfile.home.errors.contentNotFound": "供应商没有找到请求的内容。",
      "msfile.home.errors.rateLimited": "供应商暂时限制了请求，请稍后重试。",
      "msfile.home.errors.supplier": "供应商暂时无法完成请求，请稍后重试。",
      "msfile.home.errors.protocol": "供应商协议响应无效，文件未被使用。",
      "msfile.home.errors.transport": "供应商暂时不可用，请稍后重试。",
      "msfile.home.errors.rejected": "读取请求未获批准。",
      "msfile.home.errors.download": "浏览器无法创建下载文件。",
      "msfile.home.errors.default": "文件获取失败，请重试。"
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
    // 默认加载只负责让设置入口和首页模块稳定出现；未配置全局金额或
    // 供应商时，组件仍在发起 Stat/Read 前 fail closed。
    defaultEnabled: true,
    canDisable: true,
    providesCapabilities: [MSFILE_SERVICE_CAPABILITY],
    displayGroup: "platform"
  },
  dependencies: [
    { capability: SESSION_COORDINATOR_CLIENT_CAPABILITY, reason: "MSFile 设置真值与数据面都归 Coordinator SharedWorker" },
    { capability: "system-settings.registry", reason: "MSFile settings live under Settings -> System" },
    { capability: "business.registry", reason: "注册 MSFile 首页文件获取投影" },
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "active key 变化时取消首页文件任务" },
    { capability: "vault.service", reason: "首页文件读取只允许在 Vault unlocked 时进行" }
  ],
  i18n: resources,
  setup(ctx: PluginContext) {
    const coordinator = ctx.get<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY);
    const service = new MsFileServiceProxy(coordinator);
    // Window executor 与插件生命周期绑定：禁用插件时立即释放 host/lease。
    // 采用动态 import，避免把 WebRTC/WSS 依赖带入 SharedWorker 或设置模块图。
    let executorCleanup: (() => void) | undefined;
    let setupActive = true;
    const spikeMode = isLegacyExecutorHarnessMode();
    if (!spikeMode) {
      void import("./windowExecutor.js")
        .then(({ installMsFileWindowExecutor }) => {
          if (setupActive) executorCleanup = installMsFileWindowExecutor(coordinator);
        })
        .catch(() => undefined);
    }
    ctx.provide<import("@keymaster/contracts").MsFileService>(MSFILE_SERVICE_CAPABILITY, service);

    const resources_ = ctx.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY);
    registerMsFileMediaResource(resources_, service);
    const resourceId = "msfile.status";
    resources_.register<
      {
        status: import("@keymaster/contracts").MsFileServiceStatus;
        globalSettings: import("@keymaster/contracts").MsFileGlobalPriceSettings | null;
        supplierGeneration: number;
        mediaBlockReadConcurrency: number;
        globalSeedReadConcurrency: number;
        globalBlockReadConcurrency: number;
        globalStatConcurrency: number;
        approvals: import("@keymaster/contracts").MsFilePendingApprovalView[];
      },
      readonly string[]
    >({
      id: resourceId,
      scope: "global",
      key: () => [resourceId],
      load: async () => {
        let globalSettings: import("@keymaster/contracts").MsFileGlobalPriceSettings | null = null;
        let supplierGeneration = 0;
        let mediaBlockReadConcurrency = MSFILE_READ_CONCURRENCY_RECOMMENDED.mediaBlockReadConcurrency;
        let globalSeedReadConcurrency = MSFILE_READ_CONCURRENCY_RECOMMENDED.globalSeedReadConcurrency;
        let globalBlockReadConcurrency = MSFILE_READ_CONCURRENCY_RECOMMENDED.globalBlockReadConcurrency;
        let globalStatConcurrency = MSFILE_READ_CONCURRENCY_RECOMMENDED.globalStatConcurrency;
        try {
          const snapshot = await service.getSettingsSnapshot();
          globalSettings = snapshot.globalSettings;
          supplierGeneration = snapshot.supplierGeneration;
          mediaBlockReadConcurrency = snapshot.mediaBlockReadConcurrency;
          globalSeedReadConcurrency = snapshot.globalSeedReadConcurrency;
          globalBlockReadConcurrency = snapshot.globalBlockReadConcurrency;
          globalStatConcurrency = snapshot.globalStatConcurrency;
        } catch {
          // Coordinator 未就绪时按 null 展示（fail closed）。
        }
        return {
          status: service.status(),
          globalSettings,
          supplierGeneration,
          mediaBlockReadConcurrency,
          globalSeedReadConcurrency,
          globalBlockReadConcurrency,
          globalStatConcurrency,
          approvals: service.listPendingApprovals(),
        };
      },
      subscribe: (_args, _context, invalidate) => service.subscribe(invalidate),
      invalidation: "immediate"
    });

    // active-key 资源只携带生命周期标识，不携带文件、Seed 或 Block 字节。
    // Resource Store 会在 active key 切换时销毁旧记录并取消其加载。
    const lifecycleResourceId = "msfile.home.lifecycle";
    resources_.register<
      { activePublicKeyHex?: string; generation?: number },
      readonly string[]
    >({
      id: lifecycleResourceId,
      scope: "active-key",
      key: (_args, context) => [lifecycleResourceId, context.activePublicKeyHex ?? "none"],
      load: async (_args, context) => {
        const keyspace = context.getCapability<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
        const active = keyspace?.active();
        return { activePublicKeyHex: active?.activePublicKeyHex, generation: active?.generation };
      },
      subscribe: (_args, context, invalidate) => {
        const keyspace = context.getCapability<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
        return keyspace?.onActiveKeyChanged(() => invalidate()) ?? (() => undefined);
      },
      invalidation: "immediate"
    });

    // business.registry 支持在 home 域尚未加载时追加入口；home 插件加载后
    // 会自动显示这个投影。entry 同时是该业务特征的正式页面入口，便于
    // 用户从侧栏或直接访问 /msfile/files；首页模块复用同一个组件和状态机。
    const routes = ctx.get<RouteRegistry>("route.registry");
    const entryRouteId = "msfile.home.file";
    routes.register({
      id: entryRouteId,
      path: "/msfile/files",
      label: { key: "msfile.home.title", fallback: "Get a file by Seed" },
      component: MsFileHomeFileWidget,
    });
    const business = ctx.get<BusinessFeatureRegistry>("business.registry");
    business.registerFeature(MSFILE_PLUGIN_ID, "home", {
      id: "home.msfile-file",
      label: { key: "msfile.home.title", fallback: "Get a file by Seed" },
      description: { key: "msfile.home.description", fallback: "Get a file by Seed" },
      order: 600,
      entry: {
        path: "/msfile/files",
        routeId: entryRouteId,
        visibleWhen: ({ unlocked }) => unlocked
      },
      home: [{
        id: "msfile.file-fetch",
        space: { id: "msfile.files", label: { key: "msfile.home.space", fallback: "MSFile files" }, order: 600 },
        order: 10,
        component: MsFileHomeFileWidget,
        visibleWhen: ({ unlocked }) => unlocked
      }]
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
      disposeAllMsFileMediaSessions();
      // Registry 与 resource definition 由 host 按 ownership 统一回收。
      // teardown 只释放 setup 自己创建的运行时对象，避免 host 随后重复注销。
      service.dispose();
    };
  }
};
