// packages/plugin-assets/src/AssetsHomeWidget.tsx
// 首页资产聚合 widget：跨 provider 资产概览。
// 设计缘由：只使用 AssetSummary/AssetBalance，不展示 P2PKH UTXO 等具体字段。

import { useEffect, useState } from "react";
import { Button } from "@keymaster/ui";
import { useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import type { AssetRegistry, AssetSummary } from "@keymaster/contracts";
import { loadAllAssets, type ProviderLoadResult } from "./assetsFlow.js";

export function AssetsHomeWidget() {
  const registry = useCapability<AssetRegistry>("asset.registry");
  const host = usePluginHost();
  const { t } = useI18n();
  useI18n().language();
  const [results, setResults] = useState<ProviderLoadResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const r = await loadAllAssets(registry);
      setResults(r.results);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh();
    const unsubs = registry.list().map((p) => p.onChange(() => refresh()));
    return () => {
      for (const off of unsubs) off();
    };
  }, [registry]);

  const allAssets: AssetSummary[] = results?.flatMap((r) => r.assets) ?? [];
  const failed = results?.some((r) => r.error) ?? false;

  return (
    <div className={`home-widget home-widget--assets ${failed ? "is-stale" : ""}`}>
      <header className="home-widget__head">
        <h3>{t("assets.home.overview", { defaultValue: "资产" })}</h3>
        <Button size="sm" variant="ghost" onClick={refresh} loading={busy}>
          {t("assets.homeWidget.refresh", { defaultValue: "刷新" })}
        </Button>
      </header>
      {allAssets.length === 0 ? (
        <p className="home-widget__empty">
          {t("assets.homeWidget.empty", { defaultValue: "暂无资产" })}
        </p>
      ) : (
        <ul className="home-widget__list">
          {allAssets.map((a) => (
            <li key={`${a.providerId}:${a.assetId}`} className="home-widget__item">
              <span className="home-widget__name">{host.i18n.text(a.label)}</span>
              <span className="home-widget__balance">
                {a.balance
                  ? a.balance.display ?? `${a.balance.amount} ${a.balance.unit}`
                  : "-"}
              </span>
              <span className="home-widget__status">{a.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
