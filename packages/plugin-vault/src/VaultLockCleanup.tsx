import { useState } from "react";
import { Button } from "@keymaster/ui";
import { usePluginI18n } from "@keymaster/runtime";
import type { WalletLockCleanup } from "@keymaster/contracts";
import { useInternalVault } from "./VaultInternalContext.js";

/** Native details preserves its expanded state across cleanup/retry updates. */
export function WalletLockDetails({ title, details }: { title: string; details: string }) {
  return <details className="vault-lock-cleanup__details">
    <summary>{title}</summary>
    <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "20rem", overflow: "auto" }}>{details}</pre>
  </details>;
}

/** Inline lock state: the owning unlock form remains mounted throughout cleanup. */
export function VaultLockCleanup({ cleanup }: { cleanup: WalletLockCleanup }) {
  const vault = useInternalVault();
  const { t } = usePluginI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const retry = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await vault.lock();
      if (result.status !== "accepted" && result.status !== "ok") throw new Error("message" in result ? result.message : t("vault.lock.retryFailed", { defaultValue: "重试清理失败，请再次重试" }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <div className="vault-lock-cleanup" aria-busy={cleanup.phase === "pending"}>
    {cleanup.phase === "pending"
      ? <p role="status" aria-live="polite">{t("vault.lock.cleaning", { defaultValue: "正在锁定钱包，等待服务退出…完成后可解锁。" })}</p>
      : <><p role="alert">{t("vault.lock.cleanupFailed", { defaultValue: "钱包已锁定，但部分服务清理失败。请重试清理，完成后才能解锁。" })}</p>
        <Button type="button" onClick={retry} loading={busy}>{t("vault.lock.retry", { defaultValue: "重试清理" })}</Button></>}
    {(cleanup.diagnostics || cleanup.phase === "failed" || error) ? <WalletLockDetails
      title={t("vault.lock.details", { defaultValue: "锁定错误详情" })}
      details={[cleanup.diagnostics ?? (cleanup.phase === "failed" ? cleanup.error : undefined), error].filter(Boolean).join("\n\n")}
    /> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
