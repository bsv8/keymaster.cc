import { useEffect, useMemo, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, formatSats, formatSatsWithPrice, type DataTableColumn } from "@keymaster/ui";
import { useOptionalCapability } from "webloom-framework/react";
import { router, useBsvPrice, useI18n, useLocale, useOptionalResourceSelector, usePluginHost } from "@keymaster/runtime";
import { P2PKH_COORDINATOR_CONTROL_CAPABILITY } from "@keymaster/contracts";
import type { P2pkhBalanceBreakdown, P2pkhGlobalSettings, P2pkhHistoryRecord, P2pkhKeyResource, P2pkhLocalInputClaim, P2pkhLocalTransaction, P2pkhService, P2pkhSyncStatus, P2pkhTransactionSyncState, P2pkhUtxo } from "../p2pkhContracts.js";
import { P2PKH_CAPABILITY } from "../p2pkhContracts.js";
import { detailPath, listPath, parseStoredTransaction, readPage, type P2pkhNetwork, type P2pkhWalletView } from "./p2pkhTransactionView.js";

export const TRANSACTION_PAGE_SIZE = 20;

export type WalletSnapshot = {
  resources: P2pkhKeyResource[];
  history: P2pkhHistoryRecord[];
  locals: P2pkhLocalTransaction[];
  claims: P2pkhLocalInputClaim[];
  utxos: P2pkhUtxo[];
  utxosAvailable: boolean;
  utxosSyncedAt?: string;
  protectedOutpoints: Array<{ txid: string; vout: number; network: "main" | "test" }>;
  sync: P2pkhTransactionSyncState[];
  syncStatus: P2pkhSyncStatus;
  lastSyncedAt?: string;
  syncError?: string;
  balances: Record<string, { total: number; available?: boolean; breakdown?: P2pkhBalanceBreakdown }>;
  historyCursors: Record<string, string | undefined>;
  localCursors: Record<string, string | undefined>;
  claimCursors: Record<string, string | undefined>;
};

export interface P2pkhTransactionListRow {
  id: string;
  txid: string;
  network: P2pkhNetwork;
  height: number | string;
  state: string;
  time: string;
  outputAmount?: number;
  local?: P2pkhLocalTransaction;
}

function amountLabel(value: number | undefined): string {
  return value === undefined ? "—" : formatSats(value);
}

const EMPTY_WALLET_SNAPSHOT: WalletSnapshot = {
  resources: [], history: [], locals: [], claims: [], utxos: [], utxosAvailable: false, protectedOutpoints: [],
  sync: [], syncStatus: "idle", balances: {}, historyCursors: {}, localCursors: {}, claimCursors: {}
};

export function P2pkhWalletPage(props: { view?: P2pkhWalletView; network?: P2pkhNetwork } = {}) {
  const { t } = useI18n();
  // owner 作用域 capability 会在锁定时撤销；路由组件在锁定瞬间仍可能完成
  // 一次渲染，必须按"暂不可用"降级而不是抛错。
  const coordinator = useOptionalCapability(P2PKH_COORDINATOR_CONTROL_CAPABILITY);
  const service = useOptionalCapability(P2PKH_CAPABILITY);
  if (!service || !coordinator) {
    return (
      <div className="p2pkh-wallet">
        <EmptyState
          title={t("p2pkh.wallet.locked.title", { defaultValue: "钱包已锁定" })}
          description={t("p2pkh.wallet.locked.description", { defaultValue: "解锁后可继续查看交易。" })}
        />
      </div>
    );
  }
  return <P2pkhWalletPageInner {...props} service={service} />;
}

