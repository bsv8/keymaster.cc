// packages/plugin-appmsg/src/manifest.ts
// 应用消息总线平台插件（plugin-appmsg）。
//
// 设计缘由（施工单 2026-07-03 001 硬切换）：
//   - 单例真值层：HubMsg WSS 连接 + key-scoped 本地 DB + 推送分发 +
//     增量同步 + 在线查询；
//   - 提供 `appmsg.core` capability；
//   - 通过订阅 keyspace.onActiveChange + vault.onStatusChange 驱动
//     reconnect；
//   - **不**再注册 `/system/messages` 路由 / 系统菜单 / 面包屑——
//     旧的远端 owner 诊断页 `AppMsgSystemPage` 已彻底删除（§5.5）；
//   - 系统消息应用走独立的 `plugin-message`（appId = `keymaster.message`），
//     不在 plugin-appmsg 内核再承担。
//   - meta.kind = "platform"：默认启用、不可禁用。
//   - key-scoped storage 声明：`storageId = "messages"` 由 plugin-appmsg
//     在 setup 阶段向 keyspace 注册，deleteKey 时由 keyspace 整体清理。

import type {
  AppMsgCore,
  KeyspaceService,
  PluginContext,
  PluginManifest,
  VaultService
} from "@keymaster/contracts";
import { APPMESSAGE_CORE_CAPABILITY } from "@keymaster/contracts";
import { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";
import type { HubMsgBindSigner } from "./hubmsgConnection.js";
import { signCompactSecp256k1 } from "./signing.js";

/** plugin-appmsg 平台插件 id。 */
export const APPMSG_PLUGIN_ID = "appmsg";

/** HubMsg WSS 入口。V1 固定单 WSS；装配层可通过环境变量覆盖（v1 不做）。 */
const DEFAULT_HUBMSG_URL = "wss://msg.keymaster.cc/ws/v1";

/**
 * 平台插件 manifest。
 *
 * 设计要点：
 *   - 在 setup 阶段向 keyspace 注册 `storageId = "messages"`，使 keyspace
 *     在 deleteKey 时能找到要删的 DB；
 *   - 不依赖 plugin-protocol；protocolService 在 setup 后通过 capability
 *     总线反向消费 `appmsg.core`；
 *   - scoped message client 注入由 runtime host 在 enable 阶段完成（构造时
 *     传入 `endpointId` + 当前 owner publicKeyHex）。
 */
export const appmsgPlatformPlugin: PluginManifest = {
  id: APPMSG_PLUGIN_ID,
  name: "Application Messages",
  description:
    "HubMsg 应用消息平台内核：appmsg.core 单例 + 本地消息库 + 推送分发 + 增量同步 + 在线查询。",
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

    return () => {
      unsubActive();
      unsubVault?.();
      void core.disconnect();
    };
  }
};

// 防止 IDE 报 unused
void (null as unknown as HubMsgBindSigner);
