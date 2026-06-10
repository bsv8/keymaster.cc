// packages/plugin-vault/src/VaultCreatePage.tsx
// 首启"新建钱包"页：与 apps/web LockedShell 的"新建钱包"卡片语义保持一致。
// 设计缘由（硬切换 009）：同一个产品动作"新建钱包"在两处入口必须产生
// 同样的最终状态——创建 Vault + 落首把 Key。继续把本页面写成一个"只创建
// 空 Vault"页会让两条入口产生相互矛盾的结果。提交行为改走
// `vault.createVaultWithInitialKey`，失败由 Vault 内部事务化回滚到
// uninitialized。
//
// 密码是 vault 的唯一解锁钥匙：这里提示用户密码不可恢复（不存储）。

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
      // 硬切换 009：与首页"新建钱包"对齐——必须走
      // createVaultWithInitialKey 一次性完成 Vault + 首 Key + active
      // 切换。Vault 内部负责失败回滚；本页面不复制该事务。
      await vault.createVaultWithInitialKey({ password });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("vault.create.err.initialKeyFailed", { defaultValue: "创建首把 Key 失败" })
      );
    } finally {
      setBusy(false);
      setPassword("");
      setConfirm("");
    }
  }

  return (
    <div className="vault-page vault-page--create">
      <PageHeader
        title={t("vault.create.title", { defaultValue: "新建钱包" })}
        description={t("vault.create.description", {
          defaultValue: "设置一个本地密码，并立即生成你的第一把 Key。之后可以继续导入其他私钥。"
        })}
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
          {t("vault.create.submit", { defaultValue: "新建钱包" })}
        </Button>
      </form>
    </div>
  );
}
