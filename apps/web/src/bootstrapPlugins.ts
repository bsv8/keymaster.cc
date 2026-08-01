// apps/web/src/bootstrapPlugins.ts
// 装配插件：按依赖顺序注册。
// 设计缘由：apps/web 是装配层，只 import manifest，不 import 内部服务。
// 顺序（硬切换后）：
//   runtime 内置 -> vault -> home -> settings -> assets -> key-import -> transfer -> contacts -> woc -> background -> p2pkh -> importers。
// plugin-woc 必须早于 plugin-p2pkh；plugin-background 必须早于 plugin-p2pkh；
// plugin-transfer 必须早于 plugin-p2pkh（P2PKH 注册 Transfer Provider）。
//
// 硬切换 003：把 shell 自身 i18n 资源（apps/web 装配层）通过 initialI18nResources
// 注入；plugin 注册前可被 t() 命中。
//
// 硬切换 001：bootstrap 不再等价于"ordered = 全部一定装载"。
//   - registerAll 把每个 manifest 加入 host 已知集合；
//   - host 内部根据"全局启停配置（localStorage）+ manifest.meta.defaultEnabled"
//     决定每个 plugin 初始是否 enable。
//   - 因此旧的"按顺序 registerAll"在新模型下也保持兼容：core / settings / home 等
//     标记 defaultEnabled=true 的会自动装载，business 插件可通过配置 store 控制。

import {
  ASSET_DATA_NOTIFIER_CAPABILITY,
  type PluginManifest,
  type AssetDataNotifier,
  type SessionCoordinatorClient
} from "@keymaster/contracts";
import { createPluginHost, type PluginHost } from "@keymaster/runtime";
import { bsvPriceConfig } from "./pluginConfigs.js";
import { WEB_PLUGIN_CATALOG } from "./pluginCatalog.js";
import { SHELL_RESOURCES } from "./i18n/resources.js";
import { registerShellResources } from "./shell/shellResources.js";
import { registerAssetWorkspace } from "./system/registerAssetWorkspace.js";

/**
 * 启动期每个插件注册的最长等待时间。
 *
 * 设计缘由：
 *   - 本次线上故障不是 throw，而是 `indexedDB.open("keymaster.protocol")`
 *     永久 pending，导致 `bootstrapPlugins()` 不返回、`#root` 一直为空。
 *   - 这里把"插件注册永久 pending"提升成显式启动错误；由 main.tsx 现有
 *     fatal 通道统一接管。
 *   - 不在 runtime host 内做全局超时：runtime 是通用层，不应该知道
 *     web 首屏"多久算崩溃"；装配层最适合定义这个阈值。
 */
export const BOOTSTRAP_PLUGIN_TIMEOUT_MS = 15_000;

/** Worker 发布切换或缓存重新验证时的一次性恢复等待。 */
export const COORDINATOR_STARTUP_RETRY_DELAY_MS = 200;

export const WEB_STARTUP_REQUIRED_CAPABILITIES = [
  "vault.service",
  "keyspace.service"
] as const;

export function assertWebStartupContract(host: PluginHost): void {
  host.assertCapabilities(WEB_STARTUP_REQUIRED_CAPABILITIES, { phase: "web-bootstrap" });
}

/** protocol 插件当前已知的高风险启动步骤提示。 */
function bootstrapStepHint(pluginId: string): string | undefined {
  if (pluginId === "protocol") {
    return 'opening IndexedDB "keymaster.protocol"';
  }
  return undefined;
}

/** 生成启动步骤的人类可读描述，用于 fatal / 日志。 */
export function describeBootstrapStep(pluginId: string): string {
  const hint = bootstrapStepHint(pluginId);
  if (!hint) return `plugin "${pluginId}"`;
  return `plugin "${pluginId}" (${hint})`;
}

/**
 * 按装配层语义注册单个插件：若注册 Promise 长时间不返回，则视为启动挂死。
 *
 * 注意：
 *   - 这里只解决"永久 pending"这类系统故障；
 *   - host.register() 自身若同步/异步失败，仍保持 runtime 既有语义。
 */
