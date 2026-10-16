import { useEffect, useState } from "react";
import { useOptionalPluginCapability } from "webloom-framework/react";
import { AppLink, usePluginI18n, useResourceViewSelector } from "@keymaster/runtime";
import { sameWalletSession, type MsFileDemandMonitorSnapshot, type VaultLifecycleSnapshot, type VaultStatus } from "@keymaster/contracts";
import { MSFILE_BUCKET_SERVICE_CAPABILITY, type MsFileBucketService } from "./msfileBucketService.js";
import { useMsFileResources } from "./MsFileResourceContext.js";

export function MsFileDemandsPage() {
  const reader = useMsFileResources();
  const service = useOptionalPluginCapability(MSFILE_BUCKET_SERVICE_CAPABILITY);
  const { t } = usePluginI18n();
  const vault = useResourceViewSelector<VaultStatus, VaultStatus>(reader, "msfile.ui.vault-status", [], value => value.data ?? "locked");
  const lifecycle = useResourceViewSelector<VaultLifecycleSnapshot, VaultLifecycleSnapshot>(reader, "msfile.home.lifecycle", [],
    value => value.data ?? { status: "booting", sessionEpoch: "boot", runGeneration: "boot", vaultLifecycleRevision: 0 }, sameWalletSession);
  if (!service || vault !== "unlocked" || !lifecycle.activePublicKeyHex) return <p>{t("msfile.demands.locked")}</p>;
  return <DemandRecords key={JSON.stringify([lifecycle.activePublicKeyHex, lifecycle.sessionEpoch, lifecycle.runGeneration, lifecycle.walletGeneration])} service={service} />;
}

function DemandRecords({ service }: { service: MsFileBucketService }) {
  const { t } = usePluginI18n();
  const [snapshot, setSnapshot] = useState<MsFileDemandMonitorSnapshot>();
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!service.readDemandMonitor) throw new Error(t("msfile.demands.unavailable"));
        const next = await service.readDemandMonitor();
        if (alive) { setSnapshot(next); setError(""); setNow(Date.now()); }
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (alive) timer = setTimeout(() => void poll(), 2000); }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [service, t]);
  const time = (value: number | null) => value === null ? "—" : new Date(value).toLocaleTimeString();
  const status = (value: string) => t(`msfile.demands.state.${value}`, { defaultValue: value });
  const shorten = (value: string) => `${value.slice(0, 12)}…${value.slice(-6)}`;
  return <section className="msfile-purchases msfile-demands">
    <header className="msfile-purchases__toolbar"><h2>{t("msfile.demands.title")}</h2><AppLink to="/settings/local-files">{t("msfile.demands.sellerSettings")}</AppLink></header>
    <p className="msfile-demands__summary">{t("msfile.demands.memory")} · {t("msfile.demands.lastReceived")}: {time(snapshot?.lastReceivedAtMs ?? null)}</p>
    <p>{t("msfile.demands.selling")}: {snapshot ? t(snapshot.sellerEnabled ? "msfile.demands.enabled" : "msfile.demands.disabled") : "—"} · {t("msfile.demands.subscription")}: {snapshot ? status(snapshot.network.subscriptionPhase) : "—"} <code>{snapshot?.network.channel}</code></p>
    {snapshot && !snapshot.sellerEnabled ? <p>{t("msfile.demands.offNotice")}</p> : null}
    {error || snapshot?.network.error ? <p role="alert">{error || snapshot?.network.error}</p> : null}
    <div className="msfile-purchases__scroll"><table className="msfile-purchases__table" aria-label={t("msfile.demands.connections")}>
      <thead><tr><th>{t("msfile.demands.supplier")}</th><th>{t("msfile.demands.connection")}</th><th>{t("msfile.demands.receive")}</th><th>{t("msfile.demands.subscription")}</th><th>{t("msfile.demands.error")}</th></tr></thead>
      <tbody>{snapshot?.network.suppliers.map(item => <tr key={item.supplierId}>
        <td>{item.name} <code>{item.supplierId}</code></td><td>{status(item.connectionState)}</td>
        <td>{t(item.receiving ? "msfile.demands.enabled" : "msfile.demands.disabled")}</td><td>{status(item.subscribed ? "subscribed" : "idle")}</td><td>{item.error ?? "—"}</td>
      </tr>)}</tbody>
    </table></div>
    {snapshot && snapshot.network.suppliers.length === 0 ? <p>{t("msfile.demands.noConnections")}</p> : null}
    <div className="msfile-purchases__scroll"><table className="msfile-purchases__table" aria-label={t("msfile.demands.title")}>
      <thead><tr><th>{t("msfile.demands.localFile")}</th><th>{t("msfile.demands.received")}</th><th>Seed Hash</th><th>{t("msfile.demands.requester")}</th><th>{t("msfile.demands.requestId")}</th><th>{t("msfile.demands.expires")}</th><th>{t("msfile.demands.quote")}</th></tr></thead>
      <tbody>{snapshot?.demands.map(item => <tr key={`${item.requesterPublicKeyHex}:${item.requestMessageId}`}>
        <td><span className={`msfile-demands__dot${item.availability === "available" ? " msfile-demands__dot--available" : ""}`} aria-hidden="true" />{status(item.availability)}</td>
        <td>{time(item.receivedAtMs)}</td><td><code title={item.seedHashHex}>{shorten(item.seedHashHex)}</code> <button onClick={() => void navigator.clipboard.writeText(item.seedHashHex).catch(cause => setError(String(cause)))}>{t("msfile.demands.copy")}</button></td>
        <td><code title={item.requesterPublicKeyHex}>{shorten(item.requesterPublicKeyHex)}</code></td><td><code title={item.requestMessageId}>{shorten(item.requestMessageId)}</code></td>
        <td>{time(item.expiresAtMs)}{item.expiresAtMs <= now ? ` · ${t("msfile.demands.expired")}` : ""}</td>
        <td><span>{t(`msfile.demands.quote.${item.quoteStatus}`)}</span>{item.quotedAtMs ? <span> · {time(item.quotedAtMs)}</span> : null}{item.quoteMessage ? <div className={`msfile-demands__quote-message${item.quoteStatus === "failed" ? " is-error" : ""}`}>{item.quoteMessage}</div> : null}</td>
      </tr>)}</tbody>
    </table></div>
    {!snapshot && !error ? <p role="status">{t("msfile.demands.loading")}</p> : null}
    {snapshot?.demands.length === 0 ? <p>{t("msfile.demands.empty")}</p> : null}
  </section>;
}
