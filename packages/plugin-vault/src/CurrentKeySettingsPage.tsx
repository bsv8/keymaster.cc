// packages/plugin-vault/src/CurrentKeySettingsPage.tsx
// 唯一钱包 Key 的管理页。
//
// 单 Key 本地存储（docs/存储.md）之后，这一页就是"Key 管理"的全部：
//   - 展示当前 Key 的公开信息与钱包身份世代；
//   - 改名、改密、导出加密 KeyHold、锁定、重置钱包。
//
// 它刻意**没有**：Key 列表、新建第二把 Key、切换 Key、删除 Key、导入备份。
// 替换身份的唯一路径是"重置钱包后重新创建或导入"，而重置会删掉全部本地
// 钱包数据，所以必须由一个明确的破坏性确认框把关，不能混在普通操作里。

import { useEffect, useState } from "react";
import { Button, Modal, PageHeader, TextInput } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import { useCapability } from "webloom-framework/react";
import {
  VAULT_SERVICE_CAPABILITY,
  formatShortPublicKey,
  type VaultLifecycleSnapshot,
  type VaultService,
} from "@keymaster/contracts";
import { VaultChangePasswordModal } from "./VaultChangePasswordModal.js";
import { VaultKeyHoldExportModal } from "./VaultKeyHoldExportModal.js";
import { VaultResetWalletModal } from "./VaultResetWalletModal.js";

