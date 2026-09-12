import type { ReactNode } from "react";

export interface StartupPlaceholderProps {
  message?: ReactNode;
}

/**
 * 应用启动判定期间的独立占位页。
 *
 * 这里不渲染 onboarding，也不触发任何初始化恢复读取；只有
 * application-bootstrap ResourceSnapshot 真正给出 data 后，App 才会
 * 选择 setup、locked 或 unlocked shell。
 */
export function StartupPlaceholder({ message = "正在准备存储…" }: StartupPlaceholderProps) {
  return (
    <div className="startup-placeholder" role="status" aria-live="polite" aria-busy="true">
      <div className="startup-placeholder__spinner" aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}

export interface StartupErrorProps {
  title: string;
  message: ReactNode;
  onRetry?: () => void;
}

/** 启动资源/装配失败的明确恢复页；错误不能静默降级为首次设置。 */
export function StartupError({ title, message, onRetry }: StartupErrorProps) {
  return (
    <main className="startup-error" role="alert">
      <div className="startup-error__content">
        <h1>{title}</h1>
        <p>{message}</p>
        {onRetry ? <button className="startup-error__retry" type="button" onClick={onRetry}>重试启动</button> : null}
      </div>
    </main>
  );
}
