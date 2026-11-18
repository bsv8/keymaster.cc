import { PAGE_UI_RENDERER_CAPABILITY } from "@keymaster/contracts";
import { usePluginCapability } from "webloom-framework/react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, useId, type ReactNode } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { usePluginI18n } from "@keymaster/runtime";
import { useInternalVault } from "./VaultInternalContext.js";
import "./screenMask.css";

/** 页面隐私遮罩。子树保持挂载，后台业务不随显示状态退出。 */
export function WalletScreenMask({ children }: { children?: ReactNode }) {
  const vault = useInternalVault();
  const renderer = usePluginCapability(PAGE_UI_RENDERER_CAPABILITY);
  useSyncExternalStore(renderer.subscribe, renderer.revision, renderer.revision);
  const wallet = useSyncExternalStore(listener => vault.subscribeWalletState(listener), () => vault.walletSnapshot());
  const masked = wallet.status === "unlocked" && wallet.screenMasked === true;
  const { t } = usePluginI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = t("shell.mask.title", { defaultValue: "钱包仍在运行" });
  const labelId = useId();
  void labelId;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!masked) { if (element.open) element.close(); setError(null); setPassword(""); return; }
    element.setAttribute("closedby", "none");
    if (!element.open) element.showModal();
    // An asynchronously opened business dialog must not cover the password form.
    const observer = new MutationObserver(records => {
      if (records.some(record => record.target !== element && record.target instanceof HTMLDialogElement && record.target.open)) {
        element.close(); element.showModal();
      }
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
    return () => { observer.disconnect(); if (element.open) element.close(); };
  }, [masked]);
  return <>{children}<dialog ref={dialog} data-wallet-screen-mask className="wallet-screen-mask" aria-label={title}
    onCancel={event => event.preventDefault()}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (busy || !masked || !password) return;
      setBusy(true); setError(null);
      const current = password;
      setPassword("");
      try {
        const result = await vault.unlock(current);
        if (result.status !== "accepted" && result.status !== "ok") {
          setError("message" in result && result.message
            ? result.message
            : t("shell.mask.error", { defaultValue: "无法解除遮罩，请重试。" }));
        }
      } catch (cause) {
        setError(cause instanceof Error && cause.message
          ? cause.message
          : t("shell.mask.error", { defaultValue: "无法解除遮罩，请重试。" }));
      }
      finally { setBusy(false); }
    }}>
      <PageHeader
        title={title}
        description={t("shell.mask.desc", { defaultValue: "钱包此时仍在运行，输入密码进入钱包。" })}
      />
      {renderer.renderFrame("screen-mask-status")}
      <TextInput
        label={t("shell.mask.passwordLabel", { defaultValue: "钱包密码" })}
        type="password"
        autoComplete="current-password"
        autoFocus
        required
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        disabled={busy}
        error={error ?? undefined}
      />
      <div className="wallet-screen-mask__actions">
        <Button type="submit" disabled={busy || !password}>
          {busy
            ? t("shell.mask.verifying", { defaultValue: "验证中…" })
            : t("shell.mask.submit", { defaultValue: "解锁并进入钱包" })}
        </Button>
      </div>
    </form>
  </dialog></>;
}
