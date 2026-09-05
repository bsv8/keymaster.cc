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
//       * `/messages/:publicKeyHex`   —— 会话详情别名，兼容旧口头路径
//     **不**注册传输系统管理页或远端消息管理页。

import type {
  BusinessFeatureRegistry,
  Contact,
  ContactPublicKeyActionRegistry,
  ContactsService,
  ChannelRuntimeFactory,
  I18nPluginResources,
  KeyspaceService,
  MessageRecord,
  PluginContext,
  PluginManifest,
  ResourceRegistry,
  RouteRegistry
} from "@keymaster/contracts";
import { router } from "@keymaster/runtime";
import {
  CHANNEL_RUNTIME_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
} from "@keymaster/contracts";
import { MessagePage } from "./MessagePage.js";
import { MessageDetailPage } from "./MessageDetailPage.js";
import { createMessageService } from "./messageService.js";

/** 消息会话聚合结果（Resource Store 数据模型） */
export interface MessageConversationsData {
  messages: MessageRecord[];
  contactsByPeer: Record<string, Contact>;
}

/** 消息详情页数据（Resource Store 数据模型） */
export interface MessageDetailData {
  messages: MessageRecord[];
  contact: Contact | null;
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

function contactsEqual(previous: Contact | null | undefined, next: Contact | null | undefined): boolean {
  if (!previous || !next) return previous === next;
  return previous.id === next.id
    && previous.publicKeyHex === next.publicKeyHex
    && previous.name === next.name
    && previous.updatedAt === next.updatedAt;
}

function contactsByPeerEqual(
  previous: Record<string, Contact>,
  next: Record<string, Contact>
): boolean {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every((key) => contactsEqual(previous[key], next[key]));
}

/** 插件 id（与 keymaster.message 不一致；plugin manifest 仍唯一）。 */
export const MESSAGE_PLUGIN_ID = "message";

const messageResources: I18nPluginResources = {
  namespace: "message",
  resources: {
    en: {
      "message.action.toContact": "Message",
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
      "message.page.conversation.addContact": "Add contact",
      "message.page.conversation.editContact": "Edit contact",
      "message.page.detail.title": "Conversation",
      "message.page.detail.body": "Body",
      "message.page.detail.empty": "No messages in this conversation.",
      "message.page.detail.empty.desc": "Send a message below to start the thread.",
      "message.page.detail.noConversation": "Conversation not found.",
      "message.page.detail.call.title.video": "Video call",
      "message.page.detail.call.title.audio": "Audio call",
      "message.page.detail.call.peer": "Peer",
      "message.page.detail.call.local": "Local",
      "message.page.detail.call.remote": "Remote",
      "message.page.detail.call.direction.incoming": "Incoming",
      "message.page.detail.call.direction.outgoing": "Outgoing",
      "message.page.detail.call.phase": "Phase",
      "message.page.detail.call.mode": "Mode",
      "message.page.detail.call.mode.audio": "Audio",
      "message.page.detail.call.mode.video": "Video",
      "message.page.detail.call.swap": "Swap",
      "message.page.detail.call.fullscreen": "Fullscreen",
      "message.page.detail.call.exitFullscreen": "Exit fullscreen",
      "message.page.detail.call.accept": "Accept",
      "message.page.detail.call.reject": "Decline",
      "message.page.detail.call.hangup": "Hang up",
      "message.page.detail.call.waitingRemote": "Waiting for remote video",
      "message.page.detail.call.waitingLocal": "Waiting for local video",
      "message.page.detail.call.phase.idle": "idle",
      "message.page.detail.call.phase.inviting": "calling",
      "message.page.detail.call.phase.incoming": "incoming",
      "message.page.detail.call.phase.connecting": "connecting",
      "message.page.detail.call.phase.connected": "connected",
      "message.page.detail.call.phase.ended": "ended",
      "message.page.detail.from.me": "Me",
      "message.page.detail.timeline.call.audio": "Audio",
      "message.page.detail.timeline.call.video": "Video",
      "message.page.detail.timeline.call.outgoing": "Outgoing",
      "message.page.detail.timeline.call.incoming": "Incoming",
      "message.page.detail.timeline.call.label": "call",
      "message.page.detail.timeline.call.status.completed": "completed",
      "message.page.detail.timeline.call.status.missed": "missed",
      "message.page.detail.timeline.call.status.rejected": "rejected",
      "message.page.detail.timeline.call.status.failed": "failed",
      "message.page.detail.timeline.call.status.unknown": "unknown status",
      "message.page.detail.timeline.attachment.image": "Image",
      "message.page.detail.timeline.attachment.file": "File",
      "message.page.detail.timeline.previewUnavailable": "Preview unavailable",
      "message.page.detail.timeline.download": "Download",
      "message.page.detail.video": "Video chat",
      "message.page.detail.audio": "Audio chat",
      "message.page.detail.image": "Send image",
      "message.page.detail.file": "Send file",
      "message.page.detail.online": "Online",
      "message.page.detail.offline": "Offline",
      "message.page.detail.unknown": "Unknown",
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
      "message.page.detail.error.device_unavailable": "Local device is unavailable.",
      "message.page.detail.error.send_invite_failed": "Failed to send call invite.",
      "message.page.detail.error.create_offer_failed": "Failed to create offer.",
      "message.page.detail.error.invalid_state": "Invalid session state.",
      "message.page.detail.error.transfer_too_large": "Attachment is larger than 16 MiB.",
      "message.page.detail.error.busy_local": "There is already an active session.",
      "message.page.detail.error.transfer_protocol_unavailable": "Attachment transfer is unavailable.",
      "message.page.detail.error.transfer_timeout": "Attachment transfer timed out.",
      "message.page.detail.error.transfer_connection_failed": "Attachment transfer connection failed.",
      "message.page.detail.error.transfer_invite_failed": "Failed to start attachment transfer.",
      "message.page.detail.error.local_blob_unavailable": "Attachment blob is unavailable.",
      "message.page.detail.error.transfer_reject": "Attachment transfer was rejected.",
      "message.page.detail.error.unknown": "Operation failed."
    },
    "zh-CN": {
      "message.action.toContact": "发消息",
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
      "message.page.conversation.addContact": "新增联系人",
      "message.page.conversation.editContact": "编辑联系人",
      "message.page.detail.title": "会话",
      "message.page.detail.body": "正文",
      "message.page.detail.empty": "当前会话暂无消息。",
      "message.page.detail.empty.desc": "在下方发送一条消息即可开始线程。",
      "message.page.detail.noConversation": "会话未找到。",
      "message.page.detail.call.title.video": "视频通话",
      "message.page.detail.call.title.audio": "音频通话",
      "message.page.detail.call.peer": "对端",
      "message.page.detail.call.local": "本地",
      "message.page.detail.call.remote": "远端",
      "message.page.detail.call.direction.incoming": "来电",
      "message.page.detail.call.direction.outgoing": "呼出",
      "message.page.detail.call.phase": "阶段",
      "message.page.detail.call.mode": "模式",
      "message.page.detail.call.mode.audio": "音频",
      "message.page.detail.call.mode.video": "视频",
      "message.page.detail.call.swap": "交换视频",
      "message.page.detail.call.fullscreen": "全屏",
      "message.page.detail.call.exitFullscreen": "退出全屏",
      "message.page.detail.call.accept": "接听",
      "message.page.detail.call.reject": "拒接",
      "message.page.detail.call.hangup": "挂断",
      "message.page.detail.call.waitingRemote": "等待对方画面",
      "message.page.detail.call.waitingLocal": "等待本地画面",
      "message.page.detail.call.phase.idle": "空闲",
      "message.page.detail.call.phase.inviting": "呼叫中",
      "message.page.detail.call.phase.incoming": "来电",
      "message.page.detail.call.phase.connecting": "连接中",
      "message.page.detail.call.phase.connected": "已接通",
      "message.page.detail.call.phase.ended": "已结束",
      "message.page.detail.from.me": "我",
      "message.page.detail.timeline.call.audio": "音频",
      "message.page.detail.timeline.call.video": "视频",
      "message.page.detail.timeline.call.outgoing": "呼出",
      "message.page.detail.timeline.call.incoming": "来电",
      "message.page.detail.timeline.call.label": "通话",
      "message.page.detail.timeline.call.status.completed": "已完成",
      "message.page.detail.timeline.call.status.missed": "未接",
      "message.page.detail.timeline.call.status.rejected": "已拒绝",
      "message.page.detail.timeline.call.status.failed": "失败",
      "message.page.detail.timeline.call.status.unknown": "状态未知",
      "message.page.detail.timeline.attachment.image": "图片",
      "message.page.detail.timeline.attachment.file": "文件",
      "message.page.detail.timeline.previewUnavailable": "无法预览",
      "message.page.detail.timeline.download": "下载",
      "message.page.detail.video": "视频联系",
      "message.page.detail.audio": "音频联系",
      "message.page.detail.image": "发送图片",
      "message.page.detail.file": "发送文件",
      "message.page.detail.online": "在线",
      "message.page.detail.offline": "失联",
      "message.page.detail.unknown": "状态未知",
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
      "message.page.detail.error.device_unavailable": "本地设备不可用。",
      "message.page.detail.error.send_invite_failed": "发送通话邀请失败。",
      "message.page.detail.error.create_offer_failed": "创建 offer 失败。",
      "message.page.detail.error.invalid_state": "会话状态非法。",
      "message.page.detail.error.transfer_too_large": "附件超过 16 MiB。",
      "message.page.detail.error.busy_local": "当前已有活动会话。",
      "message.page.detail.error.transfer_protocol_unavailable": "附件传输不可用。",
      "message.page.detail.error.transfer_timeout": "附件传输超时。",
      "message.page.detail.error.transfer_connection_failed": "附件传输连接失败。",
      "message.page.detail.error.transfer_invite_failed": "启动附件传输失败。",
      "message.page.detail.error.local_blob_unavailable": "附件内容不可用。",
      "message.page.detail.error.transfer_reject": "附件传输已被拒绝。",
      "message.page.detail.error.unknown": "操作失败。"
    }
  }
};

/**
 * 消息业务插件 manifest。
 */
export const messagePlatformPlugin: PluginManifest = {
  id: MESSAGE_PLUGIN_ID,
  name: "Messages",
  description: "keymaster.message business page: send / list / view scoped messages.",
  meta: {
    kind: "core",
    startup: "optional",
    bootstrapStage: "owner-apps-ready",
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: ["message.service"],
    displayGroup: "platform"
  },
  i18n: messageResources,
  storage: { scope: "key", applicationStorageId: "Messages", schemaVersion: 1 },
  dependencies: [
    { capability: CHANNEL_RUNTIME_CAPABILITY, reason: "通过 Coordinator 使用 Channel" },
    { capability: "keyspace.service", reason: "读取 active key 并跟随会话聚合刷新" },
    { capability: "webrtc.service", reason: "读取 WebRTC 历史并发起音视频 / 传输动作" },
    { capability: "route.registry", reason: "注册 /message 与 /messages 详情路由" },
    { capability: "business.registry", reason: "接入首页业务导航" },
    {
      capability: "breadcrumb.registry",
      reason: "为 /message 与 /messages 详情路由提供面包屑"
    },
    { capability: "contacts.public-key-action.registry", reason: "注册联系人发消息操作" }
  ],
  setup(ctx) {
    const contactActions = ctx.get<ContactPublicKeyActionRegistry>("contacts.public-key-action.registry");
    contactActions.register({
      id: "message.to-contact",
      label: { key: "message.action.toContact", fallback: "发消息" },
      icon: "MessageCircle",
      order: 20,
      run: ({ publicKeyHex }) => router.push(`/message/${encodeURIComponent(publicKeyHex)}`)
    });
    const channel = ctx.get<ChannelRuntimeFactory>(CHANNEL_RUNTIME_CAPABILITY).forPlugin(MESSAGE_PLUGIN_ID);
    const service = createMessageService({ channel, keyspace: ctx.get<KeyspaceService>("keyspace.service"), storage: ctx.storage });
    ctx.provide("message.service", service);

    // 注册资源定义（硬切换 003）
    const resources = ctx.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY);
    const keyspace = ctx.get<KeyspaceService>("keyspace.service");

    // message.conversations：消息列表 + 联系人（MessagePage 用）
    resources.register<MessageConversationsData, readonly string[]>({
      id: "message.conversations",
      scope: "active-key",
      key: (_args, context) => ["message.conversations", context.activePublicKeyHex ?? "none"],
      load: async (_args, context, _signal) => {
        const messages = await service.listMessages({ limit: 10_000 });
        // contacts 是可选插件，可能晚于 message 完成 setup；不能在 setup
        // 阶段把缺失状态永久缓存为 null，必须在每次资源加载时动态解析。
        const contacts = context.getCapability<ContactsService>("contacts.service");
        // 从消息中提取 peer publicKeyHex 列表
        const ownerHex = keyspace.active().activePublicKeyHex?.trim().toLowerCase();
        const peerSet = new Set<string>();
        for (const msg of messages) {
          const senderHex = msg.senderPublicKeyHex.trim().toLowerCase();
          const peer = senderHex === ownerHex
            ? msg.recipientPublicKeyHex
            : msg.senderPublicKeyHex;
          const normalizedPeer = peer?.trim().toLowerCase();
          if (normalizedPeer) peerSet.add(normalizedPeer);
        }
        const peerList = Array.from(peerSet);
        // 查找联系人
        let contactsByPeer: Record<string, Contact> = {};
        if (contacts && peerList.length > 0) {
          try {
            const found = await contacts.findByPublicKeyHexes(peerList);
            for (const c of found) {
              contactsByPeer[c.publicKeyHex.trim().toLowerCase()] = c;
            }
          } catch {
            // 联系人查找失败不影响消息列表
          }
        }
        return { messages, contactsByPeer };
      },
      subscribe: (_args, context, invalidate) => {
        const contacts = context.getCapability<ContactsService>("contacts.service");
        const offMessages = service.subscribeChanges(invalidate);
        const offContacts = contacts?.onChange(invalidate) ?? (() => {});
        return () => { offMessages(); offContacts(); };
      },
      equals: (prev, next) => {
        if (!prev || !next) return prev === next;
        return messagesEqual(prev.messages, next.messages)
          && contactsByPeerEqual(prev.contactsByPeer, next.contactsByPeer);
      },
      invalidation: "microtask"
    });

    // message.detail：消息详情页数据（消息 + 联系人）
    resources.register<MessageDetailData, readonly string[]>({
      id: "message.detail",
      scope: "active-key",
      key: (args, context) => ["message.detail", context.activePublicKeyHex ?? "none", args[0] ?? "none"],
      load: async (args, context, _signal) => {
        const peerHex = args[0];
        const messages = await service.listMessages({ limit: 10_000 });
        const contacts = context.getCapability<ContactsService>("contacts.service");
        let contact: Contact | null = null;
        if (contacts && peerHex) {
          try {
            contact = await contacts.findByPublicKeyHex(peerHex) ?? null;
          } catch {
            // 联系人查找失败不影响消息列表
          }
        }
        return { messages, contact };
      },
      subscribe: (args, context, invalidate) => {
        const contacts = context.getCapability<ContactsService>("contacts.service");
        const offMessages = service.subscribeChanges(invalidate);
        const offContacts = contacts?.onChange(invalidate) ?? (() => {});
        return () => { offMessages(); offContacts(); };
      },
      equals: (prev, next) => {
        if (!prev || !next) return prev === next;
        return messagesEqual(prev.messages, next.messages)
          && contactsEqual(prev.contact, next.contact);
      },
      invalidation: "microtask"
    });

    const routes = ctx.get<RouteRegistry>("route.registry");
    const breadcrumbs = ctx.get<{
      register(input: {
        id: string;
        order?: number;
        match: (path: string) => boolean;
        resolve: () => Array<{ label: { key: string; fallback: string } }>;
      }): void;
    }>("breadcrumb.registry");

    routes.register({
      id: "message.page",
      path: "/messages",
      label: { key: "message.page.title", fallback: "Messages" },
      component: MessagePage
    });
    routes.register({
      id: "message.detail",
      path: "/message/:publicKeyHex",
      label: { key: "message.page.detail.title", fallback: "Conversation" },
      component: MessageDetailPage
    });
    routes.register({
      id: "message.detail.alias",
      path: "/messages/:publicKeyHex",
      label: { key: "message.page.detail.title", fallback: "Conversation" },
      component: MessageDetailPage
    });
    const business = ctx.get<BusinessFeatureRegistry>("business.registry");
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
};
