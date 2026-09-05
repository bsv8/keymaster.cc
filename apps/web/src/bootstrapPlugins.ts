// apps/web/src/bootstrapPlugins.ts
// 装配插件：按 manifest 声明的四阶段门禁注册。
// 设计缘由：apps/web 是装配层，只 import manifest，不 import 内部服务。
// 阶段顺序：storage-onboarding -> vault-selection -> owner-apps-ready
// -> connect-apps-ready。每个阶段内部仍按 catalog 的依赖顺序执行。
//
// 硬切换 003：把 shell 自身 i18n 资源（apps/web 装配层）通过 initialI18nResources
// 注入；plugin 注册前可被 t() 命中。
//
// 硬切换 001：bootstrap 不再等价于"ordered = 全部一定装载"。
//   - registerAll 把每个 manifest 加入 host 已知集合；
//   - host 内部根据平台 settings K-V + manifest.meta.defaultEnabled
//     决定每个 plugin 初始是否 enable。
//   - 因此每个阶段仍由 host 根据全局配置决定 optional 插件是否启用；
//     required/immutable 插件始终由 host 保证可用。

import {
  ASSET_DATA_NOTIFIER_CAPABILITY,
  APPLICATION_BOOTSTRAP_READY_CAPABILITY,
  COORDINATOR_ACTIVITY_CAPABILITY,
  type KeyValueCommitInput,
  type KeyValueCommitResult,
  type KeyValueEntry,
  type KeyValueEntryMeta,
  type KeyValueListInput,
  type KeyValueListResult,
  type KeyValueStore,
  type KeyValueValue,
  type PluginBootstrapStage,
  type PluginManifest,
  type AssetDataNotifier,
  type SessionCoordinatorClient,
  type StorageCoordinatorControl,
  type VaultCoordinatorControl,
  type BackgroundCoordinatorControl,
  type P2pkhCoordinatorControl,
  type MsFileCoordinatorControl,
  type SatCoordinatorControl,
  type WindowP2pCoordinatorControl,
  type ProtocolCoordinatorControl,
  type ContactsCoordinatorControl
} from "@keymaster/contracts";
import type { ApplicationBootstrapSnapshot, ApplicationBootstrapStatus, ApplicationBootstrapListener } from "@keymaster/contracts";
import type { CoordinatorPlatformStorageData, StorageBindingCoordinatorClient } from "@keymaster/contracts/storage-internal";
import { createPluginHost, type PluginHost } from "@keymaster/runtime";
import { createStorageBindingAuthority } from "@keymaster/platform-storage/coordinator/authority";
import { bsvPriceConfig } from "./pluginConfigs.js";
import { WEB_PLUGIN_CATALOG } from "./pluginCatalog.js";
import { SHELL_RESOURCES } from "./i18n/resources.js";
import { registerShellResources } from "./shell/shellResources.js";
import { registerAssetWorkspace } from "./system/registerAssetWorkspace.js";

/**
 * 启动期每个插件注册的最长等待时间。
 *
 * 设计缘由：
 *   - 本次线上故障不是 throw，而是平台 K-V 打开永久 pending，导致
 *     `bootstrapPlugins()` 不返回、`#root` 一直为空。
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

type CoordinatorMethodName = keyof SessionCoordinatorClient | keyof StorageBindingCoordinatorClient | "sendActivity";

function bindCoordinatorMethods<T>(
  client: SessionCoordinatorClient,
  names: readonly CoordinatorMethodName[]
): T {
  const facade = Object.create(null) as Record<string, unknown>;
  const source = client as SessionCoordinatorClient & Record<string, unknown>;
  for (const name of names) {
    const value = source[name];
    if (typeof value === "function") facade[name] = value.bind(client);
  }
  return Object.freeze(facade) as T;
}

/** 公开给业务插件的 Coordinator 视图：冻结普通对象，不继承真实 client 原型。 */
export function createPublicCoordinatorClient(client: SessionCoordinatorClient): SessionCoordinatorClient {
  return bindCoordinatorMethods<SessionCoordinatorClient>(client, [
    "connect", "getIsConnected", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity",
    "storageGrant", "storageData", "storageCancel", "storageSessionAbort",
    "msfileControl", "msfileGrant", "msfileData", "msfileCancel", "msfileSessionAbort",
    "windowP2pExecutorAcquire", "windowP2pExecutorRelease", "windowP2pExecutorSpikeTransfer", "windowP2pExecutorSignNoiseStaticKey", "windowP2pExecutorSignPeerRecord",
    "satOperation", "channelOperation", "contactsPresenceSnapshot",
    "p2pkhProvidersGet", "p2pkhProvidersUpdate", "p2pkhSettingsUpdate", "p2pkhProviderConfigGet", "p2pkhProviderConfigUpdate", "p2pkhBroadcast", "p2pkhRebroadcastAncestors"
  ]);
}

