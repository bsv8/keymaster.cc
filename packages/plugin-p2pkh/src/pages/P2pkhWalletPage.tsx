import { useEffect, useMemo, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, formatSats, type DataTableColumn } from "@keymaster/ui";
import { router, useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { P2PKH_COORDINATOR_CONTROL_CAPABILITY, type P2pkhCoordinatorControl, type P2pkhProviderRegistrySnapshot } from "@keymaster/contracts";
import type { P2pkhBalanceBreakdown, P2pkhGlobalSettings, P2pkhKeyResource, P2pkhLocalInputClaim, P2pkhLocalOutpoint, P2pkhLocalTransaction, P2pkhOwnedOutpointProjection, P2pkhService, P2pkhSyncStatus, P2pkhTransactionFact, P2pkhTransactionSyncState } from "../p2pkhContracts.js";
import { balanceAtBlock, detailPath, inputAmount, listPath, parseStoredTransaction, readPage, type P2pkhNetwork, type P2pkhWalletView } from "./p2pkhTransactionView.js";

export const TRANSACTION_PAGE_SIZE = 20;

export type WalletSnapshot = {
  resources: P2pkhKeyResource[];
  facts: P2pkhTransactionFact[];
  owned: P2pkhOwnedOutpointProjection[];
  locals: P2pkhLocalTransaction[];
  localOutpoints: P2pkhLocalOutpoint[];
  claims: P2pkhLocalInputClaim[];
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

export interface P2pkhTransactionListRow {
  id: string;
  txid: string;
  network: P2pkhNetwork;
  height: number | string;
  state: string;
  time: string;
  direction: "received" | "sent" | "self";
  netChange: number;
  inputAmount?: number;
  outputAmount?: number;
  balanceAtBlock?: number;
  fact?: P2pkhTransactionFact;
  local?: P2pkhLocalTransaction;
}

function amountLabel(value: number | undefined): string {
  return value === undefined ? "—" : formatSats(value);
}

export function P2pkhWalletPage({ view = "transactions", network = "main" }: { view?: P2pkhWalletView; network?: P2pkhNetwork } = {}) {
  const host = usePluginHost();
  const { t } = useI18n();
  const coordinator = useCapability<P2pkhCoordinatorControl>(P2PKH_COORDINATOR_CONTROL_CAPABILITY);
  const service = useCapability<P2pkhService>("p2pkh.service");
  const [page, setPage] = useState(() => readPage());
  const [rebroadcasting, setRebroadcasting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const wallet = useResourceSelector<WalletSnapshot, WalletSnapshot & { error?: string }>(host.resourceStore, "p2pkh.wallet", [], (snapshot) => snapshot.data ? { ...snapshot.data, factCursors: snapshot.data.factCursors ?? {}, ownedCursors: snapshot.data.ownedCursors ?? {}, localCursors: snapshot.data.localCursors ?? {}, localOutpointCursors: snapshot.data.localOutpointCursors ?? {}, claimCursors: snapshot.data.claimCursors ?? {}, inputValues: snapshot.data.inputValues ?? {}, inputValuesByResource: snapshot.data.inputValuesByResource ?? {}, error: snapshot.error?.message } : { resources: [], facts: [], owned: [], locals: [], localOutpoints: [], claims: [], protectedOutpoints: [], sync: [], syncStatus: "idle", balances: {}, providers: null, factCursors: {}, ownedCursors: {}, localCursors: {}, localOutpointCursors: {}, claimCursors: {}, inputValues: {}, inputValuesByResource: {}, error: snapshot.error?.message }, (left, right) => JSON.stringify(left) === JSON.stringify(right));
  const [loadedFacts, setLoadedFacts] = useState<P2pkhTransactionFact[]>(wallet.facts);
  const [loadedOwned, setLoadedOwned] = useState<P2pkhOwnedOutpointProjection[]>(wallet.owned);
  const [loadedLocals, setLoadedLocals] = useState<P2pkhLocalTransaction[]>(wallet.locals);
  const [loadedLocalOutpoints, setLoadedLocalOutpoints] = useState<P2pkhLocalOutpoint[]>(wallet.localOutpoints);
  const [loadedClaims, setLoadedClaims] = useState<P2pkhLocalInputClaim[]>(wallet.claims);
  const [loadedInputValuesByResource, setLoadedInputValuesByResource] = useState<Record<string, Record<string, number>>>(wallet.inputValuesByResource);
  const [factCursors, setFactCursors] = useState<Record<string, string | undefined>>(wallet.factCursors);
  const [ownedCursors, setOwnedCursors] = useState<Record<string, string | undefined>>(wallet.ownedCursors);
  const [localCursors, setLocalCursors] = useState<Record<string, string | undefined>>(wallet.localCursors);
  const [localOutpointCursors, setLocalOutpointCursors] = useState<Record<string, string | undefined>>(wallet.localOutpointCursors);
  const [claimCursors, setClaimCursors] = useState<Record<string, string | undefined>>(wallet.claimCursors);
  const [loadingMore, setLoadingMore] = useState<"facts" | "locals" | "owned" | null>(null);
  const [factsLoadFailed, setFactsLoadFailed] = useState(false);
  const [localLoadFailed, setLocalLoadFailed] = useState(false);
  const [ownedLoadFailed, setOwnedLoadFailed] = useState(false);

  const settings = useResourceSelector<P2pkhGlobalSettings, P2pkhGlobalSettings>(
    host.resourceStore,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data ?? { includeTestnet: false },
    (left, right) => left.includeTestnet === right.includeTestnet
  );

  useEffect(() => {
    setLoadedFacts(wallet.facts);
    setLoadedOwned(wallet.owned);
    setLoadedLocals(wallet.locals);
    setLoadedLocalOutpoints(wallet.localOutpoints);
    setLoadedClaims(wallet.claims);
    setLoadedInputValuesByResource(wallet.inputValuesByResource);
    setFactCursors(wallet.factCursors);
    setOwnedCursors(wallet.ownedCursors);
    setLocalCursors(wallet.localCursors);
    setLocalOutpointCursors(wallet.localOutpointCursors);
    setClaimCursors(wallet.claimCursors);
    setFactsLoadFailed(false);
    setLocalLoadFailed(false);
    setOwnedLoadFailed(false);
  }, [wallet.facts, wallet.owned, wallet.locals, wallet.localOutpoints, wallet.claims, wallet.inputValuesByResource, wallet.factCursors, wallet.ownedCursors, wallet.localCursors, wallet.localOutpointCursors, wallet.claimCursors]);

  const setCurrentPage = (next: number) => {
    if (next < 1) return;
    setPage(next);
    router.push(listPath(network, next, view));
  };
  const networkEnabled = network === "main" || settings.includeTestnet;
  const networkBalance = networkEnabled ? wallet.balances[network]?.total : undefined;
  const sync = wallet.sync.find((row) => row.resourceId === `p2pkh:${network}`);
  const selectedResources = useMemo(() => networkEnabled ? wallet.resources.filter((resource) => resource.network === network) : [], [wallet.resources, network, networkEnabled]);

  const txRows = useMemo<P2pkhTransactionListRow[]>(() => {
    if (!networkEnabled) return [];
    const valuesByOutpoint = new Map<string, number>();
    for (const [resourceId, values] of Object.entries(loadedInputValuesByResource)) {
      for (const [key, value] of Object.entries(values)) valuesByOutpoint.set(`${resourceId}:${key}`, value);
    }
    for (const row of loadedOwned) valuesByOutpoint.set(`${row.resourceId}:${row.outpointKey}`, row.value);
    const inputValuesForRows: Record<string, Record<string, number>> = Object.fromEntries(
      Object.entries(loadedInputValuesByResource).map(([resourceId, values]) => [resourceId, { ...values }])
    );
    const completeOwned = selectedResources.every((resource) => !ownedCursors[resource.resourceId]);
    const summarize = (resourceId: string, inputs: string[], received: number) => {
      const spent = inputs.reduce((sum, key) => sum + (valuesByOutpoint.get(`${resourceId}:${key}`) ?? 0), 0);
      const netChange = received - spent;
      return { netChange, direction: netChange > 0 ? "received" as const : netChange < 0 ? "sent" as const : "self" as const };
    };
    const byTxid = new Map<string, P2pkhTransactionListRow>();
    for (const row of loadedFacts) {
      if (row.network !== network) continue;
      const parsed = parseStoredTransaction(row.rawTxHex, row.txid);
      const received = row.ownedOutputs.reduce((sum, output) => sum + output.value, 0);
      const summary = summarize(row.resourceId, row.inputOutpointKeys, received);
      const input = inputAmount(row.resourceId, row.inputOutpointKeys, inputValuesForRows);
      byTxid.set(`${row.resourceId}:${row.txid}`, {
        id: row.id,
        txid: row.txid,
        network: row.network,
        height: row.blockHeight ?? "-",
        state: "chain-confirmed",
        time: row.blockTime === undefined ? row.lastConfirmedAt : new Date(row.blockTime * 1000).toISOString(),
        inputAmount: input.value,
        outputAmount: parsed ? parsed.outputs.reduce((sum, output) => sum + output.value, 0) : undefined,
        balanceAtBlock: balanceAtBlock(network, row.blockHeight, loadedOwned, completeOwned),
        ...summary,
        fact: row
      });
    }
    return [...byTxid.values()].sort((left, right) => {
      const leftTime = Date.parse(left.time);
      const rightTime = Date.parse(right.time);
      if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
      if (Number.isNaN(leftTime)) return 1;
      if (Number.isNaN(rightTime)) return -1;
      return rightTime - leftTime || right.id.localeCompare(left.id);
    });
  }, [loadedFacts, loadedOwned, loadedInputValuesByResource, selectedResources, ownedCursors, network, networkEnabled]);

  const visibleTxRows = useMemo(() => txRows.slice((page - 1) * TRANSACTION_PAGE_SIZE, page * TRANSACTION_PAGE_SIZE), [txRows, page]);
  const localTxRows = useMemo<P2pkhTransactionListRow[]>(() => loadedLocals.filter((row) => networkEnabled && row.network === network && row.chainResolution !== "chain-confirmed").map((row) => {
    const parsed = parseStoredTransaction(row.rawTxHex, row.txid);
    const received = row.ownOutputs.reduce((sum, output) => sum + output.value, 0);
    // Local outpoint projections may be stale; chain-sourced values (fetched
    // input values, then owned projections) must win the same way they do on
    // the chain transactions view.
    const localValues: Record<string, number> = {};
    for (const output of loadedLocalOutpoints) if (output.resourceId === row.resourceId) localValues[`${output.txid}:${output.vout}`] = output.value;
    for (const candidate of loadedLocals) if (candidate.resourceId === row.resourceId) for (const output of candidate.ownOutputs) localValues[`${candidate.txid}:${output.vout}`] = output.value;
    for (const [key, value] of Object.entries(loadedInputValuesByResource[row.resourceId] ?? {})) localValues[key] = value;
    for (const projection of loadedOwned) if (projection.resourceId === row.resourceId) localValues[projection.outpointKey] = projection.value;
    const values: Record<string, Record<string, number>> = { [row.resourceId]: localValues };
    const input = inputAmount(row.resourceId, row.inputOutpointKeys, values);
    const spent = row.inputOutpointKeys.reduce((sum, key) => sum + (values[row.resourceId]?.[key] ?? 0), 0);
    return { id: row.id, txid: row.txid, network: row.network, height: "-", state: row.chainResolution === "conflicted" ? "conflicted" : row.localState, time: row.updatedAt, inputAmount: input.value, outputAmount: parsed ? parsed.outputs.reduce((sum, output) => sum + output.value, 0) : undefined, direction: received - spent > 0 ? "received" : received - spent < 0 ? "sent" : "self", netChange: received - spent, local: row };
  }), [loadedLocals, loadedInputValuesByResource, loadedLocalOutpoints, loadedOwned, network, networkEnabled]);
  const visibleLocalTxRows = useMemo(() => localTxRows.slice((page - 1) * TRANSACTION_PAGE_SIZE, page * TRANSACTION_PAGE_SIZE), [localTxRows, page]);

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

  async function loadMoreFacts(): Promise<boolean> {
    if (loadingMore) return false;
    setLoadingMore("facts");
    try {
      const resources = selectedResources;
      if (resources.some((resource) => factCursors[resource.resourceId]) && !service.listTransactionFactsPage) throw new Error(t("p2pkh.action.loadMoreUnsupported", { defaultValue: "Local transaction pagination is unavailable." }));
      const facts = service.listTransactionFactsPage ? await Promise.all(resources.map(async (resource) => {
        if (!factCursors[resource.resourceId]) return [resource.resourceId, { items: [] as P2pkhTransactionFact[], nextCursor: undefined }] as const;
        return [resource.resourceId, await service.listTransactionFactsPage!({ resourceId: resource.resourceId, cursor: factCursors[resource.resourceId], limit: 200 })] as const;
      })) : [];
      const factAdditions = facts.flatMap(([, result]) => result.items);
      const loadedAnything = factAdditions.length > 0;
      setLoadedFacts((current) => [...new Map([...current, ...factAdditions].map((row) => [row.id, row])).values()]);
      const inputValuesByResource: Record<string, Record<string, number>> = {};
      if (service.listOwnedOutpointValues) for (const [resourceId, result] of facts) Object.assign(inputValuesByResource[resourceId] ??= {}, await service.listOwnedOutpointValues(resourceId, result.items.flatMap((row) => row.inputOutpointKeys)));
      setLoadedInputValuesByResource((current) => {
        const next = { ...current };
        for (const [resourceId, values] of Object.entries(inputValuesByResource)) next[resourceId] = { ...(current[resourceId] ?? {}), ...values };
        return next;
      });
      setFactCursors((current) => ({ ...current, ...Object.fromEntries(facts.map(([resourceId, result]) => [resourceId, result.nextCursor])) }));
      const cursorRemains = facts.some(([, result]) => result.nextCursor);
      setFactsLoadFailed(!loadedAnything && cursorRemains);
      return loadedAnything;
    } catch (error) {
      setFactsLoadFailed(true);
      setActionError(error instanceof Error ? error.message : t("p2pkh.action.loadMoreFailed", { defaultValue: "Unable to load more wallet history." }));
      return false;
    } finally { setLoadingMore(null); }
  }

  async function loadMoreLocals(): Promise<boolean> {
    if (loadingMore) return false;
    setLoadingMore("locals");
    try {
      const resources = selectedResources;
      if (resources.some((resource) => localCursors[resource.resourceId]) && !service.listLocalTransactionsPage) throw new Error(t("p2pkh.action.loadMoreUnsupported", { defaultValue: "Local transaction pagination is unavailable." }));
      // Keep reading until the target page can be filled with visible (not yet
      // promoted) records; stopping at the first visible record would let the
      // next page start past the loaded window and render empty.
      const neededVisible = (page + 1) * TRANSACTION_PAGE_SIZE - loadedLocals.filter((row) => row.network === network && row.chainResolution !== "chain-confirmed").length;
      const collectedVisible = { count: 0 };
      const locals = service.listLocalTransactionsPage ? await Promise.all(resources.map(async (resource) => {
        let cursor = localCursors[resource.resourceId];
        const visible: P2pkhLocalTransaction[] = [];
        let nextCursor: string | undefined;
        // A service page can contain only promoted audit rows. Continue from
        // its cursor in the same user action, with a hard bound against a
        // malformed provider cursor causing an infinite loop.
        for (let attempt = 0; attempt < 100 && cursor && collectedVisible.count < neededVisible; attempt += 1) {
          const result = await service.listLocalTransactionsPage!({ resourceId: resource.resourceId, cursor, limit: 100 });
          visible.push(...result.items);
          nextCursor = result.nextCursor;
          collectedVisible.count += result.items.filter((row) => row.chainResolution !== "chain-confirmed").length;
          if (!nextCursor || nextCursor === cursor) break;
          cursor = nextCursor;
        }
        return [resource.resourceId, { items: visible, nextCursor }] as const;
      })) : [];
      const localAdditions = locals.flatMap(([, result]) => result.items);
      const mergedRows = [...new Map([...loadedLocals, ...localAdditions].map((row) => [row.id, row])).values()];
      setLoadedLocals(mergedRows);
      const inputValuesByResource: Record<string, Record<string, number>> = {};
      if (service.listOwnedOutpointValues) for (const [resourceId, result] of locals) Object.assign(inputValuesByResource[resourceId] ??= {}, await service.listOwnedOutpointValues(resourceId, result.items.flatMap((row) => row.inputOutpointKeys)));
      setLoadedInputValuesByResource((current) => {
        const next = { ...current };
        for (const [resourceId, values] of Object.entries(inputValuesByResource)) next[resourceId] = { ...(current[resourceId] ?? {}), ...values };
        return next;
      });
      setLocalCursors((current) => ({ ...current, ...Object.fromEntries(locals.map(([resourceId, result]) => [resourceId, result.nextCursor])) }));
      const loadedAnything = localAdditions.some((row) => row.chainResolution !== "chain-confirmed");
      const cursorRemains = locals.some(([, result]) => result.nextCursor);
      setLocalLoadFailed(!loadedAnything && cursorRemains);
      // Only advance when the merged visible rows actually cover the next page;
      // otherwise the new page would slice an empty window.
      return mergedRows.filter((row) => row.network === network && row.chainResolution !== "chain-confirmed").length > page * TRANSACTION_PAGE_SIZE;
    } catch (error) {
      setLocalLoadFailed(true);
      setActionError(error instanceof Error ? error.message : t("p2pkh.action.loadMoreFailed", { defaultValue: "Unable to load more local transactions." }));
      return false;
    } finally { setLoadingMore(null); }
  }

  async function loadMoreOwned(): Promise<boolean> {
    if (loadingMore) return false;
    setLoadingMore("owned");
    try {
      const resources = selectedResources;
      if (resources.some((resource) => ownedCursors[resource.resourceId]) && !service.listOwnedOutpointsPage) throw new Error(t("p2pkh.action.loadMoreUnsupported", { defaultValue: "Local coin pagination is unavailable." }));
      if (resources.some((resource) => localOutpointCursors[resource.resourceId]) && !service.listLocalOutpointsPage) throw new Error(t("p2pkh.action.loadMoreUnsupported", { defaultValue: "Local coin pagination is unavailable." }));
      if (resources.some((resource) => claimCursors[resource.resourceId]) && !service.listLocalInputClaimsPage) throw new Error(t("p2pkh.action.loadMoreUnsupported", { defaultValue: "Local coin pagination is unavailable." }));
      const owned = service.listOwnedOutpointsPage ? await Promise.all(resources.map(async (resource) => {
        if (!ownedCursors[resource.resourceId]) return [resource.resourceId, { items: [] as P2pkhOwnedOutpointProjection[], nextCursor: undefined }] as const;
        return [resource.resourceId, await service.listOwnedOutpointsPage!({ resourceId: resource.resourceId, cursor: ownedCursors[resource.resourceId], limit: 500 })] as const;
      })) : [];
      const localOutpoints = service.listLocalOutpointsPage ? await Promise.all(resources.map(async (resource) => {
        if (!localOutpointCursors[resource.resourceId]) return [resource.resourceId, { items: [] as P2pkhLocalOutpoint[], nextCursor: undefined }] as const;
        return [resource.resourceId, await service.listLocalOutpointsPage!({ resourceId: resource.resourceId, cursor: localOutpointCursors[resource.resourceId], limit: 500 })] as const;
      })) : [];
      const claims = service.listLocalInputClaimsPage ? await Promise.all(resources.map(async (resource) => {
        if (!claimCursors[resource.resourceId]) return [resource.resourceId, { items: [] as P2pkhLocalInputClaim[], nextCursor: undefined }] as const;
        return [resource.resourceId, await service.listLocalInputClaimsPage!({ resourceId: resource.resourceId, cursor: claimCursors[resource.resourceId], limit: 500 })] as const;
      })) : [];
      setLoadedOwned((current) => [...new Map([...current, ...owned.flatMap(([, result]) => result.items)].map((row) => [row.id, row])).values()]);
      setLoadedLocalOutpoints((current) => [...new Map([...current, ...localOutpoints.flatMap(([, result]) => result.items)].map((row) => [row.id, row])).values()]);
      setLoadedClaims((current) => [...new Map([...current, ...claims.flatMap(([, result]) => result.items)].map((row) => [row.id, row])).values()]);
      setOwnedCursors((current) => ({ ...current, ...Object.fromEntries(owned.map(([resourceId, result]) => [resourceId, result.nextCursor])) }));
      setLocalOutpointCursors((current) => ({ ...current, ...Object.fromEntries(localOutpoints.map(([resourceId, result]) => [resourceId, result.nextCursor])) }));
      setClaimCursors((current) => ({ ...current, ...Object.fromEntries(claims.map(([resourceId, result]) => [resourceId, result.nextCursor])) }));
      const loadedAnything = owned.some(([, result]) => result.items.length > 0) || localOutpoints.some(([, result]) => result.items.length > 0) || claims.some(([, result]) => result.items.length > 0);
      const cursorRemains = owned.some(([, result]) => result.nextCursor) || localOutpoints.some(([, result]) => result.nextCursor) || claims.some(([, result]) => result.nextCursor);
      setOwnedLoadFailed(!loadedAnything && cursorRemains);
      return loadedAnything;
    } catch (error) {
      setOwnedLoadFailed(true);
      setActionError(error instanceof Error ? error.message : t("p2pkh.action.loadMoreFailed", { defaultValue: "Unable to load more wallet history." }));
      return false;
    } finally { setLoadingMore(null); }
  }

  const hasMoreFacts = selectedResources.some((resource) => factCursors[resource.resourceId]);
  const hasMoreLocals = selectedResources.some((resource) => localCursors[resource.resourceId]);
  const hasMoreOwned = selectedResources.some((resource) => ownedCursors[resource.resourceId] || localOutpointCursors[resource.resourceId] || claimCursors[resource.resourceId]);
  useEffect(() => {
    // Transaction balances depend on the complete local owned projection. Load
    // its remaining pages automatically so visiting Coins is not a prerequisite
    // for a truthful transaction-list balance.
    if (loadingMore !== null) return;
    if (view === "transactions" && hasMoreOwned && !ownedLoadFailed) {
      void loadMoreOwned();
      return;
    }
    if (view === "transactions" && visibleTxRows.length === 0 && hasMoreFacts && !factsLoadFailed) void loadMoreFacts();
    if (view === "local-transactions" && visibleLocalTxRows.length === 0 && hasMoreLocals && !localLoadFailed) void loadMoreLocals();
  }, [view, visibleTxRows.length, visibleLocalTxRows.length, hasMoreFacts, hasMoreLocals, factsLoadFailed, localLoadFailed, hasMoreOwned, ownedLoadFailed, loadingMore]);
  const hasNextPage = txRows.length > page * TRANSACTION_PAGE_SIZE || hasMoreFacts;
  const txColumns: DataTableColumn<P2pkhTransactionListRow>[] = [
    { key: "txid", header: t("p2pkh.col.txid", { defaultValue: "txid" }), render: (row) => <code>{row.txid}</code> },
    { key: "height", header: t("p2pkh.col.height", { defaultValue: "区块高度" }), render: (row) => row.height },
    { key: "inputAmount", header: t("p2pkh.col.inputAmount", { defaultValue: "Input" }), render: (row) => amountLabel(row.inputAmount) },
    { key: "outputAmount", header: t("p2pkh.col.outputAmount", { defaultValue: "Output" }), render: (row) => amountLabel(row.outputAmount) },
    { key: "balanceAtBlock", header: t("p2pkh.col.balanceAtBlock", { defaultValue: "Balance at block" }), render: (row) => amountLabel(row.balanceAtBlock) },
    { key: "state", header: t("p2pkh.col.status", { defaultValue: "状态" }), render: (row) => t(`p2pkh.state.${row.state}`, { defaultValue: row.state }) },
    { key: "time", header: t("p2pkh.col.syncedAt", { defaultValue: "最近观察" }), render: (row) => row.time },
    { key: "action", header: "", render: (row) => <span><Button variant="ghost" onClick={() => router.push(detailPath(row.txid, network, page, view))}>{t("p2pkh.action.details", { defaultValue: "Details" })}</Button>{row.local && row.local.chainResolution === "unresolved" && (row.local.localState === "submitting" || row.local.localState === "isolated") ? <Button variant="ghost" disabled={rebroadcasting === row.local.id} onClick={() => void rebroadcast(row.local!)}>{rebroadcasting === row.local.id ? t("p2pkh.action.inProgress", { defaultValue: "Working…" }) : t("p2pkh.action.rebroadcast", { defaultValue: "Rebroadcast ancestors" })}</Button> : null}</span> }
  ];
  const localTxColumns: DataTableColumn<P2pkhTransactionListRow>[] = [
    { key: "txid", header: t("p2pkh.col.txid", { defaultValue: "txid" }), render: (row) => <code>{row.txid}</code> },
    { key: "inputAmount", header: t("p2pkh.col.inputAmount", { defaultValue: "Input" }), render: (row) => amountLabel(row.inputAmount) },
    { key: "outputAmount", header: t("p2pkh.col.outputAmount", { defaultValue: "Output" }), render: (row) => amountLabel(row.outputAmount) },
    { key: "localState", header: t("p2pkh.txDetail.state", { defaultValue: "Local state" }), render: (row) => t(`p2pkh.state.${row.local?.localState ?? row.state}`, { defaultValue: row.local?.localState ?? row.state }) },
    { key: "chainResolution", header: t("p2pkh.txDetail.chainResolution", { defaultValue: "Chain resolution" }), render: (row) => t(`p2pkh.resolution.${row.local?.chainResolution ?? "unresolved"}`, { defaultValue: row.local?.chainResolution ?? "unresolved" }) },
    { key: "time", header: t("p2pkh.col.syncedAt", { defaultValue: "最近观察" }), render: (row) => row.time },
    { key: "action", header: "", render: (row) => <span><Button variant="ghost" onClick={() => router.push(detailPath(row.txid, network, page, "local-transactions", row.local?.id))}>{t("p2pkh.action.details", { defaultValue: "Details" })}</Button>{row.local && row.local.chainResolution === "unresolved" && (row.local.localState === "submitting" || row.local.localState === "isolated") ? <Button variant="ghost" disabled={rebroadcasting === row.local.id} onClick={() => void rebroadcast(row.local!)}>{rebroadcasting === row.local.id ? t("p2pkh.action.inProgress", { defaultValue: "Working…" }) : t("p2pkh.action.rebroadcast", { defaultValue: "Rebroadcast ancestors" })}</Button> : null}</span> }
  ];
  const networkTitle = network === "main" ? t("p2pkh.wallet.mainnet", { defaultValue: "Mainnet" }) : t("p2pkh.wallet.testnet", { defaultValue: "Testnet" });
  const viewTitle = view === "transactions"
    ? t("p2pkh.wallet.transactions.title", { defaultValue: "On-chain transactions" })
    : t("p2pkh.wallet.localTransactions.title", { defaultValue: "Local transactions" });
  const viewDescription = view === "transactions"
    ? t("p2pkh.wallet.transactions.description", { defaultValue: "Confirmed transaction facts from the active chain." })
    : t("p2pkh.wallet.localTransactions.description", { defaultValue: "Local transaction lifecycle and chain resolution." });
  return (
    <div className="p2pkh-wallet">
      <PageHeader
        title={`${viewTitle} · ${networkTitle}`}
        description={viewDescription}
        actions={<><Button variant={network === "main" ? "primary" : "ghost"} onClick={() => router.push(listPath("main", page, view))}>{t("p2pkh.wallet.mainnet", { defaultValue: "Mainnet" })}</Button>{settings.includeTestnet ? <Button variant={network === "test" ? "primary" : "ghost"} onClick={() => router.push(listPath("test", page, view))}>{t("p2pkh.wallet.testnet", { defaultValue: "Testnet" })}</Button> : null}</>}
      />
      {wallet.error ? <EmptyState title={t("p2pkh.wallet.loadFailed", { defaultValue: "Wallet data unavailable" })} description={wallet.error} /> : null}
      {networkEnabled ? <section className="p2pkh-wallet__balances" aria-label={t("p2pkh.wallet.balances", { defaultValue: "BSV balances" })}>
        <article><h2>{networkTitle}</h2><strong>{networkBalance === undefined ? "—" : formatSats(networkBalance)}</strong><BalanceBreakdown breakdown={wallet.balances[network]?.breakdown} /></article>
      </section> : <EmptyState title={t("p2pkh.wallet.networkDisabled", { defaultValue: "Testnet is disabled" })} description={t("p2pkh.wallet.networkDisabledDescription", { defaultValue: "Enable testnet in P2PKH settings before viewing testnet data." })} />}
      <section className="p2pkh-wallet__sync" aria-label={t("p2pkh.wallet.syncStatus", { defaultValue: "Confirmed synchronization status" })}>
        {wallet.providers ? <p>{t("p2pkh.wallet.provider", { defaultValue: "Confirmed: {{sync}} · Broadcast: {{broadcast}}", sync: wallet.providers.selection[network].syncProviderId ?? "—", broadcast: wallet.providers.selection[network].broadcastProviderId ?? "—" })}</p> : null}
        <p>{t("p2pkh.wallet.lastCompleteSync", { defaultValue: "Last complete sync: {{time}}", time: sync?.lastSuccessAt ?? "—" })}</p>
        <p>{t("p2pkh.wallet.taskStatus", { defaultValue: "Task status: {{status}}", status: t(`p2pkh.syncStatus.${wallet.syncStatus}`, { defaultValue: wallet.syncStatus }) })}</p>
        {(wallet.syncError ?? sync?.lastError) ? <p role="alert">{t("p2pkh.wallet.syncError", { defaultValue: "Sync error: {{error}}", error: wallet.syncError ?? sync?.lastError })}</p> : null}
        {actionError ? <p role="alert">{actionError}</p> : null}
      </section>
      {view === "transactions" ? <>
        <DataTable columns={txColumns} rows={visibleTxRows} rowKey={(row) => row.id} />
        <div className="p2pkh-wallet__pagination" aria-label={t("p2pkh.wallet.pagination", { defaultValue: "Transaction pages" })}>
          <Button variant="ghost" disabled={page <= 1} onClick={() => setCurrentPage(page - 1)}>{t("p2pkh.action.previousPage", { defaultValue: "Previous" })}</Button>
          <span>{t("p2pkh.wallet.page", { defaultValue: "Page {{page}}", page })}</span>
          <Button variant="ghost" disabled={!hasNextPage || loadingMore !== null} onClick={() => { setFactsLoadFailed(false); if (txRows.length > page * TRANSACTION_PAGE_SIZE) setCurrentPage(page + 1); else void loadMoreFacts().then((loaded) => { if (loaded) setCurrentPage(page + 1); }); }}>{loadingMore === "facts" ? t("p2pkh.action.loadingMore", { defaultValue: "Loading…" }) : t("p2pkh.action.nextPage", { defaultValue: "Next" })}</Button>
        </div>
      </> : <>
        <DataTable columns={localTxColumns} rows={visibleLocalTxRows} rowKey={(row) => row.id} />
        <div className="p2pkh-wallet__pagination" aria-label={t("p2pkh.wallet.pagination", { defaultValue: "Transaction pages" })}>
          <Button variant="ghost" disabled={page <= 1} onClick={() => setCurrentPage(page - 1)}>{t("p2pkh.action.previousPage", { defaultValue: "Previous" })}</Button>
          <span>{t("p2pkh.wallet.page", { defaultValue: "Page {{page}}", page })}</span>
          <Button variant="ghost" disabled={!(localTxRows.length > page * TRANSACTION_PAGE_SIZE || hasMoreLocals) || loadingMore !== null} onClick={() => { setLocalLoadFailed(false); if (localTxRows.length > page * TRANSACTION_PAGE_SIZE) setCurrentPage(page + 1); else void loadMoreLocals().then((loaded) => { if (loaded) setCurrentPage(page + 1); }); }}>{loadingMore === "locals" ? t("p2pkh.action.loadingMore", { defaultValue: "Loading…" }) : t("p2pkh.action.nextPage", { defaultValue: "Next" })}</Button>
        </div>
      </>}
    </div>
  );
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
