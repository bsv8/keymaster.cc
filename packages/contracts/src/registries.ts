// packages/contracts/src/registries.ts
// 各种 registry 的接口声明。
// 设计缘由：plugin 通过 capability 拿到这些 registry；类型契约放在 contracts，
// 实现放在 runtime。这避免 plugin 直接依赖 runtime 内部模块。

import type { AppRoute, AssetRegistry as IAssetRegistry, BreadcrumbProvider, HomeWidget, ImporterRegistry as IImporterRegistry, MenuItem, SettingsRoute, TransferRegistry as ITransferRegistry } from "./index.js";
import type { TopbarRegistry as ITopbarRegistry } from "./topbar.js";
import type { BackgroundRegistry as IBackgroundRegistry, BackgroundService as IBackgroundService } from "./background.js";
import type { I18nText } from "./i18n.js";

export interface RouteRegistry {
  register(route: AppRoute): void;
  list(): AppRoute[];
  byPath(path: string): AppRoute | undefined;
  byId(id: string): AppRoute | undefined;
}

export interface MenuRegistry {
  register(item: MenuItem): void;
  list(): MenuItem[];
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
 * - 同一路由只能由 settings.registry 一处真值，不能再同时进
 *   route.registry / menu.registry。
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
 * 首页 widget 注册表（硬切换 006）。
 *
 * - 插件只能通过 `slot: "main" | "aside"` 显式声明首页栏目归属；
 * - registry 不再承载 `size` 维度，也不再提供栏目分组 API；
 * - 栏目分组属于页面渲染职责（plugin-home / HomePage），不属于注册表职责。
 */
export interface HomeRegistry {
  register(widget: HomeWidget): void;
  list(): HomeWidget[];
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