export async function registerPluginWithTimeout(
  host: PluginHost,
  plugin: PluginManifest,
  timeoutMs = BOOTSTRAP_PLUGIN_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      host.register(plugin),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Bootstrap timed out while registering ${describeBootstrapStep(plugin.id)} after ${timeoutMs}ms`
            )
          );
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Coordinator 启动连接的一次性有界恢复。
 *
 * 仅重试初始连接；业务期断线仍由 client 自身的 reconnect 机制负责。
 */
export async function connectCoordinatorWithStartupRetry(
  coordinatorClient: {
    connect(): Promise<void>;
    disconnect(): void;
  },
  retryDelayMs = COORDINATOR_STARTUP_RETRY_DELAY_MS
): Promise<void> {
  try {
    await coordinatorClient.connect();
  } catch {
    // 首次模块 Worker 加载可能恰逢静态资源发布/缓存重新验证。先彻底
    // 关闭失败端口与其自动重连 timer，再进行一次有界重试；第二次仍
    // 失败则保留原有 fail-fast，由 main fatal 页面展示增强后的诊断。
    coordinatorClient.disconnect();
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    await coordinatorClient.connect();
  }
}

export async function bootstrapPlugins(): Promise<PluginHost> {
  // 装配层把缺 key warning 打开：开发期方便排查未翻译文案。
  // import.meta.env 是 Vite 注入的；通过 typeof 守卫避免 TS 在 node 环境下报错。
  const meta = import.meta as ImportMeta & { env?: { MODE?: string; DEV?: boolean } };
  const isProd = meta.env
    ? (typeof meta.env.MODE === "string" ? meta.env.MODE === "production" : meta.env.DEV === false)
    : false;
  const host = createPluginHost({
    initialI18nResources: [SHELL_RESOURCES],
    i18nDebug: !isProd
  });
  registerShellResources(host.capabilities.get("resource.registry"));

  // 施工单 002：注入 Coordinator client
  // 在 bootstrap 阶段创建 Coordinator client 并注入到 PluginHost
  const { createCoordinatorClient } = await import("./keymasterSessionCoordinatorClient.js");
  const coordinatorClient = createCoordinatorClient();
  await connectCoordinatorWithStartupRetry(coordinatorClient);
  host.provide("session-coordinator.client", coordinatorClient);

  // 硬切换 003：直接转发 Coordinator event 给 runtime notifier
  // 装配层只负责转发，合并语义由 runtime notifier 实现
  const dataNotifier = host.capabilities.get<AssetDataNotifier>(
    ASSET_DATA_NOTIFIER_CAPABILITY
  );
  coordinatorClient.subscribeTopic("asset.data-changed", (event) => {
    if (event.type === "asset.data-changed") {
      dataNotifier.emit(event);
    }
  });

  // 硬切换 001 + 施工单 004 + 2026-06-29 002：按"依赖先后保证 capability 顺序"的顺序
  // 加入已知集合。host.register 内部会按 config store 决定是否自动 enable。
  //
  // 关键顺序（施工单 2026-07-04 001 硬切换 + 2026-07-06 001 硬切换）：
  //   vault
  //   broadcast（先装，把 `broadcast.core` + `broadcast.provider.registry`
  //     capability 挂到 capability bus；hubcast 之后 register 自身）
  //   hubcast（在 broadcast 之后 register 自身；plugin-hubcast 依赖
  //     `broadcast.provider.registry`，**不**依赖 `appmsg.core` / 任何
  //     消息系统概念）
  //   appmsg-platform（先装，把 `message.provider.registry` capability
  //     挂到 capability bus；hubmsg 之后 register 自身）
  //   hubmsg-platform（在 appmsg 之后 register 自身；plugin-hubmsg
  //     自身不依赖 `appmsg.core`——它依赖 `message.provider.registry`）
  //   protocol
  //   webrtc（plugin-message / notice 需要它）
  //   message（plugin-message 依赖 `appmsg.endpoint.registry` + `webrtc.service`）
  //   home
  //   settings
  //   ...
  //
  // 设计缘由：
  //   - 硬切换 2026-07-06 001：plugin-broadcast / plugin-hubcast 与
  //     plugin-appmsg / plugin-hubmsg **互不依赖**；两套系统的 capability
  //     真值独立，**不**互相 import；
  //   - 硬切换 2026-07-06 001：plugin-hubcast **必须**在 plugin-broadcast
  //     之后装载——hubcast 依赖 `broadcast.provider.registry`；
  //   - 硬切换 2026-07-04 001：plugin-hubmsg **不**再依赖 `appmsg.core`；
  //     它依赖 `message.provider.registry`，由 plugin-appmsg 在 setup
  //     时 provide。plugin-hubmsg 装载顺序**必须**在 plugin-appmsg 之
  //     后、其它业务插件之前；
  //   - plugin-message 装载顺序**必须**在 plugin-appmsg 之后（拿
  //     `appmsg.endpoint.registry`）；
  //   - protocolPlugin 仍然在 appmsgPlatformPlugin 之后：plugin-protocol
  //     在 setup 时通过 capability 总线取 `appmsg.core.subscribeUnfilteredMessages`
  //     + `appmsg.core.sendAsOrigin` / `listAsOrigin` / `getAsOrigin`
  //     （协议层系统特殊方，按 origin 路由完整消息是合理特权；不走
  //     endpoint service，路径与 subscribe 同属"系统特殊方特权"）。
  const ordered = WEB_PLUGIN_CATALOG;

  // 施工单 2026-07-08 001 硬切换：装配层对 plugin-bsv-price 显式注入
  // `pricePublisherPublicKeyHex` seed；它只在本地配置缺失时作为首次
  // 默认值，运行时真值由 `localStorage["bsv-price.settings"]` 接管。
  //
  // 关键约束：
  //   - 装配层**不**自己改 plugin manifest；改为把已构造好的 `config`
  //     对象透传给 plugin；plugin 用 `ctx.config[BSV_PRICE_CONFIG_KEY]`
  //     读来决定首次 seed；
  //   - 配置来源集中：`pluginConfigs.ts`；
  //   - plugin 自己**不**走 `globalThis.__XXX__` 隐式注入路径。
  //
  // 这里用 `withConfig` 给 bsvPricePlugin 临时挂上 config，避免对其它
  // plugin 的 manifest 顺序造成影响。
  const orderedWithConfig: PluginManifest[] = ordered.map((p) => {
    if (p.id === "bsv-price") {
      return { ...p, config: { ...bsvPriceConfig } };
    }
    return p;
  });

  host.validateManifestSet(orderedWithConfig);
  host.configStore.setRequiredPluginIds(
    orderedWithConfig.filter((plugin) => plugin.meta.startup === "required").map((plugin) => plugin.id)
  );
  for (const plugin of orderedWithConfig) {
    await registerPluginWithTimeout(host, plugin);
  }

  await registerAssetWorkspace(host);

  assertWebStartupContract(host);

  // 施工单 2026-07-08 001：plugin-broadcast 在 hubcast 注册之后由
  // registry.register hook 自动激活默认 active provider；此处不需要
  // 显式调用。如果未来变更激活策略，改为在这里显式调
  // `host.capabilities.get<BroadcastCore>(BROADCAST_CORE_CAPABILITY).bootstrapActiveProvider()`。
  return host;
}
