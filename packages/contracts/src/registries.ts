// packages/contracts/src/registries.ts
import { defineCapability } from "webloom-framework";
import { NOTICE_REGISTRY_CAPABILITY } from "./notice.js";
import { PROTECTED_OUTPOINT_REGISTRY_CAPABILITY } from "./spendProtection.js";
// 各种 registry 的接口声明。
// 设计缘由：plugin 通过 capability 拿到这些 registry；类型契约放在 contracts，
// 实现放在 runtime。这避免 plugin 直接依赖 runtime 内部模块。

import type { AppRoute, AssetRegistry as IAssetRegistry, BreadcrumbProvider, HomeWidget, ImporterRegistry as IImporterRegistry, SettingsRoute, SystemSettingsItem, SystemStatusModule, TransferRegistry as ITransferRegistry, VaultSettingsSection } from "./index.js";
import type { TokenRegistry } from "./tokens.js";
import type { CollectibleRegistry } from "./collectibles.js";
import type { CollectibleTransferRegistry } from "./collectibleTransfer.js";
import type { TopbarRegistry as ITopbarRegistry } from "./topbar.js";
import type { BackgroundRegistry as IBackgroundRegistry, BackgroundService as IBackgroundService } from "./background.js";
import type { NoticeRecord } from "./notice.js";
import type { I18nText } from "./i18n.js";
import type { BusinessDomain, BusinessFeature, FeatureHomeProjection } from "./business.js";

/** Typed platform registry capabilities. */
export const ROUTE_REGISTRY_CAPABILITY = defineCapability<RouteRegistry>({ kind: "local", id: "route.registry", version: "1" });
export const BREADCRUMB_REGISTRY_CAPABILITY = defineCapability<BreadcrumbRegistry>({ kind: "local", id: "breadcrumb.registry", version: "1" });
export const SETTINGS_REGISTRY_CAPABILITY = defineCapability<SettingsRegistry>({ kind: "local", id: "settings.registry", version: "1" });
export const SYSTEM_SETTINGS_REGISTRY_CAPABILITY = defineCapability<SystemSettingsRegistry>({ kind: "local", id: "system-settings.registry", version: "1" });
export const SYSTEM_STATUS_REGISTRY_CAPABILITY = defineCapability<SystemStatusRegistry>({ kind: "local", id: "system-status.registry", version: "1" });
export const VAULT_SETTINGS_REGISTRY_CAPABILITY = defineCapability<VaultSettingsRegistry>({ kind: "local", id: "vault-settings.registry", version: "1" });
export const HOME_REGISTRY_CAPABILITY = defineCapability<HomeRegistry>({ kind: "local", id: "home.registry", version: "1" });
export const BUSINESS_REGISTRY_CAPABILITY = defineCapability<BusinessFeatureRegistry>({ kind: "local", id: "business.registry", version: "1" });
export const COMMAND_REGISTRY_CAPABILITY = defineCapability<CommandRegistry>({ kind: "local", id: "command.registry", version: "1" });
export const IMPORTER_REGISTRY_CAPABILITY = defineCapability<IImporterRegistry>({ kind: "local", id: "importer.registry", version: "1" });
export const TRANSFER_REGISTRY_CAPABILITY = defineCapability<ITransferRegistry>({ kind: "local", id: "transfer.registry", version: "1" });
export const ASSET_REGISTRY_CAPABILITY = defineCapability<IAssetRegistry>({ kind: "local", id: "asset.registry", version: "1" });
export const TOKEN_REGISTRY_CAPABILITY = defineCapability<TokenRegistry>({ kind: "local", id: "token.registry", version: "1" });
export const COLLECTIBLE_REGISTRY_CAPABILITY = defineCapability<CollectibleRegistry>({ kind: "local", id: "collectible.registry", version: "1" });
export const COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY = defineCapability<CollectibleTransferRegistry>({ kind: "local", id: "collectible-transfer.registry", version: "1" });
/** 与领域契约保持同一 capability 对象，避免同一身份出现两个 parser/type 入口。 */
export const PROTECTED_OUTPOINT_REGISTRY_CAPABILITY_TYPED = PROTECTED_OUTPOINT_REGISTRY_CAPABILITY;
export const NOTICE_REGISTRY_TYPED_CAPABILITY = NOTICE_REGISTRY_CAPABILITY;

export interface RouteRegistry {
  register(route: AppRoute): void;
  /** 注销已注册路由。路由不存在时抛错。 */
  unregister(id: string): void;
  list(): AppRoute[];
  byPath(path: string): AppRoute | undefined;
  byId(id: string): AppRoute | undefined;
}

