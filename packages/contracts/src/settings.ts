// packages/contracts/src/settings.ts
// 设置契约（硬切换 003）：
//   settings.registry 只注册"设置详情页"，不再承载聚合页 section / 字段拼装。
//   每个设置详情页是一条独立路由；由新业务导航决定其用户可见入口。
//
// 设计缘由：
//   - 设置详情页本质就是一类受约束的应用路由（自带 path / label / component）。
//   - 不再允许"业务插件把字段塞进一个聚合 /settings 页面"——这种语义本身
//     已经被本硬切换废除。
//   - 真值单源：每个设置详情页只能进 settings.registry，不能再同时进
//     route.registry。

import type { ComponentType } from "react";
import type { I18nText } from "./i18n.js";

/**
 * 系统设置页的可扩展项目。
 *
 * 插件通过 `system-settings.registry` 把自己的设置钩入 `/settings/system`。
 * group 是一个稳定的扩展点：相同 group id 的项目会归到同一组，分别按
 * group.order 与 item.order 排序。
 */
export interface SystemSettingsItem {
  /** 全局唯一、带插件命名空间的项目 id，例如 "woc.system-settings"。 */
  id: string;
  group: {
    /** 稳定 group id，例如 "woc"。 */
    id: string;
    label: I18nText;
    order: number;
  };
  /** 项目标题；同组有多个项目时用于区分。 */
  label: I18nText;
  description?: I18nText;
  component: ComponentType;
  /** 组内排序，越小越靠前。 */
  order: number;
  /**
   * 被本系统设置项迁移替代的旧 settings.registry route id。
   * shell 使用它从旧「设置」菜单隐藏重复入口，支持逐项迁移。
   */
  replacesSettingsRouteId?: string;
  visibleWhen?: (ctx: { unlocked: boolean }) => boolean;
}

/** 由常驻系统模块注入到「设置 → 系统状态」的实时状态视图。 */
export interface SystemStatusModule {
  /** 全局唯一、带模块命名空间的 id。 */
  id: string;
  /** 模块原有的可直达状态路径，例如 `/system/broadcast`。 */
  path: string;
  label: I18nText;
  description?: I18nText;
  component: ComponentType;
  order: number;
}

/**
 * Key 管理页的可扩展工作区。
 *
 * 可选插件可通过 `vault-settings.registry` 将与 Key 生命周期相关的操作嵌入
 * `/settings/vault`，而不是新增独立页面或菜单入口。
 */
export interface VaultSettingsSection {
  /** 全局唯一、带插件命名空间的 section id。 */
  id: string;
  label: I18nText;
  description?: I18nText;
  component: ComponentType;
  order: number;
}

/** 「设置 → 应用设置」中的一个应用入口。 */
export interface ApplicationSettingsItem {
  /** 全局唯一、带插件命名空间的应用设置 id。 */
  id: string;
  /** 应用设置详情页路径，由应用插件注册为隐藏路由。 */
  path: string;
  label: I18nText;
  description?: I18nText;
  icon?: string;
  order: number;
}

/**
 * 设置详情页描述。
 *
 * 严格字段：
 *   - id：唯一 id，使用命名空间，例如 "poker.settings"。
 *   - path：路由路径，必须以 "/" 开头；详情页自带的真值路径。
 *   - label：菜单 / 页面标题 / 面包屑首段之外的位置都可能用到；硬切换后是 I18nText。
 *   - description：可选页内描述（用于页面副标题等位置），不参与菜单。
 *   - component：渲染该设置详情页的 React 组件。
 *   - order：菜单 / 路由匹配中的排序，越小越靠前。
 *   - icon：可选菜单图标（lucide-react icon name）。
 *   - visibleWhen：可见性策略；缺省永远可见；shell 调用此函数决定侧边栏
 *                  是否展示该菜单项。
 */
export interface SettingsRoute {
  /** page id，使用命名空间。 */
  id: string;
  /** 路由路径，必须以 "/" 开头，例如 "/settings/apps/poker"。 */
  path: string;
  /** 菜单 / 页面标题。硬切换后为 I18nText。 */
  label: I18nText;
  /** 页内描述（可选）。 */
  description?: I18nText;
  /** 整页 React 组件。 */
  component: ComponentType;
  /** 排序，越小越靠前。 */
  order: number;
  /** 菜单图标（lucide-react icon name），可选。 */
  icon?: string;
  /** 可见性策略；缺省永远可见。 */
  visibleWhen?: (ctx: { unlocked: boolean }) => boolean;
}

// SettingsRegistry 在 registries.ts 中统一声明。
export type { SettingsRegistry } from "./registries.js";
export type { SystemSettingsRegistry } from "./registries.js";
export type { SystemStatusRegistry } from "./registries.js";
export type { VaultSettingsRegistry } from "./registries.js";
export type { ApplicationSettingsRegistry } from "./registries.js";
