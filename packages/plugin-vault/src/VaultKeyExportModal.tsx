// packages/plugin-vault/src/VaultKeyExportModal.tsx
// 单 Key Backup 导出 modal：直接请求 Vault 生成备份 JSON -> 下载文件。
// 设计缘由：
//   - 备份只复制 vault_meta + 选中的 canonical vault_keys 记录，不接触明文私钥。
//   - 该 modal 不直接调用 removeKey、不保存 key 列表、不参与删除流程。
//   - 不在页面明文展示完整私钥；下载流程失败时保留 modal 让用户重试。
//
// 硬切换 003：所有展示文案走 i18n。
// 硬切换 002 收尾：modal 接收 `publicKeyHex`（平台身份根字段），不再接收

import { useState } from "react";
import { Button, Modal } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";

export interface VaultKeyExportModalProps {
  open: boolean;
  /** 当前正在导出的 key 元数据；用作下载文件名。 */
  keyLabel: string;
  publicKeyHex: string;
  /** 父组件传入的导出调用；返回单 Key Backup JSON 字符串。 */
  onExport(): Promise<string>;
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

export function VaultKeyExportModal({
  open,
  keyLabel,
  publicKeyHex,
  onExport,
  onClose
}: VaultKeyExportModalProps) {
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setError(null);
    setBusy(false);
  }

  function close() {
    if (busy) return;
    reset();
    onClose();
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const json = await onExport();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const slug = safeSlug(keyLabel || publicKeyHex.slice(0, 8));
      a.href = url;
      a.download = `keymaster-key-${slug}-${fileTimestamp()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.keyExport.err.failed", { defaultValue: "导出失败" }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("vault.keyExport.title", { defaultValue: "导出备份" })}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("common.action.cancel", { defaultValue: "取消" })}
          </Button>
          <Button onClick={submit} loading={busy}>
            {t("vault.keyExport.submit", { defaultValue: "下载备份文件" })}
          </Button>
        </>
      }
    >
      <p className="vault-export-modal__hint">
        {t("vault.keyExport.hint", {
          defaultValue:
            "备份文件直接复制本机 Vault 的加密记录。请妥善保存文件；恢复时仍需要对应 Vault 密码。"
        })}
      </p>
      {error ? <p className="vault-export-modal__error">{error}</p> : null}
    </Modal>
  );
}
