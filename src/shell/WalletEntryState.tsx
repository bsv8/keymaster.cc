import { Children, type ReactNode } from "react";
import { useOptionalCapability } from "webloom-framework/react";
import { PAGE_UI_RENDERER_CAPABILITY } from "@keymaster/contracts";

/** Unknown is not an empty wallet. Show state inside the normal entry panel,
 * without exposing create/import/unlock controls before identity is known. */
export function WalletEntryState({ title = "Keymaster", message = "正在读取钱包状态…", error = false, onRetry }: {
  title?: string; message?: ReactNode; error?: boolean; onRetry?: () => void;
}) {
  const pages = useOptionalCapability(PAGE_UI_RENDERER_CAPABILITY);
  const content = <div className="wallet-entry-state" aria-busy={!error} role={error ? "alert" : undefined}>
    <h1>{title}</h1>
    <p role={error ? undefined : "status"} aria-live="polite">{message}</p>
    {onRetry && <button type="button" className="ui-button" onClick={onRetry}>重试</button>}
  </div>;
  // Before Page is installed, the same entry panel is safe to render without
  // registry/I/O. Once available Page owns theme, language and entry chrome.
  const shell = pages?.renderFrame("onboarding", content, "narrow");
  return Children.count(shell) > 0 ? <>{shell}</>
    : <div className="onboarding-shell"><main className="onboarding-shell__main"><div className="onboarding-shell__panel onboarding-shell__panel--narrow">{content}</div></main></div>;
}
