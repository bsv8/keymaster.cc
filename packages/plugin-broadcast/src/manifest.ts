// packages/plugin-broadcast/src/manifest.ts
// 广播子系统平台插件 manifest（施工单 2026-07-06 001 硬切换 + 2026-07-08 001 硬切换）。
//
// 设计缘由（2026-07-08 001 增量）：
//   - 平台中心保持：plugin-broadcast 持有唯一的 `BroadcastCoreImpl` 单例；
//   - 本次新增：
//       * active provider id 持久化（localStorage）
//       * `/system/broadcast` 管理页路由 + 菜单 + 面包屑
//       * 默认 active provider 自动激活（hubcast 注册后即"平台默认"）
//   - **plugin-broadcast 不再 import plugin-appmsg / plugin-hubmsg 的
//     任何类型**——与 appmsg 系统硬隔离；
//   - 在 setup 阶段依赖 `vault.service` / `keyspace.service`，订阅
//     vault status + keyspace active key 变化，由内部 reconnect 协调
//     器驱动绑定；
//   - 依赖顺序：`plugin-broadcast` 必须在 `plugin-hubcast` 之前装载。
//   - **不**依赖 `plugin-appmsg`、**不**与 `plugin-appmsg` 互相 import。

import type {
  BroadcastCore,
  BroadcastCoreSnapshot,
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
  type BroadcastSignerContext,
  type StorageLike
} from "./broadcastCore.js";
import { createReconnectCoordinator } from "./reconnectCoordinator.js";
import { BroadcastPage } from "./BroadcastPage.js";
import { createBroadcastService } from "./broadcastService.js";

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

/**
 * 内存 storage 兜底（SSR / Node 测试用）。
 *
 * 设计缘由（施工单 §7.2.2）：
 *   - 浏览器环境注入真实 `window.localStorage`；
 *   - 兜底实现避免核心代码受空指针影响；
 *   - 测试可在装配前替换为更可控的实现。
 */
function makeMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    }
  };
}

/**
 * 浏览器环境 storage 适配。
 *
 * 失败语义：API 抛错或 storage 被禁用时，所有方法 silently no-op；
 * core 内部走 userCleared / activeSnapshot 路径降级。
 */
function makeBrowserStorage(): StorageLike {
  return {
    getItem: (k) => {
      try {
        return globalThis.localStorage?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        globalThis.localStorage?.setItem(k, v);
      } catch {
        // ignore
      }
    },
    removeItem: (k) => {
      try {
        globalThis.localStorage?.removeItem(k);
      } catch {
        // ignore
      }
    }
  };
}

/** plugin-broadcast 平台插件 id。 */
export const BROADCAST_PLUGIN_ID = "broadcast";

