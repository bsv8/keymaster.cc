// packages/ui/src/index.ts
// UI 原子组件统一导出。
// 设计缘由：业务组件只 import 这个入口，避免深路径。
//
// 硬切换 003：sats / 数字格式化接收 locale 参数，调用方通过 useLocale()
// 传入当前语言；本包不再硬编码 en-US。

export * from "./Button.js";
export * from "./TextInput.js";
export * from "./Select.js";
export * from "./Modal.js";
export * from "./PageHeader.js";
export * from "./DataTable.js";
export * from "./EmptyState.js";

/** 默认 locale：与 SUPPORTED_LANGUAGES.DEFAULT_LANGUAGE 保持一致。 */
const DEFAULT_LOCALE = "en";

/** 工具函数：satoshis 可读化，调用方传入 locale（通常是 useLocale()）。
 * 旧的单参数 `formatSats(value)` 仍可用，但走 en-US；新代码应传 locale。 */
export function formatSats(value: number, locale: string = DEFAULT_LOCALE): string {
  return `${new Intl.NumberFormat(locale).format(value)} sats`;
}

export function satsToBsv(value: number): string {
  return `${(value / 100_000_000).toFixed(8)} BSV`;
}
