// packages/plugin-broadcast/src/manifest.ts
// 广播子系统平台插件 manifest（施工单 2026-07-06 001 硬切换）。
//
// 设计缘由：
//   - 平台中心：plugin-broadcast 持有唯一的 `BroadcastCoreImpl` 单例，
//     提供：
//       * `broadcast.core` capability（平台逻辑中心）
//       * `broadcast.provider.registry` capability（plugin-hubcast
//         register 自身用）
//   - **plugin-broadcast 不再 import plugin-appmsg / plugin-hubmsg 的
//     任何类型**——与 appmsg 系统硬隔离；
//   - 在 setup 阶段依赖 `vault.service` / `keyspace.service`，订阅
//     vault status + keyspace active key 变化，由内部 reconnect 协调
//     器驱动绑定；
//   - **不**注册路由 / 菜单 / 面包屑：本次广播系统先不带管理页；
//   - 依赖顺序：`plugin-broadcast` 必须在 `plugin-hubcast` 之前装载。
//   - **不**依赖 `plugin-appmsg`、**不**与 `plugin-appmsg` 互相 import。

import type {
  BroadcastCore,
  BroadcastProviderRegistry,
  I18nPluginResources,
  KeyspaceService,
  PluginManifest,
  VaultService
} from "@keymaster/contracts";
import {
  BROADCAST_CORE_CAPABILITY,
  BROADCAST_PROVIDER_REGISTRY_CAPABILITY
} from "@keymaster/contracts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  BroadcastCoreImpl,
  type BroadcastCoreConfig,
  type BroadcastSignerContext
} from "./broadcastCore.js";
import { createReconnectCoordinator } from "./reconnectCoordinator.js";

/**
 * 通用 secp256k1 签名原语：与 plugin-appmsg::signChallengeWithSecp256k1
 * 等价。
 *
 * 本插件**不**依赖 plugin-appmsg 的内部模块；签名工具直接复刻一份，
 * 保持广播系统与消息系统硬隔离。
 */
function signChallengeWithSecp256k1(
  privKeyHex: string,
  challenge: Uint8Array
): string {
  if (typeof privKeyHex !== "string" || privKeyHex.length !== 64) {
    throw new Error("signChallengeWithSecp256k1: privKeyHex must be 32-byte hex");
  }
  if (!(challenge instanceof Uint8Array)) {
    throw new Error("signChallengeWithSecp256k1: challenge must be Uint8Array");
  }
  const privBytes = hexToBytes(privKeyHex);
  const digest = sha256(challenge);
  const sig = secp256k1.sign(digest, privBytes, { prehash: false, format: "compact" });
  if (sig.length !== 64) {
    throw new Error("signChallengeWithSecp256k1: compact signature must be 64 bytes");
  }
  return bytesToHex(sig);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return s;
}

/** plugin-broadcast 平台插件 id。 */
export const BROADCAST_PLUGIN_ID = "broadcast";

/** plugin-broadcast i18n 资源（v1 暂未启用任何文案；保留 namespace）。 */
const broadcastResources: I18nPluginResources = {
  namespace: "broadcast",
  resources: {
    en: {},
    "zh-CN": {}
  }
};

/**
 * 平台插件 manifest。
 *
 * 装载顺序（apps/web/src/bootstrapPlugins.ts）：
 *   vault → broadcast → hubcast → appmsg → hubmsg → ...
 *
 * 关键约束：
 *   - `plugin-broadcast` 必须在 `plugin-hubcast` 之前装载（hubcast 依赖
 *     `broadcast.provider.registry`）；
 *   - `plugin-broadcast` 与 `plugin-appmsg` **互不依赖**；
 *   - 本插件**不**注册路由 / 菜单 / 面包屑；v1 不带管理页。
 */
