// packages/ui/src/index.ts
// UI 原子组件统一导出。
// 设计缘由：业务组件只 import 这个入口，避免深路径。
//
// 硬切换 003：sats / 数字格式化接收 locale 参数，调用方通过 useLocale()
// 传入当前语言；本包不再硬编码 en-US。

export * from "./Button.js";
export * from "./TextInput.js";
export * from "./TextArea.js";
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

/** 展示价：金额 + 单位；与服务 / Connect 的 PriceValue 形状一致。 */
export interface DisplayPrice {
  amount: string;
  unit: string;
}

/**
 * 把 sats 与展示价拼成 `x sats / y.yy UNIT`。
 *
 * 设计缘由：
 *   - 价格只作显示参考，mainnet 用实时价，testnet 恒为 0；
 *   - 价格不可用（未就绪 / 能力缺失）时也显示 0.00，消费方不需要错误分支；
 *   - 计算固定保留 2 位小数，和价格本身的精度一致。
 */
export function formatSatsWithPrice(
  sats: number,
  price: DisplayPrice | null,
  options: { locale?: string; network?: "main" | "test"; fallbackUnit?: string } = {}
): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const unit = price && price.unit.length > 0 ? price.unit : options.fallbackUnit ?? "USDT";
  const satsText = formatSats(sats, locale);
  if (!price || options.network === "test") return `${satsText} / 0.00 ${unit}`;
  const amount = Number(price.amount);
  if (!Number.isFinite(amount)) return `${satsText} / 0.00 ${unit}`;
  const value = (sats * amount) / 100_000_000;
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
  return `${satsText} / ${formatted} ${unit}`;
}
