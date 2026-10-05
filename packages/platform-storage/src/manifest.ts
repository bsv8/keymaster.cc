import { STORAGE_FILE_CLIENTS_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY } from "@keymaster/contracts";
import { COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY, COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY } from "@keymaster/contracts";
import { StorageActivityIndicator } from "./ui/StorageActivityIndicator.js";
import { APP_STORAGE_CLIENTS_CAPABILITY } from "@keymaster/contracts";
import { createAppStorageClients } from "./coordinator/appStorageClients.js";
import { STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY } from "@keymaster/contracts";
import { StorageUnavailableGuard } from "./ui/StorageUnavailableGuard.js";
import { createElement } from "react";
import { StoragePrivateProvider } from "./ui/StoragePrivateContext.js";
import { I18N_SERVICE_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY } from "@keymaster/contracts";
// Storage 平台插件 manifest（单钱包本地存储）。
//
// 相对旧实现，这里没有任何存储配置面：没有桶目录、没有 Provider 选择、
// 没有 endpoint/region/凭据表单、没有条件写能力探测、没有 multipart 上传。
// setup 负责：
//   1. 把 Worker 的存储控制 RPC 包成页面侧受限控制器并注册为 capability；
//   2. 把只读浏览 RPC 包成私有代理，由本实例的页面闭包持有；
//   3. 通过 page 注册浏览页、只读状态块与既有持久存储授权条；
//   4. 注册只读的 storage.status 资源。
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
import { StorageStatusBlock } from "./ui/StorageStatusBlock.js";
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
      "storage.status.title": "Local storage",
      "storage.status.medium": "Wallet data is kept in this browser only. It is not a backup and is not synced between devices.",
      "storage.status.uninitialized": "No wallet Key yet",
      "storage.status.locked": "Locked. Enter the Key password to unlock.",
      "storage.status.ready": "Ready",
      "storage.activity.title": "Storage activity", "storage.activity.read": "Reading", "storage.activity.write": "Writing",
      "storage.activity.reading": "Storage reading", "storage.activity.writing": "Storage writing",
      "storage.activity.readIdle": "Storage reads idle", "storage.activity.writeIdle": "Storage writes idle",
      "storage.status.corrupt": "Local wallet data is incomplete and cannot be read.",
      "storage.status.unsupported": "Local data was written by a newer version and cannot be read here.",
      "storage.status.degraded": "Local storage is temporarily unavailable.",
      "storage.status.persisted": "The browser granted persistent storage. This still is not a backup.",
      "storage.status.notPersisted": "The browser may clear this data. Export the encrypted KeyHold if you need to keep it.",
      "storage.status.usage": "Usage",
      "storage.browse.business.label": "Storage browser",
      "storage.browse.crumb.browse": "Storage",
      "storage.browse.crumb.settings": "Settings",
      "storage.browse.title": "Storage browser",
      "storage.browse.description": "Read-only view of the files this wallet stores in this browser.",
      "storage.browse.refresh": "Refresh",
      "storage.browse.showTree": "Files",
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
      "storage.browse.column.name": "Name",
      "storage.browse.column.size": "Size",
      "storage.browse.column.modified": "Modified",
      "storage.browse.crumbs.label": "Current path",
      "storage.browse.crumb.root": "/",
      "storage.browse.listing.label": "Directory contents",
      "storage.browse.detail.label": "File detail",
      "storage.browse.tree.label": "Storage tree",
      "storage.browse.tree.expand": "Expand {{name}}",
      "storage.browse.tree.collapse": "Collapse {{name}}",
      "storage.browse.tab.preview": "Preview",
      "storage.browse.tab.properties": "Properties",
      "storage.browse.noSelection": "Select a file to preview it.",
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
      "storage.browse.properties.directoryHint": "A directory is stored as a folder of objects; its own metadata is the marker below.",
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
      "storage.status.title": "本地存储",
      "storage.status.medium": "钱包数据只保存在当前浏览器中；这不是备份，也不会跨设备同步。",
      "storage.status.uninitialized": "还没有钱包 Key",
      "storage.status.locked": "已锁定，请输入 Key 密码解锁。",
      "storage.status.ready": "已就绪",
      "storage.activity.title": "存储活动", "storage.activity.read": "读取", "storage.activity.write": "写入",
      "storage.activity.reading": "正在读取存储", "storage.activity.writing": "正在写入存储",
      "storage.activity.readIdle": "存储读取空闲", "storage.activity.writeIdle": "存储写入空闲",
      "storage.status.corrupt": "本地钱包数据不完整，无法读取。",
      "storage.status.unsupported": "本地数据由更新版本写入，当前版本无法读取。",
      "storage.status.degraded": "本地存储暂时不可用。",
      "storage.status.persisted": "浏览器已授予持久存储权限；这仍然不是备份。",
      "storage.status.notPersisted": "浏览器可能清理这些数据；如需保留请导出加密 KeyHold。",
      "storage.status.usage": "已用容量",
      "storage.browse.business.label": "存储浏览器",
      "storage.browse.crumb.browse": "存储",
      "storage.browse.crumb.settings": "设置",
      "storage.browse.title": "存储浏览器",
      "storage.browse.description": "只读查看本钱包保存在当前浏览器中的文件。",
      "storage.browse.refresh": "刷新",
      "storage.browse.showTree": "文件树",
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
      "storage.browse.column.name": "名称",
      "storage.browse.column.size": "大小",
      "storage.browse.column.modified": "修改时间",
      "storage.browse.crumbs.label": "当前路径",
      "storage.browse.crumb.root": "/",
      "storage.browse.listing.label": "目录内容",
      "storage.browse.detail.label": "文件详情",
      "storage.browse.tree.label": "存储树",
      "storage.browse.tree.expand": "展开 {{name}}",
      "storage.browse.tree.collapse": "收起 {{name}}",
      "storage.browse.tab.preview": "预览",
      "storage.browse.tab.properties": "属性",
      "storage.browse.noSelection": "选择一个文件以预览。",
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
      "storage.browse.properties.directoryHint": "目录以一组对象保存；它自身的元数据就是下面的标记对象。",
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
    connect: { providerMethods: ["storage.list", "storage.directory.create", "storage.directory.delete", "storage.put", "storage.get", "storage.delete"] },
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
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, reason: "为 /settings/storage 提供面包屑" },
    ]),
  }, {
    id: "storage.coordinator-worker",
    runtime: "shared-worker" as const,
    scopeKind: "storage" as const,
    provides: [COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY, COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY, STORAGE_FILE_CLIENTS_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY],
    privateProvides: [STORAGE_PRIVATE_BROWSE_CAPABILITY],
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
    pages.view.register({ id: "storage.browse", kind: "page", path: "/settings/storage",
      label: { key: "storage.browse.business.label", fallback: "Storage browser" },
      render: () => privateContents(StorageBrowsePage),
    });
    pages.view.register({ id: "storage.status", kind: "settings-block", path: "/settings/storage", order: 910,
      label: { key: "storage.status.title", fallback: "Local storage" }, render: () => privateContents(StorageStatusBlock),
    });
    pages.view.register({ id: "storage.persistence", kind: "header", slot: "above-header", order: 0,
      label: { key: "storage.status.title", fallback: "Local storage" }, render: () => privateContents(IndexedDbPersistenceBar),
    });
    pages.view.register({ id: "storage.activity", kind: "header", slot: "topbar", order: 5,
      label: "Storage activity", render: () => privateContents(StorageActivityIndicator),
    });
    ctx.capability(BUSINESS_REGISTRY_CAPABILITY).register(ctx.pluginId, {
      id: "storage",
      label: { key: "storage.browse.business.label", fallback: "Storage browser" },
      order: 910,
      features: [{
        id: "storage.browse",
        label: { key: "storage.browse.business.label", fallback: "Storage browser" },
        order: 10,
        icon: "HardDrive",
        entry: {
          path: "/settings/storage",
          routeId: "storage.browse",
          visibleWhen: ({ unlocked }) => unlocked,
        },
      }],
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
