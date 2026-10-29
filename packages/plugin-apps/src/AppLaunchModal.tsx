import { useEffect, useRef, useState } from "react";
import { useWalletState, usePluginI18n } from "@keymaster/runtime";
import { sameWalletSession, type VaultLifecycleSnapshot, requireUnlockedWalletIdentity, formatShortPublicKey, type KeyIdentity } from "@keymaster/contracts";
import { Button, Modal } from "@keymaster/ui";
import type { AppCatalogEntry } from "./catalog.js";

export interface AppLaunchModalProps {
  open: boolean;
  entry: AppCatalogEntry | null;
  busy?: boolean;
  error?: string | null;
  onClose(): void;
  onConfirm(): Promise<void>;
}

/** 只确认应用与当前钱包身份；私钥已在正常解锁流程就绪，不重复收集密码。 */
export function AppLaunchModal({ open, entry, busy = false, error = null, onClose, onConfirm }: AppLaunchModalProps) {
  const walletState = useWalletState();
  const { t } = usePluginI18n();
  const [currentKey, setCurrentKey] = useState<KeyIdentity | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const boundSession = useRef<Readonly<VaultLifecycleSnapshot>>();

  // @resource-boundary allow: wallet-session-form-safety
  useEffect(() => {
    if (!open) return;
    const initial = walletState.snapshot();
    boundSession.current = initial;
    setLoadError(null);
    try { setCurrentKey(requireUnlockedWalletIdentity(initial)); }
    catch { setCurrentKey(null); setLoadError("Unlock the wallet before opening an application."); }
    // 确认期间发生锁定或代际变化，立即撤回旧表单，不能替它换成新钱包。
    return walletState.subscribe(state => {
      if (!sameWalletSession(initial, state)) {
        boundSession.current = undefined;
        setCurrentKey(null);
        close.current();
      }
    });
  }, [walletState, open]);

  async function submit() {
    if (busy || !currentKey || !entry || !boundSession.current || !sameWalletSession(boundSession.current, walletState.snapshot())) return;
    await onConfirm();
  }
  return <Modal open={open} title={entry ? t("apps.launch.title", { defaultValue: `Open ${entry.name}` }) : t("apps.launch.titleFallback", { defaultValue: "Open App" })} onClose={onClose} data-testid="app-launch-modal" footer={<>
    <Button variant="ghost" onClick={onClose} disabled={busy} data-testid="app-launch-cancel">{t("common.action.cancel", { defaultValue: "Cancel" })}</Button>
    <Button onClick={() => void submit()} loading={busy} disabled={busy || currentKey === null} data-testid="app-launch-confirm">{t("apps.open.cta", { defaultValue: "Open App" })}</Button>
  </>}>
    {entry ? <div className="apps-launch-modal__meta"><div className="apps-launch-modal__name">{entry.name}</div><div className="apps-launch-modal__origin">{entry.appOrigin}</div>{entry.summary ? <div className="apps-launch-modal__summary">{entry.summary}</div> : null}</div> : null}
    <div className="apps-launch-modal__identity" data-testid="app-launch-identity"><span className="apps-launch-modal__identity-label">{t("apps.launch.key", { defaultValue: "Key" })}</span><span className="apps-launch-modal__identity-value">{currentKey ? `${currentKey.label} (${formatShortPublicKey(currentKey.publicKeyHex)})` : "—"}</span><span className="apps-launch-modal__identity-hint">{t("apps.launch.keyHint", { defaultValue: "This app session binds to the only key kept in this browser." })}</span></div>
    {loadError || error ? <div className="apps-launch-modal__error" role="alert">{error ?? loadError}</div> : null}
  </Modal>;
}
