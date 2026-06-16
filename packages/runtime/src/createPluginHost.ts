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

import type {
  HostListener,
  I18nPluginResources,
  I18nService,
  KeyspaceService,
  MessageBus,
  PluginContext,
  PluginGraph,
  PluginManifest,
  PluginReverseDep,
  PluginState,
  PluginStateKind,
  TopbarRegistry,
  WocService
} from "@keymaster/contracts";
import {
  I18N_SERVICE_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  RUNTIME_MESSAGE_BUS as RUNTIME_MESSAGE_BUS_CONTRACT
} from "@keymaster/contracts";
import { createCapabilityRegistry, type CapabilityRegistry } from "./capabilityRegistry.js";
import { createMessageBus } from "./messageBus.js";
import { createAssetRegistry, type AssetRegistry } from "./registries/assetRegistry.js";
import { createBreadcrumbRegistry, type BreadcrumbRegistry } from "./registries/breadcrumbRegistry.js";
import { createCommandRegistry, type CommandRegistry } from "./registries/commandRegistry.js";
import { createHomeRegistry, type HomeRegistry } from "./registries/homeRegistry.js";
import { createImporterRegistry, type ImporterRegistry } from "./registries/importerRegistry.js";
import { createMenuRegistry, type MenuRegistry } from "./registries/menuRegistry.js";
import { createRouteRegistry, type RouteRegistry } from "./registries/routeRegistry.js";
import { createSettingsRegistry, type SettingsRegistry } from "./registries/settingsRegistry.js";
import { createTopbarRegistry } from "./registries/topbarRegistry.js";
import { createTransferRegistry, type TransferRegistry } from "./registries/transferRegistry.js";
import { createI18nService } from "./i18n/createI18nService.js";
import { createPluginConfigStore } from "./pluginConfigStore.js";
import type { PluginConfigStore } from "./pluginConfigStoreContract.js";
import { buildPluginGraph, reverseDependentsOf } from "./pluginGraph.js";
import { emptyOwnership, type PluginOwnership } from "./pluginOwnership.js";

const RUNTIME_MESSAGE_BUS = RUNTIME_MESSAGE_BUS_CONTRACT;
const TOPBAR_REGISTRY_CAPABILITY = "topbar.registry";

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
  topbar: TopbarRegistry;
  i18n: I18nService;
  /** 启停全局配置（localStorage 持久化 + storage 事件广播）。 */
  configStore: PluginConfigStore;

  // ===== 查询 / 旧兼容 =====
  /** 兼容旧 API：返回当前 enabled 的 plugin id 列表。 */
  installed(): string[];
  /** 列出所有已知 manifest id。 */
  manifests(): string[];
  /** 单个 plugin 当前状态。 */
  state(pluginId: string): PluginState;
  /** 推导依赖图。 */
  graph(): PluginGraph;
  /** 当前 host version（每次 enable / disable / unregister 递增）。 */
  version(): number;
  /** 订阅 host 变化（version / state）。返回 unsubscribe。 */
  subscribe(listener: HostListener): () => void;
  /** 取某 plugin 的 manifest（bootstrap 时注册的）。 */
  getManifest(pluginId: string): PluginManifest | undefined;
  /** 反向依赖该 plugin 的启用中插件。 */
  reverseDeps(pluginId: string): PluginReverseDep[];

  // ===== 旧 register 流程 =====
  /** 把 plugin manifest 加入"已知集合"，按 config store 决定是否自动 enable。 */
  register(plugin: PluginManifest): Promise<void>;
  registerAll(plugins: PluginManifest[]): Promise<void>;
  /** 注册一个 builtin capability（语义上等同于 plugin provide）。 */
  provide<T>(key: string, value: T): void;

  // ===== 新生命周期 =====
  /** 启用一个已 registered 的 plugin。 */
  enable(pluginId: string): Promise<void>;
  /**
   * 禁用一个 plugin：调 teardown，回收 owner，反向依赖阻止策略。
   * 失败原因：被其它 enabled 插件依赖 / canDisable=false / 当前 route 属于该 plugin。
   */
  disable(pluginId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 从 host 彻底移除（已 disabled 之后或强制）。 */
  unregister(pluginId: string): Promise<void>;
}

export interface CreatePluginHostOptions {
  /**
   * 启动前注入到 i18n service 的额外资源（apps/web 用）。
   * 必须在 plugin 注册前可用；这里注入后再创建 host。
   */
  initialI18nResources?: I18nPluginResources[];
  /**
   * 启动 i18n service 时是否打印缺 key warning。
   * 默认 false（与 i18next 默认行为一致）。
   */
  i18nDebug?: boolean;
  /**
   * 测试用：禁用 config store 写盘与 storage 事件订阅。
   */
  disableConfigPersistence?: boolean;
  /**
   * 可选：覆盖"跳到安全页"的默认目标；默认 /settings/plugins。
   * 用于在卸载前先把用户从目标 plugin 页面带离。
   */
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
    topbarItems: registries.topbar._ids(),
    capabilities: registries.capabilities.keys()
  };
}

