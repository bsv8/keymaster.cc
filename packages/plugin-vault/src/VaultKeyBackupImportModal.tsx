// packages/plugin-vault/src/VaultKeyBackupImportModal.tsx
// 单 Key Backup 导入 modal：收集备份 JSON + 源密码 + 目标 Vault 密码，
// 调用 vault.importKeyBackup 还原加密 key 记录。
//
// 设计缘由：
//   - 备份恢复需要两重授权：先验证备份来源密码，再验证当前 Vault 目标密码。
//   - JSON 文本不是单行输入，使用 TextArea；密码仍用 TextInput。
//   - 提交失败时保留 modal，方便修正 backup 或密码后重试。
//
// 硬切换 003：所有展示文案走 i18n。

import { useEffect, useState } from "react";
import { Button, Modal, TextArea, TextInput } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import type { KeyRef, VaultService } from "@keymaster/contracts";

export interface VaultKeyBackupImportModalProps {
  open: boolean;
  vault: VaultService;
  onImported?(key: KeyRef): void;
  onClose(): void;
}

export function VaultKeyBackupImportModal({
  open,
  vault,
  onImported,
  onClose
}: VaultKeyBackupImportModalProps) {
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  const [backup, setBackup] = useState("");
  const [sourcePassword, setSourcePassword] = useState("");
  const [targetPassword, setTargetPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBackup("");
    setSourcePassword("");
    setTargetPassword("");
    setError(null);
    setBusy(false);
  }, [open]);

  function close() {
    if (busy) return;
    setBackup("");
    setSourcePassword("");
    setTargetPassword("");
    setError(null);
    setBusy(false);
    onClose();
  }

  async function submit() {
    const trimmedBackup = backup.trim();
    if (!trimmedBackup) {
      setError(t("vault.keyImportBackup.err.emptyBackup", { defaultValue: "备份内容不能为空" }));
      return;
    }
    if (!sourcePassword) {
      setError(t("vault.keyImportBackup.err.emptySourcePassword", { defaultValue: "请输入源密码" }));
      return;
    }
    if (!targetPassword) {
      setError(t("vault.keyImportBackup.err.emptyTargetPassword", { defaultValue: "请输入目标 Vault 密码" }));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const restored = await vault.importKeyBackup?.({
        backup: trimmedBackup,
        sourcePassword,
        targetPassword
      });
      if (!restored) {
        throw new Error(t("vault.keyImportBackup.err.unavailable", { defaultValue: "当前 Vault 不支持备份恢复" }));
      }
      onImported?.(restored);
      setBackup("");
      setSourcePassword("");
      setTargetPassword("");
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("vault.keyImportBackup.err.failed", { defaultValue: "导入失败" })
      );
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    !busy && backup.trim().length > 0 && sourcePassword.length > 0 && targetPassword.length > 0;

  return (
    <Modal
      open={open}
      title={t("vault.keyImportBackup.title", { defaultValue: "导入备份" })}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("common.action.cancel", { defaultValue: "取消" })}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!canSubmit}>
            {t("vault.keyImportBackup.submit", { defaultValue: "恢复备份" })}
          </Button>
        </>
      }
    >
      <p className="vault-import-backup-modal__hint">
        {t("vault.keyImportBackup.hint", {
          defaultValue:
            "粘贴导出的单 Key Backup JSON。恢复时需要备份来源密码，以及当前 Vault 的目标密码。"
        })}
      </p>
      <TextArea
        label={t("vault.keyImportBackup.backup", { defaultValue: "备份 JSON" })}
        value={backup}
        onChange={(e) => setBackup(e.currentTarget.value)}
        error={error ?? undefined}
        placeholder={t("vault.keyImportBackup.backupPlaceholder", {
          defaultValue: '{"format":"keymaster","version":2,...}'
        })}
        rows={10}
        autoFocus
      />
      <TextInput
        label={t("vault.keyImportBackup.sourcePassword", { defaultValue: "源密码" })}
        type="password"
        autoComplete="current-password"
        value={sourcePassword}
        onChange={(e) => setSourcePassword(e.currentTarget.value)}
      />
      <TextInput
        label={t("vault.keyImportBackup.targetPassword", { defaultValue: "目标 Vault 密码" })}
        type="password"
        autoComplete="current-password"
        value={targetPassword}
        onChange={(e) => setTargetPassword(e.currentTarget.value)}
      />
    </Modal>
  );
}
