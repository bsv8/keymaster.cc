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
  const hasError = !!error;
  const feedbackId = `${inputId}-feedback`;
  const describedBy = [rest["aria-describedby"], hasError ? `${feedbackId}-error` : helpText && feedbackId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`ui-field ${className}`}>
      {label ? <label className="ui-field__label" htmlFor={inputId}>{toText(label)}</label> : null}
      <textarea id={inputId} className="ui-textarea" rows={rows} {...rest} aria-invalid={hasError || rest["aria-invalid"]} aria-describedby={describedBy} />
      {!hasError && helpText ? <span id={feedbackId} className="ui-field__hint">{toText(helpText)}</span> : null}
      <span id={`${feedbackId}-error`} role="alert" aria-atomic="true" className="ui-field__error">{toText(error)}</span>
    </div>
  );
}