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
  RUNTIME_MESSAGE_BUS as RUNTIME_MESSAGE_BUS_CONTRACT
} from "@keymaster/contracts";
import { assertSystemStorageDeclaration, validatePluginStorageDeclaration, type PluginStorageDeclaration } from "@keymaster/contracts";
import type { ChannelRuntimeFactory } from "@keymaster/contracts";
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
import { buildPluginGraph, reverseDependentsOf } from "./pluginGraph.js";
import { emptyOwnership, type PluginOwnership } from "./pluginOwnership.js";
import { createResourceRegistry, registerOwnedResource } from "./resources/resourceRegistry.js";
import { createResourceStore, type ResourceStoreApi } from "./resources/resourceStore.js";
import { createProtectedOutpointRegistry, type ProtectedOutpointRegistry } from "./registries/protectedOutpointRegistry.js";

const RUNTIME_MESSAGE_BUS = RUNTIME_MESSAGE_BUS_CONTRACT;
const TOPBAR_REGISTRY_CAPABILITY = "topbar.registry";

/** 硬切换 002：runtime 系统日志统一使用的 pluginId。 */
const RUNTIME_SYSTEM_PLUGIN_ID = "runtime";

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
  /** 硬切换 003：资源存储（React 读业务数据、订阅业务数据变更的唯一框架入口）。 */
  resourceStore: ResourceStoreApi;

  // ===== 查询 / 旧兼容 =====
  installed(): string[];
  manifests(): string[];
  state(pluginId: string): PluginState;
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
  disable(pluginId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  unregister(pluginId: string): Promise<void>;
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
  /**
   * 由应用装配层按 manifest.id 生成插件专属 Coordinator 面。
   * runtime 不理解各业务 RPC，也不会把一个通用 client 注入所有插件。
   */
  coordinatorForPlugin?: (pluginId: string) => unknown;
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
}

