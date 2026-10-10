import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useInternalVault } from "./VaultInternalContext.js";
import { PaymentChannelSettings } from "@keymaster/vaultlink-integration/ui";
import { usePluginI18n, useResourceView } from "@keymaster/runtime";
import { type CoordinatorHardwareState, type KeyRef } from "@keymaster/contracts";
import { Button } from "@keymaster/ui";
import { Lock, Wallet, ChevronDown } from "lucide-react";
import { useVaultResources } from "./VaultResourceContext.js";
import type { VaultKeyResourceState } from "./manifest.js";
export function VaultLockButton() {
  const resources = useVaultResources();
  const vault = useInternalVault();
  const { t } = usePluginI18n();
  const snapshot = useResourceView<VaultKeyResourceState>(resources, "vault.key-state", []).data;
  const status = snapshot?.status;
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState(false);
  const [key, setKey] = useState<KeyRef>();
  const [hardware, setHardware] = useState<CoordinatorHardwareState>();
  const [error, setError] = useState("");
  const [panelTop, setPanelTop] = useState(64);
  const root = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const payment = useCallback((command: import("@keymaster/contracts").CoordinatorWalletPaymentCommand) => vault.payment(command), [vault]);
  useEffect(() => {
    let current = true; setKey(undefined); setHardware(undefined); setError("");
    if (status !== "unlocked") { setExpanded(false); setSettings(false); return; }
    void vault.getCurrentKey().then(value => {if (current) setKey(value);}).catch(e => {if (current) setError(e instanceof Error ? e.message : String(e));});
    return () => {current = false;};
  }, [vault, status, snapshot?.activePublicKeyHex, snapshot?.runGeneration, snapshot?.walletGeneration, snapshot?.revision]);
  useEffect(() => {
    if (key?.format !== "keymaster.hardware-key") return;
    let current = true, reading = false;
    const refresh = async () => {
      if (reading) return; reading = true;
      try {const value = await vault.hardware({action: "state"}); if (current) {setHardware(value); setError("");}}
      catch (e) {if (current) setError(e instanceof Error ? e.message : String(e));}
      finally {reading = false;}
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1000);
    return () => {current = false; clearInterval(timer);};
  }, [vault, key?.format]);
  useEffect(() => {
    if (!expanded) return;
    panel.current?.focus();
    const position = () => {
      const header = root.current?.closest(".app-topbar");
      if (header) setPanelTop(Math.max(8, Math.min(header.getBoundingClientRect().bottom + 8, window.innerHeight - 100)));
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    if (root.current) observer?.observe(root.current);
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    const outside = (event: PointerEvent) => {if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);};
    const escape = (event: KeyboardEvent) => {if (event.key === "Escape") {setExpanded(false); toggle.current?.focus();}};
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => {observer?.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape);};
  }, [expanded]);
  if (status !== "unlocked") return null;
  const lock = async () => {
    const deadline = Date.now() + 6000;
    for (;;) {
      try { await vault.lock(); return; }
      catch { if (Date.now() >= deadline) return; await new Promise(resolve => setTimeout(resolve, 400)); }
    }
  };
  const state = hardware?.activity?.state;
  const stateText = state ? t(`vault.panel.${state}`, {defaultValue: {
    "awaiting-user": "请在 RocKey 上阅读并确认", executing: "设备正在执行", completed: "设备操作已完成",
    denied: "设备已否决", cancelled: "操作已取消", unknown: "操作结果未知，请勿自动重试", failed: "设备操作失败",
  }[state]}) : undefined;
  return <div className="vault-topbar-wallet" ref={root}>
    <button type="button" ref={toggle} className="vault-topbar-wallet__toggle" aria-expanded={expanded}
      aria-controls="vault-topbar-panel" onClick={() => setExpanded(value => !value)}>
      <Wallet size={16}/><span>{t("vault.panel.wallet", {defaultValue: "钱包"})}</span><ChevronDown size={14}/>
    </button>
    <Button variant="ghost" className="app-topbar__lock" iconLeft={<Lock size={16} />} onClick={lock}
      title={t("common.action.lock", { defaultValue: "锁定" })} aria-label={t("common.action.lock", { defaultValue: "锁定" })}>{t("common.action.lock", { defaultValue: "锁定" })}</Button>
    {expanded ? <div id="vault-topbar-panel" className="vault-topbar-wallet__panel" style={{"--vault-wallet-top": `${panelTop}px`} as CSSProperties} ref={panel} tabIndex={-1}
      role="region" aria-label={t("vault.panel.wallet", {defaultValue: "钱包"})}>
      {key ? <>
        <strong>{key.label}</strong>
        <p>{key.format === "keymaster.hardware-key" ? t("vault.panel.hardware", {defaultValue: "RocKey 硬件钱包"}) : t("vault.panel.software", {defaultValue: "软件钱包"})}</p>
        <p className="vault-topbar-wallet__public-key">{key.publicKeyHex}</p>
      </> : <p>{t("common.status.loading", {defaultValue: "正在读取…"})}</p>}
      {stateText ? <p role="status" aria-live="polite">{stateText}</p> : null}
      {key?.format === "keymaster.hardware-key" ? <p>{t("vault.panel.deviceOnly", {defaultValue: "PIN、批准和否决在设备上操作。"})}</p> : null}
      <Button variant="ghost" onClick={() => setSettings(value => !value)} aria-expanded={settings}>{t("vault.panel.channels", {defaultValue: "消费渠道与额度"})}</Button>
      {settings ? <PaymentChannelSettings execute={payment} text={(name,fallback) => t(`vault.${name}`, {defaultValue: fallback})}/> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div> : null}
  </div>;
}
