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
  return (
    <label className={`ui-field ${className}`} htmlFor={inputId}>
      {label ? <span className="ui-field__label">{toText(label)}</span> : null}
      <input id={inputId} className="ui-input" {...rest} />
      {error ? <span className="ui-field__error">{toText(error)}</span> : helpText ? <span className="ui-field__hint">{toText(helpText)}</span> : null}
    </label>
  );
}
