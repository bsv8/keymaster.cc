import { useEffect, useState } from "react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import type { KeyIdentity, PasskeyProtection, VaultService } from "@keymaster/contracts";
import { isWebAuthnPrfAvailable } from "./webauthnPrf.js";

export function VaultPasskeyModal(props: {
  open: boolean;
  keyIdentity: KeyIdentity;
  vault: VaultService;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<PasskeyProtection[]>([]);
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setItems(await props.vault.listPasskeys(props.keyIdentity.publicKeyHex));
  }

  useEffect(() => {
    if (!props.open) return;
    setError(null);
    void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [props.open, props.keyIdentity.publicKeyHex]);

  async function add() {
    if (!label.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.vault.addPasskey({
        publicKeyHex: props.keyIdentity.publicKeyHex,
        label: label.trim(),
        password
      });
      setLabel("");
      setPassword("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.passkey.err.add", { defaultValue: "添加 passkey 失败" }));
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: PasskeyProtection) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.vault.removePasskey({
        publicKeyHex: props.keyIdentity.publicKeyHex,
        passkeyId: item.id
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.passkey.err.remove", { defaultValue: "移除 passkey 失败" }));
    } finally {
      setBusy(false);
    }
  }

  const supported = isWebAuthnPrfAvailable();
  return (
    <Modal
      open={props.open}
      title={t("vault.passkey.title", { defaultValue: "Passkey 保护" })}
      onClose={() => !busy && props.onClose()}
      footer={
        <Button variant="ghost" onClick={props.onClose} disabled={busy}>
          {t("common.action.close", { defaultValue: "关闭" })}
        </Button>
      }
    >
      <p className="vault-passkey__hint">
        {t("vault.passkey.hint", {
          defaultValue: "每个 passkey 使用 WebAuthn PRF 独立加密同一把私钥；Vault 密码保护器会一直保留。"
        })}
      </p>
      <div className="vault-passkey__list">
        <div className="vault-passkey__item">
          <span className="vault-passkey__name">{t("vault.passkey.password", { defaultValue: "Vault 密码" })}</span>
          <span className="vault-passkey__state">{t("vault.passkey.recovery", { defaultValue: "恢复方式 · 始终保留" })}</span>
        </div>
        {items.map((item) => (
          <div className="vault-passkey__item" key={item.id}>
            <span className="vault-passkey__name">{item.label}</span>
            <span className="vault-passkey__state">WebAuthn PRF · {item.rpId}</span>
            <Button variant="ghost" size="sm" onClick={() => void remove(item)} disabled={busy}>
              {t("vault.passkey.remove", { defaultValue: "移除" })}
            </Button>
          </div>
        ))}
      </div>
      {!supported ? (
        <p className="vault-passkey__warning">
          {t("vault.passkey.unsupported", { defaultValue: "当前浏览器或上下文不支持 WebAuthn PRF；请使用 HTTPS 和兼容的 passkey 设备。" })}
        </p>
      ) : null}
      <div className="vault-passkey__form">
        <TextInput
          label={t("vault.passkey.name", { defaultValue: "Passkey 名称" })}
          placeholder={t("vault.passkey.namePlaceholder", { defaultValue: "例如：MacBook Touch ID" })}
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
          disabled={!supported || busy}
        />
        <TextInput
          label={t("vault.passkey.passwordConfirm", { defaultValue: "Vault 密码（仅添加时需要）" })}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          disabled={busy}
        />
        <Button onClick={() => void add()} loading={busy} disabled={!supported || !label.trim() || !password}>
          {t("vault.passkey.add", { defaultValue: "添加 passkey" })}
        </Button>
      </div>
      {error ? <p className="vault-passkey__error">{error}</p> : null}
    </Modal>
  );
}
