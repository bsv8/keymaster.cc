// packages/plugin-vault/src/VaultKeyDeleteModal.tsx
// 私钥删除 modal：硬切换 007 后流程升级为 key namespace 删除。
// 设计缘由：
//   - 删除是不可逆操作；modal 必须先让用户清楚：未备份 = 资产可能永久无法使用。
//   - 提供"导出备份"按钮，但**不强制**导出后才能继续删除。
//   - 删除流程由调用方（VaultSettingsPage）执行 `keyspace.deleteKeyById(keyId)`，
//     平台负责调度：prepare -> cancel background -> close handles -> delete
//     namespace DBs -> delete Vault private key。
//   - keyId 路径能同时覆盖 ready / failed / 无 hash 三类情况；不再按
//     publicKeyHash 路由（deleteKey 仍只允许 ready，failed+hash 走 hash
//     路径会卡住）。
//   - 错误信息透传平台错误（namespace DB blocked 等），用英文展示给用户。
//
// 硬切换 003：所有展示文案走 i18n。

import { useState } from "react";
import { Button, Modal } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";

export interface VaultKeyDeleteModalProps {
  open: boolean;
  keyLabel: string;
  keyFingerprint?: string;
  /** 期望用户输入的确认字符串，建议传 keyFingerprint。 */
  confirmText?: string;
  onExportBackup?(): void;
  onConfirmDelete(): Promise<void> | void;
  onClose(): void;
}

type Step = "warning" | "final";

export function VaultKeyDeleteModal({
  open,
  keyLabel,
  keyFingerprint,
  confirmText,
  onExportBackup,
  onConfirmDelete,
  onClose
}: VaultKeyDeleteModalProps) {
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [step, setStep] = useState<Step>("warning");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");

  function close() {
    if (busy) return;
    setStep("warning");
    setError(null);
    setTyped("");
    onClose();
  }

  function gotoFinal() {
    setError(null);
    setStep("final");
  }

  async function confirm() {
    setError(null);
    setBusy(true);
    try {
      await onConfirmDelete();
      setStep("warning");
      setError(null);
      setTyped("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.keyDelete.err.failed", { defaultValue: "删除失败" }));
    } finally {
      setBusy(false);
    }
  }

  const required = confirmText ?? keyFingerprint ?? keyLabel;
  const canConfirm = typed.trim() === required;

  return (
    <Modal
      open={open}
      title={
        step === "warning"
          ? t("vault.keyDelete.title.warn", { defaultValue: "删除 key" })
          : t("vault.keyDelete.title.final", { defaultValue: "再次确认" })
      }
      onClose={close}
      footer={
        step === "warning" ? (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t("common.action.cancel", { defaultValue: "取消" })}
            </Button>
            {onExportBackup ? (
              <Button variant="secondary" onClick={onExportBackup} disabled={busy}>
                {t("vault.keyDelete.exportBackup", { defaultValue: "导出备份" })}
              </Button>
            ) : null}
            <Button variant="danger" onClick={gotoFinal} disabled={busy}>
              {t("vault.keyDelete.next", { defaultValue: "下一步删除" })}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep("warning")} disabled={busy}>
              {t("common.action.back", { defaultValue: "返回" })}
            </Button>
            <Button variant="danger" onClick={confirm} loading={busy} disabled={!canConfirm}>
              {t("vault.keyDelete.confirm", { defaultValue: "确认删除" })}
            </Button>
          </>
        )
      }
    >
      {step === "warning" ? (
        <div className="vault-delete-warning">
          <p className="vault-delete-warning__danger">
            {t("vault.keyDelete.danger", {
              defaultValue:
                "删除会同时移除该 key 的私钥以及所有插件在本地的命名空间数据（资产缓存、历史、联系人等）。没有备份或在其他钱包中有副本时，相关资产将永久无法使用。"
            })}
          </p>
          <p className="vault-delete-warning__meta">
            {t("vault.keyDelete.target", { defaultValue: "目标：" })}
            <strong>{keyLabel}</strong>
            {keyFingerprint ? <>（<code>{keyFingerprint}</code>）</> : null}
          </p>
          {error ? <p className="vault-delete-warning__error">{error}</p> : null}
        </div>
      ) : (
        <div className="vault-delete-warning">
          <p className="vault-delete-warning__danger">
            {t("vault.keyDelete.confirmPrompt1", { defaultValue: "真的要删除 " })}
            <strong>{keyLabel}</strong>
            {t("vault.keyDelete.confirmPrompt2", { defaultValue: " 吗？此操作不可撤销。" })}
          </p>
          <p className="vault-delete-warning__meta">
            {t("vault.keyDelete.typedPrompt1", { defaultValue: "请输入 " })}
            <code>{required}</code>
            {t("vault.keyDelete.typedPrompt2", { defaultValue: " 以确认：" })}
          </p>
          <input
            className="vault-delete-warning__input"
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            autoFocus
          />
          {error ? <p className="vault-delete-warning__error">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