function ownershipDiff(
  before: ReturnType<typeof buildOwnershipSnapshot>,
  after: ReturnType<typeof buildOwnershipSnapshot>
): Pick<
  PluginOwnership,
  "routes" | "menus" | "breadcrumbs" | "settingsRoutes" | "homeWidgets" | "commands" | "importers" | "transferProviders" | "assetProviders" | "topbarItems" | "capabilities"
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
  const topbar = createTopbarRegistry();
  // i18n service 必须在 plugin 注册前完成初始化：
  //   - host 创建时立即 provide "i18n.service" capability；
  //   - plugin setup 可能引用 plugin.i18n 资源对应的 i18n key，资源
  //     必须在 setup 前可用，否则注册时回退到 fallback。
  // 插件注册流程在 host.register 内强制为：依赖检查 -> 注册 plugin.i18n 资源 -> 执行 setup。
  const i18n = createI18nService({
    initialResources: options.initialI18nResources,
    debug: options.i18nDebug
  });

  // 把内置 registry + messageBus + i18n 暴露成 capability。
  capabilities.provide<RouteRegistry>("route.registry", routes);
  capabilities.provide<MenuRegistry>("menu.registry", menus);
  capabilities.provide<BreadcrumbRegistry>("breadcrumb.registry", breadcrumbs);
  capabilities.provide<SettingsRegistry>("settings.registry", settings);
  capabilities.provide<HomeRegistry>("home.registry", home);
  capabilities.provide<CommandRegistry>("command.registry", commands);
  capabilities.provide<ImporterRegistry>("importer.registry", importers);
  capabilities.provide<TransferRegistry>("transfer.registry", transfers);
  capabilities.provide<AssetRegistry>("asset.registry", assets);
  capabilities.provide<TopbarRegistry>(TOPBAR_REGISTRY_CAPABILITY, topbar);
  capabilities.provide<MessageBus>(RUNTIME_MESSAGE_BUS, messageBus);
  capabilities.provide<I18nService>(I18N_SERVICE_CAPABILITY, i18n);

  // 硬切换 003：注入 route.registry 的 path 探测函数。
  // settings.registry 在 register 时会调用这个 probe，避免同一 path 同时
  // 由 settings.registry 与 route.registry 各注册一份导致双渲染真值。
  // 用 byPath 而非 list + 精确比对，保证与 RouteRenderer 的"先 route 后
  // settings"匹配顺序一致：若已经在 route.registry，settings.register 必须抛错。
  settings.setRoutePathProbe((path) => routes.byPath(path) !== undefined);

  const configStore = createPluginConfigStore({ readOnly: options.disableConfigPersistence });

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

  function buildContext(record: PluginRecord): PluginContext {
    return {
      provide: (k, v) => capabilities.provide(k, v),
      get: (k) => capabilities.get(k),
      has: (k) => capabilities.has(k),
      require: (k) => capabilities.require(k),
      messageBus
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
      topbar,
      capabilities
    });
  }

  function registerCapabilitiesFor(record: PluginRecord): void {
    for (const cap of record.manifest.meta?.providesCapabilities ?? []) {
      if (capabilities.has(cap)) {
        // 已有（host 内置或同 plugin 之前已注册）：跳过
        continue;
      }
      // 占位：plugin 在 setup 中通常会再 provide 覆盖；
      // 我们不强制 require plugin 在 setup 之外也要 provide，留出"声明"语义。
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
      // 硬切换 001：setup 中途抛错时，**已经注册的资源**仍要被回收。
      // 先做 post-snapshot（即使 throw 也会经过这里），diff 出来后保存，
      // 然后再 re-throw，让上层（enable / register 入口）走错误处理。
      const after = snapshotOwnership();
      const diff = ownershipDiff(before, after);
      record.ownership = {
        ...emptyOwnership(),
        ...diff,
        teardown: undefined
      };
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
      // 业务路由：owner 拥有的 route ids 中的 path 必须能命中当前路径。
      const routeIds = r.ownership.routes;
      for (const rid of routeIds) {
        const route = routes.byId(rid);
        if (!route) continue;
        if (route.path === path || matchPath(route.path, path)) {
          return pluginId;
        }
      }
      // 设置详情页（硬切换 003）：settings.registry 的 path 是设置详情页的真值；
      // 用户停留在 /settings/<plugin> 时，宿主必须能识别"当前页面属于该插件"，
      // 才能在 disable 时先跳离到安全页，避免渲染崩溃。
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

  // simple prefix matcher for routes that include ":param"
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
    // 顺序：先注销"展示层"（route / menu / home / settings / breadcrumb / topbar），
    // 再注销 service 层（command / importer / transfer / asset），最后 revoke capability。
    // 即便某步抛错，宿主继续走完清理。
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
    for (const id of ownership.settingsRoutes) safe(() => settings.unregister(id), `settingsRoute:${id}`);
    for (const id of ownership.breadcrumbs) safe(() => breadcrumbs.unregister(id), `breadcrumb:${id}`);
    for (const id of ownership.commands) safe(() => commands.unregister(id), `command:${id}`);
    for (const id of ownership.importers) safe(() => importers.unregister(id), `importer:${id}`);
    for (const id of ownership.transferProviders) safe(() => transfers.unregister(id), `transfer:${id}`);
    for (const id of ownership.assetProviders) safe(() => assets.unregister(id), `asset:${id}`);
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
    topbar,
    i18n,
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
    },

    async register(plugin) {
      if (knownManifests.has(plugin.id)) {
        // 重复 register：覆盖 manifest 但不重新触发 setup；调用方应使用 enable/disable。
        knownManifests.set(plugin.id, plugin);
        return;
      }
      knownManifests.set(plugin.id, plugin);
      records.set(plugin.id, {
        manifest: plugin,
        state: defaultStateFor(plugin),
        ownership: emptyOwnership()
      });
      // 根据 config store 决定初始 enabled。
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
            // enable 内部已把 state 设为 "blocked"（依赖缺失）或保持 enabled。
            // 这里只在非 blocked 时降级为 error-disabled。
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
      // 依赖检查：依赖的 capability 必须都已存在（由其它 enabled plugin 或 host builtin 提供）
      for (const dep of record.manifest.dependencies ?? []) {
        if (!capabilities.has(dep.capability)) {
          record.state = "blocked";
          throw new Error(
            `Plugin "${pluginId}" requires missing capability "${dep.capability}"${dep.reason ? `: ${dep.reason}` : ""}`
          );
        }
      }
      // 注册 i18n 资源（幂等；i18n service 内部按 pluginId 跟踪）
      if (record.manifest.i18n) {
        i18n.registerResources(record.manifest.id, record.manifest.i18n);
      }
      // 标记 enabled 在 setup 之前——内部 enable 顺序内的 capability 引用（同一个 plugin
      // 内部的 provide + get）允许出现在 setup 期间。
      enabledSet.add(pluginId);
      registerCapabilitiesFor(record);
      try {
        await runSetup(record);
        // 装载 keyspace storage 声明
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
        bumpVersion();
      } catch (err) {
        // 回滚：把 setup 中已经产生的 owner 资源全部回收。
        enabledSet.delete(pluginId);
        const ownership = record.ownership;
        purgeOwnership(ownership);
        i18n.unregisterResources(record.manifest.id);
        record.ownership = emptyOwnership();
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
        // 已 disabled / blocked / error-disabled：noop，但写回 store 保证一致。
        configStore.setEnabled(pluginId, false);
        return { ok: true };
      }
      // canDisable 守门
      if (record.manifest.meta?.canDisable === false) {
        return { ok: false, reason: "Plugin is marked canDisable=false" };
      }
      // 反向依赖：只阻断"启用中"的反向依赖；不级联 disable。
      const rev = host.reverseDeps(pluginId);
      if (rev.length > 0) {
        return {
          ok: false,
          reason: `Blocked by enabled dependents: ${rev.map((d) => d.pluginId).join(", ")}`
        };
      }
      // 跳走当前路由
      safeNavigateAway(pluginId);
      // 调 teardown；捕获错误但仍继续回收。
      const teardownErr = await runTeardown(record.ownership);
      purgeOwnership(record.ownership);
      i18n.unregisterResources(record.manifest.id);
      enabledSet.delete(pluginId);
      if (teardownErr) {
        record.state = "error-disabled";
        record.error = teardownErr instanceof Error ? teardownErr.message : String(teardownErr);
      } else {
        record.state = "disabled";
        record.error = undefined;
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
          // 阻止 unregister 的原因
          throw new Error(`Cannot unregister "${pluginId}": ${r.reason}`);
        }
      }
      // host 内部彻底移除该 plugin 实例
      const m = records.get(pluginId);
      if (m?.manifest.i18n) {
        // 重复调用 unregisterResources 是 no-op
        i18n.unregisterResources(m.manifest.id);
      }
      records.delete(pluginId);
      knownManifests.delete(pluginId);
      enabledSet.delete(pluginId);
      // config store 不删除——下次 bootstrap 时残留 id 会被忽略。
      bumpVersion();
    }
  };

  // 订阅 config store 变化（多标签页同步）：其它标签页改 config 时，本标签也
  // 跟随 enable / disable。
  configStore.subscribe((snap) => {
    for (const [id, record] of records) {
      const want = snap[id] ?? record.manifest.meta?.defaultEnabled ?? false;
      const isEnabled = record.state === "enabled";
      if (want && !isEnabled) {
        // 依赖可能尚未满足，跳过由 host.enable 自己抛错
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

// 抑制未使用告警：WocService 在 contract 中由 plugin-woc 重新导出。
void (null as unknown as WocService);
