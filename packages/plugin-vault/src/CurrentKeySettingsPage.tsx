import { useState } from "react";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";
import { useI18n, usePluginHost } from "@keymaster/runtime";
import { useCapability, useResourceSelector } from "webloom-framework/react";
import { VAULT_SERVICE_CAPABILITY, formatShortPublicKey } from "@keymaster/contracts";
import type { VaultKeyResourceState } from "./manifest.js";
import { VaultKeyExportModal } from "./VaultKeyExportModal.js";

export function CurrentKeySettingsPage() {
  const vault = useCapability(VAULT_SERVICE_CAPABILITY);
  const host = usePluginHost();
  const { t } = useI18n();
  const keyState = useResourceSelector<VaultKeyResourceState, VaultKeyResourceState>(
    host.resourceStore,
    "vault.key-state",
    [],
    (state) => state.data ?? {
      keys: [],
      active: { activePublicKeyHex: undefined },
      initializing: false,
      notice: null
    },
    (a, b) => JSON.stringify(a) === JSON.stringify(b)
  );
  const activePublicKeyHex = keyState.active.activePublicKeyHex;
  const current = keyState.keys.find((key) => key.publicKeyHex === activePublicKeyHex);
  const [exporting, setExporting] = useState(false);

  if (!current || !activePublicKeyHex) {
    return (
      <div className="vault-page current-key-page">
        <PageHeader
          title={t("vault.currentKey.title", { defaultValue: "导出私钥" })}
          description={t("vault.currentKey.description", {
            defaultValue: "下载当前私钥的加密备份，用于迁移或恢复。"
          })}
        />
        <EmptyState
          title={t("vault.currentKey.empty.title", { defaultValue: "当前没有可导出的私钥" })}
          description={t("vault.currentKey.empty.description", {
            defaultValue: "请先创建、导入或激活一把私钥。"
          })}
        />
      </div>
    );
  }

  return (
    <div className="vault-page current-key-page">
      <PageHeader
        title={t("vault.currentKey.title", { defaultValue: "导出私钥" })}
        description={t("vault.currentKey.description", {
          defaultValue: "下载当前私钥的加密备份，用于迁移或恢复。页面不会显示明文私钥。"
        })}
      />

      <section className="current-key-export-card" aria-labelledby="current-key-export-title">
        <div className="current-key-export-card__identity">
          <span>{t("vault.currentKey.identity.label", { defaultValue: "当前私钥" })}</span>
          <strong>{current.label || t("vault.settings.empty.label", { defaultValue: "未命名" })}</strong>
          <code title={current.publicKeyHex}>{formatShortPublicKey(current.publicKeyHex)}</code>
        </div>
        <div className="current-key-export-card__content">
          <h2 id="current-key-export-title">
            {t("vault.currentKey.export.title", { defaultValue: "加密私钥备份" })}
          </h2>
          <p>
            {t("vault.currentKey.export.description", {
              defaultValue: "导出文件包含当前私钥的加密数据，可使用对应凭据恢复。"
            })}
          </p>
          <div className="current-key-export-card__notice" role="note">
            {t("vault.currentKey.export.warning", {
              defaultValue: "请妥善保管下载文件和对应凭据；两者同时泄露可能导致私钥被恢复。"
            })}
          </div>
          <Button onClick={() => setExporting(true)}>
            {t("vault.currentKey.export.action", { defaultValue: "导出私钥" })}
          </Button>
        </div>
      </section>

      {exporting ? (
        <VaultKeyExportModal
          open
          keyLabel={current.label}
          publicKeyHex={current.publicKeyHex}
          onExport={() => vault.exportCurrentKeyBackup()}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </div>
  );
}
