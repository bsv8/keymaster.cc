import { useMemo } from "react";
import type { AssetRegistry, AssetSummary, BsvNetwork, I18nText, KeyIdentity, TokenRegistry } from "@keymaster/contracts";
import { useCapability, useCurrentPath, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";
import type { HoldingRowsResult } from "./assets/holdingsFlow.js";

function labelOf(value: string | I18nText): string {
  return typeof value === "string" ? value : value.fallback;
}

function countByStatus<T extends { status: string }>(items: readonly T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
}

type Network = Extract<BsvNetwork, "main" | "test">;

const NETWORK_ORDER: Network[] = ["main", "test"];

function networkLabel(network: Network, t: (key: string, values?: { defaultValue?: string }) => string): string {
  return network === "main"
    ? t("assets.network.main", { defaultValue: "Mainnet" })
    : t("assets.network.test", { defaultValue: "Testnet" });
}

export function observationLabel(observation: "unconfirmed" | "confirmed" | undefined, t: (key: string, values?: { defaultValue?: string }) => string): string | undefined {
  if (observation === "unconfirmed") return t("assets.observation.unconfirmed", { defaultValue: "WOC 已观察（未确认）" });
  if (observation === "confirmed") return t("assets.observation.confirmed", { defaultValue: "WOC 已确认" });
  return undefined;
}

export function statusLabel(status: string, t: (key: string, values?: { defaultValue?: string }) => string): string {
  switch (status) {
    case "ready":
      return t("assets.status.ready", { defaultValue: "就绪" });
    case "syncing":
      return t("assets.status.syncing", { defaultValue: "同步中" });
    case "stale":
      return t("assets.status.stale", { defaultValue: "过期" });
    case "failed":
      return t("assets.status.failed", { defaultValue: "失败" });
    case "unsupported":
      return t("assets.status.unsupported", { defaultValue: "不支持" });
    default:
      return status;
  }
}

function visibleNetworks(includeTestnet: boolean): Network[] {
  return includeTestnet ? NETWORK_ORDER : ["main"];
}

function groupByNetwork<T extends { network?: BsvNetwork }>(items: readonly T[], includeTestnet: boolean): Array<{ network: Network; items: T[] }> {
  return visibleNetworks(includeTestnet).map((network) => ({
    network,
    items: items.filter((item) => (item.network ?? "main") === network)
  }));
}

export function AssetsPage() {
  useCurrentPath();
  const { t } = useI18n();
  const host = usePluginHost();
  const assets = useCapability<AssetRegistry>("asset.registry");
  const tokens = useCapability<TokenRegistry>("token.registry");
  const rows = useResourceSelector<HoldingRowsResult, HoldingRowsResult>(
    host.resourceStore,
    "assets.holdings",
    [],
    (snapshot) => snapshot.data ?? { assets: [], tokens: [] }
  );
  const settings = useResourceSelector<{ includeTestnet: boolean }, { includeTestnet: boolean }>(
    host.resourceStore,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data ?? { includeTestnet: false }
  );
  const activeIdentity = useResourceSelector<KeyIdentity | null, KeyIdentity | null>(
    host.resourceStore,
    "assets.active-context",
    [],
    (snapshot) => snapshot.data ?? null
  );
  const includeTestnet = settings.includeTestnet;
  const assetTotal = rows.assets.reduce((sum, provider) => sum + provider.assets.length, 0);
  const tokenTotal = rows.tokens.reduce((sum, provider) => sum + provider.tokens.length, 0);
  const readyTotal = rows.assets.reduce((sum, provider) => sum + (countByStatus(provider.assets).ready ?? 0), 0)
    + rows.tokens.reduce((sum, provider) => sum + (countByStatus(provider.tokens).ready ?? 0), 0);
  const activeText = useMemo(() => {
    if (!activeIdentity) return t("assets.context.noKey", { defaultValue: "无 key" });
    return `${activeIdentity.label ?? t("assets.context.unnamed", { defaultValue: "未命名" })} (${activeIdentity.publicKeyHex.slice(0, 12)}…)`;
  }, [activeIdentity, t]);

  return (
    <div className="asset-workspace-page assets-page">
      <section className="asset-workspace-hero">
        <div className="asset-workspace-hero__eyebrow">{t("assets.page.eyebrow", { defaultValue: "Asset workspace" })}</div>
        <div className="asset-workspace-hero__body">
          <div className="asset-workspace-hero__copy">
            <PageHeader title={t("assets.page.title", { defaultValue: "资产" })} description={activeText} />
            <p className="asset-workspace-hero__lede">
              {includeTestnet
                ? t("assets.page.lede.testnet", { defaultValue: "按 provider 聚合展示你当前 key 下的 coin、token 与同步状态。mainnet 和 testnet 会分开展示。" })
                : t("assets.page.lede.mainnet", { defaultValue: "按 provider 聚合展示你当前 key 下的 coin、token 与同步状态。当前只显示 mainnet。" })}
            </p>
          </div>
          <div className="asset-workspace-hero__actions">
            <span className={`asset-workspace-scope is-${includeTestnet ? "dual" : "main"}`}>
              {includeTestnet
                ? t("assets.page.scope.dual", { defaultValue: "Mainnet + testnet" })
                : t("assets.page.scope.main", { defaultValue: "Mainnet only" })}
            </span>
            <Button onClick={() => host.resourceStore.invalidate("assets.holdings", [])}>{t("assets.page.refresh", { defaultValue: "Refresh" })}</Button>
          </div>
        </div>
        <div className="asset-workspace-stats" aria-label={t("assets.page.stats", { defaultValue: "Summary" })}>
          <div className="asset-workspace-stat">
            <span>{t("assets.page.stats.assets", { defaultValue: "Assets" })}</span>
            <strong>{assetTotal}</strong>
          </div>
          <div className="asset-workspace-stat">
            <span>{t("assets.page.stats.tokens", { defaultValue: "Tokens" })}</span>
            <strong>{tokenTotal}</strong>
          </div>
          <div className="asset-workspace-stat">
            <span>{t("assets.page.stats.ready", { defaultValue: "Ready" })}</span>
            <strong>{readyTotal}</strong>
          </div>
        </div>
      </section>
      {assets.list().length === 0 && tokens.list().length === 0 ? (
        <EmptyState title={t("assets.page.empty.providers.title", { defaultValue: "暂无资产 provider" })} />
      ) : null}
      <div className="asset-workspace-grid">
        <section className="asset-workspace-panel">
          <div className="asset-workspace-panel__head">
            <div>
              <h3>{t("assets.route.list", { defaultValue: "Asset overview" })}</h3>
              <p>{t("assets.page.assets.desc", { defaultValue: "Coins and provider-specific assets." })}</p>
            </div>
            <span>{assetTotal}</span>
          </div>
          <div className="asset-workspace-stack">
            {rows.assets.map((provider) => (
              <article key={provider.provider.id} className="asset-workspace-provider">
                <div className="asset-workspace-provider__head">
                  <div>
                    <h4>{labelOf(provider.provider.name)}</h4>
                    <p>{`${provider.assets.length} assets`}</p>
                  </div>
                  <span>{provider.provider.id}</span>
                </div>
                {provider.error ? <p className="asset-workspace-provider__error">{provider.error}</p> : null}
                {groupByNetwork(provider.assets, includeTestnet).map((group) => (
                  <section key={group.network} className={`asset-workspace-network is-${group.network}`}>
                    <div className="asset-workspace-network__head">
                      <h5>{networkLabel(group.network, t)}</h5>
                      <span>{`${group.items.length}`}</span>
                    </div>
                    {group.items.length === 0 ? (
                      <p className="asset-workspace-empty">{t("assets.page.provider.empty", { defaultValue: "No items yet." })}</p>
                    ) : (
                      <ul className="asset-workspace-list">
                        {group.items.map((asset) => (
                          <li key={asset.assetId} className="asset-workspace-row">
                        <div className={`asset-workspace-mark asset-workspace-mark--${asset.kind}`}>
                          {asset.kind.slice(0, 1)}
                        </div>
                        <div className="asset-workspace-row__button" role="group" aria-label={labelOf(asset.label)}>
                          <div className="asset-workspace-row__body">
                            <strong>{labelOf(asset.label)}</strong>
                            <span>{asset.assetId}</span>
                          </div>
                          <div className="asset-workspace-row__meta">
                                <span className={`asset-workspace-pill is-${asset.status}`}>{statusLabel(asset.status, t)}</span>
                                <span className={`asset-workspace-pill is-${group.network}`}>{networkLabel(group.network, t)}</span>
                                {asset.balance ? <strong>{asset.balance.display ?? `${asset.balance.amount} ${asset.balance.unit}`}</strong> : null}
                              </div>
                        </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ))}
              </article>
            ))}
          </div>
        </section>
        <section className="asset-workspace-panel">
          <div className="asset-workspace-panel__head">
            <div>
              <h3>{t("assets.page.tokens.title", { defaultValue: "Tokens" })}</h3>
              <p>{t("assets.page.tokens.desc", { defaultValue: "BSV-21 and other token providers." })}</p>
            </div>
            <span>{tokenTotal}</span>
          </div>
          <div className="asset-workspace-stack">
            {rows.tokens.map((provider) => (
              <article key={provider.provider.id} className="asset-workspace-provider">
                <div className="asset-workspace-provider__head">
                  <div>
                    <h4>{labelOf(provider.provider.name)}</h4>
                    <p>{`${provider.tokens.length} tokens`}</p>
                  </div>
                  <span>{provider.provider.id}</span>
                </div>
                {provider.error ? <p className="asset-workspace-provider__error">{provider.error}</p> : null}
                {groupByNetwork(provider.tokens, includeTestnet).map((group) => (
                  <section key={group.network} className={`asset-workspace-network is-${group.network}`}>
                    <div className="asset-workspace-network__head">
                      <h5>{networkLabel(group.network, t)}</h5>
                      <span>{`${group.items.length}`}</span>
                    </div>
                    {group.items.length === 0 ? (
                      <p className="asset-workspace-empty">{t("assets.page.provider.empty", { defaultValue: "No items yet." })}</p>
                    ) : (
                      <ul className="asset-workspace-list">
                        {group.items.map((token) => (
                          <li key={token.tokenId} className="asset-workspace-row">
                        <div className="asset-workspace-mark asset-workspace-mark--token">
                          T
                        </div>
                        <div className="asset-workspace-row__button" role="group" aria-label={labelOf(token.label)}>
                          <div className="asset-workspace-row__body">
                            <strong>{labelOf(token.label)}</strong>
                            <span>{token.tokenId}</span>
                          </div>
                          <div className="asset-workspace-row__meta">
                                <span className={`asset-workspace-pill is-${token.status}`}>{statusLabel(token.status, t)}</span>
                                <span className={`asset-workspace-pill is-${group.network}`}>{networkLabel(group.network, t)}</span>
                                {token.observation ? <span className={`asset-workspace-pill is-${token.observation}`}>{observationLabel(token.observation, t)}</span> : null}
                                {token.balance ? <strong>{token.balance.display ?? `${token.balance.amount} ${token.balance.unit}`}</strong> : null}
                                {token.canonicalTxid ? <span>{token.canonicalTxid.slice(0, 12)}…</span> : null}
                              </div>
                        </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ))}
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function readQuery(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

export function AssetDetailRedirect() {
  const { t } = useI18n();
  const providerId = readQuery("providerId");
  const assetId = readQuery("assetId");
  if (!providerId || !assetId) {
    return <EmptyState title={t("assets.redirect.missing", { defaultValue: "缺少 providerId/assetId 参数。" })} />;
  }
  return (
    <div className="asset-workspace-page asset-detail">
      <PageHeader title={t("assets.route.detail", { defaultValue: "Asset detail" })} />
      <p>{providerId}:{assetId}</p>
    </div>
  );
}

export function AssetsHomeWidget() {
  const host = usePluginHost();
  const { t } = useI18n();
  const data = useResourceSelector<HoldingRowsResult, HoldingRowsResult>(
    host.resourceStore,
    "assets.holdings",
    [],
    (snapshot) => snapshot.data ?? { assets: [], tokens: [] }
  );
  return (
    <section className="asset-workspace-home">
      <strong>{t("assets.home.overview", { defaultValue: "Asset overview" })}</strong>
      <div className="asset-workspace-home__count">{data.assets.length + data.tokens.length}</div>
      <Button onClick={() => host.resourceStore.invalidate("assets.holdings", [])}>{t("assets.page.refresh", { defaultValue: "Refresh" })}</Button>
    </section>
  );
}
