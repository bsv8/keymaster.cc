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
  HostListener,
  I18nPluginResources,
  I18nService,
  KeyspaceService,
  LogService,
  MessageBus,
  PluginContext,
  PluginGraph,
  PluginManifest,
  PluginReverseDep,
  PluginState,
  PluginStateKind,
  TopbarRegistry,
  VaultService
} from "@keymaster/contracts";
import {
  I18N_SERVICE_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  LOG_SERVICE_CAPABILITY,
  RUNTIME_MESSAGE_BUS as RUNTIME_MESSAGE_BUS_CONTRACT,
  isValidPluginEndpointIdShape
} from "@keymaster/contracts";

import { createCapabilityRegistry, type CapabilityRegistry } from "./capabilityRegistry.js";
import { createMessageBus } from "./messageBus.js";
import { createAssetRegistry, type AssetRegistry } from "./registries/assetRegistry.js";
import { createBreadcrumbRegistry, type BreadcrumbRegistry } from "./registries/breadcrumbRegistry.js";
import { createCollectibleRegistry, type CollectibleRegistry } from "./registries/collectibleRegistry.js";
import { createCollectibleTransferRegistry, type CollectibleTransferRegistry } from "./registries/collectibleTransferRegistry.js";
import { createCommandRegistry, type CommandRegistry } from "./registries/commandRegistry.js";
import { createHomeRegistry, type HomeRegistry } from "./registries/homeRegistry.js";
import { createImporterRegistry, type ImporterRegistry } from "./registries/importerRegistry.js";
import { createMenuRegistry, type MenuRegistry } from "./registries/menuRegistry.js";
import { createRouteRegistry, type RouteRegistry } from "./registries/routeRegistry.js";
import { createSettingsRegistry, type SettingsRegistry } from "./registries/settingsRegistry.js";
import { createTokenRegistry, type TokenRegistry } from "./registries/tokenRegistry.js";
import { createTopbarRegistry } from "./registries/topbarRegistry.js";
import { createTransferRegistry, type TransferRegistry } from "./registries/transferRegistry.js";
import { createI18nService } from "./i18n/createI18nService.js";
import { createLogService, type LogServiceHandle } from "./log/logService.js";
import { createPluginConfigStore } from "./pluginConfigStore.js";
import type { PluginConfigStore } from "./pluginConfigStoreContract.js";
import { buildPluginGraph, reverseDependentsOf } from "./pluginGraph.js";
import { emptyOwnership, type PluginOwnership } from "./pluginOwnership.js";

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
  menus: MenuRegistry;
  breadcrumbs: BreadcrumbRegistry;
  settings: SettingsRegistry;
  home: HomeRegistry;
  commands: CommandRegistry;
  importers: ImporterRegistry;
  transfers: TransferRegistry;
  assets: AssetRegistry;
  tokens: TokenRegistry;
  collectibles: CollectibleRegistry;
  collectibleTransfer: CollectibleTransferRegistry;
  topbar: TopbarRegistry;
  i18n: I18nService;
  /** 硬切换 002：runtime 内建 log service（统一日志平台）。 */
  log: LogService;
  /** 启停全局配置（localStorage 持久化 + storage 事件广播）。 */
  configStore: PluginConfigStore;

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
  /** 注册一个 builtin capability（语义上等同于 plugin provide）。 */
  provide<T>(key: string, value: T): void;

  // ===== 新生命周期 =====
  enable(pluginId: string): Promise<void>;
  disable(pluginId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  unregister(pluginId: string): Promise<void>;
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
}

function defaultStateFor(manifest: PluginManifest): PluginStateKind {
  return manifest.meta?.defaultEnabled ? "registered" : "registered";
}

function diffIds(before: readonly string[], after: readonly string[]): string[] {
  const set = new Set(before);
  return after.filter((id) => !set.has(id));
}

function buildOwnershipSnapshot(
  registries: {
    routes: { _ids: () => string[] };
    menus: { _ids: () => string[] };
    breadcrumbs: { _ids: () => string[] };
    settings: { _ids: () => string[] };
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
  }
) {
  return {
    routes: registries.routes._ids(),
    menus: registries.menus._ids(),
    breadcrumbs: registries.breadcrumbs._ids(),
    settingsRoutes: registries.settings._ids(),
    homeWidgets: registries.home._ids(),
    commands: registries.commands._ids(),
    importers: registries.importers._ids(),
    transferProviders: registries.transfers._ids(),
    assetProviders: registries.assets._ids(),
    tokenProviders: registries.tokens._ids(),
    collectibleProviders: registries.collectibles._ids(),
    collectibleTransferHandlers: registries.collectibleTransfer._ids(),
    topbarItems: registries.topbar._ids(),
    capabilities: registries.capabilities.keys()
  };
}

