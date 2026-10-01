// packages/plugin-vault/src/VaultKeyHoldExportModal.tsx
// 加密 KeyHold 导出 modal。
//
// 语义边界（docs/存储.md）：导出的文件就是 `key.json` 的原样副本——它只
// 含唯一钱包 Key 的加密材料与公开元数据，**不是完整钱包备份**。联系人、
// 消息、设置等本地业务数据都不在这个文件里，界面必须把这一点说清楚，
// 否则用户会把它误当成"整个钱包的备份"。
//
// 导出不接触明文私钥，也不参与删除流程；下载失败时保留 modal 让用户重试。

import { useState } from "react";
import { Button, Modal } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";

export interface VaultKeyHoldExportModalProps {
  open: boolean;
  /** 当前 Key 的显示标签；用作下载文件名的一部分。 */
  keyLabel: string;
  publicKeyHex: string;
  /** 请求 Vault 导出加密 KeyHold 原始字节。 */
  onExport(): Promise<Uint8Array>;
  onClose(): void;
}

function fileTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function safeSlug(input: string): string {
  // 文件名只保留字母数字、下划线、短横线；空时退回 publicKeyHex 前 8 位。
  const cleaned = input.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "key";
}

export function VaultKeyHoldExportModal({
  open,
  keyLabel,
  publicKeyHex,
  onExport,
  onClose
}: VaultKeyHoldExportModalProps) {
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    if (busy) return;
    setError(null);
    setBusy(false);
    onClose();
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const bytes = await onExport();
      // KeyHold 保持既有加密 JSON 格式；这里按字节原样落盘，不做再封装。
      const blob = new Blob([bytes as BlobPart], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const slug = safeSlug(keyLabel || publicKeyHex.slice(0, 8));
      a.href = url;
      a.download = `keymaster-keyhold-${slug}-${fileTimestamp()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setError(null);
      setBusy(false);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.keyHoldExport.err.failed", { defaultValue: "导出失败" }));
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("vault.keyHoldExport.title", { defaultValue: "导出加密 KeyHold" })}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("common.action.cancel", { defaultValue: "取消" })}
          </Button>
          <Button onClick={submit} loading={busy}>
            {t("vault.keyHoldExport.submit", { defaultValue: "导出" })}
          </Button>
        </>
      }
    >
      <p className="vault-export-modal__hint">
        {t("vault.keyHoldExport.hint", {
          defaultValue: "将下载当前 Key 的加密 KeyHold 文件。文件不包含明文私钥，但必须与对应密码一起妥善保管。"
        })}
      </p>
      <p className="vault-export-modal__notice" role="note">
        {t("vault.keyHoldExport.notBackup", {
          defaultValue: "该文件只含钱包 Key，不含联系人、消息、设置等本地业务数据，不能当作完整钱包备份。"
        })}
      </p>
      {error ? <p className="vault-export-modal__error">{error}</p> : null}
    </Modal>
  );
}
