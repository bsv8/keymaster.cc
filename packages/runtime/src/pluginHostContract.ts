// Keymaster Host 的领域兼容契约。
//
// 生命周期、Scope、权限和服务桥的实现都在 WebLoom；此文件只保留
// Keymaster shell 仍需要的领域 Registry、i18n、Storage 和 Coordinator
// 视图。这样旧调用者可以平滑切换到 Adapter，而不会在这里再出现 Host 状态机。

import type {
  AssetDataInvalidationEvent,
  AssetDataNotifier,
  AssetRegistry,
  ApplicationSettingsRegistry,
  BreadcrumbRegistry,
  BusinessFeatureRegistry,
  ChannelRuntime,
  ChannelRuntimeFactory,
  CommandRegistry,
  ContactPublicKeyActionRegistry,
  CoordinatorWorkerUnitSnapshot,
  HostListener,
  I18nPluginResources,
  I18nService,
  ImporterRegistry,
  KeyValueStore,
  NoticeRegistry,
  PluginContext,
  PluginGraph,
  PluginManifest,
  PluginPermission,
  PluginReverseDep,
  PluginState,
  ResourceRegistry,
  RuntimeIdentityTransition,
  RuntimeUnitImplementationRegistry,
  SettingsRegistry,
  SystemSettingsRegistry,
  SystemStatusRegistry,
  TopbarRegistry,
  TransferRegistry,
  VaultSettingsRegistry,
  KeymasterScopeAttributes,
} from "@keymaster/contracts";
import type {
  CapabilityDescriptor,
  LocalCapability,
  LocalServiceOf,
} from "webloom-framework";
import type {
  CapabilityRegistry,
  PluginHost as WebLoomPluginHost,
  ResourceStoreApi,
} from "webloom-framework/advanced";
import type {
  LifecycleDisposeResult,
  LifecycleScope,
  MessageBus,
  PermissionLeaseBinding,
  RuntimeKind,
  PluginIntentCoordinator,
  PluginIntentSubmissionResult,
  RuntimeHandle,
  RuntimeUnitImplementationRegistry as WebLoomRuntimeUnitImplementationRegistry,
  ScopedTaskScheduler,
} from "webloom-framework";
import type { PluginConfigStore } from "./pluginConfigStoreContract.js";
import type { StorageBindingAuthority } from "@keymaster/contracts/storage-internal";

export { StartupCapabilityError, StartupPluginError } from "webloom-framework/advanced";

const webLoomHostByKeymasterHost = new WeakMap<object, WebLoomPluginHost>();

