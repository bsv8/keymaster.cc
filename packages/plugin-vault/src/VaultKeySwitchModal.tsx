import { useEffect, useState } from "react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import { useOptionalCapability } from "webloom-framework/react";
import { STORAGE_RUNTIME_CONTROLLER_CAPABILITY, formatShortPublicKey } from "@keymaster/contracts";
import type {
  CoordinatorCommandResult,
  KeyIdentity,
  PasskeyProtection,
  VaultService
} from "@keymaster/contracts";

export function VaultKeySwitchModal(props: {
  target: KeyIdentity | null;
  vault: VaultService;
  onActivated(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const storage = useOptionalCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const isCatalogBucket = storage?.isCatalogBucket?.() === true;
  const [password, setPassword] = useState("");
  const [passkeys, setPasskeys] = useState<PasskeyProtection[]>([]);
  const [loadingPasskeys, setLoadingPasskeys] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passkeyBusyId, setPasskeyBusyId] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const busy = passwordBusy || passkeyBusyId !== null;

  useEffect(() => {
    setPassword("");
    setPasskeys([]);
    setPasswordError(null);
    setPasskeyError(null);
    if (!props.target?.publicKeyHex || isCatalogBucket) return;
    let live = true;
    setLoadingPasskeys(true);
    void props.vault.listPasskeysForKey(props.target.publicKeyHex)
      .then((items) => { if (live) setPasskeys(items); })
      .catch((err) => { if (live) setPasskeyError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (live) setLoadingPasskeys(false); });
    return () => { live = false; };
  }, [props.target?.publicKeyHex, props.vault, isCatalogBucket]);

  function resultError(result: CoordinatorCommandResult): string | null {
    if (result.status === "accepted" || result.status === "ok") return null;
    if ("message" in result) return result.message;
    if (result.status === "blocked") {
      return typeof result.reason === "string" ? result.reason : result.reason.fallback;
    }
    return `Failed to switch key: ${result.status}`;
  }

  async function submitPassword() {
    if (!props.target?.publicKeyHex || !password || busy) return;
    setPasswordBusy(true);
    setPasswordError(null);
    try {
      const result = await props.vault.activateKey({
        publicKeyHex: props.target.publicKeyHex,
        password
      });
      const message = resultError(result);
      if (message) {
        setPasswordError(message);
        return;
      }
      props.onActivated();
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : t("vault.keySwitch.err.failed", { defaultValue: "切换私钥失败" }));
    } finally {
      // 密码只服务本次解锁请求；无论成功、失败还是 RPC 被拒绝，都不
      // 留在输入组件的 React 状态中。
      setPassword("");
      setPasswordBusy(false);
    }
  }

  function close() {
    if (busy) return;
    setPassword("");
    setPasswordError(null);
    setPasskeyError(null);
    props.onClose();
  }

  async function submitPasskey(passkeyId: string) {
    if (busy) return;
    setPasskeyBusyId(passkeyId);
    setPasskeyError(null);
    try {
      const result = await props.vault.activateKeyWithPasskey({ passkeyId });
      const message = resultError(result);
      if (message) {
        setPasskeyError(message);
        return;
      }
      props.onActivated();
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : t("vault.keySwitch.passkeyFailed", { defaultValue: "Passkey 验证失败" }));
    } finally {
      setPasskeyBusyId(null);
    }
  }

  const unnamed = t("vault.keySwitch.unnamed", { defaultValue: "未命名" });
  return (
    <Modal
      open={props.target !== null}
      title={t("vault.keySwitch.confirmTitle", { defaultValue: "切换私钥" })}
      onClose={close}
      footer={
        <Button variant="ghost" onClick={close} disabled={busy}>
          {t("common.action.cancel", { defaultValue: "取消" })}
        </Button>
      }
    >
      {props.target ? (
        <p className="key-switch__confirm-target">
          {props.target.label || unnamed}{" "}
          <code>{formatShortPublicKey(props.target.publicKeyHex)}</code>
        </p>
      ) : null}

      <section className="key-switch-method" aria-labelledby="key-switch-password-title">
        <h3 id="key-switch-password-title">{t("vault.keySwitch.usePassword", { defaultValue: "使用密码" })}</h3>
        <p>{t("vault.keySwitch.passwordHint", { defaultValue: "输入 Vault 密码解锁并切换到这把私钥。" })}</p>
        <div className="key-switch-method__password">
          <TextInput
            label={t("vault.keySwitch.password", { defaultValue: isCatalogBucket ? "桶密码" : "Vault 密码" })}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitPassword();
            }}
            error={passwordError ?? undefined}
            disabled={busy}
            autoFocus
          />
          <Button onClick={() => void submitPassword()} loading={passwordBusy} disabled={!password || busy}>
            {t("vault.keySwitch.passwordSubmit", { defaultValue: "使用密码解锁" })}
          </Button>
        </div>
      </section>

      {!isCatalogBucket ? <>
        <div className="key-switch-method-divider"><span>{t("vault.keySwitch.or", { defaultValue: "或" })}</span></div>

        <section className="key-switch-method" aria-labelledby="key-switch-passkey-title">
          <h3 id="key-switch-passkey-title">{t("vault.keySwitch.usePasskey", { defaultValue: "使用 Passkey" })}</h3>
          <p>{t("vault.keySwitch.passkeyHint", { defaultValue: "选择这把私钥已经配置的 Passkey。" })}</p>
          <div className="key-switch-passkey-list">
            {passkeys.map((passkey) => (
              <Button
                key={passkey.id}
                variant="secondary"
                loading={passkeyBusyId === passkey.id}
                disabled={busy}
                onClick={() => void submitPasskey(passkey.id)}
              >
                {passkey.label}
              </Button>
            ))}
            {!loadingPasskeys && passkeys.length === 0 ? (
              <p className="key-switch-passkey-empty">{t("vault.keySwitch.noPasskeys", { defaultValue: "这把私钥尚未配置 Passkey。" })}</p>
            ) : null}
            {loadingPasskeys ? <p className="key-switch-passkey-empty">{t("common.status.loading", { defaultValue: "加载中…" })}</p> : null}
          </div>
          {passkeyError ? <p className="vault-passkey__error">{passkeyError}</p> : null}
        </section>
      </> : null}
    </Modal>
  );
}
