// packages/ui/src/TextInput.tsx
// 文本输入：单行文本/密码输入。
//
// 硬切换 003：label / hint / description / error 接受 I18nText | string。

import { useId, type InputHTMLAttributes } from "react";
import type { I18nText } from "@keymaster/contracts";

type RenderableText = string | I18nText;

function toText(input: RenderableText | undefined): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  return input.fallback;
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: RenderableText;
  hint?: RenderableText;
  description?: RenderableText;
  error?: RenderableText;
}

export function TextInput({ label, hint, description, error, id, className = "", ...rest }: TextInputProps) {
  const reactId = useId();
  const inputId = id ?? `ui-input-${reactId}`;
  const helpText = description ?? hint;
  const hasError = !!error;
  const feedbackId = `${inputId}-feedback`;
  const describedBy = [rest["aria-describedby"], hasError ? `${feedbackId}-error` : helpText && feedbackId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`ui-field ${className}`}>
      {label ? <label className="ui-field__label" htmlFor={inputId}>{toText(label)}</label> : null}
      <input id={inputId} className="ui-input" {...rest} aria-invalid={hasError || rest["aria-invalid"]} aria-describedby={describedBy} />
      {!hasError && helpText ? <span id={feedbackId} className="ui-field__hint">{toText(helpText)}</span> : null}
      <span id={`${feedbackId}-error`} role="alert" aria-atomic="true" className="ui-field__error">{toText(error)}</span>
    </div>
  );
}
