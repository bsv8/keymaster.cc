// packages/plugin-vault/src/VaultCreatePage.tsx
// 首启"新建钱包"页：与 apps/web LockedShell 的"新建钱包"卡片语义保持一致。
//
// 单 Key 本地存储（docs/存储.md）之后，创建只有一条路径：一次性生成唯一
// 钱包 Key，并把 KeyHold、.keymaster/meta 与必要初始系统数据在同一个
// IndexedDB 事务里提交。页面不再分步"先建空 Vault 再加 Key"——那会留下
// "有锁屏密码但 0 key"的空钱包。
//
// 密码是这把 Key 的唯一解锁钥匙：不存储、不上传、丢失后无法找回。

import { useState } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { useCapability } from "webloom-framework/react";
import { useI18n } from "@keymaster/runtime";
import { VAULT_SERVICE_CAPABILITY } from "@keymaster/contracts";

export function VaultCreatePage() {
  const vault = useCapability(VAULT_SERVICE_CAPABILITY);
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
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
      await vault.initialize({
        // 操作 id 只用于幂等与诊断，不是身份。
        transactionId: `create-${crypto.randomUUID()}`,
        firstKey: { kind: "generate", label: "", capabilities: ["p2pkh"], password },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.create.err.failed", { defaultValue: "创建失败" }));
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
          defaultValue: "设置一个本地密码，Keymaster 会为本浏览器生成唯一一把钱包 Key。"
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
