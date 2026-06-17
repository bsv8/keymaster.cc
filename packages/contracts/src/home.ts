// packages/contracts/src/home.ts
// 首页契约：插件通过 homeRegistry 注册首页 widget。
// 硬切换 006：首页栏目归属真值。
//   - main: 首页主业务栏，宽度自适应撑满；
//   - aside: 首页辅助栏，固定窄宽（CSS 320px）。
//   - 首页挂载插件必须显式声明栏目归属，registry 不再承载 size 维度。
//   - 旧 HomeWidgetSize 已被删除，size 不再是首页布局真值。

import type { ComponentType } from "react";
import type { I18nText } from "./i18n.js";

/** 首页栏目归属。 */
export type HomeWidgetSlot = "main" | "aside";

/** 首页 widget 描述。 */
export interface HomeWidget {
  /** 唯一 id，使用命名空间，例如 "p2pkh.balance"。 */
  id: string;
  /**
   * 展示标题。硬切换后为 I18nText，渲染层用 i18n.text() 解析。
   */
  title: I18nText;
  /** widget 组件。 */
  component: ComponentType;
  /** 栏目内排序，越小越靠前。 */
  order: number;
  /**
   * 栏目归属：main 为主业务栏，aside 为辅助栏。
   * 渲染层按 slot 分组后再按 order 升序排列。
   * 必填：插件作者必须显式声明，不允许宿主推断。
   */
  slot: HomeWidgetSlot;
  /** 刷新策略提示（用于 UI 提示 stale）。 */
  refreshHint?: "realtime" | "manual";
}

// HomeRegistry 在 registries.ts 中统一声明。
export type { HomeRegistry } from "./registries.js";
