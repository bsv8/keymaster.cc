// packages/plugin-vault/src/VaultKeyExportModal.tsx
// 私钥导出 modal：输入备份密码 + 确认密码 -> 调用 exportPrivateKey -> 下载 JSON。
// 设计缘由：
//   - 唯一允许的导出格式是 bsv8 加密 JSON（envelope）。
//   - 该 modal 不直接调用 removeKey、不保存 key 列表、不参与删除流程。
//   - 不在页面明文展示完整私钥；下载流程失败时保留 modal 让用户重试。
//
// 硬切换 003：所有展示文案走 i18n。

import { useState } from "react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";

export interface VaultKeyExportModalProps {
  open: boolean;
  /** 当前正在导出的 key 元数据；用作下载文件名。 */
  keyLabel: string;
  keyId: string;
  /** 父组件传入的导出调用；返回加密 envelope。 */
  onExport(password: string): Promise<unknown>;
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
  // 文件名只保留字母数字、下划线、短横线；空时退回 keyId 前 8 位。
  const cleaned = input.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "key";
}

export function VaultKeyExportModal({
  open,
  keyLabel,
  keyId,
  onExport,
  onClose
}: VaultKeyExportModalProps) {
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setPassword("");
    setConfirm("");
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
    if (!password) {
      setError(t("vault.keyExport.err.empty", { defaultValue: "请输入备份密码" }));
      return;
    }
    if (password !== confirm) {
      setError(t("vault.keyExport.err.mismatch", { defaultValue: "两次密码不一致" }));
      return;
    }
    setBusy(true);
    try {
      const envelope = await onExport(password);
      const json = JSON.stringify(envelope, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const slug = safeSlug(keyLabel || keyId.slice(0, 8));
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
      title={t("vault.keyExport.title", { defaultValue: "导出私钥" })}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("common.action.cancel", { defaultValue: "取消" })}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!password || !confirm}>
            {t("vault.keyExport.submit", { defaultValue: "下载备份文件" })}
          </Button>
        </>
      }
    >
      <p className="vault-export-modal__hint">
        {t("vault.keyExport.hint", {
          defaultValue:
            "备份文件是加密 JSON（bsv8 envelope），需要用这个密码解密。请妥善保存密码与文件，删除 key 后本机无法恢复。"
        })}
      </p>
      <TextInput
        label={t("vault.keyExport.passwordNew", { defaultValue: "备份密码" })}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
      />
      <TextInput
        label={t("vault.keyExport.passwordConfirm", { defaultValue: "确认密码" })}
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.currentTarget.value)}
        error={error ?? undefined}
      />
    </Modal>
  );
}
