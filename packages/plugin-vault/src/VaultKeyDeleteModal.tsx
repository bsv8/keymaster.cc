// 私钥删除 modal：危险提示 + 目标标签严格确认。

import { useState } from "react";
import { Button, Modal } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import { formatShortPublicKey } from "@keymaster/contracts";

export interface VaultKeyDeleteModalProps {
  open: boolean;
  keyLabel: string;
  publicKeyHex?: string;
  onExportBackup?(): void;
  onConfirmDelete(confirmationLabel: string): Promise<void> | void;
  onClose(): void;
}

export function VaultKeyDeleteModal({
  open,
  keyLabel,
  publicKeyHex,
  onExportBackup,
  onConfirmDelete,
  onClose
}: VaultKeyDeleteModalProps) {
  const { t } = useI18n();
  const [confirmationLabel, setConfirmationLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    if (busy) return;
    setConfirmationLabel("");
    setError(null);
    onClose();
  }

  async function confirm() {
    setError(null);
    setBusy(true);
    try {
      await onConfirmDelete(confirmationLabel);
      setConfirmationLabel("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.keyDelete.err.failed", { defaultValue: "删除失败" }));
    } finally {
      setBusy(false);
    }
  }

  const canConfirm = keyLabel.length > 0 && confirmationLabel === keyLabel;
  const identityMissingText = t("vault.settings.empty.fingerprint", { defaultValue: "身份不可用" });

  return (
    <Modal
      open={open}
      title={t("vault.keyDelete.title.warn", { defaultValue: "删除 key" })}
      onClose={close}
      footer={(
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>{t("common.action.cancel", { defaultValue: "取消" })}</Button>
          {onExportBackup ? <Button variant="secondary" onClick={onExportBackup} disabled={busy}>{t("vault.keyDelete.exportBackup", { defaultValue: "导出备份" })}</Button> : null}
          <Button variant="danger" onClick={() => void confirm()} loading={busy} disabled={!canConfirm}>{t("vault.keyDelete.confirm", { defaultValue: "确认删除" })}</Button>
        </>
      )}
    >
      <div className="vault-delete-warning">
        <p className="vault-delete-warning__danger">
          {t("vault.keyDelete.danger", { defaultValue: "删除会同时移除该 key 的私钥和本地数据，此操作不可撤销。" })}
        </p>
        <p className="vault-delete-warning__meta">
          {t("vault.keyDelete.target", { defaultValue: "目标：" })}<strong>{keyLabel}</strong>
          {publicKeyHex ? <>（<code>{formatShortPublicKey(publicKeyHex)}</code>）</> : <>（<span style={{ color: "var(--text-dim)" }}>{identityMissingText}</span>）</>}
        </p>
        <label className="vault-delete-warning__meta" htmlFor="vault-delete-confirmation-label">
          {t("vault.keyDelete.labelPrompt", { defaultValue: "请输入目标标签以确认：" })}
        </label>
        <input
          id="vault-delete-confirmation-label"
          className="vault-delete-warning__input"
          type="text"
          autoComplete="off"
          value={confirmationLabel}
          onChange={(e) => setConfirmationLabel(e.currentTarget.value)}
          autoFocus
        />
        {error ? <p className="vault-delete-warning__error">{error}</p> : null}
      </div>
    </Modal>
  );
}
