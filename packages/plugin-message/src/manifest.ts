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
      "message.page.detail.from.me": "Me",
      "message.page.noClient": "appmsg.endpoint service is not available.",
      "message.page.back": "Back",
      "message.page.send.submit": "Send",
      "message.page.send.empty": "Body is empty"
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
      "message.page.detail.from.me": "我",
      "message.page.noClient": "appmsg.endpoint service 不可用。",
      "message.page.back": "返回",
      "message.page.send.submit": "发送",
      "message.page.send.empty": "正文不能为空"
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