function P2pkhWalletPageInner({
  view = "transactions",
  network = "main",
  service
}: {
  view?: P2pkhWalletView;
  network?: P2pkhNetwork;
  service: P2pkhService;
}) {
  const host = usePluginHost();
  const { t } = useI18n();
  const locale = useLocale();
  const price = useBsvPrice();
  const [page, setPage] = useState(() => readPage());
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const wallet = useOptionalResourceSelector<WalletSnapshot, WalletSnapshot & { error?: string }>(
    host.resourceStore,
    "p2pkh.wallet",
    [],
    (snapshot) => snapshot.data
      ? {
          ...snapshot.data,
          historyCursors: snapshot.data.historyCursors ?? {},
          localCursors: snapshot.data.localCursors ?? {},
          claimCursors: snapshot.data.claimCursors ?? {},
          error: snapshot.error?.message
        }
      : { ...EMPTY_WALLET_SNAPSHOT, error: snapshot.error?.message },
    EMPTY_WALLET_SNAPSHOT
  );
  const [loadedHistory, setLoadedHistory] = useState<P2pkhHistoryRecord[]>(wallet.history);
  const [loadedLocals, setLoadedLocals] = useState<P2pkhLocalTransaction[]>(wallet.locals);
  const [historyCursors, setHistoryCursors] = useState<Record<string, string | undefined>>(wallet.historyCursors);
  const [localCursors, setLocalCursors] = useState<Record<string, string | undefined>>(wallet.localCursors);
  const [loadingMore, setLoadingMore] = useState<"history" | "locals" | null>(null);

  const settings = useOptionalResourceSelector<P2pkhGlobalSettings, P2pkhGlobalSettings>(
    host.resourceStore,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data ?? { includeTestnet: false },
    { includeTestnet: false }
  );

  useEffect(() => {
    setLoadedHistory(wallet.history);
    setLoadedLocals(wallet.locals);
    setHistoryCursors(wallet.historyCursors);
    setLocalCursors(wallet.localCursors);
  }, [wallet.history, wallet.locals, wallet.historyCursors, wallet.localCursors]);

  const setCurrentPage = (next: number) => {
    if (next < 1) return;
    setPage(next);
    router.push(listPath(network, next, view));
  };
  const networkEnabled = network === "main" || settings.includeTestnet;
  const balance = networkEnabled ? wallet.balances[network] : undefined;
  const balanceKnown = Boolean(balance?.available);
  const sync = wallet.sync.find((row) => row.resourceId === `p2pkh:${network}`);
  const selectedResources = useMemo(() => networkEnabled ? wallet.resources.filter((resource) => resource.network === network) : [], [wallet.resources, network, networkEnabled]);

  const txRows = useMemo<P2pkhTransactionListRow[]>(() => {
    if (!networkEnabled) return [];
    return loadedHistory
      .filter((row) => row.network === network)
      .map((row) => ({
        id: row.id,
        txid: row.txid,
        network: row.network,
        height: row.height > 0 ? row.height : "—",
        state: "chain-confirmed",
        time: row.firstSeenAt,
      }))
      .sort((left, right) => {
        const leftHeight = typeof left.height === "number" ? left.height : -1;
        const rightHeight = typeof right.height === "number" ? right.height : -1;
        return rightHeight - leftHeight || right.txid.localeCompare(left.txid);
      });
  }, [loadedHistory, network, networkEnabled]);

  const visibleTxRows = useMemo(() => txRows.slice((page - 1) * TRANSACTION_PAGE_SIZE, page * TRANSACTION_PAGE_SIZE), [txRows, page]);
  const localTxRows = useMemo<P2pkhTransactionListRow[]>(() => loadedLocals
    .filter((row) => networkEnabled && row.network === network && row.chainResolution !== "chain-confirmed")
    .map((row) => {
      const parsed = parseStoredTransaction(row.rawTxHex, row.txid);
      return {
        id: row.id,
        txid: row.txid,
        network: row.network,
        height: "—",
        state: row.localState,
        time: row.updatedAt,
        outputAmount: parsed ? parsed.outputs.reduce((sum, output) => sum + output.value, 0) : undefined,
        local: row
      };
    })
    .sort((left, right) => Date.parse(right.time) - Date.parse(left.time) || right.id.localeCompare(left.id)), [loadedLocals, network, networkEnabled]);
  const visibleLocalTxRows = useMemo(() => localTxRows.slice((page - 1) * TRANSACTION_PAGE_SIZE, page * TRANSACTION_PAGE_SIZE), [localTxRows, page]);

  async function refreshUtxos() {
    setRefreshing(true);
    setActionError(null);
    try {
      await service.refreshUtxos?.({ ownerPublicKeyHex: selectedResources[0]?.publicKeyHex });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }

  async function loadMoreHistory(): Promise<boolean> {
    if (loadingMore) return false;
    setLoadingMore("history");
    try {
      if (!service.listHistoryPage) throw new Error(t("p2pkh.action.loadMoreUnsupported", { defaultValue: "本地分页不可用。" }));
      const pages = await Promise.all(selectedResources.map(async (resource) => {
        if (!historyCursors[resource.resourceId]) return [resource.resourceId, { items: [] as P2pkhHistoryRecord[], nextCursor: undefined }] as const;
        return [resource.resourceId, await service.listHistoryPage!({ resourceId: resource.resourceId, cursor: historyCursors[resource.resourceId], limit: 200 })] as const;
      }));
      const additions = pages.flatMap(([, result]) => result.items);
      setLoadedHistory((current) => [...new Map([...current, ...additions].map((row) => [row.id, row])).values()]);
      setHistoryCursors((current) => ({ ...current, ...Object.fromEntries(pages.map(([resourceId, result]) => [resourceId, result.nextCursor])) }));
      const cursorRemains = pages.some(([, result]) => result.nextCursor);
      void cursorRemains;
      return additions.length > 0;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("p2pkh.action.loadMoreFailed", { defaultValue: "无法加载更多钱包历史。" }));
      return false;
    } finally { setLoadingMore(null); }
  }

  async function loadMoreLocals(): Promise<boolean> {
    if (loadingMore) return false;
    setLoadingMore("locals");
    try {
      if (!service.listLocalTransactionsPage) throw new Error(t("p2pkh.action.loadMoreUnsupported", { defaultValue: "本地分页不可用。" }));
      const pages = await Promise.all(selectedResources.map(async (resource) => {
        if (!localCursors[resource.resourceId]) return [resource.resourceId, { items: [] as P2pkhLocalTransaction[], nextCursor: undefined }] as const;
        return [resource.resourceId, await service.listLocalTransactionsPage!({ resourceId: resource.resourceId, cursor: localCursors[resource.resourceId], limit: 200 })] as const;
      }));
      const additions = pages.flatMap(([, result]) => result.items);
      setLoadedLocals((current) => [...new Map([...current, ...additions].map((row) => [row.id, row])).values()]);
      setLocalCursors((current) => ({ ...current, ...Object.fromEntries(pages.map(([resourceId, result]) => [resourceId, result.nextCursor])) }));
      const cursorRemains = pages.some(([, result]) => result.nextCursor);
      void cursorRemains;
      return additions.length > 0;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("p2pkh.action.loadMoreFailed", { defaultValue: "无法加载更多钱包历史。" }));
      return false;
    } finally { setLoadingMore(null); }
  }

  const hasMoreHistory = selectedResources.some((resource) => historyCursors[resource.resourceId]);
  const hasMoreLocals = selectedResources.some((resource) => localCursors[resource.resourceId]);
  const txColumns: DataTableColumn<P2pkhTransactionListRow>[] = [
    { key: "txid", header: t("p2pkh.col.txid", { defaultValue: "txid" }), render: (row) => <code>{row.txid}</code> },
    { key: "height", header: t("p2pkh.col.height", { defaultValue: "区块高度" }), render: (row) => row.height },
    { key: "state", header: t("p2pkh.col.status", { defaultValue: "状态" }), render: (row) => t(`p2pkh.state.${row.state}`, { defaultValue: row.state }) },
    { key: "time", header: t("p2pkh.col.syncedAt", { defaultValue: "最近观察" }), render: (row) => row.time },
    { key: "action", header: "", render: (row) => <Button variant="ghost" onClick={() => router.push(detailPath(row.txid, network, page, view))}>{t("p2pkh.action.details", { defaultValue: "Details" })}</Button> }
  ];
  const localTxColumns: DataTableColumn<P2pkhTransactionListRow>[] = [
    { key: "txid", header: t("p2pkh.col.txid", { defaultValue: "txid" }), render: (row) => <code>{row.txid}</code> },
    { key: "outputAmount", header: t("p2pkh.col.outputAmount", { defaultValue: "Output" }), render: (row) => amountLabel(row.outputAmount) },
    { key: "localState", header: t("p2pkh.txDetail.state", { defaultValue: "Local state" }), render: (row) => t(`p2pkh.state.${row.local?.localState ?? row.state}`, { defaultValue: row.local?.localState ?? row.state }) },
    { key: "chainResolution", header: t("p2pkh.txDetail.chainResolution", { defaultValue: "Chain resolution" }), render: (row) => t(`p2pkh.resolution.${row.local?.chainResolution ?? "unresolved"}`, { defaultValue: row.local?.chainResolution ?? "unresolved" }) },
    { key: "time", header: t("p2pkh.col.syncedAt", { defaultValue: "最近观察" }), render: (row) => row.time },
    { key: "action", header: "", render: (row) => <Button variant="ghost" onClick={() => router.push(detailPath(row.txid, network, page, "local-transactions", row.local?.id))}>{t("p2pkh.action.details", { defaultValue: "Details" })}</Button> }
  ];
  const networkTitle = network === "main" ? t("p2pkh.wallet.mainnet", { defaultValue: "Mainnet" }) : t("p2pkh.wallet.testnet", { defaultValue: "Testnet" });
  const viewTitle = view === "transactions"
    ? t("p2pkh.wallet.transactions.title", { defaultValue: "On-chain transactions" })
    : t("p2pkh.wallet.localTransactions.title", { defaultValue: "Local transactions" });
  const viewDescription = view === "transactions"
    ? t("p2pkh.wallet.transactions.description", { defaultValue: "WoC 历史元数据（txid / 高度）。详情页按需懒加载 raw transaction。" })
    : t("p2pkh.wallet.localTransactions.description", { defaultValue: "本地提交与按 txid 的链上收敛状态。" });
  return (
    <div className="p2pkh-wallet">
      <PageHeader
        title={`${viewTitle} · ${networkTitle}`}
        description={viewDescription}
        actions={<><Button variant={network === "main" ? "primary" : "ghost"} onClick={() => router.push(listPath("main", page, view))}>{t("p2pkh.wallet.mainnet", { defaultValue: "Mainnet" })}</Button>{settings.includeTestnet ? <Button variant={network === "test" ? "primary" : "ghost"} onClick={() => router.push(listPath("test", page, view))}>{t("p2pkh.wallet.testnet", { defaultValue: "Testnet" })}</Button> : null}</>}
      />
      {wallet.error ? <EmptyState title={t("p2pkh.wallet.loadFailed", { defaultValue: "Wallet data unavailable" })} description={wallet.error} /> : null}
      {networkEnabled ? <section className="p2pkh-wallet__balances" aria-label={t("p2pkh.wallet.balances", { defaultValue: "BSV balances" })}>
        <article>
          <h2>{networkTitle}</h2>
          <strong>{balanceKnown ? formatSatsWithPrice(balance!.total, price, { locale, network }) : t("p2pkh.balance.unknown", { defaultValue: "未知（尚未取得 UTXO 快照）" })}</strong>
          <BalanceBreakdown breakdown={balance?.breakdown} />
          <Button variant="ghost" disabled={refreshing || selectedResources.length === 0} onClick={() => void refreshUtxos()}>{refreshing ? t("p2pkh.action.inProgress", { defaultValue: "处理中…" }) : t("p2pkh.action.refreshUtxos", { defaultValue: "刷新 UTXO" })}</Button>
        </article>
      </section> : <EmptyState title={t("p2pkh.wallet.networkDisabled", { defaultValue: "Testnet is disabled" })} description={t("p2pkh.wallet.networkDisabledDescription", { defaultValue: "Enable testnet in P2PKH settings before viewing testnet data." })} />}
      <section className="p2pkh-wallet__sync" aria-label={t("p2pkh.wallet.syncStatus", { defaultValue: "Confirmed synchronization status" })}>
        <p>{t("p2pkh.wallet.lastCompleteSync", { defaultValue: "Last complete sync: {{time}}", time: wallet.lastSyncedAt ?? sync?.lastSuccessAt ?? "—" })}</p>
        <p>{t("p2pkh.wallet.taskStatus", { defaultValue: "Task status: {{status}}", status: t(`p2pkh.syncStatus.${wallet.syncStatus}`, { defaultValue: wallet.syncStatus }) })}</p>
        {wallet.utxosAvailable ? <p>{t("p2pkh.wallet.utxoSnapshot", { defaultValue: "UTXO 快照：{{time}}（{{count}} 个输出）", time: wallet.utxosSyncedAt ?? "—", count: wallet.utxos.length })}</p> : null}
        {(wallet.syncError ?? sync?.lastError) ? <p role="alert">{t("p2pkh.wallet.syncError", { defaultValue: "Sync error: {{error}}", error: wallet.syncError ?? sync?.lastError })}</p> : null}
        {actionError ? <p role="alert">{actionError}</p> : null}
      </section>
      {view === "transactions" ? <>
        <DataTable columns={txColumns} rows={visibleTxRows} rowKey={(row) => row.id} />
        <div className="p2pkh-wallet__pagination" aria-label={t("p2pkh.wallet.pagination", { defaultValue: "Transaction pages" })}>
          <Button variant="ghost" disabled={page <= 1} onClick={() => setCurrentPage(page - 1)}>{t("p2pkh.action.previousPage", { defaultValue: "Previous" })}</Button>
          <span>{t("p2pkh.wallet.page", { defaultValue: "Page {{page}}", page })}</span>
          <Button variant="ghost" disabled={!(txRows.length > page * TRANSACTION_PAGE_SIZE || hasMoreHistory) || loadingMore !== null} onClick={() => { if (txRows.length > page * TRANSACTION_PAGE_SIZE) setCurrentPage(page + 1); else void loadMoreHistory().then((loaded) => { if (loaded) setCurrentPage(page + 1); }); }}>{loadingMore === "history" ? t("p2pkh.action.loadingMore", { defaultValue: "Loading…" }) : t("p2pkh.action.nextPage", { defaultValue: "Next" })}</Button>
        </div>
      </> : <>
        <DataTable columns={localTxColumns} rows={visibleLocalTxRows} rowKey={(row) => row.id} />
        <div className="p2pkh-wallet__pagination" aria-label={t("p2pkh.wallet.pagination", { defaultValue: "Transaction pages" })}>
          <Button variant="ghost" disabled={page <= 1} onClick={() => setCurrentPage(page - 1)}>{t("p2pkh.action.previousPage", { defaultValue: "Previous" })}</Button>
          <span>{t("p2pkh.wallet.page", { defaultValue: "Page {{page}}", page })}</span>
          <Button variant="ghost" disabled={!(localTxRows.length > page * TRANSACTION_PAGE_SIZE || hasMoreLocals) || loadingMore !== null} onClick={() => { if (localTxRows.length > page * TRANSACTION_PAGE_SIZE) setCurrentPage(page + 1); else void loadMoreLocals().then((loaded) => { if (loaded) setCurrentPage(page + 1); }); }}>{loadingMore === "locals" ? t("p2pkh.action.loadingMore", { defaultValue: "Loading…" }) : t("p2pkh.action.nextPage", { defaultValue: "Next" })}</Button>
        </div>
      </>}
    </div>
  );
}

function BalanceBreakdown({ breakdown }: { breakdown?: P2pkhBalanceBreakdown }) {
  const { t } = useI18n();
  if (!breakdown) return null;
  return <dl className="p2pkh-wallet__balance-breakdown">
    <dt>{t("p2pkh.balance.confirmed", { defaultValue: "已确认" })}</dt><dd>{formatSats(breakdown.confirmed)}</dd>
    <dt>{t("p2pkh.balance.unconfirmed", { defaultValue: "未确认" })}</dt><dd>{formatSats(breakdown.unconfirmed)}</dd>
    <dt>{t("p2pkh.balance.localSpendable", { defaultValue: "可花费" })}</dt><dd>{formatSats(breakdown.spendable)}</dd>
    <dt>{t("p2pkh.balance.pendingClaims", { defaultValue: "待确认输入占用" })}</dt><dd>{formatSats(breakdown.pendingInputClaims)}</dd>
  </dl>;
}
