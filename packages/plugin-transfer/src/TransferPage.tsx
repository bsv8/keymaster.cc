// packages/plugin-transfer/src/TransferPage.tsx
// 转账页面：聚合 provider 的 Transfer Offer -> 选中 -> 挂载 provider 自己的 Widget。
// 设计缘由：transfer 平台不解释 P2PKH/UTXO/地址/金额/矿工费。
// 提供错误边界，避免单个 provider Widget 崩溃影响其他 Offer。
// 硬切换 008：页面级 keyspace guard——all 模式或无 key 时显示 empty state，
// 不让用户进入"假可操作"状态；active key 切换时清空 selected/completion。
//
// 硬切换 003：所有展示文案走 i18n；TransferOffer.label 走 host.i18n.text() 解析。

import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader } from "@keymaster/ui";
import { useCapability, useI18n, useLocale, usePluginHost } from "@keymaster/runtime";
import type { KeyspaceService, TransferCompletion, TransferOffer, TransferProvider, TransferRegistry } from "@keymaster/contracts";
import { TransferOfferPicker } from "./TransferOfferPicker.js";

export function TransferPage() {
  const registry = useCapability<TransferRegistry>("transfer.registry");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const host = usePluginHost();
  const { t } = useI18n();
  useI18n().language();
  const locale = useLocale();
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );
  const providers = useMemo(() => registry.list(), [registry]);
  const [allOffers, setAllOffers] = useState<TransferOffer[]>([]);
  const [selected, setSelected] = useState<TransferOffer | undefined>(undefined);
  const [completion, setCompletion] = useState<TransferCompletion | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [activeState, setActiveState] = useState(() => keyspace.active());

  useEffect(() => {
    const off: Array<() => void> = [];
    let cancelled = false;
    async function load() {
      const out: TransferOffer[] = [];
      for (const p of providers) {
        try {
          const list = await p.listOffers();
          for (const o of list) out.push(o);
        } catch {
          // 单 provider 失败不影响其他
        }
      }
      if (!cancelled) setAllOffers(out);
    }
    void load();
    for (const p of providers) {
      off.push(p.onChange(() => setVersion((v) => v + 1)));
    }
    return () => {
      cancelled = true;
      for (const f of off) f();
    };
  }, [providers, version]);

  useEffect(() => {
    if (selected && !allOffers.find((o) => o.id === selected.id)) {
      setSelected(undefined);
    }
  }, [allOffers, selected]);

  useEffect(() => {
    return keyspace.onActiveChange((s) => {
      setActiveState(s);
      setSelected(undefined);
      setCompletion(undefined);
    });
  }, [keyspace]);

  const selectedProvider: TransferProvider | undefined = useMemo(
    () => (selected ? providers.find((p) => p.id === selected.providerId) : undefined),
    [selected, providers]
  );

  function handleCompleted(result: TransferCompletion) {
    setCompletion(result);
    setSelected(undefined);
  }

  if (activeState.mode === "all") {
    return (
      <div className="transfer-page">
        <PageHeader
          title={t("transfer.route.title", { defaultValue: "转账" })}
          description={t("transfer.page.desc.pickKey", { defaultValue: "转账要求 single 模式。" })}
        />
        <EmptyState
          title={t("transfer.page.empty.allMode.title", { defaultValue: "请选择一个 key" })}
          description={t("transfer.page.empty.allMode.desc", { defaultValue: "到顶栏选择一把具体的 key 后再开始转账。" })}
        />
      </div>
    );
  }
  if (!activeState.activePublicKeyHash) {
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
      <section>
        <h3>{t("transfer.page.assets", { defaultValue: "资产" })}</h3>
        <TransferOfferPicker
          offers={allOffers}
          value={selected?.id}
          onChange={setSelected}
        />
      </section>
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
