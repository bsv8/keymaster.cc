// packages/contracts/src/topbar.ts
// Topbar 扩展点契约。
// 设计缘由：Shell 渲染 Topbar 时只读 topbar.registry，不直接 import 任何插件。
// 任何插件都可以注册图标/按钮/小面板，runtime 负责按 order 排序并渲染。

import type { ComponentType } from "react";
import type { I18nText } from "./i18n.js";

/** Topbar 扩展项。 */
export interface TopbarItem {
  /** 唯一 id，使用命名空间。 */
  id: string;
  /** 展示名（用于无障碍/工具提示）。硬切换后为 I18nText。 */
  label: I18nText;
  /** 渲染的 React 组件。 */
  component: ComponentType;
  /** 排序，越小越靠左。 */
  order?: number;
}

/** 注册表接口。 */
export interface TopbarRegistry {
  register(item: TopbarItem): void;
  list(): TopbarItem[];
}

/** capability key。 */
export const TOPBAR_REGISTRY_CAPABILITY = "topbar.registry";
