import { useEffect, useMemo, useState } from "react";
import type { ActiveKeyState, CollectibleRegistry, CollectibleSummary, CollectibleTransferRegistry, I18nText, TransferOffer, TransferProvider, TransferRegistry } from "@keymaster/contracts";
import { useCapability, useCurrentPath, useI18n, usePluginHost, useResourceSelector, router } from "@keymaster/runtime";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";
import type { TransferFeatureCapability, TransferRequest } from "./transfer/transferFeature.js";

function labelOf(value: string | I18nText): string {
  return typeof value === "string" ? value : value.fallback;
}

export function TransferPage() {
  useCurrentPath();
  const { t } = useI18n();
  const host = usePluginHost();
  const registry = useCapability<TransferRegistry>("transfer.registry");
  const collectibleTransferRegistry = useCapability<CollectibleTransferRegistry>("collectible-transfer.registry");
  const feature = useTransferFeature();
  const offers = useResourceSelector<TransferOffer[], TransferOffer[]>(
    host.resourceStore,
    "transfer.offers",
    [],
    (snapshot) => snapshot.data ?? []
  );
  const activeState = useResourceSelector<ActiveKeyState, ActiveKeyState>(
    host.resourceStore,
    "transfer.active-key",
    [],
    (snapshot) => snapshot.data ?? { activePublicKeyHex: undefined }
  );
  const recipientCollectibles = useResourceSelector<Array<{ providerId: string; items: CollectibleSummary[]; error?: string }>, Array<{ providerId: string; items: CollectibleSummary[]; error?: string }>>(
    host.resourceStore,
    "transfer.recipient-collectibles",
    [],
    (snapshot) => snapshot.data ?? []
  );
  const [selected, setSelected] = useState<TransferOffer | undefined>();
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");

  useEffect(() => {
    if (selected && !offers.find((offer) => offer.id === selected.id)) {
      setSelected(undefined);
    }
  }, [offers, selected]);

  const providers = useMemo(() => registry.list(), [registry]);
  const recipientPublicKeyHex = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("recipientPublicKeyHex") ?? undefined
    : undefined;
  const normalizedRecipient = recipientPublicKeyHex?.trim().toLowerCase();
  const validRecipient = normalizedRecipient && /^(02|03)[0-9a-f]{64}$/.test(normalizedRecipient) ? normalizedRecipient : undefined;

  if (!activeState.activePublicKeyHex) {
    return <EmptyState title={t("transfer.page.empty.noKey.title", { defaultValue: "还没有 key" })} />;
  }

  const visibleOffers = validRecipient
    ? offers.filter((offer) => providers.find((provider) => provider.id === offer.providerId)?.supportsRecipientPublicKeyHex?.(validRecipient) === true)
    : offers;

  const selectedProvider = selected ? providers.find((provider) => provider.id === selected.providerId) : undefined;
  const compatibleSources = selected ? feature.listSources().filter((source) => (source.supports ? source.supports(selected) : true)) : [];
  const selectedSource = compatibleSources.find((source) => source.id === selectedProviderId) ?? compatibleSources[0];

  return (
    <div className="transfer-page">
      <PageHeader title={t("transfer.route.title", { defaultValue: "转账" })} />
      {visibleOffers.length === 0 ? <EmptyState title={t("transfer.page.empty.noProvider.title", { defaultValue: "没有 provider" })} /> : null}
      {validRecipient ? <p>{validRecipient}</p> : null}
      <section>
        <h3>{t("transfer.page.assets", { defaultValue: "资产" })}</h3>
        {visibleOffers.map((offer) => (
          <button key={offer.id} type="button" onClick={() => setSelected(offer)}>
            {labelOf(offer.label)}
          </button>
        ))}
      </section>
      {recipientCollectibles.length > 0 ? (
        <section>
          <h3>{t("transfer.section.collectibles", { defaultValue: "收藏品" })}</h3>
          {recipientCollectibles.flatMap((group) => group.items.map((item) => (
            <button key={`${group.providerId}:${item.collectibleId}`} type="button" onClick={() => router.push(`/collectibles/transfer?providerId=${encodeURIComponent(group.providerId)}&collectibleId=${encodeURIComponent(item.collectibleId)}${validRecipient ? `&recipientPublicKeyHex=${encodeURIComponent(validRecipient)}` : ""}`)}>
              {labelOf(item.name as never)}
            </button>
          )))}
        </section>
      ) : null}
      {selected && selectedProvider ? (
        <section>
          {compatibleSources.length > 0 ? (
            <select value={selectedSource?.id ?? ""} onChange={(e) => setSelectedProviderId(e.currentTarget.value)}>
              {compatibleSources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
            </select>
          ) : null}
          {(() => {
            const ProviderWidget = selectedProvider.component;
            return (
              <ProviderWidget
                offer={selected}
                recipientPublicKeyHex={validRecipient}
                onCompleted={() => setSelected(undefined)}
              />
            );
          })()}
        </section>
      ) : null}
    </div>
  );
}

function useTransferFeature(): TransferFeatureCapability {
  return useCapability<TransferFeatureCapability>("feature.transfer");
}
