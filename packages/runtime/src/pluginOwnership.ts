// packages/runtime/src/pluginOwnership.ts
// 插件 ownership 记录：每个 plugin 在 setup 期间向 host 注册的"owner 资源"。
// 设计缘由（硬切换 001）：
//   - 不要求旧插件手写"我注册了哪些 route / menu / capability"。
//   - host 在 setup 前后对全部 registry 做快照 diff，把新增资源归属到当前 plugin。
//   - disable 时按 ownership record 反向注销。
//   - 这条设计保证对旧插件零侵入。

import type {
  AssetProvider,
  BreadcrumbProvider,
  CommandDescriptor,
  HomeWidget,
  KeyImporter,
  MenuItem,
  SettingsField,
  SettingsPage,
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
  /** settings page ids。 */
  settingsPages: string[];
  /** settings field ids。 */
  settingsFields: string[];
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
    settingsPages: [],
    settingsFields: [],
    homeWidgets: [],
    commands: [],
    importers: [],
    transferProviders: [],
    assetProviders: [],
    topbarItems: [],
    teardown: undefined
  };
}

// 类型保留为契约引用，避免 import 死代码。
export type {
  AssetProvider,
  BreadcrumbProvider,
  CommandDescriptor,
  HomeWidget,
  KeyImporter,
  MenuItem,
  SettingsField,
  SettingsPage,
  TopbarItem,
  TransferProvider
};
