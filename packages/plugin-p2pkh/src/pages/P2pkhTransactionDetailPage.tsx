import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, PageHeader, formatSats } from "@keymaster/ui";
import { router, useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import type { P2pkhGlobalSettings, P2pkhLocalTransaction, P2pkhService, P2pkhTransactionFact } from "../p2pkhContracts.js";
import { formatLocalTime, inputAmount, listPath, parseStoredTransaction, readPage, readTransactionId, readTransactionNetwork, readTransactionSource, readTransactionSubmissionId } from "./p2pkhTransactionView.js";
import { type WalletSnapshot } from "./P2pkhWalletPage.js";

function emptyWallet(): WalletSnapshot {
  return {
    resources: [], facts: [], owned: [], locals: [], localOutpoints: [], claims: [], protectedOutpoints: [], sync: [], syncStatus: "idle", balances: {}, providers: null,
    factCursors: {}, ownedCursors: {}, localCursors: {}, localOutpointCursors: {}, claimCursors: {}, inputValues: {}, inputValuesByResource: {}
  };
}

function amountLabel(value: number | undefined): string {
  return value === undefined ? "—" : formatSats(value);
}

function rawSize(rawTxHex: string | undefined): number | undefined {
  const normalized = rawTxHex?.replace(/^0x/i, "");
  return normalized && normalized.length % 2 === 0 && /^[0-9a-f]+$/i.test(normalized) ? normalized.length / 2 : undefined;
}

function InputRow({ outpointKey, value }: { outpointKey: string; value?: number }) {
  const [txid, vout] = outpointKey.split(":");
  return <li><span className="p2pkh-tx-detail__row-index">↪</span><code>{txid}:{vout}</code><strong>{amountLabel(value)}</strong></li>;
}

function OutputRow({ vout, value, scriptHex, owned }: { vout: number; value: number; scriptHex: string; owned: boolean }) {
  return <li><span className="p2pkh-tx-detail__row-index">↗</span><span>#{vout}</span><strong>{formatSats(value)}</strong>{owned ? <span className="p2pkh-tx-detail__owned">owned</span> : null}<code className="p2pkh-tx-detail__script">{scriptHex || "—"}</code></li>;
}

export function P2pkhTransactionDetailPage() {
  const host = usePluginHost();
  const { t } = useI18n();
  const service = useCapability<P2pkhService>("p2pkh.service");
  const network = readTransactionNetwork();
  const page = readPage();
  const source = readTransactionSource();
  const txid = readTransactionId();
  const submissionId = readTransactionSubmissionId();
  const routeResourceId = `p2pkh:${network}`;
  const settings = useResourceSelector<P2pkhGlobalSettings, P2pkhGlobalSettings>(
    host.resourceStore,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data ?? { includeTestnet: false },
    (left, right) => left.includeTestnet === right.includeTestnet
  );
  const wallet = useResourceSelector<WalletSnapshot, WalletSnapshot & { error?: string; loaded: boolean }>(host.resourceStore, "p2pkh.wallet", [], (snapshot) => snapshot.data ? { ...snapshot.data, factCursors: snapshot.data.factCursors ?? {}, ownedCursors: snapshot.data.ownedCursors ?? {}, localCursors: snapshot.data.localCursors ?? {}, localOutpointCursors: snapshot.data.localOutpointCursors ?? {}, claimCursors: snapshot.data.claimCursors ?? {}, inputValues: snapshot.data.inputValues ?? {}, inputValuesByResource: snapshot.data.inputValuesByResource ?? {}, error: snapshot.error?.message, loaded: true } : { ...emptyWallet(), error: snapshot.error?.message, loaded: false }, (left, right) => JSON.stringify(left) === JSON.stringify(right));
  const networkEnabled = network === "main" || settings.includeTestnet;
  const snapshotFact = useMemo(() => source === "transactions" && txid ? wallet.facts.find((row) => row.network === network && row.txid.toLowerCase() === txid.toLowerCase()) : undefined, [wallet.facts, network, txid, source]);
  const snapshotLocal = useMemo(() => {
    if (source !== "local-transactions" || !txid) return undefined;
    const matches = wallet.locals.filter((row) => row.resourceId === routeResourceId && row.network === network && row.txid.toLowerCase() === txid.toLowerCase());
    if (submissionId) return matches.find((row) => row.id === submissionId);
    return matches.sort((left, right) => left.id.localeCompare(right.id))[0];
  }, [wallet.locals, network, routeResourceId, txid, source, submissionId]);
  const [localFact, setLocalFact] = useState<P2pkhTransactionFact | undefined>();
  const [localRecord, setLocalRecord] = useState<P2pkhLocalTransaction | undefined>();
  const [localInputValues, setLocalInputValues] = useState<Record<string, number>>({});
  const [localOutpointValues, setLocalOutpointValues] = useState<Record<string, number>>({});
  const [loadingLocalRecord, setLoadingLocalRecord] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLocalFact(undefined);
    setLocalRecord(undefined);
    setLocalInputValues({});
    setLocalOutpointValues({});
    // The wallet resource already contains the first local page. Avoid a
    // second full-table read for the common case; only a transaction missing
    // from that bounded snapshot needs the deep local lookup below.
    if (!wallet.loaded || !txid || !networkEnabled || snapshotFact || (source !== "local-transactions" && snapshotLocal)) {
      setLoadingLocalRecord(!wallet.loaded && !wallet.error);
      return;
    }

    const readLocalRecord = async () => {
      // This deliberately reads only the local P2PKH service. No provider or
      // network request is made for a transaction detail page.
      if ((source === "transactions" && !service.listTransactionFacts) || (source === "local-transactions" && !snapshotLocal && !service.listLocalTransactions)) {
        setLoadingLocalRecord(false);
        return;
      }
      setLoadingLocalRecord(true);
      try {
        const [facts, locals] = source === "transactions"
          ? [await service.listTransactionFacts!({ limit: undefined }), [] as P2pkhLocalTransaction[]]
          : [[] as P2pkhTransactionFact[], snapshotLocal ? [snapshotLocal] : await service.listLocalTransactions!({ resourceId: routeResourceId, includeResolvedLocalTransactions: true })];
        if (cancelled) return;
        const nextFact = facts.find((row) => row.network === network && row.txid.toLowerCase() === txid.toLowerCase());
        const localMatches = locals.filter((row) => row.resourceId === routeResourceId && row.network === network && row.txid.toLowerCase() === txid.toLowerCase());
        const nextLocal = submissionId ? localMatches.find((row) => row.id === submissionId) : localMatches.sort((left, right) => left.id.localeCompare(right.id))[0];
        setLocalFact(nextFact);
        setLocalRecord(nextLocal);
        const resourceId = nextFact?.resourceId ?? nextLocal?.resourceId;
        const inputKeys = nextFact?.inputOutpointKeys ?? nextLocal?.inputOutpointKeys ?? [];
        if (resourceId && inputKeys.length > 0 && service.listOwnedOutpointValues) {
          const values = await service.listOwnedOutpointValues(resourceId, inputKeys);
          if (!cancelled) setLocalInputValues(values);
        }
        if (source === "local-transactions" && resourceId && service.listLocalOutpoints) {
          const localOutpoints = await service.listLocalOutpoints({ resourceId });
          if (!cancelled) setLocalOutpointValues(Object.fromEntries(localOutpoints.map((row) => [`${row.txid}:${row.vout}`, row.value])));
        }
      } catch {
        // Keep the resource snapshot as a fallback. It is still local data;
        // an optional deep read failure must not replace it with demo values.
      } finally {
        if (!cancelled) setLoadingLocalRecord(false);
      }
    };
    void readLocalRecord();
    return () => { cancelled = true; };
  }, [service, network, routeResourceId, networkEnabled, txid, submissionId, snapshotFact, snapshotLocal, wallet.loaded, wallet.error, source]);

  const fact = source === "transactions" ? (localFact ?? snapshotFact) : undefined;
  const localRecordMatchesRoute = localRecord
    && localRecord.resourceId === routeResourceId
    && localRecord.network === network
    && localRecord.txid.toLowerCase() === txid?.toLowerCase()
    && (!submissionId || localRecord.id === submissionId)
    ? localRecord
    : undefined;
  const local = source === "local-transactions" ? (snapshotLocal ?? localRecordMatchesRoute) : undefined;
  const rawTxHex = fact?.rawTxHex ?? local?.rawTxHex;
  const parsed = useMemo(() => txid ? parseStoredTransaction(rawTxHex, txid) : undefined, [rawTxHex, txid]);
  const inputKeys = parsed?.inputs.map((input) => input.outpointKey) ?? fact?.inputOutpointKeys ?? local?.inputOutpointKeys ?? [];
  const values = useMemo(() => {
    const ownerResourceId = fact?.resourceId ?? local?.resourceId;
    // Local outpoint projections may be stale; chain-owned values must win so
    // amounts stay consistent with the balance and coin selection views.
    const result: Record<string, number> = { ...localOutpointValues };
    if (source === "local-transactions") for (const row of wallet.localOutpoints) if (!ownerResourceId || row.resourceId === ownerResourceId) result[`${row.txid}:${row.vout}`] = row.value;
    if (fact) Object.assign(result, wallet.inputValuesByResource[fact.resourceId] ?? {});
    if (local) Object.assign(result, wallet.inputValuesByResource[local.resourceId] ?? {});
    Object.assign(result, localInputValues);
    for (const row of wallet.owned) if (row.network === network && (!ownerResourceId || row.resourceId === ownerResourceId)) result[row.outpointKey] = row.value;
    return result;
  }, [fact, local, localInputValues, localOutpointValues, source, network, wallet.inputValuesByResource, wallet.localOutpoints, wallet.owned]);
  const resourceId = fact?.resourceId ?? local?.resourceId ?? "";
  const inputTotals = inputAmount(resourceId, inputKeys, { [resourceId]: values });
  const outputRows = parsed?.outputs ?? fact?.ownedOutputs ?? local?.ownOutputs ?? [];
  const outputTotal = parsed ? parsed.outputs.reduce((sum, output) => sum + output.value, 0) : undefined;
  const inputTotal = inputTotals.value;
  const fee = inputTotal !== undefined && outputTotal !== undefined && inputTotal >= outputTotal ? inputTotal - outputTotal : undefined;
  const ownedKeys = source === "transactions"
    ? new Set([...(fact?.ownedOutpointKeys ?? []), ...(fact?.ownedOutputs ?? []).map((output) => `${txid}:${output.vout}`)])
    : new Set((local?.ownOutputs ?? []).map((output) => `${txid}:${output.vout}`));
  const timestamp = fact?.blockTime !== undefined ? formatLocalTime(fact.blockTime) : formatLocalTime(fact?.lastConfirmedAt ?? local?.updatedAt);
  const back = () => router.push(listPath(network, page, source));

  if (!txid || !networkEnabled || (!fact && !local)) {
    const disabled = !networkEnabled;
    return <div className="p2pkh-tx-detail"><PageHeader title={t("p2pkh.txDetail.title", { defaultValue: "Transaction details" })} actions={<Button variant="ghost" onClick={back}>{t("p2pkh.action.backToTransactions", { defaultValue: "Back to transactions" })}</Button>} /><EmptyState title={disabled ? t("p2pkh.wallet.networkDisabled", { defaultValue: "Testnet is disabled" }) : loadingLocalRecord ? t("p2pkh.txDetail.loading", { defaultValue: "Loading local transaction" }) : t("p2pkh.txDetail.unavailable", { defaultValue: "Transaction is not available locally" })} description={disabled ? t("p2pkh.wallet.networkDisabledDescription", { defaultValue: "Enable testnet in P2PKH settings before viewing testnet data." }) : wallet.error ?? t("p2pkh.txDetail.unavailableDescription", { defaultValue: "This page only displays transaction information stored in this wallet." })} /></div>;
  }

  return <div className="p2pkh-tx-detail">
    <PageHeader title={t("p2pkh.txDetail.title", { defaultValue: "Transaction details" })} description={`${network === "main" ? "Mainnet" : "Testnet"} · ${txid}`} actions={<Button variant="ghost" onClick={back}>{t("p2pkh.action.backToTransactions", { defaultValue: "Back to transactions" })}</Button>} />
    <section className="p2pkh-tx-detail__summary" aria-label={t("p2pkh.txDetail.summary", { defaultValue: "Transaction summary" })}>
      <dl>
        <div><dt>{t("p2pkh.txDetail.txid", { defaultValue: "Transaction ID" })}</dt><dd><code>{txid}</code></dd></div>
        <div><dt>{t("p2pkh.txDetail.network", { defaultValue: "Network" })}</dt><dd>{network === "main" ? "Mainnet" : "Testnet"}</dd></div>
        {timestamp ? <div><dt>{fact?.blockTime !== undefined ? t("p2pkh.txDetail.blockTime", { defaultValue: "Block time (UTC)" }) : t("p2pkh.txDetail.observedAt", { defaultValue: "Observed locally" })}</dt><dd>{timestamp}</dd></div> : null}
        {fact?.blockHeight !== undefined ? <div><dt>{t("p2pkh.txDetail.block", { defaultValue: "Block" })}</dt><dd>{fact.blockHeight}{fact.blockHash ? <><br /><code>{fact.blockHash}</code></> : null}</dd></div> : null}
        {rawSize(rawTxHex) !== undefined ? <div><dt>{t("p2pkh.txDetail.size", { defaultValue: "Size" })}</dt><dd>{rawSize(rawTxHex)} B</dd></div> : null}
        {outputTotal !== undefined ? <div><dt>{t("p2pkh.txDetail.fee", { defaultValue: "Fee paid" })}</dt><dd>{amountLabel(fee)}</dd></div> : null}
        {local ? <><div><dt>{t("p2pkh.txDetail.state", { defaultValue: "Local state" })}</dt><dd>{t(`p2pkh.state.${local.localState}`, { defaultValue: local.localState })}</dd></div><div><dt>{t("p2pkh.txDetail.chainResolution", { defaultValue: "Chain resolution" })}</dt><dd>{t(`p2pkh.resolution.${local.chainResolution}`, { defaultValue: local.chainResolution })}</dd></div>{local.isolationReason ? <div><dt>{t("p2pkh.txDetail.isolationReason", { defaultValue: "Isolation reason" })}</dt><dd>{local.isolationReason}</dd></div> : null}{local.conflictSourceTxids?.length ? <div><dt>{t("p2pkh.txDetail.conflictSources", { defaultValue: "Conflict source txids" })}</dt><dd>{local.conflictSourceTxids.map((sourceTxid) => <code key={sourceTxid}>{sourceTxid}</code>)}</dd></div> : null}{local.confirmedFactId ? <div><dt>{t("p2pkh.txDetail.confirmedFactId", { defaultValue: "Confirmed fact" })}</dt><dd><code>{local.confirmedFactId}</code></dd></div> : null}{local.resolvedAt ? <div><dt>{t("p2pkh.txDetail.resolvedAt", { defaultValue: "Resolved at" })}</dt><dd>{formatLocalTime(local.resolvedAt)}</dd></div> : null}</> : null}
      </dl>
    </section>
    <div className="p2pkh-tx-detail__columns">
      <section className="p2pkh-tx-detail__card"><header><h2>{inputKeys.length} {t("p2pkh.txDetail.inputs", { defaultValue: "Inputs" })}</h2><span>{t("p2pkh.txDetail.totalInput", { defaultValue: "Total input" })} <strong>{amountLabel(inputTotal)}</strong></span></header><ul>{inputKeys.map((key) => <InputRow key={key} outpointKey={key} value={values[key]} />)}</ul>{inputTotal === undefined ? <p className="p2pkh-tx-detail__muted">{t("p2pkh.txDetail.inputUnavailable", { defaultValue: "Some input values are not stored locally." })}</p> : null}</section>
      <section className="p2pkh-tx-detail__card"><header><h2>{outputRows.length} {t("p2pkh.txDetail.outputs", { defaultValue: "Outputs" })}</h2><span>{t("p2pkh.txDetail.totalOutput", { defaultValue: "Total output" })} <strong>{amountLabel(outputTotal)}</strong></span></header><ul>{outputRows.map((output) => <OutputRow key={output.vout} vout={output.vout} value={output.value} scriptHex={output.scriptHex} owned={ownedKeys.has(`${txid}:${output.vout}`)} />)}</ul>{!parsed ? <p className="p2pkh-tx-detail__muted">{t("p2pkh.txDetail.partialOutputs", { defaultValue: "Only wallet-owned outputs are available in the stored record." })}</p> : null}</section>
    </div>
    {local ? <section className="p2pkh-tx-detail__local"><h2>{t("p2pkh.txDetail.localRecord", { defaultValue: "Local record" })}</h2>{local.parentTxids.length ? <><p>{t("p2pkh.txDetail.parents", { defaultValue: "Parent transactions" })}</p><ul>{local.parentTxids.map((parent) => <li key={parent}><code>{parent}</code></li>)}</ul></> : null}{local.attempts.length ? <><p>{t("p2pkh.txDetail.attempts", { defaultValue: "Broadcast attempts" })}</p><ul>{local.attempts.map((attempt) => <li key={attempt.id}><code>{attempt.id}</code> · {attempt.status}</li>)}</ul></> : null}</section> : null}
  </div>;
}

export function P2pkhTransactionDetailRoute() {
  return <P2pkhTransactionDetailPage />;
}
