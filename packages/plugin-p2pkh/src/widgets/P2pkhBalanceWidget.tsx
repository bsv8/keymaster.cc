import { useP2pkhResources } from "../P2pkhResourceContext.js";
import { formatSats, formatSatsWithPrice } from "@keymaster/ui";
import { countRender } from "webloom-framework/react";
import { usePluginBsvPrice, usePluginI18n, usePluginLocale, useResourceViewSelector } from "@keymaster/runtime";
import { emptyGlobalBalanceSnapshot, type GlobalBalanceSnapshot } from "@keymaster/contracts";
import type { P2pkhSyncStatus } from "../p2pkhContracts.js";

const EMPTY = emptyGlobalBalanceSnapshot();
type ReadinessState = "initializing" | "no-active-key" | "ready";

/** 当前绑定钱包的 manager 可用余额，不选择资产或另一网络。 */
export function P2pkhBalanceWidget() {
  countRender("plugin-p2pkh/P2pkhBalanceWidget");
  const { t } = usePluginI18n();
  const locale = usePluginLocale();
  const price = usePluginBsvPrice();
  const store = useP2pkhResources();
  const readiness = useResourceViewSelector<ReadinessState, ReadinessState>(
    store, "p2pkh.readiness", [], snapshot => snapshot.data ?? "initializing",
  );
  const status = useResourceViewSelector<P2pkhSyncStatus, P2pkhSyncStatus>(
    store, "p2pkh.sync-status", [], snapshot => snapshot.data ?? "idle",
  );
  const snapshot = useResourceViewSelector<GlobalBalanceSnapshot, GlobalBalanceSnapshot>(
    store, "p2pkh.balance", [], state => state.data ?? EMPTY,
  );
  const { balance, bsvNetwork: network } = snapshot;
  const known = Boolean(snapshot.publicKeyHex) && balance.available === true;
  const stale = status === "failed" || status === "rate-limited";
  const statusText = readiness === "ready" ? status : t(
    readiness === "initializing" ? "p2pkh.balanceWidget.status.initializing" : "p2pkh.balanceWidget.status.noActiveKey",
    { defaultValue: readiness === "initializing" ? "钱包正在初始化" : "钱包尚未解锁" },
  );
  return (
    <div className={`home-widget home-widget--p2pkh-balance ${stale ? "is-stale" : ""}`}>
      <header className="home-widget__head"><h3>{t("p2pkh.balanceWidget.title", { defaultValue: "P2PKH 余额" })}</h3></header>
      <section className="home-widget__row"><div>
        <p className="home-widget__label">{t(network === "main" ? "p2pkh.balanceWidget.bsvMain" : "p2pkh.balanceWidget.bsvTest", { defaultValue: network === "main" ? "BSV (main)" : "BSV Testnet (test)" })}</p>
        <p className="home-widget__amount">{known ? formatSatsWithPrice(balance.total, price, { locale, network }) : "—"}</p>
        {known && balance.breakdown ? <dl className="home-widget__breakdown">
          <dt>{t("p2pkh.balance.confirmed", { defaultValue: "已确认（可花费）" })}</dt><dd>{formatSats(balance.breakdown.confirmed)}</dd>
          <dt>{t("p2pkh.balance.localSpendable", { defaultValue: "可花费" })}</dt><dd>{formatSats(balance.breakdown.spendable)}</dd>
        </dl> : null}
      </div></section>
      <p className="home-widget__status">{t("p2pkh.balanceWidget.statusLabel", { defaultValue: "状态：" })}{statusText}</p>
    </div>
  );
}
