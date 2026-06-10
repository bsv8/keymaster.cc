// packages/contracts/src/navigation.ts
// 导航契约：route / menu / breadcrumb 的最小协议。
// 插件通过 routeRegistry/menuRegistry/breadcrumbRegistry 自行接入。

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
  /** 是否出现在菜单中（默认 true）。 */
  inMenu?: boolean;
  /** 菜单分组 id。 */
  menuGroup?: string;
  /** 在菜单中的排序，越小越靠前。 */
  order?: number;
  /** 图标名（lucide-react icon name），可选。 */
  icon?: string;
}

/** 侧边栏/顶部导航菜单条目。 */
export interface MenuItem {
  /** 唯一 id，使用命名空间。 */
  id: string;
  /**
   * 展示名。menu.label 同样硬切换为 I18nText；与 route.label 一致，
   * 渲染层用 i18n.text() 取值。
   */
  label: I18nText;
  /** 关联的 route id（点击跳转用）。 */
  routeId?: string;
  /** 直接给出 path。 */
  path?: string;
  /**
   * 菜单分组 id。
   * 设计缘由：group 当前不直接作为展示文案，仅做排序分类键；
   * 未来若要把 group 名也展示出来，必须走 I18nText 而不是 string。
   */
  group: string;
  /** 排序，越小越靠前。 */
  order: number;
  /** 图标名（lucide-react icon name）。 */
  icon?: string;
  /** 是否当前可见的判断函数。 */
  visibleWhen?: (ctx: { unlocked: boolean }) => boolean;
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
