import { useState } from "react";
import { useInternalVault } from "./VaultInternalContext.js";
import { usePluginI18n, useResourceView } from "@keymaster/runtime";
import { Button } from "@keymaster/ui";
import { Lock } from "lucide-react";
import { useVaultResources } from "./VaultResourceContext.js";
import type { VaultKeyResourceState } from "./manifest.js";

export function VaultLockButton() {
  const resources = useVaultResources();
  const vault = useInternalVault();
  const { t } = usePluginI18n();
  const snapshot = useResourceView<VaultKeyResourceState>(resources, "vault.key-state", []).data;
  const [error, setError] = useState("");
  if (snapshot?.status !== "unlocked") return null;
  const lock = async () => {
    setError("");
    try {
      const result = await vault.lock();
      if (result.status !== "accepted" && result.status !== "ok") setError("message" in result ? result.message : t("vault.lock.requestFailed", { defaultValue: "锁定请求失败，请重试" }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <div className="vault-topbar-wallet">
    <Button variant="ghost" className="app-topbar__lock" iconLeft={<Lock size={16} />} onClick={lock}
      title={t("common.action.lock", { defaultValue: "锁定" })} aria-label={t("common.action.lock", { defaultValue: "锁定" })}>{t("common.action.lock", { defaultValue: "锁定" })}</Button>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
