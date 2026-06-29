// packages/plugin-assets/src/AssetsHomeWidget.tsx
// 首页统一持仓 widget：跨 asset + token provider 聚合概览。
// 设计缘由：只使用 HoldingRow 视图模型，不展示 P2PKH UTXO 等具体字段。

import { useEffect, useState } from "react";
import { Button } from "@keymaster/ui";
import { useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import type { AssetRegistry, TokenRegistry } from "@keymaster/contracts";
import { loadAllHoldings, toHoldingRows, type HoldingRow } from "./holdingsFlow.js";

export function AssetsHomeWidget() {
  const assetsRegistry = useCapability<AssetRegistry>("asset.registry");
  const tokensRegistry = useCapability<TokenRegistry>("token.registry");
  const host = usePluginHost();
  const { t } = useI18n();
  useI18n().language();
  const [rows, setRows] = useState<HoldingRow[] | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const result = await loadAllHoldings(assetsRegistry, tokensRegistry);
      const hasError =
        result.assets.some((r) => r.error) || result.tokens.some((r) => r.error);
      setStale(hasError);
      setRows(toHoldingRows(host, result));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh();
    const unsubs = [
      ...assetsRegistry.list().map((p) => p.onChange(() => refresh())),
      ...tokensRegistry.list().map((p) => p.onChange(() => refresh()))
    ];
    return () => {
      for (const off of unsubs) off();
    };
  }, [assetsRegistry, tokensRegistry]);

  return (
    <div className={`home-widget home-widget--assets ${stale ? "is-stale" : ""}`}>
      <header className="home-widget__head">
        <h3>{t("assets.home.overview", { defaultValue: "资产" })}</h3>
        <Button size="sm" variant="ghost" onClick={refresh} loading={busy}>
          {t("assets.homeWidget.refresh", { defaultValue: "刷新" })}
        </Button>
      </header>
      {rows === null || rows.length === 0 ? (
        <p className="home-widget__empty">
          {t("assets.homeWidget.empty", { defaultValue: "暂无资产" })}
        </p>
      ) : (
        <ul className="home-widget__list">
          {rows.map((r) => (
            <li
              key={`${r.kind}:${r.providerId}:${r.itemId}`}
              className="home-widget__item"
            >
              <span className="home-widget__name">{r.label}</span>
              <span className="home-widget__balance">{r.balanceDisplay}</span>
              <span className="home-widget__status">{r.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}