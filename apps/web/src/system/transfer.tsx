import { type ComponentType, useEffect, useMemo, useState } from "react";
import type {
  ActiveKeyState,
  CollectibleSummary,
  CollectibleTransferRegistry,
  I18nText,
  TransferOffer,
  TransferRegistry
} from "@keymaster/contracts";
import {
  router,
  useCapability,
  useCurrentPath,
  useI18n,
  usePluginHost,
  useResourceSelector
} from "@keymaster/runtime";
import { EmptyState, PageHeader } from "@keymaster/ui";
import type { TransferFeatureCapability } from "./transfer/transferFeature.js";

interface ContactPickerProps {
  value?: string;
  onChange(publicKeyHex: string): void;
  placeholder?: string;
}

function labelOf(value: string | I18nText): string {
  return typeof value === "string" ? value : value.fallback;
}

function observationLabel(observation: "unconfirmed" | "confirmed" | undefined, t: (key: string, values?: { defaultValue?: string }) => string): string | undefined {
  if (observation === "unconfirmed") return t("transfer.observation.unconfirmed", { defaultValue: "WOC 已观察（未确认）" });
  if (observation === "confirmed") return t("transfer.observation.confirmed", { defaultValue: "WOC 已确认" });
  return undefined;
}

export function TransferPage() {
  useCurrentPath();
  const { t } = useI18n();
  const host = usePluginHost();
  const registry = useCapability<TransferRegistry>("transfer.registry");
  const collectibleTransferRegistry = useCapability<CollectibleTransferRegistry>("collectible-transfer.registry");
  const ContactPicker = useCapabilityOrNull<ComponentType<ContactPickerProps>>("contacts.picker");
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
  const [selectedSourceId, setSelectedSourceId] = useState("");

  const providers = useMemo(() => registry.list(), [registry]);
  const recipientParameter = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("recipientPublicKeyHex") ?? undefined
    : undefined;
  const normalizedRecipient = recipientParameter?.trim().toLowerCase();
  const validRecipient = normalizedRecipient && /^(02|03)[0-9a-f]{64}$/.test(normalizedRecipient)
    ? normalizedRecipient
    : undefined;
  const invalidRecipient = recipientParameter !== undefined && !validRecipient;

  const visibleOffers = useMemo(() => validRecipient
    ? offers.filter((offer) => providers.find((provider) => provider.id === offer.providerId)?.supportsRecipientPublicKeyHex?.(validRecipient) === true)
    : offers, [offers, providers, validRecipient]);

  const visibleRecipientCollectibles = useMemo(() => validRecipient
    ? recipientCollectibles.flatMap((group) => group.items.flatMap((item) => {
      const supported = collectibleTransferRegistry
        .listSupporting({ providerId: group.providerId, collectibleId: item.collectibleId })
        .some((handler) => {
          try {
            return handler.supportsRecipientPublicKeyHex?.(validRecipient) === true;
          } catch {
            return false;
          }
        });
      return supported ? [{ ...item, providerId: group.providerId }] : [];
    }))
    : [], [collectibleTransferRegistry, recipientCollectibles, validRecipient]);

  useEffect(() => {
    if (selected && !visibleOffers.some((offer) => offer.id === selected.id)) {
      setSelected(undefined);
    }
  }, [selected, visibleOffers]);

  // URL 收款人和 active key 都是转账草稿的身份边界；任一变化都不能沿用旧的资产选择。
  useEffect(() => {
    setSelected(undefined);
    setSelectedSourceId("");
  }, [activeState.activePublicKeyHex, validRecipient]);

  if (!activeState.activePublicKeyHex) {
    return (
      <div className="transfer-page">
        <PageHeader title={t("transfer.route.title", { defaultValue: "转账" })} />
        <EmptyState
          title={t("transfer.page.empty.noKey.title", { defaultValue: "还没有 key" })}
          description={t("transfer.page.empty.noKey.desc", { defaultValue: "导入或创建一个 key 后再开始转账。" })}
        />
      </div>
    );
  }

  if (invalidRecipient) {
    return (
      <div className="transfer-page">
        <PageHeader title={t("transfer.route.title", { defaultValue: "转账" })} />
        <EmptyState title={t("transfer.page.invalidRecipient", { defaultValue: "联系人转账目标无效" })} />
      </div>
    );
  }

  if (validRecipient && visibleOffers.length === 0 && visibleRecipientCollectibles.length === 0) {
    return (
      <div className="transfer-page">
        <PageHeader title={t("transfer.route.title", { defaultValue: "转账" })} />
        <EmptyState
          title={t("transfer.page.noRecipientProvider", { defaultValue: "当前没有可向该联系人公钥转账的资产" })}
          description={`${validRecipient.slice(0, 10)}…`}
        />
        <button type="button" onClick={() => router.push("/transfer")}>
          {t("transfer.page.clearRecipient", { defaultValue: "清除目标，浏览全部资产" })}
        </button>
      </div>
    );
  }

  const selectedProvider = selected ? providers.find((provider) => provider.id === selected.providerId) : undefined;
  const compatibleSources = selected ? feature.listSources().filter((source) => (source.supports ? source.supports(selected) : true)) : [];
  const selectedSource = compatibleSources.find((source) => source.id === selectedSourceId) ?? compatibleSources[0];

  function selectRecipient(publicKeyHex: string) {
    const canonical = publicKeyHex.trim().toLowerCase();
    if (!/^(02|03)[0-9a-f]{64}$/.test(canonical)) return;
    router.push(`/transfer?recipientPublicKeyHex=${encodeURIComponent(canonical)}`);
  }

  return (
    <div className="transfer-page">
      <PageHeader
        title={t("transfer.route.title", { defaultValue: "转账" })}
        description={t("transfer.page.desc.default", { defaultValue: "先确认收款人，再选择资产类型，并在提交前核对收款信息。" })}
      />

      <section className="transfer-page__step-card transfer-page__recipient" aria-labelledby="transfer-recipient-title">
        <div className="transfer-page__step-heading">
          <span>1</span>
          <div>
            <h3 id="transfer-recipient-title">{t("transfer.page.recipient.title", { defaultValue: "收款人" })}</h3>
            <p>{t("transfer.page.recipient.hint", { defaultValue: "可以选择联系人，也可在选择资产后直接填写收款地址。" })}</p>
          </div>
        </div>
        {validRecipient ? (
          <div className="transfer-page__recipient-summary" data-testid="recipient-target" data-recipient-public-key-hex={validRecipient}>
            <div>
              <span>{t("transfer.page.recipient.publicKey", { defaultValue: "收款人公钥" })}</span>
              <code>{validRecipient}</code>
            </div>
            <button type="button" onClick={() => router.push("/transfer")}>
              {t("transfer.page.recipient.change", { defaultValue: "更换收款人" })}
            </button>
          </div>
        ) : ContactPicker ? (
          <div className="transfer-page__recipient-picker">
            <ContactPicker
              value=""
              onChange={selectRecipient}
              placeholder={t("transfer.page.recipient.placeholder", { defaultValue: "选择联系人" })}
            />
            <p>{t("transfer.page.recipient.manualAddress", { defaultValue: "也可跳过联系人，选择资产后直接填写并核对收款地址。" })}</p>
          </div>
        ) : (
          <p className="transfer-page__recipient-unavailable">
            {t("transfer.page.recipient.manualAddress", { defaultValue: "可跳过联系人，选择资产后直接填写并核对收款地址。" })}
          </p>
        )}
      </section>

      <section className="transfer-page__step-card transfer-page__asset-stage">
        <div className="transfer-page__step-heading">
          <span>2</span>
          <div>
            <h3>{t("transfer.page.assetType.title", { defaultValue: "资产类型" })}</h3>
            <p>{validRecipient
              ? t("transfer.page.assetType.targetHint", { defaultValue: "仅显示支持该收款人公钥的资产。" })
              : t("transfer.page.assetType.manualHint", { defaultValue: "选择资产后，继续填写收款地址和金额。" })}</p>
          </div>
        </div>
        <div className="transfer-page__asset-grid">
          {visibleOffers.length === 0 ? (
            <p>{t("transfer.page.empty.picker", { defaultValue: "当前没有可用的转账资产。" })}</p>
          ) : (
            <div className="transfer-picker">
              {visibleOffers.map((offer) => (
                <button
                  key={offer.id}
                  type="button"
                  className={`transfer-picker__item ${selected?.id === offer.id ? "is-selected" : ""} is-${offer.status}`}
                  onClick={() => setSelected(offer)}
                >
                  <span className="transfer-picker__name">{host.i18n.text(offer.label)}</span>
                  {offer.description ? <span className="transfer-picker__desc">{host.i18n.text(offer.description)}</span> : null}
                  {offer.balance ? <span className="transfer-picker__balance">{offer.balance.display ?? `${offer.balance.amount} ${offer.balance.unit}`}</span> : null}
                  <span className={`transfer-picker__status is-${offer.status}`}>{offer.status}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {validRecipient && visibleRecipientCollectibles.length > 0 ? (
        <section className="transfer-page__collectibles">
          <h3>{t("transfer.section.collectibles", { defaultValue: "收藏品" })}</h3>
          {visibleRecipientCollectibles.map((item) => (
            <button
              key={`${item.providerId}:${item.collectibleId}`}
              type="button"
              onClick={() => router.push(`/collectibles/transfer?providerId=${encodeURIComponent(item.providerId)}&collectibleId=${encodeURIComponent(item.collectibleId)}&recipientPublicKeyHex=${encodeURIComponent(validRecipient)}`)}
            >
              {labelOf(item.name as never)}
              {item.observation ? <span>{observationLabel(item.observation, t)}</span> : null}
            </button>
          ))}
        </section>
      ) : null}

      {selected && selectedProvider ? (
        <section className="transfer-page__provider-widget">
          {compatibleSources.length > 0 ? (
            <select value={selectedSource?.id ?? ""} onChange={(event) => setSelectedSourceId(event.currentTarget.value)}>
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
  const capability = useCapability<TransferFeatureCapability>("feature.transfer");
  const [, refresh] = useState(0);
  useEffect(() => capability.subscribe(() => refresh((value) => value + 1)), [capability]);
  return capability;
}

function useCapabilityOrNull<T>(key: string): T | null {
  try {
    return useCapability<T>(key);
  } catch {
    return null;
  }
}