function defaultStateFor(manifest: PluginManifest): PluginStateKind {
  return "registered";
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
  const safePath = options.safePath ?? "/settings/plugins";

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

  function recordState(id: string): PluginState {
    const r = records.get(id);
    if (!r) return { id, kind: "registered" };
    return { id, kind: r.state, error: r.error };
  }

  function provideCapability<T>(key: string, value: T): void {
    capabilities.provide(key, value);
    resourceStore.refreshRuntimeBindings();
  }

  function buildContext(record: PluginRecord, storage?: KeyValueStore): PluginContext {
    const ownerResourceRegistry: ResourceRegistry = {
      register: (definition) => registerOwnedResource(resourceRegistry, record.manifest.id, definition),
      unregister: (id) => resourceRegistry.unregister(id),
      get: (id) => resourceRegistry.get(id),
      _ids: () => resourceRegistry._ids(),
    };
    const pluginChannelFactory = (): ChannelRuntimeFactory | undefined => {
      if (!capabilities.has(CHANNEL_RUNTIME_CAPABILITY)) return undefined;
      const raw = capabilities.get<ChannelRuntimeFactory>(CHANNEL_RUNTIME_CAPABILITY);
      return {
        // 这里忽略插件传入的字符串，始终绑定 manifest.id。
        forPlugin: (_claimedPluginId: string) => raw.forPlugin(record.manifest.id),
        // system caller 只能由 Host/Coordinator 内部创建，插件 context 不开放。
        forSystem: (_claimedSystemId: string) => {
          throw new Error("Plugin context cannot create a system Channel caller");
        }
      };
    };
    return {
      pluginId: record.manifest.id,
      onDispose: (cleanup) => { record.disposeCallbacks.push(cleanup); },
      provide: (k, v) => provideCapability(k, v),
      get: (k) => k === RESOURCE_REGISTRY_CAPABILITY
        ? ownerResourceRegistry as any
        : k === CHANNEL_RUNTIME_CAPABILITY
          ? pluginChannelFactory() as any
          : capabilities.get(k),
      has: (k) => capabilities.has(k),
      require: (k) => k === RESOURCE_REGISTRY_CAPABILITY
        ? ownerResourceRegistry as any
        : k === CHANNEL_RUNTIME_CAPABILITY
          ? pluginChannelFactory() as any
          : capabilities.require(k),
      messageBus,
      logger: logService.forPlugin(record.manifest.id),
      // 2026-07-08 001 硬切换：plugin 作者通过 `manifest.config` 注入的
      // 强类型配置真值；缺省 = `{}`，插件对每个字段自处理缺值降级。
      config: record.manifest.config ?? {},
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

  function createDeferredOwnerAppStore(authority: StorageBindingAuthority, record: PluginRecord, declaration: PluginStorageDeclaration): KeyValueStore {
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
    async function resolve(): Promise<KeyValueStore> {
      if (closed) throw new Error("Owner storage handle is closed");
      const activeOwnerPublicKeyHex = authority.getActivePublicKeyHex?.()?.toLowerCase();
      const ownerChanged = authority.getActivePublicKeyHex !== undefined
        && (!activeOwnerPublicKeyHex || ownerPublicKeyHex !== activeOwnerPublicKeyHex);
      if (!current || !ownerPublicKeyHex || ownerChanged || bucketGeneration !== current.bucketGeneration) {
        invalidateCurrent();
        current = await authority.openOwnerAppStore({ pluginId: record.manifest.id, declaration });
        ownerPublicKeyHex = current.ownerPublicKeyHex;
        bucketGeneration = current.bucketGeneration;
      }
      return current;
    }
    const run = async <T>(operation: (store: KeyValueStore) => Promise<T>): Promise<T> => {
      const store = await resolve();
      try {
        return await operation(store);
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
    const declaration = record.manifest.storage;
    if (!declaration) return undefined;
    const authority = options.storageBindingAuthority ?? (capabilities.has("storage.binding-authority")
      ? capabilities.get<StorageBindingAuthority>("storage.binding-authority")
      : undefined);
    if (!authority) throw new Error(`Plugin "${record.manifest.id}" requires the storage binding authority`);
    if (declaration.scope === "platform") {
      return authority.openPlatformStore({ pluginId: record.manifest.id, applicationStorageId: declaration.applicationStorageId, schemaVersion: declaration.schemaVersion });
    }
    return createDeferredOwnerAppStore(authority, record, declaration);
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

  function registerCapabilitiesFor(record: PluginRecord): void {
    for (const cap of record.manifest.meta?.providesCapabilities ?? []) {
      if (capabilities.has(cap)) {
        continue;
      }
    }
  }

  function isStartupRequired(manifest: PluginManifest): boolean {
    return manifest.meta.startup === "required";
  }

  function validateManifest(plugin: PluginManifest, manifestSet?: readonly PluginManifest[]): void {
    const meta = plugin.meta;
    const declarations = plugin.storage ? [plugin.storage] : [];
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
      if (!meta.providesCapabilities?.length) throw new Error(`Required plugin "${plugin.id}" must provide capabilities`);
      for (const dep of plugin.dependencies ?? []) {
        const provider = (manifestSet ?? [...knownManifests.values()]).find((m) => m.meta.providesCapabilities?.includes(dep.capability));
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

  async function runSetup(record: PluginRecord, storage?: KeyValueStore): Promise<void> {
    const before = snapshotOwnership();
    let teardownFn: (() => void | Promise<void>) | undefined;
    try {
      const result = record.manifest.setup(buildContext(record, storage));
      teardownFn = (await Promise.resolve(result)) as
        | (() => void | Promise<void>)
        | undefined;
      registerBusinessContribution(record.manifest.id, record.manifest.business);
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
    for (const id of ownership.resourceDefinitions)
      safe(() => resourceRegistry.unregister(id), `resource:${id}`);
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

  const host: PluginHost = {
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

    assertCapabilities(requiredCapabilities, options = {}) {
      const missing: StartupCapabilityErrorDetails[] = [];
      for (const capability of requiredCapabilities) {
        if (capabilities.has(capability)) continue;
        const provider = [...knownManifests.values()].find((m) => m.meta.providesCapabilities?.includes(capability));
        const state = provider ? recordState(provider.id) : undefined;
        missing.push({
          capability,
          providerPluginId: provider?.id,
          providerState: state?.kind,
          providerError: state?.error,
          configuredEnabled: provider ? configStore.read()[provider.id] : undefined
        });
      }
      if (missing.length) throw new StartupCapabilityError(missing, options.phase);
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
    graph() {
      return buildPluginGraph([...knownManifests.values()]);
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
    },

    async register(plugin) {
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
                capabilities: plugin.meta.providesCapabilities ?? [],
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
      const snapshot = configStore.read();
      // `canDisable=false` is also an always-on contract. A stale persisted
      // false value must not turn a system plugin into a silently missing
      // route/capability on the next boot.
      const immutable = plugin.meta.canDisable === false;
      const shouldEnable = required || immutable
        ? true
        : plugin.id in snapshot
          ? Boolean(snapshot[plugin.id])
          : plugin.meta.defaultEnabled;
      if (shouldEnable) {
        try {
          await host.enable(plugin.id);
        } catch (err) {
          const r = records.get(plugin.id);
          if (r) {
            const msg = err instanceof Error ? err.message : String(err);
            r.error = msg;
            if (r.state !== "blocked" && !required) {
              r.state = "error-disabled";
            }
          }
          if (required) {
            throw new StartupPluginError({
              pluginId: plugin.id,
              capabilities: plugin.meta.providesCapabilities ?? [],
              state: r?.state ?? "error-disabled",
              error: r?.error
            });
          }
        }
      }
    },

    async registerAll(plugins) {
      host.validateManifestSet(plugins);
      configStore.setRequiredPluginIds(
        plugins.filter((plugin) => isStartupRequired(plugin)).map((plugin) => plugin.id)
      );
      for (const plugin of plugins) {
        await host.register(plugin);
      }
    },

    async enable(pluginId) {
      if (enablingPluginIds.has(pluginId)) return;
      enablingPluginIds.add(pluginId);
      try {
        return await (async () => {
      const record = records.get(pluginId);
      if (!record) {
        throw new Error(`Plugin "${pluginId}" is not registered`);
      }
      if (record.state === "enabled") return;
      for (const dep of record.manifest.dependencies ?? []) {
        if (!capabilities.has(dep.capability)) {
          record.state = "blocked";
          throw new Error(
            `Plugin "${pluginId}" requires missing capability "${dep.capability}"${dep.reason ? `: ${dep.reason}` : ""}`
          );
        }
      }
      if (record.manifest.i18n) {
        i18n.registerResources(record.manifest.id, record.manifest.i18n);
      }
      enabledSet.add(pluginId);
      registerCapabilitiesFor(record);
      let storage: KeyValueStore | undefined;
      try {
        storage = await bindManifestStorage(record);
        await runSetup(record, storage);
        const declared = record.manifest.meta.providesCapabilities ?? [];
        const owned = new Set(record.ownership.capabilities);
        const missing = declared.filter((cap) => !owned.has(cap));
        if (missing.length) throw new Error(`Plugin "${pluginId}" did not provide declared capabilities: ${missing.join(", ")}`);
        record.state = "enabled";
        record.error = undefined;
        configStore.setEnabled(pluginId, true);
        logService.append({
          level: "info",
          pluginId: RUNTIME_SYSTEM_PLUGIN_ID,
          scope: "plugin-host",
          event: "plugin.enabled",
          message: `Plugin enabled: ${pluginId}`,
          data: { pluginId }
        });
        bumpVersion();
      } catch (err) {
        enabledSet.delete(pluginId);
        storage?.close();
        await runDisposeCallbacks(record);
        const ownership = record.ownership;
        purgeOwnership(ownership, pluginId);
        purgePluginNotices(record.manifest.id);
        i18n.unregisterResources(record.manifest.id);
        record.ownership = emptyOwnership();
        record.state = "error-disabled";
        record.error = err instanceof Error ? err.message : String(err);
        if (!isStartupRequired(record.manifest)) configStore.setEnabled(pluginId, false);
        bumpVersion();
        throw err;
      }
        })();
      } finally {
        enablingPluginIds.delete(pluginId);
      }
    },

    async retry(pluginId) {
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

    async disable(pluginId) {
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
      if (record.state !== "enabled") {
        configStore.setEnabled(pluginId, false);
        return { ok: true };
      }
      const rev = host.reverseDeps(pluginId);
      if (rev.length > 0) {
        return {
          ok: false,
          reason: `Blocked by enabled dependents: ${rev.map((d) => d.pluginId).join(", ")}`
        };
      }
      safeNavigateAway(pluginId);
      const disposeErr = await runDisposeCallbacks(record);
      const teardownErr = await runTeardown(record.ownership);
      purgeOwnership(record.ownership, pluginId);
      purgePluginNotices(pluginId);
      i18n.unregisterResources(record.manifest.id);
      enabledSet.delete(pluginId);
      if (teardownErr || disposeErr) {
        record.state = "error-disabled";
        const lifecycleErr = disposeErr ?? teardownErr;
        record.error = lifecycleErr instanceof Error ? lifecycleErr.message : String(lifecycleErr);
        logService.append({
          level: "error",
          pluginId: RUNTIME_SYSTEM_PLUGIN_ID,
          scope: "plugin-host",
          event: "teardown.failed",
          message: `Plugin teardown failed: ${pluginId}`,
          data: { pluginId },
          error: {
            name: lifecycleErr instanceof Error ? lifecycleErr.name : "Error",
            message: lifecycleErr instanceof Error ? lifecycleErr.message : String(lifecycleErr)
          }
        });
      } else {
        record.state = "disabled";
        record.error = undefined;
        logService.append({
          level: "info",
          pluginId: RUNTIME_SYSTEM_PLUGIN_ID,
          scope: "plugin-host",
          event: "plugin.disabled",
          message: `Plugin disabled: ${pluginId}`,
          data: { pluginId }
        });
      }
      record.ownership = emptyOwnership();
      configStore.setEnabled(pluginId, false);
      bumpVersion();
      return { ok: true };
    },

    async unregister(pluginId) {
      const record = records.get(pluginId);
      if (!record) return;
      if (isStartupRequired(record.manifest)) {
        throw new Error(`Cannot unregister startup-required plugin "${pluginId}"`);
      }
      if (record.state === "enabled") {
        const r = await host.disable(pluginId);
        if (!r.ok) {
          throw new Error(`Cannot unregister "${pluginId}": ${r.reason}`);
        }
      }
      const m = records.get(pluginId);
      if (m?.manifest.i18n) {
        i18n.unregisterResources(m.manifest.id);
      }
      purgePluginNotices(pluginId);
      records.delete(pluginId);
      knownManifests.delete(pluginId);
      enabledSet.delete(pluginId);
      bumpVersion();
    }
  };

  // 订阅 config store 变化（多标签页同步）。
  configStore.subscribe((snap) => {
    for (const [id, record] of records) {
      const isEnabled = record.state === "enabled";
      // Ignore stale or cross-tab attempts to disable immutable core plugins.
      // Rewriting the value also repairs the persisted configuration for the
      // next page load. Do not retry a plugin already in an error state here:
      // its next normal bootstrap remains the recovery boundary.
      const immutable = record.manifest.meta.canDisable === false;
      if ((isStartupRequired(record.manifest) || immutable) && !snap[id]) {
        configStore.setEnabled(id, true);
        continue;
      }
      const want = isStartupRequired(record.manifest) || immutable
        ? true
        : snap[id] ?? record.manifest.meta.defaultEnabled;
      if (want && !isEnabled) {
        // setup 失败的不可禁用插件留在 error-disabled，等待显式重试；
        // 不能在每次其它插件写配置时无限重试并递归 setup。
        if (record.state === "error-disabled") continue;
        void host.enable(id).catch(() => {
          /* ignore: 留给 UI 显示错误 */
        });
      } else if (!want && isEnabled) {
        void host.disable(id);
      }
    }
  });

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
