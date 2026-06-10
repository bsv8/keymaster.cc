// packages/runtime/src/createPluginHost.ts
// 插件宿主：初始化内置 registry、组装 capability + messageBus、调度 setup 生命周期。
// 设计缘由：把所有插件的"协作通道"集中在这一个对象上，
// 业务插件只能看到 PluginContext，看不到 host 内部状态。
//
// UI 扩展点（route/menu/breadcrumb/settings/home/command/asset/transfer/importer/topbar）
// 以及 messageBus 都以 capability 形式对外暴露。

import type {
  I18nPluginResources,
  I18nService,
  KeyspaceService,
  MessageBus,
  PluginContext,
  PluginManifest,
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
  installed(): string[];
  register(plugin: PluginManifest): Promise<void>;
  registerAll(plugins: PluginManifest[]): Promise<void>;
  /** 注册一个 builtin capability（语义上等同于 plugin provide）。 */
  provide<T>(key: string, value: T): void;
}

const RUNTIME_MESSAGE_BUS = RUNTIME_MESSAGE_BUS_CONTRACT;
const TOPBAR_REGISTRY_CAPABILITY = "topbar.registry";

/** runtime messageBus capability key；重新导出以便 manifest 集中引用。 */
export { RUNTIME_MESSAGE_BUS };

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

  const installed: string[] = [];

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
    installed() {
      return [...installed];
    },
    provide(key, value) {
      capabilities.provide(key, value);
    },
    async register(plugin) {
      // 依赖检查：必须在 setup 前就成立，避免半初始化。
      for (const dep of plugin.dependencies ?? []) {
        if (!capabilities.has(dep.capability)) {
          throw new Error(
            `Plugin "${plugin.id}" requires missing capability "${dep.capability}"${dep.reason ? `: ${dep.reason}` : ""}`
          );
        }
      }

      // 硬切换 003：插件 i18n 资源必须在 setup 前注入，
      // 这样 plugin.setup 里注册 route / menu / settings 时引用的 i18n key
      // 才能命中（不会回退到 fallback）。plugin 仍可以通过 ctx.get("i18n.service")
      // 拿到 service 引用以做运行时翻译，但资源注册由 runtime 统一处理。
      if (plugin.i18n) {
        i18n.registerResources(plugin.id, plugin.i18n);
      }

      const ctx: PluginContext = {
        provide: (k, v) => capabilities.provide(k, v),
        get: (k) => capabilities.get(k),
        has: (k) => capabilities.has(k),
        require: (k) => capabilities.require(k),
        messageBus
      };

      await plugin.setup(ctx);
      // 硬切换 007：插件在 setup 中声明 keyScopedStorages 后，runtime 自动调用
      // keyspace.registerPluginStorage，让 keyspace.deleteKey 能找到要删除的 DB。
      // 必须放在 setup 之后——plugin 可能需要在 setup 内已建立自己的 keyspace 能力
      // 关联（如果 plugin 自己作为 keyspace 提供方，runtime 不能覆盖）。
      if (plugin.keyScopedStorages && plugin.keyScopedStorages.length > 0) {
        if (capabilities.has(KEYSPACE_SERVICE_CAPABILITY)) {
          const keyspace = capabilities.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
          for (const decl of plugin.keyScopedStorages) {
            keyspace.registerPluginStorage({
              pluginId: plugin.id,
              storageId: decl.storageId
            });
          }
        }
      }
      installed.push(plugin.id);
    },
    async registerAll(plugins) {
      for (const plugin of plugins) {
        await host.register(plugin);
      }
    }
  };

  return host;
}

// 抑制未使用告警：WocService 在 contract 中由 plugin-woc 重新导出。
void (null as unknown as WocService);
