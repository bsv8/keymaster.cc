// packages/plugin-appmsg/src/manifest.ts
// 应用消息总线平台插件（施工单 2026-07-04 001 硬切换）。
//
// 设计缘由：
//   - 系统中心：plugin-appmsg 持有唯一的 `AppMsgCoreImpl` 单例，提供：
//       * `appmsg.core` capability（platform internal）
//       * `message.provider.registry` capability（plugin-hubmsg / 未来其它
//         provider 注册用）
//       * `appmsg.endpoint.registry` capability（plugin-message 等业务
//         插件拿稳定 endpoint service 用）
//   - **plugin-appmsg 不再 import HubMsg 线协议实现**：所有 provider 相关
//     操作都通过 `MessageProvider` / `MessageProviderOperations` typed
//     接口。wire → public 翻译由 provider 内部完成；
//   - **active provider 持久化**：`message.provider.registry` 在构造时从
//     `localStorage.appmsg.activeProviderId` 读出持久值；用户切换时
//     同步回写；持久值不存在 / provider 不可用时进入 not-ready；
//   - **owner / provider 真值**：plugin-appmsg 内部订阅 keyspace + vault，
//     owner 真值变化时驱动 `core.connectForOwner(...)`；当前 owner 不
//     可用时自动 close；
//   - **管理面**：路由 `/system/appmsg`（不再是 `/system/hubmsg`），菜单
//     分组 `system` 改为系统名 `AppMsg`，**不**绑定到具体 provider；
//   - **i18n namespace**：`appmsg`（不再是 `hubmsg`），所有 key 一次性
//     迁移；
//   - **依赖顺序**：`plugin-appmsg` 必须在 `plugin-hubmsg` 之前装载
//     ——appmsg 提供 registry，hubmsg register 自身。

