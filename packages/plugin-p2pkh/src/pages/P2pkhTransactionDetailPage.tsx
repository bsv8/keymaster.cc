import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, PageHeader, formatSats } from "@keymaster/ui";
import { useOptionalCapability } from "webloom-framework/react";
import { router, useI18n, useOptionalResourceSelector, usePluginHost } from "@keymaster/runtime";
import type { P2pkhGlobalSettings, P2pkhHistoryRecord, P2pkhLocalTransaction, P2pkhService, P2pkhTransactionDetail } from "../p2pkhContracts.js";
import { P2PKH_CAPABILITY } from "../p2pkhContracts.js";
import { formatLocalTime, listPath, readPage, readTransactionId, readTransactionNetwork, readTransactionSource, readTransactionSubmissionId } from "./p2pkhTransactionView.js";
import { type WalletSnapshot } from "./P2pkhWalletPage.js";

function emptyWallet(): WalletSnapshot {
  return {
    resources: [], history: [], locals: [], claims: [], utxos: [], utxosAvailable: false, protectedOutpoints: [], sync: [], syncStatus: "idle", balances: {},
    historyCursors: {}, localCursors: {}, claimCursors: {}
  };
}

function amountLabel(value: number | undefined): string {
  return value === undefined ? "—" : formatSats(value);
}

function InputRow({ outpointKey }: { outpointKey: string }) {
  const [txid, vout] = outpointKey.split(":");
  return <li><span className="p2pkh-tx-detail__row-index">↪</span><code>{txid}:{vout}</code></li>;
}

function OutputRow({ vout, value, scriptHex, owned }: { vout: number; value: number; scriptHex: string; owned: boolean }) {
  return <li><span className="p2pkh-tx-detail__row-index">↗</span><span>#{vout}</span><strong>{formatSats(value)}</strong>{owned ? <span className="p2pkh-tx-detail__owned">owned</span> : null}<code className="p2pkh-tx-detail__script">{scriptHex || "—"}</code></li>;
}

export function P2pkhTransactionDetailPage() {
  const { t } = useI18n();
  // owner 作用域 capability 会在锁定时撤销；路由组件在锁定瞬间仍可能完成
  // 一次渲染，必须按"暂不可用"降级而不是抛错。
  const service = useOptionalCapability(P2PKH_CAPABILITY);
  if (!service) {
    return (
      <EmptyState
        title={t("p2pkh.detail.locked.title", { defaultValue: "钱包已锁定" })}
        description={t("p2pkh.detail.locked.description", { defaultValue: "解锁后可继续查看交易详情。" })}
      />
    );
  }
  return <P2pkhTransactionDetailPageInner service={service} />;
}