function ownershipDiff(
  before: ReturnType<typeof buildOwnershipSnapshot>,
  after: ReturnType<typeof buildOwnershipSnapshot>
): Pick<
  PluginOwnership,
  | "routes"
  | "menus"
  | "breadcrumbs"
  | "settingsRoutes"
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
> {
  return {
    routes: diffIds(before.routes, after.routes),
    menus: diffIds(before.menus, after.menus),
    breadcrumbs: diffIds(before.breadcrumbs, after.breadcrumbs),
    settingsRoutes: diffIds(before.settingsRoutes, after.settingsRoutes),
    homeWidgets: diffIds(before.homeWidgets, after.homeWidgets),
    commands: diffIds(before.commands, after.commands),
    importers: diffIds(before.importers, after.importers),
    transferProviders: diffIds(before.transferProviders, after.transferProviders),
    assetProviders: diffIds(before.assetProviders, after.assetProviders),
    tokenProviders: diffIds(before.tokenProviders, after.tokenProviders),
    collectibleProviders: diffIds(before.collectibleProviders, after.collectibleProviders),
    collectibleTransferHandlers: diffIds(before.collectibleTransferHandlers, after.collectibleTransferHandlers),
    topbarItems: diffIds(before.topbarItems, after.topbarItems),
    capabilities: diffIds(before.capabilities, after.capabilities)
  };
}

