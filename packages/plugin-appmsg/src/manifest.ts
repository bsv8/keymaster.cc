// packages/plugin-appmsg/src/manifest.ts
// 应用消息总线平台插件（plugin-appmsg）。
//
// 设计缘由（施工单 2026-07-03 002 硬切换）：
//   - 单例真值层：HubMsg WSS 连接 + key-scoped 本地 DB + 推送分发 +
//     增量同步 + 在线查询；
//   - 提供 `appmsg.core` capability；
//   - 通过订阅 keyspace.onActiveChange + vault.onStatusChange 驱动
//     reconnect；
//   - **本插件同时承担 HubMsg 管理面**：注册路由 `/system/hubmsg` +
//     system 分组菜单项 `HubMsg`；管理页直接消费 `appmsg.core` 的
//     平台 internal 全库能力（`listUnfilteredMessages` /
//     `subscribeUnfilteredMessages` / `triggerSync` / `listTargetSyncStates`
//     / `checkOnline` / `inspectLocalDb` 等）；
//   - 系统消息应用走独立的 `plugin-message`（appId = `keymaster.message`），
//     是一个普通 scoped 消息插件，**不**再走 `createSystemMessageClient`
//     特权旁路；
//   - meta.kind = "platform"：默认启用、不可禁用。
//   - key-scoped storage 声明：`storageId = "messages"` 由 plugin-appmsg
//     在 setup 阶段向 keyspace 注册，deleteKey 时由 keyspace 整体清理。

