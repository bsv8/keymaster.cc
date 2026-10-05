import type { InternalVaultService } from "./internalVaultService.js";
// packages/plugin-vault/src/VaultResetWalletModal.tsx
// 重置钱包确认框。
//
// 这是"更换钱包身份"的唯一入口。单 Key 存储不提供删除单把 Key 或原地替换
// 身份：要换一把 Key，只能重置钱包后重新创建或导入，而重置会删除当前 Key
// 和新结构中的全部本地钱包数据（联系人、消息、设置、模块数据与 App 数据）。
//
// 确认方式用**钱包名称**而不是 Key 名称：删除的不是一个对象而是整个钱包，
// 用 Key 标签确认会让人误以为只影响那把 Key。用户必须原样输入当前 Key 的
// 显示名才能提交。
//
// 明确说明的边界：重置只清本地数据，不撤销链上交易，也不回滚服务端已经
// 接受的操作——那类结果按对应业务的恢复规则处理。

import { useEffect, useState } from "react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { usePluginI18n } from "@keymaster/runtime";


export interface VaultResetWalletModalProps {
  open: boolean;
  vault: InternalVaultService;
  onClose(): void;
}

export function VaultResetWalletModal({ open, vault, onClose }: VaultResetWalletModalProps) {
  const { t } = usePluginI18n();
  // 触发 languageChanged 重渲染。
  const [confirmation, setConfirmation] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirmation("");
    setError(null);
    setBusy(false);
    void vault.getCurrentKey()
      .then((key) => setLabel(key?.label ?? ""))
      .catch(() => setLabel(""));
  }, [open, vault]);

  // 标签为空时无法要求用户"输入名称确认"，否则空标签会让确认条件恒真。
  const canSubmit = !busy && label.length > 0 && confirmation === label;

  function close() {
    if (busy) return;
    setConfirmation("");
    setError(null);
    setBusy(false);
    onClose();
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await vault.resetWallet({ confirmationLabel: confirmation });
      setConfirmation("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.resetWallet.err.failed", { defaultValue: "重置失败" }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("vault.resetWallet.title", { defaultValue: "重置钱包" })}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("common.action.cancel", { defaultValue: "取消" })}
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy} disabled={!canSubmit}>
            {t("vault.resetWallet.submit", { defaultValue: "永久删除本地钱包数据" })}
          </Button>
        </>
      }
    >
      <div className="vault-reset-wallet-modal__danger" role="alert">
        <p>
          {t("vault.resetWallet.danger", {
            defaultValue:
              "重置会删除当前钱包 Key 以及新存储结构中的全部本地钱包数据：联系人、消息记录、设置、模块数据和第三方 App 数据都将被清空，且无法撤销。"
          })}
        </p>
        <p>
          {t("vault.resetWallet.scope", {
            defaultValue:
              "这不会撤销链上交易或服务端已经接受的操作；那类结果按对应业务的恢复规则处理。旧的备份文件（KeyHold 导出）不会自动失效。"
          })}
        </p>
        <p>
          {t("vault.resetWallet.replace", {
            defaultValue: "之后可以重新创建一把新 Key，或导入已有私钥；新钱包不会继承这里的任何数据。"
          })}
        </p>
      </div>
      <TextInput
        label={t("vault.resetWallet.confirmPrompt", { defaultValue: "输入当前钱包名称以确认：" })}
        value={confirmation}
        onChange={(e) => setConfirmation(e.currentTarget.value)}
        required
        error={error ?? undefined}
      />
    </Modal>
  );
}
