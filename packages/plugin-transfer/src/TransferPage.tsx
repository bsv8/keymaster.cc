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

import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader } from "@keymaster/ui";
import { useCapability, useI18n, useLocale, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import type { ActiveKeyState, TransferCompletion, TransferOffer, TransferProvider, TransferRegistry } from "@keymaster/contracts";
import { TransferOfferPicker } from "./TransferOfferPicker.js";
import type { TransferFeatureCapability, TransferRequest } from "./transferFeature.js";

const EMPTY_OFFERS: TransferOffer[] = [];
const EMPTY_ACTIVE_KEY: ActiveKeyState = { activePublicKeyHex: undefined };

export function TransferPage() {
  const registry = useCapability<TransferRegistry>("transfer.registry");
  const host = usePluginHost();
  const { t } = useI18n();
  const feature = useTransferFeature();
  const locale = useLocale();
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
  const activeState = useResourceSelector<ActiveKeyState, ActiveKeyState>(
    store,
    "transfer.active-key",
    [],
    (snapshot) => snapshot.data ?? EMPTY_ACTIVE_KEY,
    (a, b) => a.activePublicKeyHex === b.activePublicKeyHex
  );

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
    if (selected && !allOffers.find((o) => o.id === selected.id)) {
      setSelected(undefined);
    }
    if (!selected) { setSourceId(undefined); setQuote(undefined); setSubmission(undefined); }
  }, [allOffers, selected]);

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

  const selectedProvider: TransferProvider | undefined = useMemo(
    () => (selected ? providers.find((p) => p.id === selected.providerId) : undefined),
    [selected, providers]
  );

  function handleCompleted(result: TransferCompletion) {
    setCompletion(result);
    setSelected(undefined);
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

  if (providers.length === 0) {
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
        description={t("transfer.page.desc.default", { defaultValue: "选择资产 Offer，然后由 provider 提供的 Widget 完成输入、预览与提交。" })}
      />
      <section data-transfer-source-count={featureSources.length} data-transfer-quote-count={quoteProviders.length} data-transfer-submit-count={submitHandlers.length}>
        <h3>{t("transfer.page.assets", { defaultValue: "资产" })}</h3>
        <TransferOfferPicker
          offers={allOffers}
          value={selected?.id}
          onChange={setSelected}
        />
      </section>
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
        <section>
          <h3>{host.i18n.text(selected.label)}</h3>
          <ProviderErrorBoundary
            providerId={selectedProvider.id}
            onReset={() => setSelected(undefined)}
            t={t}
          >
            <selectedProvider.component offer={selected} onCompleted={handleCompleted} />
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
