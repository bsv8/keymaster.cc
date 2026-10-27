import { useEffect, useState } from "react";
import { Button, TextInput } from "@keymaster/ui";
import { useOptionalPluginCapability } from "webloom-framework/react";
import { AppLink, usePluginI18n, useOptionalResourceSelector } from "@keymaster/runtime";
import type { ChainFeePolicy, ChainFeeSnapshot } from "@keymaster/contracts";
import { P2PKH_CAPABILITY, type P2pkhGlobalSettings, type P2pkhService } from "../p2pkhContracts.js";
import { useP2pkhResources } from "../P2pkhResourceContext.js";

/** 当前钱包的费率设置；只保存策略，不选择网络。 */
export function P2pkhSettingsPage() {
  const service = useOptionalPluginCapability(P2PKH_CAPABILITY);
  const { t } = usePluginI18n();
  return service ? <P2pkhSettingsEditor service={service} /> : <p>{t("p2pkh.settings.unavailable")}</p>;
}
function P2pkhSettingsEditor({ service }: { service: P2pkhService }) {
  const reader = useP2pkhResources();
  const { t } = usePluginI18n();
  const [initialSettings] = useState(() => service.getGlobalSettings());
  const settings = useOptionalResourceSelector<P2pkhGlobalSettings, P2pkhGlobalSettings>(reader, "p2pkh.settings", [], snapshot => snapshot.data ?? initialSettings, initialSettings);
  const fee = useOptionalResourceSelector<ChainFeeSnapshot, ChainFeeSnapshot | undefined>(reader, "p2pkh.chain-fee", [], snapshot => snapshot.data, undefined);
  const [draft, setDraft] = useState(() => fee ? String(fee.effectiveSatoshisPerKb) : "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setDirty(false); setError(undefined); }, [settings.bsvNetwork]);
  useEffect(() => { if (fee && !dirty) setDraft(String(fee.effectiveSatoshisPerKb)); }, [fee?.effectiveSatoshisPerKb, dirty]);
  async function save(policy: ChainFeePolicy) {
    if (!service || busy) return;
    setBusy(true); setError(undefined);
    try { await service.applyGlobalSettings({ feePolicy: policy }); setDirty(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  function saveManual() {
    const value = Number(draft);
    if (!/^[1-9][0-9]*$/u.test(draft) || !Number.isSafeInteger(value)) {
      setError(t("p2pkh.settings.feeRateInvalid")); return;
    }
    void save({ mode: "manual", satoshisPerKb: value });
  }
  if (!fee) return <p>{t("p2pkh.settings.feePending")}</p>;
  return <div className="p2pkh-settings">
    <p>{settings.bsvNetwork === "test" ? "Testnet" : "Mainnet"}</p>
    <section className="p2pkh-settings__fee-rates" aria-labelledby="p2pkh-fee-rates-title">
      <h3 id="p2pkh-fee-rates-title">{t("p2pkh.settings.feeRates")}</h3>
      <p>{t("p2pkh.settings.feeRatesHint")}</p>
      <p>{t("p2pkh.settings.feeEffective")}: {fee.effectiveSatoshisPerKb} sat/KB · {t(`p2pkh.settings.feeSource.${fee.source}`)}</p>
      <p>{t("p2pkh.settings.feeRecommended")}: {fee.recommendation ? `${fee.recommendation.fee} sat/KB` : t("p2pkh.settings.feePending")}</p>
      {fee.updatedAtMs !== undefined ? <p>{t("p2pkh.settings.feeUpdated")}: {new Date(fee.updatedAtMs).toLocaleString()}</p> : null}
      {fee.error ? <p role="status">{t("p2pkh.settings.feeRefreshFailed")} {fee.error}</p> : null}
      <TextInput label={t("p2pkh.settings.feeManual")} type="number" min="1" step="1" value={draft} disabled={busy}
        onChange={event => { setDraft(event.currentTarget.value); setDirty(true); }} hint="sat/KB" />
      <div className="p2pkh-settings__fee-actions">
      <Button disabled={busy} onClick={saveManual}>{t("p2pkh.settings.feeSaveManual")}</Button>
      <Button disabled={busy} onClick={() => void save({ mode: "automatic" })}>{t("p2pkh.settings.feeUseWoc")}</Button>
      </div>
      <AppLink to="/settings/smart-scheduling">{t("p2pkh.settings.feeScheduling")}</AppLink>
    </section>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
export function P2pkhSettingsBlock() {
  return <section className="bsv-chain-page__section" id="p2pkh" aria-labelledby="bsv-chain-p2pkh-title">
    <header className="bsv-chain-page__section-header"><h2 id="bsv-chain-p2pkh-title">P2PKH</h2></header><P2pkhSettingsPage />
  </section>;
}