export function CurrentKeySettingsPage() {
  const vault = useCapability(VAULT_SERVICE_CAPABILITY);
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<VaultLifecycleSnapshot>(() => vault.getLifecycleSnapshot());
  const [label, setLabel] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => vault.onLifecycleChange(setSnapshot), [vault]);

  const publicKeyHex = snapshot.activePublicKeyHex;
  // 显示名由 vault 单独读取：lifecycle 事件只带公钥，避免每个会话事件都
  // 附带一份 Key 元数据。
  const [currentLabel, setCurrentLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!publicKeyHex) { setCurrentLabel(null); return; }
    void vault.getCurrentKey()
      .then((key) => { if (!cancelled) setCurrentLabel(key?.label ?? null); })
      .catch(() => { if (!cancelled) setCurrentLabel(null); });
    return () => { cancelled = true; };
  }, [vault, publicKeyHex, snapshot.runGeneration, snapshot.walletGeneration]);

  async function submitRename() {
    const next = (label ?? currentLabel ?? "").trim();
    if (!next) {
      setError(t("vault.settings.err.renameEmpty", { defaultValue: "名称不能为空" }));
      return;
    }
    setRenamingBusy(true);
    setError(null);
    try {
      await vault.renameKey(next);
      setCurrentLabel(next);
      setRenaming(false);
      setLabel(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.settings.err.rename", { defaultValue: "重命名失败" }));
    } finally {
      setRenamingBusy(false);
    }
  }

  async function lockNow() {
    setError(null);
    const result = await vault.lock();
    if (result.status !== "accepted" && result.status !== "ok" && result.status !== "stale-epoch") {
      setError("message" in result ? result.message : `${t("vault.settings.err.lock", { defaultValue: "锁定失败" })}: ${result.status}`);
    }
  }

  if (!publicKeyHex) {
    return (
      <div className="vault-page current-key-page">
        <PageHeader
          title={t("vault.currentKey.title", { defaultValue: "钱包 Key" })}
          description={t("vault.currentKey.description", {
            defaultValue: "本 Origin 只保存一把钱包 Key。解锁后可管理它的名称、密码和加密导出。"
          })}
        />
        <p className="vault-page__notice" role="note">
          {t("vault.currentKey.locked.hint", {
            defaultValue: "钱包当前处于锁定状态，解锁后可管理 Key。"
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="vault-page current-key-page">
      <PageHeader
        title={t("vault.currentKey.title", { defaultValue: "钱包 Key" })}
        description={t("vault.currentKey.description", {
          defaultValue: "本 Origin 只保存一把钱包 Key。替换身份需要先重置钱包，那会删除全部本地钱包数据。"
        })}
      />

      <section className="current-key-export-card" aria-labelledby="current-key-export-title">
        <div className="current-key-export-card__identity">
          <span>{t("vault.currentKey.identity.label", { defaultValue: "当前 Key" })}</span>
          <strong>{currentLabel || t("vault.settings.empty.label", { defaultValue: "未命名" })}</strong>
          <code title={publicKeyHex}>{formatShortPublicKey(publicKeyHex)}</code>
        </div>
        <div className="current-key-export-card__content">
          <h2 id="current-key-export-title">
            {t("vault.currentKey.export.title", { defaultValue: "加密 KeyHold 导出" })}
          </h2>
          <p>
            {t("vault.currentKey.export.description", {
              defaultValue: "导出文件就是本地 key.json 的原样副本，保持既有加密格式。"
            })}
          </p>
          <div className="current-key-export-card__notice" role="note">
            {t("vault.currentKey.export.notBackup", {
              defaultValue:
                "该文件只含钱包 Key，不含联系人、消息、设置等本地业务数据，不能当作完整钱包备份。"
            })}
          </div>
          <Button onClick={() => setExporting(true)}>
            {t("vault.currentKey.export.action", { defaultValue: "导出 KeyHold" })}
          </Button>
        </div>
      </section>

      <section className="vault-key-actions" aria-label={t("vault.settings.actions.title", { defaultValue: "Key 操作" })}>
        <h2>{t("vault.settings.actions.title", { defaultValue: "Key 操作" })}</h2>
        {error ? <p className="vault-page__error" role="alert">{error}</p> : null}
        <div className="vault-key-actions__row">
          <Button
            variant="ghost"
            onClick={() => { setLabel(currentLabel ?? ""); setRenaming(true); }}
          >
            {t("vault.settings.action.rename", { defaultValue: "重命名" })}
          </Button>
          <Button variant="ghost" onClick={() => setChangingPassword(true)}>
            {t("vault.settings.action.changePassword", { defaultValue: "修改密码" })}
          </Button>
          <Button variant="ghost" onClick={() => void lockNow()}>
            {t("vault.settings.action.lock", { defaultValue: "锁定钱包" })}
          </Button>
          <Button variant="danger" onClick={() => setResetting(true)}>
            {t("vault.settings.action.resetWallet", { defaultValue: "重置钱包" })}
          </Button>
        </div>
      </section>

      {renaming ? (
        <Modal
          open
          title={t("vault.settings.rename.title", { defaultValue: "重命名 Key" })}
          onClose={() => setRenaming(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRenaming(false)} disabled={renamingBusy}>
                {t("common.action.cancel", { defaultValue: "取消" })}
              </Button>
              <Button onClick={() => void submitRename()} loading={renamingBusy} disabled={!(label ?? "").trim()}>
                {t("vault.settings.rename.submit", { defaultValue: "保存" })}
              </Button>
            </>
          }
        >
          <TextInput
            label={t("vault.settings.rename.label", { defaultValue: "名称" })}
            value={label ?? ""}
            onChange={(e) => setLabel(e.currentTarget.value)}
            maxLength={64}
            required
          />
        </Modal>
      ) : null}

      {exporting ? (
        <VaultKeyHoldExportModal
          open
          keyLabel={currentLabel ?? ""}
          publicKeyHex={publicKeyHex}
          onExport={() => vault.exportKeyHold()}
          onClose={() => setExporting(false)}
        />
      ) : null}

      {changingPassword ? (
        <VaultChangePasswordModal
          open
          vault={vault as VaultService}
          onClose={() => setChangingPassword(false)}
        />
      ) : null}

      {resetting ? (
        <VaultResetWalletModal
          open
          vault={vault as VaultService}
          onClose={() => setResetting(false)}
        />
      ) : null}
    </div>
  );
}
