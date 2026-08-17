// packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx
// P2PKH 余额 widget：
//   - 金额来源改为 `{ total }`；不再分 confirmed / unconfirmed。
//   - testnet 行受 `includeTestnet` 控制：false 时不展示。
//   - 只被动订阅 data-changed / settings 变化，不暴露手动同步入口。
//
// 硬切换 003：使用 Resource Store 读取余额和设置数据。
// 跨标签同步、请求去重、失效批处理由 resource 处理。

import { formatSats } from "@keymaster/ui";
import { countRender, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import type { P2pkhBalance, P2pkhGlobalSettings, P2pkhSyncStatus } from "../p2pkhContracts.js";

const DEFAULT_BALANCES: { bsv: P2pkhBalance | null; bsvtest: P2pkhBalance | null } = { bsv: null, bsvtest: null };
const DEFAULT_SETTINGS: P2pkhGlobalSettings = { includeTestnet: false };

type ReadinessState = "initializing" | "no-active-key" | "ready";

export function P2pkhBalanceWidget() {
  countRender("plugin-p2pkh/P2pkhBalanceWidget");
  const host = usePluginHost();
  const { t } = useI18n();
  const store = host.resourceStore;

  const readiness = useResourceSelector<ReadinessState, ReadinessState>(
    store, "p2pkh.readiness", [], (snapshot) => snapshot.data ?? "initializing"
  );
  const status = useResourceSelector<P2pkhSyncStatus, P2pkhSyncStatus>(
    store, "p2pkh.sync-status", [], (snapshot) => snapshot.data ?? "idle"
  );

  // 使用 Resource Store 读取余额数据
  const balances = useResourceSelector<typeof DEFAULT_BALANCES, typeof DEFAULT_BALANCES>(
    store,
    "p2pkh.balance",
    [],
    (snapshot) => snapshot.data ?? DEFAULT_BALANCES,
    (a, b) => JSON.stringify(a) === JSON.stringify(b)
  );

  // 使用 Resource Store 读取设置
  const settings = useResourceSelector<P2pkhGlobalSettings, P2pkhGlobalSettings>(
    store,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data ?? DEFAULT_SETTINGS,
    (a, b) => a.includeTestnet === b.includeTestnet
  );

  const stale = status === "failed" || status === "rate-limited";
  const showAmount = (b: P2pkhBalance | null) => (b ? formatSats(b.total) : "—");
  const breakdown = (b: P2pkhBalance | null) => b?.breakdown ? <dl className="home-widget__breakdown"><dt>Block confirmed</dt><dd>{formatSats(b.breakdown.blockConfirmed)}</dd><dt>Isolated</dt><dd>{formatSats(b.breakdown.isolated)}</dd></dl> : null;
  const statusText = computeStatusText(readiness, status, t);

  return (
    <div className={`home-widget home-widget--p2pkh-balance ${stale ? "is-stale" : ""}`}>
      <header className="home-widget__head">
        <h3>{t("p2pkh.balanceWidget.title", { defaultValue: "P2PKH 余额" })}</h3>
      </header>
      <section className="home-widget__row">
        <div>
          <p className="home-widget__label">{t("p2pkh.balanceWidget.bsvMain", { defaultValue: "BSV (main)" })}</p>
          <p className="home-widget__amount">{showAmount(balances.bsv)}</p>
          {breakdown(balances.bsv)}
        </div>
      </section>
      {settings.includeTestnet ? (
        <section className="home-widget__row">
          <div>
            <p className="home-widget__label">{t("p2pkh.balanceWidget.bsvTest", { defaultValue: "BSV Testnet (test)" })}</p>
            <p className="home-widget__amount">{showAmount(balances.bsvtest)}</p>
            {breakdown(balances.bsvtest)}
          </div>
        </section>
      ) : null}
      <p className="home-widget__status">
        {t("p2pkh.balanceWidget.statusLabel", { defaultValue: "状态：" })}{statusText}
      </p>
    </div>
  );
}

function computeStatusText(
  readiness: ReadinessState,
  sync: string,
  t: (key: string, values?: { defaultValue?: string; [k: string]: string | number | boolean | null | undefined }) => string
): string {
  if (readiness === "initializing") return t("p2pkh.balanceWidget.status.initializing", { defaultValue: "Key 正在初始化" });
  if (readiness === "no-active-key") return t("p2pkh.balanceWidget.status.noActiveKey", { defaultValue: "请选择一个 active key" });
  return sync;
}
