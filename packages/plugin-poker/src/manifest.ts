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
//
// 硬切换 003：
//   - /settings/poker 改为通过 settings.registry 注册单一真值；
//   - 不再向 route.registry / menu.registry 重复注册同一设置页；
//   - 删除 PokerSettingsEntry，不再向 /settings 聚合页注册入口 section；
//   - breadcrumb 第一段改为不可点击"设置"分类节点。

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
  SettingsRegistry,
  VaultService
} from "@keymaster/contracts";
import { I18N_SERVICE_CAPABILITY, POKER_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { createPokerService } from "./pokerService.js";
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
      "poker.crumb.poker": "Poker",
      "poker.crumb.settings": "Settings",
      "poker.crumb.table": "Table",
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
      "poker.settings.status.label": "Status",
      "poker.settings.status.idle": "Idle",
      "poker.settings.status.connecting": "Connecting",
      "poker.settings.status.authenticating": "Authenticating",
      "poker.settings.status.ready": "Ready",
      "poker.settings.status.reconnecting": "Reconnecting",
      "poker.settings.status.failed": "Failed",
      "poker.settings.status.closed": "Closed",
      "poker.settings.network": "Network",
      "poker.settings.actions.section": "Actions",
      "poker.settings.diag": "Diagnostics",
      "poker.settings.identity.label": "Current poker identity",
      "poker.settings.identity.section": "Poker identity",
      "poker.settings.identity.hint":
        "Poker uses the current identity for this session. If the identity changes, the current session will be rebuilt automatically.",
      "poker.settings.identity.unavailable": "Poker is currently unavailable.",
      "poker.home.title": "Poker",
      "poker.home.empty": "Not connected",
      "poker.home.connectHint": "Open Poker settings to configure the proxy endpoint.",
      "poker.home.tables": "Tables",
      "poker.home.presences": "Online players",
      "poker.home.identity": "Current poker identity",
      "poker.home.unavailable": "Poker is currently unavailable.",
      "poker.home.unavailableHint": "The current session is unavailable.",
      "poker.status.idle": "Idle",
      "poker.status.connecting": "Connecting",
      "poker.status.authenticating": "Authenticating",
      "poker.status.ready": "Ready",
      "poker.status.reconnecting": "Reconnecting",
      "poker.status.failed": "Failed",
      "poker.status.closed": "Closed",
      "poker.lobby.title": "Poker lobby",
      "poker.lobby.description":
        "Tables and online players observed by the local poker-proxy connection.",
      "poker.lobby.tables": "Tables",
      "poker.lobby.presences": "Online players",
      "poker.lobby.noTables": "No tables yet",
      "poker.lobby.noTablesHint":
        "Tables appear here once a host announces them on the proxy.",
      "poker.lobby.noPresences": "Nobody online",
      "poker.lobby.noPresencesHint":
        "Online players will show up once the proxy connection is established.",
      "poker.lobby.sessionUnavailable.default.title": "Poker is currently unavailable",
      "poker.lobby.sessionUnavailable.default.hint":
        "The current session is unavailable.",
      "poker.lobby.sessionUnavailable.allMode.title": "Poker is currently unavailable",
      "poker.lobby.sessionUnavailable.allMode.hint":
        "The current session is unavailable.",
      "poker.lobby.sessionUnavailable.vaultLocked.title": "Poker is currently unavailable",
      "poker.lobby.sessionUnavailable.vaultLocked.hint":
        "The current session is unavailable.",
      "poker.lobby.sessionUnavailable.missing.title": "Poker is currently unavailable",
      "poker.lobby.sessionUnavailable.missing.hint":
        "The current session is unavailable.",
      "poker.lobby.sessionUnavailable.notReady.title": "Poker is currently unavailable",
      "poker.lobby.sessionUnavailable.notReady.hint":
        "The current session is unavailable.",
      "poker.lobby.sessionUnavailable.noActiveHash.title": "Poker is currently unavailable",
      "poker.lobby.sessionUnavailable.noActiveHash.hint":
        "The current session is unavailable.",
      "poker.table.title": "Poker table",
      "poker.table.back": "Back to lobby",
      "poker.table.notJoined": "You have not joined this table",
      "poker.table.topic": "Topic",
      "poker.table.subscribe": "Subscribe",
      "poker.table.joined": "Joined",
      "poker.table.txEvents": "Tx events",
      "poker.table.frames": "Frames",
      "poker.table.protocolOnly":
        "Protocol-only view. Game-state rendering will land in a later hard switch.",
      "poker.table.sessionClosed":
        "The current session was closed. Please re-enter.",
      "poker.table.sessionUnavailable.default":
        "Poker is currently unavailable.",
      "poker.table.sessionUnavailable.allMode":
        "Poker is currently unavailable.",
      "poker.table.sessionUnavailable.vaultLocked":
        "Poker is currently unavailable.",
      "poker.table.sessionUnavailable.missing":
        "Poker is currently unavailable.",
      "poker.table.sessionUnavailable.notReady":
        "Poker is currently unavailable.",
      "poker.table.sessionUnavailable.noActiveHash":
        "Poker is currently unavailable.",
      "poker.err.notReady": "Proxy not ready"
    },
    "zh-CN": {
      "poker.provider.name": "扑克",
      "poker.provider.description": "基于 bsv-poker 协议的多租户浏览器扑克。",
      "poker.route.lobby": "扑克大厅",
      "poker.route.table": "扑克桌",
      "poker.crumb.poker": "扑克",
      "poker.crumb.settings": "设置",
      "poker.crumb.table": "桌",
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
      "poker.settings.status.label": "连接状态",
      "poker.settings.status.idle": "空闲",
      "poker.settings.status.connecting": "连接中",
      "poker.settings.status.authenticating": "认证中",
      "poker.settings.status.ready": "就绪",
      "poker.settings.status.reconnecting": "重连中",
      "poker.settings.status.failed": "失败",
      "poker.settings.status.closed": "已断开",
      "poker.settings.network": "网络",
      "poker.settings.actions.section": "操作",
      "poker.settings.diag": "诊断",
      "poker.settings.identity.label": "当前扑克身份",
      "poker.settings.identity.section": "扑克身份",
      "poker.settings.identity.hint":
        "Poker 会使用当前身份建立会话；身份变化时，当前会话会自动重建。",
      "poker.settings.identity.unavailable": "扑克当前不可用。",
      "poker.home.title": "扑克",
      "poker.home.empty": "未连接",
      "poker.home.connectHint": "前往扑克设置配置代理 endpoint。",
      "poker.home.tables": "桌局",
      "poker.home.presences": "在线玩家",
      "poker.home.identity": "当前扑克身份",
      "poker.home.unavailable": "扑克当前不可用。",
      "poker.home.unavailableHint": "当前会话暂不可用。",
      "poker.status.idle": "空闲",
      "poker.status.connecting": "连接中",
      "poker.status.authenticating": "认证中",
      "poker.status.ready": "就绪",
      "poker.status.reconnecting": "重连中",
      "poker.status.failed": "失败",
      "poker.status.closed": "已断开",
      "poker.lobby.title": "扑克大厅",
      "poker.lobby.description": "本地 poker-proxy 连接观察到的桌局与在线玩家。",
      "poker.lobby.tables": "桌局",
      "poker.lobby.presences": "在线玩家",
      "poker.lobby.noTables": "暂无桌局",
      "poker.lobby.noTablesHint": "代理上 host 公告桌局后，会出现在这里。",
      "poker.lobby.noPresences": "暂无在线玩家",
      "poker.lobby.noPresencesHint": "代理连接建立后，在线玩家会出现在这里。",
      "poker.lobby.sessionUnavailable.default.title": "扑克当前不可用",
      "poker.lobby.sessionUnavailable.default.hint": "当前会话暂不可用。",
      "poker.lobby.sessionUnavailable.allMode.title": "扑克当前不可用",
      "poker.lobby.sessionUnavailable.allMode.hint": "当前会话暂不可用。",
      "poker.lobby.sessionUnavailable.vaultLocked.title": "扑克当前不可用",
      "poker.lobby.sessionUnavailable.vaultLocked.hint": "当前会话暂不可用。",
      "poker.lobby.sessionUnavailable.missing.title": "扑克当前不可用",
      "poker.lobby.sessionUnavailable.missing.hint": "当前会话暂不可用。",
      "poker.lobby.sessionUnavailable.notReady.title": "扑克当前不可用",
      "poker.lobby.sessionUnavailable.notReady.hint": "当前会话暂不可用。",
      "poker.lobby.sessionUnavailable.noActiveHash.title": "扑克当前不可用",
      "poker.lobby.sessionUnavailable.noActiveHash.hint": "当前会话暂不可用。",
      "poker.table.title": "扑克桌",
      "poker.table.back": "返回大厅",
      "poker.table.notJoined": "尚未加入该桌",
      "poker.table.topic": "Topic",
      "poker.table.subscribe": "订阅",
      "poker.table.joined": "已加入",
      "poker.table.txEvents": "Tx 事件",
      "poker.table.frames": "帧",
      "poker.table.protocolOnly": "纯协议页。牌局状态渲染留到后续硬切换。",
      "poker.table.sessionClosed": "当前会话已关闭，请重新进入。",
      "poker.table.sessionUnavailable.default": "扑克当前不可用。",
      "poker.table.sessionUnavailable.allMode": "扑克当前不可用。",
      "poker.table.sessionUnavailable.vaultLocked": "扑克当前不可用。",
      "poker.table.sessionUnavailable.missing": "扑克当前不可用。",
      "poker.table.sessionUnavailable.notReady": "扑克当前不可用。",
      "poker.table.sessionUnavailable.noActiveHash": "扑克当前不可用。",
      "poker.err.notReady": "代理尚未就绪"
    }
  }
};

