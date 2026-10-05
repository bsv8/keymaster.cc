// Keymaster Host 的领域兼容契约。
//
// 生命周期、Scope、权限和服务桥的实现都在 WebLoom；此文件只保留
// Keymaster shell 仍需要的领域 Registry、i18n、Storage 和 Coordinator
// 视图。这样旧调用者可以平滑切换到 Adapter，而不会在这里再出现 Host 状态机。

import type {
  AssetDataInvalidationEvent,
  AssetDataNotifier,
  ChannelRuntime,
  ChannelRuntimeFactory,
  CoordinatorWorkerUnitSnapshot,
  HostListener,
  I18nPluginResources,
  I18nService,
  PluginContext,
  PluginGraph,
  PluginManifest,
  PluginPermission,
  PluginReverseDep,
  PluginState,
  ResourceRegistry,
  RuntimeIdentityTransition,
  RuntimeUnitImplementationRegistry,
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
import type { LifecycleDisposeResult, LifecycleScope, MessageBus, PermissionLeaseBinding, RuntimeKind, RuntimeHandle, RuntimeUnitImplementationRegistry as WebLoomRuntimeUnitImplementationRegistry, ScopedTaskScheduler } from "webloom-framework";
import type {} from "@keymaster/contracts/storage-internal";

export { StartupCapabilityError, StartupPluginError } from "webloom-framework/advanced";

const webLoomHostByKeymasterHost = new WeakMap<object, WebLoomPluginHost>();

export interface PluginHost {
  /** Host 预注入和插件提供的能力注册表。 */
  capabilities: CapabilityRegistry;
  /** Keymaster 兼容的 MessageBus 视图。 */
  messageBus: MessageBus;
  i18n: I18nService;
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
  retry(pluginId: string): Promise<void>;
  revoke(pluginId: string, reason: string): Promise<void>;
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
  /** Explicit trusted assembly capabilities; domain registries are provided by plugins. */
  capabilities?: import("webloom-framework/advanced").HostCapabilityRegistration[];
  /** 只由可信装配登记的私有能力授权。 */
  privateCapabilities?: NonNullable<Parameters<typeof import("webloom-framework/advanced").createPluginHost>[0]>["privateCapabilities"];
  /** 可信装配维护的运行单元/能力来源槽位。 */
  runtimeSlotBindings?: NonNullable<Parameters<typeof import("webloom-framework/advanced").createPluginHost>[0]>["runtimeSlotBindings"];
  /** 页面初始 i18n 资源。 */
  initialI18nResources?: I18nPluginResources[];
  /** 是否启用 i18n 调试日志。 */
  i18nDebug?: boolean;
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
  /** 可信装配登记的多个物理 Worker 槽位；来源由 runtimeSlotBindings 明确指定。 */
  remoteRuntimes?: Readonly<Record<string, RuntimeHandle>>;
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
}

/** 兼容旧模块对未使用类型导入的稳定导出。 */
export type {
  AssetDataInvalidationEvent,
  AssetDataNotifier,
  ChannelRuntime,
  ChannelRuntimeFactory,
  PluginContext,
};
