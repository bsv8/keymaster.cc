import { PROTOCOL_METHODS, STORAGE_FILE_CLIENTS_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY } from "@keymaster/contracts";
import { COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY, COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY } from "@keymaster/contracts";
import { APP_STORAGE_CLIENTS_CAPABILITY } from "@keymaster/contracts";
import { createAppStorageClients } from "./coordinator/appStorageClients.js";
import { STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY } from "@keymaster/contracts";
import { StorageUnavailableGuard } from "./ui/StorageUnavailableGuard.js";
import { createElement } from "react";
import { StoragePrivateProvider } from "./ui/StoragePrivateContext.js";
import { I18N_SERVICE_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY } from "@keymaster/contracts";
// Storage 拥有钱包本地存储、只读浏览及 Connect 专用 S3 文件能力。
// 两种介质的数据面分离，私有 S3 配置仅向本插件 UI 开放。
import type {
  I18nPluginResources,
  PluginManifest,
  PluginSetup,
  StorageCoordinatorControl,
} from "@keymaster/contracts";
import {
  BREADCRUMB_REGISTRY_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  STORAGE_RUNTIME_CONTROLLER_CAPABILITY,
  capabilityDescriptor,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import { StorageRpcProxy } from "./coordinator/storageRpcProxy.js";
import { STORAGE_PRIVATE_BROWSE_CAPABILITY } from "./coordinator/storageBrowsePrivateCapability.js";
import { StorageBrowseRpcProxy } from "./coordinator/storageBrowseRpcProxy.js";
import { IndexedDbPersistenceBar } from "./ui/IndexedDbPersistenceBar.js";
import { STORAGE_PRIVATE_S3_CAPABILITY } from "./connect-s3/protocol.js";
import { ConnectS3SettingsPage } from "./ui/ConnectS3SettingsPage.js";
import { StorageBrowsePage } from "./ui/StorageBrowsePage.js";

export const STORAGE_PLATFORM_PLUGIN_ID = "storage";
/**
 * 浏览页所在的 window 单元 id。
 *
 * 它只用于 manifest 的单元身份声明，**不参与授权**：打开浏览会话不再逐字比对任何
 * 单元 id，授权由 Coordinator 从已验证的 peer 上下文签发。
 */
export const STORAGE_BROWSE_UNIT_ID = "storage.window";

export const storageResources: I18nPluginResources = {
  namespace: "common",
  resources: {
    en: {
      "storage.s3.testing": "Testing connection…",
      "storage.s3.failed.configuration": "Configuration is invalid. Nothing was saved; correct the fields and retry.",
      "storage.s3.failed.list": "S3 listing failed. Nothing was saved; check the endpoint, credentials, permissions and CORS, then retry.",
      "storage.s3.failed.write": "S3 test upload failed. Nothing was saved; correct the configuration and retry.",
      "storage.s3.failed.read": "S3 test read failed. Nothing was saved; check read permissions and CORS, then retry.",
      "storage.s3.failed.verify": "S3 test content or version did not match. Nothing was saved; check the service and CORS exposed headers, then retry.",
      "storage.s3.failed.delete": "S3 test cleanup failed. Nothing was saved; check delete permissions and retry.",
      "storage.s3.failed.cancelled": "The S3 check was cancelled or timed out. Nothing was saved; retry when the connection is available.",
      "storage.s3.cleanupFailed": "A test object may remain in the bucket. Remove this object manually:",
      "storage.s3.httpStatus": "HTTP status: {{status}}",
      "storage.s3.cleared": "Configuration removed. Remote App files were not deleted.",
      "storage.s3.pageTitle": "Storage",
      "storage.s3.locationTitle": "Storage location",
      "storage.s3.locationHint": "Define where App files are stored and how the bucket is addressed.",
      "storage.s3.authenticationTitle": "Access credentials",
      "storage.s3.addressingHint": "Address the bucket through the endpoint path instead of a bucket subdomain.",
      "storage.s3.connectionNotes": "Connection and data notes",
      "storage.s3.dataHint": "Wallet keys and internal data stay in this browser. App objects are stored as submitted, without wallet encryption.",
      "storage.s3.title": "Storage",
      "storage.s3.description": "Define the storage location and connection settings for external App files.",
      "storage.s3.configured": "S3 is configured. All connected Apps use their isolated S3 directories.",
      "storage.s3.missing": "S3 is not configured. App storage is unavailable.",
      "storage.s3.endpoint": "HTTPS endpoint",
      "storage.s3.region": "Region",
      "storage.s3.bucket": "Bucket",
      "storage.s3.accessKeyId": "Access Key ID",
      "storage.s3.secretAccessKey": "Secret Access Key",
      "storage.s3.sessionToken": "Session token (optional)",
      "storage.s3.forcePathStyle": "Use path-style bucket URLs (Path-Style)",
      "storage.s3.credentialsHint": "Credentials are encrypted locally with Vault after the connection check passes. Re-enter credentials to save changes; failed checks keep your inputs for correction.",
      "storage.s3.save": "Save",
      "storage.s3.clear": "Remove configuration",
      "storage.s3.probe": "Test saved connection",
      "storage.s3.probeOk": "Saved connection passed listing, test upload, read verification and cleanup.",
      "storage.s3.saved": "S3 connection check passed. Configuration saved.",
      "storage.s3.failed": "Operation failed. Check the configuration, wallet session, network, S3 permissions and CORS, then retry.",
      "storage.s3.corsHint": "Allow the wallet origin in bucket CORS, with GET, PUT, DELETE, HEAD and the required request headers. Expose ETag and Last-Modified. Removing configuration does not delete remote files. Local App files are not migrated.",
      "storage.status.title": "Local storage",
      "storage.activity.title": "Storage activity", "storage.activity.read": "Reading", "storage.activity.write": "Writing",
      "storage.activity.reading": "Storage reading", "storage.activity.writing": "Storage writing",
      "storage.activity.readIdle": "Storage reads idle", "storage.activity.writeIdle": "Storage writes idle",
      "storage.browse.business.label": "Local storage",
      "storage.browse.crumb.browse": "Local storage",
      "storage.browse.crumb.settings": "Settings",
      "storage.browse.title": "Local storage",
      "storage.browse.description": "Read-only view of the files this wallet stores in this browser.",
      "storage.browse.refresh": "Refresh",
      "storage.browse.loading": "Loading…",
      "storage.browse.notLoaded": "Not loaded yet.",
      "storage.browse.emptyDirectory": "This directory is empty.",
      "storage.browse.loadFailed": "This directory could not be listed.",
      "storage.browse.loadMore": "Load more",
      "storage.browse.retry": "Retry",
      "storage.browse.partialHint": "More objects may exist under this prefix; browsing only reads metadata.",
      "storage.browse.renderWindow": "Showing {{first}}–{{last}} of {{total}} loaded items.",
      "storage.browse.pagePrevious": "Previous items",
      "storage.browse.pageNext": "Next items",
      "storage.browse.crumbs.label": "Current path",
      "storage.browse.crumb.root": "/",
      "storage.browse.detail.label": "File detail",
      "storage.browse.tree.label": "Storage tree",
      "storage.browse.tree.expand": "Expand {{name}}",
      "storage.browse.tree.collapse": "Collapse {{name}}",
      "storage.browse.tab.preview": "Preview",
      "storage.browse.tab.properties": "Properties",
      "storage.browse.noSelection": "Select a file to preview it.",
      "storage.browse.detail.empty": "Select a file or directory in the file tree.",
      "storage.browse.previewLoading": "Loading preview…",
      "storage.browse.previewFailed": "This object could not be read.",
      "storage.browse.truncated": "Showing the first {{shown}} of {{total}} bytes.",
      "storage.browse.emptyFile": "Empty file",
      "storage.browse.unsupportedFormat": "This format cannot be previewed.",
      "storage.browse.encodingUnsupported": "This text uses an unsupported encoding.",
      "storage.browse.jsonBroken": "This object is not valid JSON; showing the original text.",
      "storage.browse.retryPreview": "Retry",
      "storage.browse.verifyFailed": "The selected file could not be verified after refreshing; it may still exist.",
      "storage.browse.jsonCount": "{{type}} · {{count}}",
      "storage.browse.json.source": "Original text",
      "storage.browse.jsonScalar": "{{type}}",
      "storage.browse.jsonMore": "Show more members ({{hidden}} remaining)",
      "storage.browse.toggleWrap": "Wrap lines",
      "storage.browse.md.render": "Rendered",
      "storage.browse.md.source": "Source",
      "storage.browse.md.image": "[image: {{target}}]",
      "storage.browse.md.capped": "This document was truncated for display.",
      "storage.browse.kv.raw": "Raw object",
      "storage.browse.kv.decoded": "Decoded",
      "storage.browse.kv.valueId": "Value id",
      "storage.browse.kv.partition": "Partition",
      "storage.browse.kv.payload": "Payload",
      "storage.browse.kv.envelopeInvalid": "The key-value envelope is malformed.",
      "storage.browse.kv.versionUnsupported": "This key-value version is not supported.",
      "storage.browse.kv.hashMismatch": "The key-value payload hash does not match.",
      "storage.browse.kv.payloadUnsupported": "The key-value payload is binary and cannot be previewed.",
      "storage.browse.kv.invalid": "This key-value object could not be decoded.",
      "storage.browse.copyPath": "Copy path",
      "storage.browse.pathCopied": "Path copied to the clipboard.",
      "storage.browse.copyFailed": "The path could not be copied.",
      "storage.browse.properties.noSelection": "Select a file to see its properties.",
      "storage.browse.props.type": "Type",
      "storage.browse.props.directory": "Directory",
      "storage.browse.props.children": "Loaded direct children",
      "storage.browse.props.path": "Path",
      "storage.browse.props.size": "Size",
      "storage.browse.props.modified": "Modified",
      "storage.browse.props.revision": "Revision",
      "storage.browse.props.contentType": "Content type",
      "storage.browse.props.format": "Preview format",
      "storage.browse.marker.title": "Directory marker",
      "storage.browse.marker.hint": "This zero-byte marker object is how an empty directory is stored; it is not a separate file.",
      "storage.browse.gone": "This object no longer exists.",
      "storage.browse.changed": "This object changed since it was listed. Refresh to read the current version.",
      "storage.browse.removed": "The selected file no longer exists.",
      "storage.browse.unavailable": "Storage browsing is not available. The wallet may be locked.",
      "storage.browse.forbidden": "This request is not permitted.",
      "storage.browse.failed": "The request failed.",
    },
    "zh-CN": {
      "storage.s3.testing": "正在测试连接…",
      "storage.s3.failed.configuration": "配置格式不正确，未保存。请修改后重新保存。",
      "storage.s3.failed.list": "S3 列举失败，未保存。请检查端点、凭据、权限和 CORS 后重试。",
      "storage.s3.failed.write": "S3 测试写入失败，未保存。请修改配置后重试。",
      "storage.s3.failed.read": "S3 测试读取失败，未保存。请检查读取权限和 CORS 后重试。",
      "storage.s3.failed.verify": "S3 测试内容或版本核对失败，未保存。请检查服务和 CORS 暴露头后重试。",
      "storage.s3.failed.delete": "S3 测试对象清理失败，未保存。请检查删除权限后重试。",
      "storage.s3.failed.cancelled": "S3 检查已取消或超时，未保存。请恢复连接后重试。",
      "storage.s3.cleanupFailed": "桶中可能残留测试对象，请人工清理此对象：",
      "storage.s3.httpStatus": "HTTP 状态：{{status}}",
      "storage.s3.cleared": "已移除配置，未删除远端 App 文件。",
      "storage.s3.pageTitle": "存储",
      "storage.s3.locationTitle": "存储位置",
      "storage.s3.locationHint": "定义外部 App 文件的存储位置和访问方式。",
      "storage.s3.authenticationTitle": "访问凭据",
      "storage.s3.addressingHint": "通过端点路径访问桶，而非使用桶名子域名。",
      "storage.s3.connectionNotes": "连接与数据说明",
      "storage.s3.dataHint": "钱包密钥和内部数据仍在本浏览器。App 对象按提交内容存储，钱包不额外加密文件内容。",
      "storage.s3.title": "存储",
      "storage.s3.description": "定义外部 App 文件的存储位置和连接方式。",
      "storage.s3.configured": "已配置 S3，所有连接的 App 使用各自隔离的 S3 目录。",
      "storage.s3.missing": "尚未配置 S3，App 存储不可用。",
      "storage.s3.endpoint": "HTTPS 端点",
      "storage.s3.region": "区域（Region）",
      "storage.s3.bucket": "桶名称（Bucket）",
      "storage.s3.accessKeyId": "Access Key ID",
      "storage.s3.secretAccessKey": "Secret Access Key",
      "storage.s3.sessionToken": "会话令牌（可选）",
      "storage.s3.forcePathStyle": "使用路径式桶地址（Path-Style）",
      "storage.s3.credentialsHint": "连接检查通过后，凭据由 Vault 加密保存在本机。修改已保存配置需重新输入凭据；检查失败会保留本页输入供修改。",
      "storage.s3.save": "保存",
      "storage.s3.clear": "移除配置",
      "storage.s3.probe": "测试已保存连接",
      "storage.s3.probeOk": "已保存连接的列举、测试写入、读回核对及清理均已通过。",
      "storage.s3.saved": "S3 连接检查通过，配置已保存。",
      "storage.s3.failed": "操作失败，请检查配置、钱包连接、网络、S3 权限与 CORS 后重试。",
      "storage.s3.corsHint": "桶 CORS 需允许钱包来源、GET / PUT / DELETE / HEAD 及所需请求头，并暴露 ETag、Last-Modified。移除配置不删除远端文件；旧 App 本地文件不会迁移。",
      "storage.status.title": "本地存储",
      "storage.activity.title": "存储活动", "storage.activity.read": "读取", "storage.activity.write": "写入",
      "storage.activity.reading": "正在读取存储", "storage.activity.writing": "正在写入存储",
      "storage.activity.readIdle": "存储读取空闲", "storage.activity.writeIdle": "存储写入空闲",
      "storage.browse.business.label": "本地存储",
      "storage.browse.crumb.browse": "本地存储",
      "storage.browse.crumb.settings": "设置",
      "storage.browse.title": "本地存储",
      "storage.browse.description": "只读查看本钱包保存在当前浏览器中的文件。",
      "storage.browse.refresh": "刷新",
      "storage.browse.loading": "加载中…",
      "storage.browse.notLoaded": "尚未加载。",
      "storage.browse.emptyDirectory": "此目录为空。",
      "storage.browse.loadFailed": "此目录无法列出。",
      "storage.browse.loadMore": "继续加载",
      "storage.browse.retry": "重试",
      "storage.browse.partialHint": "该前缀下可能还有更多对象；浏览只读取元数据。",
      "storage.browse.renderWindow": "正在显示第 {{first}}–{{last}} 项，共加载 {{total}} 项。",
      "storage.browse.pagePrevious": "上一批",
      "storage.browse.pageNext": "下一批",
      "storage.browse.crumbs.label": "当前路径",
      "storage.browse.crumb.root": "/",
      "storage.browse.detail.label": "文件详情",
      "storage.browse.tree.label": "存储树",
      "storage.browse.tree.expand": "展开 {{name}}",
      "storage.browse.tree.collapse": "收起 {{name}}",
      "storage.browse.tab.preview": "预览",
      "storage.browse.tab.properties": "属性",
      "storage.browse.noSelection": "选择一个文件以预览。",
      "storage.browse.detail.empty": "在左侧文件树中选择一个文件或目录。",
      "storage.browse.previewLoading": "正在加载预览…",
      "storage.browse.previewFailed": "此对象无法读取。",
      "storage.browse.truncated": "已显示前 {{shown}} 字节，共 {{total}} 字节。",
      "storage.browse.emptyFile": "空文件",
      "storage.browse.unsupportedFormat": "此格式暂不支持预览。",
      "storage.browse.encodingUnsupported": "此文本使用了不支持的编码。",
      "storage.browse.jsonBroken": "此对象不是合法 JSON，以下显示原文。",
      "storage.browse.retryPreview": "重试",
      "storage.browse.verifyFailed": "刷新后无法核验选中的文件，它可能仍然存在。",
      "storage.browse.jsonCount": "{{type}} · {{count}}",
      "storage.browse.json.source": "原文",
      "storage.browse.jsonScalar": "{{type}}",
      "storage.browse.jsonMore": "显示更多成员（还有 {{hidden}} 项）",
      "storage.browse.toggleWrap": "自动换行",
      "storage.browse.md.render": "渲染",
      "storage.browse.md.source": "源码",
      "storage.browse.md.image": "[图片: {{target}}]",
      "storage.browse.md.capped": "此文档已在展示时截断。",
      "storage.browse.kv.raw": "原始对象",
      "storage.browse.kv.decoded": "解码内容",
      "storage.browse.kv.valueId": "Value id",
      "storage.browse.kv.partition": "分区",
      "storage.browse.kv.payload": "载荷",
      "storage.browse.kv.envelopeInvalid": "K-V 信封格式损坏。",
      "storage.browse.kv.versionUnsupported": "不支持该 K-V 版本。",
      "storage.browse.kv.hashMismatch": "K-V 载荷哈希不匹配。",
      "storage.browse.kv.payloadUnsupported": "K-V 载荷是二进制，无法预览。",
      "storage.browse.kv.invalid": "此 K-V 对象无法解码。",
      "storage.browse.copyPath": "复制路径",
      "storage.browse.pathCopied": "路径已复制到剪贴板。",
      "storage.browse.copyFailed": "路径复制失败。",
      "storage.browse.properties.noSelection": "选择一个文件以查看属性。",
      "storage.browse.props.type": "类型",
      "storage.browse.props.directory": "目录",
      "storage.browse.props.children": "已加载直接子项",
      "storage.browse.props.path": "路径",
      "storage.browse.props.size": "大小",
      "storage.browse.props.modified": "修改时间",
      "storage.browse.props.revision": "版本",
      "storage.browse.props.contentType": "内容类型",
      "storage.browse.props.format": "预览格式",
      "storage.browse.marker.title": "目录标记",
      "storage.browse.marker.hint": "零字节标记对象是空目录的存储方式，它不是一个独立文件。",
      "storage.browse.gone": "此对象已不存在。",
      "storage.browse.changed": "此对象在列出后已变化，请刷新以读取最新版本。",
      "storage.browse.removed": "选中的文件已不存在。",
      "storage.browse.unavailable": "存储浏览暂不可用，钱包可能已锁定。",
      "storage.browse.forbidden": "此请求不被允许。",
      "storage.browse.failed": "请求失败。",
    },
  },
};

const storagePlatformPluginDefinition = {
  id: STORAGE_PLATFORM_PLUGIN_ID,
  name: "Storage",
  description: "本 Origin 的单钱包本地存储与统一文件存储能力。",

  units: [{
    id: STORAGE_BROWSE_UNIT_ID,
    runtime: "window-main" as const,
    connect: { providerMethods: PROTOCOL_METHODS.filter(method => method.startsWith("storage.")) },
    scopeKind: "storage" as const,
    provides: [
      capabilityDescriptor(STORAGE_RUNTIME_CONTROLLER_CAPABILITY), APP_STORAGE_CLIENTS_CAPABILITY,
    ],
    dependencies: defineRuntimeUnitDependencies([
      { capability: STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY, sourceRuntime: "window-main", reason: "声明本插件的受限 Coordinator 连接" },
      { capability: RESOURCE_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
      { capability: I18N_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
      { capability: PAGE_UI_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
      { capability: PAGE_UI_RENDERER_CAPABILITY, sourceRuntime: "window-main", reason: "迁移恢复守卫渲染受限钱包恢复入口" },
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, reason: "为 /settings/storage 提供面包屑" },
    ]),
  }, {
    id: "storage.coordinator-worker",
    runtime: "shared-worker" as const,
    scopeKind: "storage" as const,
    provides: [COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY, COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY, STORAGE_FILE_CLIENTS_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY],
    privateProvides: [STORAGE_PRIVATE_BROWSE_CAPABILITY, STORAGE_PRIVATE_S3_CAPABILITY],
  }],
  i18n: storageResources,
  async setup(ctx) {
    const coordinator = ctx.capability(STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY).bind(ctx.consumer, ctx.scope) as StorageCoordinatorControl | undefined;
    if (!coordinator) throw new Error("Storage Coordinator control is unavailable");
    const service = new StorageRpcProxy(coordinator);
    // 浏览代理与控制器共用同一个端口：Worker 按 clientId 归属会话，因此
    // 两者关闭顺序不需要额外协调。
    const browse = new StorageBrowseRpcProxy({
      client: () => ctx.privateCapability(STORAGE_PRIVATE_BROWSE_CAPABILITY),
      sessionEpoch: () => coordinator.getSessionEpoch(),
    });
    ctx.provide(STORAGE_RUNTIME_CONTROLLER_CAPABILITY, Object.freeze({
      status: () => service.status(), subscribe: (listener: () => void) => service.subscribe(listener),
      summary: () => service.summary(), abortSession: (sessionId: string) => service.abortSession(sessionId),
    }));
    ctx.provide(APP_STORAGE_CLIENTS_CAPABILITY, createAppStorageClients(service, ctx.scope));
    // 页面闭包只捕获本实例的私有服务；注册数据不携带服务对象。
    const privateContents = (Component: import("react").ComponentType) => createElement(StoragePrivateProvider, {
      service: browse, controller: service, children: createElement(Component),
    });
    const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope);
    pages.view.register({ kind: "frame", slot: "storage-guard", id: "storage.guard", label: "Storage",
      render: location => createElement(StorageUnavailableGuard, { children: location.children }) });
    pages.view.register({ id: "storage.connect-s3", kind: "page", path: "/settings/connect-storage",
      label: { key: "storage.s3.title", fallback: "Storage" },
      render: () => createElement(ConnectS3SettingsPage, { client: () => ctx.privateCapability(STORAGE_PRIVATE_S3_CAPABILITY), epoch: () => coordinator.getSessionEpoch() }),
    });
    pages.view.register({ id: "storage.browse", kind: "page", path: "/settings/storage",
      label: { key: "storage.browse.business.label", fallback: "Local storage" },
      render: () => privateContents(StorageBrowsePage),
    });
    pages.view.register({ id: "storage.persistence", kind: "header", slot: "above-header", order: 0,
      label: { key: "storage.status.title", fallback: "Local storage" }, render: () => privateContents(IndexedDbPersistenceBar),
    });
    // 「设置」域由 Page 拥有，各产品把自己的设置页注册成它的 feature；存储浏览器
    // 同样如此。此前本插件自建 domain，侧边栏因此多出一个与「设置」并列的一级
    // 分组，而面包屑、本页注释与 docs/存储.md 说的都是「设置 → 存储」。
    //
    // 这里只改导航归属，不改权限：全钱包浏览能力仍只在本包的私有跨单元契约里
    // 声明，普通插件与 Connect App 照样拿不到。
    //
    // 注意 `entry.routeId` 指向上方注册的 page id（storage.browse），与这里的
    // feature id 是两套身份；feature id 用 settings.* 前缀与其它设置项保持一致。
    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
    business.registerFeature(ctx.pluginId, "settings", {
      id: "settings.connect-s3", label: { key: "storage.s3.title", fallback: "Storage" }, order: 61, icon: "HardDrive",
      entry: { path: "/settings/connect-storage", routeId: "storage.connect-s3", visibleWhen: ({ unlocked }) => unlocked },
    });
    business.registerFeature(ctx.pluginId, "settings", {
      id: "settings.storagebrowse",
      label: { key: "storage.browse.business.label", fallback: "Local storage" },
      order: 60,
      icon: "HardDrive",
      entry: {
        path: "/settings/storage",
        routeId: "storage.browse",
        visibleWhen: ({ unlocked }) => unlocked,
      },
    });
    ctx.scope.onRevoke(() => browse.dispose());

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

    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
    breadcrumbs.register({
      id: "storage.browse.crumbs",
      order: 6,
      match: (path) => path === "/settings/storage",
      resolve: () => [
        // 第一段与 /settings/plugins 保持一致：不可点击的“设置”分类节点，
        // 因此不产生一个指向已不存在的 /settings 聚合页的链接。
        { label: { key: "storage.browse.crumb.settings", fallback: "Settings" } },
        { label: { key: "storage.browse.crumb.browse", fallback: "Storage" } },
      ],
    });

    // scoped registry 会随 Storage 插件 scope 一起被精确回收；teardown 只负责
    // 释放页面侧的订阅、浏览句柄与控制器状态。关闭浏览会话是必须的：否则
    // Worker 里会留下一份活着的句柄和它持有的游标。
    return () => {
      browse.dispose();
      service.dispose();
    };
  },
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: storagePlatformSetup, ...storagePlatformPlugin } = storagePlatformPluginDefinition;

export { storagePlatformPlugin, storagePlatformSetup };
