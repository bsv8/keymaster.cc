// packages/plugin-appmsg/src/manifest.ts
// 应用消息总线平台插件（plugin-appmsg）。
//
// 设计缘由（施工单 2026-07-01 002 硬切换）：
//   - 单例真值层：HubMsg WSS 连接 + 本地缓存 + 推送分发；
//   - 提供 `appmsg.core` capability：origin / plugin 端点通用；
//   - 在 owner 切换 / vault 锁状态变化时驱动 reconnect；
//   - 通过 capability 总线，**不**允许插件伪造外部 `request` 绕过内部
//     能力；plugin 必须经 capability 入口才能发 / 列 / 取消息。
//   - meta.kind = "platform"：默认启用、不可禁用（与 protocol 同级）。
//   - **不**做持久化：v1 仅内存缓存；HubMsg 协议层自己负责持久化。

import type {
  AppMsgCore,
  AppMsgEndpoint,
  AppMsgInboxDirtyEvent,
  AppMsgListBox,
  AppMsgListResult,
  AppMsgMessage,
  AppMsgPluginClient,
  AppMsgSendResult,
  BreadcrumbRegistry,
  I18nPluginResources,
  KeyspaceService,
  MenuRegistry,
  PluginContext,
  PluginManifest,
  PluginLogger,
  RouteRegistry,
  VaultService
} from "@keymaster/contracts";
import {
  APPMESSAGE_CLIENT_CAPABILITY,
  APPMESSAGE_CORE_CAPABILITY
} from "@keymaster/contracts";
import { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";
import { AppMsgPluginClientImpl } from "./pluginClient.js";
import { AppMsgSystemPage } from "./AppMsgSystemPage.js";
import { signCompactSecp256k1 } from "./signing.js";

/** plugin-appmsg 平台插件 id。 */
export const APPMSG_PLUGIN_ID = "appmsg";

/** HubMsg WSS 入口。V1 固定单 WSS；装配层可通过环境变量覆盖（v1 不做）。 */
const DEFAULT_HUBMSG_URL = "wss://hubmsg.local/ws/v1";

const appmsgResources: I18nPluginResources = {
  namespace: "appmsg",
  resources: {
    en: {
      "appmsg.platform.title": "Application Messages",
      "appmsg.platform.desc":
        "Bridges between local apps / plugins and the centralized HubMsg service.",
      /* ============== 施工单 2026-07-02 001：系统级诊断页文案 ============== */
      "appmsg.system.title": "Message system",
      "appmsg.system.description":
        "Connection status and per-channel message counts. Read-only diagnostics; no message body is shown here.",
      "appmsg.system.menu": "Message system",
      "appmsg.system.breadcrumb": "Message system",
      "appmsg.system.status.label": "State",
      "appmsg.system.status.bound": "bound",
      "appmsg.system.status.connecting": "connecting",
      "appmsg.system.status.closed": "closed",
      "appmsg.system.status.disconnected": "disconnected",
      "appmsg.system.status.no_owner": "no owner (vault locked)",
      "appmsg.system.status.ok": "OK",
      "appmsg.system.status.partialFailed": "Partial",
      "appmsg.system.status.failed": "Failed",
      "appmsg.system.owner": "Owner",
      "appmsg.system.url": "HubMsg URL",
      "appmsg.system.lastBoundAt": "Last bound at",
      "appmsg.system.lastReceivedAt": "Last received at",
      "appmsg.system.lastError": "Last error",
      "appmsg.system.counts.kind": "Kind",
      "appmsg.system.counts.channel": "Channel",
      "appmsg.system.counts.source": "Source",
      "appmsg.system.counts.source.hubmsg-origins": "HubMsg origin history",
      "appmsg.system.counts.source.plugin-endpoint": "Plugin endpoint",
      "appmsg.system.counts.inbox": "Inbox",
      "appmsg.system.counts.sent": "Sent",
      "appmsg.system.counts.all": "All",
      "appmsg.system.counts.lastRefreshed": "Last refreshed",
      "appmsg.system.counts.status": "Status",
      "appmsg.system.counts.refresh": "Refresh",
      "appmsg.system.counts.refreshing": "Refreshing…",
      "appmsg.system.rowStatus.ok": "ok",
      "appmsg.system.rowStatus.stale": "stale",
      "appmsg.system.rowStatus.failed": "failed: {{error}}",
      "appmsg.system.empty": "No known channels for the current owner.",
      "appmsg.system.lockedHint":
        "Unlock the Vault to see per-channel counts. The last successful snapshot, if any, is shown with a stale marker."
    },
    "zh-CN": {
      "appmsg.platform.title": "应用消息总线",
      "appmsg.platform.desc": "连接本地应用 / 插件与中心化 HubMsg 服务。",
      "appmsg.system.title": "消息系统",
      "appmsg.system.description":
        "连接状态 + 各渠道消息数量。只读诊断页；这里**不**显示任何消息正文。",
      "appmsg.system.menu": "消息系统",
      "appmsg.system.breadcrumb": "消息系统",
      "appmsg.system.status.label": "状态",
      "appmsg.system.status.bound": "已绑定",
      "appmsg.system.status.connecting": "连接中",
      "appmsg.system.status.closed": "已关闭",
      "appmsg.system.status.disconnected": "未连接",
      "appmsg.system.status.no_owner": "无 owner（Vault 锁定）",
      "appmsg.system.status.ok": "正常",
      "appmsg.system.status.partialFailed": "部分失败",
      "appmsg.system.status.failed": "失败",
      "appmsg.system.owner": "Owner",
      "appmsg.system.url": "HubMsg URL",
      "appmsg.system.lastBoundAt": "最近一次成功 bind",
      "appmsg.system.lastReceivedAt": "最近一次收到消息",
      "appmsg.system.lastError": "最近一次错误",
      "appmsg.system.counts.kind": "类型",
      "appmsg.system.counts.channel": "渠道",
      "appmsg.system.counts.source": "来源",
      "appmsg.system.counts.source.hubmsg-origins": "HubMsg 历史 origin",
      "appmsg.system.counts.source.plugin-endpoint": "插件端点",
      "appmsg.system.counts.inbox": "收件",
      "appmsg.system.counts.sent": "发件",
      "appmsg.system.counts.all": "总数",
      "appmsg.system.counts.lastRefreshed": "最近刷新",
      "appmsg.system.counts.status": "状态",
      "appmsg.system.counts.refresh": "刷新",
      "appmsg.system.counts.refreshing": "刷新中…",
      "appmsg.system.rowStatus.ok": "正常",
      "appmsg.system.rowStatus.stale": "陈旧",
      "appmsg.system.rowStatus.failed": "失败：{{error}}",
      "appmsg.system.empty": "当前 owner 没有已知渠道。",
      "appmsg.system.lockedHint":
        "解锁 Vault 后才能看到各渠道数量。保留的上次成功快照会用 stale 标记。"
    }
  }
};

/** plugin host 在 setup 阶段暴露给 plugin 的最小 ctx 形状。 */
type PluginContextLike = Pick<PluginContext, "logger">;

/**
 * 平台插件 manifest。
 *
 * 设计要点：
 *   - 不直接依赖 plugin-protocol；protocolService 在 setup 后通过
 *     capability 总线反向消费 `appmsg.core`；
 *   - 依赖 vault.service / keyspace.service 用于借 owner 私钥签名；
 *   - 通过订阅 keyspace.onActiveChange + vault.onStatusChange 驱动 reconnect。
 *   - 自身注册 `/system/messages` 路由 + `group="system"` 菜单项（施工单
 *     2026-07-02 001）。这个页面是系统级诊断页，归属 plugin-appmsg；
 *     它通过 `appmsg.core.inspectConnection / listKnownOrigins /
 *     countScopes` 直接与 HubMsg 内部 RPC 通信，**不**走 protocol popup
 *     路径，也不读取 connect session 真值。
 */
export const appmsgPlatformPlugin: PluginManifest = {
  id: APPMSG_PLUGIN_ID,
  name: "Application Messages",
  description: "HubMsg WSS 应用消息总线：appmsg.core 平台单例 + appmsg.client scoped client。",
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: [APPMESSAGE_CORE_CAPABILITY],
    displayGroup: "platform"
  },
  i18n: appmsgResources,
  dependencies: [
    { capability: "vault.service", reason: "借 owner 私钥签 HubMsg client_bind" },
    { capability: "keyspace.service", reason: "解析 owner publicKeyHex" },
    { capability: "route.registry", reason: "注册 /system/messages 诊断页路由" },
    { capability: "menu.registry", reason: "注册 system 分组下「消息系统」菜单项" },
    { capability: "breadcrumb.registry", reason: "为 /system/messages 提供面包屑" }
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
        if (!key || !key.keyId || !key.publicKeyHex) return null;
        const pubHex: string = key.publicKeyHex;
        return await vault.withPrivateKey(key.keyId, async (material) => ({
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
      logger: {
        // 平台内部 logger bridge：把 core 内部 emitLog 输出的对象
        // 转换为 ctx.logger 调用。
        //
        // 关键（施工单 2026-07-02 001）：必须保留 input.event 真值
        // （如 `appmsg.connect.begin` / `appmsg.send.failed` / ...），
        // 不能硬写成级别名 `info/warn/error`——否则 `/settings/logs`
        // 按 event 检索会失配，验收项 8.1（pluginId=appmsg + event 名
        // 检索）做不出来。
        //
        // 兜底：input 不是对象 / 没有 event 字段时，回退到该级别名
        // 自身，保持向前兼容。
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
     * scoped `appmsg.client` 注入由 runtime host 在 enable 阶段完成
     * （施工单 2026-07-01/003）：host 按 `<pluginId>.appmsg.client`
     * 形 key 注入 sender 已绑定的 client；**不**在 plugin-appmsg
     * 平台单例里再暴露一个"全局工厂 capability + 手动 forEndpoint()"
     * 路径——这条 UX 不再是插件作者最终体验。
     *
     * plugin-appmsg 这里**只**挂 `APPMESSAGE_CORE_CAPABILITY`（平台单例）；
     * scoped client 由 host（`packages/runtime/src/createPluginHost.ts`）
     * 在 enable 完成后自动 provide。
     */

    /**
     * 订阅 owner / vault 变化驱动 reconnect。
     *
     * 设计缘由：
     *   - 同一个 owner 不需要 reconnect（幂等返回）；
     *   - owner 变化：先 disconnect 旧连接再 connect 新连接；
     *   - vault relock 时不允许发 / 列消息（关闭连接）；unlock 后
     *     再尝试重连（如果 keyspace 仍有 ready key）。
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

    // plugin-appmsg 在 setup 结束后立即尝试一次 connect（best-effort）：
    // 如果 vault 已解锁且有 active key，立即建立连接。
    tryReconnect();

    /* ============== 施工单 2026-07-02 001：注册系统级诊断页 ============== */
    // 路由 + 菜单 + 面包屑：平台插件自注册，不走 settings.registry。
    // - route id "appmsg.system.messages"（全局唯一）
    // - menu group "system"（分类键；展示文案由 Sidebar 走 i18n 解析）
    // - breadcrumb 第一段固定为 "系统"（与 menu group 同 key 的 i18n 解析）
    const routes = ctx.get<RouteRegistry>("route.registry");
    const menus = ctx.get<MenuRegistry>("menu.registry");
    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");

    routes.register({
      id: "appmsg.system.messages",
      path: "/system/messages",
      label: { key: "appmsg.system.title", fallback: "Message system" },
      component: AppMsgSystemPage,
      inMenu: true,
      menuGroup: "system",
      order: 10,
      icon: "MessagesSquare"
    });
    menus.register({
      id: "appmsg.system.messages.menu",
      label: { key: "appmsg.system.menu", fallback: "Message system" },
      path: "/system/messages",
      group: "system",
      order: 10,
      icon: "MessagesSquare"
    });
    breadcrumbs.register({
      id: "appmsg.system.messages.crumbs",
      order: 5,
      match: (path) => path === "/system/messages",
      resolve: () => [
        // 第一段：与 menu group "system" 共享 i18n key（Sidebar
        // 走 `shell.menu.group.system` 解析，breadcrumb 这里
        // 走 `appmsg.system.breadcrumb` 解析；二者同语义、当前
        // 翻译一致）。保留两份 key 是为了让 sidebar 跟 breadcrumb
        // 各自走自己的 i18n 通道，避免互相耦合。
        { label: { key: "appmsg.system.breadcrumb", fallback: "Message system" } }
      ]
    });

    return () => {
      unsubActive();
      unsubVault?.();
      void core.disconnect();
    };
  }
};

/**
 * scoped `appmsg.client` 工厂类型。
 *
 * runtime 在 setup 阶段对声明了 `appMessageEndpoint.endpointId` 的插件
 * 注入：scoped client 由 host 直接挂到 `<pluginId>.appmsg.client`，
 * 插件作者**不**需要 `forEndpoint()`。
 */
// 仅用于内部引用；contracts 已经导出同名接口，这里 re-export 便于上层统一 import。
export type { AppMsgEndpoint, AppMsgInboxDirtyEvent, AppMsgListBox, AppMsgListResult, AppMsgMessage, AppMsgSendResult };