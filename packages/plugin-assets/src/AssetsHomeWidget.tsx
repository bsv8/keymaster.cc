// packages/plugin-assets/src/AssetsHomeWidget.tsx
// 首页统一持仓 widget：跨 asset + token provider 聚合概览。
// 设计缘由：只使用 HoldingRow 视图模型，不展示 P2PKH UTXO 等具体字段。
// 增量刷新：只重读发生变化的 provider，避免全量聚合。

import { useCallback, useEffect, useRef, useState } from "react";
import { useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import type { AssetProvider, AssetRegistry, TokenProvider, TokenRegistry } from "@keymaster/contracts";
import {
  loadSingleAssetProvider,
  loadSingleTokenProvider,
  toHoldingRows,
  type AssetProviderLoadResult,
  type HoldingRow,
  type HoldingsLoadResult,
  type TokenProviderLoadResult
} from "./holdingsFlow.js";

export function AssetsHomeWidget() {
  const assetsRegistry = useCapability<AssetRegistry>("asset.registry");
  const tokensRegistry = useCapability<TokenRegistry>("token.registry");
  const host = usePluginHost();
  const { t } = useI18n();
  useI18n().language();
  const [rows, setRows] = useState<HoldingRow[] | null>(null);
  const [stale, setStale] = useState(false);

  // provider 级状态缓存
  const assetResultsRef = useRef<Map<string, AssetProviderLoadResult>>(new Map());
  const tokenResultsRef = useRef<Map<string, TokenProviderLoadResult>>(new Map());
  // provider 级 revision：防止旧请求晚到覆盖新数据。
  const assetRevisionRef = useRef<Map<string, number>>(new Map());
  const tokenRevisionRef = useRef<Map<string, number>>(new Map());
  const aliveRef = useRef(true);

  /** 从当前 provider 级缓存重建 rows。 */
  const rebuildRows = useCallback(() => {
    const result: HoldingsLoadResult = {
      assets: [...assetResultsRef.current.values()],
      tokens: [...tokenResultsRef.current.values()],
    };
    const hasError =
      result.assets.some((r) => r.error) || result.tokens.some((r) => r.error);
    setStale(hasError);
    setRows(toHoldingRows(host, result));
  }, [host]);

  /**
   * 渐进加载：每个 provider 独立请求，完成即写入 Map 并 rebuildRows。
   * 设计缘由：一个 provider 挂起时，已完成 provider 的资产仍先显示。
   * 每个 provider 请求前递增 revision，完成时仅在 revision 仍匹配时写入。
   */
  async function refreshAll() {
    assetResultsRef.current.clear();
    tokenResultsRef.current.clear();
    const assetProviders = assetsRegistry.list();
    const tokenProviders = tokensRegistry.list();
    const promises = [
      ...assetProviders.map(async (p) => {
        const rev = (assetRevisionRef.current.get(p.id) ?? 0) + 1;
        assetRevisionRef.current.set(p.id, rev);
        const result = await loadSingleAssetProvider(p);
        if (!aliveRef.current || assetRevisionRef.current.get(p.id) !== rev) return;
        assetResultsRef.current.set(p.id, result);
        rebuildRows();
      }),
      ...tokenProviders.map(async (p) => {
        const rev = (tokenRevisionRef.current.get(p.id) ?? 0) + 1;
        tokenRevisionRef.current.set(p.id, rev);
        const result = await loadSingleTokenProvider(p);
        if (!aliveRef.current || tokenRevisionRef.current.get(p.id) !== rev) return;
        tokenResultsRef.current.set(p.id, result);
        rebuildRows();
      }),
    ];
    await Promise.allSettled(promises);
  }

  /** 增量刷新单个 asset provider。 */
  async function refreshAssetProvider(provider: AssetProvider) {
    const rev = (assetRevisionRef.current.get(provider.id) ?? 0) + 1;
    assetRevisionRef.current.set(provider.id, rev);
    const result = await loadSingleAssetProvider(provider);
    if (!aliveRef.current || assetRevisionRef.current.get(provider.id) !== rev) return;
    assetResultsRef.current.set(provider.id, result);
    rebuildRows();
  }

  /** 增量刷新单个 token provider。 */
  async function refreshTokenProvider(provider: TokenProvider) {
    const rev = (tokenRevisionRef.current.get(provider.id) ?? 0) + 1;
    tokenRevisionRef.current.set(provider.id, rev);
    const result = await loadSingleTokenProvider(provider);
    if (!aliveRef.current || tokenRevisionRef.current.get(provider.id) !== rev) return;
    tokenResultsRef.current.set(provider.id, result);
    rebuildRows();
  }

  useEffect(() => {
    aliveRef.current = true;
    refreshAll();
    // 订阅每个 provider 的 onChange，只重读该 provider
    const unsubs = [
      ...assetsRegistry.list().map((p) => p.onChange(() => refreshAssetProvider(p))),
      ...tokensRegistry.list().map((p) => p.onChange(() => refreshTokenProvider(p)))
    ];
    return () => {
      aliveRef.current = false;
      for (const off of unsubs) off();
    };
  }, [assetsRegistry, tokensRegistry]);

  return (
    <div className={`home-widget home-widget--assets ${stale ? "is-stale" : ""}`}>
      <header className="home-widget__head">
        <h3>{t("assets.home.overview", { defaultValue: "资产" })}</h3>
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