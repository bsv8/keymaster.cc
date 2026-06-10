// packages/ui/src/Select.tsx
// 下拉选择。
//
// 硬切换 003：label / option.label 接受 I18nText | string。
// 设计缘由：UI 包不直接依赖 runtime（避免包边界倒置），但允许调用方
// 传入 I18nText 对象，由调用方在 i18n 上下文里解析。组件在没解析的情况下
// 退到 fallback 显示，保证至少可读。

import { useId, type SelectHTMLAttributes } from "react";
import type { I18nText } from "@keymaster/contracts";

/** UI 组件接受的可渲染文本。调用方可以传 string（已解析）或 I18nText
 * （未解析；组件在渲染时退到 fallback）。 */
type RenderableText = string | I18nText;

function toText(input: RenderableText | undefined): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  return input.fallback;
}

export interface SelectOption {
  label: RenderableText;
  value: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  label?: RenderableText;
  hint?: RenderableText;
  error?: RenderableText;
  options: SelectOption[];
}

export function Select({ label, hint, error, options, id, className = "", ...rest }: SelectProps) {
  const reactId = useId();
  const selectId = id ?? `ui-select-${reactId}`;
  return (
    <label className={`ui-field ${className}`} htmlFor={selectId}>
      {label ? <span className="ui-field__label">{toText(label)}</span> : null}
      <select id={selectId} className="ui-input" {...rest}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {toText(opt.label)}
          </option>
        ))}
      </select>
      {error ? <span className="ui-field__error">{toText(error)}</span> : hint ? <span className="ui-field__hint">{toText(hint)}</span> : null}
    </label>
  );
}
