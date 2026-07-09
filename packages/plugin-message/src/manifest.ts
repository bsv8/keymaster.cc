// packages/plugin-message/src/manifest.ts
// 消息业务插件 manifest（施工单 2026-07-04 001 硬切换）。
//
// 设计缘由：
//   - `plugin-message` 是一个**极薄业务插件**，appId = `keymaster.message`，
//     **不**再感知 owner / provider / 任何 provider 细节；
//   - **不**订阅 keyspace.onActiveChange / vault.onStatusChange；
//   - **不**走 `<pluginId>.appmsg.client` 旧 capability（runtime 已经
//     移除该注入路径）；
//   - **不**通过 plugin-facade 透传 `subscriptionSource()` 这种"subscription
//     token"——服务内部自动迁移订阅；
//   - 在自己的 `setup` 阶段：
//       * `ctx.get<...>("appmsg.endpoint.registry").forEndpoint(...)` 拿到
//         稳定长寿的 `AppMsgEndpointService`；
//       * `service` 内部已自动处理 owner / provider 变化；
//       * 把 service 透传给 `createMessageService(service)` 作为公开
//         `message.service` capability。
//   - 页面路由固定归本插件：
//       * `/messages`                —— 会话列表
//       * `/messages/:publicKeyHex`   —— 会话详情
//     **不**再注册 `/system/messages` / 系统菜单 / 系统面包屑——AppMsg
//     管理面归 `plugin-appmsg` 的 `/system/appmsg`。

import type {
  AppMsgEndpointId,
  AppMsgEndpointService,
  AppMsgEndpointServiceRegistry,
  I18nPluginResources,
  PluginContext,
  PluginManifest
} from "@keymaster/contracts";
import { APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY, KEYMASTER_MESSAGE_APP_ID } from "@keymaster/contracts";
import { MessagePage } from "./MessagePage.js";
import { MessageDetailPage } from "./MessageDetailPage.js";
import { createMessageService } from "./messageService.js";

/** 插件 id（与 keymaster.message 不一致；plugin manifest 仍唯一）。 */
export const MESSAGE_PLUGIN_ID = "message";

