// packages/plugin-message/src/manifest.ts
// 系统消息应用 manifest（施工单 2026-07-03 001）。
//
// 设计缘由：
//   - 系统消息应用固定 appId = `keymaster.message`；该值作为插件 sender 投影
//     与 HubMsg 远端 endpoint alias 都一致；
//   - 它是查看 / 管理本地消息真值的**唯一**正式入口——**不**依赖远端
//     HubMsg 数量统计 / origin 列表；
//   - 默认 core system app：core kind = "core"（不可禁用）；
//   - 不持有 owner 私钥 / HubMsg 连接；只读取 plugin-appmsg 暴露的
//     `appmsg.core` 能力；
//   - UI 走 `@keymaster/ui` 的 React 组件；不引入额外 UI 框架依赖。

import type {
  AppMsgCore,
  I18nPluginResources,
  PluginContext,
  PluginManifest
} from "@keymaster/contracts";
import { APPMESSAGE_CORE_CAPABILITY } from "@keymaster/contracts";
import { MessagePage } from "./MessagePage.js";
import { createMessageService } from "./messageService.js";

/** 插件 id（与 keymaster.message 不一致；plugin manifest 仍唯一）。 */
export const MESSAGE_PLUGIN_ID = "message";

const messageResources: I18nPluginResources = {
  namespace: "message",
  resources: {
    en: {
      "message.platform.title": "Messages",
      "message.platform.desc": "View and manage local messages.",
      "message.menu": "Messages",
      "message.breadcrumb": "Messages",
      "message.page.title": "Messages",
      "message.page.empty": "No local messages yet.",
      "message.page.sync.state.open": "Connected",
      "message.page.sync.state.closed": "Disconnected",
      "message.page.sync.state.idle": "Idle",
      "message.page.sync.lastSynced": "Last synced",
      "message.page.sync.error": "Sync error",
      "message.page.sender.label": "From",
      "message.page.recipient.label": "To",
      "message.page.body.label": "Message",
      "message.page.group.label": "Channel",
      "message.page.refresh": "Refresh",
      "message.page.checkOnline": "Check online",
      "message.page.online.label": "Online status",
      "message.page.online.online": "online",
      "message.page.online.offline": "offline",
      "message.page.online.unknown": "unknown"
    },
    "zh-CN": {
      "message.platform.title": "消息",
      "message.platform.desc": "查看并管理本地消息。",
      "message.menu": "消息",
      "message.breadcrumb": "消息",
      "message.page.title": "消息",
      "message.page.empty": "本地暂无消息。",
      "message.page.sync.state.open": "已连接",
      "message.page.sync.state.closed": "未连接",
      "message.page.sync.state.idle": "空闲",
      "message.page.sync.lastSynced": "最近一次同步",
      "message.page.sync.error": "同步错误",
      "message.page.sender.label": "发件人",
      "message.page.recipient.label": "收件人",
      "message.page.body.label": "消息内容",
      "message.page.group.label": "渠道",
      "message.page.refresh": "刷新",
      "message.page.checkOnline": "查询在线",
      "message.page.online.label": "在线状态",
      "message.page.online.online": "在线",
      "message.page.online.offline": "离线",
      "message.page.online.unknown": "未知"
    }
  }
};

/**
 * 系统消息应用 manifest。
 */
export const messagePlatformPlugin: PluginManifest = {
  id: MESSAGE_PLUGIN_ID,
  name: "Messages",
  description: "View / manage local messages; appId = keymaster.message",
  meta: {
    kind: "core",
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: ["message.service"],
    displayGroup: "platform"
  },
  i18n: messageResources,
  keyScopedStorages: [], // 该插件不持久化自己的状态；只读 appmsg.core
  dependencies: [
    {
      capability: APPMESSAGE_CORE_CAPABILITY,
      reason: "读取本地消息库 / 同步状态 / 在线查询"
    },
    { capability: "route.registry", reason: "注册 /messages 路由" },
    { capability: "menu.registry", reason: "注册「消息」菜单项" },
    {
      capability: "breadcrumb.registry",
      reason: "为 /messages 提供面包屑"
    }
  ],
  setup(ctx) {
    const core = ctx.get<AppMsgCore>(APPMESSAGE_CORE_CAPABILITY);
    const service = createMessageService(core);

    // 在 plugin context provide 一个 `message.service`：方便别的插件
    // (例如 contacts) 查询"指定 publicKeyHex 当前是否在线"。
    ctx.provide("message.service", service);

    const routes = ctx.get<{
      register(input: { id: string; path: string; component: unknown; inMenu?: boolean; menuGroup?: string; order?: number; icon?: string; label?: { key: string; fallback: string } }): void;
    }>("route.registry");
    const menus = ctx.get<{
      register(input: { id: string; path: string; group: string; order?: number; icon?: string; label: { key: string; fallback: string } }): void;
    }>("menu.registry");
    const breadcrumbs = ctx.get<{
      register(input: { id: string; order?: number; match: (path: string) => boolean; resolve: () => Array<{ label: { key: string; fallback: string } }> }): void;
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
      match: (path) => path === "/messages",
      resolve: () => [
        { label: { key: "message.breadcrumb", fallback: "Messages" } }
      ]
    });

    return () => {
      // 不持有资源，无需清理；plugin-appmsg 自然清理自己的连接。
    };
  }
};
