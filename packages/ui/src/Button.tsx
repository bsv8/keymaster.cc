// packages/ui/src/Button.tsx
// 统一按钮：业务组件不直接写 <button>，使用这个以保证样式一致。

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
      disabled={disabled || loading}
      className={`ui-button ui-button--${variant} ui-button--${size} ${className}`}
    >
      {iconLeft ? <span className="ui-button__icon">{iconLeft}</span> : null}
      <span>{loading ? "Loading…" : children}</span>
      {iconRight ? <span className="ui-button__icon">{iconRight}</span> : null}
    </button>
  );
}
