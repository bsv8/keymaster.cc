// packages/plugin-poker/src/manifest.ts
// Poker 插件 manifest：注册 capability / route / menu / settings / breadcrumb。
//
// 设计缘由：
//   - 硬切换文档要求 "plugin-poker 必须作为独立业务插件接入，不允许把扑
//     克逻辑散落到 apps/web/src/shell/"。本 manifest 是唯一入口。
//   - 通过 ctx.get 拿 vault / keyspace / messageBus / 各 registry；
//     严禁 deep-import 其它 plugin-*。
//   - 暴露 POKER_SERVICE_CAPABILITY 与 POKER_CAPABILITY（同值）两个常量名，
//     兼容旧调用方；plugin-poker 的能力 key 与 contracts/poker.ts 集中维护。

import type {
  BreadcrumbProvider,
  BreadcrumbRegistry,
  HomeRegistry,
  I18nPluginResources,
  KeyspaceService,
  MenuItem,
  MenuRegistry,
  MessageBus,
  PluginManifest,
  RouteRegistry,
  SettingsField,
  SettingsRegistry,
  VaultService
} from "@keymaster/contracts";
import { I18N_SERVICE_CAPABILITY, POKER_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { createPokerService } from "./pokerService.js";
import { PokerPage } from "./PokerPage.js";
import { PokerLobby } from "./PokerLobby.js";
import { PokerTable as PokerTablePage } from "./PokerTable.js";
import { PokerSettingsPage } from "./PokerSettingsPage.js";
import { PokerHomeWidget } from "./widgets/PokerHomeWidget.js";

export { POKER_SERVICE_CAPABILITY };

/** Poker i18n 资源：覆盖 route / menu / settings / home / breadcrumb 与 poker 业务文案。 */
const pokerResources: I18nPluginResources = {
  namespace: "poker",
  resources: {
    en: {
      "poker.provider.name": "Poker",
      "poker.provider.description": "Multi-tenant peer poker over bsv-poker protocol.",
      "poker.route.lobby": "Poker lobby",
      "poker.route.table": "Poker table",
      "poker.route.settings": "Poker settings",
      "poker.menu.lobby": "Poker",
      "poker.menu.settings": "Poker settings",
      "poker.crumb.poker": "Poker",
      "poker.crumb.settings": "Settings",
      "poker.crumb.table": "Table",
      "poker.settings.label": "Poker",
      "poker.settings.description": "Proxy endpoint and broadcast policy.",
      "poker.settings.endpoint": "Proxy WSS endpoint",
      "poker.settings.endpointHint": "e.g. wss://poker-proxy.example.com",
      "poker.settings.announceP2PNode": "Announced P2PNode endpoint",
      "poker.settings.announceP2PNodeHint": "host:port for the P2PNode plane (mesh)",
      "poker.settings.announceTxLink": "Announced TxLink endpoint",
      "poker.settings.announceTxLinkHint": "host:port for the TxLink plane (raw tx)",
      "poker.settings.allowFallback": "Allow fallback broadcast",
      "poker.settings.allowFallback.yes": "Yes",
      "poker.settings.allowFallback.no": "No (only direct)",
      "poker.settings.connect": "Connect",
      "poker.settings.disconnect": "Disconnect",
      "poker.settings.save": "Save",
      "poker.settings.saved": "Saved",
      "poker.settings.identity": "Poker identity",
      "poker.settings.identity.bound": "Bound to",
      "poker.settings.identity.unbound": "No poker identity bound (fail-closed)",
      "poker.settings.identity.select": "Select vault key",
      "poker.settings.identity.bind": "Bind",
      "poker.settings.identity.unbind": "Unbind",
      "poker.settings.diag": "Diagnostics",
      "poker.home.title": "Poker",
      "poker.home.empty": "Not connected",
      "poker.home.connectHint": "Open Poker settings to configure the proxy endpoint.",
      "poker.home.tables": "Tables",
      "poker.home.presences": "Online players",
      "poker.status.idle": "Idle",
      "poker.status.connecting": "Connecting",
      "poker.status.authenticating": "Authenticating",
      "poker.status.ready": "Ready",
      "poker.status.reconnecting": "Reconnecting",
      "poker.status.failed": "Failed",
      "poker.status.closed": "Closed",
      "poker.lobby.title": "Poker lobby",
      "poker.lobby.tables": "Tables",
      "poker.lobby.presences": "Online players",
      "poker.lobby.noTables": "No tables yet",
      "poker.lobby.noPresences": "Nobody online",
      "poker.table.title": "Poker table",
      "poker.table.back": "Back to lobby",
      "poker.table.notJoined": "You have not joined this table",
      "poker.table.topic": "Topic",
      "poker.err.notReady": "Proxy not ready",
      "poker.err.locked": "Vault is locked"
    },
    "zh-CN": {
      "poker.provider.name": "扑克",
      "poker.provider.description": "基于 bsv-poker 协议的多租户浏览器扑克。",
      "poker.route.lobby": "扑克大厅",
      "poker.route.table": "扑克桌",
      "poker.route.settings": "扑克设置",
      "poker.menu.lobby": "扑克",
      "poker.menu.settings": "扑克设置",
      "poker.crumb.poker": "扑克",
      "poker.crumb.settings": "设置",
      "poker.crumb.table": "桌",
      "poker.settings.label": "扑克",
      "poker.settings.description": "代理入口与广播策略。",
      "poker.settings.endpoint": "代理 WSS endpoint",
      "poker.settings.endpointHint": "例如 wss://poker-proxy.example.com",
      "poker.settings.announceP2PNode": "公告的 P2PNode 入口",
      "poker.settings.announceP2PNodeHint": "P2PNode 平面（mesh）host:port",
      "poker.settings.announceTxLink": "公告的 TxLink 入口",
      "poker.settings.announceTxLinkHint": "TxLink 平面（raw tx）host:port",
      "poker.settings.allowFallback": "允许兜底广播",
      "poker.settings.allowFallback.yes": "是",
      "poker.settings.allowFallback.no": "否（只收 direct）",
      "poker.settings.connect": "连接",
      "poker.settings.disconnect": "断开",
      "poker.settings.save": "保存",
      "poker.settings.saved": "已保存",
      "poker.settings.identity": "扑克身份",
      "poker.settings.identity.bound": "已绑定",
      "poker.settings.identity.unbound": "未绑定（fail-closed）",
      "poker.settings.identity.select": "选择 vault key",
      "poker.settings.identity.bind": "绑定",
      "poker.settings.identity.unbind": "解绑",
      "poker.settings.diag": "诊断",
      "poker.home.title": "扑克",
      "poker.home.empty": "未连接",
      "poker.home.connectHint": "前往扑克设置配置代理 endpoint。",
      "poker.home.tables": "桌局",
      "poker.home.presences": "在线玩家",
      "poker.status.idle": "空闲",
      "poker.status.connecting": "连接中",
      "poker.status.authenticating": "认证中",
      "poker.status.ready": "就绪",
      "poker.status.reconnecting": "重连中",
      "poker.status.failed": "失败",
      "poker.status.closed": "已关闭",
      "poker.lobby.title": "扑克大厅",
      "poker.lobby.tables": "桌局",
      "poker.lobby.presences": "在线玩家",
      "poker.lobby.noTables": "暂无桌局",
      "poker.lobby.noPresences": "暂无在线玩家",
      "poker.table.title": "扑克桌",
      "poker.table.back": "返回大厅",
      "poker.table.notJoined": "尚未加入该桌",
      "poker.table.topic": "Topic",
      "poker.err.notReady": "代理尚未就绪",
      "poker.err.locked": "钱包未解锁"
    }
  }
};

export const pokerPlugin: PluginManifest = {
  id: "poker",
  name: "Poker",
  description: "Browser-native peer poker over bsv-poker protocol, served by an external poker-proxy.",
  i18n: pokerResources,
  keyScopedStorages: [
    { storageId: "poker", description: "Poker settings / tables / presences / tx ingest" }
  ],
  dependencies: [
    { capability: "vault.service", reason: "need vault.withPrivateKey for signing" },
    { capability: "keyspace.service", reason: "active key + key-scoped storage" },
    { capability: "runtime.messageBus", reason: "event subscription + publish" },
    { capability: I18N_SERVICE_CAPABILITY, reason: "i18n for route / menu / settings labels" },
    { capability: "route.registry", reason: "register poker pages" },
    { capability: "menu.registry", reason: "register poker menu" },
    { capability: "settings.registry", reason: "register poker settings" },
    { capability: "home.registry", reason: "register poker home widget" },
    { capability: "breadcrumb.registry", reason: "register poker breadcrumbs" }
  ],
  setup(ctx) {
    const vault = ctx.get<VaultService>("vault.service");
    const keyspace = ctx.get<KeyspaceService>("keyspace.service");
    const messageBus = ctx.get<MessageBus>("runtime.messageBus");

    const service = createPokerService({ vault, keyspace, messageBus });
    ctx.provide(POKER_SERVICE_CAPABILITY, service);

    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "poker.lobby",
      path: "/poker",
      label: { key: "poker.route.lobby", fallback: "Poker lobby" },
      component: PokerLobby,
      inMenu: true,
      menuGroup: "apps",
      order: 30,
      icon: "Spade"
    });
    routes.register({
      id: "poker.table",
      path: "/poker/table/:tableId",
      label: { key: "poker.route.table", fallback: "Poker table" },
      component: PokerTablePage,
      inMenu: false
    });
    routes.register({
      id: "poker.settings",
      path: "/settings/poker",
      label: { key: "poker.route.settings", fallback: "Poker settings" },
      component: PokerSettingsPage,
      inMenu: false,
      menuGroup: "settings",
      order: 120,
      icon: "Cog"
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const items: MenuItem[] = [
      {
        id: "menu.poker.lobby",
        label: { key: "poker.menu.lobby", fallback: "Poker" },
        routeId: "poker.lobby",
        group: "apps",
        order: 30,
        icon: "Spade",
        visibleWhen: ({ unlocked }) => unlocked
      }
    ];
    for (const item of items) menus.register(item);

    const settings = ctx.get<SettingsRegistry>("settings.registry");
    const fields: SettingsField[] = [
      {
        id: "poker.endpoint",
        label: { key: "poker.settings.endpoint", fallback: "Proxy WSS endpoint" },
        kind: "text",
        getValue: async () => service.getSettings().proxyEndpoint,
        setValue: async (v) => {
          await service.updateSettings({ proxyEndpoint: String(v ?? "") });
        }
      },
      {
        id: "poker.announceP2PNode",
        label: { key: "poker.settings.announceP2PNode", fallback: "Announced P2PNode endpoint" },
        kind: "text",
        getValue: async () => service.getSettings().announceP2PNodeEndpoint ?? "",
        setValue: async (v) => {
          await service.updateSettings({ announceP2PNodeEndpoint: String(v ?? "") || undefined });
        }
      },
      {
        id: "poker.announceTxLink",
        label: { key: "poker.settings.announceTxLink", fallback: "Announced TxLink endpoint" },
        kind: "text",
        getValue: async () => service.getSettings().announceTxLinkEndpoint ?? "",
        setValue: async (v) => {
          await service.updateSettings({ announceTxLinkEndpoint: String(v ?? "") || undefined });
        }
      },
      {
        id: "poker.allowFallback",
        label: { key: "poker.settings.allowFallback", fallback: "Allow fallback broadcast" },
        kind: "boolean",
        getValue: async () => service.getSettings().allowFallbackBroadcast,
        setValue: async (v) => {
          await service.updateSettings({ allowFallbackBroadcast: Boolean(v) });
        }
      }
    ];
    for (const f of fields) settings.registerField(f);
    settings.registerPage({
      id: "poker.config",
      label: { key: "poker.settings.label", fallback: "Poker" },
      description: { key: "poker.settings.description", fallback: "Poker settings." },
      fields,
      order: 30,
      component: PokerSettingsPage
    });

    const home = ctx.get<HomeRegistry>("home.registry");
    home.register({
      id: "poker.status",
      title: { key: "poker.home.title", fallback: "Poker" },
      component: PokerHomeWidget,
      order: 30,
      size: "sm",
      refreshHint: "manual"
    });

    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    const provider: BreadcrumbProvider = {
      id: "poker.crumbs",
      order: 220,
      match: (path) => path.startsWith("/poker") || path.startsWith("/settings/poker"),
      resolve: (path) => {
        if (path.startsWith("/settings/poker")) {
          return [
            { label: { key: "poker.crumb.settings", fallback: "Settings" }, path: "/settings" },
            { label: { key: "poker.crumb.poker", fallback: "Poker" } }
          ];
        }
        if (path.startsWith("/poker/table/")) {
          return [
            { label: { key: "poker.crumb.poker", fallback: "Poker" }, path: "/poker" },
            { label: { key: "poker.crumb.table", fallback: "Table" } }
          ];
        }
        return [{ label: { key: "poker.crumb.poker", fallback: "Poker" } }];
      }
    };
    breadcrumbs.register(provider);

    // 单页 alias（保留旧入口）。
    void PokerPage;
  }
};
