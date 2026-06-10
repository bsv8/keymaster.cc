// packages/plugin-vault/src/VaultUnlockPage.tsx
// 解锁页面：输入密码，调用 vault.unlock。
// 失败时显示明确错误，不暴露明文密码。

import { useState } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { VaultService } from "@keymaster/contracts";

export function VaultUnlockPage() {
  const vault = useCapability<VaultService>("vault.service");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await vault.unlock(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.unlock.err.failed", { defaultValue: "Unlock failed" }));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <div className="vault-page vault-page--unlock">
      <PageHeader
        title={t("vault.unlock.title", { defaultValue: "解锁钱包" })}
        description={t("vault.unlock.description", { defaultValue: "输入密码以解锁本地 Vault。" })}
      />
      <form onSubmit={submit} className="vault-form">
        <TextInput
          label={t("vault.unlock.password", { defaultValue: "密码" })}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          required
          error={error ?? undefined}
        />
        <Button type="submit" loading={busy} disabled={!password}>
          {t("vault.unlock.submit", { defaultValue: "解锁" })}
        </Button>
      </form>
    </div>
  );
}