export const broadcastPlatformPlugin: PluginManifest = {
  id: BROADCAST_PLUGIN_ID,
  name: "Broadcast",
  description:
    "Broadcast platform plugin: broadcast.core + provider registry + local subscription union + signed envelope verify/distribute + 固定延迟重连。",
  i18n: broadcastResources,
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: [
      BROADCAST_CORE_CAPABILITY,
      BROADCAST_PROVIDER_REGISTRY_CAPABILITY
    ],
    displayGroup: "platform"
  },
  dependencies: [
    { capability: "vault.service", reason: "借 owner 私钥签 broadcast envelope" },
    {
      capability: "keyspace.service",
      reason: "解析 owner publicKeyHex / 监听 active key 变化"
    }
  ],
  setup(ctx) {
    const vault = ctx.get<VaultService>("vault.service");
    const keyspace = ctx.get<KeyspaceService>("keyspace.service");

    /**
     * signer provider：plugin-broadcast 不持有 owner 私钥；通过闭包从
     * keyspace + vault 借出 owner 私钥 hex 完成 secp256k1 签名。
     *
     * 失败语义（vault locked / 无 active key）：返回 null；core 内部
     * 不抛错，仅记日志，等待下次 owner 切换 / unlock 时再重试。
     *
     * 通用性：signer 只承诺"用 owner 私钥对任意 `challenge` 字节做
     * secp256k1 (SHA-256 + compact 64-byte) 签名"，**不**夹带任何
     * provider 协议字段；HubCast 自己的 bind 拼接规则下沉到
     * `plugin-hubcast`。
     */
    const signerProvider: BroadcastCoreConfig["signerProvider"] = async () => {
      try {
        const vaultStatus = vault.status();
        const active = keyspace.active().activePublicKeyHex ?? null;
        if (vaultStatus !== "unlocked") return null;
        if (!active) return null;
        const key = await keyspace.getKey(active);
        if (!key || !key.publicKeyHex) return null;
        const pubHex: string = key.publicKeyHex;
        return await vault.withPrivateKey(pubHex, async (material) => {
          return {
            publicKeyHex: pubHex,
            privateKeyHex: material.hex,
            signChallenge: async (args: { challenge: Uint8Array }): Promise<string> => {
              return signChallengeWithSecp256k1(material.hex, args.challenge);
            }
          } satisfies BroadcastSignerContext;
        });
      } catch (err) {
        ctx.logger.error({
          scope: "broadcast.core",
          event: "broadcast.signer_provider.failed",
          message: "failed to build signer",
          data: { err: err instanceof Error ? err.message : String(err) }
        });
        return null;
      }
    };

    const core = BroadcastCoreImpl.create({
      signerProvider,
      keyspace,
      vault,
      reconnectDelayMs: 5_000,
      logger: {
        info: (input: unknown) => {
          const obj = isRecord(input) ? input : {};
          ctx.logger.info({
            scope: "broadcast.core",
            event: typeof obj.event === "string" ? obj.event : "info",
            message: typeof obj.message === "string" ? obj.message : "",
            data: isRecord(obj.data) ? obj.data : undefined
          });
        },
        warn: (input: unknown) => {
          const obj = isRecord(input) ? input : {};
          ctx.logger.warn({
            scope: "broadcast.core",
            event: typeof obj.event === "string" ? obj.event : "warn",
            message: typeof obj.message === "string" ? obj.message : "",
            data: isRecord(obj.data) ? obj.data : undefined
          });
        },
        error: (input: unknown) => {
          const obj = isRecord(input) ? input : {};
          ctx.logger.error({
            scope: "broadcast.core",
            event: typeof obj.event === "string" ? obj.event : "error",
            message: typeof obj.message === "string" ? obj.message : "",
            data: isRecord(obj.data) ? obj.data : undefined
          });
        }
      }
    });

    ctx.provide<BroadcastCore>(BROADCAST_CORE_CAPABILITY, core);
    ctx.provide<BroadcastProviderRegistry>(
      BROADCAST_PROVIDER_REGISTRY_CAPABILITY,
      core.providers()
    );

    /**
     * 单一重连协调器（施工单 §6.3 + 反馈"必改"第二轮）。
     *
     * 实际逻辑落在 `reconnectCoordinator.ts`；本处只做依赖装配与
     * teardown 转发。
     */
    const coordinator = createReconnectCoordinator({
      core,
      vault,
      keyspace,
      reconnectDelayMs: 5_000,
      logger: {
        info: (input: unknown) => ctx.logger.info(asLogWrite(input)),
        warn: (input: unknown) => ctx.logger.warn(asLogWrite(input))
      }
    });

    return () => {
      coordinator.dispose();
      void core.disconnect();
    };
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

import type { LogWriteInput } from "@keymaster/contracts";

function asLogWrite(input: unknown): LogWriteInput {
  const obj = isRecord(input) ? input : {};
  return {
    scope: typeof obj.scope === "string" && obj.scope.length > 0 ? obj.scope : "broadcast.core",
    event: typeof obj.event === "string" && obj.event.length > 0 ? obj.event : "info",
    message: typeof obj.message === "string" ? obj.message : "",
    data: isRecord(obj.data) ? obj.data : undefined
  };
}