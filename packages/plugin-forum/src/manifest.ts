import { WINDOW_P2P_WORKER_BRIDGE_CAPABILITY } from "@keymaster/contracts/window-p2p";
import {
  BREADCRUMB_REGISTRY_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, CENTRAL_STORAGE_DECLARATIONS,
  FORUM_SERVICE_CAPABILITY, FORUM_WORKER_NETWORK_CAPABILITY, FORUM_WORKER_SERVICE_CAPABILITY, FORUM_WORKER_ATTACHMENT_CAPABILITY,
  I18N_SERVICE_CAPABILITY, MSFILE_CONTENT_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY,
  P2PKH_WORKER_PROTOCOL_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY,
  STORAGE_FILE_CLIENTS_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, VAULT_WORKER_CRYPTO_CAPABILITY,
  WINDOW_P2P_EXECUTOR_CAPABILITY, WOC_CAPABILITY, capabilityDescriptor, defineRuntimeUnitDependencies,
  type PluginContext, type PluginManifest, type PluginSetup,
} from "@keymaster/contracts";
import { createElement, type ReactNode } from "react";

import { createForumServiceProxy } from "./forumServiceProxy.js";
import { ForumP2pLane } from "./network/forumP2pLane.js";
import { forumResources } from "./resources.js";
import { ForumResourceProvider, type ForumUiContextValue } from "./ForumResourceContext.js";
import { ForumBoardPage, ForumHomePage, ForumPostPage, ForumPostsPage, ForumPublishPage } from "./pages.js";

export const FORUM_PLUGIN_ID = "forum";

/** Forum 仓储的存储 purpose；空串表示 `forum/` 模块根，与中央声明一致。 */

