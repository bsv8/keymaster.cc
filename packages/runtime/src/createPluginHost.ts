// packages/runtime/src/createPluginHost.ts
// 插件宿主：初始化内置 registry、组装 capability + messageBus、调度 setup/teardown
// 生命周期、支持运行时 enable / disable / unregister。
//
// 硬切换 001：runtime 进入真正的"运行期可卸载"模型。
//   - register / registerAll 仍兼容旧调用：把 plugins 注入"已知 manifest"集合，
//     并按 config store 决定初始 enable 集合。
//   - enable / disable / unregister 走完整 ownership 回收流程。
//   - version / subscribe 让 React 感知 host 变化。
//   - 旧 plugin setup 仍可只返回 void；host 走 owner 快照 diff 来回收。
//   - 新 plugin setup 可返回 teardown 函数（PluginTeardown）。
//   - i18n 资源通过 pluginId 跟踪，unregisterResources(pluginId) 精确回收。
//   - 当前 route 属于被 disable 的 plugin 时，host 会先调用 navigateTo 跳走。
//
// 消息、Channel 和网络生命周期不由 runtime 维护；插件直接声明并消费
// 自己所需的 capability，SharedWorker Coordinator 负责唯一网络真值。

import type {
  AssetDataInvalidationEvent,
  AssetDataNotifier,
  HostListener,
  I18nPluginResources,
  I18nService,
  KeyspaceService,
  KeyValueStore,
  LogService,
  MessageBus,
  PluginContext,
  PluginGraph,
  PluginManifest,
  PluginBusinessContribution,
  StartupCapabilityErrorDetails,
  StartupPluginErrorDetails,
  PluginReverseDep,
  PluginState,
  PluginStateKind,
  LifecycleCleanup,
  LifecycleDisposeResult,
  LifecycleScope,
  LifecycleScopeIdentity,
  PluginPermission,
  PermissionLease,
  PermissionLeaseBinding,
  PluginIntentCommand,
  PluginIntentCoordinator,
  PluginIntentSnapshot,
  PluginIntentSubmissionResult,
  CoordinatorWorkerUnitSnapshot,
  RemoteServiceBridge,
  RuntimeUnitImplementationRegistry,
  RuntimeIdentityTransition,
  PluginLifetime,
  ScopedTaskScheduler,
  NoticeRegistry,
  ResourceRegistry,
  TopbarRegistry,
  VaultService
} from "@keymaster/contracts";
import {
  ASSET_DATA_NOTIFIER_CAPABILITY,
  I18N_SERVICE_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  LOG_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  CHANNEL_RUNTIME_CAPABILITY,
  RUNTIME_MESSAGE_BUS as RUNTIME_MESSAGE_BUS_CONTRACT,
  SCOPED_TASK_SCHEDULER_CAPABILITY
} from "@keymaster/contracts";
import { assertSystemStorageDeclaration, validatePluginStorageDeclaration, type PluginStorageDeclaration } from "@keymaster/contracts";
import type { ChannelRuntime, ChannelRuntimeFactory } from "@keymaster/contracts";
import type { ContactPublicKeyActionRegistry } from "@keymaster/contracts";
import type { StorageBindingAuthority } from "@keymaster/contracts/storage-internal";

import { createCapabilityRegistry, type CapabilityRegistry } from "./capabilityRegistry.js";
import { createMessageBus } from "./messageBus.js";
import { createAssetRegistry, type AssetRegistry } from "./registries/assetRegistry.js";
import { createApplicationSettingsRegistry, type ApplicationSettingsRegistry } from "./registries/applicationSettingsRegistry.js";
import { createBreadcrumbRegistry, type BreadcrumbRegistry } from "./registries/breadcrumbRegistry.js";
import { createCollectibleRegistry, type CollectibleRegistry } from "./registries/collectibleRegistry.js";
import { createCollectibleTransferRegistry, type CollectibleTransferRegistry } from "./registries/collectibleTransferRegistry.js";
import { createCommandRegistry, type CommandRegistry } from "./registries/commandRegistry.js";
import { createHomeRegistry, type HomeRegistry } from "./registries/homeRegistry.js";
import { createBusinessFeatureRegistry, type BusinessFeatureRegistry } from "./registries/businessFeatureRegistry.js";
import { createImporterRegistry, type ImporterRegistry } from "./registries/importerRegistry.js";
import { createNoticeRegistry } from "./registries/noticeRegistry.js";
import { createRouteRegistry, type RouteRegistry } from "./registries/routeRegistry.js";
import { createSettingsRegistry, type SettingsRegistry } from "./registries/settingsRegistry.js";
import { createSystemSettingsRegistry, type SystemSettingsRegistry } from "./registries/systemSettingsRegistry.js";
import { createSystemStatusRegistry, type SystemStatusRegistry } from "./registries/systemStatusRegistry.js";
import { createVaultSettingsRegistry, type VaultSettingsRegistry } from "./registries/vaultSettingsRegistry.js";
import { createTokenRegistry, type TokenRegistry } from "./registries/tokenRegistry.js";
import { createTopbarRegistry } from "./registries/topbarRegistry.js";
import { createTransferRegistry, type TransferRegistry } from "./registries/transferRegistry.js";
import { createContactPublicKeyActionRegistry } from "./registries/contactPublicKeyActionRegistry.js";
import { createI18nService } from "./i18n/createI18nService.js";
import { createLogService, type LogServiceHandle } from "./log/logService.js";
import { createPluginConfigStore } from "./pluginConfigStore.js";
import type { PluginConfigStore } from "./pluginConfigStoreContract.js";
import {
  buildPluginGraph,
  dependenciesOfManifest,
  providesOfManifest,
  reverseDependentsOf,
  validatePluginGraph,
} from "./pluginGraph.js";
import { emptyOwnership, type PluginOwnership } from "./pluginOwnership.js";
import { createResourceRegistry, registerOwnedResource } from "./resources/resourceRegistry.js";
import { createResourceStore, type ResourceStoreApi } from "./resources/resourceStore.js";
import { createProtectedOutpointRegistry, type ProtectedOutpointRegistry } from "./registries/protectedOutpointRegistry.js";
import { createLifecycleScope } from "./lifecycle/resourceScope.js";
import { createScopedMessageBus } from "./lifecycle/scopedMessageBus.js";
import { createScopedChannelRuntime } from "./lifecycle/scopedChannelRuntime.js";
import { createScopedTaskScheduler } from "./lifecycle/taskScheduler.js";
import { createPermissionLease } from "./lifecycle/permissionLease.js";
import {
  createScopedRegistryFacade,
  type CreateScopedRegistryFacadeOptions,
} from "./lifecycle/scopedRegistry.js";
import { LifecycleScopeRevokedError } from "@keymaster/contracts";

const RUNTIME_MESSAGE_BUS = RUNTIME_MESSAGE_BUS_CONTRACT;
const TOPBAR_REGISTRY_CAPABILITY = "topbar.registry";

/** 硬切换 002：runtime 系统日志统一使用的 pluginId。 */
const RUNTIME_SYSTEM_PLUGIN_ID = "runtime";

function lifecycleErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error
    && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

/** runtime messageBus capability key；重新导出以便 manifest 集中引用。 */
export { RUNTIME_MESSAGE_BUS };

export interface PluginHost {
  capabilities: CapabilityRegistry;
  messageBus: MessageBus;
  routes: RouteRegistry;
  breadcrumbs: BreadcrumbRegistry;
  settings: SettingsRegistry;
  systemSettings: SystemSettingsRegistry;
  systemStatus: SystemStatusRegistry;
  vaultSettings: VaultSettingsRegistry;
  applicationSettings: ApplicationSettingsRegistry;
  home: HomeRegistry;
  business: BusinessFeatureRegistry;
  commands: CommandRegistry;
  importers: ImporterRegistry;
  transfers: TransferRegistry;
  contactPublicKeyActions: ContactPublicKeyActionRegistry;
  assets: AssetRegistry;
  tokens: TokenRegistry;
  collectibles: CollectibleRegistry;
  collectibleTransfer: CollectibleTransferRegistry;
  protectedOutpoints: ProtectedOutpointRegistry;
  topbar: TopbarRegistry;
  notice: NoticeRegistry;
  i18n: I18nService;
  /** 硬切换 002：runtime 内建 log service（统一日志平台）。 */
  log: LogService;
  /** 启停全局配置（平台 settings K-V 持久化）。 */
  configStore: PluginConfigStore;
  /** Coordinator 唯一插件意图控制面；未注入时保留测试/旧宿主兼容。 */
  readonly pluginIntent?: PluginIntentCoordinator;
  /** 硬切换 003：资源存储（React 读业务数据、订阅业务数据变更的唯一框架入口）。 */
  resourceStore: ResourceStoreApi;

  // ===== 查询 / 旧兼容 =====
  installed(): string[];
  manifests(): string[];
  state(pluginId: string): PluginState;
  /** 查询当前实例作用域；不返回已停止实例。 */
  scope(pluginId: string): LifecycleScope | undefined;
  /** 当前执行环境根作用域；Host dispose 时先同步撤权再异步收尾。 */
  readonly rootScope: LifecycleScope;
  /** 远程运行单元快照变化后刷新产品页投影。 */
  refreshRuntimeUnitSnapshots(): void;
  /**
   * 切换 Window 的 Vault/owner/session 身份：同步撤销旧 owner 作用域，
   * 保留产品启用意图，并在新身份可用后重建新的运行实例。
   */
  transitionRuntimeIdentity(identity: RuntimeIdentityTransition): Promise<void>;
  /** 绑定执行环境根作用域的任务调度器。 */
  readonly taskScheduler: ScopedTaskScheduler;
  graph(): PluginGraph;
  version(): number;
  subscribe(listener: HostListener): () => void;
  getManifest(pluginId: string): PluginManifest | undefined;
  reverseDeps(pluginId: string): PluginReverseDep[];

  // ===== 旧 register 流程 =====
  register(plugin: PluginManifest): Promise<void>;
  registerAll(plugins: PluginManifest[]): Promise<void>;
  validateManifestSet(plugins: readonly PluginManifest[]): void;
  /** 注册一个 builtin capability（语义上等同于 plugin provide）。 */
  provide<T>(key: string, value: T): void;

