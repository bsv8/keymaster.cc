// apps/web/src/bootstrapPlugins.ts
// 装配插件：按 manifest 声明的四阶段门禁注册。
// 设计缘由：apps/web 是装配层，只 import manifest，不 import 内部服务。
// 插件注册阶段顺序：storage-onboarding -> vault-selection -> owner-apps-ready
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
  KEYSPACE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  STORAGE_RUNTIME_CONTROLLER_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
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
  type ContactsCoordinatorControl,
  type PluginPermission,
  type RuntimeIdentityTransition,
  CENTRAL_STORAGE_DECLARATIONS,
  type PluginStorageDeclaration,
} from "@keymaster/contracts";
import {
  type WindowApp,
} from "webloom-framework";
import type { PluginIntentCoordinator, PluginIntentSnapshot } from "webloom-framework";
import { createWindowAppFromHost, registerPlugins } from "webloom-framework/advanced";
import type { ApplicationBootstrapPhase, ApplicationBootstrapSnapshot, ApplicationBootstrapStatus, ApplicationBootstrapListener } from "@keymaster/contracts";
import type { CoordinatorPlatformStorageData, StorageBindingCoordinatorClient } from "@keymaster/contracts/storage-internal";
import { attachKeymasterRemoteRuntime, createKeymasterPluginHost as createPluginHost, getWebLoomHost, type PluginHost } from "@keymaster/runtime";
import { createStorageBindingAuthority } from "@keymaster/platform-storage/coordinator/authority";
import { bsvPriceConfig } from "./pluginConfigs.js";
import { WEB_PLUGIN_CATALOG } from "./pluginCatalog.js";
import { createWebRuntimeUnitImplementationRegistry } from "./runtimeUnitImplementations.js";
import { SHELL_RESOURCES } from "./i18n/resources.js";
import { registerShellResources } from "./shell/shellResources.js";
import { registerAssetWorkspace } from "./system/registerAssetWorkspace.js";
import { formatStartupErrorSummary } from "./startupErrorSummary.js";
import {
  attachBootstrapErrorContext,
  runWithBootstrapErrorContext,
  withBootstrapErrorContext,
  type BootstrapErrorStage,
} from "./bootstrapErrorContext.js";

export {
  BootstrapContextError,
  bootstrapPhaseForContext,
  getBootstrapErrorContext,
} from "./bootstrapErrorContext.js";
export type { BootstrapErrorContext, BootstrapErrorStage, BootstrapFatalPhase } from "./bootstrapErrorContext.js";

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
// 需覆盖旧 Worker 的空闲宽限、Runtime 排空和资源释放。
// 失败的新 Worker 会在 25ms 后主动退出，旧 Worker 在无页面后 250ms
// 开始退场；500ms 仍保持一次有界恢复，不会长期掩盖真实的多页面冲突。
export const COORDINATOR_STARTUP_RETRY_DELAY_MS = 500;

/** owner 插件必须等待服务目录就绪的最长时间；超时交给启动 fatal/retry 面。 */
export const COORDINATOR_SERVICE_READY_TIMEOUT_MS = BOOTSTRAP_PLUGIN_TIMEOUT_MS;

function startupFailureText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * 两次 Coordinator 启动尝试都失败时保留两端错误。
 *
 * Vite dev Worker 的脚本执行错误可能只发生在第一次 SharedWorker 句柄
 * 上；WebLoom 只把它呈现为 ready snapshot 前的 disconnected，随后
 * 同名 Worker 的第二个句柄通常只能等到 call deadline，形成一条泛化的
 * timeout。首个错误因此只会是明确的“尚未发布 ready、请检查 Worker
 * console”诊断，不假装拿到了浏览器的 JS exception 文本。该错误把两次
 * 尝试的摘要带到统一 fatal 通道，但不重放任何 capability call。
 */
export class CoordinatorStartupError extends Error {
  readonly firstError: unknown;
  readonly retryError: unknown;

  constructor(firstError: unknown, retryError: unknown) {
    super([
      "Coordinator startup failed after one bounded retry.",
      `Initial attempt: ${startupFailureText(firstError)}`,
      `Retry attempt: ${startupFailureText(retryError)}`,
    ].join("\n"));
    this.name = "CoordinatorStartupError";
    this.firstError = firstError;
    this.retryError = retryError;
    const firstStack = firstError instanceof Error ? firstError.stack : undefined;
    if (firstStack && this.stack) {
      this.stack = `${this.stack}\nCaused by initial Coordinator startup attempt:\n${firstStack}`;
    }
  }
}

export const WEB_STARTUP_REQUIRED_CAPABILITIES = [
  VAULT_SERVICE_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
] as const;

const EMPTY_PLUGIN_INTENT_SNAPSHOT: PluginIntentSnapshot = {
  revision: 0,
  desiredEnabled: {},
  desiredRevision: {},
};

/**
 * 计算身份切换时仍可公开的最早应用装配阶段。
 *
 * Storage onboarding 尚未完成时，Coordinator 仍可能先发布一次
 * `session.state`（例如 booting -> uninitialized）。这条事件只改变 Vault
 * 身份，不能把 storageReady=false 的启动状态提前投影成 vault-selection；
 * 否则 App 会把合法的首次存储选择误判成启动不一致。
 */
export function applicationBootstrapPhaseForStorageReadiness(
  storageReadyForBootstrap: boolean,
  storageAuthenticationRequired = false,
): ApplicationBootstrapPhase {
  return storageReadyForBootstrap
    ? "vault-selection"
    : storageAuthenticationRequired
      ? "storage-authentication"
      : "storage-onboarding";
}

/**
 * 把 Coordinator 返回的 Storage 状态映射成页面启动阶段。
 *
 * `authentication` 表示设备上已有选中的连接，只缺本次密码；它不能和
 * `unselected` 共用首次初始化入口。其它非 ready 状态仍然保留在首次
 * Storage 门禁，等待已有恢复/重试逻辑处理。
 */
