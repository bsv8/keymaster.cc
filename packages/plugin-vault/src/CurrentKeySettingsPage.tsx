import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, EmptyState, PageHeader, TextInput } from "@keymaster/ui";
import {
  router,
  useCapability,
  useI18n,
  useLocale,
  usePluginHost,
  useResourceSelector
} from "@keymaster/runtime";
import { formatShortPublicKey } from "@keymaster/contracts";
import type { PasskeyProtection, VaultService } from "@keymaster/contracts";
import type { VaultKeyResourceState } from "./manifest.js";
import {
  isWebAuthnPrfAvailable,
  PasskeyPrfOnCreateRequiredError
} from "./webauthnPrf.js";
import { VaultKeyExportModal } from "./VaultKeyExportModal.js";

export function CurrentKeySettingsPage() {
  const vault = useCapability<VaultService>("vault.service");
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
  const [passkeys, setPasskeys] = useState<PasskeyProtection[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const supported = isWebAuthnPrfAvailable();
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale]
  );

  const refreshPasskeys = useCallback(async () => {
    if (!activePublicKeyHex) {
      setPasskeys([]);
      return;
    }
    setPasskeys(await vault.listCurrentKeyPasskeys());
  }, [activePublicKeyHex, vault]);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setLabel("");
    setExporting(false);
    void refreshPasskeys().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [activePublicKeyHex, refreshPasskeys]);

  async function addPasskey() {
    const trimmed = label.trim();
    if (!trimmed || loading || removingId) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await vault.addPasskeyToCurrentKey({ label: trimmed });
      setLabel("");
      await refreshPasskeys();
      setNotice(t("vault.currentKey.passkeys.added", { defaultValue: "Passkey 已添加到当前私钥。" }));
    } catch (err) {
      setError(
        err instanceof PasskeyPrfOnCreateRequiredError
          ? t("vault.passkey.err.singleStepRequired", {
              defaultValue: "本次 Passkey 创建没有直接返回 PRF（不代表 Chrome 不支持 PRF），严格单次模式下 KeyMaster 未添加它；Passkey 管理器中可能仍保留刚创建的凭证。"
            })
          : err instanceof Error
            ? err.message
            : t("vault.passkey.err.add", { defaultValue: "添加 passkey 失败" })
      );
    } finally {
      setLoading(false);
    }
  }

  async function removePasskey(passkeyId: string) {
    if (loading || removingId) return;
    setRemovingId(passkeyId);
    setError(null);
    setNotice(null);
    try {
      await vault.removePasskeyFromCurrentKey({ passkeyId });
      await refreshPasskeys();
      setNotice(t("vault.currentKey.passkeys.removed", { defaultValue: "Passkey 已移除。" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.passkey.err.remove", { defaultValue: "移除 passkey 失败" }));
    } finally {
      setRemovingId(null);
    }
  }

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
          description={t("vault.currentKey.description", { defaultValue: "管理当前 active 私钥的保护方式与加密备份。" })}
        />
        <EmptyState
          title={t("vault.currentKey.empty.title", { defaultValue: "当前没有可管理的私钥" })}
          description={t("vault.currentKey.empty.description", { defaultValue: "请先到 Key 管理中创建、导入或激活一把 Key。" })}
          action={<Button onClick={() => router.push("/settings/vault")}>{t("vault.currentKey.empty.action", { defaultValue: "前往 Key 管理" })}</Button>}
        />
      </div>
    );
  }

  return (
    <div className="vault-page current-key-page">
      <PageHeader
        title={t("vault.currentKey.title", { defaultValue: "当前私钥管理" })}
        description={t("vault.currentKey.description", { defaultValue: "管理当前 active 私钥的保护方式与加密备份。" })}
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
            <p>{t("vault.currentKey.protection.description", { defaultValue: "每种保护方式都能独立恢复同一把私钥。" })}</p>
          </div>
        </div>
        <div className="current-key-protectors">
          <div className="current-key-protector">
            <div>
              <strong>{t("vault.passkey.password", { defaultValue: "Vault 密码" })}</strong>
              <span>{t("vault.passkey.recovery", { defaultValue: "恢复方式 · 始终保留" })}</span>
            </div>
            <span className="current-key-protector__status">{t("vault.currentKey.protection.available", { defaultValue: "可用" })}</span>
          </div>
          {passkeys.map((passkey) => (
            <div className="current-key-protector" key={passkey.id}>
              <div>
                <strong>{passkey.label}</strong>
                <span>WebAuthn PRF · {passkey.rpId} · {dateFmt.format(new Date(passkey.createdAt))}</span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                loading={removingId === passkey.id}
                disabled={loading || Boolean(removingId)}
                onClick={() => void removePasskey(passkey.id)}
              >
                {t("vault.passkey.remove", { defaultValue: "移除" })}
              </Button>
            </div>
          ))}
        </div>
        {!supported ? (
          <p className="vault-passkey__warning">{t("vault.passkey.unsupported", { defaultValue: "当前浏览器或上下文不支持 WebAuthn PRF；请使用 HTTPS 和兼容的 passkey 设备。" })}</p>
        ) : null}
        <div className="current-key-passkey-add">
          <TextInput
            label={t("vault.passkey.name", { defaultValue: "Passkey 名称" })}
            placeholder={t("vault.passkey.namePlaceholder", { defaultValue: "例如：MacBook Touch ID" })}
            value={label}
            maxLength={64}
            disabled={!supported || loading || Boolean(removingId)}
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
          <Button
            loading={loading}
            disabled={!supported || !label.trim() || Boolean(removingId)}
            onClick={() => void addPasskey()}
          >
            {t("vault.passkey.add", { defaultValue: "添加 Passkey" })}
          </Button>
        </div>
      </section>

      <section className="current-key-section current-key-backup" aria-labelledby="current-key-backup-title">
        <div>
          <h2 id="current-key-backup-title">{t("vault.currentKey.backup.title", { defaultValue: "加密备份" })}</h2>
          <p>{t("vault.keyExport.hint", { defaultValue: "JSON 备份包含密码保护器和全部 Passkey 保护器；任一可用保护器都能恢复同一把私钥。" })}</p>
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
