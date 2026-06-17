// packages/ui/src/Button.tsx
// 统一按钮：业务组件不直接写 <button>，使用这个以保证样式一致。
//
// 硬切换 007：未传 `type` 时默认补 `type="button"`，把"普通按钮误提交表单"
// 从 HTML 默认行为（submit）改成 fail-closed。真实表单提交必须显式
// `type="submit"`，真实重置必须显式 `type="reset"`。

import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  type,
  className = "",
  iconLeft,
  iconRight,
  loading,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type ?? "button"}
      disabled={disabled || loading}
      className={`ui-button ui-button--${variant} ui-button--${size} ${className}`}
    >
      {iconLeft ? <span className="ui-button__icon">{iconLeft}</span> : null}
      <span>{loading ? "Loading…" : children}</span>
      {iconRight ? <span className="ui-button__icon">{iconRight}</span> : null}
    </button>
  );
}
