import { STORAGE_FILE_CLIENTS_CAPABILITY } from "@keymaster/contracts";
import { COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY } from "@keymaster/contracts";
import { STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY } from "@keymaster/contracts";
import { StorageUnavailableGuard } from "./ui/StorageUnavailableGuard.js";
import { createElement } from "react";
import { StoragePrivateProvider } from "./ui/StoragePrivateContext.js";
import { I18N_SERVICE_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY } from "@keymaster/contracts";
// Storage 提供钱包内部本地存储和只读浏览。
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
  description: "本 Origin 的单钱包本地存储与只读浏览。",

  units: [{
    id: STORAGE_BROWSE_UNIT_ID,
    runtime: "window-main" as const,
    scopeKind: "storage" as const,
    provides: [
      capabilityDescriptor(STORAGE_RUNTIME_CONTROLLER_CAPABILITY),
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
    provides: [COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY, STORAGE_FILE_CLIENTS_CAPABILITY],
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
    // 页面闭包只捕获本实例的私有服务；注册数据不携带服务对象。
    const privateContents = (Component: import("react").ComponentType) => createElement(StoragePrivateProvider, {
      service: browse, controller: service, children: createElement(Component),
    });
    const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope);
    pages.view.register({ kind: "frame", slot: "storage-guard", id: "storage.guard", label: "Storage",
      render: location => createElement(StorageUnavailableGuard, { children: location.children }) });
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