const forumPluginDefinition = {
  id: FORUM_PLUGIN_ID,
  name: "Forum",
  description: "RivetForum 客户端：索引浏览、MSFile 正文阅读与符合协议的签名发布。",
  units: [
    {
      id: "forum.window",
      runtime: "window-main",
      scopeKind: "owner-session",
      provides: [capabilityDescriptor(FORUM_SERVICE_CAPABILITY)],
      dependencies: defineRuntimeUnitDependencies([
        { capability: FORUM_WORKER_ATTACHMENT_CAPABILITY, sourceRuntime: "shared-worker", reason: "已验证附件分块交付给 Window 展示" },
        { capability: FORUM_WORKER_SERVICE_CAPABILITY, sourceRuntime: "shared-worker", reason: "唯一 owner-session Forum 任务与发布权威；不可用时阻止发布" },
        { capability: WINDOW_P2P_EXECUTOR_CAPABILITY, sourceRuntime: "window-main", reason: "注册 Forum lane，共用唯一网络 Host" },
        { capability: RESOURCE_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册论坛资源投影" },
        { capability: OWNED_RESOURCE_ACCESS_CAPABILITY, reason: "UI 读取所属实例资源" },
        { capability: PAGE_UI_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册论坛页面" },
        { capability: BREADCRUMB_REGISTRY_CAPABILITY, reason: "论坛页面包屑" },
        { capability: BUSINESS_REGISTRY_CAPABILITY, reason: "首页业务导航入口" },
        { capability: I18N_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "界面文案" },
      ]),
    },
    {
      id: "forum.coordinator-worker",
      runtime: "shared-worker",
      scopeKind: "owner-session",
      storage: CENTRAL_STORAGE_DECLARATIONS.forumFiles,
      provides: [capabilityDescriptor(FORUM_WORKER_NETWORK_CAPABILITY), capabilityDescriptor(FORUM_WORKER_SERVICE_CAPABILITY), capabilityDescriptor(FORUM_WORKER_ATTACHMENT_CAPABILITY)],
      dependencies: defineRuntimeUnitDependencies([
        { capability: STORAGE_FILE_CLIENTS_CAPABILITY, sourceRuntime: "shared-worker", reason: "Forum 配置、缓存与发布任务的唯一仓储" },
      { capability: WINDOW_P2P_WORKER_BRIDGE_CAPABILITY, sourceRuntime: "shared-worker", reason: "由公共 Window executor 提供受限网络 lane" },
        { capability: VAULT_WALLET_STATE_CAPABILITY, sourceRuntime: "shared-worker", reason: "owner-session 身份与世代" },
        { capability: VAULT_WORKER_CRYPTO_CAPABILITY, sourceRuntime: "shared-worker", reason: "Worker 内规范业务签名" },
        { capability: MSFILE_CONTENT_CAPABILITY, sourceRuntime: "shared-worker", reason: "正文附件统一由 MSFile 获取与保存" },
        { capability: P2PKH_WORKER_PROTOCOL_CAPABILITY, sourceRuntime: "shared-worker", reason: "钱包权威的协议资金、签名、广播与同提交观测" },
        { capability: WOC_CAPABILITY, sourceRuntime: "shared-worker", reason: "根 raw 和链上观测" },
      ], "shared-worker"),
    },
  ],
  i18n: forumResources,
} satisfies PluginManifest;

export const forumPlugin = forumPluginDefinition;

/** 装配：注册 lane、提供 Forum 服务与页面；teardown 释放全部资源。 */
const setup: PluginSetup = (ctx: PluginContext) => {
  const lane = new ForumP2pLane();
  ctx.capability(WINDOW_P2P_EXECUTOR_CAPABILITY).register(lane);
  const service = createForumServiceProxy(ctx.capability(FORUM_WORKER_SERVICE_CAPABILITY), ctx.capability(FORUM_WORKER_ATTACHMENT_CAPABILITY));
  ctx.provide(FORUM_SERVICE_CAPABILITY, service);
  registerForumPages(ctx);
  // Registrations belong to ctx.scope and are removed by the framework on revoke.
  // Calling revoked registry proxies during teardown would fail cleanup.

};

/**
 * 注册论坛页面。
 *
 * 路由字面量写在 setup 里，因此页面注册与静态路由盘点读到的是同一份字符串。
 * 每个页面都包在 `ForumResourceProvider` 里，资源与订阅因此绑定该页面 Scope：
 * 退出或身份失效时随之释放。
 */
function registerForumPages(ctx: PluginContext): void {
  // UI 使用当前 Scope 下的服务实例，而不是装配时闭包里的那一份。
  const scoped = ctx.capability(FORUM_SERVICE_CAPABILITY);
  const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view;
  const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
  const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);

  /** 页面外壳：把 Scope 绑定的服务注入组件树。 */
  function shell(render: (params: Readonly<Record<string, string>>) => ReactNode) {
    return function BoundForumPage(location: { readonly params: Readonly<Record<string, string>> }): ReactNode {
      const value: ForumUiContextValue = { forum: scoped };
      return createElement(ForumResourceProvider, { value, children: render(location.params) });
    };
  }

  // 逐个注册；注销按 id 反序进行，先注销依赖面更窄的页面。
  pages.register({
    kind: "page", id: "forum.home", path: "/forum", order: 700,
    label: { key: "forum.page.title", fallback: "Forum" },
    render: shell(() => createElement(ForumHomePage)),
  });
  pages.register({
    kind: "page", id: "forum.boards", path: "/forum/:configId", order: 701,
    label: { key: "forum.list.boards", fallback: "Boards" },
    render: shell((params) =>
      params.configId === undefined ? createElement(ForumHomePage) : createElement(ForumBoardPage, { configId: params.configId })),
  });
  pages.register({
    kind: "page", id: "forum.posts", path: "/forum/:configId/board/:boardTxid", order: 702,
    label: { key: "forum.list.posts", fallback: "Posts" },
    render: shell((params) =>
      params.configId === undefined || params.boardTxid === undefined
        ? createElement(ForumHomePage)
        : createElement(ForumPostsPage, { configId: params.configId, boardTxid: params.boardTxid })),
  });
  pages.register({
    kind: "page", id: "forum.post", path: "/forum/:configId/post/:txid", order: 703,
    label: { key: "forum.list.replies", fallback: "Replies" },
    render: shell((params) =>
      params.configId === undefined || params.txid === undefined
        ? createElement(ForumHomePage)
        : createElement(ForumPostPage, { configId: params.configId, txid: params.txid })),
  });
  pages.register({
    kind: "page", id: "forum.publish", path: "/forum/:configId/publish/:txid", order: 704,
    label: { key: "forum.reply.title", fallback: "Reply" },
    render: shell((params) =>
      params.configId === undefined || params.txid === undefined
        ? createElement(ForumHomePage)
        : createElement(ForumPublishPage, { configId: params.configId, targetTxid: params.txid })),
  });

  breadcrumbs.register({
    id: "forum.crumbs",
    order: 700,
    match: (path) => path.startsWith("/forum"),
    resolve: () => [{ label: { key: "forum.page.title", fallback: "Forum" } }],
  });
  business.registerFeature("forum", "home", {
    id: "forum.home",
    label: { key: "forum.page.title", fallback: "Forum" },
    order: 700,
    entry: { path: "/forum", routeId: "forum.home", visibleWhen: ({ unlocked }: { unlocked: boolean }) => unlocked },
  });

}

export const forumSetup = setup;