const messageResources: I18nPluginResources = {
  namespace: "message",
  resources: {
    en: {
      "message.menu": "Messages",
      "message.breadcrumb": "Messages",
      "message.breadcrumb.detail": "Detail",
      "message.page.title": "Messages",
      "message.page.desc": "Conversation list grouped by peer publicKeyHex.",
      "message.page.empty": "No local conversations yet.",
      "message.page.empty.desc": "Open a conversation detail page to send a message and start a thread.",
      "message.page.noOwner.title": "Pick a key",
      "message.page.noOwner.desc": "Switch to an active key to view conversations.",
      "message.page.conversation.count": "{{count}} messages",
      "message.page.conversation.addContact": "Add contact",
      "message.page.conversation.editContact": "Edit contact",
      "message.page.detail.title": "Conversation",
      "message.page.detail.body": "Body",
      "message.page.detail.empty": "No messages in this conversation.",
      "message.page.detail.empty.desc": "Send a message below to start the thread.",
      "message.page.detail.noConversation": "Conversation not found.",
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
      "message.page.noClient": "appmsg.endpoint service is not available.",
      "message.page.back": "Back",
      "message.page.send.submit": "Send",
      "message.page.send.empty": "Body is empty",
      "message.page.detail.error.target_offline": "Peer is offline.",
      "message.page.detail.error.target_unknown": "Peer online status is unknown.",
      "message.page.detail.error.service_not_ready": "WebRTC service is not ready.",
      "message.page.detail.error.invalid_target": "Target publicKeyHex is invalid.",
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
      "message.menu": "消息",
      "message.breadcrumb": "消息",
      "message.breadcrumb.detail": "详情",
      "message.page.title": "消息",
      "message.page.desc": "按对端 publicKeyHex 聚合的会话列表。",
      "message.page.empty": "本地暂无会话。",
      "message.page.empty.desc": "进入会话详情页即可发送消息并开始线程。",
      "message.page.noOwner.title": "请选择一个 key",
      "message.page.noOwner.desc": "切换到 active key 后即可查看会话。",
      "message.page.conversation.count": "{{count}} 条消息",
      "message.page.conversation.addContact": "新增联系人",
      "message.page.conversation.editContact": "编辑联系人",
      "message.page.detail.title": "会话",
      "message.page.detail.body": "正文",
      "message.page.detail.empty": "当前会话暂无消息。",
      "message.page.detail.empty.desc": "在下方发送一条消息即可开始线程。",
      "message.page.detail.noConversation": "会话未找到。",
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
      "message.page.detail.offline": "离线",
      "message.page.detail.unknown": "状态未知",
      "message.page.detail.loadMore": "再加载 20 条更早消息",
      "message.page.noClient": "appmsg.endpoint service 不可用。",
      "message.page.back": "返回",
      "message.page.send.submit": "发送",
      "message.page.send.empty": "正文不能为空",
      "message.page.detail.error.target_offline": "对方当前离线。",
      "message.page.detail.error.target_unknown": "无法确认对方在线状态。",
      "message.page.detail.error.service_not_ready": "WebRTC 服务未就绪。",
      "message.page.detail.error.invalid_target": "目标 publicKeyHex 非法。",
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
 * plugin-message 的固定 endpoint id。
 */
const PLUGIN_MESSAGE_ENDPOINT: AppMsgEndpointId = {
  kind: "plugin",
  id: KEYMASTER_MESSAGE_APP_ID
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
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: ["message.service"],
    displayGroup: "platform"
  },
  i18n: messageResources,
  keyScopedStorages: [], // 该插件不持久化自己的状态；只读 endpoint service
  /**
   * 声明 endpointId = `keymaster.message`：runtime 仅做形状校验 +
   * 唯一性校验；**不**注入任何 scoped client capability。
   *
   * `endpointId` 形状必须满足 `isValidPluginEndpointIdShape`——
   * "keymaster.message" 满足（a.b 形式 portable subset）。
   */
  appMessageEndpoint: {
    endpointId: KEYMASTER_MESSAGE_APP_ID,
    description: "keymaster.message business app"
  },
  dependencies: [
    {
      capability: APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY,
      reason: "拿 endpoint service（plugin-appmsg 提供）"
    },
    { capability: "keyspace.service", reason: "读取 active key 并跟随会话聚合刷新" },
    { capability: "webrtc.service", reason: "读取 WebRTC 历史并发起音视频 / 传输动作" },
    { capability: "route.registry", reason: "注册 /messages 与 /messages/:publicKeyHex 路由" },
    { capability: "menu.registry", reason: "注册「消息」菜单项" },
    {
      capability: "breadcrumb.registry",
      reason: "为 /messages 与 /messages/:publicKeyHex 提供面包屑"
    }
  ],
  setup(ctx) {
    // 从 plugin-appmsg 的 endpoint registry 拿稳定长寿的 endpoint service。
    // service 内部自动处理 owner 真值 / active provider 变化；
    // plugin-message **不需要**监听 keyspace / vault / provider 任何事件。
    const registry = ctx.get<AppMsgEndpointServiceRegistry>(
      APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY
    );
    const endpointService = registry.forEndpoint(PLUGIN_MESSAGE_ENDPOINT);
    const service = createMessageService(endpointService);
    ctx.provide("message.service", service);

    const routes = ctx.get<{
      register(input: {
        id: string;
        path: string;
        component: unknown;
        inMenu?: boolean;
        menuGroup?: string;
        order?: number;
        icon?: string;
        label: { key: string; fallback: string };
      }): void;
    }>("route.registry");
    const menus = ctx.get<{
      register(input: {
        id: string;
        path: string;
        group: string;
        order?: number;
        icon?: string;
        label: { key: string; fallback: string };
      }): void;
    }>("menu.registry");
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
      component: MessagePage,
      inMenu: true,
      menuGroup: "platform",
      order: 5,
      icon: "Mail"
    });
    routes.register({
      id: "message.detail",
      path: "/messages/:publicKeyHex",
      label: { key: "message.page.detail.title", fallback: "Conversation" },
      component: MessageDetailPage,
      inMenu: false
    });
    menus.register({
      id: "message.page.menu",
      label: { key: "message.menu", fallback: "Messages" },
      path: "/messages",
      group: "platform",
      order: 5,
      icon: "Mail"
    });
    breadcrumbs.register({
      id: "message.page.crumbs",
      order: 4,
      match: (path) => path === "/messages" || /^\/messages\/[^/]+\/?$/.test(path),
      resolve: () => [
        { label: { key: "message.breadcrumb", fallback: "Messages" } }
      ]
    });

    return () => {
      // 释放 endpoint service；plugin-appmsg 回收内部订阅迁移资源。
      registry.releaseEndpoint(PLUGIN_MESSAGE_ENDPOINT);
    };
  }
};
