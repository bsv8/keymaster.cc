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
      "poker.settings.activeKey.label": "Active key",
      "poker.settings.activeKey.section": "Poker identity",
      "poker.settings.activeKey.hint":
        "The current active key is your poker identity. Switching active key will close the current session and rebuild it under the new key.",
      "poker.settings.activeKey.allModeWarn":
        "All-keys mode is active. Poker requires a single active key — switch back to a single key to enable connection.",
      "poker.settings.activeKey.lockedWarn": "Vault is locked. Unlock to enable Poker.",
      "poker.settings.activeKey.ready": "ready",
      "poker.settings.activeKey.allMode": "all-keys mode (fail-closed)",
      "poker.settings.activeKey.vaultLocked": "vault locked (fail-closed)",
      "poker.settings.activeKey.missing": "no ready key (fail-closed)",
      "poker.settings.activeKey.notReady": "active key not ready (fail-closed)",
      "poker.settings.activeKey.noActiveHash": "no active hash (fail-closed)",
      "poker.home.title": "Poker",
      "poker.home.empty": "Not connected",
      "poker.home.connectHint": "Open Poker settings to configure the proxy endpoint.",
      "poker.home.tables": "Tables",
      "poker.home.presences": "Online players",
      "poker.home.activeKey": "Active key",
      "poker.home.sessionUnavailable.allMode":
        "All-keys mode is active. Poker needs a single active key.",
      "poker.home.sessionUnavailable.vaultLocked":
        "Vault is locked. Unlock the vault to use Poker.",
      "poker.home.sessionUnavailable.missing":
        "No ready key. Import or generate a key to use Poker.",
      "poker.home.sessionUnavailable.notReady":
        "Active key is not ready yet. Wait for backfill to finish.",
      "poker.home.sessionUnavailable.noActiveHash":
        "No active hash. Select a single active key.",
      "poker.home.sessionUnavailable.subHint":
        "Poker needs a single active key. Switch back from all-keys mode or unlock the vault.",
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
      "poker.lobby.sessionUnavailable.default.title": "Poker session unavailable",
      "poker.lobby.sessionUnavailable.default.hint":
        "Switch to a single active key to see tables and online players.",
      "poker.lobby.sessionUnavailable.allMode.title": "All-keys mode active",
      "poker.lobby.sessionUnavailable.allMode.hint":
        "Poker requires a single active key. Switch back from all-keys mode.",
      "poker.lobby.sessionUnavailable.vaultLocked.title": "Vault is locked",
      "poker.lobby.sessionUnavailable.vaultLocked.hint":
        "Unlock the vault to see tables and online players.",
      "poker.lobby.sessionUnavailable.missing.title": "No ready key",
      "poker.lobby.sessionUnavailable.missing.hint":
        "Import or generate a key to use Poker.",
      "poker.lobby.sessionUnavailable.notReady.title": "Active key is not ready",
      "poker.lobby.sessionUnavailable.notReady.hint":
        "Wait for backfill to finish, then reload.",
      "poker.lobby.sessionUnavailable.noActiveHash.title": "No active key selected",
      "poker.lobby.sessionUnavailable.noActiveHash.hint":
        "Select a single active key to enable Poker.",
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
      "poker.table.activeKeyChanged":
        "Active key has changed. The previous session was closed; please re-enter under the new identity.",
      "poker.table.sessionUnavailable.default":
        "Poker session unavailable. Open Poker settings.",
      "poker.table.sessionUnavailable.allMode":
        "All-keys mode is active. Switch to a single active key.",
      "poker.table.sessionUnavailable.vaultLocked":
        "Vault is locked. Unlock to use Poker.",
      "poker.table.sessionUnavailable.missing":
        "No ready key. Import or generate a key to use Poker.",
      "poker.table.sessionUnavailable.notReady":
        "Active key is not ready. Wait for backfill to finish.",
      "poker.table.sessionUnavailable.noActiveHash":
        "No active hash. Select a single active key.",
      "poker.err.notReady": "Proxy not ready",
      "poker.err.locked": "Vault is locked"
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
      "poker.settings.activeKey.label": "当前 active key",
      "poker.settings.activeKey.section": "扑克身份",
      "poker.settings.activeKey.hint":
        "当前 active key 即扑克身份；切换 active key 会断开当前会话并以新 key 重建。",
      "poker.settings.activeKey.allModeWarn":
        "当前处于全部 key 模式，Poker 需要单一 active key —— 切换回单一 key 后才能连接。",
      "poker.settings.activeKey.lockedWarn": "钱包未解锁，无法启用 Poker。",
      "poker.settings.activeKey.ready": "就绪",
      "poker.settings.activeKey.allMode": "全部 key 模式（fail-closed）",
      "poker.settings.activeKey.vaultLocked": "钱包未解锁（fail-closed）",
      "poker.settings.activeKey.missing": "没有 ready key（fail-closed）",
      "poker.settings.activeKey.notReady": "active key 尚未就绪（fail-closed）",
      "poker.settings.activeKey.noActiveHash": "没有 active hash（fail-closed）",
      "poker.home.title": "扑克",
      "poker.home.empty": "未连接",
      "poker.home.connectHint": "前往扑克设置配置代理 endpoint。",
      "poker.home.tables": "桌局",
      "poker.home.presences": "在线玩家",
      "poker.home.activeKey": "当前 active key",
      "poker.home.sessionUnavailable.allMode": "当前处于全部 key 模式，Poker 需要单一 active key。",
      "poker.home.sessionUnavailable.vaultLocked": "钱包未解锁，解锁后即可使用 Poker。",
      "poker.home.sessionUnavailable.missing": "没有 ready key。请导入或生成一把 key。",
      "poker.home.sessionUnavailable.notReady": "active key 尚未就绪，请等待 backfill 完成。",
      "poker.home.sessionUnavailable.noActiveHash": "没有 active hash。请选择单一 active key。",
      "poker.home.sessionUnavailable.subHint":
        "Poker 需要单一 active key，请切换回单一 key 模式或解锁钱包。",
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
      "poker.lobby.sessionUnavailable.default.title": "扑克会话不可用",
      "poker.lobby.sessionUnavailable.default.hint": "切换到单一 active key 后即可查看桌局与在线玩家。",
      "poker.lobby.sessionUnavailable.allMode.title": "全部 key 模式已开启",
      "poker.lobby.sessionUnavailable.allMode.hint": "Poker 需要单一 active key，请切换回单一 key 模式。",
      "poker.lobby.sessionUnavailable.vaultLocked.title": "钱包未解锁",
      "poker.lobby.sessionUnavailable.vaultLocked.hint": "解锁钱包后即可查看桌局与在线玩家。",
      "poker.lobby.sessionUnavailable.missing.title": "没有 ready key",
      "poker.lobby.sessionUnavailable.missing.hint": "请导入或生成一把 key。",
      "poker.lobby.sessionUnavailable.notReady.title": "active key 尚未就绪",
      "poker.lobby.sessionUnavailable.notReady.hint": "等待 backfill 完成后重新加载。",
      "poker.lobby.sessionUnavailable.noActiveHash.title": "未选择 active key",
      "poker.lobby.sessionUnavailable.noActiveHash.hint": "选择单一 active key 后即可启用 Poker。",
      "poker.table.title": "扑克桌",
      "poker.table.back": "返回大厅",
      "poker.table.notJoined": "尚未加入该桌",
      "poker.table.topic": "Topic",
      "poker.table.subscribe": "订阅",
      "poker.table.joined": "已加入",
      "poker.table.txEvents": "Tx 事件",
      "poker.table.frames": "帧",
      "poker.table.protocolOnly": "纯协议页。牌局状态渲染留到后续硬切换。",
      "poker.table.activeKeyChanged": "active key 已变更，旧会话已关闭，请用新身份重新进入。",
      "poker.table.sessionUnavailable.default": "扑克会话不可用，请打开扑克设置。",
      "poker.table.sessionUnavailable.allMode": "全部 key 模式已开启，请切换到单一 active key。",
      "poker.table.sessionUnavailable.vaultLocked": "钱包未解锁，请解锁后使用 Poker。",
      "poker.table.sessionUnavailable.missing": "没有 ready key，请导入或生成一把 key。",
      "poker.table.sessionUnavailable.notReady": "active key 尚未就绪，请等待 backfill 完成。",
      "poker.table.sessionUnavailable.noActiveHash": "没有 active hash，请选择单一 active key。",
      "poker.err.notReady": "代理尚未就绪",
      "poker.err.locked": "钱包未解锁"
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
