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
    providesCapabilities: [APPMESSAGE_CORE_CAPABILITY, APPMESSAGE_CLIENT_CAPABILITY],
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
          sign: async (message: string): Promise<string> =>
            signCompactSecp256k1(material.hex, message)
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
     * scoped `appmsg.client` 工厂。
     *
     * 设计缘由：单一 capability 不易携带"plugin 专属 endpoint"参数；
     * 这里把 capability 暴露为一个工厂形态——插件拿到的对象提供
     * `forEndpoint(endpointId)` 方法；endpointId 必须在插件 manifest 的
     * `appMessageEndpoint.endpointId` 中声明，否则抛错（fail-closed）。
     *
     * 关键约束：
     *   - 插件**不**允许自报 endpoint；scoped 入口的 endpoint 由 runtime
     *     在注入时校验；
     *   - sender endpoint **不**进入插件入参：插件调 list / send / get
     *     时不传 sender，scoped 内部统一填 sender = { kind: "plugin",
     *     id: <endpointId> }。
     */
    ctx.provide<AppMsgPluginClientFactory>(
      APPMESSAGE_CLIENT_CAPABILITY,
      makePluginScopedClientFactory(core, ctx)
    );

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
 * 注入：插件 `ctx.get<AppMsgPluginClientFactory>(APPMESSAGE_CLIENT_CAPABILITY)`
 * 时拿到本工厂；再调 `forEndpoint(endpointId)` 取 scoped client。
 */
export interface AppMsgPluginClientFactory {
  /**
   * 取一个 sender endpoint 已绑定的 scoped `appmsg.client`。
   *
   * @param endpointId 插件 manifest `appMessageEndpoint.endpointId`。
   * @throws endpointId 非法 / 缺失时 fail-closed 抛错。
   */
  forEndpoint(endpointId: string): AppMsgPluginClient;
}

function makePluginScopedClientFactory(
  core: AppMsgCore,
  ctx: PluginContextLike
): AppMsgPluginClientFactory {
  return {
    forEndpoint(endpointId: string): AppMsgPluginClient {
      if (typeof endpointId !== "string" || endpointId.length === 0) {
        throw new Error("appmsg.client: endpointId is required");
      }
      // runtime 层在 plugin enable 阶段已校验 endpointId 全局唯一 + 合法形状；
      // 这里只做兜底：endpointId 非空。
      ctx.logger.info({
        scope: "appmsg.client",
        event: "client.created",
        message: "",
        data: { endpointId }
      });
      return new AppMsgPluginClientImpl(core, endpointId);
    }
  };
}

// 仅用于内部引用；contracts 已经导出同名接口，这里 re-export 便于上层统一 import。
export type { AppMsgEndpoint, AppMsgInboxDirtyEvent, AppMsgListBox, AppMsgListResult, AppMsgMessage, AppMsgSendResult };