/** Storage 插件专用 facade：只允许页面侧 StorageRuntimeController 所需 RPC。 */
export function createStorageCoordinatorClient(client: SessionCoordinatorClient): StorageCoordinatorControl {
  return bindCoordinatorMethods<StorageCoordinatorControl>(client, [
    "connect", "getIsConnected", "getBootstrapSnapshot", "getSessionEpoch", "subscribeTopic",
    "storageControl", "storageGrant", "storageData", "storageCancel", "storageSessionAbort"
  ]);
}

/** Vault 插件专用 facade：只有 Vault 可以操作私钥与会话生命周期。 */
export function createVaultCoordinatorClient(client: SessionCoordinatorClient): VaultCoordinatorControl {
  return bindCoordinatorMethods<VaultCoordinatorControl>(client, [
    "connect", "getIsConnected", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic",
    "unlock", "lock", "activateKey", "vaultOperation", "crypto", "backgroundCancelByKey"
  ]);
}

/**
 * 按 manifest.id 生成插件专属 Coordinator 面。这个映射只在 Host 装配时
 * 执行一次；插件 setup 通过 `ctx.coordinator` 取得已经绑定身份的对象，
 * 不再通过字符串 capability 取得其它插件的 RPC。
 */
export function createPluginCoordinatorFacade(client: SessionCoordinatorClient, pluginId: string): unknown {
  switch (pluginId) {
    case "storage": return createStorageCoordinatorClient(client);
    case "vault": return createVaultCoordinatorClient(client);
    case "background": return bindCoordinatorMethods<BackgroundCoordinatorControl>(client, [
      "getIsConnected", "getBootstrapSnapshot", "subscribeTopic", "backgroundRunNow", "backgroundTrigger",
      "backgroundCancel", "backgroundCancelByKey", "backgroundSettingsUpdate", "reportRecoverableCoordinatorFailure"
    ]);
    case "p2pkh":
    case "woc":
    case "junglebus": return bindCoordinatorMethods<P2pkhCoordinatorControl>(client, [
      "connect", "getIsConnected", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity",
      "p2pkhProvidersGet", "p2pkhProvidersUpdate", "p2pkhSettingsUpdate", "p2pkhProviderConfigGet", "p2pkhProviderConfigUpdate",
      "p2pkhBroadcast", "p2pkhRebroadcastAncestors"
    ]);
    case "msfile": return bindCoordinatorMethods<MsFileCoordinatorControl>(client, [
      "connect", "getIsConnected", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity",
      "msfileControl", "msfileGrant", "msfileData", "msfileCancel", "msfileSessionAbort"
    ]);
    case "sat-subscription": return bindCoordinatorMethods<SatCoordinatorControl>(client, [
      "connect", "getIsConnected", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity",
      "satOperation", "channelOperation"
    ]);
    case "window-p2p": return bindCoordinatorMethods<WindowP2pCoordinatorControl>(client, [
      "connect", "getIsConnected", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity",
      "windowP2pExecutorAcquire", "windowP2pExecutorRelease", "windowP2pExecutorSpikeTransfer",
      "windowP2pExecutorSignNoiseStaticKey", "windowP2pExecutorSignPeerRecord"
    ]);
    case "protocol": return bindCoordinatorMethods<ProtocolCoordinatorControl>(client, [
      "connect", "getIsConnected", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity", "channelOperation"
    ]);
    case "contacts": return bindCoordinatorMethods<ContactsCoordinatorControl>(client, [
      "getIsConnected", "getBootstrapSnapshot", "subscribeTopic", "contactsPresenceSnapshot"
    ]);
    default: return undefined;
  }
}

