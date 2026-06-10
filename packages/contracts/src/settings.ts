// packages/contracts/src/settings.ts
// 设置契约：plugin-settings 是平台，业务插件注册 SettingsPage / SettingsField。

import type { ComponentType } from "react";
import type { I18nText } from "./i18n.js";

/** 设置字段类型。 */
export type SettingsFieldKind = "text" | "number" | "boolean" | "select";

/** 设置字段描述。 */
export interface SettingsField {
  /** 字段 id，使用命名空间，例如 "p2pkh.wocBaseUrl"。 */
  id: string;
  /**
   * 展示标签。硬切换后为 I18nText。
   * 渲染层统一用 i18n.text(field.label) 解析。
   */
  label: I18nText;
  /** 帮助文本。 */
  description?: I18nText;
  /** 字段类型。 */
  kind: SettingsFieldKind;
  /**
   * select 选项。
   * `value` 保持稳定 code，不做本地化；`label` 改用 I18nText。
   * 设计缘由：option 标签通常是多语言的（"是/否"、语言名等），按
   * I18nText 表达后切换语言时立即重渲染。
   */
  options?: Array<{ label: I18nText; value: string }>;
  /** 默认值（稳定 code，不翻译）。 */
  defaultValue?: string | number | boolean;
  /** 读取当前值。 */
  getValue(): Promise<string | number | boolean | undefined>;
  /** 写入值。 */
  setValue(value: string | number | boolean): Promise<void>;
}

/** 设置页：业务插件可以提供整页设置视图。 */
export interface SettingsPage {
  /** page id，使用命名空间。 */
  id: string;
  /** 展示名。 */
  label: I18nText;
  /** 描述。 */
  description?: I18nText;
  /** 关联的字段。 */
  fields: SettingsField[];
  /** 整页 React 组件（可选，提供后会用 component 渲染）。 */
  component?: ComponentType;
  /** 排序，越小越靠前。 */
  order: number;
}

// SettingsRegistry 在 registries.ts 中统一声明。
export type { SettingsRegistry } from "./registries.js";
