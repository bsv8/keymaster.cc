import { useMemo } from "react";
import type { BusinessFeatureRegistry, BsvNetwork, CollectibleRegistry, CollectibleSummary, CollectibleTransferRegistry, I18nText } from "@keymaster/contracts";
import { useCapability, useCurrentPath, useI18n, usePluginHost, useResourceSelector, router } from "@keymaster/runtime";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";

function labelOf(value: string | I18nText): string {
  return typeof value === "string" ? value : value.fallback;
}

function readQuery(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

type Network = Extract<BsvNetwork, "main" | "test">;
const NETWORK_ORDER: Network[] = ["main", "test"];

function networkLabel(network: Network, t: (key: string, values?: { defaultValue?: string }) => string): string {
  return network === "main"
    ? t("collectibles.network.main", { defaultValue: "Mainnet" })
    : t("collectibles.network.test", { defaultValue: "Testnet" });
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

export function CollectiblesPage() {
  useCurrentPath();
  const { t } = useI18n();
  const host = usePluginHost();
  const registry = useCapability<CollectibleRegistry>("collectible.registry");
  const business = useCapability<BusinessFeatureRegistry>("business.registry");
  const data = useResourceSelector<Array<{ provider: { id: string; name: I18nText }; items: CollectibleSummary[]; error?: string }>, Array<{ provider: { id: string; name: I18nText }; items: CollectibleSummary[]; error?: string }>>(
    host.resourceStore,
    "collectibles.list",
    [],
    (snapshot) => snapshot.data ?? []
  );
  const settings = useResourceSelector<{ includeTestnet: boolean }, { includeTestnet: boolean }>(
    host.resourceStore,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data ?? { includeTestnet: false }
  );
  const includeTestnet = settings.includeTestnet;
  const createPath = useMemo(() => {
    const features = business.listFeatures()
      .filter((feature) => feature.domainId === "assets")
      .filter((feature) => feature.entry.path.includes("/mint"))
      .filter((feature) => feature.ownerPluginId !== "assets")
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return features[0]?.entry.path ?? "/collectibles";
  }, [business]);
  const totalItems = data.reduce((sum, provider) => sum + provider.items.length, 0);
  return (
    <div className="asset-workspace-page collectibles-page">
      <section className="asset-workspace-hero">
        <div className="asset-workspace-hero__eyebrow">{t("collectibles.page.eyebrow", { defaultValue: "Collectible workspace" })}</div>
        <div className="asset-workspace-hero__body">
          <div className="asset-workspace-hero__copy">
            <PageHeader
              title={t("collectibles.page.title", { defaultValue: "藏品" })}
              description={
                includeTestnet
                  ? t("collectibles.page.lede.testnet", { defaultValue: "按 provider 浏览单件藏品。mainnet 和 testnet 会分开展示。" })
                  : t("collectibles.page.lede.mainnet", { defaultValue: "按 provider 浏览单件藏品。当前只显示 mainnet。" })
              }
            />
          </div>
          <div className="asset-workspace-hero__actions">
            <span className={`asset-workspace-scope is-${includeTestnet ? "dual" : "main"}`}>
              {includeTestnet
                ? t("collectibles.page.scope.dual", { defaultValue: "Mainnet + testnet" })
                : t("collectibles.page.scope.main", { defaultValue: "Mainnet only" })}
            </span>
            <Button onClick={() => router.push(createPath)} disabled={createPath === "/collectibles"}>{t("collectibles.page.mint", { defaultValue: "Create collectible" })}</Button>
          </div>
        </div>
        <div className="asset-workspace-stats" aria-label={t("collectibles.page.stats", { defaultValue: "Summary" })}>
          <div className="asset-workspace-stat">
            <span>{t("collectibles.page.stats.providers", { defaultValue: "Providers" })}</span>
            <strong>{registry.list().length}</strong>
          </div>
          <div className="asset-workspace-stat">
            <span>{t("collectibles.page.stats.items", { defaultValue: "Items" })}</span>
            <strong>{totalItems}</strong>
          </div>
          <div className="asset-workspace-stat">
            <span>{t("collectibles.page.stats.ready", { defaultValue: "Ready" })}</span>
            <strong>{data.reduce((sum, provider) => sum + provider.items.filter((item) => item.status === "ready").length, 0)}</strong>
          </div>
        </div>
      </section>
      {registry.list().length === 0 ? <EmptyState title={t("collectibles.page.empty.providers.title", { defaultValue: "暂无 collectible provider" })} /> : null}
      <div className="asset-workspace-grid">
        <section className="asset-workspace-panel">
          <div className="asset-workspace-panel__head">
            <div>
              <h3>{t("collectibles.page.providers.title", { defaultValue: "Providers" })}</h3>
              <p>{t("collectibles.page.providers.desc", { defaultValue: "Each provider keeps its own registry and status." })}</p>
            </div>
            <span>{registry.list().length}</span>
          </div>
          <div className="asset-workspace-stack">
            {data.map((provider) => (
              <article key={provider.provider.id} className="asset-workspace-provider">
                <div className="asset-workspace-provider__head">
                  <div>
                    <h4>{labelOf(provider.provider.name)}</h4>
                    <p>{`${provider.items.length} collectibles`}</p>
                  </div>
                  <span>{provider.provider.id}</span>
                </div>
                {provider.error ? <p className="asset-workspace-provider__error">{provider.error}</p> : null}
                {groupByNetwork(provider.items, includeTestnet).map((group) => (
                  <section key={group.network} className={`asset-workspace-network is-${group.network}`}>
                    <div className="asset-workspace-network__head">
                      <h5>{networkLabel(group.network, t)}</h5>
                      <span>{`${group.items.length}`}</span>
                    </div>
                    {group.items.length === 0 ? (
                      <p className="asset-workspace-empty">{t("collectibles.page.provider.empty", { defaultValue: "No items yet." })}</p>
                    ) : (
                      <ul className="asset-workspace-list">
                        {group.items.map((item) => (
                          <li key={item.collectibleId} className="asset-workspace-row">
                            <div className="asset-workspace-mark asset-workspace-mark--collectible">
                              {labelOf(item.name).slice(0, 1)}
                            </div>
                            <button
                              className="asset-workspace-row__button"
                              type="button"
                              onClick={() => router.push(`/collectibles/detail?providerId=${encodeURIComponent(item.providerId)}&collectibleId=${encodeURIComponent(item.collectibleId)}`)}
                            >
                              <div className="asset-workspace-row__body">
                                <strong>{labelOf(item.name)}</strong>
                                <span>{item.collectibleId}</span>
                              </div>
                              <div className="asset-workspace-row__meta">
                                <span className={`asset-workspace-pill is-${item.status}`}>{item.status}</span>
                                <span className={`asset-workspace-pill is-${group.network}`}>{networkLabel(group.network, t)}</span>
                                {item.preview?.contentType ? <strong>{item.preview.contentType}</strong> : null}
                              </div>
                            </button>
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

export function CollectibleDetailPage() {
  const { t } = useI18n();
  const providerId = readQuery("providerId");
  const collectibleId = readQuery("collectibleId");
  const transferRegistry = useCapability<CollectibleTransferRegistry>("collectible-transfer.registry");
  const supportsTransfer = useMemo(() => Boolean(providerId && collectibleId && transferRegistry.listSupporting({ providerId, collectibleId }).length > 0), [collectibleId, providerId, transferRegistry]);
  if (!providerId || !collectibleId) {
    return <EmptyState title={t("collectibles.redirect.missing", { defaultValue: "缺少 providerId/collectibleId 参数。" })} />;
  }
  return (
    <div className="asset-workspace-page collectible-detail">
      <PageHeader title={t("collectibles.route.detail", { defaultValue: "藏品详情" })} />
      <p className="asset-workspace-detail-code">{providerId}:{collectibleId}</p>
      {supportsTransfer ? <Button onClick={() => router.push(`/collectibles/transfer?providerId=${encodeURIComponent(providerId)}&collectibleId=${encodeURIComponent(collectibleId)}`)}>{t("collectibles.detail.transfer", { defaultValue: "转移" })}</Button> : null}
    </div>
  );
}
