// packages/contracts/src/home.ts
// 首页契约：插件通过 homeRegistry 注册首页 widget。

import type { ComponentType } from "react";
import type { I18nText } from "./i18n.js";

/** widget 尺寸，决定首页栅格。 */
export type HomeWidgetSize = "sm" | "md" | "lg";

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
  /** 排序，越小越靠前。 */
  order: number;
  /** 栅格尺寸。 */
  size: HomeWidgetSize;
  /** 刷新策略提示（用于 UI 提示 stale）。 */
  refreshHint?: "realtime" | "manual";
}

// HomeRegistry 在 registries.ts 中统一声明。
export type { HomeRegistry } from "./registries.js";