import type {
  AppMsgCore,
  I18nPluginResources,
  KeyspaceService,
  MessageProviderRegistry,
  PluginContext,
  PluginManifest,
  VaultService
} from "@keymaster/contracts";
import {
  APPMESSAGE_CORE_CAPABILITY,
  APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY,
  MESSAGE_PROVIDER_REGISTRY_CAPABILITY
} from "@keymaster/contracts";
import { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";
import { AppMsgPage } from "./AppMsgPage.js";
import type { AppMsgBindSigner } from "./appmsgCore.js";
import { createReconnectCoordinator } from "./reconnectCoordinator.js";

/** plugin-appmsg 平台插件 id。 */
export const APPMSG_PLUGIN_ID = "appmsg";

/** AppMsg 管理页路由。 */
export const APPMSG_ROUTE_PATH = "/system/appmsg";

const appmsgResources: I18nPluginResources = {
  namespace: "appmsg",
  resources: {
    en: {
      "appmsg.menu": "AppMsg",
      "appmsg.breadcrumb": "AppMsg",
      "appmsg.page.title": "AppMsg",
      "appmsg.page.provider.active": "Active provider",
      "appmsg.page.provider.none": "(no active message provider)",
      "appmsg.page.provider.id": "id",
      "appmsg.page.provider.name": "name",
      "appmsg.page.provider.health": "health",
      "appmsg.page.provider.health.ok": "healthy",
      "appmsg.page.provider.health.fail": "unhealthy",
      "appmsg.page.provider.lastError": "last error",
      "appmsg.page.providers.title": "Available providers",
      "appmsg.page.providers.empty": "No providers registered.",
      "appmsg.page.providers.name": "name",
      "appmsg.page.providers.actions": "actions",
      "appmsg.page.providers.active": "active",
      "appmsg.page.providers.activate": "activate",
      "appmsg.page.providers.switched": "switched",
      "appmsg.page.providers.switch.fail": "switch failed",
      "appmsg.page.connection": "Connection",
      "appmsg.page.connection.state": "state",
      "appmsg.page.connection.state.idle": "idle",
      "appmsg.page.connection.state.open": "open",
      "appmsg.page.connection.state.closed": "closed",
      "appmsg.page.connection.owner": "owner",
      "appmsg.page.connection.lastError": "last error",
      "appmsg.page.connection.lastError.none": "(none)",
      "appmsg.page.sync": "Sync",
      "appmsg.page.sync.targets": "Target sync states",
      "appmsg.page.sync.targets.empty": "No sync targets yet.",
      "appmsg.page.sync.target.lastSynced": "Last synced",
      "appmsg.page.sync.target.lastReceived": "Last received",
      "appmsg.page.sync.target.error": "Error",
      "appmsg.page.sync.target.error.none": "(none)",
      "appmsg.page.sync.trigger": "Trigger sync",
      "appmsg.page.sync.trigger.done": "Sync triggered.",
      "appmsg.page.sync.trigger.fail": "Sync failed.",
      "appmsg.page.stats": "Statistics",
      "appmsg.page.stats.total": "Total messages",
      "appmsg.page.stats.byKey": "By target",
      "appmsg.page.stats.byKey.empty": "(no messages)",
      "appmsg.page.browse": "Local messages",
      "appmsg.page.browse.search": "Filter by body",
      "appmsg.page.browse.filter": "Filter by target",
      "appmsg.page.browse.filter.all": "(all)",
      "appmsg.page.browse.empty": "No local messages.",
      "appmsg.page.online.label": "Online check",
      "appmsg.page.online.placeholder": "publicKeyHex (66 hex chars)",
      "appmsg.page.online.check": "Check online",
      "appmsg.page.online.online": "online",
      "appmsg.page.online.offline": "offline",
      "appmsg.page.online.unknown": "unknown"
    },
    "zh-CN": {
      "appmsg.menu": "AppMsg",
      "appmsg.breadcrumb": "AppMsg",
      "appmsg.page.title": "AppMsg",
      "appmsg.page.provider.active": "当前 provider",
      "appmsg.page.provider.none": "（未选择消息服务）",
      "appmsg.page.provider.id": "id",
      "appmsg.page.provider.name": "名称",
      "appmsg.page.provider.health": "健康",
      "appmsg.page.provider.health.ok": "正常",
      "appmsg.page.provider.health.fail": "异常",
      "appmsg.page.provider.lastError": "最近错误",
      "appmsg.page.providers.title": "已注册 provider",
      "appmsg.page.providers.empty": "暂无 provider 注册。",
      "appmsg.page.providers.name": "名称",
      "appmsg.page.providers.actions": "操作",
      "appmsg.page.providers.active": "当前",
      "appmsg.page.providers.activate": "切换",
      "appmsg.page.providers.switched": "已切换",
      "appmsg.page.providers.switch.fail": "切换失败",
      "appmsg.page.connection": "连接",
      "appmsg.page.connection.state": "状态",
      "appmsg.page.connection.state.idle": "空闲",
      "appmsg.page.connection.state.open": "已连接",
      "appmsg.page.connection.state.closed": "已断开",
      "appmsg.page.connection.owner": "owner",
      "appmsg.page.connection.lastError": "最近错误",
      "appmsg.page.connection.lastError.none": "（无）",
      "appmsg.page.sync": "同步",
      "appmsg.page.sync.targets": "目标同步状态",
      "appmsg.page.sync.targets.empty": "暂无同步目标。",
      "appmsg.page.sync.target.lastSynced": "最近同步",
      "appmsg.page.sync.target.lastReceived": "最近收到",
      "appmsg.page.sync.target.error": "错误",
      "appmsg.page.sync.target.error.none": "（无）",
      "appmsg.page.sync.trigger": "手动同步",
      "appmsg.page.sync.trigger.done": "已触发同步。",
      "appmsg.page.sync.trigger.fail": "同步失败。",
      "appmsg.page.stats": "统计",
      "appmsg.page.stats.total": "消息总数",
      "appmsg.page.stats.byKey": "按目标分组",
      "appmsg.page.stats.byKey.empty": "（无消息）",
      "appmsg.page.browse": "本地消息浏览",
      "appmsg.page.browse.search": "按正文过滤",
      "appmsg.page.browse.filter": "按目标过滤",
      "appmsg.page.browse.filter.all": "（全部）",
      "appmsg.page.browse.empty": "本地暂无消息。",
      "appmsg.page.online.label": "在线查询",
      "appmsg.page.online.placeholder": "publicKeyHex (66 个 hex)",
      "appmsg.page.online.check": "查询在线",
      "appmsg.page.online.online": "在线",
      "appmsg.page.online.offline": "离线",
      "appmsg.page.online.unknown": "未知"
    }
  }
};

/**
 * 平台插件 manifest。
 *
 * 设计要点：
 *   - **不**依赖 plugin-protocol；plugin-protocol 通过 `appmsg.core`
 *     capability 总线反向消费；
 *   - **不**依赖 plugin-hubmsg（registry 由 plugin-appmsg 自己 provide；
 *     plugin-hubmsg register 自身）；但 plugin-hubmsg 必须在 plugin-appmsg
 *     **之后**装载，详见 apps/web/src/bootstrapPlugins.ts；
 *   - key-scoped storage `storageId = "messages_v3"`：硬切换 001，旧
 *     `messages` DB 不迁移、不兼容读、不 fall through；
 *   - 在 setup 阶段向 keyspace 注册 `storageId = "messages_v3"`；
 *   - 同时承担 AppMsg 管理面：注册 `/system/appmsg` 路由与 system 分组
 *     菜单项 AppMsg；
 *   - meta.kind = "platform"：默认启用、不可禁用。
 */
export const appmsgPlatformPlugin: PluginManifest = {
  id: APPMSG_PLUGIN_ID,
  name: "Application Messages",
  description:
    "AppMsg 应用消息平台内核：appmsg.core 单例 + provider registry + 本地消息库 + endpoint service registry + 推送分发 + 增量同步 + 在线查询 + AppMsg 管理页。",
  i18n: appmsgResources,
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: [
      APPMESSAGE_CORE_CAPABILITY,
      MESSAGE_PROVIDER_REGISTRY_CAPABILITY,
      APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY
    ],
    displayGroup: "platform"
  },
  keyScopedStorages: [{ storageId: "messages_v3", description: "Key-scoped appmsg local DB (v2; messages_v1 abandoned)." }],
  dependencies: [
    { capability: "vault.service", reason: "借 owner 私钥签 provider bind" },
    {
      capability: "keyspace.service",
      reason: "解析 owner publicKeyHex / 打开 key-scoped 本地 DB"
    },
    { capability: "route.registry", reason: "注册 /system/appmsg 路由" },
    { capability: "menu.registry", reason: "注册 system 分组菜单项 AppMsg" },
    {
      capability: "breadcrumb.registry",
      reason: "为 /system/appmsg 提供面包屑"
    }
  ],
  setup(ctx) {
    const vault = ctx.get<VaultService>("vault.service");
    const keyspace = ctx.get<KeyspaceService>("keyspace.service");

    /**
     * signer provider：plugin-appmsg 不持有 owner 私钥；通过闭包从
     * keyspace + vault 借出 owner 私钥 hex 完成通用 secp256k1 签名。
     *
     * 失败语义（vault locked / 无 active key）：返回 null；core 内部
     * 不抛错，仅记日志，等待下次 owner 切换 / unlock 时再重试。
     *
     * 通用性（硬切换 2026-07-04 001 修订）：
     *   - 本闭包只承诺"用 owner 私钥对任意 `challenge` 字节做
     *     secp256k1 (SHA-256 + compact 64-byte) 签名"，**不**夹带
     *     任何具体 provider 的协议字段；
     *   - HubMsg 自己的四元组拼接规则（canonicalBindText）下沉到
     *     `plugin-hubmsg`，由 `HubMsgBindSignerAdapter` 完成；
     *   - 其它 provider（未来）可使用任意 `challenge` 字节内容，
     *     signer 不关心 provider 协议。
     */
    const signerProvider: AppMsgCoreConfig["signerProvider"] = async () => {
      try {
        if (vault.status() !== "unlocked") return null;
        const active = keyspace.active().activePublicKeyHex;
        if (!active) return null;
        const key = await keyspace.getKey(active);
        if (!key || !key.publicKeyHex) return null;
        const pubHex: string = key.publicKeyHex;
        return await vault.withPrivateKey(pubHex, async (material) => {
          const { signChallengeWithSecp256k1 } = await import("./signer.js");
          return {
            publicKeyHex: pubHex,
            privateKeyHex: material.hex,
            signChallenge: async (args: {
              challenge: Uint8Array;
            }): Promise<string> => {
              return signChallengeWithSecp256k1(material.hex, args.challenge);
            }
          };
        });
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
      signerProvider,
      keyspace,
      pluginId: APPMSG_PLUGIN_ID,
      storageId: "messages_v3",
      // localStorage 仅在浏览器环境可用；非浏览器（测试）走 null，registry
      // 会跳过持久化但仍按 in-memory 状态运行。
      localStorage:
        typeof globalThis !== "undefined" &&
        typeof (globalThis as { localStorage?: Storage }).localStorage !== "undefined"
          ? (globalThis as { localStorage: Storage }).localStorage
          : null,
      logger: {
        info: (input) => {
          const obj = (input ?? {}) as Record<string, unknown>;
          const ev = typeof obj.event === "string" ? obj.event : "info";
          ctx.logger.info({ scope: "appmsg.core", event: ev, message: "", data: obj });
        },
        warn: (input) => {
          const obj = (input ?? {}) as Record<string, unknown>;
          const ev = typeof obj.event === "string" ? obj.event : "warn";
          ctx.logger.warn({ scope: "appmsg.core", event: ev, message: "", data: obj });
        },
        error: (input) => {
          const obj = (input ?? {}) as Record<string, unknown>;
          const ev = typeof obj.event === "string" ? obj.event : "error";
          ctx.logger.error({ scope: "appmsg.core", event: ev, message: "", data: obj });
        }
      }
    };
    const core = new AppMsgCoreImpl(cfg);
    ctx.provide<AppMsgCore>(APPMESSAGE_CORE_CAPABILITY, core);
    ctx.provide<MessageProviderRegistry>(
      MESSAGE_PROVIDER_REGISTRY_CAPABILITY,
      core.providers()
    );
    ctx.provide(APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY, core.endpointRegistry());

    /**
     * 单一重连协调器（施工单 2026-07-04 003 硬切换 + 反馈"必改"第二轮）。
     *
     * 实际逻辑落在 `reconnectCoordinator.ts`；本处只做依赖装配与
     * teardown 转发。独立抽离的理由：协调器是连接生命周期真值拥有
     * 者，必须可被单测覆盖完整路径（5s 重试 / 远端断线 / 切
     * provider / 锁定取消 / 切 key 等）。
     */
    const coordinator = createReconnectCoordinator({
      core,
      vault,
      keyspace,
      logger: {
        info: (input) => {
          const obj = input as unknown as Record<string, unknown>;
          const ev = typeof obj.event === "string" ? obj.event : "info";
          ctx.logger.info({
            scope: "appmsg.core",
            event: ev,
            message: "",
            data: obj
          });
        },
        warn: (input) => {
          const obj = input as unknown as Record<string, unknown>;
          const ev = typeof obj.event === "string" ? obj.event : "warn";
          ctx.logger.warn({
            scope: "appmsg.core",
            event: ev,
            message: "",
            data: obj
          });
        }
      }
    });

    /**
     * AppMsg 管理面：路由 / 菜单 / 面包屑。
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
      id: "appmsg.system",
      path: APPMSG_ROUTE_PATH,
      label: { key: "appmsg.page.title", fallback: "AppMsg" },
      component: AppMsgPage,
      inMenu: false
    });
    menus.register({
      id: "appmsg.system.menu",
      label: { key: "appmsg.menu", fallback: "AppMsg" },
      path: APPMSG_ROUTE_PATH,
      group: "system",
      order: 10,
      icon: "Radio"
    });
    breadcrumbs.register({
      id: "appmsg.system.crumbs",
      order: 4,
      match: (path) => path === APPMSG_ROUTE_PATH,
      resolve: () => [{ label: { key: "appmsg.breadcrumb", fallback: "AppMsg" } }]
    });

    return () => {
      coordinator.dispose();
      void core.disconnect();
    };
  }
};

// 防止 IDE 报 unused
void (null as unknown as AppMsgBindSigner);