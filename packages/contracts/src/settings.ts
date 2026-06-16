// packages/contracts/src/settings.ts
// 设置契约（硬切换 003）：
//   settings.registry 只注册"设置详情页"，不再承载聚合页 section / 字段拼装。
//   每个设置详情页是一条独立路由；shell 直接消费 settings.registry 列表来
//   生成侧边栏 settings 分组与详情页路由匹配。
//
// 设计缘由：
//   - 设置详情页本质就是一类受约束的应用路由（自带 path / label / component）。
//   - 不再允许"业务插件把字段塞进一个聚合 /settings 页面"——这种语义本身
//     已经被本硬切换废除。
//   - 真值单源：每个设置详情页只能进 settings.registry，不能再同时进
//     route.registry / menu.registry。

import type { ComponentType } from "react";
import type { I18nText } from "./i18n.js";

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
  /** 路由路径，必须以 "/" 开头，例如 "/settings/poker"。 */
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
