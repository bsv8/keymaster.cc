// packages/ui/src/TextArea.tsx
// 多行文本输入组件。
// 设计缘由：JSON 文本不是一行短字符串；继续塞进单行 TextInput 会直接损害
// 可用性。UI 层应提供正式的多行组件，而不是在业务页内联原生 <textarea>。
// API 风格与 TextInput 保持一致：label / hint / description / error 均接受
// I18nText | string，统一走 i18n 解析。

import { useId, type TextareaHTMLAttributes } from "react";
import type { I18nText } from "@keymaster/contracts";

type RenderableText = string | I18nText;

function toText(input: RenderableText | undefined): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  return input.fallback;
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: RenderableText;
  hint?: RenderableText;
  description?: RenderableText;
  error?: RenderableText;
}

export function TextArea({
  label,
  hint,
  description,
  error,
  id,
  className = "",
  rows = 6,
  ...rest
}: TextAreaProps) {
  const reactId = useId();
  const inputId = id ?? `ui-textarea-${reactId}`;
  const helpText = description ?? hint;
  return (
    <label className={`ui-field ${className}`} htmlFor={inputId}>
      {label ? <span className="ui-field__label">{toText(label)}</span> : null}
      <textarea id={inputId} className="ui-textarea" rows={rows} {...rest} />
      {error ? (
        <span className="ui-field__error">{toText(error)}</span>
      ) : helpText ? (
        <span className="ui-field__hint">{toText(helpText)}</span>
      ) : null}
    </label>
  );
}