// packages/plugin-transfer/src/TransferPage.tsx
// 转账页面：聚合 provider 的 Transfer Offer -> 选中 -> 挂载 provider 自己的 Widget。
// 设计缘由：transfer 平台不解释 P2PKH/UTXO/地址/金额/矿工费。
// 提供错误边界，避免单个 provider Widget 崩溃影响其他 Offer。
// 硬切换 008：页面级 keyspace guard——无 key 时显示 empty state，
// 不让用户进入"假可操作"状态；active key 切换时清空 selected/completion。
//
// 硬切换 005 收尾：删掉 "all 模式" 提示。平台 active key 唯一——无
// active key 时由壳层 AppShell 阻断，本页面不再显示"all mode 请选择 key"，
// 只保留"无 provider"空态与正常业务流。
//
// 硬切换 003：使用 Resource Store 读取 Transfer Offer 列表。
// 跨标签同步、请求去重、失效批处理由 resource 处理。

import { Component, type ComponentType, type ErrorInfo, type ReactNode, useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader } from "@keymaster/ui";
import { router, useCapability, useCurrentPath, useI18n, useLocale, usePluginHost, useRegistry, useResourceSelector } from "@keymaster/runtime";
import type { ActiveKeyState, CollectibleRegistry, CollectibleTransferRegistry, CollectibleSummary, TransferCompletion, TransferOffer, TransferProvider, TransferRegistry } from "@keymaster/contracts";
import { TransferOfferPicker } from "./TransferOfferPicker.js";
import type { TransferFeatureCapability, TransferRequest } from "./transferFeature.js";

const EMPTY_OFFERS: TransferOffer[] = [];
const EMPTY_ACTIVE_KEY: ActiveKeyState = { activePublicKeyHex: undefined };
const EMPTY_COLLECTIBLES: Array<{ providerId: string; items: CollectibleSummary[]; error?: string }> = [];

interface ContactPickerProps {
  value?: string;
  onChange: (publicKeyHex: string) => void;
  placeholder?: string;
}

