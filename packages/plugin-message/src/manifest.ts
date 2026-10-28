import { setupMessageUriActions } from "./setupUriActions.js";
import { URI_ACTION_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { STORAGE_FILE_CLIENTS_CAPABILITY } from "@keymaster/contracts";
import { createElement } from "react";
import { bindMessageUi } from "./MessageResourceContext.js";
import { MessagePage } from "./MessagePage.js";
import { MessageDetailPage } from "./MessageDetailPage.js";
import { I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
// packages/plugin-message/src/manifest.ts
// 消息业务插件 manifest（施工单 2026-09-02/003）。
//
// 设计缘由：
//   - `plugin-message` 是一个**极薄业务插件**，appId = `keymaster.message`，
//     **不**感知 owner / provider / 任何物理传输细节；
//   - 消息服务通过 Coordinator Channel runtime 发送固定私密消息协议；
//   - 历史只使用本地 key-scoped K-V，收件回执是独立私密消息；
//   - 在自己的 `setup` 阶段：
//       * 从 Coordinator 注入 `ChannelRuntime`；
//       * 把本地 K-V 与 runtime 交给 `createMessageService(...)` 作为公开
//         `message.service` capability。
//   - 页面路由固定归本插件：
//       * `/messages`                —— 会话列表
//       * `/message/:publicKeyHex`    —— 会话详情（主承载路由）
//     **不**注册传输系统管理页或远端消息管理页。

import type {
  I18nPluginResources,
  MessageRecord,
  PluginContext,
  PluginManifest,
  PluginSetup,
} from "@keymaster/contracts";
import {
  BREADCRUMB_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  CHANNEL_RUNTIME_CAPABILITY,
  VAULT_WALLET_STATE_CAPABILITY,
  MESSAGE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  PAGE_UI_REGISTRY_CAPABILITY,
  OWNED_RESOURCE_ACCESS_CAPABILITY,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import { createMessageService } from "./messageService.js";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";

/** 消息会话聚合结果（Resource Store 数据模型） */
export interface MessageConversationsData {
  messages: MessageRecord[];
}

/** 消息详情页数据（Resource Store 数据模型） */
export interface MessageDetailData {
  messages: MessageRecord[];
}

function messagesEqual(previous: readonly MessageRecord[], next: readonly MessageRecord[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((message, index) => {
    const candidate = next[index];
    return candidate !== undefined
      && message.messageId === candidate.messageId
      && message.senderPublicKeyHex === candidate.senderPublicKeyHex
      && message.recipientPublicKeyHex === candidate.recipientPublicKeyHex
      && message.body === candidate.body
      && message.insertedAtMs === candidate.insertedAtMs;
  });
}
/** 插件 id（与 keymaster.message 不一致；plugin manifest 仍唯一）。 */
export const MESSAGE_PLUGIN_ID = "message";

const messageResources: I18nPluginResources = {
  namespace: "message",
  resources: {
    en: {
      "message.action.openConversation": "Open conversation",
      "message.menu": "Messages",
      "message.breadcrumb": "Messages",
      "message.breadcrumb.detail": "Detail",
      "message.page.title": "Messages",
      "message.page.desc": "Conversation list grouped by peer publicKeyHex.",
      "message.page.empty": "No local conversations yet.",
      "message.page.empty.desc": "Open a conversation detail page to send a message and start a thread.",
      "message.page.noOwner.title": "Pick a key",
      "message.page.noOwner.desc": "Switch to an active key to view conversations.",
      "message.page.newChat.open": "Start a new chat",
      "message.page.newChat.title": "Start a new chat",
      "message.page.newChat.label": "publicKeyHex",
      "message.page.newChat.placeholder": "66 hex characters",
      "message.page.newChat.submit": "Go to chat",
      "message.page.newChat.cancel": "Cancel",
      "message.page.newChat.error.invalid": "Invalid publicKeyHex. Expected 66 hex characters.",
      "message.page.conversation.count": "{{count}} messages",
      "message.page.detail.title": "Conversation",
      "message.page.detail.body": "Body",
      "message.page.detail.empty": "No messages in this conversation.",
      "message.page.detail.empty.desc": "Send a message below to start the thread.",
      "message.page.detail.noConversation": "Conversation not found.",
      "message.page.detail.from.me": "Me",
      "message.page.detail.loadMore": "Load 20 older messages",
      "message.page.noClient": "Channel messaging service is not available.",
      "message.page.back": "Back",
      "message.page.send.submit": "Send",
      "message.page.send.sending": "Sending…",
      "message.page.send.empty": "Body is empty",
      "message.page.detail.error.service_not_ready": "Messaging service is not ready. Please try again.",
      "message.page.detail.error.invalid_target": "Target publicKeyHex is invalid.",
      "message.page.detail.error.send_timeout": "Sending timed out. Check the connection and try again.",
      "message.page.detail.error.signature_failed": "Message signing failed. Reconnect the active key and try again.",
      "message.page.detail.error.duplicate_message": "This message conflicts with an earlier send. Please send it again.",
      "message.page.detail.error.seal_failed": "Message encryption failed. Reconnect the active key and try again.",
      "message.page.detail.error.server_unavailable": "The messaging server is temporarily unavailable.",
      "message.page.detail.error.send_rejected": "The messaging server rejected this message.",
      "message.page.detail.error.send_unknown": "Message sending failed. Check the Channel service and try again.",
      "message.page.detail.error.unknown": "Operation failed.",
      "message.page.detail.rawMissing": "Original message data is missing."
    },
    "zh-CN": {
      "message.action.openConversation": "打开会话",
      "message.menu": "消息",
      "message.breadcrumb": "消息",
      "message.breadcrumb.detail": "详情",
      "message.page.title": "消息",
      "message.page.desc": "按对端 publicKeyHex 聚合的会话列表。",
      "message.page.empty": "本地暂无会话。",
      "message.page.empty.desc": "进入会话详情页即可发送消息并开始线程。",
      "message.page.noOwner.title": "请选择一个 key",
      "message.page.noOwner.desc": "切换到 active key 后即可查看会话。",
      "message.page.newChat.open": "新建聊天",
      "message.page.newChat.title": "新建聊天",
      "message.page.newChat.label": "publicKeyHex",
      "message.page.newChat.placeholder": "66 位 hex",
      "message.page.newChat.submit": "去聊天",
      "message.page.newChat.cancel": "取消",
      "message.page.newChat.error.invalid": "publicKeyHex 非法，必须是 66 位 hex。",
      "message.page.conversation.count": "{{count}} 条消息",
      "message.page.detail.title": "会话",
      "message.page.detail.body": "正文",
      "message.page.detail.empty": "当前会话暂无消息。",
      "message.page.detail.empty.desc": "在下方发送一条消息即可开始线程。",
      "message.page.detail.noConversation": "会话未找到。",
      "message.page.detail.from.me": "我",
      "message.page.detail.loadMore": "再加载 20 条更早消息",
      "message.page.noClient": "Channel 消息服务不可用。",
      "message.page.back": "返回",
      "message.page.send.submit": "发送",
      "message.page.send.sending": "发送中…",
      "message.page.send.empty": "正文不能为空",
      "message.page.detail.error.service_not_ready": "消息服务未就绪，请稍后重试。",
      "message.page.detail.error.invalid_target": "目标 publicKeyHex 非法。",
      "message.page.detail.error.send_timeout": "发送超时，请检查网络后重试。",
      "message.page.detail.error.signature_failed": "消息签名失败，请重新连接当前密钥后重试。",
      "message.page.detail.error.duplicate_message": "本条消息与先前发送记录冲突，请重新发送。",
      "message.page.detail.error.seal_failed": "消息加密失败，请重新连接当前密钥后重试。",
      "message.page.detail.error.server_unavailable": "消息服务器暂时不可用，请稍后重试。",
      "message.page.detail.error.send_rejected": "消息服务器拒绝了本条消息。",
      "message.page.detail.error.send_unknown": "消息发送失败，请检查 Channel 服务后重试。",
      "message.page.detail.error.unknown": "操作失败。",
      "message.page.detail.rawMissing": "原始消息数据缺失。"
    }
  }
};

/**
 * 消息业务插件 manifest。
 */
const messagePlatformPluginDefinition = {
  id: MESSAGE_PLUGIN_ID,
  name: "Messages",
  description: "keymaster.message business page: send / list / view scoped messages.",

  units: [{
    id: "message.window",
    runtime: "window-main",
    scopeKind: "owner-session",
    provides: [MESSAGE_SERVICE_CAPABILITY],
    storages: [CENTRAL_STORAGE_DECLARATIONS.messagesFiles],
    dependencies: defineRuntimeUnitDependencies([
      { capability: STORAGE_FILE_CLIENTS_CAPABILITY, sourceRuntime: "window-main", reason: "声明存储客户端及用途授权" },
      { capability: OWNED_RESOURCE_ACCESS_CAPABILITY, reason: "UI 读取本实例消息及服务投影资源" },
      { capability: RESOURCE_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
      { capability: I18N_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
      { capability: CHANNEL_RUNTIME_CAPABILITY, reason: "通过 Coordinator 使用 Channel" },
      { capability: VAULT_WALLET_STATE_CAPABILITY, reason: "读取 active key 并跟随会话聚合刷新" },
      { capability: PAGE_UI_REGISTRY_CAPABILITY, reason: "注册 /message 与 /messages 详情路由" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, reason: "接入首页业务导航" },
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, reason: "为 /message 与 /messages 详情路由提供面包屑" },
      { capability: URI_ACTION_REGISTRY_CAPABILITY, optional: true, reason: "注册公钥 URI 消息入口" },
    ]),
  }],
  i18n: messageResources,
  setup(ctx) {
    const channel = ctx.capability(CHANNEL_RUNTIME_CAPABILITY).forPlugin(MESSAGE_PLUGIN_ID);
    const walletState = ctx.capability(VAULT_WALLET_STATE_CAPABILITY).bind(ctx.consumer, ctx.scope);
    const service = createMessageService({ channel, walletState, files: ctx.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, "") });
    ctx.provide(MESSAGE_SERVICE_CAPABILITY, service);
    setupMessageUriActions(ctx);

    // 注册资源定义（硬切换 003）
    const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);

    // message.conversations：消息列表（MessagePage 用，按对端公钥展示）
    resources.register<MessageConversationsData, readonly string[]>({
      id: "message.conversations",
      scope: "active-key",
      key: (_args, context) => ["message.conversations", context.activePublicKeyHex ?? "none"],
      load: async () => {
        const messages = await service.listConversationMessages();
        return { messages };
      },
      subscribe: (_args, _context, invalidate) => service.subscribeChanges(invalidate),
      equals: (prev, next) => {
        if (!prev || !next) return prev === next;
        return messagesEqual(prev.messages, next.messages);
      },
      invalidation: "microtask"
    });

    // message.detail：消息详情页数据
    resources.register<MessageDetailData, readonly string[]>({
      id: "message.detail",
      scope: "active-key",
      key: (args, context) => ["message.detail", context.activePublicKeyHex ?? "none", args[0] ?? "none"],
      load: async (args) => {
        const peerHex = args[0];
        const messages = await service.listMessages({ peerPublicKeyHex: peerHex, limit: 10_000 });
        return { messages };
      },
      subscribe: (_args, _context, invalidate) => service.subscribeChanges(invalidate),
      equals: (prev, next) => {
        if (!prev || !next) return prev === next;
        return messagesEqual(prev.messages, next.messages);
      },
      invalidation: "microtask"
    });
    const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope);
    const List = bindMessageUi(ctx, MessagePage);
    const Detail = bindMessageUi(ctx, MessageDetailPage);
    pages.view.register({ kind: "page", id: "message.page", path: "/messages",
      label: { key: "message.page.title", fallback: "Messages" }, render: () => createElement(List) });
    pages.view.register({ kind: "page", id: "message.detail", path: "/message/:publicKeyHex",
      label: { key: "message.page.detail.title", fallback: "Conversation" }, render: location => createElement(Detail, { location }) });
    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
    business.registerFeature(MESSAGE_PLUGIN_ID, "home", {
      id: "home.messages",
      label: { key: "message.menu", fallback: "Messages" },
      order: 70,
      icon: "Mail",
      entry: {
        path: "/messages",
        routeId: "message.page",
        activeWhen: (path) => path.startsWith("/message/") || path.startsWith("/messages/")
      }
    });
    breadcrumbs.register({
      id: "message.page.crumbs",
      order: 4,
      match: (path) =>
        path === "/messages" ||
        /^\/message\/[^/]+\/?$/.test(path) ||
        /^\/messages\/[^/]+\/?$/.test(path),
      resolve: () => [
        { label: { key: "message.breadcrumb", fallback: "Messages" } }
      ]
    });

    return () => {
      service.dispose?.();
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: messageSetup, ...messagePlatformPlugin } = messagePlatformPluginDefinition;
export { messageSetup, messagePlatformPlugin };
