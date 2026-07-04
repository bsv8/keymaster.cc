// packages/plugin-message/src/manifest.ts
// 消息业务插件 manifest（施工单 2026-07-03 002 硬切换）。
//
// 设计缘由：
//   - `plugin-message` 是一个**普通 scoped 消息插件**，
//     appId = `keymaster.message`；它**不**再拥有"看全库" / "系统管理员
//     身份"的特权；
//   - 声明 `appMessageEndpoint.endpointId = "keymaster.message"` 后，
//     runtime host 在 enable 阶段把 sender 已绑定的 scoped client
//     注入到 `<pluginId>.appmsg.client` capability，本插件通过它读 / 发
//     自己 scope 内的消息；
//   - 页面路由固定归本插件：
//       * `/messages`            —— 业务页（发送 / 搜索 / 列表）
//       * `/messages/:messageId` —— 单条详情
//     **不**再注册 `/system/messages` / 系统菜单 / 系统面包屑——HubMsg
//     管理面归 `plugin-appmsg`。
//   - HubMsg 连接 / 同步 / 在线 / 全局统计 / 错误信息由 `plugin-appmsg`
//     的 `/system/hubmsg` 管理页直接消费 `appmsg.core` 展示，
//     本插件**不**展示这些信息。

import type {
  I18nPluginResources,
  PluginContext,
  PluginManifest
} from "@keymaster/contracts";
import { APPMESSAGE_CLIENT_CAPABILITY_SUFFIX, KEYMASTER_MESSAGE_APP_ID } from "@keymaster/contracts";
import { MessagePage } from "./MessagePage.js";
import { MessageDetailPage } from "./MessageDetailPage.js";
import { createMessageService } from "./messageService.js";

/** 插件 id（与 keymaster.message 不一致；plugin manifest 仍唯一）。 */
export const MESSAGE_PLUGIN_ID = "message";

/**
 * scoped `appmsg.client` capability key（plugin 侧）。runtime host 在
 * enable 阶段把 sender 已绑定的 client 挂到 `<pluginId>.appmsg.client`。
 */
const APPMESSAGE_CLIENT_CAPABILITY_SUFFIX_LOCAL = APPMESSAGE_CLIENT_CAPABILITY_SUFFIX;

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
      "message.page.noClient": "scoped appmsg.client is not available.",
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
      "message.page.noClient": "scoped appmsg.client 不可用。",
      "message.page.back": "返回"
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
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: ["message.service"],
    displayGroup: "platform"
  },
  i18n: messageResources,
  keyScopedStorages: [], // 该插件不持久化自己的状态；只读 scoped client
  /**
   * 声明 endpointId = `keymaster.message` 后，runtime host 在 enable
   * 完成时把 sender 已绑定 scoped client 注入到
   * `message.appmsg.client` capability；本插件通过 `ctx.get(...)` 拿。
   *
   * `endpointId` 形状必须满足 `isValidPluginEndpointIdShape`——
   * "keymaster.message" 满足（a.b 形式 portable subset）。
   */
  appMessageEndpoint: {
    endpointId: KEYMASTER_MESSAGE_APP_ID,
    description: "keymaster.message business app"
  },
  dependencies: [
    { capability: "route.registry", reason: "注册 /messages 与 /messages/:messageId 路由" },
    { capability: "menu.registry", reason: "注册「消息」菜单项" },
    {
      capability: "breadcrumb.registry",
      reason: "为 /messages 与 /messages/:messageId 提供面包屑"
    }
  ],
  setup(ctx) {
    // scoped client capability key：runtime 在 enable 阶段已经把
    // sender 投影固化的 client 挂到 `<pluginId>.appmsg.client`。
    const scopedKey = `${MESSAGE_PLUGIN_ID}${APPMESSAGE_CLIENT_CAPABILITY_SUFFIX_LOCAL}`;
    // 这里**不**在 setup 阶段强依赖 client：
    //   - vault 锁定时 client 可能仍然挂在 cap bus 上（sender = ""）；
    //   - 如果完全拿不到（runtime 没注入），service 走"未就绪"空态。
    // 因此 setup 不 require，而是让页面按 capability 是否存在降级。
    const service = createMessageService(() =>
      ctx.has(scopedKey) ? ctx.get(scopedKey) : null
    );
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
    // /messages 面包屑：固定节点。
    breadcrumbs.register({
      id: "message.page.crumbs",
      order: 4,
      match: (path) => path === "/messages" || /^\/messages\/[^/]+\/?$/.test(path),
      resolve: () => [
        { label: { key: "message.breadcrumb", fallback: "Messages" } }
      ]
    });

    return () => {
      // 不持有资源，无需清理。
    };
  }
};