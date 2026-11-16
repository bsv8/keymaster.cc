import { useLayoutEffect, useRef, useState, useSyncExternalStore, useId, type ReactNode } from "react";
import { useInternalVault } from "./VaultInternalContext.js";
import "./screenMask.css";

/** 页面隐私遮罩。子树保持挂载，后台业务不随显示状态退出。 */
export function WalletScreenMask({ children }: { children?: ReactNode }) {
  const vault = useInternalVault();
  const wallet = useSyncExternalStore(listener => vault.subscribeWalletState(listener), () => vault.walletSnapshot());
  const masked = wallet.status === "unlocked" && wallet.screenMasked === true;
  const dialog = useRef<HTMLDialogElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleId = useId();
  const passwordId = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!masked) { if (element.open) element.close(); setError(""); if (passwordInput.current) passwordInput.current.value = ""; return; }
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
  return <>{children}<dialog ref={dialog} data-wallet-screen-mask className="wallet-screen-mask" aria-labelledby={titleId}
    onCancel={event => event.preventDefault()}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (busy || !masked || !passwordInput.current?.value) return;
      setBusy(true); setError("");
      const password = passwordInput.current.value;
      passwordInput.current.value = "";
      try {
        const result = await vault.unlock(password);
        if (result.status !== "accepted" && result.status !== "ok") setError("message" in result ? result.message : "无法解除遮罩，请重试。");
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setBusy(false); }
    }}>
      <h1 id={titleId}>页面已遮罩</h1>
      <p>输入钱包密码继续使用。后台任务与已许可的应用操作仍在运行。</p>
      <label htmlFor={passwordId}>钱包密码</label>
      <input ref={passwordInput} id={passwordId} type="password" autoComplete="current-password" autoFocus required disabled={busy} />
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "验证中…" : "解除遮罩"}</button>
    </form>
  </dialog></>;
}
