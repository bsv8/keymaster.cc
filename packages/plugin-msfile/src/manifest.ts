// packages/plugin-msfile/src/manifest.ts
// MSFile 插件清单：提供 `msfile.service`（页面侧 proxy）与 /settings/system
// 的 MSFile group。设置真值、分 purpose K-V 与网络都在 Coordinator SharedWorker。

import type { I18nPluginResources, PluginManifest, PluginSetup, PluginContext, ResourceRegistry, RouteRegistry, WindowP2pExecutorLaneRegistry } from "@keymaster/contracts";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import {
  BUSINESS_REGISTRY_CAPABILITY,
  ROUTE_REGISTRY_CAPABILITY,
  SYSTEM_SETTINGS_REGISTRY_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  type BusinessFeatureRegistry,
  type KeyspaceService,
  KEYSPACE_SERVICE_CAPABILITY,
  MSFILE_READ_CONCURRENCY_RECOMMENDED,
  MSFILE_SERVICE_CAPABILITY,
  MSFILE_COORDINATOR_CONTROL_CAPABILITY,
  P2PKH_PROTOCOL_SPEND_CAPABILITY,
  WEBRTC_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  type MsFileCoordinatorControl,
  WINDOW_P2P_EXECUTOR_CAPABILITY,
  defineRuntimeUnitDependencies,
  type SessionCoordinatorClient,
  type SystemSettingsRegistry,
} from "@keymaster/contracts";
import { MsFileServiceProxy } from "./msfileServiceProxy.js";
import { MsFileHomeFileWidget } from "./MsFileHomeFileWidget.js";
import { MsFileSettings } from "./MsFileSettings.js";
import { MsFileBucketHomeWidget, MsFileBucketPage } from "./MsFileBucketPage.js";
import { MSFILE_BUCKET_SERVICE_CAPABILITY, createMsFileBucketService } from "./msfileBucketService.js";
import { disposeAllMsFileMediaSessions, registerMsFileMediaResource } from "./msfileMediaResource.js";
import { MsFileP2pLane } from "./msfileLane.js";

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
      "msfile.settings.unavailable": "Wallet is locked or the MSFile service is temporarily unavailable; unlock to continue configuring.",
      "msfile.settings.save": "Save price limits",
      "msfile.settings.saved": "Saved. New reads use the new limits immediately.",
      "msfile.settings.suppliers": "Suppliers",
      "msfile.settings.supplier.name": "Display name",
      "msfile.settings.supplier.publicKey": "Supplier public key (66 hex chars)",
      "msfile.settings.supplier.addresses": "Dialable addresses (one per line, in try order)",
      "msfile.settings.supplier.enabled": "Enabled",
      "msfile.settings.supplier.builtin": "System default",
      "msfile.settings.supplier.builtinFixed": "Always enabled; cannot be edited or deleted",
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
      "msfile.home.config.bitfsIndependent": "BitFS demand discovery does not require regular MSFile suppliers; BitFS quotes can still be collected when the file is absent locally.",
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
      "msfile.home.bitfs.title": "BitFS demand and quotes",
      "msfile.home.bitfs.waiting": "The file is not local. A BitFS demand was published; waiting for seller quotes.",
      "msfile.home.bitfs.requestId": "Demand ID",
      "msfile.home.bitfs.expires": "Expires",
      "msfile.home.bitfs.noQuotes": "The demand is published. No valid quotes have arrived yet; this page will keep refreshing.",
      "msfile.home.bitfs.publishUnknown": "The publish result is unknown; waiting for quotes against the same demand ID.",
      "msfile.home.bitfs.seller": "Seller",
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
      "msfile.home.errors.default": "File fetching failed. Try again.",
      "msfile.bucket.title": "Bucket storage files",
      "msfile.bucket.description": "Seeds and file blocks produced in MasterSeed format and stored in this bucket; download, preview, verify, or delete them here.",
      "msfile.bucket.load": "View stored files",
      "msfile.bucket.openPage": "Open full page",
      "msfile.bucket.unavailable": "MSFile is unavailable right now. Try again later.",
      "msfile.bucket.upload.label": "Choose a file to upload",
      "msfile.bucket.upload.cancel": "Cancel upload",
      "msfile.bucket.upload.hashing": "Computing seed digests…",
      "msfile.bucket.upload.storing": "Storing file blocks…",
      "msfile.bucket.upload.failed": "Upload failed. Try again.",
      "msfile.bucket.upload.cancelled": "Upload cancelled; unfinished blocks are not listed.",
      "msfile.bucket.list.loading": "Reading stored seeds…",
      "msfile.bucket.list.retry": "Retry",
      "msfile.bucket.list.empty": "No stored seeds yet",
      "msfile.bucket.list.emptyHint": "Choose a file above; it is split into MasterSeed blocks, and the seed file plus blocks are stored in this bucket.",
      "msfile.bucket.column.seed": "Seed Hash",
      "msfile.bucket.column.name": "File name",
      "msfile.bucket.column.type": "Type",
      "msfile.bucket.column.size": "Size",
      "msfile.bucket.column.blocks": "Blocks",
      "msfile.bucket.column.storedAt": "Stored at",
      "msfile.bucket.column.actions": "Actions",
      "msfile.bucket.metaMissing": "Metadata missing",
      "msfile.bucket.seedMissing": "Seed lost",
      "msfile.bucket.action.preview": "Preview",
      "msfile.bucket.action.download": "Download",
      "msfile.bucket.action.verify": "Verify",
      "msfile.bucket.action.delete": "Delete",
      "msfile.bucket.action.cancel": "Cancel",
      "msfile.bucket.action.deleteConfirmTitle": "Delete this entry?",
      "msfile.bucket.action.deleteConfirmBody": "This deletes the seed file, metadata, and every block under that seed's directory; other seeds are unaffected.",
      "msfile.bucket.action.deleteConfirm": "Delete",
      "msfile.bucket.status.previewing": "Reading blocks…",
      "msfile.bucket.status.downloading": "Reading and verifying blocks…",
      "msfile.bucket.status.verifying": "Verifying the whole entry…",
      "msfile.bucket.status.deleting": "Deleting…",
      "msfile.bucket.preview.title": "File preview",
      "msfile.bucket.preview.htmlTitle": "HTML safe static preview",
      "msfile.bucket.preview.pdfTitle": "PDF preview",
      "msfile.bucket.preview.close": "Close preview",
      "msfile.bucket.notice.uploadDone": "Upload complete: seed and file blocks are stored in the bucket.",
      "msfile.bucket.notice.downloadTooLarge": "Files over 256 MiB are not read in this browser.",
      "msfile.bucket.notice.previewTooLarge": "Files over 32 MiB are not previewed automatically; download instead.",
      "msfile.bucket.notice.previewUnsupported": "This file type is not previewed automatically; download it instead.",
      "msfile.bucket.notice.verifyOk": "Verified: seed present, all {{blocks}} block files accounted for.",
      "msfile.bucket.notice.verifySeedOnly": "Verified: seed present, all {{blocks}} block files accounted for (metadata missing).",
      "msfile.bucket.notice.verifyMissingBlocks": "Incomplete: {{missing}} block file(s) are missing.",
      "msfile.bucket.notice.verifySeedInvalid": "The seed file is damaged (length is not a multiple of 32).",
      "msfile.bucket.notice.verifyMetaMismatch": "Metadata does not match the seed.",
      "msfile.bucket.notice.deleteDone": "Entry deleted: seed, metadata, and file blocks.",
      "msfile.bucket.notice.seedMissing": "The seed file is missing; content cannot be read.",
      "msfile.bucket.error.invalidHash": "Seed Hash must be 64 lower-case hexadecimal characters.",
      "msfile.bucket.error.invalidSource": "The file cannot be read or exceeds this browser's limit.",
      "msfile.bucket.error.sourceChanged": "The source file changed while reading; upload was aborted.",
      "msfile.bucket.error.missingSeed": "The seed file does not exist.",
      "msfile.bucket.error.missingMeta": "Metadata is missing; file name, type, and size cannot be recovered.",
      "msfile.bucket.error.missingBlock": "A file block is missing; the content is incomplete.",
      "msfile.bucket.error.invalidMeta": "Metadata is damaged and was treated as missing.",
      "msfile.bucket.error.integrity": "Integrity check failed; all bytes were discarded.",
      "msfile.bucket.error.cancelled": "The operation was cancelled.",
      "msfile.bucket.error.download": "The browser could not create a download file.",
      "msfile.bucket.error.default": "Bucket storage operation failed. Try again."
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
      "msfile.settings.unavailable": "钱包已锁定或 MSFile 服务暂不可用；解锁后可继续配置。",
      "msfile.settings.save": "保存价格限制",
      "msfile.settings.saved": "已保存。之后的 Read 立即使用新限额。",
      "msfile.settings.suppliers": "供应商配置",
      "msfile.settings.supplier.name": "显示名称",
      "msfile.settings.supplier.publicKey": "供应商公钥（66 位 hex）",
      "msfile.settings.supplier.addresses": "可拨号地址（每行一个，按尝试顺序）",
      "msfile.settings.supplier.enabled": "启用",
      "msfile.settings.supplier.builtin": "系统内置",
      "msfile.settings.supplier.builtinFixed": "始终启用，不可编辑或删除",
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
      "msfile.home.config.bitfsIndependent": "BitFS 需求广播不依赖普通 MSFile 供应商；本地缺失时仍可收集 BitFS 报价。",
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
      "msfile.home.bitfs.title": "BitFS 需求与报价",
      "msfile.home.bitfs.waiting": "本地没有该文件，已发布 BitFS 需求；正在等待卖家报价。",
      "msfile.home.bitfs.requestId": "需求编号",
      "msfile.home.bitfs.expires": "有效至",
      "msfile.home.bitfs.noQuotes": "需求已发出，尚未收到有效报价；页面会继续刷新报价。",
      "msfile.home.bitfs.publishUnknown": "需求发布结果暂时未知；正在按原需求编号等待报价。",
      "msfile.home.bitfs.seller": "卖家",
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
      "msfile.home.errors.default": "文件获取失败，请重试。",
      "msfile.bucket.title": "桶存储文件",
      "msfile.bucket.description": "按 MasterSeed 格式存入本桶的种子与文件块；可直接下载、预览、校验或删除。",
      "msfile.bucket.load": "查看存储文件",
      "msfile.bucket.openPage": "打开完整页面",
      "msfile.bucket.unavailable": "MSFile 当前不可用，请稍后重试。",
      "msfile.bucket.upload.label": "选择文件并上传",
      "msfile.bucket.upload.cancel": "取消上传",
      "msfile.bucket.upload.hashing": "正在计算种子摘要…",
      "msfile.bucket.upload.storing": "正在写入文件块…",
      "msfile.bucket.upload.failed": "上传失败，请重试。",
      "msfile.bucket.upload.cancelled": "上传已取消；未完成的块不会进入列表。",
      "msfile.bucket.list.loading": "正在读取桶内种子…",
      "msfile.bucket.list.retry": "重试",
      "msfile.bucket.list.empty": "还没有已存储的种子",
      "msfile.bucket.list.emptyHint": "选择上面的文件上传；上传完成后会按 MasterSeed 制作种子文件并写入文件块。",
      "msfile.bucket.column.seed": "Seed Hash",
      "msfile.bucket.column.name": "文件名",
      "msfile.bucket.column.type": "类型",
      "msfile.bucket.column.size": "大小",
      "msfile.bucket.column.blocks": "块数",
      "msfile.bucket.column.storedAt": "存入时间",
      "msfile.bucket.column.actions": "操作",
      "msfile.bucket.metaMissing": "元数据缺失",
      "msfile.bucket.seedMissing": "种子丢失",
      "msfile.bucket.action.preview": "预览",
      "msfile.bucket.action.download": "下载",
      "msfile.bucket.action.verify": "校验",
      "msfile.bucket.action.delete": "删除",
      "msfile.bucket.action.cancel": "取消",
      "msfile.bucket.action.deleteConfirmTitle": "删除这个条目？",
      "msfile.bucket.action.deleteConfirmBody": "将删除种子、元数据以及该种子目录下的全部文件块；其它种子不受影响。",
      "msfile.bucket.action.deleteConfirm": "删除",
      "msfile.bucket.status.previewing": "正在读取文件块…",
      "msfile.bucket.status.downloading": "正在读取并校验文件块…",
      "msfile.bucket.status.verifying": "正在完整校验…",
      "msfile.bucket.status.deleting": "正在删除…",
      "msfile.bucket.preview.title": "文件预览",
      "msfile.bucket.preview.htmlTitle": "HTML 安全静态预览",
      "msfile.bucket.preview.pdfTitle": "PDF 预览",
      "msfile.bucket.preview.close": "关闭预览",
      "msfile.bucket.notice.uploadDone": "上传完成，种子与文件块已写入存储桶。",
      "msfile.bucket.notice.downloadTooLarge": "文件超过 256 MiB，当前浏览器不会读取。",
      "msfile.bucket.notice.previewTooLarge": "超过 32 MiB 的文件不会自动预览，请下载后查看。",
      "msfile.bucket.notice.previewUnsupported": "该文件类型不会自动预览，请下载后使用。",
      "msfile.bucket.notice.verifyOk": "校验通过：种子存在，{{blocks}} 个块文件齐全。",
      "msfile.bucket.notice.verifySeedOnly": "校验通过：种子存在，{{blocks}} 个块文件齐全（元数据缺失）。",
      "msfile.bucket.notice.verifyMissingBlocks": "内容不完整：缺少 {{missing}} 个块文件。",
      "msfile.bucket.notice.verifySeedInvalid": "种子文件损坏（长度不是 32 的整数倍）。",
      "msfile.bucket.notice.verifyMetaMismatch": "元数据与种子不一致。",
      "msfile.bucket.notice.deleteDone": "条目已删除：种子、元数据和文件块。",
      "msfile.bucket.notice.seedMissing": "种子文件已丢失，无法读取内容。",
      "msfile.bucket.error.invalidHash": "Seed Hash 必须是 64 位小写十六进制字符。",
      "msfile.bucket.error.invalidSource": "该文件无法读取或超过浏览器可处理的大小。",
      "msfile.bucket.error.sourceChanged": "读取过程中源文件发生变化，上传已中止。",
      "msfile.bucket.error.missingSeed": "种子文件不存在。",
      "msfile.bucket.error.missingMeta": "元数据缺失，无法还原文件名、类型和大小。",
      "msfile.bucket.error.missingBlock": "文件块缺失，内容不完整。",
      "msfile.bucket.error.invalidMeta": "元数据损坏，已按缺失处理。",
      "msfile.bucket.error.integrity": "内容校验失败，已丢弃全部字节。",
      "msfile.bucket.error.cancelled": "操作已取消。",
      "msfile.bucket.error.download": "浏览器无法创建下载文件。",
      "msfile.bucket.error.default": "桶存储操作失败，请重试。"
    }
  }
};