export function applicationBootstrapPhaseForStorageStatus(
  storageStatus: unknown,
): ApplicationBootstrapPhase {
  if (storageStatus === "authentication") return "storage-authentication";
  if (storageStatus === "ready") return "vault-selection";
  return "storage-onboarding";
}

/** 把 Coordinator 的会话快照转换成 Window Host 的作用域身份。 */
function runtimeIdentityFromSnapshot(
  snapshot: import("@keymaster/contracts").CoordinatorBootstrapSnapshot,
): RuntimeIdentityTransition {
  return {
    vaultStatus: snapshot.vaultStatus,
    ownerPublicKeyHex: snapshot.vaultStatus === "unlocked" ? snapshot.activePublicKeyHex : undefined,
    sessionEpoch: snapshot.sessionEpoch,
    bucketGeneration: snapshot.storageBucketGeneration,
  };
}

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
    "connect", "getIsConnected", "getConnectionState", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity",
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
    "connect", "getIsConnected", "getConnectionState", "getBootstrapSnapshot", "getSessionEpoch", "subscribeTopic",
    "storageControl", "storageGrant", "storageData", "storageCancel", "storageSessionAbort",
    "refreshStorageBootstrap"
  ]);
}

/** Vault 插件专用 facade：只有 Vault 可以操作私钥与会话生命周期。 */
export function createVaultCoordinatorClient(client: SessionCoordinatorClient): VaultCoordinatorControl {
  const facade = bindCoordinatorMethods<VaultCoordinatorControl>(client, [
    "connect", "getIsConnected", "getConnectionState", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic",
    "unlock", "lock", "activateKey", "vaultOperation", "crypto", "backgroundCancelByKey"
  ]);
  return facade;
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
      "getIsConnected", "getConnectionState", "getBootstrapSnapshot", "subscribeTopic", "backgroundRunNow", "backgroundTrigger",
      "backgroundCancel", "backgroundCancelByKey", "backgroundSettingsUpdate", "reportRecoverableCoordinatorFailure"
    ]);
    case "p2pkh":
    case "woc":
    case "junglebus": return bindCoordinatorMethods<P2pkhCoordinatorControl>(client, [
      "connect", "getIsConnected", "getConnectionState", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity",
      "p2pkhProvidersGet", "p2pkhProvidersUpdate", "p2pkhSettingsUpdate", "p2pkhProviderConfigGet", "p2pkhProviderConfigUpdate",
      "p2pkhBroadcast", "p2pkhRebroadcastAncestors"
    ]);
    case "msfile": return bindCoordinatorMethods<MsFileCoordinatorControl>(client, [
      "connect", "getIsConnected", "getConnectionState", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity",
      "msfileControl", "msfileGrant", "msfileData", "msfileCancel", "msfileSessionAbort"
    ]);
    case "sat-subscription": return bindCoordinatorMethods<SatCoordinatorControl>(client, [
      "connect", "getIsConnected", "getConnectionState", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity",
      "satOperation", "channelOperation"
    ]);
    case "window-p2p": return bindCoordinatorMethods<WindowP2pCoordinatorControl>(client, [
      "connect", "getIsConnected", "getConnectionState", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity",
      "windowP2pExecutorAcquire", "windowP2pExecutorRelease", "windowP2pExecutorSpikeTransfer",
      "windowP2pExecutorSignNoiseStaticKey", "windowP2pExecutorSignPeerRecord"
    ]);
    case "protocol": return bindCoordinatorMethods<ProtocolCoordinatorControl>(client, [
      "connect", "getIsConnected", "getConnectionState", "getBootstrapSnapshot", "getSessionEpoch", "getActivePublicKeyHex", "subscribeTopic", "sendActivity", "channelOperation"
    ]);
    case "contacts": return bindCoordinatorMethods<ContactsCoordinatorControl>(client, [
      "getIsConnected", "getConnectionState", "getBootstrapSnapshot", "subscribeTopic", "contactsPresenceSnapshot"
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
/** 创建页面 Host 使用的受限平台 K-V 句柄；不暴露真实 Provider 或 grant 值。 */
export function createCoordinatorPlatformStore(
  client: SessionCoordinatorClient,
  declaration: PluginStorageDeclaration,
  pluginId = "runtime"
): KeyValueStore {
  if (declaration.scope !== "bucket" || declaration.authority !== "platform-only" || declaration.model !== "kv") {
    throw new Error("Coordinator platform store requires a bucket platform K-V declaration");
  }
  const internalClient = client as SessionCoordinatorClient & StorageBindingCoordinatorClient;
  let currentGrant: import("@keymaster/contracts/storage-internal").StoragePlatformGrant | undefined;
  let grantPromise: Promise<import("@keymaster/contracts/storage-internal").StoragePlatformGrant> | undefined;
  const grant = async () => {
    if (!grantPromise) {
      grantPromise = internalClient.storageBindPlatform({ pluginId, declaration }).then((result) => {
        if (result.status !== "ok") {
          const error = new Error("message" in result ? result.message : `Platform storage bind failed: ${result.status}`) as Error & { code?: string };
          if ("code" in result && typeof result.code === "string") error.code = result.code;
          throw error;
        }
        currentGrant = result.value;
        return result.value;
      }).catch((error) => {
        grantPromise = undefined;
        throw error;
      });
    }
    return grantPromise;
  };
  const invalidateGrant = (expected: import("@keymaster/contracts/storage-internal").StoragePlatformGrant): void => {
    // 并发请求中如果已经完成重绑，旧请求不能把新 grant 一起清掉。
    if (currentGrant !== expected) return;
    currentGrant = undefined;
    grantPromise = undefined;
  };
  const isPreIoGrantValidationFailure = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    // Worker 在打开底层 store 之前完成这两个校验；只有这里允许同一
    // 业务调用重绑一次。越过最终 I/O 后的 stale binding 不能重放写入。
    return message === "Platform storage grant is invalid"
      || message === "Platform storage bucket generation changed";
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
    assertOpen();
    const bound = await grant();
    try {
      return await call<T>(build(bound.platformGrantId));
    } catch (error) {
      if (closed || !isPreIoGrantValidationFailure(error)) {
        // 不重试已经越过远端物理 I/O 的调用；下一次业务调用才重新
        // 获取 grant，避免把不确定的 put/commit 变成重复写入。
        if (isStaleCoordinatorStorageBinding(error)) invalidateGrant(bound);
        throw error;
      }
      invalidateGrant(bound);
      const rebound = await grant();
      return call<T>(build(rebound.platformGrantId));
    }
  };
  return {
    bucketId: "coordinator",
    bucketGeneration: 0,
    ownerPublicKeyHex: "",
    moduleId: declaration.moduleId,
    purposeId: declaration.purposeId,
    scope: declaration.scope,
    authority: declaration.authority,
    model: declaration.model,
    schemaVersion: declaration.schemaVersion,
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

/** 生成启动步骤的人类可读描述，用于 fatal 提示。 */
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
  timeoutMs = BOOTSTRAP_PLUGIN_TIMEOUT_MS,
  stage: PluginBootstrapStage | undefined = plugin.bootstrapStage
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
  } catch (error) {
    throw attachBootstrapErrorContext(error, {
      stage: stage ?? "bootstrap",
      pluginId: plugin.id,
      operation: "register-plugin",
      context: { timeoutMs }
    });
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
  } catch (firstError) {
    // 首次模块 Worker 加载可能恰逢静态资源发布/缓存重新验证。先彻底
    // 关闭失败端口与其自动重连 timer，再进行一次有界重试；第二次仍
    // 失败则保留两次错误，由 main fatal 页面展示首个 pre-ready Worker
    // 诊断，而不是只展示第二次可能泛化的 call timeout。
    try {
      coordinatorClient.disconnect();
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      await coordinatorClient.connect();
    } catch (retryError) {
      throw attachBootstrapErrorContext(
        new CoordinatorStartupError(firstError, retryError),
        {
          stage: "coordinator",
          operation: "connect-coordinator",
          context: { retryAttempt: 2, retryDelayMs }
        }
      );
    }
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
  const { getCoordinatorClient } = await withBootstrapErrorContext({
    stage: "coordinator",
    operation: "load-coordinator-client"
  }, () => import("./keymasterSessionCoordinatorClient.js"));
  // Spike hooks and plugin capabilities must share the same physical port;
  // creating a second client here would bypass the real SharedWorker session.
  const coordinatorClient = runWithBootstrapErrorContext({
    stage: "coordinator",
    operation: "create-coordinator-client"
  }, () => getCoordinatorClient());
  let pageHost: PluginHost | undefined;
  let pageWindowApp: WindowApp | undefined;
  let pageLifecycleClosed = false;
  const disposePageLifecycle = (): void => {
    if (pageLifecycleClosed) return;
    pageLifecycleClosed = true;
    // 页面销毁不是一次可重用的业务断线；撤权同步完成后必须立即通知
    // Coordinator。若等 Host 的异步 teardown（配置/远端连接）结束，
    // 浏览器可能先销毁文档而不再执行 Promise；连接必须尽快撤销，避免
    // 页面继续使用旧代理。Worker 资源由 SharedWorker Host 的 dispose 收口。
    // shutdown 本身只撤销当前页面连接并发送 disconnect；Host cleanup
    // 仍在后台尽力执行，不能反过来阻塞新 Worker 的接管判定。
    coordinatorClient.shutdown();
    const cleanup = pageWindowApp?.dispose("pagehide") ?? pageHost?.dispose("pagehide");
    if (cleanup) {
      void cleanup.catch(() => undefined);
    }
  };
  if (typeof window !== "undefined") {
    // beforeunload 比 pagehide 更早，给 SharedWorker 的 disconnect 控制
    // 消息更大的投递窗口；pagehide 仍作为不触发 beforeunload 的宿主兜底。
    // 不使用 once：BFCache 的 pagehide(persisted=true) 不应关闭会恢复的
    // 页面，恢复后仍必须保留下一次真正销毁的清理监听。
    const onPageHide = (event: PageTransitionEvent): void => {
      if (event.persisted) return;
      disposePageLifecycle();
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
    };
    const onBeforeUnload = (): void => {
      disposePageLifecycle();
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
  }
  try {
    // 插件启停命令的唯一写入面是 SharedWorker。页面 Host 只缓存并投影
    // Worker 快照；命令本身由 UI 通过 host.submitIntent() 发送到这里。
    const pluginIntentCoordinator: PluginIntentCoordinator = {
      get authorityInstanceId() {
        return coordinatorClient.getBootstrapSnapshot().authorityInstanceId;
      },
      snapshot() {
        const snapshot = coordinatorClient.getBootstrapSnapshot().pluginIntent;
        return snapshot
          ? {
              revision: snapshot.revision,
              desiredEnabled: { ...snapshot.desiredEnabled },
              desiredRevision: { ...snapshot.desiredRevision },
            }
          : { ...EMPTY_PLUGIN_INTENT_SNAPSHOT };
      },
      submit(command) {
        return coordinatorClient.pluginIntentSubmit(command);
      },
      subscribe(listener) {
        return coordinatorClient.subscribeTopic("plugin.intent", (event) => {
          if (event.type === "plugin.intent.changed") listener(event.snapshot);
        });
      },
    };

    const runtimeUnitImplementationRegistry = runWithBootstrapErrorContext({
      stage: "bootstrap",
      operation: "create-runtime-unit-registry"
    }, () => createWebRuntimeUnitImplementationRegistry(WEB_PLUGIN_CATALOG));
    const initialRuntimeIdentity = runWithBootstrapErrorContext({
      stage: "coordinator",
      operation: "read-initial-runtime-identity"
    }, () => runtimeIdentityFromSnapshot(coordinatorClient.getBootstrapSnapshot()));
  const host = runWithBootstrapErrorContext({
    stage: "bootstrap",
    operation: "create-plugin-host"
  }, () => createPluginHost({
    initialI18nResources: [SHELL_RESOURCES],
    i18nDebug: !isProd,
    storageBindingAuthority: createStorageBindingAuthority(coordinatorClient as SessionCoordinatorClient & StorageBindingCoordinatorClient & { getActivePublicKeyHex(): string | undefined }),
    coordinatorForPlugin: (pluginId) => createPluginCoordinatorFacade(coordinatorClient, pluginId),
    pluginIntentCoordinator,
    // 真实 RuntimeHandle 在 WindowApp 建立后再 attach；Host 创建阶段不读取
    // Worker、不会把尚未完成的远端目录当成本地 capability。
    // 生产 Window Host 只从当前环境实现注册表取得 setup；静态 manifest
    // 不携带可执行函数，缺少实现时直接保持 fail-closed。
    runtimeUnitImplementationRegistry,
    // 本页面 Host 明确是 Window 执行环境。未来多单元产品没有 Window
    // 单元时会 fail closed，不会把 Worker capability 当作本地能力。
    runtime: "window-main",
    initialRuntimeIdentity,
    approvedPermissionsForPlugin: (pluginId, requested) => {
      const approvedByPlugin: Readonly<Record<string, readonly PluginPermission[]>> = {
        vault: ["identity.read", "storage.read", "storage.write", "crypto.signIntent", "crypto.signTransaction", "vault.exportBackup", "vault.manage"],
        storage: ["storage.read", "storage.write", "storage.platform"],
        protocol: ["identity.read", "crypto.signIntent", "crypto.channel"],
      };
      const approved = new Set(approvedByPlugin[pluginId] ?? []);
      return requested.filter((permission) => approved.has(permission));
    },
    sessionPermissionsForPlugin: (_pluginId, requested) => {
      // 锁定时不向新实例发放 owner/session 权限；Vault 自身只使用
      // Coordinator facade，业务插件会等到解锁后再进入 owner 阶段。
      return coordinatorClient.getBootstrapSnapshot().vaultStatus === "unlocked"
        ? requested
        : [];
    },
    permissionBindingForPlugin: () => ({ policyRevision: 1 }),
    lifecycleIdentityForPlugin: () => {
      const snapshot = coordinatorClient.getBootstrapSnapshot();
      return {
        sessionEpoch: snapshot.sessionEpoch,
        ownerPublicKeyHex: snapshot.vaultStatus === "unlocked" ? snapshot.activePublicKeyHex : undefined,
        bucketGeneration: snapshot.storageBucketGeneration,
      };
    },
    // 页面销毁时给插件一个有限的异步收尾窗口；撤权本身仍同步发生。
    lifecycleCleanupTimeoutMs: 5_000,
  }));
  pageHost = host;
  // Keymaster 的四阶段门禁仍由本装配层控制；createWindowApp 负责把同一
  // WebLoom Window Host 纳入唯一 window-main Runtime，并投影真实 Worker
  // RuntimeHandle。这样不会为了绕过 staged registration 再创建第二个 Host。
  pageWindowApp = await withBootstrapErrorContext({
    stage: "window-app",
    operation: "create-window-app",
    context: { runtime: "window-main" }
  }, () => createWindowAppFromHost({
    id: "keymaster-window",
    host: getWebLoomHost(host),
  }));
  runWithBootstrapErrorContext({
    stage: "window-app",
    operation: "bind-window-app",
    context: { appId: "keymaster-window" }
  }, () => coordinatorClient.setWindowApp(pageWindowApp!));
  await withBootstrapErrorContext({
    stage: "transport",
    operation: "register-window-storage-plugin",
    pluginId: "storage"
  }, () => registerPlugins(pageWindowApp!, [coordinatorClient.createWindowStoragePlugin()]));
  await connectCoordinatorWithStartupRetry(coordinatorClient);
  // `sendHello()` 把 Coordinator 的权威身份快照同步写入 client，但首次
  // `session.state` topic baseline 可能稍后才到达。若此时直接进入 owner
  // 阶段，Adapter 仍会拿创建 Host 时的 `booting` 身份检查 owner-session
  // unit，导致真实第二个 tab 被错误地标成 unavailable。这里把已确认的
  // hello 快照作为启动 barrier 立即投影到 Window Host；后续 topic 事件
  // 仍负责处理真正的世代变化。
  await withBootstrapErrorContext({
    stage: "coordinator",
    operation: "synchronize-runtime-identity",
  }, () => host.transitionRuntimeIdentity(runtimeIdentityFromSnapshot(coordinatorClient.getBootstrapSnapshot())));
  const coordinatorRuntime = runWithBootstrapErrorContext({
    stage: "transport",
    operation: "get-coordinator-runtime-handle"
  }, () => {
    const runtime = coordinatorClient.getRuntimeHandle();
    if (!runtime) throw new Error("Coordinator WebLoom RuntimeHandle is unavailable after connect");
    return runtime;
  });
  runWithBootstrapErrorContext({
    stage: "transport",
    operation: "attach-coordinator-runtime"
  }, () => attachKeymasterRemoteRuntime(host, coordinatorRuntime));
  const storageStatus = await withBootstrapErrorContext({
    stage: "storage-status",
    operation: "read-storage-status"
  }, () => coordinatorClient.storageControl({ type: "status" }));
  // Storage 是独立健康域。Provider/CORS/认证暂不可用时，仍需让页面看到
  // 对应的恢复入口；此时不能再读取平台配置 K-V。尤其是 authentication
  // 只允许已有桶认证页，不能退回首次初始化。
  const storagePhase = storageStatus.status === "ok"
    ? applicationBootstrapPhaseForStorageStatus(storageStatus.value)
    : "storage-onboarding";
  const storageReady = storageStatus.status === "ok" && storageStatus.value === "ready";
  runWithBootstrapErrorContext({
    stage: "transport",
    operation: "publish-coordinator-activity"
  }, () => host.provide(COORDINATOR_ACTIVITY_CAPABILITY, Object.freeze({
    getIsConnected: () => coordinatorClient.getIsConnected(),
    sendActivity: () => coordinatorClient.sendActivity()
  })));
  const bootstrapStatus = runWithBootstrapErrorContext({
    stage: "storage-status",
    operation: "create-bootstrap-status"
  }, () => createApplicationBootstrapStatus({
    phase: storagePhase,
    storageReady,
    vaultCapabilityReady: false,
    hasUnlockedActiveKey: false,
    vaultSelectionReady: false,
    ownerAppsReady: false,
    connectAppsReady: false,
    assetWorkspaceReady: false
  }));
  runWithBootstrapErrorContext({
    stage: "storage-status",
    operation: "publish-bootstrap-status"
  }, () => host.provide(APPLICATION_BOOTSTRAP_READY_CAPABILITY, bootstrapStatus.service));
  runWithBootstrapErrorContext({
    stage: "storage-status",
    operation: "register-shell-resources"
  }, () => registerShellResources(host.capabilities.get(RESOURCE_REGISTRY_CAPABILITY), bootstrapStatus.service));

  // 硬切换 003：直接转发 Coordinator event 给 runtime notifier
  // 装配层只负责转发，合并语义由 runtime notifier 实现
  const dataNotifier = runWithBootstrapErrorContext({
    stage: "transport",
    operation: "get-asset-data-notifier"
  }, () => host.capabilities.get(ASSET_DATA_NOTIFIER_CAPABILITY));
  runWithBootstrapErrorContext({
    stage: "transport",
    operation: "subscribe-asset-data-changes"
  }, () => coordinatorClient.subscribeTopic("asset.data-changed", (event) => {
    if (event.type === "asset.data-changed") {
      dataNotifier.emit(event);
    }
  }));

  // 硬切换 004：启动清单按 manifest.meta.bootstrapStage 分成四道门禁。
  // 阶段字段是唯一真值；这里不能根据 pluginId、kind 或 storage scope 猜测。
  const fullCatalog = [...WEB_PLUGIN_CATALOG];
  const bootstrapStages: readonly PluginBootstrapStage[] = [
    "storage-onboarding",
    "vault-selection",
    "owner-apps-ready",
    "connect-apps-ready"
  ];
  const missingBootstrapStage = fullCatalog.filter((plugin) => !plugin.bootstrapStage);
  if (missingBootstrapStage.length > 0) {
    throw attachBootstrapErrorContext(
      new Error(`Web plugin catalog has no bootstrapStage: ${missingBootstrapStage.map((plugin) => plugin.id).join(", ")}`),
      { stage: "bootstrap", operation: "validate-bootstrap-stages" }
    );
  }
  const catalogForStage = (catalog: readonly PluginManifest[], stage: PluginBootstrapStage): PluginManifest[] =>
    catalog.filter((plugin) => plugin.bootstrapStage === stage);
  const phaseOneCatalog = catalogForStage(fullCatalog, "storage-onboarding");
  if (phaseOneCatalog.length === 0) {
    throw attachBootstrapErrorContext(
      new Error("Web plugin catalog must contain a storage-onboarding plugin"),
      { stage: "storage-onboarding", operation: "validate-bootstrap-catalog" }
    );
  }

  // 施工单 2026-07-08 001 硬切换：装配层对 plugin-bsv-price 的 Window
  // runtime unit 显式注入 `pricePublisherPublicKeyHex` seed；它只在本地配置缺失时作为首次
  // 默认值，运行时真值由 BSV Price owner/App K-V 接管。
  //
  // 关键约束：
  //   - 装配层只替换 Window unit 的 `config`，不把配置放回产品级 manifest；
  //     plugin 用 `ctx.config[BSV_PRICE_CONFIG_KEY]`
  //     读来决定首次 seed；
  //   - 配置来源集中：`pluginConfigs.ts`；
  //   - plugin 自己**不**走 `globalThis.__XXX__` 隐式注入路径。
  //
  // 这里用临时的 Window unit 描述挂上 config，避免对其它 plugin 的
  // manifest 顺序造成影响。
  const fullCatalogWithConfig: PluginManifest[] = fullCatalog.map((p) => {
    if (p.id === "bsv-price") {
      return {
        ...p,
        units: p.units?.map((unit) => unit.runtime === "window-main"
          ? { ...unit, config: { ...bsvPriceConfig } }
          : unit),
      };
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
  let assetWorkspaceDisposer: (() => void) | undefined;
  let storageReadyForBootstrap = storageReady;
  let sessionStateOff: (() => void) | undefined;
  let ownerAssemblyGeneration = 0;
  // connect() 已经完成 hello 和 topic baseline；以此刻 Coordinator 的
  // 权威快照作为 observed baseline。否则首次 session.state baseline 会把
  // 启动阶段刚同步过的同一身份误判为一次 owner 切换，重入
  // runOwnerAndConnectStages，并在旧实例仍 starting 时触发 StartupCapabilityError。
  let observedRuntimeIdentity = runtimeIdentityFromSnapshot(coordinatorClient.getBootstrapSnapshot());
  let observedRuntimeIdentityKey = runtimeIdentityKeyFor(observedRuntimeIdentity);

  // 页面销毁时也要回收不是由某个业务 manifest 直接拥有的资产工作区。
  runWithBootstrapErrorContext({
    stage: "bootstrap",
    operation: "register-asset-workspace-cleanup"
  }, () => host.rootScope.onDispose(() => {
    assetWorkspaceDisposer?.();
    assetWorkspaceDisposer = undefined;
  }, "asset-workspace-lifecycle"));

  function runtimeIdentityKeyFor(identity: RuntimeIdentityTransition): string {
    return `${identity.vaultStatus}|${identity.ownerPublicKeyHex ?? ""}|${identity.sessionEpoch}|${identity.bucketGeneration ?? "unknown"}`;
  }

  /**
   * Owner 阶段可能由 storage-ready 回调先于 `session.state` baseline 触发。
   * 在装配 owner 插件前，把当前 Coordinator 快照先提交给 Host，并立即
   * 更新 observed baseline；这样随后到达的同一身份事件只会刷新目录，
   * 不会把正在启动的 owner 阶段误判为第二次身份切换并停掉。
   */
  let runtimeIdentitySyncPromise: Promise<void> | undefined;
  const synchronizeRuntimeIdentityBeforeOwnerStage = (): Promise<void> => {
    if (runtimeIdentitySyncPromise) return runtimeIdentitySyncPromise;
    const task = (async () => {
      const next = runtimeIdentityFromSnapshot(coordinatorClient.getBootstrapSnapshot());
      const nextKey = runtimeIdentityKeyFor(next);
      if (nextKey === observedRuntimeIdentityKey) return;
      observedRuntimeIdentity = next;
      observedRuntimeIdentityKey = nextKey;
      await withBootstrapErrorContext({
        stage: "coordinator",
        operation: "synchronize-runtime-identity-before-owner-stage",
      }, () => host.transitionRuntimeIdentity(next));
    })().finally(() => {
      if (runtimeIdentitySyncPromise === task) runtimeIdentitySyncPromise = undefined;
    });
    runtimeIdentitySyncPromise = task;
    return task;
  };

  const currentActiveKey = (stage: BootstrapErrorStage = "coordinator"): { unlocked: boolean; activePublicKeyHex?: string } =>
    runWithBootstrapErrorContext({
      stage,
      operation: "read-active-key-state"
    }, () => {
      const snapshot = coordinatorClient.getBootstrapSnapshot();
      const unlocked = snapshot.vaultStatus === "unlocked" && typeof snapshot.activePublicKeyHex === "string";
      return { unlocked, activePublicKeyHex: unlocked ? snapshot.activePublicKeyHex : undefined };
    });

  const updateBootstrapStatus = (
    patch: Partial<ApplicationBootstrapSnapshot>,
    stage: BootstrapErrorStage = "bootstrap"
  ): void => {
    runWithBootstrapErrorContext({ stage, operation: "update-bootstrap-status" }, () => {
      bootstrapStatus.set({ ...bootstrapStatus.service.snapshot(), ...patch });
    });
  };

  const registerStage = async (stage: PluginBootstrapStage, retryFailed = false): Promise<void> =>
    withBootstrapErrorContext({ stage, operation: "register-stage" }, async () => {
      const plugins = catalogForStage(fullCatalogWithConfig, stage);
      host.configStore.setRequiredPluginIds(
        fullCatalogWithConfig.filter((plugin) => plugin.startup === "required").map((plugin) => plugin.id)
      );
      const enabledByConfig = new Set(
        host.configStore.resolveEnabled(plugins.map((plugin) => plugin.id), (pluginId) =>
          plugins.find((plugin) => plugin.id === pluginId)?.defaultEnabled ?? false
        ).enabled
      );
      for (const plugin of plugins) {
        const existing = host.getManifest(plugin.id);
        if (!existing) {
          await registerPluginWithTimeout(host, plugin, BOOTSTRAP_PLUGIN_TIMEOUT_MS, stage);
          continue;
        }
        // register() 负责 required/immutable 插件的失败重放；显式的应用
        // 装配重试还会按持久化启停配置重试已开启的 optional 插件。
        await registerPluginWithTimeout(host, plugin, BOOTSTRAP_PLUGIN_TIMEOUT_MS, stage);
        const state = host.state(plugin.id);
        const shouldRetry = retryFailed
          && (plugin.startup === "required" || plugin.canDisable === false || enabledByConfig.has(plugin.id))
          && (state.kind === "error-disabled" || state.kind === "blocked");
        if (shouldRetry) {
          await withBootstrapErrorContext({ stage, pluginId: plugin.id, operation: "retry-plugin" }, () => host.retry(plugin.id));
        }
      }
    });

  const runOwnerAndConnectStages = async (retryFailed = false): Promise<void> => {
    await synchronizeRuntimeIdentityBeforeOwnerStage();
    const active = currentActiveKey("owner-apps-ready");
    if (!active.unlocked) return;
    if (ownerAppsPromise) return ownerAppsPromise;
    const generation = ownerAssemblyGeneration;
    const isCurrentOwnerGeneration = (): boolean =>
      generation === ownerAssemblyGeneration && currentActiveKey("owner-apps-ready").unlocked;
    const stagePromise = (async () => {
      updateBootstrapStatus({ phase: "vault-selection", hasUnlockedActiveKey: true }, "owner-apps-ready");
      if (!isCurrentOwnerGeneration()) return;
      await registerStage("owner-apps-ready", retryFailed);
      if (!isCurrentOwnerGeneration()) return;
      ownerAppsReady = true;
      updateBootstrapStatus({ phase: "owner-apps-ready", hasUnlockedActiveKey: true, ownerAppsReady: true }, "owner-apps-ready");
      if (!assetWorkspaceReady) {
        const disposeWorkspace = await withBootstrapErrorContext({
          stage: "owner-apps-ready",
          operation: "register-asset-workspace"
        }, () => registerAssetWorkspace(host));
        if (!isCurrentOwnerGeneration()) {
          runWithBootstrapErrorContext({
            stage: "owner-apps-ready",
            operation: "dispose-stale-asset-workspace"
          }, () => disposeWorkspace());
          return;
        }
        assetWorkspaceDisposer = disposeWorkspace;
        assetWorkspaceReady = true;
      }
      if (!isCurrentOwnerGeneration()) return;
      updateBootstrapStatus({ assetWorkspaceReady: true }, "owner-apps-ready");
      await registerStage("connect-apps-ready", retryFailed);
      if (!isCurrentOwnerGeneration()) return;
      connectAppsReady = true;
      runWithBootstrapErrorContext({
        stage: "connect-apps-ready",
        operation: "assert-startup-capabilities"
      }, () => assertWebStartupContract(host));
      updateBootstrapStatus({
        phase: "connect-apps-ready",
        hasUnlockedActiveKey: true,
        ownerAppsReady,
        connectAppsReady,
        assetWorkspaceReady: true
      }, "connect-apps-ready");
    })();
    ownerAppsPromise = stagePromise;
    try {
      await stagePromise;
    } catch (error) {
      if (ownerAppsPromise === stagePromise) {
        ownerAppsPromise = undefined;
        updateBootstrapStatus({
          phase: "error",
          storageReady: true,
          vaultCapabilityReady: host.capabilities.has(VAULT_SERVICE_CAPABILITY) && host.capabilities.has(KEYSPACE_SERVICE_CAPABILITY),
          hasUnlockedActiveKey: currentActiveKey("owner-apps-ready").unlocked,
          vaultSelectionReady,
          ownerAppsReady,
          connectAppsReady,
          assetWorkspaceReady,
          error: formatStartupErrorSummary(error)
        }, "owner-apps-ready");
      }
      throw error;
    }
  };

  const enterVaultSelectionStage = async (retryFailed = false): Promise<void> => {
    if (!storageReadyForBootstrap) return;
    if (vaultSelectionPromise) return vaultSelectionPromise;
    vaultSelectionPromise = (async () => {
      updateBootstrapStatus({ phase: "vault-selection", storageReady: true }, "vault-selection");
      await withBootstrapErrorContext({
        stage: "vault-selection",
        operation: "hydrate-plugin-config"
      }, () => host.configStore.hydrate());
      runWithBootstrapErrorContext({
        stage: "vault-selection",
        operation: "validate-plugin-catalog"
      }, () => host.validateManifestSet(fullCatalogWithConfig));
      await registerStage("vault-selection", retryFailed);
      runWithBootstrapErrorContext({
        stage: "vault-selection",
        operation: "assert-vault-capabilities"
      }, () => host.assertCapabilities(WEB_STARTUP_REQUIRED_CAPABILITIES, { phase: "vault-selection" }));
      vaultSelectionReady = true;
      const active = currentActiveKey("vault-selection");
      updateBootstrapStatus({
        phase: "vault-selection",
        storageReady: true,
        vaultCapabilityReady: true,
        hasUnlockedActiveKey: active.unlocked,
        vaultSelectionReady: true
      }, "vault-selection");
      if (active.unlocked) await runOwnerAndConnectStages(retryFailed);
    })();
    try {
      await vaultSelectionPromise;
    } catch (error) {
      vaultSelectionPromise = undefined;
      updateBootstrapStatus({
        phase: "error",
        storageReady: true,
        vaultCapabilityReady: host.capabilities.has(VAULT_SERVICE_CAPABILITY) && host.capabilities.has(KEYSPACE_SERVICE_CAPABILITY),
        hasUnlockedActiveKey: currentActiveKey("vault-selection").unlocked,
        vaultSelectionReady,
        ownerAppsReady,
        connectAppsReady,
        assetWorkspaceReady,
        error: formatStartupErrorSummary(error)
      }, "vault-selection");
      throw error;
    }
  };

  const retryApplicationBootstrap = async (): Promise<void> => {
    if (!storageReadyForBootstrap) return;
    await enterVaultSelectionStage(true);
    if (currentActiveKey("vault-selection").unlocked) await runOwnerAndConnectStages(true);
  };
  runWithBootstrapErrorContext({
    stage: "vault-selection",
    operation: "publish-bootstrap-retry"
  }, () => bootstrapStatus.setRetry(retryApplicationBootstrap));

  const phaseOneRequiredCatalog = phaseOneCatalogWithConfig;

  runWithBootstrapErrorContext({
    stage: "storage-onboarding",
    operation: "validate-plugin-catalog"
  }, () => host.validateManifestSet(fullCatalogWithConfig));
  runWithBootstrapErrorContext({
    stage: "storage-onboarding",
    operation: "configure-required-plugins"
  }, () => host.configStore.setRequiredPluginIds(
    phaseOneRequiredCatalog.filter((plugin) => plugin.startup === "required").map((plugin) => plugin.id)
  ));
  for (const plugin of phaseOneCatalogWithConfig) {
    await registerPluginWithTimeout(host, plugin, BOOTSTRAP_PLUGIN_TIMEOUT_MS, "storage-onboarding");
  }
  if (!storageReady) {
    const storageService = runWithBootstrapErrorContext({
      stage: "storage-onboarding",
      operation: "get-storage-runtime-controller"
    }, () => host.capabilities.get(STORAGE_RUNTIME_CONTROLLER_CAPABILITY));
    const offStorageReady = runWithBootstrapErrorContext({
      stage: "storage-onboarding",
      operation: "subscribe-storage-ready"
    }, () => storageService.subscribe(() => {
      try {
        if (runWithBootstrapErrorContext({
          stage: "storage-onboarding",
          operation: "read-storage-readiness"
        }, () => storageService.status()) !== "ready") return;
        storageReadyForBootstrap = true;
        void enterVaultSelectionStage().catch((error) => {
          // 异步回调不能再交给 bootstrapPlugins() 的 caller；状态页保留
          // 可重试入口，同时用同一套结构化/脱敏摘要暴露真实阶段。
          console.error("[bootstrap] Storage-ready plugin assembly failed", error);
        });
      } catch (error) {
        updateBootstrapStatus({ phase: "error", error: formatStartupErrorSummary(error) }, "storage-onboarding");
        console.error("[bootstrap] Storage-ready callback failed", error);
      }
    }));
    // subscribe() is intentionally not an immediate callback; handle a
    // ready baseline explicitly for a race between status() and subscription.
    if (runWithBootstrapErrorContext({
      stage: "storage-onboarding",
      operation: "read-storage-readiness"
    }, () => storageService.status()) === "ready") {
      storageReadyForBootstrap = true;
      await enterVaultSelectionStage();
    }
    void offStorageReady;
  } else {
    await enterVaultSelectionStage();
  }

  let sessionTransitionTail = Promise.resolve();
  const handleSessionStateChanged = async (): Promise<void> => {
    // session.state 可能已经排队，而页面在这段时间内主动 disconnect
    // 并建立了新的 Runtime。旧事件不能继续让 Host enable storage；否则
    // 正常的 late result 会被误报成启动错误并污染浏览器 console。
    const runtimeAtStart = coordinatorClient.getRuntimeHandle();
    const isCurrentConnection = (): boolean => Boolean(
      runtimeAtStart
      && coordinatorClient.getIsConnected()
      && coordinatorClient.getRuntimeHandle() === runtimeAtStart,
    );
    if (!isCurrentConnection()) return;
    try {
      await withBootstrapErrorContext({
        stage: "coordinator",
        operation: "handle-session-state"
      }, async () => {
        if (!isCurrentConnection()) return;
    const nextIdentity = runWithBootstrapErrorContext({
      stage: "coordinator",
      operation: "read-runtime-identity"
    }, () => runtimeIdentityFromSnapshot(coordinatorClient.getBootstrapSnapshot()));
    const nextKey = runtimeIdentityKeyFor(nextIdentity);
    const identityChanged = nextKey !== observedRuntimeIdentityKey;
    const ownerIdentityChanged = observedRuntimeIdentity.vaultStatus !== nextIdentity.vaultStatus
      || (observedRuntimeIdentity.ownerPublicKeyHex ?? "") !== (nextIdentity.ownerPublicKeyHex ?? "")
      || observedRuntimeIdentity.sessionEpoch !== nextIdentity.sessionEpoch;

    // Worker 运行单元属于 session 世代；Coordinator client 在世代切换时
    // 会先清空旧后台快照，Host 必须立即重新投影，不能等下一条 unit 事件。
    runWithBootstrapErrorContext({
      stage: "coordinator",
      operation: "refresh-runtime-unit-snapshots"
    }, () => host.refreshRuntimeUnitSnapshots());
    if (!isCurrentConnection()) return;
    if (!identityChanged) {
      const active = currentActiveKey("coordinator");
      if (vaultSelectionReady) {
        updateBootstrapStatus({ hasUnlockedActiveKey: active.unlocked }, "coordinator");
        if (active.unlocked && !connectAppsReady) await runOwnerAndConnectStages();
      }
      return;
    }

    observedRuntimeIdentityKey = nextKey;
    observedRuntimeIdentity = nextIdentity;
    const staleOwnerAssembly = ownerIdentityChanged ? ownerAppsPromise : undefined;
    if (ownerIdentityChanged) {
      // 这不是用户 disable：意图保持不变，但当前 Window owner 实例和
      // 资产工作区必须立刻从所有入口消失，不能等待网络 teardown。
      ownerAssemblyGeneration += 1;
      ownerAppsPromise = undefined;
      ownerAppsReady = false;
      connectAppsReady = false;
      runWithBootstrapErrorContext({
        stage: "owner-apps-ready",
        operation: "dispose-owner-asset-workspace"
      }, () => assetWorkspaceDisposer?.());
      assetWorkspaceDisposer = undefined;
      assetWorkspaceReady = false;
      updateBootstrapStatus({
        hasUnlockedActiveKey: nextIdentity.vaultStatus === "unlocked",
        ownerAppsReady: false,
        connectAppsReady: false,
        assetWorkspaceReady: false,
        phase: applicationBootstrapPhaseForStorageReadiness(
          storageReadyForBootstrap,
          storagePhase === "storage-authentication",
        )
      }, "coordinator");
    }

    // transitionRuntimeIdentity 的同步前半段会在此调用返回前撤销旧
    // owner Scope；await 部分只等待有界异步清理，再按新身份重建实例。
    await withBootstrapErrorContext({
      stage: "coordinator",
      operation: "transition-runtime-identity",
      context: { identityChanged, ownerIdentityChanged }
    }, () => host.transitionRuntimeIdentity(nextIdentity));
    if (!isCurrentConnection()) return;
    await staleOwnerAssembly?.catch(() => undefined);

    if (!vaultSelectionReady) return;
    const active = currentActiveKey("coordinator");
    updateBootstrapStatus({ hasUnlockedActiveKey: active.unlocked }, "coordinator");
    if (active.unlocked && !connectAppsReady) await runOwnerAndConnectStages();
      });
    } catch (error) {
      // disconnect/reconnect 是合法的生命周期路径；若错误来自已失效的
      // Runtime，仅丢弃该旧事件。当前 Runtime 仍有效时继续上抛，让统一
      // bootstrap error 通道暴露真实故障。
      if (!isCurrentConnection()) return;
      throw error;
    }
  };

  sessionStateOff = runWithBootstrapErrorContext({
    stage: "coordinator",
    operation: "subscribe-session-state"
  }, () => coordinatorClient.subscribeTopic("session.state", (event) => {
    if (event.type !== "session.state.changed") return;
    // session.state 事件顺序就是身份世代顺序；串行处理可避免 A -> B
    // 的旧异步阶段在 B -> A 时覆盖新阶段状态。
    sessionTransitionTail = sessionTransitionTail
      .then(handleSessionStateChanged)
      .catch((error) => {
        updateBootstrapStatus({
          phase: "error",
          error: formatStartupErrorSummary(error)
        }, "coordinator");
        console.error("[bootstrap] session identity transition failed", error);
      });
  }));
  void sessionStateOff;

    return host;
  } catch (error) {
    disposePageLifecycle();
    throw attachBootstrapErrorContext(error, {
      stage: "bootstrap",
      operation: "bootstrap"
    });
  }
}
