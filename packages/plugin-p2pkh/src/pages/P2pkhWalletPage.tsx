import { useEffect, useMemo, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, formatSats, type DataTableColumn } from "@keymaster/ui";
import { router, useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { SESSION_COORDINATOR_CLIENT_CAPABILITY, type P2pkhProviderRegistrySnapshot, type SessionCoordinatorClient } from "@keymaster/contracts";
import type { P2pkhBalanceBreakdown, P2pkhGlobalSettings, P2pkhKeyResource, P2pkhLocalInputClaim, P2pkhLocalOutpoint, P2pkhLocalTransaction, P2pkhMigrationAudit, P2pkhOwnedOutpointProjection, P2pkhService, P2pkhSyncStatus, P2pkhTransactionFact, P2pkhTransactionSyncState } from "../p2pkhContracts.js";

type WalletTab = "transactions" | "coins";
type WalletSnapshot = {
  resources: P2pkhKeyResource[];
  facts: P2pkhTransactionFact[];
  owned: P2pkhOwnedOutpointProjection[];
  locals: P2pkhLocalTransaction[];
  localOutpoints: P2pkhLocalOutpoint[];
  claims: P2pkhLocalInputClaim[];
  migrationAudits: P2pkhMigrationAudit[];
  protectedOutpoints: Array<{ txid: string; vout: number; network: "main" | "test" }>;
  sync: P2pkhTransactionSyncState[];
  syncStatus: P2pkhSyncStatus;
  syncError?: string;
  balances: Record<string, { total: number; breakdown?: P2pkhBalanceBreakdown }>;
  providers: P2pkhProviderRegistrySnapshot | null;
  factCursors: Record<string, string | undefined>;
  ownedCursors: Record<string, string | undefined>;
  localCursors: Record<string, string | undefined>;
  localOutpointCursors: Record<string, string | undefined>;
  claimCursors: Record<string, string | undefined>;
  inputValues: Record<string, number>;
  inputValuesByResource: Record<string, Record<string, number>>;
};

function readTab(): WalletTab {
  const value = new URLSearchParams(window.location.search).get("tab");
  return value === "coins" ? "coins" : "transactions";
}

export function P2pkhWalletPage({ initialTab }: { initialTab?: WalletTab } = {}) {
  const host = usePluginHost();
  const { t } = useI18n();
  const coordinator = useCapability<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY);
  const service = useCapability<P2pkhService>("p2pkh.service");
  const [tab, setTab] = useState<WalletTab>(() => initialTab ?? readTab());
  const [networkFilter, setNetworkFilter] = useState<"all" | "main" | "test">("all");
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null);
  const [rebroadcasting, setRebroadcasting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const settings = useResourceSelector<P2pkhGlobalSettings, P2pkhGlobalSettings>(host.resourceStore, "p2pkh.settings", [], (snapshot) => snapshot.data ?? { includeTestnet: false });
  const wallet = useResourceSelector<WalletSnapshot, WalletSnapshot & { error?: string }>(host.resourceStore, "p2pkh.wallet", [], (snapshot) => snapshot.data ? { ...snapshot.data, migrationAudits: snapshot.data.migrationAudits ?? [], factCursors: snapshot.data.factCursors ?? {}, ownedCursors: snapshot.data.ownedCursors ?? {}, localCursors: snapshot.data.localCursors ?? {}, localOutpointCursors: snapshot.data.localOutpointCursors ?? {}, claimCursors: snapshot.data.claimCursors ?? {}, inputValues: snapshot.data.inputValues ?? {}, inputValuesByResource: snapshot.data.inputValuesByResource ?? {}, error: snapshot.error?.message } : { resources: [], facts: [], owned: [], locals: [], localOutpoints: [], claims: [], migrationAudits: [], protectedOutpoints: [], sync: [], syncStatus: "idle", balances: {}, providers: null, factCursors: {}, ownedCursors: {}, localCursors: {}, localOutpointCursors: {}, claimCursors: {}, inputValues: {}, inputValuesByResource: {}, error: snapshot.error?.message }, (left, right) => JSON.stringify(left) === JSON.stringify(right));
  const [loadedFacts, setLoadedFacts] = useState<P2pkhTransactionFact[]>(wallet.facts);
  const [loadedOwned, setLoadedOwned] = useState<P2pkhOwnedOutpointProjection[]>(wallet.owned);
  const [loadedLocals, setLoadedLocals] = useState<P2pkhLocalTransaction[]>(wallet.locals);
  const [loadedLocalOutpoints, setLoadedLocalOutpoints] = useState<P2pkhLocalOutpoint[]>(wallet.localOutpoints);
  const [loadedClaims, setLoadedClaims] = useState<P2pkhLocalInputClaim[]>(wallet.claims);
  const [loadedInputValues, setLoadedInputValues] = useState<Record<string, number>>(wallet.inputValues);
  const [loadedInputValuesByResource, setLoadedInputValuesByResource] = useState<Record<string, Record<string, number>>>(wallet.inputValuesByResource);
  const [factCursors, setFactCursors] = useState<Record<string, string | undefined>>(wallet.factCursors);
  const [ownedCursors, setOwnedCursors] = useState<Record<string, string | undefined>>(wallet.ownedCursors);
  const [localCursors, setLocalCursors] = useState<Record<string, string | undefined>>(wallet.localCursors);
  const [localOutpointCursors, setLocalOutpointCursors] = useState<Record<string, string | undefined>>(wallet.localOutpointCursors);
  const [claimCursors, setClaimCursors] = useState<Record<string, string | undefined>>(wallet.claimCursors);
  const [loadingMore, setLoadingMore] = useState<"facts" | "owned" | null>(null);
  useEffect(() => {
    setLoadedFacts(wallet.facts);
    setLoadedOwned(wallet.owned);
    setLoadedLocals(wallet.locals);
    setLoadedLocalOutpoints(wallet.localOutpoints);
    setLoadedClaims(wallet.claims);
    setLoadedInputValues(wallet.inputValues);
    setLoadedInputValuesByResource(wallet.inputValuesByResource);
    setFactCursors(wallet.factCursors);
    setOwnedCursors(wallet.ownedCursors);
    setLocalCursors(wallet.localCursors);
    setLocalOutpointCursors(wallet.localOutpointCursors);
    setClaimCursors(wallet.claimCursors);
  }, [wallet.facts, wallet.owned, wallet.locals, wallet.localOutpoints, wallet.claims, wallet.inputValues, wallet.inputValuesByResource, wallet.factCursors, wallet.ownedCursors, wallet.localCursors, wallet.localOutpointCursors, wallet.claimCursors]);
  const setCurrentTab = (next: WalletTab) => {
    setTab(next);
    router.push(next === "transactions" ? "/p2pkh" : `/p2pkh?tab=${next}`);
  };
  const mainBalance = wallet.balances.main?.total ?? 0;
  const testBalance = settings.includeTestnet ? wallet.balances.test?.total ?? 0 : undefined;
  const mainSync = wallet.sync.find((row) => row.resourceId === "p2pkh:main");
  const testSync = wallet.sync.find((row) => row.resourceId === "p2pkh:test");
  const factsByTxid = useMemo(() => new Map(loadedFacts.map((row) => [`${row.resourceId}:${row.txid}`, row])), [loadedFacts]);
  const resourcesById = useMemo(() => new Map(wallet.resources.map((row) => [row.resourceId, row])), [wallet.resources]);
  const txRows = useMemo(() => {
    type TxRow = { id: string; txid: string; network: "main" | "test"; height: number | string; state: string; time: string; direction: "received" | "sent" | "self"; netChange: number; fact?: P2pkhTransactionFact; local?: P2pkhLocalTransaction };
    const valuesByOutpoint = new Map<string, number>();
    for (const [resourceId, values] of Object.entries(loadedInputValuesByResource)) for (const [key, value] of Object.entries(values)) valuesByOutpoint.set(`${resourceId}:${key}`, value);
    for (const row of loadedOwned) valuesByOutpoint.set(`${row.resourceId}:${row.outpointKey}`, row.value);
    for (const row of loadedLocalOutpoints) valuesByOutpoint.set(`${row.resourceId}:${row.txid}:${row.vout}`, row.value);
    const summarize = (resourceId: string, inputs: string[], received: number) => {
      const spent = inputs.reduce((sum, key) => sum + (valuesByOutpoint.get(`${resourceId}:${key}`) ?? 0), 0);
      const netChange = received - spent;
      return { netChange, direction: netChange > 0 ? "received" as const : netChange < 0 ? "sent" as const : "self" as const };
    };
    const byTxid = new Map<string, TxRow>();
    for (const row of loadedFacts) {
      const summary = summarize(row.resourceId, row.inputOutpointKeys, row.ownedOutputs.reduce((sum, output) => sum + output.value, 0));
      byTxid.set(`${row.resourceId}:${row.txid}`, { id: row.id, txid: row.txid, network: row.network, height: row.blockHeight ?? "-", state: "chain-confirmed", time: row.blockTime === undefined ? row.lastConfirmedAt : new Date(row.blockTime * 1000).toISOString(), ...summary, fact: row });
    }
    for (const row of loadedLocals) {
      const existing = byTxid.get(`${row.resourceId}:${row.txid}`);
      const summary = summarize(row.resourceId, row.inputOutpointKeys, row.ownOutputs.reduce((sum, output) => sum + output.value, 0));
      byTxid.set(`${row.resourceId}:${row.txid}`, existing ? { ...existing, id: row.id, state: row.state, ...summary, local: row } : { id: row.id, txid: row.txid, network: row.network, height: "-", state: row.state, time: row.updatedAt, ...summary, local: row });
    }
    return [...byTxid.values()];
  }, [loadedFacts, loadedLocals, loadedOwned, loadedLocalOutpoints, loadedInputValues, loadedInputValuesByResource]);
  const visibleTxRows = useMemo(() => networkFilter === "all" ? txRows : txRows.filter((row) => row.network === networkFilter), [networkFilter, txRows]);
  const coinRows = useMemo(() => {
    const claimsByOutpoint = new Map(loadedClaims.map((claim) => [`${claim.resourceId}:${claim.outpointKey ?? `${claim.txid}:${claim.vout}`}`, claim]));
    const protectedKeys = new Set(wallet.protectedOutpoints.map((row) => `${row.network}:${row.txid}:${row.vout}`));
    return [
      ...loadedOwned.map((row) => { const key = `${row.resourceId}:${row.outpointKey}`; const claim = claimsByOutpoint.get(key); const protectedKey = `${row.network}:${row.outpointKey}`; return { id: row.id, outpoint: row.outpointKey, network: row.network, value: row.value, state: protectedKeys.has(protectedKey) ? "protected" : claim?.state === "isolated" ? "isolated" : claim?.state === "active" ? "claimed" : row.chainState, source: "confirmed", submissionId: undefined, spentBy: row.spentByTxid }; }),
      ...loadedLocalOutpoints.map((row) => { const resource = resourcesById.get(row.resourceId); const network = resource?.network ?? factsByTxid.get(`${row.resourceId}:${row.txid}`)?.network ?? "main"; const key = `${row.txid}:${row.vout}`; const protectedKey = `${network}:${key}`; const pendingSpender = loadedLocals.find((candidate) => candidate.resourceId === row.resourceId && candidate.txid !== row.txid && candidate.state !== "chain-confirmed" && candidate.inputOutpointKeys.includes(key)); return { id: row.id, outpoint: key, network, value: row.value, state: protectedKeys.has(protectedKey) ? "protected" : row.state, source: "local-confirmed", submissionId: row.submissionId, spentBy: pendingSpender?.txid }; })
    ];
  }, [loadedOwned, loadedLocalOutpoints, loadedClaims, wallet.protectedOutpoints, factsByTxid, resourcesById, loadedLocals]);
  const coinColumns: DataTableColumn<(typeof coinRows)[number]>[] = [
    { key: "outpoint", header: t("p2pkh.col.txidVout", { defaultValue: "txid:vout" }), render: (row) => <code>{row.outpoint}</code> },
    { key: "value", header: t("p2pkh.col.value", { defaultValue: "金额" }), render: (row) => formatSats(row.value) },
    { key: "network", header: t("p2pkh.col.network", { defaultValue: "网络" }), render: (row) => t(`p2pkh.network.${row.network}`, { defaultValue: row.network }) },
    { key: "state", header: t("p2pkh.col.status", { defaultValue: "状态" }), render: (row) => t(`p2pkh.state.${row.state}`, { defaultValue: row.state }) },
    { key: "source", header: t("p2pkh.col.source", { defaultValue: "来源" }), render: (row) => t(`p2pkh.source.${row.source}`, { defaultValue: row.source }) },
    { key: "submissionId", header: t("p2pkh.col.submission", { defaultValue: "Local submission" }), render: (row) => row.submissionId ? <code>{row.submissionId}</code> : t("p2pkh.wallet.none", { defaultValue: "None" }) },
    { key: "spentBy", header: t("p2pkh.col.spentBy", { defaultValue: "Spent by" }), render: (row) => row.spentBy ? <code>{row.spentBy}</code> : t("p2pkh.wallet.none", { defaultValue: "None" }) }
  ];
  async function rebroadcast(local: P2pkhLocalTransaction) {
    const selection = wallet.providers?.selection[local.network];
    const ownerPublicKeyHex = wallet.resources.find((resource) => resource.resourceId === local.resourceId)?.publicKeyHex;
    if (!selection?.broadcastProviderId || !ownerPublicKeyHex) { setActionError(t("p2pkh.wallet.noBroadcastProvider", { defaultValue: "No broadcast provider is configured for this network." })); return; }
    setActionError(null);
    setRebroadcasting(local.id);
    try {
      const result = await coordinator.p2pkhRebroadcastAncestors({ ownerPublicKeyHex, network: local.network, submissionId: local.id, expectedProviderGeneration: wallet.providers!.selection.generation });
      if (result.status !== "ok") setActionError("message" in result ? result.message : t("p2pkh.action.rebroadcastFailed", { defaultValue: "Rebroadcast failed" }));
      else if (["isolated", "rebroadcast-failed", "not-dispatched"].includes((result.value as { status?: string }).status ?? "")) setActionError((result.value as { reason?: string }).reason ?? t("p2pkh.action.rebroadcastFailed", { defaultValue: "Rebroadcast failed; the submission was retained for retry" }));
    } finally { setRebroadcasting(null); }
  }
  async function loadMoreFacts() {
    if (loadingMore) return;
    setLoadingMore("facts");
    try {
      const facts = service.listTransactionFactsPage ? await Promise.all(wallet.resources.map(async (resource) => {
        if (!factCursors[resource.resourceId]) return [resource.resourceId, { items: [] as P2pkhTransactionFact[], nextCursor: undefined }] as const;
        return [resource.resourceId, await service.listTransactionFactsPage!({ resourceId: resource.resourceId, cursor: factCursors[resource.resourceId], limit: 200 })] as const;
      })) : [];
      const locals = service.listLocalTransactionsPage ? await Promise.all(wallet.resources.map(async (resource) => {
        if (!localCursors[resource.resourceId]) return [resource.resourceId, { items: [] as P2pkhLocalTransaction[], nextCursor: undefined }] as const;
        return [resource.resourceId, await service.listLocalTransactionsPage!({ resourceId: resource.resourceId, cursor: localCursors[resource.resourceId], limit: 500 })] as const;
      })) : [];
      const factAdditions = facts.flatMap(([, page]) => page.items);
      const localAdditions = locals.flatMap(([, page]) => page.items);
      setLoadedFacts((current) => [...new Map([...current, ...factAdditions].map((row) => [row.id, row])).values()]);
      setLoadedLocals((current) => [...new Map([...current, ...localAdditions].map((row) => [row.id, row])).values()]);
      const inputValuesByResource: Record<string, Record<string, number>> = {};
      if (service.listOwnedOutpointValues) for (const [resourceId, page] of [...facts, ...locals]) Object.assign(inputValuesByResource[resourceId] ??= {}, await service.listOwnedOutpointValues(resourceId, page.items.flatMap((row) => row.inputOutpointKeys)));
      const inputValues = Object.assign({}, ...Object.values(inputValuesByResource));
      setLoadedInputValues((current) => ({ ...current, ...inputValues }));
      setLoadedInputValuesByResource((current) => {
        const next = { ...current };
        for (const [resourceId, values] of Object.entries(inputValuesByResource)) next[resourceId] = { ...(current[resourceId] ?? {}), ...values };
        return next;
      });
      setFactCursors((current) => ({ ...current, ...Object.fromEntries(facts.map(([resourceId, page]) => [resourceId, page.nextCursor])) }));
      setLocalCursors((current) => ({ ...current, ...Object.fromEntries(locals.map(([resourceId, page]) => [resourceId, page.nextCursor])) }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("p2pkh.action.loadMoreFailed", { defaultValue: "Unable to load more wallet history." }));
    } finally { setLoadingMore(null); }
  }
  async function loadMoreOwned() {
    if (loadingMore) return;
    setLoadingMore("owned");
    try {
      const owned = service.listOwnedOutpointsPage ? await Promise.all(wallet.resources.map(async (resource) => {
        if (!ownedCursors[resource.resourceId]) return [resource.resourceId, { items: [] as P2pkhOwnedOutpointProjection[], nextCursor: undefined }] as const;
        return [resource.resourceId, await service.listOwnedOutpointsPage!({ resourceId: resource.resourceId, cursor: ownedCursors[resource.resourceId], limit: 500 })] as const;
      })) : [];
      const localOutpoints = service.listLocalOutpointsPage ? await Promise.all(wallet.resources.map(async (resource) => {
        if (!localOutpointCursors[resource.resourceId]) return [resource.resourceId, { items: [] as P2pkhLocalOutpoint[], nextCursor: undefined }] as const;
        return [resource.resourceId, await service.listLocalOutpointsPage!({ resourceId: resource.resourceId, cursor: localOutpointCursors[resource.resourceId], limit: 500 })] as const;
      })) : [];
      const claims = service.listLocalInputClaimsPage ? await Promise.all(wallet.resources.map(async (resource) => {
        if (!claimCursors[resource.resourceId]) return [resource.resourceId, { items: [] as P2pkhLocalInputClaim[], nextCursor: undefined }] as const;
        return [resource.resourceId, await service.listLocalInputClaimsPage!({ resourceId: resource.resourceId, cursor: claimCursors[resource.resourceId], limit: 500 })] as const;
      })) : [];
      setLoadedOwned((current) => [...new Map([...current, ...owned.flatMap(([, page]) => page.items)].map((row) => [row.id, row])).values()]);
      setLoadedLocalOutpoints((current) => [...new Map([...current, ...localOutpoints.flatMap(([, page]) => page.items)].map((row) => [row.id, row])).values()]);
      setLoadedClaims((current) => [...new Map([...current, ...claims.flatMap(([, page]) => page.items)].map((row) => [row.id, row])).values()]);
      setOwnedCursors((current) => ({ ...current, ...Object.fromEntries(owned.map(([resourceId, page]) => [resourceId, page.nextCursor])) }));
      setLocalOutpointCursors((current) => ({ ...current, ...Object.fromEntries(localOutpoints.map(([resourceId, page]) => [resourceId, page.nextCursor])) }));
      setClaimCursors((current) => ({ ...current, ...Object.fromEntries(claims.map(([resourceId, page]) => [resourceId, page.nextCursor])) }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("p2pkh.action.loadMoreFailed", { defaultValue: "Unable to load more wallet history." }));
    } finally { setLoadingMore(null); }
  }
  const hasMoreFacts = Object.values(factCursors).some(Boolean) || Object.values(localCursors).some(Boolean);
  const hasMoreOwned = Object.values(ownedCursors).some(Boolean) || Object.values(localOutpointCursors).some(Boolean) || Object.values(claimCursors).some(Boolean);
  const txColumns: DataTableColumn<(typeof txRows)[number]>[] = [
    { key: "txid", header: t("p2pkh.col.txid", { defaultValue: "txid" }), render: (row) => <code>{row.txid}</code> },
    { key: "network", header: t("p2pkh.col.network", { defaultValue: "网络" }), render: (row) => t(`p2pkh.network.${row.network}`, { defaultValue: row.network }) },
    { key: "height", header: t("p2pkh.col.height", { defaultValue: "区块高度" }), render: (row) => row.height },
    { key: "state", header: t("p2pkh.col.status", { defaultValue: "状态" }), render: (row) => t(`p2pkh.state.${row.state}`, { defaultValue: row.state }) },
    { key: "direction", header: t("p2pkh.col.direction", { defaultValue: "Direction" }), render: (row) => t(`p2pkh.direction.${row.direction}`, { defaultValue: row.direction }) },
    { key: "netChange", header: t("p2pkh.col.netChange", { defaultValue: "Net change" }), render: (row) => `${row.netChange >= 0 ? "+" : ""}${formatSats(row.netChange)}` },
    { key: "time", header: t("p2pkh.col.syncedAt", { defaultValue: "最近观察" }), render: (row) => row.time },
    { key: "action", header: "", render: (row) => <span><Button variant="ghost" onClick={() => setExpandedTxId(expandedTxId === row.id ? null : row.id)}>{expandedTxId === row.id ? t("p2pkh.action.hideDetails", { defaultValue: "Hide details" }) : t("p2pkh.action.details", { defaultValue: "Details" })}</Button>{row.local && (row.local.state === "submitting" || row.local.state === "isolated" || row.local.state === "conflicted") ? <Button variant="ghost" disabled={rebroadcasting === row.local.id} onClick={() => void rebroadcast(row.local!)}>{rebroadcasting === row.local.id ? t("p2pkh.action.inProgress", { defaultValue: "Working…" }) : t("p2pkh.action.rebroadcast", { defaultValue: "Rebroadcast ancestors" })}</Button> : null}</span> }
  ];
  const expanded = visibleTxRows.find((row) => row.id === expandedTxId);
  return (
    <div className="p2pkh-wallet">
      <PageHeader
        title={t("p2pkh.wallet.title", { defaultValue: "BSV Wallet" })}
        description={t("p2pkh.wallet.description", { defaultValue: "Confirmed transaction facts, local overlay state, and spendable coins." })}
        actions={<Button variant="ghost" onClick={() => router.push("/p2pkh/settings")}>{t("p2pkh.wallet.settings", { defaultValue: "Provider settings" })}</Button>}
      />
      <nav aria-label={t("p2pkh.wallet.tabs", { defaultValue: "P2PKH wallet tabs" })}>
        {(["transactions", "coins"] as const).map((value) => <Button key={value} variant={tab === value ? "primary" : "ghost"} onClick={() => setCurrentTab(value)}>{t(`p2pkh.wallet.tab.${value}`, { defaultValue: value === "transactions" ? "Transactions" : "Coins" })}</Button>)}
      </nav>
      {wallet.error ? <EmptyState title={t("p2pkh.wallet.loadFailed", { defaultValue: "Wallet data unavailable" })} description={wallet.error} /> : null}
      {wallet.migrationAudits.length ? <p role="alert">{t("p2pkh.wallet.migrationAudit", { defaultValue: "Some legacy local submissions need review ({{count}}).", count: wallet.migrationAudits.length })}</p> : null}
      <section className="p2pkh-wallet__balances" aria-label={t("p2pkh.wallet.balances", { defaultValue: "BSV balances" })}>
        <article><h2>{t("p2pkh.asset.bsvMain", { defaultValue: "BSV / main" })}</h2><strong>{formatSats(mainBalance)}</strong><BalanceBreakdown breakdown={wallet.balances.main?.breakdown} /></article>
        {testBalance !== undefined ? <article><h2>{t("p2pkh.asset.bsvTest", { defaultValue: "BSV / test" })}</h2><strong>{formatSats(testBalance)}</strong><BalanceBreakdown breakdown={wallet.balances.test?.breakdown} /></article> : null}
      </section>
      <section className="p2pkh-wallet__sync" aria-label={t("p2pkh.wallet.syncStatus", { defaultValue: "Confirmed synchronization status" })}>
        {wallet.providers ? <p>{t("p2pkh.wallet.providers", { defaultValue: "main — Confirmed: {{mainSync}} / Broadcast: {{mainBroadcast}} · test — Confirmed: {{testSync}} / Broadcast: {{testBroadcast}}", mainSync: wallet.providers.selection.main.syncProviderId ?? "—", mainBroadcast: wallet.providers.selection.main.broadcastProviderId ?? "—", testSync: wallet.providers.selection.test.syncProviderId ?? "—", testBroadcast: wallet.providers.selection.test.broadcastProviderId ?? "—" })}</p> : null}
        <p>{t("p2pkh.wallet.lastCompleteSync", { defaultValue: "Last complete sync: {{main}}", main: mainSync?.lastSuccessAt ?? "—" })}{testSync && settings.includeTestnet ? ` / ${t("p2pkh.wallet.testSync", { defaultValue: "test {{time}}", time: testSync.lastSuccessAt ?? "—" })}` : ""}</p>
        <p>{t("p2pkh.wallet.taskStatus", { defaultValue: "Task status: {{status}}", status: t(`p2pkh.syncStatus.${wallet.syncStatus}`, { defaultValue: wallet.syncStatus }) })}</p>
        {(wallet.syncError ?? mainSync?.lastError) ? <p role="alert">{t("p2pkh.wallet.syncError", { defaultValue: "Sync error: {{error}}", error: wallet.syncError ?? mainSync?.lastError })}</p> : null}
        {actionError ? <p role="alert">{actionError}</p> : null}
      </section>
      <label className="p2pkh-wallet__network-filter">{t("p2pkh.wallet.network", { defaultValue: "Network" })} <select aria-label={t("p2pkh.wallet.network", { defaultValue: "Network" })} value={networkFilter} onChange={(event) => setNetworkFilter(event.currentTarget.value as "all" | "main" | "test")}><option value="all">{t("p2pkh.asset.all", { defaultValue: "All" })}</option><option value="main">{t("p2pkh.wallet.mainnet", { defaultValue: "Mainnet" })}</option><option value="test">{t("p2pkh.wallet.testnet", { defaultValue: "Testnet" })}</option></select></label>
      {tab === "transactions" ? <><DataTable columns={txColumns} rows={visibleTxRows} rowKey={(row) => row.id} />{hasMoreFacts ? <Button variant="ghost" disabled={loadingMore !== null} onClick={() => void loadMoreFacts()}>{loadingMore === "facts" ? t("p2pkh.action.loadingMore", { defaultValue: "Loading…" }) : t("p2pkh.action.loadMoreTransactions", { defaultValue: "Load more transactions" })}</Button> : null}{expanded ? <TransactionDetails row={expanded} /> : null}</> : <><DataTable columns={coinColumns} rows={coinRows.filter((row) => networkFilter === "all" || row.network === networkFilter)} rowKey={(row) => row.id} />{hasMoreOwned ? <Button variant="ghost" disabled={loadingMore !== null} onClick={() => void loadMoreOwned()}>{loadingMore === "owned" ? t("p2pkh.action.loadingMore", { defaultValue: "Loading…" }) : t("p2pkh.action.loadMoreCoins", { defaultValue: "Load more coins" })}</Button> : null}</>}
    </div>
  );
}

function TransactionDetails({ row }: { row: { txid: string; fact?: P2pkhTransactionFact; local?: P2pkhLocalTransaction } }) {
  const { t } = useI18n();
  const inputs = row.fact?.inputs.map((input) => input.outpointKey) ?? row.local?.inputOutpointKeys ?? [];
  const outputs = row.fact?.ownedOutputs ?? row.local?.ownOutputs ?? [];
  const attempts = row.local?.attempts ?? [];
  return <section className="p2pkh-wallet__transaction-details"><h3>{t("p2pkh.wallet.transaction", { defaultValue: "Transaction {{txid}}", txid: row.txid })}</h3>{row.local?.parentTxids.length ? <><h4>{t("p2pkh.wallet.parents", { defaultValue: "Parents" })}</h4><ul>{row.local.parentTxids.map((parent) => <li key={parent}><code>{parent}</code></li>)}</ul></> : null}<h4>{t("p2pkh.wallet.inputs", { defaultValue: "Inputs" })}</h4><ul>{inputs.map((input) => <li key={input}><code>{input}</code></li>)}</ul><h4>{t("p2pkh.wallet.outputs", { defaultValue: "Outputs" })}</h4><ul>{outputs.map((output) => <li key={`${output.vout}:${output.value}`}><code>{output.vout}</code> · {formatSats(output.value)}</li>)}</ul><h4>{t("p2pkh.wallet.attempts", { defaultValue: "Broadcast attempts" })}</h4>{attempts.length ? <pre>{JSON.stringify(attempts, null, 2)}</pre> : <p>{t("p2pkh.wallet.none", { defaultValue: "None" })}</p>}</section>;
}

function BalanceBreakdown({ breakdown }: { breakdown?: P2pkhBalanceBreakdown }) {
  const { t } = useI18n();
  if (!breakdown) return null;
  return <dl className="p2pkh-wallet__balance-breakdown">
    <dt>{t("p2pkh.balance.blockConfirmed", { defaultValue: "Block confirmed" })}</dt><dd>{formatSats(breakdown.blockConfirmed)}</dd>
    <dt>{t("p2pkh.balance.localSpendable", { defaultValue: "Local spendable" })}</dt><dd>{formatSats(breakdown.localSpendable)}</dd>
    <dt>{t("p2pkh.balance.pendingClaims", { defaultValue: "Pending input claims" })}</dt><dd>{formatSats(breakdown.pendingInputClaims)}</dd>
    <dt>{t("p2pkh.balance.localChange", { defaultValue: "Local confirmed change" })}</dt><dd>{formatSats(breakdown.localConfirmedChange)}</dd>
    <dt>{t("p2pkh.balance.isolated", { defaultValue: "Isolated" })}</dt><dd>{formatSats(breakdown.isolated)}</dd>
  </dl>;
}
