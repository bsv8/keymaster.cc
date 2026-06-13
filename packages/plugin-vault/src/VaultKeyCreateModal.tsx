// packages/plugin-vault/src/VaultKeyCreateModal.tsx
// 硬切换 002：新建 Key Modal。
// 设计缘由：
//   - 私钥生成属于 Vault 安全边界，本组件不调用 crypto / noble / IndexedDB，
//     只负责收集标签 + 调用父组件传入的 onCreate(label)。
//   - 提交中防重复：loading 期间禁止关闭、禁止二次提交。
//   - 成功状态：展示公开 KeyRef + 备份风险提示，导出走父组件传入的
//     onExport（复用现有 VaultKeyExportModal，不实现第二套导出）。
//   - "稍后"按钮允许用户跳过导出；Key 已持久化并保持 active。
//   - 失败状态：保留 modal，可重试。
//
// 硬切换 003：所有展示文案走 i18n。
//
// 硬切换 003 收尾：
//   - 成功提示展示"公钥"而不是"指纹"，默认显示**短公钥**。
//   - "按指纹区分"文案改为"按公钥区分"或"按短公钥区分"。
//   - 复制按钮复制**完整公钥**，不是截断串。
//   - 不再读取 KeyRef.fingerprint 字段。

import { useEffect, useState } from "react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import { formatShortPublicKey } from "@keymaster/contracts";
import type { KeyRef } from "@keymaster/contracts";

/** 标签最大长度，与 vaultService.LABEL_MAX_LENGTH 保持一致。 */
const LABEL_MAX_LENGTH = 64;

export interface VaultKeyCreateModalProps {
  open: boolean;
  /** 父组件传入的"创建 Key"调用，返回公开 KeyRef。 */
  onCreate(label: string): Promise<KeyRef>;
  /** 创建成功后父组件如何打开导出 Modal。 */
  onExport(key: KeyRef): void;
  onClose(): void;
}

type Phase = "form" | "success";

/** 生成 "Key YYYY-MM-DD HH:mm" 形式的默认标签。 */
function defaultLabel(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `Key ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function VaultKeyCreateModal({
  open,
  onCreate,
  onExport,
  onClose
}: VaultKeyCreateModalProps) {
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [phase, setPhase] = useState<Phase>("form");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<KeyRef | null>(null);

  useEffect(() => {
    if (open) {
      setPhase("form");
      setError(null);
      setBusy(false);
      setCreated(null);
      setLabel(defaultLabel());
    }
  }, [open]);

  function close() {
    if (busy) return;
    onClose();
  }

  async function submit() {
    setError(null);
    const trimmed = label.trim();
    if (!trimmed) {
      setError(t("vault.keyCreate.err.empty", { defaultValue: "标签不能为空" }));
      return;
    }
    if (trimmed.length > LABEL_MAX_LENGTH) {
      setError(
        t("vault.keyCreate.err.tooLong", { defaultValue: `标签最长 ${LABEL_MAX_LENGTH} 个字符`, max: LABEL_MAX_LENGTH })
      );
      return;
    }
    setBusy(true);
    try {
      const ref = await onCreate(trimmed);
      setCreated(ref);
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.keyCreate.err.failed", { defaultValue: "创建失败" }));
    } finally {
      setBusy(false);
    }
  }

  // 复制完整公钥。硬切换 003 收尾：复制永远是完整 publicKeyHex。
  async function copyPubkey() {
    if (!created?.publicKeyHex) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(created.publicKeyHex);
      }
    } catch {
      // 静默：用户仍可手动选中复制
    }
  }

  const canSubmit = !busy && label.trim().length > 0 && label.trim().length <= LABEL_MAX_LENGTH;

  return (
    <Modal
      open={open}
      title={
        phase === "form"
          ? t("vault.keyCreate.title", { defaultValue: "新建 Key" })
          : t("vault.keyCreate.successTitle", { defaultValue: "Key 已创建并设为 active" })
      }
      onClose={close}
      footer={
        phase === "form" ? (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t("common.action.cancel", { defaultValue: "取消" })}
            </Button>
            <Button onClick={submit} loading={busy} disabled={!canSubmit}>
              {t("vault.keyCreate.submit", { defaultValue: "新建 Key" })}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t("vault.keyCreate.later", { defaultValue: "稍后" })}
            </Button>
            <Button
              onClick={() => {
                if (created) onExport(created);
                onClose();
              }}
              disabled={busy}
            >
              {t("vault.keyCreate.exportBackup", { defaultValue: "导出加密备份" })}
            </Button>
          </>
        )
      }
    >
      {phase === "form" ? (
        <>
          <p className="vault-create-modal__hint">
            {t("vault.keyCreate.hint", {
              defaultValue:
                "Vault 会在浏览器内安全生成一把新的 secp256k1 私钥，并立即用当前密码加密保存。生成成功后会自动设为 active key。"
            })}
          </p>
          <TextInput
            label={t("vault.keyCreate.label", { defaultValue: "标签" })}
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            error={error ?? undefined}
            placeholder={t("vault.keyCreate.placeholder", { defaultValue: "例如：Key 2026-06-06 14:30" })}
            maxLength={LABEL_MAX_LENGTH}
            autoFocus
          />
          <p className="vault-create-modal__note">
            {t("vault.keyCreate.note", { defaultValue: "标签不要求唯一；后续管理列表按公钥区分。" })}
          </p>
        </>
      ) : (
        created ? (
          <div className="vault-create-modal__success">
            <p className="vault-create-modal__success-line">
              <span className="vault-create-modal__success-label">
                {t("vault.keyCreate.success.label", { defaultValue: "标签" })}
              </span>
              <span>{created.label}</span>
            </p>
            <p className="vault-create-modal__success-line">
              <span className="vault-create-modal__success-label">
                {t("vault.keyCreate.success.publicKey", { defaultValue: "公钥" })}
              </span>
              {created.publicKeyHex ? (
                <code>{formatShortPublicKey(created.publicKeyHex)}</code>
              ) : (
                <code>—</code>
              )}
            </p>
            {created.publicKeyHex ? (
              <p className="vault-create-modal__success-line vault-create-modal__success-actions">
                <Button size="sm" variant="secondary" onClick={copyPubkey}>
                  {t("vault.keyCreate.copyPubkey", { defaultValue: "复制完整公钥" })}
                </Button>
              </p>
            ) : null}
            <p className="vault-create-modal__warning">
              {t("vault.keyCreate.warning", {
                defaultValue:
                  "该 Key 只保存在当前浏览器的本地 Vault 中。清除浏览器数据、设备损坏或忘记 Vault 密码都可能导致无法恢复，请尽快导出加密备份。"
              })}
            </p>
          </div>
        ) : null
      )}
    </Modal>
  );
}