export function assertWebStartupContract(host: PluginHost): void {
  host.assertCapabilities(WEB_STARTUP_REQUIRED_CAPABILITIES, { phase: "web-bootstrap" });
}

function createApplicationBootstrapStatus(initial: ApplicationBootstrapSnapshot): {
  service: ApplicationBootstrapStatus;
  set(snapshot: ApplicationBootstrapSnapshot): void;
  setRetry(retry: () => Promise<void>): void;
} {
  let current = { ...initial };
  let retryHandler: () => Promise<void> = async () => undefined;
  const listeners = new Set<ApplicationBootstrapListener>();
  return {
    service: {
      snapshot: () => ({ ...current }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      retry: () => retryHandler()
    },
    set(snapshot) {
      current = { ...snapshot };
      for (const listener of listeners) listener({ ...current });
    },
    setRetry(retry) {
      retryHandler = retry;
    }
  };
}

function isStaleCoordinatorStorageBinding(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof code === "string") {
    return code === "storage_unavailable" || code === "storage_identity_required";
  }
  const message = error instanceof Error ? error.message : String(error);
  return /storage (?:handle|grant|binding) .*?(?:stale|invalid|changed)|storage .*unavailable|owner storage .*changed|platform storage .*changed/i.test(message);
}

/** 页面侧平台 K-V 句柄：只转发 platform K-V RPC，不暴露 Provider 或物理路径。 */
function createCoordinatorPlatformStore(
  client: SessionCoordinatorClient,
  applicationStorageId: string,
  pluginId = "runtime"
): KeyValueStore {
  const internalClient = client as SessionCoordinatorClient & StorageBindingCoordinatorClient;
  let grantPromise: Promise<import("@keymaster/contracts/storage-internal").StoragePlatformGrant> | undefined;
  const grant = async () => {
    if (!grantPromise) {
      grantPromise = internalClient.storageBindPlatform({ pluginId, declaration: { scope: "platform", applicationStorageId, schemaVersion: 1 } }).then((result) => {
        if (result.status !== "ok") {
          const error = new Error("message" in result ? result.message : `Platform storage bind failed: ${result.status}`) as Error & { code?: string };
          if ("code" in result && typeof result.code === "string") error.code = result.code;
          throw error;
        }
        return result.value;
      }).catch((error) => {
        grantPromise = undefined;
        throw error;
      });
    }
    return grantPromise;
  };
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Platform storage handle is closed");
  };
  const call = async <T>(data: CoordinatorPlatformStorageData): Promise<T> => {
    assertOpen();
    const result = await internalClient.storagePlatformData(data);
    if (result.status !== "ok") {
      const message = "message" in result ? result.message : `Platform storage request failed: ${result.status}`;
      const error = new Error(message) as Error & { code?: string };
      if ("code" in result && typeof result.code === "string") error.code = result.code;
      throw error;
    }
    return result.value as T;
  };
  const request = async <T>(build: (platformGrantId: string) => CoordinatorPlatformStorageData): Promise<T> => {
    try {
      const bound = await grant();
      return await call<T>(build(bound.platformGrantId));
    } catch (error) {
      // 不重试本次写入/提交：响应可能已经跨过远端写入边界。
      // 只丢弃旧 grant，让下一次业务调用在新 Root 上重新绑定。
      if (isStaleCoordinatorStorageBinding(error)) grantPromise = undefined;
      throw error;
    }
  };
  return {
    bucketId: "coordinator",
    bucketGeneration: 0,
    ownerPublicKeyHex: "",
    applicationStorageId,
    get<T = KeyValueValue>(key: string, options: { partition?: string } = {}): Promise<KeyValueEntry<T> | undefined> {
      return request<KeyValueEntry<T> | undefined>((platformGrantId) => ({ type: "platform.get", platformGrantId, key, partition: options.partition }));
    },
    list(input: KeyValueListInput = {}): Promise<KeyValueListResult> {
      return request<KeyValueListResult>((platformGrantId) => ({ type: "platform.list", platformGrantId, input }));
    },
    put<T = KeyValueValue>(key: string, value: T, condition: { ifRevision?: number; partition?: string } = {}): Promise<KeyValueEntryMeta> {
      return request<KeyValueEntryMeta>((platformGrantId) => ({ type: "platform.put", platformGrantId, key, value, condition }));
    },
    async delete(key: string, condition: { ifRevision?: number; partition?: string } = {}): Promise<void> {
      await request<void>((platformGrantId) => ({ type: "platform.delete", platformGrantId, key, condition }));
    },
    commit(input: KeyValueCommitInput): Promise<KeyValueCommitResult> {
      return request<KeyValueCommitResult>((platformGrantId) => ({ type: "platform.commit", platformGrantId, ...input }));
    },
    close() {
      closed = true;
    }
  };
}