export const pokerPlugin: PluginManifest = {
  id: "poker",
  name: "Poker",
  description: "Browser-native peer poker over bsv-poker protocol, served by an external poker-proxy.",
  meta: {
    kind: "business",
    defaultEnabled: false,
    canDisable: true,
    providesCapabilities: [POKER_SERVICE_CAPABILITY],
    displayGroup: "business"
  },
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
    { capability: "settings.registry", reason: "register poker settings detail page" },
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

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const items: MenuItem[] = [
      {
        id: "menu.poker.lobby",
        label: { key: "poker.route.lobby", fallback: "Poker lobby" },
        routeId: "poker.lobby",
        group: "apps",
        order: 30,
        icon: "Spade",
        visibleWhen: ({ unlocked }) => unlocked
      }
    ];
    for (const item of items) menus.register(item);

    // 硬切换 003：/settings/poker 由 settings.registry 单一真值提供。
    // 不再保留 PokerSettingsEntry，不再向 /settings 聚合页注册入口 section。
    const settings = ctx.get<SettingsRegistry>("settings.registry");
    settings.register({
      id: "poker.settings",
      path: "/settings/poker",
      label: { key: "poker.crumb.poker", fallback: "Poker" },
      description: { key: "poker.provider.description", fallback: "Multi-tenant peer poker." },
      component: PokerSettingsPage,
      order: 130,
      icon: "Cog",
      visibleWhen: ({ unlocked }) => unlocked
    });

    const home = ctx.get<HomeRegistry>("home.registry");
    home.register({
      id: "poker.status",
      title: { key: "poker.home.title", fallback: "Poker" },
      component: PokerHomeWidget,
      order: 30,
      slot: "aside",
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
            { label: { key: "poker.crumb.settings", fallback: "Settings" } },
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

    // 硬切换 001：teardown 桥接到 service.dispose() —— 内部处理 ws / reconnect
    // timer / identity binding / listeners 全部清理。
    return () => {
      try {
        service.dispose?.();
      } catch {
        // swallow
      }
    };
  }
};
