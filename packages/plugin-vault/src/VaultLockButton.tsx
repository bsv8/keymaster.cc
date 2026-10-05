import { usePluginCapability } from "webloom-framework/react";
import { usePluginI18n, useResourceView } from "@keymaster/runtime";
import { VAULT_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { Button } from "@keymaster/ui";
import { Lock } from "lucide-react";
import { useVaultResources } from "./VaultResourceContext.js";
import type { VaultKeyResourceState } from "./manifest.js";
export function VaultLockButton() {
  const resources = useVaultResources();
  const vault = usePluginCapability(VAULT_SERVICE_CAPABILITY);
  const { t } = usePluginI18n();
  const status = useResourceView<VaultKeyResourceState>(resources, "vault.key-state", []).data?.status;
  if (status !== "unlocked") return null;
  const lock = async () => {
    const deadline = Date.now() + 6000;
    for (;;) {
      try { await vault.lock(); return; }
      catch { if (Date.now() >= deadline) return; await new Promise(resolve => setTimeout(resolve, 400)); }
    }
  };
  return <Button variant="ghost" className="app-topbar__lock" iconLeft={<Lock size={16} />} onClick={lock}
    title={t("common.action.lock", { defaultValue: "锁定" })} aria-label={t("common.action.lock", { defaultValue: "锁定" })}>{t("common.action.lock", { defaultValue: "锁定" })}</Button>;
}
