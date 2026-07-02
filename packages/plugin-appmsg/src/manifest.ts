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
  I18nPluginResources,
  KeyspaceService,
  PluginContext,
  PluginManifest,
  PluginLogger,
  VaultService
} from "@keymaster/contracts";
import {
  APPMESSAGE_CLIENT_CAPABILITY,
  APPMESSAGE_CORE_CAPABILITY
} from "@keymaster/contracts";
import { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";
import { AppMsgPluginClientImpl } from "./pluginClient.js";
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
        "Bridges between local apps / plugins and the centralized HubMsg service."
    },
    "zh-CN": {
      "appmsg.platform.title": "应用消息总线",
      "appmsg.platform.desc": "连接本地应用 / 插件与中心化 HubMsg 服务。"
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
    { capability: "keyspace.service", reason: "解析 owner publicKeyHex" }
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
        info: (input) =>
          ctx.logger.info({
            scope: "appmsg.core",
            event: "info",
            message: "",
            data: input as Record<string, unknown>
          }),
        warn: (input) =>
          ctx.logger.warn({
            scope: "appmsg.core",
            event: "warn",
            message: "",
            data: input as Record<string, unknown>
          }),
        error: (input) =>
          ctx.logger.error({
            scope: "appmsg.core",
            event: "error",
            message: "",
            data: input as Record<string, unknown>
          })
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