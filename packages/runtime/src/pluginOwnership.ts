// packages/runtime/src/pluginOwnership.ts
// 插件 ownership 记录：每个 plugin 在 setup 期间向 host 注册的"owner 资源"。
// 设计缘由（硬切换 001）：
//   - 不要求旧插件手写"我注册了哪些 route / menu / capability"。
//   - host 在 setup 前后对全部 registry 做快照 diff，把新增资源归属到当前 plugin。
//   - disable 时按 ownership record 反向注销。
//   - 这条设计保证对旧插件零侵入。
//
// 硬切换 003：settingsPages / settingsFields 收敛成单一 settingsRoutes。

import type {
  AssetProvider,
  BreadcrumbProvider,
  CollectibleProvider,
  CollectibleTransferHandler,
  CommandDescriptor,
  HomeWidget,
  KeyImporter,
  MenuItem,
  SettingsRoute,
  TokenProvider,
  TopbarItem,
  TransferProvider
} from "@keymaster/contracts";

export interface PluginOwnership {
  /** capability keys 该 plugin 提供的。 */
  capabilities: string[];
  /** route ids 该 plugin 注册的。 */
  routes: string[];
  /** menu ids。 */
  menus: string[];
  /** breadcrumb provider ids。 */
  breadcrumbs: string[];
  /** settings detail page ids（硬切换 003：单一 settings 资源）。 */
  settingsRoutes: string[];
  /** home widget ids。 */
  homeWidgets: string[];
  /** command ids。 */
  commands: string[];
  /** importer ids。 */
  importers: string[];
  /** transfer provider ids。 */
  transferProviders: string[];
  /** asset provider ids。 */
  assetProviders: string[];
  /** token provider ids。 */
  tokenProviders: string[];
  /** collectible provider ids。 */
  collectibleProviders: string[];
  /** collectible transfer handler ids。 */
  collectibleTransferHandlers: string[];
  /** topbar item ids。 */
  topbarItems: string[];
  /** 该 plugin 的 teardown。空实现 = 无资源。 */
  teardown: (() => void | Promise<void>) | undefined;
}

export function emptyOwnership(): PluginOwnership {
  return {
    capabilities: [],
    routes: [],
    menus: [],
    breadcrumbs: [],
    settingsRoutes: [],
    homeWidgets: [],
    commands: [],
    importers: [],
    transferProviders: [],
    assetProviders: [],
    tokenProviders: [],
    collectibleProviders: [],
    collectibleTransferHandlers: [],
    topbarItems: [],
    teardown: undefined
  };
}

// 类型保留为契约引用，避免 import 死代码。
export type {
  AssetProvider,
  BreadcrumbProvider,
  CollectibleProvider,
  CollectibleTransferHandler,
  CommandDescriptor,
  HomeWidget,
  KeyImporter,
  MenuItem,
  SettingsRoute,
  TokenProvider,
  TopbarItem,
  TransferProvider
};
