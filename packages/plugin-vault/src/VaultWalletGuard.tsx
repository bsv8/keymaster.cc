import { useEffect, type ReactNode } from "react";
import { usePluginCapability } from "webloom-framework/react";
import { usePluginI18n, useResourceView } from "@keymaster/runtime";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";
import { VAULT_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { useVaultResources } from "./VaultResourceContext.js";
import type { VaultKeyResourceState } from "./manifest.js";
export type WalletGuard = { kind: "normal" } | { kind: "needs-repair"; publicKeyHex?: string } | { kind: "diagnostic"; error: string };
export function VaultWalletGuard({ children, sendActivity }: { children?: ReactNode; sendActivity(): void }) {
  const resources = useVaultResources();
  const vault = usePluginCapability(VAULT_SERVICE_CAPABILITY);
  const status = useResourceView<VaultKeyResourceState>(resources, "vault.key-state", []).data?.status;
  const { t } = usePluginI18n();
  const guard = useResourceView<WalletGuard>(resources, "vault.wallet-guard", []);
  useEffect(() => {
    if (status !== "unlocked") return;
    let lastActivity = 0;
    const activity = () => { const now = Date.now(); if (now - lastActivity >= 5000) { lastActivity = now; sendActivity(); } };
    const events = ["pointerdown", "keydown", "mousemove", "touchstart", "wheel"] as const;
    for (const event of events) window.addEventListener(event, activity, { passive: true });
    return () => { for (const event of events) window.removeEventListener(event, activity); };
  }, [status, sendActivity]);
  if (!guard.data) return <p role="status">{t("common.status.loading", { defaultValue: "Loading…" })}</p>;
  if (guard.data.kind === "normal") return <>{children}</>;
  if (guard.data.kind === "diagnostic") return <div className="app-shell--diagnostic">
    <PageHeader title={t("shell.appShell.diagnostic.title", { defaultValue: "无法读取钱包 Key" })} />
    <EmptyState title={t("shell.appShell.diagnostic.errorTitle", { defaultValue: "读取失败" })} description={guard.data.error}
      action={<Button onClick={() => resources.invalidate("vault.wallet-guard", [])}>{t("common.action.retry", { defaultValue: "重试" })}</Button>} />
  </div>;
  return <div className="app-shell__repair">
    <PageHeader title={t("shell.appShell.repair.title", { defaultValue: "钱包 Key 状态不一致" })}
      description={t("shell.appShell.repair.desc", { defaultValue: "钱包已解锁，但读不到唯一 Key 的公开身份。已阻断其它业务页，以免在身份不明时修改数据。" })} />
    <EmptyState title={t("shell.appShell.repair.emptyTitle", { defaultValue: "读不到钱包 Key" })}
      description={t("shell.appShell.repair.emptyDesc", { defaultValue: "请先锁定再解锁；如果仍然失败，需要重置钱包后重新创建或导入。重置会删除当前 Key 和全部本地钱包数据。" })} />
    {guard.data.publicKeyHex ? <p className="app-shell__repair-summary">{guard.data.publicKeyHex}</p> : null}
  </div>;
}