export interface PluginHost {
  /** Host 预注入和插件提供的能力注册表。 */
  capabilities: CapabilityRegistry;
  /** Keymaster 兼容的 MessageBus 视图。 */
  messageBus: MessageBus;
  routes: import("./registries/routeRegistry.js").RouteRegistry;
  breadcrumbs: import("./registries/breadcrumbRegistry.js").BreadcrumbRegistry;
  settings: import("./registries/settingsRegistry.js").SettingsRegistry;
  systemSettings: SystemSettingsRegistry;
  systemStatus: SystemStatusRegistry;
  vaultSettings: VaultSettingsRegistry;
  applicationSettings: ApplicationSettingsRegistry;
  home: import("./registries/homeRegistry.js").HomeRegistry;
  business: BusinessFeatureRegistry;
  commands: CommandRegistry;
  importers: ImporterRegistry;
  transfers: TransferRegistry;
  contactPublicKeyActions: ContactPublicKeyActionRegistry;
  assets: AssetRegistry;
  tokens: import("./registries/tokenRegistry.js").TokenRegistry;
  collectibles: import("./registries/collectibleRegistry.js").CollectibleRegistry;
  collectibleTransfer: import("./registries/collectibleTransferRegistry.js").CollectibleTransferRegistry;
  protectedOutpoints: import("./registries/protectedOutpointRegistry.js").ProtectedOutpointRegistry;
  topbar: TopbarRegistry;
  notice: NoticeRegistry;
  i18n: I18nService;
  /** 插件启停意图的 Keymaster 持久化视图。 */
  configStore: PluginConfigStore;
  /** 多页面唯一启停意图控制面。 */
  readonly pluginIntent?: PluginIntentCoordinator;
  /** WebLoom Resource Store 的领域兼容视图。 */
  resourceStore: ResourceStoreApi;
  installed(): string[];
  manifests(): string[];
  state(pluginId: string): PluginState;
  scope(pluginId: string): LifecycleScope | undefined;
  readonly rootScope: LifecycleScope;
  refreshRuntimeUnitSnapshots(): void;
  /** 更新 Keymaster 的 Vault/owner/session 身份，由 Adapter 转换为 Scope。 */
  transitionRuntimeIdentity(identity: RuntimeIdentityTransition): Promise<void>;
  readonly taskScheduler: ScopedTaskScheduler;
  graph(): PluginGraph;
  version(): number;
  subscribe(listener: HostListener): () => void;
  getManifest(pluginId: string): PluginManifest | undefined;
  reverseDeps(pluginId: string): PluginReverseDep[];
  register(plugin: PluginManifest): Promise<void>;
  registerAll(plugins: PluginManifest[]): Promise<void>;
  validateManifestSet(plugins: readonly PluginManifest[]): void;
  provide<C extends LocalCapability<unknown>>(key: C, value: LocalServiceOf<C>): void;
  enable(pluginId: string): Promise<void>;
  retry(pluginId: string): Promise<void>;
  submitIntent(pluginId: string, desiredEnabled: boolean): Promise<PluginIntentSubmissionResult>;
  disable(pluginId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  unregister(pluginId: string): Promise<void>;
  dispose(reason?: string): Promise<LifecycleDisposeResult>;
  assertCapabilities(capabilities: readonly CapabilityDescriptor[], options?: { phase?: string }): void;
  /** 旧插件类型保留的领域资源注册表；实现由 WebLoom Scope 绑定所有权。 */
  resourceRegistry?: ResourceRegistry;
}

/** 绑定领域 Host 对应的 WebLoom Host，供 Keymaster React Provider 建立双上下文。 */
export function bindWebLoomHost(host: PluginHost, webLoomHost: WebLoomPluginHost): void {
  webLoomHostByKeymasterHost.set(host, webLoomHost);
}

/** 取得 Adapter 内部的通用 Host；绑定缺失时必须 fail closed。 */
export function getWebLoomHost(host: PluginHost): WebLoomPluginHost {
  const webLoomHost = webLoomHostByKeymasterHost.get(host);
  if (webLoomHost) return webLoomHost;
  throw new Error("Keymaster PluginHost is not bound to a WebLoom Host");
}

export interface CreatePluginHostOptions {
  /** 页面初始 i18n 资源。 */
  initialI18nResources?: I18nPluginResources[];
  /** 是否启用 i18n 调试日志。 */
  i18nDebug?: boolean;
  /** 测试时关闭启停配置持久化。 */
  disableConfigPersistence?: boolean;
  /** 插件启停配置平台 K-V 句柄。 */
  configStorage?: KeyValueStore;
  /** 没有远程配置时使用的初始启停值。 */
  initialPluginConfig?: Record<string, boolean>;
  /** Keymaster Storage binding authority；只在 Adapter 内使用。 */
  storageBindingAuthority?: StorageBindingAuthority;
  /** 多页面唯一启停意图控制面。 */
  pluginIntentCoordinator?: PluginIntentCoordinator;
  /** 按 pluginId 注入的 Coordinator 窄接口。 */
  coordinatorForPlugin?: (pluginId: string) => unknown;
  /** 当前实例的远程服务桥。 */
  /**
   * 迁移中的运行时注入点；最终由 typed CapabilityBridge 取代。
   * 当前保留 unknown 仅用于让旧测试在编译阶段暴露迁移点，不能进入 v4
   * 适配器的生产调用路径。
   */
  serviceBridgeForPlugin?: (pluginId: string, instanceId: string) => unknown;
  /** 可信装配批准的权限。 */
  approvedPermissionsForPlugin?: (
    pluginId: string,
    requested: readonly PluginPermission[],
  ) => readonly PluginPermission[];
  /** 当前 owner/session 的额外权限约束。 */
  sessionPermissionsForPlugin?: (
    pluginId: string,
    requested: readonly PluginPermission[],
  ) => readonly PluginPermission[];
  /** 权限租约的不可替换绑定修订。 */
  permissionBindingForPlugin?: (
    pluginId: string,
    unitId: string,
    requested: readonly PluginPermission[],
  ) => Partial<Pick<PermissionLeaseBinding, "policyRevision" | "grantRevision" | "grantId">>;
  /** 当前 Host 所在执行环境。 */
  runtime?: RuntimeKind;
  /** 页面已连接的 WebLoom SharedWorker Runtime；由 Window App 投影其快照。 */
  remoteRuntime?: RuntimeHandle;
  /** Host 的初始 Vault/owner/session 身份。 */
  initialRuntimeIdentity?: RuntimeIdentityTransition;
  /** 新实例的领域身份扩展；最终变为 WebLoom Scope.attributes。 */
  lifecycleIdentityForPlugin?: (
    pluginId: string,
    unitId: string,
  ) => Partial<KeymasterScopeAttributes>;
  /** 单项清理等待上限。 */
  lifecycleCleanupTimeoutMs?: number;
  /** 远程 Coordinator 运行单元快照。 */
  runtimeUnitSnapshots?: () => readonly CoordinatorWorkerUnitSnapshot[];
  /** 当前环境的 unit setup 实现注册表。 */
  runtimeUnitImplementationRegistry?:
    | RuntimeUnitImplementationRegistry
    | WebLoomRuntimeUnitImplementationRegistry;
  /** 插件禁用后的安全导航路径。 */
  safePath?: string;
}

/** 兼容旧模块对未使用类型导入的稳定导出。 */
export type {
  AssetDataInvalidationEvent,
  AssetDataNotifier,
  ChannelRuntime,
  ChannelRuntimeFactory,
  PluginContext,
};
