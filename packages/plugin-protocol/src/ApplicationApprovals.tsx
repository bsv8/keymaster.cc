import { useState } from "react";
import { usePluginCapability, useHasPluginCapability } from "webloom-framework/react";
import { useResourceViewSelector } from "@keymaster/runtime";
import { MSFILE_SERVICE_CAPABILITY, VAULT_SERVICE_CAPABILITY, formatShortPublicKey, type ProtocolConnectAuthSnapshot, type ProtocolService, type MsFileApprovalDecision, type MsFilePendingApprovalView } from "@keymaster/contracts";
import { useProtocolResources } from "./ProtocolResourceContext.js";

type Translate = (key: string, values?: { defaultValue?: string }) => string;

/** 登录认证只属于所选外部申请，不启动或销毁钱包/协议宿主。 */
export function ApplicationAuthentication({ service, auth, t }: { service: ProtocolService; auth: ProtocolConnectAuthSnapshot; t: Translate }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const login = auth.ownerType === "login";
  const wallet = login ? auth.login?.wallet : auth.resume ? { label: auth.resume.ownerLabel, publicKeyHex: auth.resume.ownerPublicKeyHex } : undefined;
  return <section className="protocol-auth__panel">
    <h2>{t(login ? "protocol.connect.login.title" : "protocol.connect.resume.title", { defaultValue: login ? "连接当前钱包" : "恢复连接" })}</h2>
    <p>该申请仅建立此应用的连接；不会自动授予签名、加解密或付款许可。</p>
    {wallet ? <p>{wallet.label} · <code>{formatShortPublicKey(wallet.publicKeyHex)}</code></p> : <p>Wallet identity is not ready.</p>}
    <form className="protocol-auth__form" onSubmit={async event => {
      event.preventDefault();
      if (busy || !password || !wallet || !auth.canSubmit || !auth.recordId) return;
      setBusy(true); setError(undefined);
      try {
        if (login) await service.confirmConnectLogin(auth.recordId, password);
        else await service.confirmConnectResume(auth.recordId, password);
        setPassword("");
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Authentication failed"); }
      finally { setBusy(false); }
    }}>
      <label className="protocol-auth__password"><span>{t("protocol.unlock.password", { defaultValue: "密码" })}</span><input type="password" autoComplete="current-password" value={password} disabled={busy || auth.submitted} onChange={event => setPassword(event.target.value)} /></label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="protocol-popup__actions"><button type="button" disabled={busy} onClick={async () => { try { await service.rejectConnectRequest(auth.recordId!); } catch { setError("Request rejection could not be saved"); } }}>{t("protocol.connect.cancel", { defaultValue: "取消" })}</button>
        <button type="submit" disabled={busy || auth.submitted || !auth.canSubmit || !wallet || !password}>{t(login ? "protocol.connect.login.confirm" : "protocol.connect.resume.confirm", { defaultValue: "确认连接" })}</button></div>
    </form>
  </section>;
}

/** MSFile 的价格约束继续使用业务自身的 once/always 上限，不恢复钱包内部付款审批。 */
export function MsFileApprovalSection({ t, approvalId }: { t: Translate; approvalId?: string }) {
  const available = useHasPluginCapability(MSFILE_SERVICE_CAPABILITY);
  return available ? <MsFileApproval t={t} approvalId={approvalId} /> : null;
}
function MsFileApproval({ t, approvalId }: { t: Translate; approvalId?: string }) {
  const service = usePluginCapability(MSFILE_SERVICE_CAPABILITY);
  const vault = usePluginCapability(VAULT_SERVICE_CAPABILITY);
  const status = useResourceViewSelector<{ approvals: MsFilePendingApprovalView[] }, { approvals: MsFilePendingApprovalView[] }>(useProtocolResources(), "protocol.msfile-approvals", [], snapshot => snapshot.data ?? { approvals: service.listPendingApprovals() }, (a, b) => JSON.stringify(a.approvals) === JSON.stringify(b.approvals));
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const approvals = status.approvals.filter(value => !approvalId || value.approvalId === approvalId);
  const unlocked = vault.status() === "unlocked";
  async function decide(id: string, decision: MsFileApprovalDecision) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await service.resolveApproval(id, decision); setAmounts(previous => { const next = { ...previous }; delete next[id]; return next; }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Price approval failed"); }
    finally { setBusy(false); }
  }
  return <div className="protocol-popup__msfile-approvals" role="group" aria-label={t("msfile.approvals.title", { defaultValue: "Price increase requested" })}>{approvals.map(value => <section key={value.approvalId} className="protocol-msfile-approval-card">
    <h3>{t("msfile.approvals.title", { defaultValue: "Price increase requested" })}</h3>
    <dl><dt>App</dt><dd>{value.appName} ({value.appId})</dd><dt>Kind</dt><dd>{value.kind}</dd><dt>Current cap</dt><dd>{value.effectiveMaxPriceSatoshis}</dd><dt>Hash</dt><dd><code>{value.contentHashHint}…</code></dd></dl>
    {error ? <p role="alert">{error}</p> : null}
    <input type="text" inputMode="numeric" aria-label="New maximum price" placeholder={t("msfile.approvals.newLimit", { defaultValue: "New maximum price (satoshis)" })} value={amounts[value.approvalId] ?? ""} onChange={event => setAmounts(previous => ({ ...previous, [value.approvalId]: event.target.value.replace(/[^0-9]/g, "") }))} />
    <div className="protocol-msfile-approval-actions"><button type="button" disabled={!unlocked || busy} onClick={() => void decide(value.approvalId, { action: "reject" })}>{t("protocol.confirm.reject", { defaultValue: "拒绝" })}</button>
      {(["once", "always"] as const).map(scope => <button type="button" key={scope} disabled={!unlocked || busy || !amounts[value.approvalId]} onClick={() => void decide(value.approvalId, { action: "allow", scope, newMaxPriceSatoshis: amounts[value.approvalId]! })}>{t(scope === "once" ? "msfile.approvals.allowOnce" : "msfile.approvals.allowAlways", { defaultValue: scope === "once" ? "Allow once" : "Always allow up to this amount" })}</button>)}</div>
  </section>)}</div>;
}