  // ===== 新生命周期 =====
  enable(pluginId: string): Promise<void>;
  /** 清除 blocked/error-disabled 状态并显式重试插件装配。 */
  retry(pluginId: string): Promise<void>;
  /** 提交产品级绝对启停意图，并在本地投影运行实例结果。 */
  submitIntent(pluginId: string, desiredEnabled: boolean): Promise<PluginIntentSubmissionResult>;
  disable(pluginId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  unregister(pluginId: string): Promise<void>;
  /** 销毁整个执行环境 Host；清理失败仍保持撤权并返回根作用域结果。 */
  dispose(reason?: string): Promise<LifecycleDisposeResult>;
  assertCapabilities(capabilities: readonly string[], options?: { phase?: string }): void;
}

export class StartupCapabilityError extends Error {
  readonly details: StartupCapabilityErrorDetails[];
  constructor(details: StartupCapabilityErrorDetails[], phase = "startup") {
    super(`Startup prerequisite unavailable: ${details.map((d) => d.capability).join(", ")} (${phase})`);
    this.name = "StartupCapabilityError";
    this.details = details;
  }
}

export class StartupPluginError extends Error {
  readonly details: StartupPluginErrorDetails;
  constructor(details: StartupPluginErrorDetails) {
    super(`Startup plugin failed: ${details.pluginId}`);
    this.name = "StartupPluginError";
    this.details = details;
  }
}

export interface CreatePluginHostOptions {
  initialI18nResources?: I18nPluginResources[];
  i18nDebug?: boolean;
  disableConfigPersistence?: boolean;
  /** Tests: disable runtime log persistence/startup and drop append writes. */
  disableLogPersistence?: boolean;
  /** 生产装配层注入 logs platform K-V 句柄。 */
  logStorage?: KeyValueStore;
  /** 生产装配层注入 runtime settings platform K-V 句柄。 */
  configStorage?: KeyValueStore;
  /** 无远端配置时使用的初始内存插件启停配置。 */
  initialPluginConfig?: Record<string, boolean>;
  /** Host 内部存储绑定权威；不向业务插件暴露。 */
  storageBindingAuthority?: StorageBindingAuthority;
  /** 生产环境的唯一插件意图控制面；Host 不自行持久化用户启停命令。 */
  pluginIntentCoordinator?: PluginIntentCoordinator;
  /**
   * 由应用装配层按 manifest.id 生成插件专属 Coordinator 面。
   * runtime 不理解各业务 RPC，也不会把一个通用 client 注入所有插件。
   */
  coordinatorForPlugin?: (pluginId: string) => unknown;
  /** 为插件提供已完成握手 / 快照校验的远程服务桥。 */
  serviceBridgeForPlugin?: (pluginId: string, instanceId: string) => RemoteServiceBridge | undefined;
  /** 可信装配策略批准的权限；未批准的 manifest 权限不会进入上下文。 */
  approvedPermissionsForPlugin?: (
    pluginId: string,
    requested: readonly PluginPermission[]
  ) => readonly PluginPermission[];
  /** 当前 owner / Connect 会话允许的权限；缺省表示本次 Host 不再收窄。 */
  sessionPermissionsForPlugin?: (
    pluginId: string,
    requested: readonly PluginPermission[]
  ) => readonly PluginPermission[];
  /** 为最终权限租约绑定不可替换的策略/Connect 授权修订和 grantId。 */
  permissionBindingForPlugin?: (
    pluginId: string,
    unitId: string,
    requested: readonly PluginPermission[]
  ) => Partial<Pick<PermissionLeaseBinding, "policyRevision" | "grantRevision" | "grantId">>;
  /** 当前 Host 装载的实际执行环境；多单元产品必须显式指定。 */
  execution?: import("@keymaster/contracts").PluginExecution;
  /** Host 初始身份；生产 Window 应在首次注册插件前提供。 */
  initialRuntimeIdentity?: RuntimeIdentityTransition;
  /** 为新实例提供 owner / session / bucket / 授权修订；返回值只作为绑定元数据。 */
  lifecycleIdentityForPlugin?: (
    pluginId: string,
    unitId: string
  ) => Partial<Pick<LifecycleScopeIdentity, "ownerPublicKeyHex" | "sessionEpoch" | "bucketGeneration" | "authorizationRevision">>;
  /** 插件作用域每项清理的等待上限；超时仍保持撤权。 */
  lifecycleCleanupTimeoutMs?: number;
  /** Coordinator Worker 的实际运行单元快照；缺失时页面必须显示 unknown。 */
  runtimeUnitSnapshots?: () => readonly CoordinatorWorkerUnitSnapshot[];
  /** 当前执行环境的可执行实现；运行单元描述本身不携带 setup 函数。 */
  runtimeUnitImplementationRegistry?: RuntimeUnitImplementationRegistry;
  /**
   * 生产装配是否必须从实现注册表取得入口；开启后不允许通过
   * `PluginManifest.setup` 兼容字段偷偷绕过 product/unit 映射。
   */
  requireRuntimeUnitImplementationRegistry?: boolean;
  safePath?: string;
}

/**
 * 可以申请桶级 platform namespace 的最小白名单。
 * 该列表按插件身份授权，不按 `kind`、插件名称或 capability 猜测权限。
 */
export const PLATFORM_STORAGE_MANIFEST_ALLOWLIST = new Set(["storage", "protocol", "vault", "settings"]);

interface PluginRecord {
  manifest: PluginManifest;
  state: PluginStateKind;
  error?: string;
  ownership: PluginOwnership;
  disposeCallbacks: Array<() => void | Promise<void>>;
  /** 当前运行实例作用域；disabled/未启动时为空。 */
  scope?: LifecycleScope;
  instanceId?: string;
  cleanup?: LifecycleDisposeResult;
  blockedBy?: string[];
  /** 当前兼容单元标识；多单元迁移时可替换为单元记录。 */
  unitId?: string;
  /** starting/stopping 之间用户最新的目标；不创建并发替代实例。 */
  pendingDesiredEnabled?: boolean;
  /** starting 期间收到 disable 的原因。 */
  stopRequested?: string;
  /** 依赖级联停止时保留用户意图；启动失败收尾不能错误地自动重启。 */
  stopPreserveIntent?: boolean;
  /** 级联停止后进入 waiting 时的能力原因。 */
  stopBlockedBy?: string[];
  /** 清理超时后用于把同一产品恢复到最终状态的上下文。 */
  cleanupRecovery?: {
    preserveIntent: boolean;
    blockedBy?: string[];
    /** setup/teardown 已知失败时，最终清理完成后仍应保留失败态。 */
    completionState: "disabled" | "error-disabled";
  };
}

function defaultStateFor(manifest: PluginManifest): PluginStateKind {
  return "registered";
}

/** 把兼容旧 kind 映射成设计 6.1 的稳定运行语义。 */
function lifecycleStateFor(
  state: PluginStateKind,
  desiredEnabled: boolean
): NonNullable<PluginState["lifecycleState"]> {
  switch (state) {
    case "starting": return "starting";
    case "stopping": return "stopping";
    case "enabled": return "running";
    case "blocked": return "waiting";
    case "error-disabled":
    case "cleanup-pending": return "failed";
    case "unknown": return desiredEnabled ? "waiting" : "disabled";
    case "disabled": return "disabled";
    case "registered": return desiredEnabled ? "waiting" : "disabled";
  }
}

/** 在 batch 注册时先放入提供者，消除 manifest 顺序对依赖装配的影响。 */
function orderManifestsByDependencies(
  manifests: readonly PluginManifest[],
  execution?: import("@keymaster/contracts").PluginExecution
): PluginManifest[] {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const providerByCapability = new Map<string, string>();
  for (const manifest of manifests) {
    for (const capability of providesOfManifest(manifest, execution)) {
      // 重复 Provider 会在 validateManifestSet 中报错；这里保留首个只
      // 为了让类型正确的输入得到稳定的排序，不在排序阶段静默选择语义。
      if (!providerByCapability.has(capability)) providerByCapability.set(capability, manifest.id);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: PluginManifest[] = [];
  const visit = (manifest: PluginManifest) => {
    if (visited.has(manifest.id) || visiting.has(manifest.id)) return;
    visiting.add(manifest.id);
    for (const dependency of dependenciesOfManifest(manifest, execution)) {
      if (dependency.optional) continue;
      const provider = providerByCapability.get(dependency.capability);
      const providerManifest = provider ? byId.get(provider) : undefined;
      if (providerManifest && providerManifest.id !== manifest.id) visit(providerManifest);
    }
    visiting.delete(manifest.id);
    visited.add(manifest.id);
    ordered.push(manifest);
  };
  for (const manifest of manifests) visit(manifest);
  return ordered;
}

/** 返回当前执行环境唯一可运行的单元；多个匹配单元时 fail closed。 */
function primaryRuntimeUnit(manifest: PluginManifest, execution?: import("@keymaster/contracts").PluginExecution) {
  const units = manifest.units ?? [];
  if (units.length === 0) return undefined;
  if (execution !== undefined) {
    const matches = units.filter((unit) => unit.execution === execution);
    return matches.length === 1 ? matches[0] : undefined;
  }
  return units.length === 1 ? units[0] : undefined;
}

/**
 * 返回当前运行单元的权限；显式 units 不继承产品级权限，避免 Worker
 * 意外取得 Window 单元的授权。没有 units 的简单插件才使用旧字段。
 */
function permissionsOfPrimaryUnit(
  manifest: PluginManifest,
  execution?: import("@keymaster/contracts").PluginExecution
): PluginPermission[] {
  const units = manifest.units ?? [];
  if (units.length > 0) return [...new Set(primaryRuntimeUnit(manifest, execution)?.permissions ?? [])];
  return [...new Set(manifest.permissions ?? [])];
}

/** 存储声明属于当前装配单元；无 units 的简单插件才使用产品级声明。 */
function storageOfPrimaryUnit(
  manifest: PluginManifest,
  execution?: import("@keymaster/contracts").PluginExecution
): PluginStorageDeclaration | undefined {
  const units = manifest.units ?? [];
  return units.length > 0 ? primaryRuntimeUnit(manifest, execution)?.storage : manifest.storage;
}

function diffIds(before: readonly string[], after: readonly string[]): string[] {
  const set = new Set(before);
  return after.filter((id) => !set.has(id));
}

function buildOwnershipSnapshot(
  registries: {
    routes: { _ids: () => string[] };
    breadcrumbs: { _ids: () => string[] };
    settings: { _ids: () => string[] };
    systemSettings: { _ids: () => string[] };
    systemStatus: { _ids: () => string[] };
    vaultSettings: { _ids: () => string[] };
    applicationSettings: { _ids: () => string[] };
    home: { _ids: () => string[] };
    commands: { _ids: () => string[] };
    importers: { _ids: () => string[] };
    transfers: { _ids: () => string[] };
    contactPublicKeyActions: { _ids: () => string[] };
    assets: { _ids: () => string[] };
    tokens: { _ids: () => string[] };
    collectibles: { _ids: () => string[] };
    collectibleTransfer: { _ids: () => string[] };
    protectedOutpoints: { _ids: () => string[] };
    topbar: { _ids: () => string[] };
    capabilities: { keys: () => string[] };
    resourceRegistry: { _ids: () => string[] };
    business: { _ids: () => { domains: string[]; features: string[]; projections: string[] } };
  }
) {
  return {
    routes: registries.routes._ids(),
    breadcrumbs: registries.breadcrumbs._ids(),
    settingsRoutes: registries.settings._ids(),
    systemSettingsItems: registries.systemSettings._ids(),
    systemStatusModules: registries.systemStatus._ids(),
    vaultSettingsSections: registries.vaultSettings._ids(),
    applicationSettingsItems: registries.applicationSettings._ids(),
    homeWidgets: registries.home._ids(),
    commands: registries.commands._ids(),
    importers: registries.importers._ids(),
    transferProviders: registries.transfers._ids(),
    contactPublicKeyActions: registries.contactPublicKeyActions._ids(),
    assetProviders: registries.assets._ids(),
    tokenProviders: registries.tokens._ids(),
    collectibleProviders: registries.collectibles._ids(),
    collectibleTransferHandlers: registries.collectibleTransfer._ids(),
    protectedOutpointProviders: registries.protectedOutpoints._ids(),
    topbarItems: registries.topbar._ids(),
    capabilities: registries.capabilities.keys(),
    resourceDefinitions: registries.resourceRegistry._ids(),
    businessDomains: registries.business._ids().domains,
    businessFeatures: registries.business._ids().features,
    businessHomeProjections: registries.business._ids().projections
  };
}

function ownershipDiff(
  before: ReturnType<typeof buildOwnershipSnapshot>,
  after: ReturnType<typeof buildOwnershipSnapshot>
): Pick<
  PluginOwnership,
  | "routes"
  | "businessDomains"
  | "businessFeatures"
  | "businessHomeProjections"
  | "breadcrumbs"
  | "settingsRoutes"
  | "systemSettingsItems"
  | "systemStatusModules"
  | "vaultSettingsSections"
  | "applicationSettingsItems"
  | "homeWidgets"
  | "commands"
  | "importers"
  | "transferProviders"
  | "contactPublicKeyActions"
  | "assetProviders"
  | "tokenProviders"
  | "collectibleProviders"
  | "collectibleTransferHandlers"
  | "topbarItems"
  | "capabilities"
  | "resourceDefinitions"
> {
  return {
    routes: diffIds(before.routes, after.routes),
    businessDomains: diffIds(before.businessDomains, after.businessDomains),
    businessFeatures: diffIds(before.businessFeatures, after.businessFeatures),
    businessHomeProjections: diffIds(before.businessHomeProjections, after.businessHomeProjections),
    breadcrumbs: diffIds(before.breadcrumbs, after.breadcrumbs),
    settingsRoutes: diffIds(before.settingsRoutes, after.settingsRoutes),
    systemSettingsItems: diffIds(before.systemSettingsItems, after.systemSettingsItems),
    systemStatusModules: diffIds(before.systemStatusModules, after.systemStatusModules),
    vaultSettingsSections: diffIds(before.vaultSettingsSections, after.vaultSettingsSections),
    applicationSettingsItems: diffIds(before.applicationSettingsItems, after.applicationSettingsItems),
    homeWidgets: diffIds(before.homeWidgets, after.homeWidgets),
    commands: diffIds(before.commands, after.commands),
    importers: diffIds(before.importers, after.importers),
    transferProviders: diffIds(before.transferProviders, after.transferProviders),
    contactPublicKeyActions: diffIds(before.contactPublicKeyActions, after.contactPublicKeyActions),
    assetProviders: diffIds(before.assetProviders, after.assetProviders),
    tokenProviders: diffIds(before.tokenProviders, after.tokenProviders),
    collectibleProviders: diffIds(before.collectibleProviders, after.collectibleProviders),
    collectibleTransferHandlers: diffIds(before.collectibleTransferHandlers, after.collectibleTransferHandlers),
    topbarItems: diffIds(before.topbarItems, after.topbarItems),
    capabilities: diffIds(before.capabilities, after.capabilities),
    resourceDefinitions: diffIds(before.resourceDefinitions, after.resourceDefinitions)
  };
}

export function createPluginHost(options: CreatePluginHostOptions = {}): PluginHost {
  // 每个 Host 实例对应一个执行环境根；插件作用域和任务调度器都从这里
  // 派生，但页面插件不能拿根作用域绕过自己的撤权边界。
  const rootScope = createLifecycleScope({
    kind: "root",
    // Root 是所有插件实例的生命周期父节点；子作用域的资源变化也要让
    // Host 订阅者重新读取状态快照。
    onChange: () => bumpVersion(),
  });
  const taskScheduler = createScopedTaskScheduler(rootScope);
  const capabilities = createCapabilityRegistry();
  const messageBus = createMessageBus();
  const routes = createRouteRegistry();
  const breadcrumbs = createBreadcrumbRegistry();
  const settings = createSettingsRegistry();
  const systemSettings = createSystemSettingsRegistry();
  const systemStatus = createSystemStatusRegistry();
  const vaultSettings = createVaultSettingsRegistry();
  const applicationSettings = createApplicationSettingsRegistry();
  const home = createHomeRegistry();
  const business = createBusinessFeatureRegistry();
  const commands = createCommandRegistry();
  const importers = createImporterRegistry();
  const transfers = createTransferRegistry();
  const contactPublicKeyActions = createContactPublicKeyActionRegistry();
  const assets = createAssetRegistry();
  const tokens = createTokenRegistry();
  const collectibles = createCollectibleRegistry();
  const collectibleTransfer = createCollectibleTransferRegistry();
  const protectedOutpoints = createProtectedOutpointRegistry();
  const topbar = createTopbarRegistry();
  const notice = createNoticeRegistry();
  const i18n = createI18nService({
    initialResources: options.initialI18nResources,
    debug: options.i18nDebug
  });

  const logService: LogServiceHandle = createLogService({
    storage: options.logStorage,
    disablePersistence: options.disableLogPersistence
  });

  /**
   * 资产数据变更通知器。
   * 设计缘由：统一本 tab pub/sub 与跨 tab BroadcastChannel 失效通知。
   * 后台任务原子提交 provider K-V 后发布此事件，页面收到后只重读本地 K-V。
   *
   * 合并语义（硬切换 003）：
   * - 同一 `providerId + publicKeyHex` 的同一 microtask 内事件合并
   * - `kinds` 求并集
   * - `revision` 取最新事件
   */
  const assetDataNotifier = createAssetDataNotifier();

  /**
   * 资源注册表和资源存储。
   * 设计缘由（硬切换 003）：Resource Store 是 React 读业务数据、
   * 订阅业务数据变更的唯一框架入口。
   */
  const resourceRegistry = createResourceRegistry();

  const resourceStore = createResourceStore(
    resourceRegistry,
    <T>(id: string) => capabilities.has(id) ? capabilities.get<T>(id) : undefined,
    // activePublicKeyHex 从 keyspace service 动态获取（延迟绑定，因为
    // keyspace service 由 plugin-vault 在 setup 阶段注入，晚于 createPluginHost）
    () => {
      if (!capabilities.has(KEYSPACE_SERVICE_CAPABILITY)) return undefined;
      try {
        const ks = capabilities.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
        return ks.active().activePublicKeyHex ?? undefined;
      } catch {
        return undefined;
      }
    }
  );

  // 把内置 registry + messageBus + i18n + log + assetDataNotifier 暴露成 capability。
  capabilities.provide<RouteRegistry>("route.registry", routes);
  capabilities.provide<BreadcrumbRegistry>("breadcrumb.registry", breadcrumbs);
  capabilities.provide<SettingsRegistry>("settings.registry", settings);
  capabilities.provide<SystemSettingsRegistry>("system-settings.registry", systemSettings);
  capabilities.provide<SystemStatusRegistry>("system-status.registry", systemStatus);
  capabilities.provide<VaultSettingsRegistry>("vault-settings.registry", vaultSettings);
  capabilities.provide<ApplicationSettingsRegistry>("application-settings.registry", applicationSettings);
  capabilities.provide<HomeRegistry>("home.registry", home);
  capabilities.provide<BusinessFeatureRegistry>("business.registry", business);
  capabilities.provide<CommandRegistry>("command.registry", commands);
  capabilities.provide<ImporterRegistry>("importer.registry", importers);
  capabilities.provide<TransferRegistry>("transfer.registry", transfers);
  capabilities.provide<ContactPublicKeyActionRegistry>("contacts.public-key-action.registry", contactPublicKeyActions);
  capabilities.provide<AssetRegistry>("asset.registry", assets);
  capabilities.provide<TokenRegistry>("token.registry", tokens);
  capabilities.provide<CollectibleRegistry>("collectible.registry", collectibles);
  capabilities.provide<CollectibleTransferRegistry>(
    "collectible-transfer.registry",
    collectibleTransfer
  );
  capabilities.provide<ProtectedOutpointRegistry>("protected-outpoint.registry", protectedOutpoints);
  capabilities.provide<TopbarRegistry>(TOPBAR_REGISTRY_CAPABILITY, topbar);
  capabilities.provide<NoticeRegistry>("notice.registry", notice);
  capabilities.provide<MessageBus>(RUNTIME_MESSAGE_BUS, messageBus);
  capabilities.provide<I18nService>(I18N_SERVICE_CAPABILITY, i18n);
  capabilities.provide<LogService>(LOG_SERVICE_CAPABILITY, logService);
  capabilities.provide<AssetDataNotifier>(ASSET_DATA_NOTIFIER_CAPABILITY, assetDataNotifier);
  capabilities.provide<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY, resourceRegistry);
  capabilities.provide<ScopedTaskScheduler>(SCOPED_TASK_SCHEDULER_CAPABILITY, taskScheduler);

  // route.registry path 探测，避免 settings.registry 与 route.registry 双渲染。
  settings.setRoutePathProbe((path) => routes.byPath(path) !== undefined);

  const configStore = createPluginConfigStore({
    readOnly: options.disableConfigPersistence,
    storage: options.configStorage,
    initial: options.initialPluginConfig
  });

  const knownManifests = new Map<string, PluginManifest>();
  const records = new Map<string, PluginRecord>();
  const enabledSet = new Set<string>();
  let versionCounter = 0;
  const listeners = new Set<HostListener>();
  let hostDisposed = false;
  let hostDisposePromise: Promise<LifecycleDisposeResult> | undefined;
  let hostCleanupResult: LifecycleDisposeResult | undefined;
  let hostCleanupRootResult: LifecycleDisposeResult | undefined;
  let hostCleanupRecords: PluginRecord[] = [];
  let removeConfigSubscription: () => void = () => undefined;
  const safePath = options.safePath ?? "/settings/plugins";
  let pluginIntentSnapshot: PluginIntentSnapshot | undefined = options.pluginIntentCoordinator?.snapshot();
  /**
   * Window 的运行身份与产品启停意图分离：身份切换只重建受影响的
   * storage/owner/connect 作用域，不把用户保存的 desiredEnabled 改成 false。
   */
  let runtimeIdentity: RuntimeIdentityTransition | undefined = options.initialRuntimeIdentity
    ? { ...options.initialRuntimeIdentity }
    : undefined;
  let runtimeTransitionPromise: Promise<void> | undefined;
  let storageScope: LifecycleScope | undefined;
  let storageScopeKey: string | undefined;
  let ownerSessionScope: LifecycleScope | undefined;
  let ownerSessionScopeKey: string | undefined;
  let connectSessionScope: LifecycleScope | undefined;
  let connectSessionScopeKey: string | undefined;
  /** 身份切换期间禁止 stop 完成回调抢先创建新实例。 */
  let runtimeTransitioning = false;

  function hasPluginIntent(pluginId: string): boolean {
    return pluginIntentSnapshot !== undefined
      && Object.prototype.hasOwnProperty.call(pluginIntentSnapshot.desiredEnabled, pluginId);
  }

  function desiredEnabledFor(pluginId: string, manifest?: PluginManifest): boolean {
    const known = manifest ?? knownManifests.get(pluginId);
    if (pluginIntentSnapshot && hasPluginIntent(pluginId)) {
      return pluginIntentSnapshot.desiredEnabled[pluginId] === true;
    }
    return configStore.read()[pluginId] ?? known?.meta.defaultEnabled ?? false;
  }

  function bumpVersion() {
    versionCounter += 1;
    for (const l of listeners) {
      try {
        l({ version: versionCounter });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[pluginHost] listener threw", err);
      }
    }
  }

  /** 将 Host 根清理和所有插件实例清理合并成一个可观测结果。 */
  function mergeHostCleanupResult(): void {
    if (!hostCleanupResult || !hostCleanupRootResult) return;
    const pending = [...hostCleanupRootResult.pending];
    const errors = [...hostCleanupRootResult.errors];
    let attempted = hostCleanupRootResult.attempted;
    let released = hostCleanupRootResult.released;
    for (const record of hostCleanupRecords) {
      const cleanup = record.cleanup;
      if (!cleanup) {
        // starting/setup 永不返回时，插件子作用域仍是 Host 的未完成清理项。
        // 已知具体资源时保留资源级标识；否则才退化为实例级占位符，避免
        // Host.dispose() 把插件清理隐藏成“Root 已完成”。
        const prefix = `plugin:${record.manifest.id}`;
        const scopeResources = record.scope?.resources()
          .filter((resource) => resource.state !== "released")
          .map((resource) => `${prefix}:${resource.resourceId}`) ?? [];
        if (record.ownership.teardown) scopeResources.push(`${prefix}:scope:teardown`);
        const resourceIds = [...new Set(scopeResources.length > 0 ? scopeResources : [prefix])];
        for (const resourceId of resourceIds) {
          if (!pending.includes(resourceId)) pending.push(resourceId);
          errors.push({
            resourceId,
            code: "lifecycle.cleanup_timeout",
            message: "Plugin instance cleanup did not finish before Host disposal",
          });
        }
        attempted += resourceIds.length;
        continue;
      }
      attempted += cleanup.attempted;
      released += cleanup.released;
      for (const resourceId of cleanup.pending) {
        const scopedId = `plugin:${record.manifest.id}:${resourceId}`;
        if (!pending.includes(scopedId)) pending.push(scopedId);
      }
      errors.push(...cleanup.errors.map((issue) => ({
        ...issue,
        resourceId: `plugin:${record.manifest.id}:${issue.resourceId}`,
      })));
    }
    hostCleanupResult.attempted = attempted;
    hostCleanupResult.released = released;
    hostCleanupResult.pending = pending;
    hostCleanupResult.errors = errors;
    hostCleanupResult.cleanupIncomplete = pending.length > 0 || errors.length > 0;
  }

  function recordState(id: string): PluginState {
    const r = records.get(id);
    if (!r) return { id, kind: "registered" };
    const desiredEnabled = desiredEnabledFor(id, r.manifest);
    const desiredRevision = pluginIntentSnapshot?.desiredRevision[id];
    const unit = primaryRuntimeUnit(r.manifest, options.execution);
    const declaredUnits = r.manifest.units ?? [];
    const remoteUnits = options.runtimeUnitSnapshots?.() ?? [];
    const unitStates = declaredUnits.length > 0
      ? declaredUnits.map((declared) => {
          const selected = unit?.id === declared.id;
          const remote = selected || declared.execution === options.execution
            ? undefined
            : remoteUnits.find((candidate) => candidate.productId === r.manifest.id && candidate.unitId === declared.id);
          const remoteKind: PluginStateKind = remote
            ? remote.state === "ready"
              ? "enabled"
              : remote.state === "starting"
                ? "starting"
                : "error-disabled"
            : "unknown";
          return {
            pluginId: r.manifest.id,
            unitId: declared.id,
            execution: declared.execution,
            instanceId: selected ? r.scope?.identity.instanceId : remote?.instanceId,
            desiredRevision,
            kind: selected ? r.state : remoteKind,
            error: selected
              ? r.error
              : remote?.error
                ?? (remote ? undefined : "远程运行单元快照不可用（状态未知）"),
            cleanup: selected ? r.cleanup : undefined,
          };
        })
      : undefined;
    return {
      id,
      kind: r.state,
      lifecycleState: lifecycleStateFor(r.state, desiredEnabled),
      error: r.error,
      desiredEnabled,
      desiredRevision,
      // waiting / disabled / failed 不暴露旧实例令牌；旧异步结果只能清理
      // 自己，不能让 UI 或调用方把它误认为当前活动实例。
      instanceId: r.scope?.identity.instanceId,
      unitId: r.unitId ?? primaryRuntimeUnit(r.manifest, options.execution)?.id ?? r.manifest.id,
      blockedBy: r.blockedBy ? [...r.blockedBy] : undefined,
      cleanup: r.cleanup,
      units: unitStates,
    };
  }

  function provideCapability<T>(key: string, value: T): void {
    capabilities.provide(key, value);
    resourceStore.refreshRuntimeBindings();
  }

  function buildContext(record: PluginRecord, storage?: KeyValueStore): PluginContext {
    const scope = record.scope;
    if (!scope) throw new Error(`Plugin "${record.manifest.id}" has no lifecycle scope`);
    const scopedMessageBus = createScopedMessageBus(messageBus, scope);
    const scopedTaskScheduler = createScopedTaskScheduler(scope);
    const serviceBridge = options.serviceBridgeForPlugin?.(record.manifest.id, scope.identity.instanceId);
    const scopedProvidedCapabilities = new Map<string, unknown>();
    let scopedChannelRuntime: ChannelRuntime | undefined;
    const provideScopedCapability = <T>(key: string, value: T): void => {
      scope.assertActive();
      provideCapability(key, value);
      scopedProvidedCapabilities.set(key, value);
      // 不依赖 setup 前后 ownership snapshot：setup 返回后的异步 provide
      // 也必须在同一 instance 撤权时同步消失。
      scope.onRevoke(() => {
        if (capabilities.has(key) && capabilities.get<T>(key) === value) capabilities.revoke(key);
      });
      scope.onDispose(() => {
        if (capabilities.has(key) && capabilities.get<T>(key) === value) capabilities.revoke(key);
        scopedProvidedCapabilities.delete(key);
      }, `capability:${key}`);
    };
    const registryFacadeOptions: Readonly<Record<string, CreateScopedRegistryFacadeOptions>> = {
      "route.registry": { name: "route.registry" },
      "breadcrumb.registry": { name: "breadcrumb.registry" },
      "settings.registry": { name: "settings.registry" },
      "system-settings.registry": { name: "system-settings.registry" },
      "system-status.registry": { name: "system-status.registry" },
      "vault-settings.registry": { name: "vault-settings.registry" },
      "application-settings.registry": { name: "application-settings.registry" },
      "home.registry": { name: "home.registry" },
      "command.registry": { name: "command.registry" },
      "importer.registry": { name: "importer.registry" },
      "transfer.registry": { name: "transfer.registry" },
      "contacts.public-key-action.registry": { name: "contacts.public-key-action.registry" },
      "asset.registry": { name: "asset.registry" },
      "token.registry": { name: "token.registry" },
      "collectible.registry": { name: "collectible.registry" },
      "collectible-transfer.registry": { name: "collectible-transfer.registry" },
      "protected-outpoint.registry": { name: "protected-outpoint.registry" },
      "topbar.registry": { name: "topbar.registry" },
      "background.registry": { name: "background.registry" },
      "notice.registry": {
        name: "notice.registry",
        registrations: [{ method: "upsert", idArgument: 0, unregisterMethod: "dismiss" }],
      },
      "business.registry": {
        name: "business.registry",
        registrations: [
          {
            method: "register",
            idArgument: 1,
            unregisterMethod: "unregisterDomain",
            unregisterArgument: 0,
            bindPluginIdArgument: 0,
          },
          {
            method: "registerFeature",
            idArgument: 2,
            unregisterMethod: "unregisterFeature",
            unregisterArgument: 0,
            bindPluginIdArgument: 0,
          },
        ],
      },
      // Window P2P lane register 返回自己的幂等 off 函数，不需要猜 lane id。
      "window-p2p.executor": {
        name: "window-p2p.executor",
        registrations: [{ method: "register" }],
      },
    };
    const scopedCapabilities = new Map<string, unknown>();
    const getContextCapability = <T>(key: string): T => {
      const raw = capabilities.get<T>(key);
      const facadeOptions = registryFacadeOptions[key];
      if (!facadeOptions || !raw || typeof raw !== "object") return raw;
      const cached = scopedCapabilities.get(key);
      if (cached) return cached as T;
      const facade = createScopedRegistryFacade(raw as object, scope, facadeOptions);
      scopedCapabilities.set(key, facade);
      return facade as T;
    };
    const requestedPermissions = permissionsOfPrimaryUnit(record.manifest, options.execution);
    const approvedPermissions = options.approvedPermissionsForPlugin?.(
      record.manifest.id,
      requestedPermissions
    ) ?? [];
    const sessionPermissions = options.sessionPermissionsForPlugin?.(
      record.manifest.id,
      requestedPermissions
    );
    const permissionBinding = options.permissionBindingForPlugin?.(
      record.manifest.id,
      record.unitId ?? record.manifest.id,
      requestedPermissions
    ) ?? {};
    const permissionLease: PermissionLease = createPermissionLease({
      identity: scope.identity,
      requested: requestedPermissions,
      approved: approvedPermissions,
      sessionConstraints: sessionPermissions,
      policyRevision: permissionBinding.policyRevision,
      grantRevision: permissionBinding.grantRevision,
      grantId: permissionBinding.grantId,
      scope,
    });
    const grantedPermissions = requestedPermissions.filter((permission) => permissionLease.has(permission));
    const ownedResourceIds = new Set<string>();
    const ownerResourceRegistry: ResourceRegistry = {
      register: (definition) => {
        scope.assertActive();
        registerOwnedResource(resourceRegistry, record.manifest.id, definition);
        ownedResourceIds.add(definition.id);
        const revokeResourceDefinition = () => {
          // Resource Definition 是业务入口的一部分。必须在同步 revoke 阶段
          // 注销，不能等后台 load/subscribe 的异步清理结束后才消失。
          resourceStore.disposeOwner(record.manifest.id);
          if (resourceRegistry.get(definition.id)) resourceRegistry.unregister(definition.id);
          ownedResourceIds.delete(definition.id);
        };
        const removeRevoke = scope.onRevoke(revokeResourceDefinition);
        // setup 返回后才完成的异步注册也属于当前 instance；不再依赖
        // setup 前后 snapshot 差分才能回收。
        scope.onDispose(() => {
          removeRevoke();
          revokeResourceDefinition();
        }, `resource:${definition.id}`);
      },
      unregister: (id) => {
        if (!ownedResourceIds.has(id) && !record.ownership.resourceDefinitions.includes(id)) {
          throw new Error(`Resource definition "${id}" is not owned by plugin "${record.manifest.id}"`);
        }
        if (resourceRegistry.get(id)) resourceRegistry.unregister(id);
        ownedResourceIds.delete(id);
      },
      get: (id) => resourceRegistry.get(id),
      _ids: () => resourceRegistry._ids(),
    };
    const pluginChannelFactory = (): ChannelRuntimeFactory | undefined => {
      if (!capabilities.has(CHANNEL_RUNTIME_CAPABILITY)) return undefined;
      const raw = capabilities.get<ChannelRuntimeFactory>(CHANNEL_RUNTIME_CAPABILITY);
      return {
        // 这里忽略插件传入的字符串，始终绑定 manifest.id。
        forPlugin: (_claimedPluginId: string) => {
          if (!scopedChannelRuntime) {
            scopedChannelRuntime = createScopedChannelRuntime(raw.forPlugin(record.manifest.id), scope);
          }
          return scopedChannelRuntime;
        },
        // system caller 只能由 Host/Coordinator 内部创建，插件 context 不开放。
        forSystem: (_claimedSystemId: string) => {
          throw new Error("Plugin context cannot create a system Channel caller");
        }
      };
    };
    return {
      pluginId: record.manifest.id,
      instanceId: scope.identity.instanceId,
      unitId: record.unitId ?? record.manifest.id,
      scope,
      signal: scope.signal,
      permissions: grantedPermissions,
      permissionLease,
      serviceBridge,
      taskScheduler: scopedTaskScheduler,
      onDispose: (cleanup) => { scope.onDispose(cleanup); },
      provide: (k, v) => {
        provideScopedCapability(k, v);
      },
      get: (k) => {
        scope.assertActive();
        if (k === RESOURCE_REGISTRY_CAPABILITY) return ownerResourceRegistry as any;
        if (k === CHANNEL_RUNTIME_CAPABILITY) return pluginChannelFactory() as any;
        if (k === RUNTIME_MESSAGE_BUS) return scopedMessageBus as any;
        if (k === SCOPED_TASK_SCHEDULER_CAPABILITY) return scopedTaskScheduler as any;
        return getContextCapability(k);
      },
      has: (k) => scope.state === "active" && (
        k === RESOURCE_REGISTRY_CAPABILITY
        || k === CHANNEL_RUNTIME_CAPABILITY && capabilities.has(CHANNEL_RUNTIME_CAPABILITY)
        || k === RUNTIME_MESSAGE_BUS
        || k === SCOPED_TASK_SCHEDULER_CAPABILITY
        || capabilities.has(k)
      ),
      require: (k) => {
        scope.assertActive();
        if (k === RESOURCE_REGISTRY_CAPABILITY) return ownerResourceRegistry as any;
        if (k === CHANNEL_RUNTIME_CAPABILITY) return pluginChannelFactory() as any;
        if (k === RUNTIME_MESSAGE_BUS) return scopedMessageBus as any;
        if (k === SCOPED_TASK_SCHEDULER_CAPABILITY) return scopedTaskScheduler as any;
        return getContextCapability(k);
      },
      messageBus: scopedMessageBus,
      logger: logService.forPlugin(record.manifest.id),
      // 运行单元硬切换：显式 units 只读取当前 unit 的配置，不继承其它
      // 环境或产品级配置；无 units 的简单插件才读取历史 manifest.config。
      config: (() => {
        const units = record.manifest.units ?? [];
        return units.length > 0
          ? { ...(primaryRuntimeUnit(record.manifest, options.execution)?.config ?? {}) }
          : { ...(record.manifest.config ?? {}) };
      })(),
      storage,
      // Coordinator facade 必须由 Host 按 manifest id 注入；不再从一个全局
      // SessionCoordinatorClient capability 回退，避免插件借用其他插件的权限面。
      coordinator: options.coordinatorForPlugin?.(record.manifest.id)
    };
  }

  /**
   * 为 key-scope 插件提供一个由 Host 控制的延迟绑定句柄。
   *
   * 首屏可能尚未解锁 Vault，此时没有可绑定的 owner；但插件仍需完成
   * setup 并注册能力。句柄只在第一次 K-V 操作时按当前 active key 打开
   * 真正的 OwnerAppStore，切 key 时自动丢弃旧底层句柄。插件始终只能
   * 接触这个 Host 句柄，不能自行提供 owner、bucket 或物理路径。
   */
  function isStaleOwnerStorageBinding(error: unknown): boolean {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "storage_unavailable" || code === "storage_identity_required") return true;
    const message = error instanceof Error ? error.message : String(error);
    return /owner storage (?:handle|grant|binding) .*?(?:stale|invalid|changed)|owner storage .*unavailable|owner storage owner changed|owner storage bucket generation changed/i.test(message);
  }

  function createDeferredOwnerAppStore(
    authority: StorageBindingAuthority,
    record: PluginRecord,
    declaration: PluginStorageDeclaration,
    scope: LifecycleScope
  ): KeyValueStore {
    let closed = false;
    let ownerPublicKeyHex: string | undefined;
    let bucketGeneration: number | undefined;
    let current: KeyValueStore | undefined;
    const invalidateCurrent = () => {
      current?.close();
      current = undefined;
      ownerPublicKeyHex = undefined;
      bucketGeneration = undefined;
    };
    const removeScopeRevoke = scope.onRevoke(() => {
      closed = true;
      invalidateCurrent();
    });
    scope.onDispose((reason) => {
      removeScopeRevoke();
      closed = true;
      invalidateCurrent();
    }, "owner-storage");
    async function resolve(): Promise<KeyValueStore> {
      scope.assertActive();
      if (closed) throw new Error("Owner storage handle is closed");
      const activeOwnerPublicKeyHex = authority.getActivePublicKeyHex?.()?.toLowerCase();
      const ownerChanged = authority.getActivePublicKeyHex !== undefined
        && (!activeOwnerPublicKeyHex || ownerPublicKeyHex !== activeOwnerPublicKeyHex);
      if (!current || !ownerPublicKeyHex || ownerChanged || bucketGeneration !== current.bucketGeneration) {
        invalidateCurrent();
        const opened = await authority.openOwnerAppStore({ pluginId: record.manifest.id, declaration });
        try {
          scope.assertActive();
          const latestOwnerPublicKeyHex = authority.getActivePublicKeyHex?.()?.toLowerCase();
          if (
            latestOwnerPublicKeyHex
            && opened.ownerPublicKeyHex.toLowerCase() !== latestOwnerPublicKeyHex
          ) {
            throw new Error("Owner storage owner changed while opening binding");
          }
          current = opened;
          ownerPublicKeyHex = opened.ownerPublicKeyHex.toLowerCase();
          bucketGeneration = opened.bucketGeneration;
        } catch (error) {
          opened.close();
          throw error;
        }
      }
      scope.assertActive();
      return current;
    }
    const run = async <T>(operation: (store: KeyValueStore) => Promise<T>): Promise<T> => {
      const store = await resolve();
      const boundOwnerPublicKeyHex = ownerPublicKeyHex;
      const boundBucketGeneration = bucketGeneration;
      try {
        scope.assertActive();
        const result = await operation(store);
        scope.assertActive();
        if (
          current !== store
          || ownerPublicKeyHex !== boundOwnerPublicKeyHex
          || bucketGeneration !== boundBucketGeneration
        ) {
          throw new Error("Owner storage binding changed while operation was running");
        }
        return result;
      } catch (error) {
        // Root/会话恢复后不能重试当前写入：响应可能已经越过远端
        // 写入边界。这里只丢弃旧绑定，让下一次调用重新申请 grant。
        if (isStaleOwnerStorageBinding(error)) invalidateCurrent();
        throw error;
      }
    };
    return {
      get bucketId() { return current?.bucketId ?? "pending"; },
      get bucketGeneration() { return current?.bucketGeneration ?? 0; },
      get ownerPublicKeyHex() { return ownerPublicKeyHex ?? ""; },
      applicationStorageId: declaration.applicationStorageId,
      get: async (key, options) => run((store) => store.get(key, options)),
      list: async (input) => run((store) => store.list(input)),
      put: async (key, value, condition) => run((store) => store.put(key, value, condition)),
      delete: async (key, condition) => { await run((store) => store.delete(key, condition)); },
      commit: async (input) => run((store) => store.commit(input)),
      close: () => { if (closed) return; closed = true; invalidateCurrent(); }
    };
  }

  async function bindManifestStorage(record: PluginRecord): Promise<KeyValueStore | undefined> {
    const declaration = storageOfPrimaryUnit(record.manifest, options.execution);
    if (!declaration) return undefined;
    const authority = options.storageBindingAuthority ?? (capabilities.has("storage.binding-authority")
      ? capabilities.get<StorageBindingAuthority>("storage.binding-authority")
      : undefined);
    if (!authority) throw new Error(`Plugin "${record.manifest.id}" requires the storage binding authority`);
    if (declaration.scope === "platform") {
      return authority.openPlatformStore({ pluginId: record.manifest.id, applicationStorageId: declaration.applicationStorageId, schemaVersion: declaration.schemaVersion });
    }
    return createDeferredOwnerAppStore(authority, record, declaration, record.scope!);
  }

  function snapshotOwnership() {
    return buildOwnershipSnapshot({
      routes,
      breadcrumbs,
      settings,
      systemSettings,
      systemStatus,
      vaultSettings,
      applicationSettings,
      home,
      commands,
      importers,
      transfers,
      contactPublicKeyActions,
      assets,
      tokens,
      collectibles,
      collectibleTransfer,
      protectedOutpoints,
      topbar,
      capabilities,
      resourceRegistry,
      business
    });
  }

  /** 当前 Host 选中的运行单元寿命；无 units 的简单插件沿用 meta 声明。 */
  function lifetimeOfManifest(manifest: PluginManifest): PluginLifetime {
    return primaryRuntimeUnit(manifest, options.execution)?.lifetime
      ?? manifest.meta.lifetime
      ?? "root";
  }

  function ownerIdentityAvailable(): boolean {
    return runtimeIdentity?.vaultStatus === "unlocked"
      && typeof runtimeIdentity.ownerPublicKeyHex === "string"
      && runtimeIdentity.ownerPublicKeyHex.length > 0
      && runtimeIdentity.sessionEpoch.length > 0;
  }

  function connectIdentityAvailable(): boolean {
    return runtimeIdentity?.vaultStatus === "unlocked"
      && runtimeIdentity.sessionEpoch.length > 0;
  }

  function runtimeUnitUnavailableReason(manifest: PluginManifest): string | undefined {
    switch (lifetimeOfManifest(manifest)) {
      case "owner-session":
        return ownerIdentityAvailable() ? undefined : "runtime:owner-session-unavailable";
      case "connect-session":
        return connectIdentityAvailable()
          ? undefined
          : "runtime:connect-session-unavailable";
      case "root":
      case "storage":
        return undefined;
    }
  }

  function storageScopeIdentityKey(): string {
    return `bucket:${runtimeIdentity?.bucketGeneration ?? "unknown"}`;
  }

  function ownerSessionScopeIdentityKey(): string {
    return `owner:${runtimeIdentity?.ownerPublicKeyHex ?? "none"}:session:${runtimeIdentity?.sessionEpoch ?? "none"}`;
  }

  function storageScopeKeyFor(identity: RuntimeIdentityTransition | undefined): string {
    return `bucket:${identity?.bucketGeneration ?? "unknown"}`;
  }

  function ownerSessionScopeKeyFor(identity: RuntimeIdentityTransition | undefined): string {
    return `owner:${identity?.ownerPublicKeyHex ?? "none"}:session:${identity?.sessionEpoch ?? "none"}`;
  }

  function ensureStorageScope(): LifecycleScope {
    const key = storageScopeIdentityKey();
    if (storageScope?.state === "active" && storageScopeKey === key) return storageScope;
    if (storageScope?.state === "active") storageScope.revoke("storage bucket generation changed");
    storageScope = rootScope.child("storage", {
      bucketGeneration: runtimeIdentity?.bucketGeneration,
    });
    storageScopeKey = key;
    return storageScope;
  }

  function ensureOwnerSessionScope(): LifecycleScope {
    if (!ownerIdentityAvailable()) {
      throw new Error("Owner-session runtime identity is unavailable; plugin remains waiting");
    }
    const key = ownerSessionScopeIdentityKey();
    if (ownerSessionScope?.state === "active" && ownerSessionScopeKey === key) return ownerSessionScope;
    if (ownerSessionScope?.state === "active") ownerSessionScope.revoke("owner session changed");
    ownerSessionScope = rootScope.child("owner-session", {
      ownerPublicKeyHex: runtimeIdentity?.ownerPublicKeyHex ?? undefined,
      sessionEpoch: runtimeIdentity?.sessionEpoch,
    });
    ownerSessionScopeKey = key;
    return ownerSessionScope;
  }

  function ensureConnectSessionScope(): LifecycleScope {
    if (!connectIdentityAvailable()) {
      throw new Error("Connect-session runtime identity is unavailable; plugin remains waiting");
    }
    const key = ownerSessionScopeIdentityKey();
    if (connectSessionScope?.state === "active" && connectSessionScopeKey === key) return connectSessionScope;
    if (connectSessionScope?.state === "active") connectSessionScope.revoke("connect session changed");
    connectSessionScope = rootScope.child("connect-session", {
      ownerPublicKeyHex: runtimeIdentity?.ownerPublicKeyHex ?? undefined,
      sessionEpoch: runtimeIdentity?.sessionEpoch,
    });
    connectSessionScopeKey = key;
    return connectSessionScope;
  }

  function parentScopeForRecord(record: PluginRecord): LifecycleScope {
    switch (lifetimeOfManifest(record.manifest)) {
      case "storage": return ensureStorageScope();
      case "owner-session": return ensureOwnerSessionScope();
      case "connect-session": return ensureConnectSessionScope();
      case "root": return rootScope;
    }
  }

  function createPluginScope(record: PluginRecord): LifecycleScope {
    const unitId = primaryRuntimeUnit(record.manifest, options.execution)?.id ?? record.manifest.id;
    const lifecycleIdentity = options.lifecycleIdentityForPlugin?.(record.manifest.id, unitId);
    const scope = parentScopeForRecord(record).child("plugin-instance", {
      ...lifecycleIdentity,
      // 插件身份由 Host 强制绑定，不能被外部 metadata 回调覆盖。
      pluginId: record.manifest.id,
    });
    record.scope = scope;
    record.instanceId = scope.identity.instanceId;
    record.unitId = unitId;
    record.cleanup = undefined;
    return scope;
  }

  async function disposePluginScope(
    record: PluginRecord,
    reason: string,
    teardown?: LifecycleCleanup
  ): Promise<LifecycleDisposeResult | undefined> {
    const scope = record.scope;
    if (!scope) return record.cleanup;
    const cleanup = await scope.dispose({
      reason,
      timeoutMs: options.lifecycleCleanupTimeoutMs,
      teardown,
      onLateSuccess: (_resourceId, result) => {
        if (result) record.cleanup = result;
        recoverPluginAfterCleanup(record);
        mergeHostCleanupResult();
      },
      onLateFailure: (_resourceId, error, result) => {
        if (result) record.cleanup = result;
        if (record.state === "cleanup-pending") {
          record.error = error instanceof Error ? error.message : String(error);
          bumpVersion();
        }
        mergeHostCleanupResult();
      },
    });
    record.cleanup = cleanup;
    // `scope.dispose()` 可能在最后一个清理 Promise 恰好回调于结果对象
    // 创建之前完成。此时 onLateSuccess 拿不到 record.cleanup；这里再做
    // 一次收敛检查，避免插件已经清理完却永久停在 cleanup-pending。
    recoverPluginAfterCleanup(record);
    mergeHostCleanupResult();
    return cleanup;
  }

  /**
   * 超时只是本次等待窗口结束，不是永久状态。资源最终全部释放后，
   * cleanup-pending 必须收敛到 disabled / waiting，或按最新意图重启；
   * 该回调只认当前 record，不会把旧实例结果写到新实例。
   */
  function recoverPluginAfterCleanup(record: PluginRecord): void {
    const cleanup = record.cleanup;
    const recovery = record.cleanupRecovery;
    if (!cleanup || cleanup.cleanupIncomplete || cleanup.pending.length > 0) return;
    if (record.state !== "cleanup-pending" || !recovery) return;

    const latestDesired = record.pendingDesiredEnabled
      ?? desiredEnabledFor(record.manifest.id, record.manifest);
    const missingDependencies = missingHardDependencies(record.manifest);
    const preserveIntent = recovery.preserveIntent && latestDesired;
    const runtimeUnavailable = runtimeUnitUnavailableReason(record.manifest);
    const waitingForDependency = preserveIntent
      && (missingDependencies.length > 0 || runtimeUnavailable !== undefined);
    const restartAfterCleanup = recovery.completionState === "disabled"
      && latestDesired
      && (!recovery.preserveIntent || !waitingForDependency)
      && !runtimeTransitioning
      && !hostDisposed;

    record.state = recovery.completionState === "error-disabled"
      ? "error-disabled"
      : waitingForDependency ? "blocked" : "disabled";
    record.blockedBy = waitingForDependency
      ? [...new Set([...(recovery.blockedBy ?? []), ...missingDependencies, ...(runtimeUnavailable ? [runtimeUnavailable] : [])])]
      : undefined;
    record.error = recovery.completionState === "error-disabled"
      ? record.error
      : undefined;
    record.cleanupRecovery = undefined;
    record.pendingDesiredEnabled = undefined;
    bumpVersion();
    mergeHostCleanupResult();

    if (restartAfterCleanup && record.state === "disabled") {
      queueMicrotask(() => {
        void host.enable(record.manifest.id).catch(() => undefined);
      });
    }
  }

  function isStartupRequired(manifest: PluginManifest): boolean {
    return manifest.meta.startup === "required";
  }

  /** 返回当前仍未满足的硬依赖；optional 依赖不会阻断插件主体。 */
  function missingHardDependencies(manifest: PluginManifest): string[] {
    return dependenciesOfManifest(manifest, options.execution)
      .filter((dependency) => !dependency.optional && !capabilities.has(dependency.capability))
      .map((dependency) => dependency.capability);
  }

  function validateManifest(plugin: PluginManifest, manifestSet?: readonly PluginManifest[]): void {
    const meta = plugin.meta;
    const units = plugin.units ?? [];
    const unitIds = new Set<string>();
    for (const unit of units) {
      if (!unit.id || unit.id.length === 0) {
        throw new Error(`Plugin "${plugin.id}" has a runtime unit without an id`);
      }
      if (unitIds.has(unit.id)) {
        throw new Error(`Plugin "${plugin.id}" has duplicate runtime unit id "${unit.id}"`);
      }
      if (!new Set(["coordinator-worker", "window", "connect-worker"]).has(unit.execution)) {
        throw new Error(`Plugin "${plugin.id}" runtime unit "${unit.id}" has invalid execution`);
      }
      if (!new Set(["root", "storage", "owner-session", "connect-session"]).has(unit.lifetime)) {
        throw new Error(`Plugin "${plugin.id}" runtime unit "${unit.id}" has invalid lifetime`);
      }
      unitIds.add(unit.id);
    }
    if (units.length > 1 && options.execution === undefined) {
      throw new Error(`Plugin "${plugin.id}" declares multiple runtime units; Host execution must be explicit`);
    }
    if (options.execution !== undefined) {
      const matchingUnits = units.filter((unit) => unit.execution === options.execution);
      if (matchingUnits.length > 1) {
        throw new Error(`Plugin "${plugin.id}" declares multiple runtime units for execution "${options.execution}"`);
      }
    }
    if (units.length > 0) {
      const productLevelFields = [
        ["dependencies", plugin.dependencies],
        ["storage", plugin.storage],
        ["permissions", plugin.permissions],
        ["business", plugin.business],
        ["config", plugin.config],
      ] as const;
      const misplaced = productLevelFields
        .filter(([, value]) => value !== undefined)
        .map(([field]) => field);
      if (misplaced.length > 0) {
        throw new Error(
          `Plugin "${plugin.id}" has product-level runtime declarations (${misplaced.join(", ")}); move them to the selected runtime unit`,
        );
      }
      if ((plugin.meta.providesCapabilities?.length ?? 0) > 0) {
        throw new Error(
          `Plugin "${plugin.id}" has product-level meta.providesCapabilities; move provides to the selected runtime unit`,
        );
      }
    }
    const declarations = [plugin.storage, ...units.map((unit) => unit.storage)].filter(
      (declaration): declaration is PluginStorageDeclaration => declaration !== undefined
    );
    for (const declaration of declarations) {
      if (declaration.scope === "platform" && !PLATFORM_STORAGE_MANIFEST_ALLOWLIST.has(plugin.id)) {
        throw new Error(`Plugin "${plugin.id}" is not allowed to declare platform storage`);
      }
      if (declaration.scope === "key" && declaration.applicationStorageId.toLowerCase() === "keys") {
        throw new Error(`Plugin "${plugin.id}" cannot claim the platform keys namespace`);
      }
      validatePluginStorageDeclaration(declaration);
      assertSystemStorageDeclaration(plugin.id, declaration);
    }
    if (meta.startup === "required") {
      if (!meta.defaultEnabled) throw new Error(`Required plugin "${plugin.id}" must have defaultEnabled=true`);
      if (meta.canDisable) throw new Error(`Required plugin "${plugin.id}" must have canDisable=false`);
      if (!providesOfManifest(plugin, options.execution).length) throw new Error(`Required plugin "${plugin.id}" must provide capabilities`);
      for (const dep of dependenciesOfManifest(plugin, options.execution)) {
        if (dep.optional) continue;
        const provider = (manifestSet ?? [...knownManifests.values()]).find((m) => providesOfManifest(m, options.execution).includes(dep.capability));
        if (provider?.meta.startup === "optional") {
          throw new Error(`Required plugin "${plugin.id}" cannot depend on optional capability provider "${provider.id}"`);
        }
      }
    }
  }

  /**
   * 将 manifest 的业务声明投影到内部技术 registry。
   *
   * 这是唯一允许业务配置接触 route/menu/home 的位置：插件只需维护自己的
   * manifest；disable/unregister 时仍由既有 ownership diff 自动回收。
   */
  function registerBusinessContribution(ownerPluginId: string, contribution: PluginBusinessContribution | undefined): void {
    if (!contribution) return;
    for (const domain of contribution.domains) {
      for (const feature of domain.features) {
        const route = feature.entry.routeId ? routes.byId(feature.entry.routeId) : routes.byPath(feature.entry.path);
        if (feature.entry.routeId && !route) throw new Error(`Business feature "${feature.id}" references missing route "${feature.entry.routeId}"`);
        if (route && route.path !== feature.entry.path) throw new Error(`Business feature "${feature.id}" route path conflicts with its reference`);
        if (route && !feature.entry.routeId) throw new Error(`Business feature "${feature.id}" must explicitly declare routeId for existing route "${feature.entry.path}"`);
        if (!route) {
          if (!feature.entry.component) throw new Error(`Business feature "${feature.id}" must provide component for a new route`);
          routes.register({ id: feature.id, path: feature.entry.path, label: feature.label, component: feature.entry.component });
        }
        for (const view of feature.views ?? []) {
          if (routes.byPath(view.path)) throw new Error(`Business feature view "${view.id}" path "${view.path}" conflicts with an existing route`);
          routes.register({ id: view.id, path: view.path, label: view.label, component: view.component });
        }
      }
      business.register(ownerPluginId, domain);
    }
  }

  /** 业务贡献只来自当前运行单元；Worker 不继承 Window 页面声明。 */
  function businessOfPrimaryUnit(manifest: PluginManifest): PluginBusinessContribution | undefined {
    const units = manifest.units ?? [];
    return units.length > 0 ? primaryRuntimeUnit(manifest, options.execution)?.business : manifest.business;
  }

  async function runSetup(record: PluginRecord, storage?: KeyValueStore): Promise<void> {
    const before = snapshotOwnership();
    let teardownFn: (() => void | Promise<void>) | undefined;
    try {
      // 多单元 manifest 的实现由环境注册表按 unitId 选择；不能把另一个
      // 环境的 setup 当成当前单元入口。迁移期间仅 Window 允许回退到
      // product-level setup，Worker 缺实现时保持空装配；无 units/单单元仍
      // 兼容历史 product setup。
      const declaredUnits = record.manifest.units ?? [];
      const selectedUnit = primaryRuntimeUnit(record.manifest, options.execution);
      const registeredImplementation = selectedUnit
        ? options.runtimeUnitImplementationRegistry?.get(record.manifest.id, selectedUnit.id)
        : undefined;
      if (options.requireRuntimeUnitImplementationRegistry
        && typeof record.manifest.setup === "function"
        && !registeredImplementation) {
        throw new Error(`运行单元 ${record.manifest.id}/${selectedUnit?.id ?? "unknown"} 缺少当前环境实现注册`);
      }
      const setup = declaredUnits.length > 1
        ? registeredImplementation ?? (options.execution === "window" ? record.manifest.setup : undefined)
        : registeredImplementation ?? record.manifest.setup;
      const run = setup ?? (() => undefined);
      const result = run(buildContext(record, storage));
      teardownFn = (await Promise.resolve(result)) as
        | (() => void | Promise<void>)
        | undefined;
      registerBusinessContribution(record.manifest.id, businessOfPrimaryUnit(record.manifest));
    } catch (err) {
      const after = snapshotOwnership();
      const diff = ownershipDiff(before, after);
      record.ownership = {
        ...emptyOwnership(),
        ...diff,
        teardown: undefined
      };
      logService.append({
        level: "error",
        pluginId: RUNTIME_SYSTEM_PLUGIN_ID,
        scope: "plugin-host",
        event: "setup.failed",
        message: `Plugin setup failed: ${record.manifest.id}`,
        data: { pluginId: record.manifest.id },
        error: {
          name: err instanceof Error ? err.name : "Error",
          message: err instanceof Error ? err.message : String(err)
        }
      });
      throw err;
    }
    const after = snapshotOwnership();
    const diff = ownershipDiff(before, after);
    record.ownership = {
      ...emptyOwnership(),
      ...diff,
      teardown: typeof teardownFn === "function" ? teardownFn : undefined
    };
  }

  function currentRoutePlugin(): string | undefined {
    if (typeof window === "undefined") return undefined;
    const path = window.location.pathname;
    for (const pluginId of enabledSet) {
      const r = records.get(pluginId);
      if (!r) continue;
      const routeIds = r.ownership.routes;
      for (const rid of routeIds) {
        const route = routes.byId(rid);
        if (!route) continue;
        if (route.path === path || matchPath(route.path, path)) {
          return pluginId;
        }
      }
      for (const sid of r.ownership.settingsRoutes) {
        const settingsRoute = settings.byId(sid);
        if (!settingsRoute) continue;
        if (settingsRoute.path === path || matchPath(settingsRoute.path, path)) {
          return pluginId;
        }
      }
    }
    return undefined;
  }

  function matchPath(pattern: string, path: string): boolean {
    if (!pattern.includes(":")) return pattern === path;
    const patternParts = pattern.split("/");
    const pathParts = path.split("/");
    if (patternParts.length !== pathParts.length) return false;
    for (let i = 0; i < patternParts.length; i++) {
      const p = patternParts[i];
      if (p && p.startsWith(":")) continue;
      if (p !== pathParts[i]) return false;
    }
    return true;
  }

  function safeNavigateAway(pluginId: string): void {
    const current = currentRoutePlugin();
    if (current !== pluginId) return;
    if (typeof window === "undefined") return;
    if (window.location.pathname === safePath) return;
    window.history.pushState({}, "", safePath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function purgeOwnership(ownership: PluginOwnership, pluginId?: string): void {
    const errors: unknown[] = [];
    function safe(fn: () => void, name: string) {
      try {
        fn();
      } catch (err) {
        // 新的实例级 Registry facade 可能已经完成注销；旧 ownership
        // snapshot 再次兜底时遇到不存在的 id 属于幂等成功。
        if (err instanceof Error && /not registered/i.test(err.message)) return;
        errors.push({ name, err });
      }
    }
    // Dispose records first: callbacks must not observe a definition that is
    // about to be removed and schedule new work through it.
    if (pluginId) {
      safe(() => resourceStore.disposeOwner(pluginId), `resourceOwner:${pluginId}`);
    }
    for (const id of ownership.topbarItems) safe(() => topbar.unregister(id), `topbar:${id}`);
    for (const id of ownership.businessFeatures) safe(() => business.unregisterFeature(id), `businessFeature:${id}`);
    for (const id of ownership.businessDomains) safe(() => business.unregisterDomain(id), `businessDomain:${id}`);
    for (const id of ownership.routes) safe(() => routes.unregister(id), `route:${id}`);
    for (const id of ownership.homeWidgets) safe(() => home.unregister(id), `home:${id}`);
    for (const id of ownership.settingsRoutes)
      safe(() => settings.unregister(id), `settingsRoute:${id}`);
    for (const id of ownership.systemSettingsItems)
      safe(() => systemSettings.unregister(id), `systemSettingsItem:${id}`);
    for (const id of ownership.systemStatusModules)
      safe(() => systemStatus.unregister(id), `systemStatusModule:${id}`);
    for (const id of ownership.vaultSettingsSections)
      safe(() => vaultSettings.unregister(id), `vaultSettingsSection:${id}`);
    for (const id of ownership.applicationSettingsItems)
      safe(() => applicationSettings.unregister(id), `applicationSettingsItem:${id}`);
    for (const id of ownership.breadcrumbs)
      safe(() => breadcrumbs.unregister(id), `breadcrumb:${id}`);
    for (const id of ownership.commands) safe(() => commands.unregister(id), `command:${id}`);
    for (const id of ownership.importers) safe(() => importers.unregister(id), `importer:${id}`);
    for (const id of ownership.transferProviders)
      safe(() => transfers.unregister(id), `transfer:${id}`);
    for (const id of ownership.contactPublicKeyActions)
      safe(() => contactPublicKeyActions.unregister(id), `contactPublicKeyAction:${id}`);
    for (const id of ownership.assetProviders)
      safe(() => assets.unregister(id), `asset:${id}`);
    for (const id of ownership.tokenProviders) safe(() => tokens.unregister(id), `token:${id}`);
    for (const id of ownership.collectibleProviders)
      safe(() => collectibles.unregister(id), `collectible:${id}`);
    for (const id of ownership.collectibleTransferHandlers)
      safe(() => collectibleTransfer.unregister(id), `collectibleTransfer:${id}`);
    if (pluginId && capabilities.has("protected-outpoint.registry")) {
      safe(() => capabilities.get<ProtectedOutpointRegistry>("protected-outpoint.registry").unregisterByOwner(pluginId), `protectedOutpoints:${pluginId}`);
    }
    for (const cap of ownership.capabilities) safe(() => capabilities.revoke(cap), `capability:${cap}`);
    resourceStore.refreshRuntimeBindings();
    // 注销 resource definition 并清理该 plugin 拥有的所有 resource records
    for (const id of ownership.resourceDefinitions) {
      if (resourceRegistry.get(id)) safe(() => resourceRegistry.unregister(id), `resource:${id}`);
    }
    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.error("[pluginHost] purgeOwnership errors", errors);
    }
  }

  function purgePluginNotices(pluginId: string): void {
    if (!capabilities.has("notice.registry")) return;
    const registry = capabilities.get<NoticeRegistry>("notice.registry");
    registry.removeBySourcePluginId(pluginId);
  }

  async function runTeardown(ownership: PluginOwnership): Promise<unknown> {
    if (!ownership.teardown) return undefined;
    try {
      return await ownership.teardown();
    } catch (err) {
      return err;
    }
  }

  async function runDisposeCallbacks(record: PluginRecord): Promise<unknown> {
    const callbacks = record.disposeCallbacks.splice(0).reverse();
    let firstError: unknown;
    for (const cleanup of callbacks) {
      try { await cleanup(); } catch (err) { firstError ??= err; }
    }
    return firstError;
  }

  // configStore 订阅会在插件启用过程中收到 setEnabled 通知；用 in-flight
  // 集合避免同一插件被递归 enable，导致 setup 永不返回。
  const enablingPluginIds = new Set<string>();
  /** 正在初始化的实例；并发 enable/disable 必须等待同一条链。 */
  const startingPluginIds = new Map<string, Promise<void>>();
  /** 正在收尾的插件；并发 disable 共享同一个 Promise。 */
  const stoppingPluginIds = new Map<string, Promise<void>>();
  /** Host 自己写入意图时抑制同一同步栈内的 config 反馈，避免递归 enable。 */
  const internalIntentWrites = new Set<string>();

  function setDesiredEnabled(pluginId: string, enabled: boolean): void {
    if (options.pluginIntentCoordinator) {
      // 生产命令只能经过 Coordinator plugin.intent.submit；Host 内部的
      // enable/disable 是“执行已提交意图”，不能反向改写唯一权威。
      return;
    }
    internalIntentWrites.add(pluginId);
    try {
      configStore.setEnabled(pluginId, enabled);
    } finally {
      internalIntentWrites.delete(pluginId);
    }
  }

  function revokeOwnedCapabilities(record: PluginRecord): void {
    for (const capability of record.ownership.capabilities) {
      capabilities.revoke(capability);
    }
    resourceStore.refreshRuntimeBindings();
  }

  /** 先同步撤权，再按消费者到提供者的顺序异步收尾。 */
  function beginPluginStop(
    record: PluginRecord,
    reason: string,
    preserveIntent = false,
    blockedBy?: readonly string[]
  ): void {
    if (record.state === "stopping" || record.state === "cleanup-pending") return;
    const wasStarting = record.state === "starting";
    record.state = "stopping";
    record.error = undefined;
    record.blockedBy = undefined;
    // 级联停止可能直接命中异步 setup。让 setup 的旧 Promise 走“被停止”
    // 收尾分支，否则它会被误报为普通启动失败并丢失 waiting 意图。
    if (wasStarting) record.stopRequested = reason;
    record.stopPreserveIntent = preserveIntent;
    record.stopBlockedBy = blockedBy ? [...blockedBy] : undefined;
    record.scope?.revoke(reason);
    // 能力、路由、菜单、命令、Resource Definition 等所有产品入口都在
    // 同步阶段撤销；不能把 UI/业务入口留到网络 teardown 完成之后。
    safeNavigateAway(record.manifest.id);
    purgeOwnership(record.ownership, record.manifest.id);
    purgePluginNotices(record.manifest.id);
    i18n.unregisterResources(record.manifest.id);
    // 兼容 setup 期间 ownership 尚未完成 snapshot 的情况；scope facade
    // 已经在 revoke 时同步撤权，这里只作为 Host 级兜底，不等待异步清理。
    revokeOwnedCapabilities(record);
    enabledSet.delete(record.manifest.id);
    bumpVersion();
  }

  function collectDisablePlan(pluginId: string): PluginRecord[] {
    const plan: PluginRecord[] = [];
    const visited = new Set<string>();
    const graph = host.graph();
    const visit = (providerId: string) => {
      for (const dependent of reverseDependentsOf(graph, providerId, enabledSet)) {
        if (visited.has(dependent.pluginId)) continue;
        visited.add(dependent.pluginId);
        visit(dependent.pluginId);
        const record = records.get(dependent.pluginId);
        if (record) plan.push(record);
      }
    };
    visit(pluginId);
    const provider = records.get(pluginId);
    if (provider) plan.push(provider);
    return plan;
  }

  function immutableDependent(plan: readonly PluginRecord[], providerId: string): PluginRecord | undefined {
    return plan
      .filter((record) => record.manifest.id !== providerId)
      .find((record) => isStartupRequired(record.manifest) || record.manifest.meta.canDisable === false);
  }

  async function finishPluginStop(
    record: PluginRecord,
    options: { preserveIntent: boolean; blockedBy?: string[]; reason: string }
  ): Promise<void> {
    let disposeErr: unknown;
    let teardownErr: unknown;
    record.cleanupRecovery = {
      preserveIntent: options.preserveIntent,
      blockedBy: options.blockedBy,
      completionState: "disabled",
    };
    const scopeCleanup = await disposePluginScope(record, options.reason, async () => {
      // 生命周期清理分成三段：先让显式 onDispose 停止业务订阅，再执行
      // legacy teardown，最后由 Registry facade 注销技术注册项。
      disposeErr = await runDisposeCallbacks(record);
      teardownErr = await runTeardown(record.ownership);
      // 不能把 teardown 的错误只存在局部变量里：如果调用方设置了
      // timeout，ResourceScope 会先返回 cleanup-pending，底层回调随后
      // 才结算。必须让该错误沿同一个 teardown entry 进入 onLateFailure，
      // 否则“超时后迟到失败”会被误判成“超时后成功”，并错误恢复插件。
      const cleanupError = disposeErr ?? teardownErr;
      if (cleanupError) throw cleanupError;
    });
    record.cleanup = scopeCleanup;
    purgeOwnership(record.ownership, record.manifest.id);
    purgePluginNotices(record.manifest.id);
    i18n.unregisterResources(record.manifest.id);
    record.ownership = emptyOwnership();
    record.scope = undefined;
    record.instanceId = undefined;
    record.stopRequested = undefined;
    record.stopPreserveIntent = undefined;
    record.stopBlockedBy = undefined;
    const latestDesired = record.pendingDesiredEnabled
      ?? desiredEnabledFor(record.manifest.id, record.manifest);
    const missingDependencies = missingHardDependencies(record.manifest);
    const preserveIntent = options.preserveIntent && latestDesired;
    // 级联停止后，如果用户在清理完成前重新启用了 Provider，消费者的
    // waiting 意图应在旧实例完全收尾后重启，而不是永久停在 blocked。
    const runtimeUnavailable = runtimeUnitUnavailableReason(record.manifest);
    const waitingForDependency = preserveIntent
      && (missingDependencies.length > 0 || runtimeUnavailable !== undefined);
    const restartAfterStop = latestDesired
      && (!options.preserveIntent || !waitingForDependency)
      && !runtimeTransitioning;
    record.pendingDesiredEnabled = undefined;
    const lifecycleError = disposeErr ?? teardownErr ?? scopeCleanup?.errors[0];
    const nonTimeoutCleanupError = scopeCleanup?.errors.find((issue) => issue.code !== "lifecycle.cleanup_timeout");
    const hasCleanupError = Boolean(disposeErr || teardownErr || nonTimeoutCleanupError);
    const hasCleanupTimeout = Boolean(scopeCleanup?.errors.some((issue) => issue.code === "lifecycle.cleanup_timeout"));
    // ResourceScope 会把“已结算但失败”的条目也列入 pending，便于诊断；
    // Host 状态要区分它与仍有 Promise 在后台运行的 cleanup-pending。
    // 没有 timeout 的错误已经收敛，只保留 error-disabled；存在 timeout
    // 才继续锁住 cleanup-pending，等待迟到成功/失败回调。
    const cleanupStillPending = Boolean(scopeCleanup?.pending.length) && hasCleanupTimeout;
    if (hasCleanupError) {
      record.cleanupRecovery.completionState = "error-disabled";
    }
    if (cleanupStillPending) {
      record.state = "cleanup-pending";
      record.error = lifecycleError
        ? lifecycleErrorMessage(lifecycleError)
        : "Plugin cleanup is still pending";
    } else if (hasCleanupError) {
      record.state = "error-disabled";
      record.error = lifecycleErrorMessage(lifecycleError);
      // 清理已经收敛，只是 teardown 返回了错误；不能把已完成实例的恢复
      // 上下文留到下一次 retry，避免旧结果再次改写新实例状态。
      record.cleanupRecovery = undefined;
    } else if (scopeCleanup?.cleanupIncomplete) {
      // 未识别的清理不完整结果也必须 fail closed，不能显示为已停用。
      record.state = "cleanup-pending";
      record.error = "Plugin cleanup is still pending";
    } else {
      record.state = waitingForDependency ? "blocked" : "disabled";
      record.blockedBy = waitingForDependency
        ? [...new Set([...(options.blockedBy ?? []), ...missingDependencies, ...(runtimeUnavailable ? [runtimeUnavailable] : [])])]
        : undefined;
      record.error = undefined;
      record.cleanupRecovery = undefined;
    }
    if (!options.preserveIntent && !latestDesired) setDesiredEnabled(record.manifest.id, false);
    logService.append({
      level: lifecycleError ? "error" : "info",
      pluginId: RUNTIME_SYSTEM_PLUGIN_ID,
      scope: "plugin-host",
      event: lifecycleError ? "teardown.failed" : "plugin.disabled",
      message: lifecycleError
        ? `Plugin cleanup failed: ${record.manifest.id}`
        : `Plugin disabled: ${record.manifest.id}`,
      data: { pluginId: record.manifest.id, preserveIntent: options.preserveIntent },
      ...(lifecycleError ? {
        error: {
          name: lifecycleError instanceof Error ? lifecycleError.name : "Error",
          message: lifecycleErrorMessage(lifecycleError)
        }
      } : {})
    });
    bumpVersion();
    if (restartAfterStop && record.state === "disabled" && desiredEnabledFor(record.manifest.id, record.manifest)) {
      // 只在旧清理完全结束后创建新实例；旧实例的异步结果不会覆盖它。
      queueMicrotask(() => {
        void host.enable(record.manifest.id).catch(() => undefined);
      });
    }
  }

  async function stopPlugin(
    record: PluginRecord,
    options: { preserveIntent: boolean; blockedBy?: string[]; reason: string }
  ): Promise<void> {
    const existing = stoppingPluginIds.get(record.manifest.id);
    if (existing) return existing;
    beginPluginStop(record, options.reason, options.preserveIntent, options.blockedBy);
    const starting = startingPluginIds.get(record.manifest.id);
    if (starting) {
      // 级联停止可能撞上消费者自己的异步 setup。先同步撤权，再等待
      // setup 的旧实例自行进入失败收尾；不能另起一条 dispose 链。
      const promise = starting
        .catch(() => undefined)
        .finally(() => { stoppingPluginIds.delete(record.manifest.id); });
      stoppingPluginIds.set(record.manifest.id, promise);
      return promise;
    }
    const promise = finishPluginStop(record, options).finally(() => {
      stoppingPluginIds.delete(record.manifest.id);
    });
    stoppingPluginIds.set(record.manifest.id, promise);
    return promise;
  }

  function runtimeIdentityKey(identity: RuntimeIdentityTransition | undefined): string {
    return identity
      ? `${identity.vaultStatus}|${identity.ownerPublicKeyHex ?? ""}|${identity.sessionEpoch}|${identity.bucketGeneration ?? "unknown"}`
      : "uninitialized";
  }

  function lifetimeChanged(
    lifetime: PluginLifetime,
    previous: RuntimeIdentityTransition | undefined,
    next: RuntimeIdentityTransition,
  ): boolean {
    if (!previous) return true;
    if (lifetime === "storage") {
      return storageScopeKeyFor(previous) !== storageScopeKeyFor(next);
    }
    if (lifetime === "owner-session") {
      return ownerSessionScopeKeyFor(previous) !== ownerSessionScopeKeyFor(next)
        || previous.vaultStatus !== next.vaultStatus;
    }
    if (lifetime === "connect-session") {
      return previous.sessionEpoch !== next.sessionEpoch
        || previous.vaultStatus !== next.vaultStatus;
    }
    return false;
  }

  async function waitForRuntimeCleanup(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise.catch(() => undefined),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  interface RuntimeIdentityTransitionWork {
    requested: RuntimeIdentityTransition;
    rotatingLifetimes: Set<PluginLifetime>;
    affected: PluginRecord[];
    oldScopes: LifecycleScope[];
    oldStorageScope?: LifecycleScope;
    oldOwnerSessionScope?: LifecycleScope;
    oldConnectSessionScope?: LifecycleScope;
  }

  /** 身份转换的同步部分：调用 transition API 返回前就完成撤权。 */
  function prepareRuntimeIdentityTransition(
    requested: RuntimeIdentityTransition,
  ): RuntimeIdentityTransitionWork | undefined {
    if (runtimeIdentityKey(runtimeIdentity) === runtimeIdentityKey(requested)) return undefined;

    const previous = runtimeIdentity;
    const rotatingLifetimes = new Set<PluginLifetime>(
      (["storage", "owner-session", "connect-session"] as PluginLifetime[])
        .filter((lifetime) => lifetimeChanged(lifetime, previous, requested)),
    );
    const affected = [...records.values()].filter((record) =>
      rotatingLifetimes.has(lifetimeOfManifest(record.manifest))
      && (
        Boolean(record.scope)
        || record.state === "starting"
        || record.state === "stopping"
        || (
          desiredEnabledFor(record.manifest.id, record.manifest)
          && (record.state === "blocked" || record.state === "disabled" || record.state === "registered")
        )
      )
    );
    const oldStorageScope = rotatingLifetimes.has("storage") ? storageScope : undefined;
    const oldOwnerSessionScope = rotatingLifetimes.has("owner-session") ? ownerSessionScope : undefined;
    const oldConnectSessionScope = rotatingLifetimes.has("connect-session") ? connectSessionScope : undefined;
    const oldScopes = [oldStorageScope, oldOwnerSessionScope, oldConnectSessionScope]
      .filter((scope): scope is LifecycleScope => Boolean(scope));

    // 先切换身份，使 stop 完成逻辑和 late cleanup recovery 都看到新
    // 世代；再同步撤销所有旧实例的 capability、路由、菜单和监听器。
    runtimeIdentity = { ...requested };
    runtimeTransitioning = true;
    for (const record of affected) {
      beginPluginStop(
        record,
        `runtime identity changed to ${requested.vaultStatus}`,
        true,
      );
    }
    for (const scope of oldScopes) scope.revoke("runtime identity changed");
    bumpVersion();

    return {
      requested,
      rotatingLifetimes,
      affected,
      oldScopes,
      oldStorageScope,
      oldOwnerSessionScope,
      oldConnectSessionScope,
    };
  }

  async function completeRuntimeIdentityTransition(
    work: RuntimeIdentityTransitionWork,
  ): Promise<void> {
    const waitMs = options.lifecycleCleanupTimeoutMs ?? 5_000;
    try {
      await Promise.all(work.affected.map(async (record) => {
        const stopping = stopPlugin(record, {
          preserveIntent: true,
          reason: `runtime identity changed to ${work.requested.vaultStatus}`,
        });
        await waitForRuntimeCleanup(stopping, waitMs);
      }));
      // 父 Scope 也必须完成一次 dispose；它是 Root 的一等资源，不能
      // 只依赖插件记录上的 scope.dispose 结果。
      await Promise.all(work.oldScopes.map((scope) => scope.dispose({
        reason: "runtime identity changed",
        timeoutMs: options.lifecycleCleanupTimeoutMs,
      })));
    } finally {
      if (storageScope === work.oldStorageScope) {
        storageScope = undefined;
        storageScopeKey = undefined;
      }
      if (ownerSessionScope === work.oldOwnerSessionScope) {
        ownerSessionScope = undefined;
        ownerSessionScopeKey = undefined;
      }
      if (connectSessionScope === work.oldConnectSessionScope) {
        connectSessionScope = undefined;
        connectSessionScopeKey = undefined;
      }
      runtimeTransitioning = false;
    }

    // 新身份已经可用后，只重启仍保留 desiredEnabled 的实例；旧清理
    // 仍 pending 的记录会由其 late-success recovery 在最终完成后触发。
    for (const record of work.affected) {
      const desired = desiredEnabledFor(record.manifest.id, record.manifest);
      if (!desired || record.cleanup?.cleanupIncomplete) continue;
      if (record.state !== "blocked" && record.state !== "disabled" && record.state !== "registered") continue;
      if (runtimeUnitUnavailableReason(record.manifest)) continue;
      try {
        await host.enable(record.manifest.id);
      } catch {
        // 新实例 setup 失败由 Host 状态记录；不能回滚已经切换的身份。
      }
    }
  }

  /**
   * 应用 Vault/owner/session 身份切换。这个 API 只改变运行实例，不写入
   * 产品启停配置：锁屏后 desiredEnabled 仍为 true，解锁时按新身份重建。
   */
  function transitionRuntimeIdentity(identity: RuntimeIdentityTransition): Promise<void> {
    if (hostDisposed) return Promise.reject(new LifecycleScopeRevokedError("Plugin host is disposed"));
    if (!identity.sessionEpoch || typeof identity.sessionEpoch !== "string") {
      return Promise.reject(new Error("Runtime identity sessionEpoch is required"));
    }
    if (identity.vaultStatus === "unlocked"
      && (!identity.ownerPublicKeyHex || identity.ownerPublicKeyHex.length === 0)) {
      return Promise.reject(new Error("Unlocked runtime identity requires ownerPublicKeyHex"));
    }
    const requested = { ...identity };
    const previousTransition = runtimeTransitionPromise;
    if (!previousTransition) {
      const work = prepareRuntimeIdentityTransition(requested);
      if (!work) return Promise.resolve();
      const settled = completeRuntimeIdentityTransition(work).finally(() => {
        if (runtimeTransitionPromise === settled) runtimeTransitionPromise = undefined;
      });
      runtimeTransitionPromise = settled;
      return settled;
    }
    const run = previousTransition.catch(() => undefined).then(async () => {
      if (hostDisposed) throw new LifecycleScopeRevokedError("Plugin host is disposed");
      const work = prepareRuntimeIdentityTransition(requested);
      if (!work) return;
      await completeRuntimeIdentityTransition(work);
    });
    const settled = run.finally(() => {
      if (runtimeTransitionPromise === settled) runtimeTransitionPromise = undefined;
    });
    runtimeTransitionPromise = settled;
    return settled;
  }

  /** 提供者恢复后，只重启仍保留用户意图且确实被该能力阻塞的消费者。 */
  async function restoreDesiredDependents(providerId: string): Promise<void> {
    const provider = records.get(providerId);
    if (!provider) return;
    const providerCapabilities = new Set(providesOfManifest(provider.manifest, options.execution));
    const graph = host.graph();
    for (const dependent of graph.reverse[providerId] ?? []) {
      const record = records.get(dependent.pluginId);
      if (!record || record.state !== "blocked") continue;
      const desired = desiredEnabledFor(dependent.pluginId, record.manifest);
      if (!desired || !record.blockedBy?.some((capability) => providerCapabilities.has(capability))) continue;
      try {
        await host.enable(dependent.pluginId);
      } catch {
        // 其它依赖仍缺失或 setup 失败时保留其 waiting/failed 状态；
        // 提供者本身已经成功，不让一个消费者错误回滚提供者。
      }
    }
  }

  function makePluginIntentCommandId(pluginId: string, desiredEnabled: boolean): string {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `plugin-intent:${pluginId}:${crypto.randomUUID()}`;
      }
    } catch {
      // 仅作命令幂等键；没有 Web Crypto 时仍需保证本次页面内不重复。
    }
    return `plugin-intent:${pluginId}:${desiredEnabled ? "enable" : "disable"}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  }

  function pluginIntentConflict(commandId: string, message: string): Extract<PluginIntentSubmissionResult, { status: "command-conflict" }> {
    return { status: "command-conflict", commandId, message };
  }

  /** 将 Coordinator 广播的产品意图投影到当前 Window Host。 */
  async function reconcilePluginIntentSnapshot(snapshot: PluginIntentSnapshot): Promise<void> {
    pluginIntentSnapshot = {
      revision: snapshot.revision,
      desiredEnabled: { ...snapshot.desiredEnabled },
      desiredRevision: { ...snapshot.desiredRevision },
    };
    bumpVersion();
    for (const [id, record] of records) {
      const immutable = isStartupRequired(record.manifest) || record.manifest.meta.canDisable === false;
      const desired = immutable ? true : desiredEnabledFor(id, record.manifest);
      const activeLike = record.state === "enabled" || record.state === "starting" || record.state === "stopping";
      if (desired && !activeLike && record.state !== "error-disabled" && record.state !== "cleanup-pending") {
        void host.enable(id).catch(() => undefined);
      } else if (!desired && activeLike) {
        void host.disable(id).catch(() => undefined);
      }
    }
  }

  async function submitPluginIntent(pluginId: string, desiredEnabled: boolean): Promise<PluginIntentSubmissionResult> {
    const commandId = makePluginIntentCommandId(pluginId, desiredEnabled);
    const record = records.get(pluginId);
    if (!record) return pluginIntentConflict(commandId, `Plugin "${pluginId}" is not registered`);
    if (!desiredEnabled && (isStartupRequired(record.manifest) || record.manifest.meta.canDisable === false)) {
      return pluginIntentConflict(commandId, `Plugin "${pluginId}" is marked canDisable=false`);
    }

    const coordinator = options.pluginIntentCoordinator;
    if (!coordinator) {
      // 兼容没有 Coordinator 的测试/旧宿主；生产 Host 必须走上面的
      // 唯一权威适配器，不会进入这个分支。
      if (desiredEnabled) {
        await host.enable(pluginId);
      } else {
        const result = await host.disable(pluginId);
        if (!result.ok) return pluginIntentConflict(commandId, result.reason);
      }
      const current = pluginIntentSnapshot ?? { revision: 0, desiredEnabled: {}, desiredRevision: {} };
      return {
        status: "accepted",
        commandId,
        persisted: true,
        snapshot: {
          revision: current.revision,
          desiredEnabled: { ...current.desiredEnabled, [pluginId]: desiredEnabled },
          desiredRevision: { ...current.desiredRevision, [pluginId]: (current.desiredRevision[pluginId] ?? 0) + 1 },
        },
      };
    }

    if (!desiredEnabled) {
      const plan = collectDisablePlan(pluginId);
      const immutable = immutableDependent(plan, pluginId);
      if (immutable) {
        return pluginIntentConflict(commandId, `Cannot disable "${pluginId}": required dependent "${immutable.manifest.id}" cannot be stopped`);
      }
    }

    const current = coordinator.snapshot();
    const command: PluginIntentCommand = {
      commandId,
      authorityInstanceId: coordinator.authorityInstanceId,
      expectedRevision: current.revision,
      pluginId,
      desiredEnabled,
    };
    const result = await coordinator.submit(command);
    if ("snapshot" in result && result.snapshot) {
      await reconcilePluginIntentSnapshot(result.snapshot);
    }
    if (result.status === "accepted") {
      // accepted 只承诺 Worker 已持久化。当前页面仍要执行本地实例，
      // 失败由 host.state(error-disabled/blocked) 暴露，不能回写 false。
      try {
        if (desiredEnabled) await host.enable(pluginId);
        else await host.disable(pluginId);
      } catch {
        // setup/清理错误已由 Host 记录到实例状态；意图必须保持不变。
      }
    }
    return result;
  }

  const host: PluginHost = {
    rootScope,
    taskScheduler,
    refreshRuntimeUnitSnapshots() {
      // 远程 Worker 快照是观察面变化，不改变本地插件生命周期状态。
      bumpVersion();
    },
    transitionRuntimeIdentity,
    capabilities,
    messageBus,
    routes,
    breadcrumbs,
    settings,
    systemSettings,
    systemStatus,
    vaultSettings,
    applicationSettings,
    home,
    business,
    commands,
    importers,
    transfers,
    contactPublicKeyActions,
    assets,
    tokens,
    collectibles,
    collectibleTransfer,
    protectedOutpoints,
    topbar,
    notice,
    i18n,
    log: logService,
    configStore,
    resourceStore,
    pluginIntent: options.pluginIntentCoordinator,

    assertCapabilities(requiredCapabilities, assertOptions = {}) {
      const missing: StartupCapabilityErrorDetails[] = [];
      for (const capability of requiredCapabilities) {
        if (capabilities.has(capability)) continue;
        const provider = [...knownManifests.values()].find((m) => providesOfManifest(m, options.execution).includes(capability));
        const state = provider ? recordState(provider.id) : undefined;
        missing.push({
          capability,
          providerPluginId: provider?.id,
          providerState: state?.kind,
          providerError: state?.error,
          configuredEnabled: provider ? desiredEnabledFor(provider.id, provider) : undefined
        });
      }
      if (missing.length) throw new StartupCapabilityError(missing, assertOptions.phase);
    },

    installed() {
      return [...enabledSet];
    },
    manifests() {
      return [...knownManifests.keys()];
    },
    state(pluginId) {
      return recordState(pluginId);
    },
    scope(pluginId) {
      return records.get(pluginId)?.scope;
    },
    graph() {
      return buildPluginGraph([...knownManifests.values()], { enabledPluginIds: enabledSet, execution: options.execution });
    },
    version() {
      return versionCounter;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getManifest(pluginId) {
      return knownManifests.get(pluginId);
    },
    reverseDeps(pluginId) {
      const g = host.graph();
      return reverseDependentsOf(g, pluginId, enabledSet);
    },

    provide(key, value) {
      provideCapability(key, value);
      // 硬切换 2026-07-04 001：不再因 vault / keyspace 注入触发
      // scoped client 刷新——runtime 已不持有消息业务生命周期。
    },

    validateManifestSet(plugins) {
      const ids = new Set<string>();
      for (const plugin of plugins) {
        if (ids.has(plugin.id)) throw new Error(`Duplicate plugin id "${plugin.id}"`);
        ids.add(plugin.id);
      }
      for (const plugin of plugins) validateManifest(plugin, plugins);
      validatePluginGraph(plugins, {
        builtinCapabilities: new Set(capabilities.keys()),
        allowMissingDependencies: true,
        execution: options.execution,
      });
    },

    async register(plugin) {
      if (hostDisposed) throw new LifecycleScopeRevokedError("Plugin host is disposed");
      validateManifest(plugin);
      if (knownManifests.has(plugin.id)) {
        knownManifests.set(plugin.id, plugin);
        const record = records.get(plugin.id);
        if (record) {
          record.manifest = plugin;
          // Host 在第一次 setup 前就会记录 manifest。required 插件第一次
          // setup 失败后，后续阶段重放 register 时不能把“已知”误当成
          // “已装配”；必须显式清除失败状态并重新 enable。
          if ((isStartupRequired(plugin) || plugin.meta.canDisable === false)
            && (record.state === "error-disabled" || record.state === "blocked")) {
            try {
              await host.retry(plugin.id);
            } catch (err) {
              throw new StartupPluginError({
                pluginId: plugin.id,
                capabilities: providesOfManifest(plugin, options.execution),
                state: record.state,
                error: record.error ?? (err instanceof Error ? err.message : String(err))
              });
            }
          }
        }
        return;
      }
      knownManifests.set(plugin.id, plugin);
      records.set(plugin.id, {
        manifest: plugin,
        state: defaultStateFor(plugin),
        ownership: emptyOwnership(),
        disposeCallbacks: []
      });
      const required = isStartupRequired(plugin);
      configStore.setRequiredPluginIds(
        [...knownManifests.values()].filter((m) => isStartupRequired(m)).map((m) => m.id)
      );
      // `canDisable=false` is also an always-on contract. A stale persisted
      // false value must not turn a system plugin into a silently missing
      // route/capability on the next boot.
      const immutable = plugin.meta.canDisable === false;
      const shouldEnable = required || immutable
        ? true
        : desiredEnabledFor(plugin.id, plugin);
      if (shouldEnable) {
        try {
          await host.enable(plugin.id);
        } catch (err) {
          const r = records.get(plugin.id);
          if (r) {
            const msg = err instanceof Error ? err.message : String(err);
            r.error = msg;
            if (r.state !== "blocked" && r.state !== "disabled" && r.state !== "cleanup-pending" && !required) {
              r.state = "error-disabled";
            }
          }
          if (required) {
            throw new StartupPluginError({
              pluginId: plugin.id,
              capabilities: providesOfManifest(plugin, options.execution),
              state: r?.state ?? "error-disabled",
              error: r?.error
            });
          }
        }
      }
    },

    async registerAll(plugins) {
      if (hostDisposed) throw new LifecycleScopeRevokedError("Plugin host is disposed");
      host.validateManifestSet(plugins);
      configStore.setRequiredPluginIds(
        plugins.filter((plugin) => isStartupRequired(plugin)).map((plugin) => plugin.id)
      );
      // 只排序本批次内的依赖，不要求调用方手写“先 Provider 后消费者”；
      // 缺失外部 Provider 仍由 enable 转为 blocked/waiting。
      for (const plugin of orderManifestsByDependencies(plugins, options.execution)) {
        await host.register(plugin);
      }
    },

    async enable(pluginId) {
      if (hostDisposed) throw new LifecycleScopeRevokedError("Plugin host is disposed");
      const existing = startingPluginIds.get(pluginId);
      if (existing) {
        const record = records.get(pluginId);
        if (record?.state === "starting" || record?.state === "stopping") {
          // 不能只返回旧 Promise；调用者此时表达的是最新绝对意图，
          // 必须让 setup 失败收尾后按 true 重新装配。
          record.pendingDesiredEnabled = true;
          setDesiredEnabled(pluginId, true);
        }
        return existing;
      }
      const operation = (async () => {
        if (enablingPluginIds.has(pluginId)) return;
        enablingPluginIds.add(pluginId);
        try {
          const record = records.get(pluginId);
          if (!record) {
            throw new Error(`Plugin "${pluginId}" is not registered`);
          }
          if ((record.manifest.units?.length ?? 0) > 0 && !primaryRuntimeUnit(record.manifest, options.execution)) {
            record.state = "blocked";
            record.blockedBy = [`execution:${options.execution ?? "unspecified"}`];
            throw new Error(
              `Plugin "${pluginId}" has no unique runtime unit for execution "${options.execution ?? "unspecified"}"`
            );
          }
          const runtimeUnavailable = runtimeUnitUnavailableReason(record.manifest);
          if (runtimeUnavailable) {
            record.state = "blocked";
            record.blockedBy = [runtimeUnavailable];
            throw new Error(
              `Plugin "${pluginId}" cannot start because ${runtimeUnavailable}`
            );
          }
          if (record.state === "enabled") {
            setDesiredEnabled(pluginId, true);
            return;
          }
          if (record.state === "starting" || record.state === "stopping") {
            record.pendingDesiredEnabled = true;
            setDesiredEnabled(pluginId, true);
            return;
          }
          if (record.state === "cleanup-pending") {
            throw new Error(`Plugin "${pluginId}" cannot start while cleanup is pending`);
          }
          record.state = "starting";
          record.error = undefined;
          record.blockedBy = undefined;
          record.stopRequested = undefined;
          record.pendingDesiredEnabled = true;
          // 配置成功只表示用户意图已保存；后续 setup 失败仍保留 true，
          // 由状态快照报告 error-disabled，而不是伪装成用户停用。
          setDesiredEnabled(pluginId, true);
          for (const dep of dependenciesOfManifest(record.manifest, options.execution)) {
            if (dep.optional) continue;
            if (!capabilities.has(dep.capability)) {
              record.state = "blocked";
              record.blockedBy = [dep.capability];
              throw new Error(
                `Plugin "${pluginId}" requires missing capability "${dep.capability}"${dep.reason ? `: ${dep.reason}` : ""}`
              );
            }
          }
          if (record.manifest.i18n) {
            i18n.registerResources(record.manifest.id, record.manifest.i18n);
          }
          createPluginScope(record);
          enabledSet.add(pluginId);
          let storage: KeyValueStore | undefined;
          let storageTracked = false;
          try {
            storage = await bindManifestStorage(record);
            if (storage && record.scope) {
              // Storage handle 也属于 instance；不要等领域 teardown 或
              // ownership snapshot 才猜测何时关闭。
              storage = record.scope.track(storage, (store) => store.close(), "storage");
              storageTracked = true;
            }
            await runSetup(record, storage);
            // setup 期间可能收到 disable；旧初始化结果只能清理自身，不能
            // 在已撤权的实例上发布能力或覆盖新实例。
            record.scope?.assertActive();
            if (record.stopRequested) throw new LifecycleScopeRevokedError(record.stopRequested);
            const declared = providesOfManifest(record.manifest, options.execution);
            const owned = new Set(record.ownership.capabilities);
            const missing = declared.filter((cap) => !owned.has(cap));
            if (missing.length) throw new Error(`Plugin "${pluginId}" did not provide declared capabilities: ${missing.join(", ")}`);
            record.state = "enabled";
            record.error = undefined;
            record.pendingDesiredEnabled = undefined;
            setDesiredEnabled(pluginId, true);
            await restoreDesiredDependents(pluginId);
            logService.append({
              level: "info",
              pluginId: RUNTIME_SYSTEM_PLUGIN_ID,
              scope: "plugin-host",
              event: "plugin.enabled",
              message: `Plugin enabled: ${pluginId}`,
              data: { pluginId, instanceId: record.instanceId, unitId: record.unitId }
            });
            bumpVersion();
          } catch (err) {
            const stopRequested = Boolean(record.stopRequested);
            const preserveRequested = Boolean(record.stopPreserveIntent);
            const executionUnavailable = (record.manifest.units?.length ?? 0) > 0
              && !primaryRuntimeUnit(record.manifest, options.execution);
            const runtimeUnavailable = runtimeUnitUnavailableReason(record.manifest);
            const latestDesired = record.pendingDesiredEnabled
              ?? desiredEnabledFor(pluginId, record.manifest);
            const missingDependencies = missingHardDependencies(record.manifest);
            const preserveIntent = preserveRequested && latestDesired;
            const waitingForDependency = preserveIntent
              && (missingDependencies.length > 0 || runtimeUnavailable !== undefined);
            const wantsRestart = stopRequested && latestDesired && !waitingForDependency && !runtimeTransitioning;
            const stopBlockedBy = record.stopBlockedBy;
            enabledSet.delete(pluginId);
            if (!storageTracked) storage?.close();
            record.cleanupRecovery = {
              preserveIntent: false,
              completionState: stopRequested ? "disabled" : "error-disabled",
            };
            const cleanup = await disposePluginScope(record, stopRequested
              ? record.stopRequested ?? `plugin ${pluginId} stopped during setup`
              : `plugin ${pluginId} setup failed`);
            record.cleanup = cleanup;
            await runDisposeCallbacks(record);
            const ownership = record.ownership;
            purgeOwnership(ownership, pluginId);
            purgePluginNotices(record.manifest.id);
            i18n.unregisterResources(record.manifest.id);
            record.ownership = emptyOwnership();
            record.scope = undefined;
            record.instanceId = undefined;
            record.stopRequested = undefined;
            record.stopPreserveIntent = undefined;
            record.stopBlockedBy = undefined;
            record.pendingDesiredEnabled = cleanup?.cleanupIncomplete ? undefined : wantsRestart ? true : undefined;
            record.state = cleanup?.cleanupIncomplete
              ? "cleanup-pending"
              : executionUnavailable || runtimeUnavailable ? "blocked"
              : stopRequested ? waitingForDependency ? "blocked" : "disabled" : "error-disabled";
            record.blockedBy = executionUnavailable
              ? [`execution:${options.execution ?? "unspecified"}`]
              : waitingForDependency
              ? [...new Set([...(stopBlockedBy ?? []), ...missingDependencies, ...(runtimeUnavailable ? [runtimeUnavailable] : [])])]
              : undefined;
            record.error = cleanup?.cleanupIncomplete
              ? cleanup.errors[0]?.message ?? "Plugin cleanup is still pending"
              : stopRequested ? undefined : err instanceof Error ? err.message : String(err);
            if (!cleanup?.cleanupIncomplete) record.cleanupRecovery = undefined;
            if (stopRequested && !latestDesired) setDesiredEnabled(pluginId, false);
            bumpVersion();
            throw err;
          }
        } finally {
          enablingPluginIds.delete(pluginId);
        }
      })();
      startingPluginIds.set(pluginId, operation);
      try {
        return await operation;
      } finally {
        if (startingPluginIds.get(pluginId) === operation) startingPluginIds.delete(pluginId);
        const record = records.get(pluginId);
        if (
          record?.state === "disabled"
          && record.pendingDesiredEnabled === true
          && desiredEnabledFor(pluginId, record.manifest)
        ) {
          // 这里已经移除了 starting map，才允许创建替代实例；旧 setup
          // 的 Promise 结算顺序不能抢先占住这次重启。
          record.pendingDesiredEnabled = undefined;
          queueMicrotask(() => {
            void host.enable(pluginId).catch(() => undefined);
          });
        }
      }
    },

    async retry(pluginId) {
      if (hostDisposed) throw new LifecycleScopeRevokedError("Plugin host is disposed");
      const record = records.get(pluginId);
      if (!record) throw new Error(`Plugin "${pluginId}" is not registered`);
      if (record.state === "enabled") return;
      if (record.state !== "error-disabled" && record.state !== "blocked" && record.state !== "disabled" && record.state !== "registered") {
        return;
      }
      record.state = "registered";
      record.error = undefined;
      enabledSet.delete(pluginId);
      bumpVersion();
      await host.enable(pluginId);
    },

    submitIntent(pluginId, desiredEnabled) {
      if (hostDisposed) return Promise.reject(new LifecycleScopeRevokedError("Plugin host is disposed"));
      return submitPluginIntent(pluginId, desiredEnabled);
    },

    async disable(pluginId) {
      if (hostDisposed) return { ok: false, reason: "Plugin host is disposed" };
      const record = records.get(pluginId);
      if (!record) {
        return { ok: false, reason: `Plugin "${pluginId}" is not registered` };
      }
      if (isStartupRequired(record.manifest)) {
        return { ok: false, reason: "Plugin is marked canDisable=false" };
      }
      if (record.manifest.meta.canDisable === false) {
        return { ok: false, reason: "Plugin is marked canDisable=false" };
      }
      if (record.state === "starting") {
        // setup 仍在等待异步依赖时也必须先撤权；等旧 setup 自己收尾，
        // 不能让后续 enable 创建第二个实例。
        record.pendingDesiredEnabled = false;
        record.stopRequested = `plugin "${pluginId}" disabled during setup`;
        setDesiredEnabled(pluginId, false);
        beginPluginStop(record, record.stopRequested);
        const starting = startingPluginIds.get(pluginId);
        if (starting) await starting.catch(() => undefined);
        else if (record.scope) await stopPlugin(record, { preserveIntent: false, reason: record.stopRequested });
        return { ok: true };
      }
      if (record.state === "stopping") {
        record.pendingDesiredEnabled = false;
        setDesiredEnabled(pluginId, false);
        const stopping = stoppingPluginIds.get(pluginId);
        if (stopping) await stopping;
        else if (record.scope) await stopPlugin(record, { preserveIntent: false, reason: `plugin "${pluginId}" disabled` });
        return { ok: true };
      }
      if (record.state !== "enabled") {
        record.pendingDesiredEnabled = false;
        setDesiredEnabled(pluginId, false);
        return { ok: true };
      }
      const plan = collectDisablePlan(pluginId);
      const immutable = immutableDependent(plan, pluginId);
      if (immutable) {
        return {
          ok: false,
          reason: `Cannot disable "${pluginId}": required dependent "${immutable.manifest.id}" cannot be stopped`
        };
      }
      // 先记录这次直接停用的最新目标；若 stopping 期间又 enable，
      // enable 会把它改回 true，旧清理完成后再启动新实例。
      record.pendingDesiredEnabled = false;
      setDesiredEnabled(pluginId, false);
      // 先把整条逆依赖链同步撤权；随后才等待异步清理。这样提供者
      // 即使遇到永不返回的退订，也不会继续向新调用暴露旧服务。
      const stoppingCapabilities = new Set(
        plan.flatMap((item) => providesOfManifest(item.manifest, options.execution))
      );
      const blockedByFor = (item: PluginRecord): string[] => dependenciesOfManifest(item.manifest, options.execution)
        .filter((dependency) => stoppingCapabilities.has(dependency.capability))
        .map((dependency) => dependency.capability);
      for (const item of plan) {
        safeNavigateAway(item.manifest.id);
        const preserveIntent = item.manifest.id !== pluginId;
        beginPluginStop(
          item,
          `dependency provider "${pluginId}" disabled`,
          preserveIntent,
          preserveIntent ? blockedByFor(item) : undefined
        );
      }
      for (const item of plan) {
        const preserveIntent = item.manifest.id !== pluginId;
        await stopPlugin(item, {
          preserveIntent,
          blockedBy: preserveIntent ? blockedByFor(item) : undefined,
          reason: preserveIntent
            ? `dependency provider "${pluginId}" disabled`
            : `plugin "${pluginId}" disabled`
        });
      }
      return { ok: true };
    },

    async unregister(pluginId) {
      if (hostDisposed) return;
      const record = records.get(pluginId);
      if (!record) return;
      if (isStartupRequired(record.manifest)) {
        throw new Error(`Cannot unregister startup-required plugin "${pluginId}"`);
      }
      if (record.state === "enabled" || record.state === "starting" || record.state === "stopping") {
        const r = await host.disable(pluginId);
        if (!r.ok) {
          throw new Error(`Cannot unregister "${pluginId}": ${r.reason}`);
        }
      }
      const m = records.get(pluginId);
      if (m?.state === "cleanup-pending") {
        throw new Error(`Cannot unregister "${pluginId}" while cleanup is pending`);
      }
      if (m?.manifest.i18n) {
        i18n.unregisterResources(m.manifest.id);
      }
      purgePluginNotices(pluginId);
      records.delete(pluginId);
      knownManifests.delete(pluginId);
      enabledSet.delete(pluginId);
      bumpVersion();
    },
    dispose: disposeHost
  };

  /**
   * 页面 / Worker 执行环境销毁：
   * 1. 先撤销根作用域和所有插件作用域，立即切断旧调用；
   * 2. 按依赖逆序等待插件清理，避免提供者先于消费者关闭；
   * 3. 最后关闭根资源和平台句柄。
   *
   * stopPlugin 可能等待一个插件自己的异步初始化。销毁边界不能因此
   * 永久挂起；超时只表示本地结果为 pending，旧权限不会恢复。
   */
  function disposeHost(reason = "plugin host disposed"): Promise<LifecycleDisposeResult> {
    if (hostDisposePromise) return hostDisposePromise;
    hostDisposed = true;
    // 先同步移除浏览器 pagehide/beforeunload 日志 hook；后续 Host 清理
    // 仍会显式 flush，但不能在 Coordinator client 已关闭后再启动一笔
    // 隐式平台 K-V 写入。
    logService.stopBrowserFlushHooks();
    rootScope.revoke(reason);
    const run = (async (): Promise<LifecycleDisposeResult> => {
      const candidates = [...records.values()].filter((record) => Boolean(record.scope)
        || record.state === "starting"
        || record.state === "stopping");
      const ordered: PluginRecord[] = [];
      const seen = new Set<string>();
      // 在同步 revoke 前计算顺序；revoke 会从 enabledSet 隐藏旧实例。
      for (const record of candidates) {
        for (const item of collectDisablePlan(record.manifest.id)) {
          if (!seen.has(item.manifest.id)) {
            seen.add(item.manifest.id);
            ordered.push(item);
          }
        }
        if (!seen.has(record.manifest.id)) {
          seen.add(record.manifest.id);
          ordered.push(record);
        }
      }
      for (const record of candidates) {
        beginPluginStop(record, reason, true);
      }
      const waitMs = options.lifecycleCleanupTimeoutMs ?? 5_000;
      const waitForStop = async (record: PluginRecord): Promise<void> => {
        if (!record.scope && record.state !== "starting" && record.state !== "stopping") return;
        const pending = stopPlugin(record, { preserveIntent: true, reason });
        pending.catch((error) => {
          console.error(`[pluginHost] dispose failed for ${record.manifest.id}`, error);
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            pending,
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, waitMs);
            }),
          ]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      };
      for (const record of ordered) await waitForStop(record);
      for (const record of candidates) {
        if (!seen.has(record.manifest.id)) await waitForStop(record);
      }
      const rootCleanup = await rootScope.dispose({
        reason,
        timeoutMs: options.lifecycleCleanupTimeoutMs,
      });
      // 已经在 cleanup-pending 的实例可能在本次 Host.dispose() 之前就结束
      // 了自己的 stopPlugin；它没有 scope 了，但仍必须纳入 Host 结果，
      // 直到同一份清理快照最终收敛。
      const pendingRecords = [...records.values()].filter((record) =>
        !candidates.includes(record) && Boolean(record.cleanup?.cleanupIncomplete));
      hostCleanupRecords = [...candidates, ...pendingRecords];
      hostCleanupRootResult = rootCleanup;
      hostCleanupResult = {
        ...rootCleanup,
        pending: [...rootCleanup.pending],
        errors: [...rootCleanup.errors],
      };
      mergeHostCleanupResult();
      removeConfigSubscription();
      await Promise.all([
        configStore.flush({ timeoutMs: Math.min(waitMs, 250) }).catch(() => undefined),
        logService.flush({ timeoutMs: Math.min(waitMs, 250) }).catch(() => undefined),
      ]);
      configStore.close();
      options.configStorage?.close();
      logService.dispose();
      listeners.clear();
      return hostCleanupResult;
    })();
    hostDisposePromise = run;
    return run;
  }

  // 订阅 config store 变化（多标签页同步）。
  removeConfigSubscription = configStore.subscribe((snap) => {
    if (options.pluginIntentCoordinator) {
      // Coordinator 注入后，历史 config K-V 只能作为首次兼容读取来源，
      // 不能再作为运行时命令入口。否则旧页面 / 旧代码的跨 Tab 写入会
      // 绕过 commandId、authorityInstanceId 和 expectedRevision。
      return;
    }
    for (const [id, record] of records) {
      const isEnabled = record.state === "enabled";
      const isActiveLike = record.state === "enabled"
        || record.state === "starting"
        || record.state === "stopping";
      if (internalIntentWrites.has(id)) continue;
      // Ignore stale or cross-tab attempts to disable immutable core plugins.
      // Rewriting the value also repairs the persisted configuration for the
      // next page load. Do not retry a plugin already in an error state here:
      // its next normal bootstrap remains the recovery boundary.
      const immutable = record.manifest.meta.canDisable === false;
      if ((isStartupRequired(record.manifest) || immutable) && !snap[id]) {
        setDesiredEnabled(id, true);
        continue;
      }
      const want = isStartupRequired(record.manifest) || immutable
        ? true
        : hasPluginIntent(id)
          ? pluginIntentSnapshot!.desiredEnabled[id] === true
          : snap[id] ?? record.manifest.meta.defaultEnabled;
      record.pendingDesiredEnabled = want;
      if (want && !isEnabled) {
        // setup 失败的不可禁用插件留在 error-disabled，等待显式重试；
        // 不能在每次其它插件写配置时无限重试并递归 setup。
        if (record.state === "error-disabled" || record.state === "cleanup-pending") continue;
        void host.enable(id).catch(() => {
          /* ignore: 留给 UI 显示错误 */
        });
      } else if (!want && isActiveLike) {
        void host.disable(id);
      }
    }
  });

  if (options.pluginIntentCoordinator) {
    const removeIntentSubscription = options.pluginIntentCoordinator.subscribe((snapshot) => {
      void reconcilePluginIntentSnapshot(snapshot);
    });
    rootScope.onDispose(() => removeIntentSubscription(), "plugin-intent-subscription");
  }

  return host;
}

// 抑制未使用告警：vault / keyspace service 在 host 通用能力里
// 不再被使用；这里保留 import 兼容外部类型扩展。
void (null as unknown as VaultService);
void (null as unknown as KeyspaceService);

/**
 * 创建资产数据变更通知器。
 * 设计缘由：统一本 tab pub/sub 与跨 tab BroadcastChannel 失效通知。
 * 后台任务原子提交 provider K-V 后发布此事件，页面收到后只重读本地 K-V。
 *
 * 合并语义（硬切换 003）：
 * - 同一 `providerId + publicKeyHex` 的同一 microtask 内事件合并
 * - `kinds` 求并集
 * - `revision` 取最新事件
 *
 * 跨标签页同步：
 *   - 本 tab emit 时同时通过 BroadcastChannel 广播
 *   - 其他 tab 收到广播后在本 tab 内 emit，触发本地订阅者
 *   - payload 不携带余额、UTXO、token 数据，只表达"哪个 provider 的哪类数据已变更"
 */
function createAssetDataNotifier(): AssetDataNotifier {
  const listeners = new Set<(event: AssetDataInvalidationEvent) => void>();
  const pendingEvents = new Map<string, AssetDataInvalidationEvent>();
  let microtaskScheduled = false;

  /** 生成事件键（用于合并同一 provider + key 的事件） */
  function eventKey(event: AssetDataInvalidationEvent): string {
    return `${event.providerId}::${event.publicKeyHex ?? "none"}`;
  }

  /** 刷新微任务队列 */
  function flushMicrotaskQueue(): void {
    const events = Array.from(pendingEvents.values());
    pendingEvents.clear();
    microtaskScheduled = false;

    for (const event of events) {
      for (const l of listeners) {
        try {
          l(event);
        } catch (err) {
          console.error("[assetDataNotifier] listener threw", err);
        }
      }
    }
  }

  return {
    emit(event: AssetDataInvalidationEvent) {
      const key = eventKey(event);
      const existing = pendingEvents.get(key);

      if (existing) {
        // 合并事件：kinds 求并集，revision 取最新
        const mergedKinds = Array.from(new Set([...existing.kinds, ...event.kinds]));
        const mergedRevision = Math.max(existing.revision, event.revision);
        pendingEvents.set(key, {
          ...existing,
          kinds: mergedKinds,
          revision: mergedRevision
        });
      } else {
        pendingEvents.set(key, event);
      }

      // 调度微任务
      if (!microtaskScheduled) {
        microtaskScheduled = true;
        queueMicrotask(flushMicrotaskQueue);
      }
    },
    subscribe(handler: (event: AssetDataInvalidationEvent) => void) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  };
}
