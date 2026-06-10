// packages/plugin-vault/src/VaultCreatePage.tsx
// 创建钱包密码：第一次进入应用时使用。
// 设计缘由：密码是 vault 的唯一解锁钥匙；这里提示用户密码不可恢复（不存储）。

import { useState } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { VaultService } from "@keymaster/contracts";

export function VaultCreatePage() {
  const vault = useCapability<VaultService>("vault.service");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError(t("vault.create.err.tooShort", { defaultValue: "密码至少 8 位" }));
      return;
    }
    if (password !== confirm) {
      setError(t("vault.create.err.mismatch", { defaultValue: "两次密码不一致" }));
      return;
    }
    setBusy(true);
    try {
      await vault.createVault(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.create.err.failed", { defaultValue: "Create failed" }));
    } finally {
      setBusy(false);
      setPassword("");
      setConfirm("");
    }
  }

  return (
    <div className="vault-page vault-page--create">
      <PageHeader
        title={t("vault.create.title", { defaultValue: "创建钱包" })}
        description={t("vault.create.description", { defaultValue: "设置一个本地密码。该密码用于加密所有私钥，不会发送到任何服务器，丢失后无法找回。" })}
      />
      <form onSubmit={submit} className="vault-form">
        <TextInput
          label={t("vault.create.passwordNew", { defaultValue: "新密码" })}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          required
        />
        <TextInput
          label={t("vault.create.passwordConfirm", { defaultValue: "确认密码" })}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.currentTarget.value)}
          required
          error={error ?? undefined}
        />
        <Button type="submit" loading={busy} disabled={!password || !confirm}>
          {t("vault.create.submit", { defaultValue: "创建钱包" })}
        </Button>
      </form>
    </div>
  );
}