/** protocol 插件当前已知的高风险启动步骤提示。 */
function bootstrapStepHint(pluginId: string): string | undefined {
  if (pluginId === "protocol") {
    return 'opening platform K-V "protocol"';
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
  // 施工单 002：注入 Coordinator client
  // 在 bootstrap 阶段创建 Coordinator client 并注入到 PluginHost
  const { getCoordinatorClient } = await import("./keymasterSessionCoordinatorClient.js");
  // Spike hooks and plugin capabilities must share the same physical port;
  // creating a second client here would bypass the real SharedWorker session.
  const coordinatorClient = getCoordinatorClient();
  await connectCoordinatorWithStartupRetry(coordinatorClient);
  const storageStatus = await coordinatorClient.storageControl({ type: "status" });
  // Storage 是独立健康域。Provider/CORS/认证暂不可用时，仍需让 Vault
  // 和设置页启动，以便用户看到恢复入口；此时不能再读取平台配置 K-V。
  const storageReady = storageStatus.status === "ok" && storageStatus.value === "ready";

  // 日志也是平台诊断数据，必须在 Host 创建时绑定到 Coordinator 平台 K-V。
  // 这样 runtime 首次读取配置和写入 entry 时不会落到测试内存夹具。
  const logStorage = createCoordinatorPlatformStore(coordinatorClient, "logs");
  const configStorage = createCoordinatorPlatformStore(coordinatorClient, "settings");
  const host = createPluginHost({
    initialI18nResources: [SHELL_RESOURCES],
    i18nDebug: !isProd,
    logStorage,
    configStorage,
    storageBindingAuthority: createStorageBindingAuthority(coordinatorClient as SessionCoordinatorClient & StorageBindingCoordinatorClient & { getActivePublicKeyHex(): string | undefined }),
    coordinatorForPlugin: (pluginId) => createPluginCoordinatorFacade(coordinatorClient, pluginId)
  });
  host.provide(COORDINATOR_ACTIVITY_CAPABILITY, Object.freeze({
    getIsConnected: () => coordinatorClient.getIsConnected(),
    sendActivity: () => coordinatorClient.sendActivity()
  }));
  const bootstrapStatus = createApplicationBootstrapStatus({
    phase: storageReady ? "vault-selection" : "storage-onboarding",
    storageReady,
    vaultCapabilityReady: false,
    hasUnlockedActiveKey: false,
    vaultSelectionReady: false,
    ownerAppsReady: false,
    connectAppsReady: false,
    assetWorkspaceReady: false
  });
  host.provide(APPLICATION_BOOTSTRAP_READY_CAPABILITY, bootstrapStatus.service);
  registerShellResources(host.capabilities.get("resource.registry"), bootstrapStatus.service);

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

  // 硬切换 004：启动清单按 manifest.meta.bootstrapStage 分成四道门禁。
  // 阶段字段是唯一真值；这里不能根据 pluginId、kind 或 storage scope 猜测。
  const fullCatalog = [...WEB_PLUGIN_CATALOG];
  const bootstrapStages: readonly PluginBootstrapStage[] = [
    "storage-onboarding",
    "vault-selection",
    "owner-apps-ready",
    "connect-apps-ready"
  ];
  const missingBootstrapStage = fullCatalog.filter((plugin) => !plugin.meta.bootstrapStage);
  if (missingBootstrapStage.length > 0) {
    throw new Error(`Web plugin catalog has no bootstrapStage: ${missingBootstrapStage.map((plugin) => plugin.id).join(", ")}`);
  }
  const catalogForStage = (catalog: readonly PluginManifest[], stage: PluginBootstrapStage): PluginManifest[] =>
    catalog.filter((plugin) => plugin.meta.bootstrapStage === stage);
  const phaseOneCatalog = catalogForStage(fullCatalog, "storage-onboarding");
  if (phaseOneCatalog.length === 0) throw new Error("Web plugin catalog must contain a storage-onboarding plugin");

  // 施工单 2026-07-08 001 硬切换：装配层对 plugin-bsv-price 显式注入
  // `pricePublisherPublicKeyHex` seed；它只在本地配置缺失时作为首次
  // 默认值，运行时真值由 BSV Price owner/App K-V 接管。
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
  const fullCatalogWithConfig: PluginManifest[] = fullCatalog.map((p) => {
    if (p.id === "bsv-price") {
      return { ...p, config: { ...bsvPriceConfig } };
    }
    return p;
  });
  const phaseOneCatalogWithConfig = catalogForStage(fullCatalogWithConfig, "storage-onboarding");

  let vaultSelectionPromise: Promise<void> | undefined;
  let ownerAppsPromise: Promise<void> | undefined;
  let vaultSelectionReady = false;
  let ownerAppsReady = false;
  let connectAppsReady = false;
  let assetWorkspaceReady = false;
  let storageReadyForBootstrap = storageReady;
  let sessionStateOff: (() => void) | undefined;

  const currentActiveKey = (): { unlocked: boolean; activePublicKeyHex?: string } => {
    const snapshot = coordinatorClient.getBootstrapSnapshot();
    const unlocked = snapshot.vaultStatus === "unlocked" && typeof snapshot.activePublicKeyHex === "string";
    return { unlocked, activePublicKeyHex: unlocked ? snapshot.activePublicKeyHex : undefined };
  };

  const updateBootstrapStatus = (patch: Partial<ApplicationBootstrapSnapshot>): void => {
    bootstrapStatus.set({ ...bootstrapStatus.service.snapshot(), ...patch });
  };

  const registerStage = async (stage: PluginBootstrapStage, retryFailed = false): Promise<void> => {
    const plugins = catalogForStage(fullCatalogWithConfig, stage);
    host.configStore.setRequiredPluginIds(
      fullCatalogWithConfig.filter((plugin) => plugin.meta.startup === "required").map((plugin) => plugin.id)
    );
    const enabledByConfig = new Set(
      host.configStore.resolveEnabled(plugins.map((plugin) => plugin.id), (pluginId) =>
        plugins.find((plugin) => plugin.id === pluginId)?.meta.defaultEnabled ?? false
      ).enabled
    );
    for (const plugin of plugins) {
      const existing = host.getManifest(plugin.id);
      if (!existing) {
        await registerPluginWithTimeout(host, plugin);
        continue;
      }
      // register() 负责 required/immutable 插件的失败重放；显式的应用
      // 装配重试还会按持久化启停配置重试已开启的 optional 插件。
      await registerPluginWithTimeout(host, plugin);
      const state = host.state(plugin.id);
      const shouldRetry = retryFailed
        && (plugin.meta.startup === "required" || plugin.meta.canDisable === false || enabledByConfig.has(plugin.id))
        && (state.kind === "error-disabled" || state.kind === "blocked");
      if (shouldRetry) await host.retry(plugin.id);
    }
  };

  const runOwnerAndConnectStages = async (retryFailed = false): Promise<void> => {
    const active = currentActiveKey();
    if (!active.unlocked) return;
    if (ownerAppsPromise) return ownerAppsPromise;
    ownerAppsPromise = (async () => {
      updateBootstrapStatus({ phase: "vault-selection", hasUnlockedActiveKey: true });
      await registerStage("owner-apps-ready", retryFailed);
      ownerAppsReady = true;
      updateBootstrapStatus({ phase: "owner-apps-ready", hasUnlockedActiveKey: true, ownerAppsReady: true });
      if (!assetWorkspaceReady) {
        await registerAssetWorkspace(host);
        assetWorkspaceReady = true;
      }
      updateBootstrapStatus({ assetWorkspaceReady: true });
      await registerStage("connect-apps-ready", retryFailed);
      connectAppsReady = true;
      assertWebStartupContract(host);
      updateBootstrapStatus({
        phase: "connect-apps-ready",
        hasUnlockedActiveKey: true,
        ownerAppsReady,
        connectAppsReady,
        assetWorkspaceReady: true
      });
    })();
    try {
      await ownerAppsPromise;
    } catch (error) {
      ownerAppsPromise = undefined;
      updateBootstrapStatus({
        phase: "error",
        storageReady: true,
        vaultCapabilityReady: host.capabilities.has("vault.service") && host.capabilities.has("keyspace.service"),
        hasUnlockedActiveKey: currentActiveKey().unlocked,
        vaultSelectionReady,
        ownerAppsReady,
        connectAppsReady,
        assetWorkspaceReady,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };

  const enterVaultSelectionStage = async (retryFailed = false): Promise<void> => {
    if (!storageReadyForBootstrap) return;
    if (vaultSelectionPromise) return vaultSelectionPromise;
    vaultSelectionPromise = (async () => {
      updateBootstrapStatus({ phase: "vault-selection", storageReady: true });
      await host.configStore.hydrate();
      host.validateManifestSet(fullCatalogWithConfig);
      await registerStage("vault-selection", retryFailed);
      host.assertCapabilities(["vault.service", "keyspace.service"], { phase: "vault-selection" });
      vaultSelectionReady = true;
      const active = currentActiveKey();
      updateBootstrapStatus({
        phase: "vault-selection",
        storageReady: true,
        vaultCapabilityReady: true,
        hasUnlockedActiveKey: active.unlocked,
        vaultSelectionReady: true
      });
      if (active.unlocked) await runOwnerAndConnectStages(retryFailed);
    })();
    try {
      await vaultSelectionPromise;
    } catch (error) {
      vaultSelectionPromise = undefined;
      updateBootstrapStatus({
        phase: "error",
        storageReady: true,
        vaultCapabilityReady: host.capabilities.has("vault.service") && host.capabilities.has("keyspace.service"),
        hasUnlockedActiveKey: currentActiveKey().unlocked,
        vaultSelectionReady,
        ownerAppsReady,
        connectAppsReady,
        assetWorkspaceReady,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };

  const retryApplicationBootstrap = async (): Promise<void> => {
    if (!storageReadyForBootstrap) return;
    await enterVaultSelectionStage(true);
    if (currentActiveKey().unlocked) await runOwnerAndConnectStages(true);
  };
  bootstrapStatus.setRetry(retryApplicationBootstrap);

  const phaseOneRequiredCatalog = phaseOneCatalogWithConfig;

  host.validateManifestSet(fullCatalogWithConfig);
  host.configStore.setRequiredPluginIds(
    phaseOneRequiredCatalog.filter((plugin) => plugin.meta.startup === "required").map((plugin) => plugin.id)
  );
  for (const plugin of phaseOneCatalogWithConfig) await registerPluginWithTimeout(host, plugin);
  if (!storageReady) {
    const storageService = host.capabilities.get<import("@keymaster/contracts").StorageRuntimeController>("storage.runtime-controller");
    const offStorageReady = storageService.subscribe(() => {
      if (storageService.status() !== "ready") return;
      storageReadyForBootstrap = true;
      void enterVaultSelectionStage().catch((error) => {
        console.error("[bootstrap] Storage-ready plugin assembly failed", error);
      });
    });
    // subscribe() is intentionally not an immediate callback; handle a
    // ready baseline explicitly for a race between status() and subscription.
    if (storageService.status() === "ready") {
      storageReadyForBootstrap = true;
      await enterVaultSelectionStage();
    }
    void offStorageReady;
  } else {
    await enterVaultSelectionStage();
  }

  sessionStateOff = coordinatorClient.subscribeTopic("session.state", (event) => {
    if (event.type !== "session.state.changed") return;
    const active = currentActiveKey();
    if (!vaultSelectionReady) return;
    updateBootstrapStatus({ hasUnlockedActiveKey: active.unlocked });
    if (active.unlocked && !connectAppsReady) {
      void runOwnerAndConnectStages().catch((error) => {
        console.error("[bootstrap] owner/connect plugin assembly failed", error);
      });
    }
  });
  void sessionStateOff;

  return host;
}