export interface BreadcrumbRegistry {
  register(provider: BreadcrumbProvider): void;
  list(): BreadcrumbProvider[];
  match(path: string): BreadcrumbProvider | undefined;
}

/**
 * 设置详情页注册表（硬切换 003）。
 *
 * - 插件只能注册"独立设置详情页"（SettingsRoute）；
 * - 不再支持 registerField / listFields / 聚合 page.component 拼装；
 * - 同一路由只能由 settings.registry 一处真值，不能再同时进 route.registry。
 */
export interface SettingsRegistry {
  /** 注册一个设置详情页。id 重复时抛错。 */
  register(route: SettingsRoute): void;
  /** 注销设置详情页。id 不存在时抛错。 */
  unregister(id: string): void;
  /** 列出全部设置详情页，按 order 升序。 */
  list(): SettingsRoute[];
  /** 按 id 取详情页。 */
  byId(id: string): SettingsRoute | undefined;
  /** 按 path 取详情页（path 必须以 "/" 开头）。 */
  byPath(path: string): SettingsRoute | undefined;
}

/**
 * `/settings/system` 的设置钩子注册表。
 *
 * 每个插件项目携带自己的 group 和 order；registry 保证 id 唯一以及同一
 * group 的定义一致。页面读取 list() 后按 group/order 渲染即可。
 */
export interface SystemSettingsRegistry {
  register(item: SystemSettingsItem): void;
  unregister(id: string): void;
  list(): SystemSettingsItem[];
  _ids(): string[];
}

/** 常驻系统模块向「设置 → 广播网关」注入实时状态视图。 */
export interface SystemStatusRegistry {
  register(module: SystemStatusModule): void;
  unregister(id: string): void;
  list(): SystemStatusModule[];
  _ids(): string[];
}

/** 可选插件向「设置 → Key 管理」注入内嵌工作区。 */
export interface VaultSettingsRegistry {
  register(section: VaultSettingsSection): void;
  unregister(id: string): void;
  list(): VaultSettingsSection[];
  _ids(): string[];
}

/**
 * 首页 widget 注册表（硬切换 006）。
 *
 * - 新插件通过 manifest 的 `business.home.space` 声明业务空间；runtime 统一决定栏目归属；
 * - `slot` 只保留给旧 registry hook 兼容；
 * - registry 不承载 `size` 维度，也不提供栏目分组 API。
 */
export interface HomeRegistry {
  register(widget: HomeWidget): void;
  /** 注销已注册 widget；插件卸载时释放自己的首页挂载。 */
  unregister(id: string): void;
  list(): HomeWidget[];
}

export interface BusinessFeatureRegistry {
  register(ownerPluginId: string, domain: BusinessDomain): void;
  /** 向已存在（或稍后注册）的业务域追加一个由其它插件拥有的入口。 */
  registerFeature(ownerPluginId: string, domainId: string, feature: BusinessFeature): void;
  unregisterFeature(featureId: string): void;
  unregisterDomain(domainId: string): void;
  listDomains(): BusinessDomain[];
  listFeatures(): Array<BusinessFeature & { domainId: string; ownerPluginId: string }>;
  listHomeProjections(): Array<FeatureHomeProjection & { featureId: string; ownerPluginId: string }>;
  byOwnerPluginId(pluginId: string): BusinessDomain[];
  subscribe(handler: () => void): () => void;
  _ids(): { domains: string[]; features: string[]; projections: string[] };
}

export interface CommandDescriptor {
  id: string;
  /** 展示名。硬切换后为 I18nText。 */
  label: I18nText;
  /** 描述。硬切换后为 I18nText。 */
  description?: I18nText;
  run(): void | Promise<void>;
  enabled?(ctx: { unlocked: boolean }): boolean;
}

export interface CommandRegistry {
  register(command: CommandDescriptor): void;
  list(): CommandDescriptor[];
  get(id: string): CommandDescriptor | undefined;
  run(id: string): Promise<void>;
}

// 复用 keyImport/transfer/assets/topbar/background 的注册表接口，避免重复声明。
export type {
  IImporterRegistry as ImporterRegistryContract,
  ITransferRegistry as TransferRegistryContract,
  IAssetRegistry as AssetRegistryContract,
  ITopbarRegistry as TopbarRegistryContract
};
export type { IBackgroundRegistry as BackgroundRegistryContract, IBackgroundService as BackgroundServiceContract };

/** 全局 notice registry。 */
export interface NoticeRegistry {
  upsert(record: NoticeRecord): void;
  dismiss(id: string): void;
  list(): NoticeRecord[];
  subscribe(handler: (records: NoticeRecord[]) => void): () => void;
  /** 清理某个插件投递的全部 notice。 */
  removeBySourcePluginId(sourcePluginId: string): void;
}
