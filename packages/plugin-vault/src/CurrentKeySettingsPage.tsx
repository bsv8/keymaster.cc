import { useMemo, useState } from "react";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";
import { useI18n, useLocale, usePluginHost } from "@keymaster/runtime";
import { useCapability, useResourceSelector } from "webloom-framework/react";
import { VAULT_SERVICE_CAPABILITY, formatShortPublicKey } from "@keymaster/contracts";
import type { VaultKeyResourceState } from "./manifest.js";
import { VaultKeyExportModal } from "./VaultKeyExportModal.js";

/** 当前 Key 的只读摘要；私钥解密和 Hold I/O 始终由 Coordinator/Vault 完成。 */
export function CurrentKeySettingsPage() {
  const vault = useCapability(VAULT_SERVICE_CAPABILITY);
  const host = usePluginHost();
  const { t } = useI18n();
  const locale = useLocale();
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale]
  );

  async function copyPublicKey() {
    if (!current?.publicKeyHex) return;
    try {
      await navigator.clipboard.writeText(current.publicKeyHex);
      setNotice(t("vault.settings.notice.copied", { defaultValue: "已复制完整公钥" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.settings.err.copy", { defaultValue: "复制失败" }));
    }
  }

  if (!current || !activePublicKeyHex) {
    return (
      <div className="vault-page current-key-page">
        <PageHeader
          title={t("vault.currentKey.title", { defaultValue: "当前私钥管理" })}
          description={t("vault.currentKey.description", { defaultValue: "查看当前 active 私钥和加密备份。" })}
        />
        <EmptyState
          title={t("vault.currentKey.empty.title", { defaultValue: "当前没有可管理的私钥" })}
          description={t("vault.currentKey.empty.description", { defaultValue: "当前没有可用的 active Key。" })}
        />
      </div>
    );
  }

  return (
    <div className="vault-page current-key-page">
      <PageHeader
        title={t("vault.currentKey.title", { defaultValue: "当前私钥管理" })}
        description={t("vault.currentKey.description", { defaultValue: "查看当前 active 私钥和加密备份。" })}
      />

      {error ? <p className="vault-page__error">{error}</p> : null}
      {notice ? <p className="vault-page__notice">{notice}</p> : null}

      <section className="current-key-section" aria-labelledby="current-key-identity-title">
        <div className="current-key-section__heading">
          <div>
            <h2 id="current-key-identity-title">{current.label || t("vault.settings.empty.label", { defaultValue: "未命名" })}</h2>
            <p>{t("vault.currentKey.identity.active", { defaultValue: "当前 active 私钥" })}</p>
          </div>
          <span className="current-key-active-badge">Active</span>
        </div>
        <dl className="current-key-identity">
          <div>
            <dt>{t("vault.settings.col.pubkey", { defaultValue: "公钥" })}</dt>
            <dd><code>{formatShortPublicKey(current.publicKeyHex)}</code> <Button size="sm" variant="ghost" onClick={() => void copyPublicKey()}>{t("vault.settings.action.copyPubkey", { defaultValue: "复制完整公钥" })}</Button></dd>
          </div>
          <div>
            <dt>{t("vault.settings.col.caps", { defaultValue: "能力" })}</dt>
            <dd>{current.capabilities.join(", ") || "—"}</dd>
          </div>
          <div>
            <dt>{t("vault.settings.col.created", { defaultValue: "创建时间" })}</dt>
            <dd>{dateFmt.format(new Date(current.createdAt))}</dd>
          </div>
        </dl>
      </section>

      <section className="current-key-section" aria-labelledby="current-key-protection-title">
        <div className="current-key-section__heading">
          <div>
            <h2 id="current-key-protection-title">{t("vault.currentKey.protection.title", { defaultValue: "私钥保护" })}</h2>
            <p>{t("vault.currentKey.protection.description", { defaultValue: "当前桶密码通过 Hold 保护私钥密文。" })}</p>
          </div>
        </div>
        <div className="current-key-protectors">
          <div className="current-key-protector">
            <div>
              <strong>{t("vault.currentKey.protection.password", { defaultValue: "桶密码" })}</strong>
              <span>{t("vault.currentKey.protection.passwordDescription", { defaultValue: "Hold 密文保护器 · 可用于解锁和恢复" })}</span>
            </div>
            <span className="current-key-protector__status">{t("vault.currentKey.protection.available", { defaultValue: "可用" })}</span>
          </div>
        </div>
      </section>

      <section className="current-key-section current-key-backup" aria-labelledby="current-key-backup-title">
        <div>
          <h2 id="current-key-backup-title">{t("vault.currentKey.backup.title", { defaultValue: "加密备份" })}</h2>
          <p>{t("vault.keyExport.hint", { defaultValue: "导出当前 Catalog Hold Key 的加密备份。" })}</p>
        </div>
        <Button variant="secondary" onClick={() => setExporting(true)}>
          {t("vault.currentKey.backup.action", { defaultValue: "导出当前私钥备份" })}
        </Button>
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
