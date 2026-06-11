// packages/plugin-vault/src/VaultKeyDeleteModal.tsx
// 私钥删除 modal：硬切换 002 改为"重新输入锁屏密码"作为删除授权。
// 设计缘由：
//   - 删除是不可逆且涉及资产丢失的危险操作。仅"输入指纹 / 标签"只能
//     防误触，不能证明操作者仍掌握锁屏密码——其他入口也能绕开。
//   - 收口到平台：modal 只负责收集密码与风险提示，**不**自己校验
//     密码真伪；真正的校验由 `keyspace.deleteKey* -> vault.verifyPassword`
//     在 service 层完成。这样未来命令面板 / 快捷操作等入口也会被同
//     一套删除授权约束。
//   - 提供"导出备份"按钮，但**不强制**导出后才能继续删除。
//   - 错误信息透传平台错误（密码错误、namespace DB blocked、空 vault
//     finalize 失败等），用英文展示给用户。
//
// 不能这样改（施工单 §不能怎么做 / §3 部分）：
//   - 不能再要求"输入指纹 / 标签 / publicKeyHash"——这些都是公开信息。
//   - 不能把密码缓存到 modal 外的长期 state；提交后 setState 清空。
//   - 不能要求"输入指纹 + 输入密码"叠加复杂度。
//   - 不能在 modal 内部根据本地 keys.length 预测是否要跳欢迎页；状态
//     源是 vault.status()，由 App 自然切壳。
//
// 硬切换 003：所有展示文案走 i18n。

import { useState } from "react";
import { Button, Modal } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";

export interface VaultKeyDeleteModalProps {
  open: boolean;
  keyLabel: string;
  /** 可选展示用指纹；仅用于让用户在 warning step 复核目标 key。 */
  keyFingerprint?: string;
  onExportBackup?(): void;
  /**
   * 用户在最终 step 输入的锁屏密码会原样回传；调用方再把它喂给
   * `keyspace.deleteKeyById({ keyId, password })`。modal **不**校验密码
   * 真伪——校验在 `vault.verifyPassword` 中完成。
   */
  onConfirmDelete(password: string): Promise<void> | void;
  onClose(): void;
}

type Step = "warning" | "final";

export function VaultKeyDeleteModal({
  open,
  keyLabel,
  keyFingerprint,
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
  const [password, setPassword] = useState("");

  function close() {
    if (busy) return;
    setStep("warning");
    setError(null);
    setPassword("");
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
      await onConfirmDelete(password);
      // 删除成功后清空 modal 状态——尤其密码字段，避免下次打开仍残留。
      setStep("warning");
      setError(null);
      setPassword("");
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("vault.keyDelete.err.failed", { defaultValue: "删除失败" })
      );
    } finally {
      setBusy(false);
    }
  }

  // 必须输入非空密码才能点击确认；真伪由平台校验。
  const canConfirm = password.length > 0;

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
            {t("vault.keyDelete.passwordPrompt", {
              defaultValue: "请输入锁屏密码以确认删除："
            })}
          </p>
          <input
            className="vault-delete-warning__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            autoFocus
          />
          {error ? <p className="vault-delete-warning__error">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
