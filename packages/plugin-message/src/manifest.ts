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
//       * `/messages`            —— 业务页（发送 / 搜索 / 列表）
//       * `/messages/:messageId` —— 单条详情
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
      "message.page.empty": "No local messages yet.",
      "message.page.search.label": "Search",
      "message.page.search.placeholder": "filter messages by body",
      "message.page.send.label": "Send",
      "message.page.send.recipient": "Recipient publicKeyHex",
      "message.page.send.body": "Body",
      "message.page.send.submit": "Send",
      "message.page.send.success": "Sent.",
      "message.page.send.fail": "Send failed.",
      "message.page.list.label": "Local messages",
      "message.page.sender.label": "From",
      "message.page.recipient.label": "To",
      "message.page.detail.title": "Message detail",
      "message.page.detail.body": "Body",
      "message.page.detail.meta.createdAt": "Created at",
      "message.page.detail.meta.insertedAt": "Inserted at",
      "message.page.detail.meta.messageId": "Message id",
      "message.page.detail.meta.clientMessageId": "Client message id",
      "message.page.detail.empty": "Message not found in this scope.",
      "message.page.noClient": "appmsg.endpoint service is not available.",
      "message.page.back": "Back"
    },
    "zh-CN": {
      "message.menu": "消息",
      "message.breadcrumb": "消息",
      "message.breadcrumb.detail": "详情",
      "message.page.title": "消息",
      "message.page.empty": "本地暂无消息。",
      "message.page.search.label": "搜索",
      "message.page.search.placeholder": "按正文过滤消息",
      "message.page.send.label": "发送",
      "message.page.send.recipient": "收件方 publicKeyHex",
      "message.page.send.body": "正文",
      "message.page.send.submit": "发送",
      "message.page.send.success": "已发送。",
      "message.page.send.fail": "发送失败。",
      "message.page.list.label": "本地消息",
      "message.page.sender.label": "发件人",
      "message.page.recipient.label": "收件人",
      "message.page.detail.title": "消息详情",
      "message.page.detail.body": "正文",
      "message.page.detail.meta.createdAt": "创建时间",
      "message.page.detail.meta.insertedAt": "入库时间",
      "message.page.detail.meta.messageId": "消息 id",
      "message.page.detail.meta.clientMessageId": "客户端消息 id",
      "message.page.detail.empty": "当前 scope 内未找到该消息。",
      "message.page.noClient": "appmsg.endpoint service 不可用。",
      "message.page.back": "返回"
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
    { capability: "route.registry", reason: "注册 /messages 与 /messages/:messageId 路由" },
    { capability: "menu.registry", reason: "注册「消息」菜单项" },
    {
      capability: "breadcrumb.registry",
      reason: "为 /messages 与 /messages/:messageId 提供面包屑"
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
      path: "/messages/:messageId",
      label: { key: "message.page.detail.title", fallback: "Message detail" },
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