function P2pkhTransactionDetailPageInner({ service }: { service: P2pkhService }) {
  const host = usePluginHost();
  const { t } = useI18n();
  const network = readTransactionNetwork();
  const page = readPage();
  const source = readTransactionSource();
  const txid = readTransactionId();
  const submissionId = readTransactionSubmissionId();
  const routeResourceId = `p2pkh:${network}`;
  const settings = useOptionalResourceSelector<P2pkhGlobalSettings, P2pkhGlobalSettings>(
    host.resourceStore,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data ?? { includeTestnet: false },
    { includeTestnet: false }
  );
  const wallet = useOptionalResourceSelector<WalletSnapshot, WalletSnapshot & { error?: string; loaded: boolean }>(
    host.resourceStore,
    "p2pkh.wallet",
    [],
    (snapshot) => snapshot.data
      ? {
          ...snapshot.data,
          historyCursors: snapshot.data.historyCursors ?? {},
          localCursors: snapshot.data.localCursors ?? {},
          claimCursors: snapshot.data.claimCursors ?? {},
          error: snapshot.error?.message,
          loaded: true
        }
      : { ...emptyWallet(), error: snapshot.error?.message, loaded: false },
    { ...emptyWallet(), loaded: false }
  );
  const networkEnabled = network === "main" || settings.includeTestnet;
  const snapshotHistory = useMemo(() => source === "transactions" && txid ? wallet.history.find((row) => row.network === network && row.txid.toLowerCase() === txid.toLowerCase()) : undefined, [wallet.history, network, txid, source]);
  const snapshotLocal = useMemo(() => {
    if (source !== "local-transactions" || !txid) return undefined;
    const matches = wallet.locals.filter((row) => row.resourceId === routeResourceId && row.network === network && row.txid.toLowerCase() === txid.toLowerCase());
    if (submissionId) return matches.find((row) => row.id === submissionId);
    return matches.sort((left, right) => left.id.localeCompare(right.id))[0];
  }, [wallet.locals, network, routeResourceId, txid, source, submissionId]);

  const [historyRecord, setHistoryRecord] = useState<P2pkhHistoryRecord | undefined>();
  const [localRecord, setLocalRecord] = useState<P2pkhLocalTransaction | undefined>();
  const [detail, setDetail] = useState<P2pkhTransactionDetail | undefined>();
  const [detailError, setDetailError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  // 历史记录可能不在钱包首屏的有界分页里；按 txid 深读一次本地历史。
  useEffect(() => {
    let cancelled = false;
    setHistoryRecord(undefined);
    setLocalRecord(undefined);
    if (!txid || !networkEnabled) return;
    if (snapshotHistory || snapshotLocal) {
      setHistoryRecord(snapshotHistory);
      setLocalRecord(snapshotLocal);
      return;
    }
    const readRecord = async () => {
      try {
        if (source === "transactions" && service.listHistory) {
          const rows = await service.listHistory({ resourceId: routeResourceId });
          if (!cancelled) setHistoryRecord(rows.find((row) => row.txid.toLowerCase() === txid.toLowerCase()));
        } else if (source === "local-transactions" && service.listLocalTransactions) {
          const rows = await service.listLocalTransactions({ resourceId: routeResourceId, includeResolvedLocalTransactions: true });
          const matches = rows.filter((row) => row.txid.toLowerCase() === txid.toLowerCase());
          if (!cancelled) setLocalRecord(submissionId ? matches.find((row) => row.id === submissionId) : matches.sort((left, right) => left.id.localeCompare(right.id))[0]);
        }
      } catch {
        // 深读失败保持“不可用”展示；不回退到演示数据。
      }
    };
    void readRecord();
    return () => { cancelled = true; };
  }, [service, networkEnabled, txid, routeResourceId, submissionId, source, snapshotHistory, snapshotLocal]);

  const record = source === "transactions" ? (historyRecord ?? snapshotHistory) : undefined;
  const local = source === "local-transactions" ? (localRecord ?? snapshotLocal) : undefined;

  // 打开详情时才按 txid 取 raw transaction 并临时解析；结果只用于展示。
  useEffect(() => {
    let cancelled = false;
    setDetail(undefined);
    setDetailError(undefined);
    if (!txid || !networkEnabled || (!record && !local) || !service.getTransactionDetail) return;
    setLoading(true);
    void service.getTransactionDetail({ resourceId: routeResourceId, network, txid })
      .then((result) => { if (!cancelled) setDetail(result); })
      .catch((error) => { if (!cancelled) setDetailError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [service, networkEnabled, txid, routeResourceId, record, local]);

  const outputTotal = detail ? detail.outputs.reduce((sum, output) => sum + output.value, 0) : undefined;
  const timestamp = record ? formatLocalTime(record.firstSeenAt) : formatLocalTime(local?.updatedAt);
  const back = () => router.push(listPath(network, page, source));

  if (!txid || !networkEnabled || (!record && !local)) {
    const disabled = !networkEnabled;
    return <div className="p2pkh-tx-detail"><PageHeader title={t("p2pkh.txDetail.title", { defaultValue: "Transaction details" })} actions={<Button variant="ghost" onClick={back}>{t("p2pkh.action.backToTransactions", { defaultValue: "Back to transactions" })}</Button>} /><EmptyState title={disabled ? t("p2pkh.wallet.networkDisabled", { defaultValue: "Testnet is disabled" }) : t("p2pkh.txDetail.unavailable", { defaultValue: "本地没有这笔交易" })} description={disabled ? t("p2pkh.wallet.networkDisabledDescription", { defaultValue: "Enable testnet in P2PKH settings before viewing testnet data." }) : wallet.error ?? t("p2pkh.txDetail.unavailableDescription", { defaultValue: "此页面只展示本钱包已知的历史记录。" })} /></div>;
  }

  return <div className="p2pkh-tx-detail">
    <PageHeader title={t("p2pkh.txDetail.title", { defaultValue: "Transaction details" })} description={`${network === "main" ? "Mainnet" : "Testnet"} · ${txid}`} actions={<Button variant="ghost" onClick={back}>{t("p2pkh.action.backToTransactions", { defaultValue: "Back to transactions" })}</Button>} />
    <section className="p2pkh-tx-detail__summary" aria-label={t("p2pkh.txDetail.summary", { defaultValue: "Transaction summary" })}>
      <dl>
        <div><dt>{t("p2pkh.txDetail.txid", { defaultValue: "Transaction ID" })}</dt><dd><code>{txid}</code></dd></div>
        <div><dt>{t("p2pkh.txDetail.network", { defaultValue: "Network" })}</dt><dd>{network === "main" ? "Mainnet" : "Testnet"}</dd></div>
        {timestamp ? <div><dt>{t("p2pkh.txDetail.observedAt", { defaultValue: "Observed locally" })}</dt><dd>{timestamp}</dd></div> : null}
        {record && record.height > 0 ? <div><dt>{t("p2pkh.txDetail.block", { defaultValue: "Block" })}</dt><dd>{record.height}</dd></div> : null}
        {record?.fee !== undefined ? <div><dt>{t("p2pkh.txDetail.fee", { defaultValue: "Fee paid" })}</dt><dd>{formatSats(record.fee)}</dd></div> : null}
        {detail ? <div><dt>{t("p2pkh.txDetail.size", { defaultValue: "Size" })}</dt><dd>{detail.sizeBytes} B</dd></div> : null}
        {local ? <><div><dt>{t("p2pkh.txDetail.state", { defaultValue: "Local state" })}</dt><dd>{t(`p2pkh.state.${local.localState}`, { defaultValue: local.localState })}</dd></div><div><dt>{t("p2pkh.txDetail.chainResolution", { defaultValue: "Chain resolution" })}</dt><dd>{t(`p2pkh.resolution.${local.chainResolution}`, { defaultValue: local.chainResolution })}</dd></div>{local.isolationReason ? <div><dt>{t("p2pkh.txDetail.isolationReason", { defaultValue: "Isolation reason" })}</dt><dd>{local.isolationReason}</dd></div> : null}{local.confirmedHistoryId ? <div><dt>{t("p2pkh.txDetail.confirmedHistoryId", { defaultValue: "Confirmed history record" })}</dt><dd><code>{local.confirmedHistoryId}</code></dd></div> : null}{local.resolvedAt ? <div><dt>{t("p2pkh.txDetail.resolvedAt", { defaultValue: "Resolved at" })}</dt><dd>{formatLocalTime(local.resolvedAt)}</dd></div> : null}</> : null}
      </dl>
    </section>
    {loading ? <p className="p2pkh-tx-detail__muted">{t("p2pkh.txDetail.loading", { defaultValue: "正在读取本地交易" })}</p> : null}
    {detailError ? <p className="p2pkh-tx-detail__muted" role="alert">{detailError}</p> : null}
    <div className="p2pkh-tx-detail__columns">
      <section className="p2pkh-tx-detail__card"><header><h2>{detail?.inputs.length ?? 0} {t("p2pkh.txDetail.inputs", { defaultValue: "Inputs" })}</h2><span>{t("p2pkh.txDetail.totalInput", { defaultValue: "Total input" })} <strong>{amountLabel(undefined)}</strong></span></header><ul>{(detail?.inputs ?? []).map((input) => <InputRow key={input.outpointKey} outpointKey={input.outpointKey} />)}</ul><p className="p2pkh-tx-detail__muted">{t("p2pkh.txDetail.inputUnavailable", { defaultValue: "输入金额不在本地保存；详情只展示 outpoint。" })}</p></section>
      <section className="p2pkh-tx-detail__card"><header><h2>{detail?.outputs.length ?? 0} {t("p2pkh.txDetail.outputs", { defaultValue: "Outputs" })}</h2><span>{t("p2pkh.txDetail.totalOutput", { defaultValue: "Total output" })} <strong>{amountLabel(outputTotal)}</strong></span></header><ul>{(detail?.outputs ?? []).map((output) => <OutputRow key={output.vout} vout={output.vout} value={output.value} scriptHex={output.scriptHex} owned={false} />)}</ul>{!detail ? <p className="p2pkh-tx-detail__muted">{t("p2pkh.txDetail.rawUnavailable", { defaultValue: "raw transaction 尚未加载或不可用。" })}</p> : null}</section>
    </div>
    {local ? <section className="p2pkh-tx-detail__local"><h2>{t("p2pkh.txDetail.localRecord", { defaultValue: "Local record" })}</h2>{local.attempts.length ? <><p>{t("p2pkh.txDetail.attempts", { defaultValue: "Broadcast attempts" })}</p><ul>{local.attempts.map((attempt) => <li key={attempt.id}><code>{attempt.id}</code> · {attempt.status}</li>)}</ul></> : null}</section> : null}
  </div>;
}

export function P2pkhTransactionDetailRoute() {
  return <P2pkhTransactionDetailPage />;
}