export function TransferPage() {
  const registry = useCapability<TransferRegistry>("transfer.registry");
  const collectibleRegistry = useCapability<CollectibleRegistry>("collectible.registry");
  const collectibleTransferRegistry = useCapability<CollectibleTransferRegistry>("collectible-transfer.registry");
  const collectibleHandlerIds = useRegistry((h) => h.collectibleTransfer._ids().join("\u0000"));
  const host = usePluginHost();
  const { t } = useI18n();
  const ContactPicker = useCapabilityOrNull<ComponentType<ContactPickerProps>>("contacts.picker");
  const feature = useTransferFeature();
  const locale = useLocale();
  useCurrentPath();
  const recipientPublicKeyHex = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("recipientPublicKeyHex") ?? undefined : undefined;
  const normalizedRecipientTarget = recipientPublicKeyHex?.trim().toLowerCase();
  const recipientTarget = normalizedRecipientTarget && /^(02|03)[0-9a-f]{64}$/.test(normalizedRecipientTarget) ? normalizedRecipientTarget : undefined;
  const invalidRecipientTarget = recipientPublicKeyHex !== undefined && !recipientTarget;
  const store = host.resourceStore;
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );
  const providers = useMemo(() => registry.list(), [registry]);
  const featureSources = feature.listSources();
  const quoteProviders = feature.listQuoteProviders();
  const reviewSections = feature.listReviewSections();
  const submitHandlers = feature.listSubmitHandlers();

  // 使用 Resource Store 读取 Transfer Offer 列表
  const allOffers = useResourceSelector<TransferOffer[], TransferOffer[]>(
    store,
    "transfer.offers",
    [],
    (snapshot) => snapshot.data ?? EMPTY_OFFERS,
    (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        const oa = a[i];
        const ob = b[i];
        if (!oa || !ob) return oa === ob;
        if (oa.id !== ob.id) return false;
      }
      return true;
    }
  );
  const visibleOffers = useMemo(() => recipientTarget
    ? allOffers.filter((offer) => providers.find((p) => p.id === offer.providerId)?.supportsRecipientPublicKeyHex?.(recipientTarget) === true)
    : allOffers, [allOffers, providers, recipientTarget]);
  const activeState = useResourceSelector<ActiveKeyState, ActiveKeyState>(
    store,
    "transfer.active-key",
    [],
    (snapshot) => snapshot.data ?? EMPTY_ACTIVE_KEY,
    (a, b) => a.activePublicKeyHex === b.activePublicKeyHex
  );
  const recipientCollectibles = useResourceSelector<typeof EMPTY_COLLECTIBLES, typeof EMPTY_COLLECTIBLES>(
    host.resourceStore,
    "transfer.recipient-collectibles",
    [],
    (snapshot) => snapshot.data ?? EMPTY_COLLECTIBLES,
    (a, b) => a === b
  );
  const visibleRecipientCollectibles = useMemo(() => recipientTarget
    ? recipientCollectibles.flatMap((group) => group.items.filter((item) => collectibleTransferRegistry.listSupporting({ providerId: group.providerId, collectibleId: item.collectibleId }).some((handler) => {
      try { return handler.supportsRecipientPublicKeyHex(recipientTarget); } catch { return false; }
    })).map((item) => ({ ...item, providerId: group.providerId })))
    : [], [collectibleRegistry, collectibleHandlerIds, collectibleTransferRegistry, recipientCollectibles, recipientTarget]);

  useEffect(() => {
    host.resourceStore.invalidate("transfer.recipient-collectibles", []);
  }, [collectibleHandlerIds, host.resourceStore]);

  // 本地交互 state
  const [selected, setSelected] = useState<TransferOffer | undefined>(undefined);
  const [completion, setCompletion] = useState<TransferCompletion | undefined>(undefined);
  const [sourceId, setSourceId] = useState<string | undefined>(undefined);
  const [quote, setQuote] = useState<unknown>(undefined);
  const [submission, setSubmission] = useState<unknown>(undefined);
  const [hookError, setHookError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // 当 offers 变化时，清除已不存在的 selected
  useEffect(() => {
    if (selected && !visibleOffers.find((o) => o.id === selected.id)) {
      setSelected(undefined);
    }
    if (!selected) { setSourceId(undefined); setQuote(undefined); setSubmission(undefined); }
  }, [visibleOffers, selected]);

  useEffect(() => {
    setSourceId(undefined);
    setQuote(undefined);
    setSubmission(undefined);
    setHookError(undefined);
  }, [selected?.id]);

  // active key 变化时清空仅属于当前 key 的本地交互状态。
  useEffect(() => {
    setSelected(undefined);
    setCompletion(undefined);
    setSourceId(undefined);
    setQuote(undefined);
    setSubmission(undefined);
  }, [activeState.activePublicKeyHex]);

  useEffect(() => {
    setSelected(undefined);
    setCompletion(undefined);
    setSourceId(undefined);
    setQuote(undefined);
    setSubmission(undefined);
    setHookError(undefined);
  }, [recipientTarget]);

  const selectedProvider: TransferProvider | undefined = useMemo(
    () => (selected ? providers.find((p) => p.id === selected.providerId) : undefined),
    [selected, providers]
  );

  function handleCompleted(result: TransferCompletion) {
    setCompletion(result);
    setSelected(undefined);
  }

  function selectRecipient(publicKeyHex: string) {
    const canonical = publicKeyHex.trim().toLowerCase();
    if (!/^(02|03)[0-9a-f]{64}$/.test(canonical)) return;
    router.push(`/transfer?recipientPublicKeyHex=${encodeURIComponent(canonical)}`);
  }

  const compatibleSources = selected
    ? featureSources.filter((source) => source.supports ? source.supports(selected) : true)
    : [];
  const selectedSource = compatibleSources.find((source) => source.id === sourceId) ?? compatibleSources[0];
  const requestFor = (): TransferRequest | undefined => selected && selectedSource ? {
    offer: selected,
    sourceId: selectedSource.id,
    draft: selectedSource.createDraft?.(selected),
    quote
  } : undefined;
  async function requestQuote() {
    const request = requestFor();
    const provider = quoteProviders[0];
    if (!request || !provider) return;
    setHookError(undefined);
    try { setQuote(await provider.quote(request)); } catch (error) { setHookError(error instanceof Error ? error.message : String(error)); }
  }
  async function submitTransfer() {
    const request = requestFor();
    const handler = submitHandlers[0];
    if (!request || !handler) return;
    setSubmitting(true); setHookError(undefined);
    try { setSubmission(await handler.submit(request)); } catch (error) { setHookError(error instanceof Error ? error.message : String(error)); }
    finally { setSubmitting(false); }
  }

  if (!activeState.activePublicKeyHex) {
    return (
      <div className="transfer-page">
        <PageHeader
          title={t("transfer.route.title", { defaultValue: "转账" })}
          description={t("transfer.page.desc.noKey", { defaultValue: "还没有可用的 key。" })}
        />
        <EmptyState
          title={t("transfer.page.empty.noKey.title", { defaultValue: "还没有 key" })}
          description={t("transfer.page.empty.noKey.desc", { defaultValue: "导入或创建一个 key 后再开始转账。" })}
        />
      </div>
    );
  }

  if (invalidRecipientTarget) return <div className="transfer-page"><PageHeader title={t("transfer.route.title", { defaultValue: "转账" })} /><EmptyState title={t("transfer.page.invalidRecipient", { defaultValue: "联系人转账目标无效" })} /></div>;
  if (recipientTarget && visibleOffers.length === 0 && visibleRecipientCollectibles.length === 0) return <div className="transfer-page"><PageHeader title={t("transfer.route.title", { defaultValue: "转账" })} /><EmptyState title={t("transfer.page.noRecipientProvider", { defaultValue: "当前没有可向该联系人公钥转账的资产" })} description={recipientTarget.slice(0, 10) + "…"} /><button type="button" onClick={() => router.push("/transfer")}>{t("transfer.page.clearRecipient", { defaultValue: "清除目标，浏览全部资产" })}</button></div>;

  if (providers.length === 0 && !recipientTarget) {
    return (
      <div className="transfer-page">
        <PageHeader
          title={t("transfer.route.title", { defaultValue: "转账" })}
          description={t("transfer.page.desc.noProvider", { defaultValue: "还没有可用的转账 provider。" })}
        />
        <EmptyState
          title={t("transfer.page.empty.noProvider.title", { defaultValue: "没有 provider" })}
          description={t("transfer.page.empty.noProvider.desc", { defaultValue: "安装至少一个转账资产 provider（例如 plugin-p2pkh）后这里会出现选项。" })}
        />
      </div>
    );
  }


  return (
    <div className="transfer-page">
      <PageHeader
        title={t("transfer.route.title", { defaultValue: "转账" })}
        description={t("transfer.page.desc.default", { defaultValue: "先确认收款人，再选择资产类型；资产插件负责展示并核对实际收款形式。" })}
      />
      <section className="transfer-page__step-card transfer-page__recipient" aria-labelledby="transfer-recipient-title">
        <div className="transfer-page__step-heading">
          <span>1</span>
          <div><h3 id="transfer-recipient-title">{t("transfer.page.recipient.title", { defaultValue: "收款人" })}</h3><p>{t("transfer.page.recipient.hint", { defaultValue: "联系人传递的是公钥；资产类型会将其投影为可核对的收款地址或其它收款形式。" })}</p></div>
        </div>
        {recipientTarget ? (
          <div className="transfer-page__recipient-summary" data-testid="recipient-target" data-recipient-public-key-hex={recipientTarget}>
            <div><span>{t("transfer.page.recipient.publicKey", { defaultValue: "收款人公钥" })}</span><code>{recipientTarget}</code></div>
            <button type="button" onClick={() => router.push("/transfer")}>{t("transfer.page.recipient.change", { defaultValue: "更换收款人" })}</button>
          </div>
        ) : ContactPicker ? (
          <div className="transfer-page__recipient-picker">
            <ContactPicker value="" onChange={selectRecipient} placeholder={t("transfer.page.recipient.placeholder", { defaultValue: "选择联系人" })} />
            <p>{t("transfer.page.recipient.manualAddress", { defaultValue: "若资产只接受地址，可直接在选择资产后填写并核对地址。" })}</p>
          </div>
        ) : <p className="transfer-page__recipient-unavailable">{t("transfer.page.recipient.manualAddress", { defaultValue: "若资产只接受地址，可直接在选择资产后填写并核对地址。" })}</p>}
      </section>
      <section className="transfer-page__step-card transfer-page__asset-stage" data-transfer-source-count={featureSources.length} data-transfer-quote-count={quoteProviders.length} data-transfer-submit-count={submitHandlers.length}>
        <div className="transfer-page__step-heading"><span>2</span><div><h3>{t("transfer.page.assetType.title", { defaultValue: "资产类型" })}</h3><p>{recipientTarget ? t("transfer.page.assetType.targetHint", { defaultValue: "仅显示支持该收款人公钥的资产。" }) : t("transfer.page.assetType.manualHint", { defaultValue: "选择资产后，按该资产的收款地址或公钥规则完成核对。" })}</p></div></div>
        <div className="transfer-page__asset-grid"><TransferOfferPicker offers={visibleOffers} value={selected?.id} onChange={setSelected} /></div>
      </section>
      {recipientTarget && visibleRecipientCollectibles.length > 0 ? <section className="transfer-page__collectibles" data-transfer-section="collectibles"><h3>{t("transfer.section.collectibles", { defaultValue: "收藏品" })}</h3>{visibleRecipientCollectibles.map((item) => <button key={`${item.providerId}:${item.collectibleId}`} type="button" onClick={() => router.push(`/collectibles/transfer?providerId=${encodeURIComponent(item.providerId)}&collectibleId=${encodeURIComponent(item.collectibleId)}&recipientPublicKeyHex=${encodeURIComponent(recipientTarget)}`)}>{host.i18n.text(item.name)}</button>)}</section> : null}
      {selected && (compatibleSources.length > 0 || quoteProviders.length > 0 || submitHandlers.length > 0) ? (
        <section className="transfer-page__feature-flow">
          {compatibleSources.length > 0 ? <label>
            {t("transfer.feature.source", { defaultValue: "Source" })}
            <select value={selectedSource?.id ?? ""} onChange={(event) => { setSourceId(event.target.value); setQuote(undefined); setSubmission(undefined); }}>
              {compatibleSources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
            </select>
          </label> : null}
          {quoteProviders.length > 0 ? <button type="button" disabled={!selectedSource} onClick={() => void requestQuote()}>{t("transfer.feature.getQuote", { defaultValue: "Get quote" })}</button> : null}
          {quote !== undefined ? <pre>{formatHookResult(quote)}</pre> : null}
          {submitHandlers.length > 0 ? <button type="button" disabled={!selectedSource || submitting || (quoteProviders.length > 0 && quote === undefined)} onClick={() => void submitTransfer()}>{submitting ? t("transfer.feature.submitting", { defaultValue: "Submitting…" }) : t("transfer.feature.submit", { defaultValue: "Submit transfer" })}</button> : null}
          {submission !== undefined ? <pre>{formatHookResult(submission)}</pre> : null}
          {hookError ? <p className="transfer-page__error">{hookError}</p> : null}
        </section>
      ) : null}
      {selected && selectedProvider ? (
        <section className="transfer-page__provider-widget">
          <ProviderErrorBoundary
            providerId={selectedProvider.id}
            onReset={() => setSelected(undefined)}
            t={t}
          >
            <selectedProvider.component offer={selected} onCompleted={handleCompleted} recipientPublicKeyHex={recipientTarget} />
          </ProviderErrorBoundary>
        </section>
      ) : null}
      {selected ? reviewSections.map((section) => <section key={section.id} className="transfer-page__review"><section.component /></section>) : null}
      {selected && !selectedProvider ? (
        <p className="transfer-page__error">
          {t("transfer.page.err.providerGone", { defaultValue: "该 Offer 对应的 provider 不再可用。" })}
        </p>
      ) : null}
      {completion ? (
        <section>
          <h3>{t("transfer.page.completed", { defaultValue: "已完成" })}</h3>
          <p>
            {completion.providerId} / {completion.assetId}
            {completion.reference ? (
              <>
                {" "}
                {t("transfer.page.txidPrefix", { defaultValue: " · txid " })}
                <code>{completion.reference}</code>
              </>
            ) : null}
          </p>
          <p>{dateFmt.format(new Date(completion.completedAt))}</p>
        </section>
      ) : null}
    </div>
  );
}

function formatHookResult(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
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

interface ProviderErrorBoundaryProps {
  providerId: string;
  onReset: () => void;
  children: ReactNode;
  t: (k: string, opts?: { defaultValue?: string }) => string;
}
interface ProviderErrorBoundaryState {
  error: Error | null;
}
class ProviderErrorBoundary extends Component<ProviderErrorBoundaryProps, ProviderErrorBoundaryState> {
  state: ProviderErrorBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): ProviderErrorBoundaryState {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Provider widget crashed", this.props.providerId, error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="transfer-page__error">
          <p>
            {this.props.t("transfer.page.err.widget", { defaultValue: "该 provider 的转移 Widget 出现错误：" })}
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset();
            }}
          >
            {this.props.t("common.action.close", { defaultValue: "关闭" })}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
