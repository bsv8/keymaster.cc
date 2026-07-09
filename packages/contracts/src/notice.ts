// 全局紧急通知契约。
//
// 设计缘由：
//   - notice 是 shell/runtime 级通用能力，不属于某个业务插件；
//   - 只承载结构化文本 + 按钮动作，不允许业务插件直接塞 JSX；
//   - run() 只保留在当前内存态里，不做跨刷新持久化。

import type { I18nText } from "./i18n.js";

/** 单条结构化 notice。 */
export interface NoticeRecord {
  /** notice 真值主键；同 id 再次 upsert 表示覆盖更新。 */
  id: string;
  /** 来源插件 id，仅用于诊断与卸载清理。 */
  sourcePluginId: string;
  /** 优先级，越大越靠前。 */
  priority: number;
  /** 标题。 */
  title: I18nText;
  /** 正文。 */
  body?: I18nText;
  /** 创建时间。 */
  createdAtMs: number;
  /** 可选跳转路径。 */
  routeTo?: string;
  /** 是否允许用户手动关闭。默认 true。 */
  dismissible?: boolean;
  /** 动作按钮列表。 */
  actions: NoticeAction[];
}

/** notice 动作。 */
export interface NoticeAction {
  /** 动作 id。 */
  id: string;
  /** 按钮文案。 */
  label: I18nText;
  /** 按钮风格。 */
  variant?: "primary" | "secondary" | "danger";
  /** 当前页面内存态动作。 */
  run?: () => void | Promise<void>;
  /** 可选跳转路径。 */
  navigateTo?: string;
  /** 执行动作后自动 dismiss。默认 false。 */
  autoDismiss?: boolean;
}

/** notice registry capability key。 */
export const NOTICE_REGISTRY_CAPABILITY = "notice.registry";