export const msfileResources = resources;

const msfilePluginDefinition = {
  id: MSFILE_PLUGIN_ID,
  name: "MSFile",
  description: "MSFile Proxy V1 客户端能力：多供应商 Stat/Read、价格授权与供应商配置。",
  kind: "platform",
  startup: "optional",
  bootstrapStage: "owner-apps-ready",
  // 默认加载只负责让设置入口和首页模块稳定出现；未配置全局金额或
  // 供应商时，组件仍在发起 Stat/Read 前 fail closed。
  defaultEnabled: true,
  canDisable: false,
  displayGroup: "platform",
  units: [{
    id: "msfile.window",
    runtime: "window-main",
    scopeKind: "owner-session",
    provides: [MSFILE_SERVICE_CAPABILITY, MSFILE_COORDINATOR_CONTROL_CAPABILITY, MSFILE_BUCKET_SERVICE_CAPABILITY],
    // 桶存储页面直接读写 `<owner>/msfiles/` 文件根（seeds/storage/meta）；
    // 句柄由 Host 绑定、真实 I/O 仍由 Coordinator Worker 执行。
    storages: [CENTRAL_STORAGE_DECLARATIONS.msfilesFiles],
    dependencies: defineRuntimeUnitDependencies([
      { capability: WINDOW_P2P_EXECUTOR_CAPABILITY, reason: "MSFile 数据面挂载到唯一 Window P2P Host 的 msfile lane" },
      { capability: P2PKH_PROTOCOL_SPEND_CAPABILITY, optional: true, reason: "BitFS 专款交易只通过 P2PKH 受控 signer 预签；P2PKH 未启用时买方准备保持不可用" },
      { capability: WEBRTC_SERVICE_CAPABILITY, optional: true, reason: "BitFS SDP DataChannel 复用用户当前 WebRTC STUN 配置" },
      { capability: SYSTEM_SETTINGS_REGISTRY_CAPABILITY, reason: "MSFile settings live under Settings -> System" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, reason: "注册 MSFile 首页文件获取投影" },
      { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "active key 变化时取消首页文件任务" },
      { capability: VAULT_SERVICE_CAPABILITY, reason: "首页文件读取只允许在 Vault unlocked 时进行" },
      { capability: RESOURCE_REGISTRY_CAPABILITY, reason: "注册 MSFile resources" },
      { capability: ROUTE_REGISTRY_CAPABILITY, reason: "注册 MSFile 文件入口" },
    ]),
  }, {
    id: "msfile.coordinator-worker",
    runtime: "shared-worker",
    scopeKind: "owner-session",
    // 设置与供应商是 `<owner>/msfiles/setting.json`；App 覆盖额度按 publisher
    // 打开 `<owner>/app.<publisher>/settings.json`（绑定需要 publisher，不能
    // 通过 filesFor(purposeId) 预绑定，因此不出现在这里）。
    storages: [
      CENTRAL_STORAGE_DECLARATIONS.msfilesFiles,
      CENTRAL_STORAGE_DECLARATIONS.bitfsJournalFiles,
    ],
  }],
  i18n: resources,
  setup(ctx: PluginContext) {
    const coordinator = ctx.coordinator as MsFileCoordinatorControl | undefined;
    if (!coordinator) throw new Error("MSFile Coordinator control is unavailable");
    ctx.provide(MSFILE_COORDINATOR_CONTROL_CAPABILITY, coordinator);
    const laneRegistry = ctx.capability(WINDOW_P2P_EXECUTOR_CAPABILITY);
    // MSFile 只注册自己的业务 lane；公共 Host 与 executor 由 Window P2P
    // 系统插件拥有，避免两个插件各自建立网络实例。
    const protocolSpend = ctx.optionalCapability(P2PKH_PROTOCOL_SPEND_CAPABILITY);
    const webRtcService = ctx.optionalCapability(WEBRTC_SERVICE_CAPABILITY);
    const offLane = laneRegistry.register(new MsFileP2pLane(
      protocolSpend,
      () => webRtcService?.getStunServers?.() ?? ["stun:stun.l.google.com:19302"],
    ));
    const service = new MsFileServiceProxy(coordinator);
    ctx.provide(MSFILE_SERVICE_CAPABILITY, service);
    // 桶存储服务复用同一 owner 文件根；MasterSeed 算法来自官方 SDK。
    // 块写入经 Coordinator 直写，避免页面 storage 数据面的端口并发上限。
    const bucketService = createMsFileBucketService({ store: ctx.filesFor(""), coordinator });
    ctx.provide(MSFILE_BUCKET_SERVICE_CAPABILITY, bucketService);

    const resources_ = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
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
    const routes = ctx.capability(ROUTE_REGISTRY_CAPABILITY);
    const entryRouteId = "msfile.home.file";
    routes.register({
      id: entryRouteId,
      path: "/msfile/files",
      label: { key: "msfile.home.title", fallback: "Get a file by Seed" },
      component: MsFileHomeFileWidget,
    });
    const bucketRouteId = "msfile.bucket.storage";
    routes.register({
      id: bucketRouteId,
      path: "/msfile/storage",
      label: { key: "msfile.bucket.title", fallback: "Bucket storage files" },
      component: MsFileBucketPage,
    });
    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
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
    // 桶存储文件：正式页面入口 `/msfile/storage`，首页 MSFile 空间复用同一组件。
    business.registerFeature(MSFILE_PLUGIN_ID, "home", {
      id: "home.msfile-bucket",
      label: { key: "msfile.bucket.title", fallback: "Bucket storage files" },
      description: { key: "msfile.bucket.description", fallback: "Seeds and blocks stored in this bucket" },
      order: 610,
      entry: {
        path: "/msfile/storage",
        routeId: bucketRouteId,
        visibleWhen: ({ unlocked }) => unlocked
      },
      home: [{
        id: "msfile.bucket-storage",
        space: { id: "msfile.files", label: { key: "msfile.home.space", fallback: "MSFile files" }, order: 600 },
        order: 20,
        // 首页入口默认折叠，不读取桶；点开才加载 meta 列表。
        component: MsFileBucketHomeWidget,
        visibleWhen: ({ unlocked }) => unlocked
      }]
    });

    const settings = ctx.capability(SYSTEM_SETTINGS_REGISTRY_CAPABILITY);
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
      disposeAllMsFileMediaSessions();
      offLane();
      // Registry 与 resource definition 由 host 按 ownership 统一回收。
      // teardown 只释放 setup 自己创建的运行时对象，避免 host 随后重复注销。
      service.dispose();
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: msfileSetup, ...msfilePlugin } = msfilePluginDefinition;
export { msfileSetup, msfilePlugin };
