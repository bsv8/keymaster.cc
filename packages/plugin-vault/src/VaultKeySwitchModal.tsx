import { useState } from "react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import { formatShortPublicKey } from "@keymaster/contracts";
import type { CoordinatorCommandResult, KeyIdentity, VaultService } from "@keymaster/contracts";

/** Key 切换只接受当前桶密码；Hold 是私钥密文的唯一解密入口。 */
export function VaultKeySwitchModal(props: {
  target: KeyIdentity | null;
  vault: VaultService;
  onActivated(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resultError(result: CoordinatorCommandResult): string | null {
    if (result.status === "accepted" || result.status === "ok") return null;
    if ("message" in result) return result.message;
    if (result.status === "blocked") {
      return typeof result.reason === "string" ? result.reason : result.reason.fallback;
    }
    return `Failed to switch key: ${result.status}`;
  }

  async function submit() {
    if (!props.target?.publicKeyHex || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await props.vault.activateKey({
        publicKeyHex: props.target.publicKeyHex,
        password
      });
      const message = resultError(result);
      if (message) {
        setError(message);
        return;
      }
      props.onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vault.keySwitch.err.failed", { defaultValue: "切换私钥失败" }));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    setPassword("");
    setError(null);
    props.onClose();
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
        <p>{t("vault.keySwitch.passwordHint", { defaultValue: "输入桶密码解锁并切换到这把私钥。" })}</p>
        <div className="key-switch-method__password">
          <TextInput
            label={t("vault.keySwitch.password", { defaultValue: "桶密码" })}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            error={error ?? undefined}
            disabled={busy}
            autoFocus
          />
          <Button onClick={() => void submit()} loading={busy} disabled={!password || busy}>
            {t("vault.keySwitch.passwordSubmit", { defaultValue: "使用密码解锁" })}
          </Button>
        </div>
      </section>
    </Modal>
  );
}