import type {
  AppMsgCore,
  I18nPluginResources,
  KeyspaceService,
  PluginContext,
  PluginManifest,
  VaultService
} from "@keymaster/contracts";
import { APPMESSAGE_CORE_CAPABILITY } from "@keymaster/contracts";
import { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";
import { HubMsgPage } from "./HubMsgPage.js";
import type { HubMsgBindSigner } from "./hubmsgConnection.js";
import { signCompactSecp256k1 } from "./signing.js";

/** plugin-appmsg 平台插件 id。 */
export const APPMSG_PLUGIN_ID = "appmsg";

/** HubMsg WSS 入口。V1 固定单 WSS；装配层可通过环境变量覆盖（v1 不做）。 */
const DEFAULT_HUBMSG_URL = "wss://msg.keymaster.cc/ws/v1";

/** HubMsg 管理页路由。 */
export const HUBMSG_ROUTE_PATH = "/system/hubmsg";

const hubmsgResources: I18nPluginResources = {
  namespace: "hubmsg",
  resources: {
    en: {
      "hubmsg.menu": "HubMsg",
      "hubmsg.breadcrumb": "HubMsg",
      "hubmsg.page.title": "HubMsg",
      "hubmsg.page.connection": "Connection",
      "hubmsg.page.connection.state": "State",
      "hubmsg.page.connection.state.idle": "Idle",
      "hubmsg.page.connection.state.open": "Open",
      "hubmsg.page.connection.state.closed": "Closed",
      "hubmsg.page.connection.owner": "Owner",
      "hubmsg.page.connection.url": "HubMsg URL",
      "hubmsg.page.connection.lastError": "Last error",
      "hubmsg.page.connection.lastError.none": "(none)",
      "hubmsg.page.sync": "Sync",
      "hubmsg.page.sync.targets": "Target sync states",
      "hubmsg.page.sync.targets.empty": "No sync targets yet.",
      "hubmsg.page.sync.target.lastSynced": "Last synced",
      "hubmsg.page.sync.target.lastReceived": "Last received",
      "hubmsg.page.sync.target.error": "Error",
      "hubmsg.page.sync.target.error.none": "(none)",
      "hubmsg.page.sync.trigger": "Trigger sync",
      "hubmsg.page.sync.trigger.done": "Sync triggered.",
      "hubmsg.page.sync.trigger.fail": "Sync failed.",
      "hubmsg.page.stats": "Statistics",
      "hubmsg.page.stats.total": "Total messages",
      "hubmsg.page.stats.byKey": "By target",
      "hubmsg.page.stats.byKey.empty": "(no messages)",
      "hubmsg.page.browse": "Local messages",
      "hubmsg.page.browse.search": "Filter by body",
      "hubmsg.page.browse.filter": "Filter by target",
      "hubmsg.page.browse.filter.all": "(all)",
      "hubmsg.page.browse.empty": "No local messages.",
      "hubmsg.page.online.label": "Online check",
      "hubmsg.page.online.placeholder": "publicKeyHex (66 hex chars)",
      "hubmsg.page.online.check": "Check online",
      "hubmsg.page.online.online": "online",
      "hubmsg.page.online.offline": "offline",
      "hubmsg.page.online.unknown": "unknown"
    },
    "zh-CN": {
      "hubmsg.menu": "HubMsg",
      "hubmsg.breadcrumb": "HubMsg",
      "hubmsg.page.title": "HubMsg",
      "hubmsg.page.connection": "连接",
      "hubmsg.page.connection.state": "状态",
      "hubmsg.page.connection.state.idle": "空闲",
      "hubmsg.page.connection.state.open": "已连接",
      "hubmsg.page.connection.state.closed": "已断开",
      "hubmsg.page.connection.owner": "Owner",
      "hubmsg.page.connection.url": "HubMsg URL",
      "hubmsg.page.connection.lastError": "最近错误",
      "hubmsg.page.connection.lastError.none": "（无）",
      "hubmsg.page.sync": "同步",
      "hubmsg.page.sync.targets": "目标同步状态",
      "hubmsg.page.sync.targets.empty": "暂无同步目标。",
      "hubmsg.page.sync.target.lastSynced": "最近同步",
      "hubmsg.page.sync.target.lastReceived": "最近收到",
      "hubmsg.page.sync.target.error": "错误",
      "hubmsg.page.sync.target.error.none": "（无）",
      "hubmsg.page.sync.trigger": "手动同步",
      "hubmsg.page.sync.trigger.done": "已触发同步。",
      "hubmsg.page.sync.trigger.fail": "同步失败。",
      "hubmsg.page.stats": "统计",
      "hubmsg.page.stats.total": "消息总数",
      "hubmsg.page.stats.byKey": "按目标分组",
      "hubmsg.page.stats.byKey.empty": "（无消息）",
      "hubmsg.page.browse": "本地消息浏览",
      "hubmsg.page.browse.search": "按正文过滤",
      "hubmsg.page.browse.filter": "按目标过滤",
      "hubmsg.page.browse.filter.all": "（全部）",
      "hubmsg.page.browse.empty": "本地暂无消息。",
      "hubmsg.page.online.label": "在线查询",
      "hubmsg.page.online.placeholder": "publicKeyHex (66 个 hex)",
      "hubmsg.page.online.check": "查询在线",
      "hubmsg.page.online.online": "在线",
      "hubmsg.page.online.offline": "离线",
      "hubmsg.page.online.unknown": "未知"
    }
  }
};

/**
 * 平台插件 manifest。
 *
 * 设计要点：
 *   - 在 setup 阶段向 keyspace 注册 `storageId = "messages"`，使 keyspace
 *     在 deleteKey 时能找到要删的 DB；
 *   - 不依赖 plugin-protocol；protocolService 在 setup 后通过 capability
 *     总线反向消费 `appmsg.core`；
 *   - scoped message client 注入由 runtime host 在 enable 阶段完成（构造时
 *     传入 `endpointId` + 当前 owner publicKeyHex）；
 *   - 同时承担 HubMsg 管理面：注册 `/system/hubmsg` 路由与 system 分组
 *     菜单项。
 */
export const appmsgPlatformPlugin: PluginManifest = {
  id: APPMSG_PLUGIN_ID,
  name: "Application Messages",
  description:
    "HubMsg 应用消息平台内核：appmsg.core 单例 + 本地消息库 + 推送分发 + 增量同步 + 在线查询 + HubMsg 管理页。",
  i18n: hubmsgResources,
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: [APPMESSAGE_CORE_CAPABILITY],
    displayGroup: "platform"
  },
  keyScopedStorages: [{ storageId: "messages", description: "Key-scoped appmsg local DB." }],
  dependencies: [
    { capability: "vault.service", reason: "借 owner 私钥签 HubMsg client_bind" },
    {
      capability: "keyspace.service",
      reason: "解析 owner publicKeyHex / 打开 key-scoped 本地 DB"
    },
    { capability: "route.registry", reason: "注册 /system/hubmsg 路由" },
    { capability: "menu.registry", reason: "注册 system 分组菜单项 HubMsg" },
    {
      capability: "breadcrumb.registry",
      reason: "为 /system/hubmsg 提供面包屑"
    }
  ],
  setup(ctx) {
    const vault = ctx.get<VaultService>("vault.service");
    const keyspace = ctx.get<KeyspaceService>("keyspace.service");

    /**
     * signer provider：plugin-appmsg 不持有 owner 私钥；通过闭包从
     * keyspace + vault 借出 owner 私钥 hex 完成签名。
     *
     * 失败语义（vault locked / 无 active key）：返回 null；core 内部
     * 不抛错，仅记日志，等待下次 owner 切换 / unlock 时再重试。
     */
    const signerProvider: AppMsgCoreConfig["signerProvider"] = async () => {
      try {
        if (vault.status() !== "unlocked") return null;
        const active = keyspace.active().activePublicKeyHex;
        if (!active) return null;
        const key = await keyspace.getKey(active);
        if (!key || !key.publicKeyHex) return null;
        const pubHex: string = key.publicKeyHex;
        return await vault.withPrivateKey(pubHex, async (material) => ({
          publicKeyHex: pubHex,
          sign: async (args: {
            sessionId: string;
            nonce: string;
            publicKeyHex: string;
            issuedAtMs: number;
          }): Promise<string> =>
            signCompactSecp256k1(
              material.hex,
              args.sessionId,
              args.nonce,
              args.publicKeyHex,
              args.issuedAtMs
            )
        }));
      } catch (err) {
        ctx.logger.error({
          scope: "appmsg.core",
          event: "signerProvider.failed",
          message: "failed to build signer",
          data: { err: err instanceof Error ? err.message : String(err) }
        });
        return null;
      }
    };

    const cfg: AppMsgCoreConfig = {
      url: DEFAULT_HUBMSG_URL,
      heartbeatSec: 30,
      signerProvider,
      keyspace,
      pluginId: APPMSG_PLUGIN_ID,
      storageId: "messages",
      logger: {
        // 平台内部 logger bridge：把 core 内部 emitLog 输出的对象
        // 转换为 ctx.logger 调用；保留 input.event 真值（如
        // `appmsg.connect.begin` / `appmsg.send.failed` / ...），不能
        // 硬写成 `info/warn/error`，否则 /settings/logs 按 event 检索会
        // 失配。
        info: (input) => {
          const obj = (input ?? {}) as Record<string, unknown>;
          const ev = typeof obj.event === "string" ? obj.event : "info";
          ctx.logger.info({
            scope: "appmsg.core",
            event: ev,
            message: "",
            data: obj
          });
        },
        warn: (input) => {
          const obj = (input ?? {}) as Record<string, unknown>;
          const ev = typeof obj.event === "string" ? obj.event : "warn";
          ctx.logger.warn({
            scope: "appmsg.core",
            event: ev,
            message: "",
            data: obj
          });
        },
        error: (input) => {
          const obj = (input ?? {}) as Record<string, unknown>;
          const ev = typeof obj.event === "string" ? obj.event : "error";
          ctx.logger.error({
            scope: "appmsg.core",
            event: ev,
            message: "",
            data: obj
          });
        }
      }
    };
    const core = new AppMsgCoreImpl(cfg);
    ctx.provide<AppMsgCore>(APPMESSAGE_CORE_CAPABILITY, core);

    /**
     * 订阅 owner / vault 变化驱动 reconnect。
     */
    let reconnectInFlight: Promise<void> | null = null;
    const tryReconnect = (): void => {
      if (reconnectInFlight) return;
      reconnectInFlight = (async () => {
        try {
          if (vault.status() !== "unlocked") {
            await core.disconnect();
            return;
          }
          const active = keyspace.active().activePublicKeyHex;
          if (!active) {
            await core.disconnect();
            return;
          }
          await core.connectForOwner(active);
        } catch (err) {
          ctx.logger.warn({
            scope: "appmsg.core",
            event: "tryReconnect.failed",
            message: "reconnect failed",
            data: { err: err instanceof Error ? err.message : String(err) }
          });
        } finally {
          reconnectInFlight = null;
        }
      })();
    };

    const unsubActive = keyspace.onActiveChange(() => tryReconnect());
    const unsubVault = vault.onStatusChange?.(() => tryReconnect());

    // plugin-appmsg 在 setup 结束后立即尝试一次 connect（best-effort）
    tryReconnect();

    /**
     * HubMsg 管理面：路由 / 菜单 / 面包屑。
     *
     * 本页是平台管理的"真值"——它直接消费 `appmsg.core` 的全库 / 状态
     * 能力，**不**再被任何 plugin facade 包装。`plugin-message` 是普通
     * 业务插件，**不**接触这条路径。
     */
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
      id: "appmsg.hubmsg",
      path: HUBMSG_ROUTE_PATH,
      label: { key: "hubmsg.page.title", fallback: "HubMsg" },
      component: HubMsgPage,
      inMenu: false
    });
    menus.register({
      id: "appmsg.hubmsg.menu",
      label: { key: "hubmsg.menu", fallback: "HubMsg" },
      path: HUBMSG_ROUTE_PATH,
      group: "system",
      order: 10,
      icon: "Radio"
    });
    breadcrumbs.register({
      id: "appmsg.hubmsg.crumbs",
      order: 4,
      match: (path) => path === HUBMSG_ROUTE_PATH,
      resolve: () => [
        { label: { key: "hubmsg.breadcrumb", fallback: "HubMsg" } }
      ]
    });

    return () => {
      unsubActive();
      unsubVault?.();
      void core.disconnect();
    };
  }
};

// 防止 IDE 报 unused
void (null as unknown as HubMsgBindSigner);
