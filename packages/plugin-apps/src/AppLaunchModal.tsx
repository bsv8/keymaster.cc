import { useWalletState } from "@keymaster/runtime";
import { sameWalletSession, type VaultLifecycleSnapshot, requireUnlockedWalletIdentity } from "@keymaster/contracts";
// packages/plugin-apps/src/AppLaunchModal.tsx
// appView 启动授权 modal：确认当前唯一 Key 的身份 + 输入 Vault 密码。
//
// 设计缘由：
//   - 单 Key 本地钱包（docs/存储.md）之后 appView 只能绑定当前唯一 Key，
//     所以这里没有 Key 选择器：只读展示这把 Key 的身份，并要求重新输入
//     密码来创建独立 appView session；
//   - modal 只收集输入，不直接调用 protocol service。

import { useEffect, useRef, useState } from "react";
import { usePluginCapability } from "webloom-framework/react";
import { usePluginI18n } from "@keymaster/runtime";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { VAULT_WALLET_STATE_CAPABILITY, formatShortPublicKey, type KeyIdentity } from "@keymaster/contracts";
import type { AppCatalogEntry } from "./catalog.js";

export interface AppLaunchModalProps {
  open: boolean;
  entry: AppCatalogEntry | null;
  busy?: boolean;
  error?: string | null;
  onClose(): void;
  onConfirm(input: { publicKeyHex: string; password: string }): Promise<void>;
}

export function AppLaunchModal({
  open,
  entry,
  busy = false,
  error = null,
  onClose,
  onConfirm
}: AppLaunchModalProps) {
  const walletState = useWalletState();
  const { t } = usePluginI18n();
  const [currentKey, setCurrentKey] = useState<KeyIdentity | null>(null);
  const [password, setPassword] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  const close = useRef(onClose);
  close.current = onClose;
  const boundSession = useRef<Readonly<VaultLifecycleSnapshot>>();

  // @resource-boundary allow: wallet-session-form-safety
  useEffect(() => {
    if (!open) return;
    const initial = walletState.snapshot();
    boundSession.current = initial;
    setPassword("");
    setLoadError(null);
    try { setCurrentKey(requireUnlockedWalletIdentity(initial)); }
    catch {
      setCurrentKey(null);
      setLoadError(t("apps.launch.error.noKeys", { defaultValue: "No Vault key is available." }));
    }
    // This subscription only withdraws credentials and closes this form.
    return walletState.subscribe(state => {
      if (!sameWalletSession(initial, state)) {
        boundSession.current = undefined;
        setPassword("");
        setCurrentKey(null);
        close.current();
      }
    });
  }, [walletState, open, t]);

  useEffect(() => {
    if (!open) {
      setPassword("");
      setLoadError(null);
    }
  }, [open]);

  async function submit() {
    if (!currentKey || !password || !entry || !boundSession.current || !sameWalletSession(boundSession.current, walletState.snapshot())) return;
    await onConfirm({ publicKeyHex: currentKey.publicKeyHex, password });
  }

  return (
    <Modal
      open={open}
      title={
        entry
          ? t("apps.launch.title", {
              defaultValue: `Open ${entry.name}`
            })
          : t("apps.launch.titleFallback", { defaultValue: "Open App" })
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy} data-testid="app-launch-cancel">
            {t("common.action.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={busy || !password || currentKey === null}
            data-testid="app-launch-confirm"
          >
            {t("apps.open.cta", { defaultValue: "Open App" })}
          </Button>
        </>
      }
      data-testid="app-launch-modal"
    >
      {entry ? (
        <div className="apps-launch-modal__meta">
          <div className="apps-launch-modal__name">{entry.name}</div>
          <div className="apps-launch-modal__origin">{entry.appOrigin}</div>
          {entry.summary ? <div className="apps-launch-modal__summary">{entry.summary}</div> : null}
        </div>
      ) : null}
      <div className="apps-launch-modal__identity" data-testid="app-launch-identity">
        <span className="apps-launch-modal__identity-label">
          {t("apps.launch.key", { defaultValue: "Key" })}
        </span>
        <span className="apps-launch-modal__identity-value">
          {currentKey
            ? `${currentKey.label} (${formatShortPublicKey(currentKey.publicKeyHex)})`
            : "\u2014"}
        </span>
        <span className="apps-launch-modal__identity-hint">
          {t("apps.launch.keyHint", {
            defaultValue: "This app session binds to the only key kept in this browser."
          })}
        </span>
      </div>
      {loadError ? <div className="apps-launch-modal__error">{loadError}</div> : null}
      <TextInput
        label={t("apps.launch.password", { defaultValue: "Vault password" })}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        error={error ?? undefined}
      />
      {loadError ? (
        <div className="apps-launch-modal__error">{loadError}</div>
      ) : null}
    </Modal>
  );
}
