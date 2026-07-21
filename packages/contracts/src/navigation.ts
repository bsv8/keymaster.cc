// packages/contracts/src/navigation.ts
// 导航契约：route / breadcrumb 的最小协议。
// 用户可见菜单由 business.registry 的 domain / feature 声明统一提供。

import type { ComponentType } from "react";
import type { I18nText } from "./i18n.js";

/** 应用路由描述。 */
export interface AppRoute {
  /** 唯一 id，使用命名空间，例如 "p2pkh.overview"。 */
  id: string;
  /** 路由路径，必须以 "/" 开头。 */
  path: string;
  /**
   * 展示名。
   * 设计缘由：硬切换后 route.label 改为 I18nText；语义仍是"展示标签"，
   * 只是值从 string 扩展为可翻译描述，渲染层走 i18n.text(...)。
   */
  label: I18nText;
  /** 路由要渲染的 React 组件。 */
  component: ComponentType;
}

/** 面包屑节点。 */
export interface BreadcrumbItem {
  /**
   * 显示文本。breadcrumb.label 同样硬切换为 I18nText；动态资源名
   * （联系人名、key 标签）允许走 `{ key, fallback, values }` 把动态值
   * 拼到翻译里，但 i18n key 必须稳定。
   */
  label: I18nText;
  /** 关联的 path（可点击跳转）。 */
  path?: string;
}

/** 面包屑 provider：插件实现，按当前 path 产出面包屑节点。 */
export interface BreadcrumbProvider {
  /** provider id，使用命名空间。 */
  id: string;
  /** 排序，越小越靠前。 */
  order: number;
  /** 判断该 provider 是否要处理当前 path。 */
  match(path: string): boolean;
  /** 解析面包屑，动态资源名（key 标签、联系人名等）必须在这里 resolve。 */
  resolve(path: string): Promise<BreadcrumbItem[]> | BreadcrumbItem[];
}
