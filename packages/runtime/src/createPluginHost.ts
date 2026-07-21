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
// 硬切换 2026-07-04 001（施工单）：runtime 删除消息专用生命周期。
//   - 不再监听 keyspace / vault owner 变化、不再注入
//     `<pluginId>.appmsg.client` capability、不再调用
//     `appmsg.core.createMessageScopedClient(...)`；
//   - 业务消息的 owner / provider / endpoint service 迁移由
//     plugin-appmsg 内部持有；
//   - runtime 只保留通用装配能力：manifest 元数据校验、registry /
//     capability 通用装配、endpoint shape 校验 + 唯一性校验。

import type {
  AssetDataInvalidationEvent,
  AssetDataNotifier,
  HostListener,
  I18nPluginResources,
  I18nService,
  KeyspaceService,
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
  RUNTIME_MESSAGE_BUS as RUNTIME_MESSAGE_BUS_CONTRACT,
  isValidPluginEndpointIdShape
} from "@keymaster/contracts";

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
import { createI18nService } from "./i18n/createI18nService.js";
import { createLogService, type LogServiceHandle } from "./log/logService.js";
import { createPluginConfigStore } from "./pluginConfigStore.js";
import type { PluginConfigStore } from "./pluginConfigStoreContract.js";
import { buildPluginGraph, reverseDependentsOf } from "./pluginGraph.js";
import { emptyOwnership, type PluginOwnership } from "./pluginOwnership.js";
import { createResourceRegistry, registerOwnedResource } from "./resources/resourceRegistry.js";
import { createResourceStore, type ResourceStoreApi } from "./resources/resourceStore.js";

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
  assets: AssetRegistry;
  tokens: TokenRegistry;
  collectibles: CollectibleRegistry;
  collectibleTransfer: CollectibleTransferRegistry;
  topbar: TopbarRegistry;
  notice: NoticeRegistry;
  i18n: I18nService;
  /** 硬切换 002：runtime 内建 log service（统一日志平台）。 */
  log: LogService;
  /** 启停全局配置（localStorage 持久化 + storage 事件广播）。 */
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
  safePath?: string;
}

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
    assets: { _ids: () => string[] };
    tokens: { _ids: () => string[] };
    collectibles: { _ids: () => string[] };
    collectibleTransfer: { _ids: () => string[] };
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
    assetProviders: registries.assets._ids(),
    tokenProviders: registries.tokens._ids(),
    collectibleProviders: registries.collectibles._ids(),
    collectibleTransferHandlers: registries.collectibleTransfer._ids(),
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
  const assets = createAssetRegistry();
  const tokens = createTokenRegistry();
  const collectibles = createCollectibleRegistry();
  const collectibleTransfer = createCollectibleTransferRegistry();
  const topbar = createTopbarRegistry();
  const notice = createNoticeRegistry();
  const i18n = createI18nService({
    initialResources: options.initialI18nResources,
    debug: options.i18nDebug
  });

  const logService: LogServiceHandle = createLogService();

  /**
   * 资产数据变更通知器。
   * 设计缘由：统一本 tab pub/sub 与跨 tab BroadcastChannel 失效通知。
   * 后台任务原子提交 provider DB 后发布此事件，页面收到后只重读本地 DB。
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
  capabilities.provide<AssetRegistry>("asset.registry", assets);
  capabilities.provide<TokenRegistry>("token.registry", tokens);
  capabilities.provide<CollectibleRegistry>("collectible.registry", collectibles);
  capabilities.provide<CollectibleTransferRegistry>(
    "collectible-transfer.registry",
    collectibleTransfer
  );
  capabilities.provide<TopbarRegistry>(TOPBAR_REGISTRY_CAPABILITY, topbar);
  capabilities.provide<NoticeRegistry>("notice.registry", notice);
  capabilities.provide<MessageBus>(RUNTIME_MESSAGE_BUS, messageBus);
  capabilities.provide<I18nService>(I18N_SERVICE_CAPABILITY, i18n);
  capabilities.provide<LogService>(LOG_SERVICE_CAPABILITY, logService);
  capabilities.provide<AssetDataNotifier>(ASSET_DATA_NOTIFIER_CAPABILITY, assetDataNotifier);
  capabilities.provide<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY, resourceRegistry);

  // route.registry path 探测，避免 settings.registry 与 route.registry 双渲染。
  settings.setRoutePathProbe((path) => routes.byPath(path) !== undefined);

  const configStore = createPluginConfigStore({ readOnly: options.disableConfigPersistence });

  const knownManifests = new Map<string, PluginManifest>();
  const records = new Map<string, PluginRecord>();
  const enabledSet = new Set<string>();
  /**
   * 已声明的 pluginEndpointId 集合。
   *
   * enable 阶段填：endpointId 形状合法 + 全局唯一才允许写入。
   * disable 阶段同步删除，避免"插件 disable 后还能 inject 一个
   * 同 id 的 plugin"导致的孤儿 endpoint 占用。
   *
   * 硬切换 2026-07-04 001：**不**再用于 runtime 注入 scoped client
   * capability——只是用于形状 + 唯一性校验。
   */
  const appMessageEndpointIds = new Set<string>();
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

  function buildContext(record: PluginRecord): PluginContext {
    const ownerResourceRegistry: ResourceRegistry = {
      register: (definition) => registerOwnedResource(resourceRegistry, record.manifest.id, definition),
      unregister: (id) => resourceRegistry.unregister(id),
      get: (id) => resourceRegistry.get(id),
      _ids: () => resourceRegistry._ids(),
    };
    return {
      onDispose: (cleanup) => { record.disposeCallbacks.push(cleanup); },
      provide: (k, v) => provideCapability(k, v),
      get: (k) => k === RESOURCE_REGISTRY_CAPABILITY
        ? ownerResourceRegistry as any
        : capabilities.get(k),
      has: (k) => capabilities.has(k),
      require: (k) => k === RESOURCE_REGISTRY_CAPABILITY
        ? ownerResourceRegistry as any
        : capabilities.require(k),
      messageBus,
      logger: logService.forPlugin(record.manifest.id),
      // 2026-07-08 001 硬切换：plugin 作者通过 `manifest.config` 注入的
      // 强类型配置真值；缺省 = `{}`，插件对每个字段自处理缺值降级。
      config: record.manifest.config ?? {}
    };
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
      assets,
      tokens,
      collectibles,
      collectibleTransfer,
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

  async function runSetup(record: PluginRecord): Promise<void> {
    const before = snapshotOwnership();
    let teardownFn: (() => void | Promise<void>) | undefined;
    try {
      const result = record.manifest.setup(buildContext(record));
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
    for (const id of ownership.assetProviders)
      safe(() => assets.unregister(id), `asset:${id}`);
    for (const id of ownership.tokenProviders) safe(() => tokens.unregister(id), `token:${id}`);
    for (const id of ownership.collectibleProviders)
      safe(() => collectibles.unregister(id), `collectible:${id}`);
    for (const id of ownership.collectibleTransferHandlers)
      safe(() => collectibleTransfer.unregister(id), `collectibleTransfer:${id}`);
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
    assets,
    tokens,
    collectibles,
    collectibleTransfer,
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
      // 硬切换 2026-07-04 001：manifest.appMessageEndpoint 仅做形状 +
      // 唯一性校验；**不**注入任何 scoped client capability。
      const appMsgEp = record.manifest.appMessageEndpoint;
      if (appMsgEp) {
        if (!isValidPluginEndpointIdShape(appMsgEp.endpointId)) {
          record.state = "blocked";
          throw new Error(
            `Plugin "${pluginId}": appMessageEndpoint.endpointId "${appMsgEp.endpointId}" is not a valid pluginEndpointId shape`
          );
        }
        if (appMessageEndpointIds.has(appMsgEp.endpointId)) {
          record.state = "blocked";
          throw new Error(
            `Plugin "${pluginId}": appMessageEndpoint.endpointId "${appMsgEp.endpointId}" already registered by another plugin`
          );
        }
        appMessageEndpointIds.add(appMsgEp.endpointId);
      }
      if (record.manifest.i18n) {
        i18n.registerResources(record.manifest.id, record.manifest.i18n);
      }
      enabledSet.add(pluginId);
      registerCapabilitiesFor(record);
      try {
        await runSetup(record);
        const declared = record.manifest.meta.providesCapabilities ?? [];
        const owned = new Set(record.ownership.capabilities);
        const missing = declared.filter((cap) => !owned.has(cap));
        if (missing.length) throw new Error(`Plugin "${pluginId}" did not provide declared capabilities: ${missing.join(", ")}`);
        if (record.manifest.keyScopedStorages && record.manifest.keyScopedStorages.length > 0) {
          if (capabilities.has(KEYSPACE_SERVICE_CAPABILITY)) {
            const keyspace = capabilities.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
            for (const decl of record.manifest.keyScopedStorages) {
              keyspace.registerPluginStorage({
                pluginId: record.manifest.id,
                storageId: decl.storageId
              });
            }
          }
        }
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
        await runDisposeCallbacks(record);
        const ownership = record.ownership;
        purgeOwnership(ownership, pluginId);
        purgePluginNotices(record.manifest.id);
        i18n.unregisterResources(record.manifest.id);
        record.ownership = emptyOwnership();
        if (appMsgEp) {
          appMessageEndpointIds.delete(appMsgEp.endpointId);
        }
        record.state = "error-disabled";
        record.error = err instanceof Error ? err.message : String(err);
        if (!isStartupRequired(record.manifest)) configStore.setEnabled(pluginId, false);
        bumpVersion();
        throw err;
      }
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
      if (record.manifest.appMessageEndpoint) {
        appMessageEndpointIds.delete(record.manifest.appMessageEndpoint.endpointId);
      }
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
 * 后台任务原子提交 provider DB 后发布此事件，页面收到后只重读本地 DB。
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