export function createPluginHost(options: CreatePluginHostOptions = {}): PluginHost {
  const capabilities = createCapabilityRegistry();
  const messageBus = createMessageBus();
  const routes = createRouteRegistry();
  const menus = createMenuRegistry();
  const breadcrumbs = createBreadcrumbRegistry();
  const settings = createSettingsRegistry();
  const home = createHomeRegistry();
  const commands = createCommandRegistry();
  const importers = createImporterRegistry();
  const transfers = createTransferRegistry();
  const assets = createAssetRegistry();
  const tokens = createTokenRegistry();
  const collectibles = createCollectibleRegistry();
  const collectibleTransfer = createCollectibleTransferRegistry();
  const topbar = createTopbarRegistry();
  const i18n = createI18nService({
    initialResources: options.initialI18nResources,
    debug: options.i18nDebug
  });

  const logService: LogServiceHandle = createLogService();

  // 把内置 registry + messageBus + i18n + log 暴露成 capability。
  capabilities.provide<RouteRegistry>("route.registry", routes);
  capabilities.provide<MenuRegistry>("menu.registry", menus);
  capabilities.provide<BreadcrumbRegistry>("breadcrumb.registry", breadcrumbs);
  capabilities.provide<SettingsRegistry>("settings.registry", settings);
  capabilities.provide<HomeRegistry>("home.registry", home);
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
  capabilities.provide<MessageBus>(RUNTIME_MESSAGE_BUS, messageBus);
  capabilities.provide<I18nService>(I18N_SERVICE_CAPABILITY, i18n);
  capabilities.provide<LogService>(LOG_SERVICE_CAPABILITY, logService);

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

  function buildContext(record: PluginRecord): PluginContext {
    return {
      provide: (k, v) => capabilities.provide(k, v),
      get: (k) => capabilities.get(k),
      has: (k) => capabilities.has(k),
      require: (k) => capabilities.require(k),
      messageBus,
      logger: logService.forPlugin(record.manifest.id)
    };
  }

  function snapshotOwnership() {
    return buildOwnershipSnapshot({
      routes,
      menus,
      breadcrumbs,
      settings,
      home,
      commands,
      importers,
      transfers,
      assets,
      tokens,
      collectibles,
      collectibleTransfer,
      topbar,
      capabilities
    });
  }

  function registerCapabilitiesFor(record: PluginRecord): void {
    for (const cap of record.manifest.meta?.providesCapabilities ?? []) {
      if (capabilities.has(cap)) {
        continue;
      }
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

  function purgeOwnership(ownership: PluginOwnership): void {
    const errors: unknown[] = [];
    function safe(fn: () => void, name: string) {
      try {
        fn();
      } catch (err) {
        errors.push({ name, err });
      }
    }
    for (const id of ownership.topbarItems) safe(() => topbar.unregister(id), `topbar:${id}`);
    for (const id of ownership.routes) safe(() => routes.unregister(id), `route:${id}`);
    for (const id of ownership.menus) safe(() => menus.unregister(id), `menu:${id}`);
    for (const id of ownership.homeWidgets) safe(() => home.unregister(id), `home:${id}`);
    for (const id of ownership.settingsRoutes)
      safe(() => settings.unregister(id), `settingsRoute:${id}`);
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
    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.error("[pluginHost] purgeOwnership errors", errors);
    }
  }

  async function runTeardown(ownership: PluginOwnership): Promise<unknown> {
    if (!ownership.teardown) return undefined;
    try {
      return await ownership.teardown();
    } catch (err) {
      return err;
    }
  }

  const host: PluginHost = {
    capabilities,
    messageBus,
    routes,
    menus,
    breadcrumbs,
    settings,
    home,
    commands,
    importers,
    transfers,
    assets,
    tokens,
    collectibles,
    collectibleTransfer,
    topbar,
    i18n,
    log: logService,
    configStore,

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
      capabilities.provide(key, value);
      // 硬切换 2026-07-04 001：不再因 vault / keyspace 注入触发
      // scoped client 刷新——runtime 已不持有消息业务生命周期。
    },

    async register(plugin) {
      if (knownManifests.has(plugin.id)) {
        knownManifests.set(plugin.id, plugin);
        return;
      }
      knownManifests.set(plugin.id, plugin);
      records.set(plugin.id, {
        manifest: plugin,
        state: defaultStateFor(plugin),
        ownership: emptyOwnership()
      });
      const snapshot = configStore.read();
      let shouldEnable: boolean;
      if (plugin.id in snapshot) {
        shouldEnable = Boolean(snapshot[plugin.id]);
      } else {
        shouldEnable = plugin.meta?.defaultEnabled ?? false;
      }
      if (shouldEnable) {
        try {
          await host.enable(plugin.id);
        } catch (err) {
          const r = records.get(plugin.id);
          if (r) {
            const msg = err instanceof Error ? err.message : String(err);
            r.error = msg;
            if (r.state !== "blocked") {
              r.state = "error-disabled";
            }
          }
        }
      }
    },

    async registerAll(plugins) {
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
        const ownership = record.ownership;
        purgeOwnership(ownership);
        i18n.unregisterResources(record.manifest.id);
        record.ownership = emptyOwnership();
        if (appMsgEp) {
          appMessageEndpointIds.delete(appMsgEp.endpointId);
        }
        record.state = "error-disabled";
        record.error = err instanceof Error ? err.message : String(err);
        configStore.setEnabled(pluginId, false);
        bumpVersion();
        throw err;
      }
    },

    async disable(pluginId) {
      const record = records.get(pluginId);
      if (!record) {
        return { ok: false, reason: `Plugin "${pluginId}" is not registered` };
      }
      if (record.state !== "enabled") {
        configStore.setEnabled(pluginId, false);
        return { ok: true };
      }
      if (record.manifest.meta?.canDisable === false) {
        return { ok: false, reason: "Plugin is marked canDisable=false" };
      }
      const rev = host.reverseDeps(pluginId);
      if (rev.length > 0) {
        return {
          ok: false,
          reason: `Blocked by enabled dependents: ${rev.map((d) => d.pluginId).join(", ")}`
        };
      }
      safeNavigateAway(pluginId);
      const teardownErr = await runTeardown(record.ownership);
      purgeOwnership(record.ownership);
      i18n.unregisterResources(record.manifest.id);
      if (record.manifest.appMessageEndpoint) {
        appMessageEndpointIds.delete(record.manifest.appMessageEndpoint.endpointId);
      }
      enabledSet.delete(pluginId);
      if (teardownErr) {
        record.state = "error-disabled";
        record.error = teardownErr instanceof Error ? teardownErr.message : String(teardownErr);
        logService.append({
          level: "error",
          pluginId: RUNTIME_SYSTEM_PLUGIN_ID,
          scope: "plugin-host",
          event: "teardown.failed",
          message: `Plugin teardown failed: ${pluginId}`,
          data: { pluginId },
          error: {
            name: teardownErr instanceof Error ? teardownErr.name : "Error",
            message: teardownErr instanceof Error ? teardownErr.message : String(teardownErr)
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
      records.delete(pluginId);
      knownManifests.delete(pluginId);
      enabledSet.delete(pluginId);
      bumpVersion();
    }
  };

  // 订阅 config store 变化（多标签页同步）。
  configStore.subscribe((snap) => {
    for (const [id, record] of records) {
      const want = snap[id] ?? record.manifest.meta?.defaultEnabled ?? false;
      const isEnabled = record.state === "enabled";
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