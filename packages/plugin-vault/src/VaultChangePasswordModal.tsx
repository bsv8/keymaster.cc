// packages/plugin-vault/src/VaultChangePasswordModal.tsx
// Vault 锁屏密码修改 modal：收集旧密码、新密码与确认新密码，
// 调用 vault.changePassword 执行原子轮换。
//
// 设计缘由：
//   - 改密码是危险操作，必须显式输入旧密码，不允许借用当前 unlocked
//     session 当作永久授权。
//   - 提交时让 Vault 自己完成 maintenance / 原子重加密；UI 不拆事务。
//   - 成功后 Vault 会锁定，modal 可能随壳层切换自然卸载；失败则保留
//     输入方便重试。

import { useEffect, useState } from "react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import type { VaultService } from "@keymaster/contracts";

export interface VaultChangePasswordModalProps {
  open: boolean;
  vault: VaultService;
  onClose(): void;
}

export function VaultChangePasswordModal({
  open,
  vault,
  onClose
}: VaultChangePasswordModalProps) {
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOldPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setBusy(false);
  }, [open]);

  function close() {
    if (busy) return;
    setOldPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setBusy(false);
    onClose();
  }

  async function submit() {
    if (!oldPassword) {
      setError(t("vault.changePassword.err.oldRequired", { defaultValue: "请输入旧密码" }));
      return;
    }
    if (newPassword.length < 8) {
      setError(t("vault.changePassword.err.tooShort", { defaultValue: "新密码至少 8 位" }));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("vault.changePassword.err.mismatch", { defaultValue: "两次新密码不一致" }));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await vault.changePassword({ oldPassword, newPassword });
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("vault.changePassword.err.failed", { defaultValue: "修改密码失败" })
      );
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    !busy && oldPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword;

  return (
    <Modal
      open={open}
      title={t("vault.changePassword.title", { defaultValue: "修改密码" })}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("common.action.cancel", { defaultValue: "取消" })}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!canSubmit}>
            {t("vault.changePassword.submit", { defaultValue: "确认修改" })}
          </Button>
        </>
      }
    >
      <p className="vault-change-password-modal__hint">
        {t("vault.changePassword.hint", {
          defaultValue:
            "修改后 Vault 会立即锁定；新密码将替换旧密码保护的所有 Vault 记录。"
        })}
      </p>
      <TextInput
        label={t("vault.changePassword.oldPassword", { defaultValue: "旧密码" })}
        type="password"
        autoComplete="current-password"
        value={oldPassword}
        onChange={(e) => setOldPassword(e.currentTarget.value)}
        error={error ?? undefined}
      />
      <TextInput
        label={t("vault.changePassword.newPassword", { defaultValue: "新密码" })}
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.currentTarget.value)}
      />
      <TextInput
        label={t("vault.changePassword.confirmPassword", { defaultValue: "确认新密码" })}
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.currentTarget.value)}
      />
    </Modal>
  );
}