/** plugin-broadcast i18n 资源（管理页文案）。 */
const broadcastResources: I18nPluginResources = {
  namespace: "broadcast",
  resources: {
    en: {
      "broadcast.menu": "Broadcast",
      "broadcast.breadcrumb": "Broadcast",
      "broadcast.page.title": "Broadcast system",
      "broadcast.page.activeProvider": "Active provider",
      "broadcast.page.activeProvider.none": "(none)",
      "broadcast.page.providerList": "Registered providers",
      "broadcast.page.providerList.empty": "No providers registered.",
      "broadcast.page.connection": "Connection state",
      "broadcast.page.connection.bound": "Bound",
      "broadcast.page.connection.connecting": "Connecting",
      "broadcast.page.connection.closed": "Disconnected",
      "broadcast.page.connection.idle": "Idle",
      "broadcast.page.owner": "Owner public key",
      "broadcast.page.owner.none": "(no active key / vault locked)",
      "broadcast.page.lastError": "Last error",
      "broadcast.page.lastError.none": "(no errors)",
      "broadcast.page.nextReconnect": "Next auto-reconnect",
      "broadcast.page.nextReconnect.now": "Will retry on next coordinator tick",
      "broadcast.page.subscribedChannels": "Local subscribed channels",
      "broadcast.page.subscribedChannels.empty": "(none)",
      "broadcast.page.action.setActive": "Activate",
      "broadcast.page.action.clearActive": "Clear active",
      "broadcast.page.action.refresh": "Refresh",
      "broadcast.page.note.keyProvider": "Active provider id is persisted in localStorage. Clearing it stops auto-activation until you pick one."
    },
    "zh-CN": {
      "broadcast.menu": "广播",
      "broadcast.breadcrumb": "广播",
      "broadcast.page.title": "广播系统",
      "broadcast.page.activeProvider": "当前 active provider",
      "broadcast.page.activeProvider.none": "（未选择）",
      "broadcast.page.providerList": "已注册 providers",
      "broadcast.page.providerList.empty": "暂未注册任何 provider。",
      "broadcast.page.connection": "连接状态",
      "broadcast.page.connection.bound": "已绑定",
      "broadcast.page.connection.connecting": "连接中",
      "broadcast.page.connection.closed": "已断开",
      "broadcast.page.connection.idle": "空闲",
      "broadcast.page.owner": "Owner 公钥",
      "broadcast.page.owner.none": "（无 active key / vault 已锁）",
      "broadcast.page.lastError": "最近错误",
      "broadcast.page.lastError.none": "（无错误）",
      "broadcast.page.nextReconnect": "下一次自动重连时间",
      "broadcast.page.nextReconnect.now": "将在协调器下一次 tick 重试",
      "broadcast.page.subscribedChannels": "本地订阅 union",
      "broadcast.page.subscribedChannels.empty": "（无）",
      "broadcast.page.action.setActive": "激活",
      "broadcast.page.action.clearActive": "取消激活",
      "broadcast.page.action.refresh": "刷新",
      "broadcast.page.note.keyProvider": "active provider id 持久化在 localStorage 中。取消激活后将停止自动激活，直至你手动选择。"
    }
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
 *   - 本次（2026-07-08 001）注册管理页路由 `/system/broadcast`；
 *   - 本次不再单纯靠装配层 `setActive` 触发；改为 core 内置
 *     `bootstrapActiveProvider()`，装配层在 setup 末尾、且 plugin-hubcast
 *     register 自身**之后**调一次。
 */
export const broadcastPlatformPlugin: PluginManifest = {
  id: BROADCAST_PLUGIN_ID,
  name: "Broadcast",
  description:
    "Broadcast platform plugin: broadcast.core + provider registry + local subscription union + signed envelope verify/distribute + 固定延迟重连 + active provider 持久化 + 管理页。",
  i18n: broadcastResources,
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: [
      BROADCAST_CORE_CAPABILITY,
      BROADCAST_PROVIDER_REGISTRY_CAPABILITY,
      "broadcast.service"
    ],
    displayGroup: "platform"
  },
  dependencies: [
    { capability: "vault.service", reason: "借 owner 私钥签 broadcast envelope" },
    {
      capability: "keyspace.service",
      reason: "解析 owner publicKeyHex / 监听 active key 变化"
    },
    { capability: "route.registry", reason: "注册 /system/broadcast 路由" },
    { capability: "menu.registry", reason: "注册「广播」菜单项" },
    {
      capability: "breadcrumb.registry",
      reason: "为 /system/broadcast 提供面包屑"
    }
  ],
  setup(ctx) {
    const vault = ctx.get<VaultService>("vault.service");
    const keyspace = ctx.get<KeyspaceService>("keyspace.service");

    // 选择 storage：
    //   - 浏览器环境（globalThis.localStorage 存在）走真实 storage；
    //   - 否则走内存 map（test / SSR）。
    const storage: StorageLike =
      typeof globalThis !== "undefined" &&
      typeof (globalThis as { localStorage?: unknown }).localStorage !== "undefined"
        ? makeBrowserStorage()
        : makeMemoryStorage();

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
      storage,
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

    /**
     * 管理页 service（在 setup 阶段 provide；管理页消费）。
     */
    const service = createBroadcastService(core);
    ctx.provide("broadcast.service", service);

    /**
     * 注册管理页路由 + 菜单 + 面包屑。
     *
     * 设计缘由（施工单 §7.2.2 + §8.四）：
     *   - 路由固定 `/system/broadcast`；
     *   - 菜单挂在 "system" 组；
     *   - 面包屑就一个层级：Broadcast。
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
      id: "broadcast.system",
      path: "/system/broadcast",
      label: { key: "broadcast.menu", fallback: "Broadcast" },
      component: BroadcastPage,
      inMenu: true,
      menuGroup: "system",
      order: 30,
      icon: "Radio"
    });

    menus.register({
      id: "broadcast.system",
      path: "/system/broadcast",
      group: "system",
      order: 30,
      icon: "Radio",
      label: { key: "broadcast.menu", fallback: "Broadcast" }
    });

    breadcrumbs.register({
      id: "broadcast.system",
      order: 30,
      match: (path: string) => path === "/system/broadcast",
      resolve: () => [
        { label: { key: "broadcast.breadcrumb", fallback: "Broadcast" } }
      ]
    });

    // 等 plugin-hubcast 在 setup 阶段调用 `registry.register(...)`；
    // 装配层 host 在 hubcast 注册完之后调一次 `bootstrapActiveProvider()`；
    // 这里不强依赖 host 时序——如果不调，按"未持久化 + 未显式清空 = null"处理。
    // 见 apps/web/src/bootstrapPlugins.ts。

    return () => {
      coordinator.dispose();
      void core.disconnect();
    };
  }
};

/* ============== helpers ============== */

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

/* 类型导出供 BroadcastService / BroadcastPage 复用 */
export type { BroadcastCoreSnapshot };
