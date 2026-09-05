import type { P2pkhConfirmedDataProvider, P2pkhProviderRegistry } from "@keymaster/contracts";
import { P2pkhProviderError } from "@keymaster/contracts";
import type { P2pkhKeyResource, P2pkhTransactionSyncState } from "./p2pkhContracts.js";
import type { P2pkhStateRepositoryHandle } from "./storage/p2pkhStateRepository.js";

export const P2PKH_TRANSACTIONS_SYNC_TASK = "p2pkh.transactions-sync";

export interface P2pkhTransactionSyncDeps {
  getStore(): Promise<P2pkhStateRepositoryHandle>;
  getResources(): Promise<P2pkhKeyResource[]>;
  registry: P2pkhProviderRegistry;
  getSelection(network: "main" | "test"): { syncProviderId: string | null; generation: number };
  isGenerationCurrent?(network: "main" | "test", generation: number): boolean;
  isNetworkEnabled?(network: "main" | "test"): boolean;
  now?(): string;
}

export interface P2pkhTransactionSyncResult { resources: number; pages: number; transactions: number; cancelled: boolean; }

function dedupePage(items: Array<{ txid: string; blockHeight?: number; blockHash?: string; blockTime?: number }>) {
  const seen = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    const txid = item.txid.toLowerCase();
    const prior = seen.get(txid);
    if (prior && (prior.blockHeight !== item.blockHeight || prior.blockHash !== item.blockHash)) throw new P2pkhProviderError("provider-inconsistent", `Conflicting block metadata for transaction ${txid}`);
    if (!prior) seen.set(txid, { ...item, txid });
  }
  return [...seen.values()];
}

export function createP2pkhTransactionSync(deps: P2pkhTransactionSyncDeps) {
  const now = () => deps.now?.() ?? new Date().toISOString();
  async function syncResource(resource: P2pkhKeyResource, signal: AbortSignal): Promise<{ pages: number; transactions: number }> {
    const network = resource.network;
    if (deps.isNetworkEnabled && !deps.isNetworkEnabled(network)) return { pages: 0, transactions: 0 };
    const selection = deps.getSelection(network);
    if (!selection.syncProviderId) throw new P2pkhProviderError("provider-unavailable", `No confirmed sync provider selected for ${network}`);
    const provider = deps.registry.getConfirmedProvider(selection.syncProviderId, network);
    if (!provider) throw new P2pkhProviderError("provider-unavailable", `Selected confirmed provider is unavailable: ${selection.syncProviderId}`);
    const stateRepository = await deps.getStore();
    const previous = await stateRepository.getTransactionSyncState(resource.resourceId);
    const resuming = previous?.inProgressProviderId === selection.syncProviderId && previous.inProgressProviderGeneration === selection.generation;
    const runId = resuming && previous?.runId ? previous.runId : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let cursor = resuming ? previous?.inProgressCursor : undefined;
    let pages = 0; let transactions = 0;
    // A resumed run must retain the original head. Otherwise the final page
    // can move completeHeadTxid backwards to an older transaction.
    let runHeadTxid: string | undefined = resuming ? previous?.runHeadTxid : undefined;
    let anchorSeen = false;
    const observedTxids = new Set<string>(resuming ? previous?.runObservedTxids ?? [] : []);
    const seenPageItems = new Map<string, { blockHeight?: number; blockHash?: string; blockTime?: number }>();
    let emptyHistoryConfirmed = false;
    let providerReturnedTransactions = false;
    await stateRepository.putTransactionSyncState({ id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: previous?.completeHeadTxid, inProgressProviderId: selection.syncProviderId, inProgressProviderGeneration: selection.generation, inProgressCursor: cursor, runHeadTxid, runObservedTxids: resuming ? previous?.runObservedTxids : [], runId, pagesSynced: 0, transactionsSynced: 0, lastAttemptAt: now(), lastSuccessAt: previous?.lastSuccessAt });
    try {
      while (true) {
        if (signal.aborted) return { pages, transactions };
        if (deps.isNetworkEnabled && !deps.isNetworkEnabled(network)) return { pages, transactions };
        if (deps.isGenerationCurrent && !deps.isGenerationCurrent(network, selection.generation)) return { pages, transactions };
        const page = await provider.listAddressConfirmedTransactions({ network, address: resource.address, cursor, limit: 100, signal });
        const pageItems = dedupePage(page.items);
        const items = pageItems.filter((item) => {
          const previousItem = seenPageItems.get(item.txid);
          if (previousItem && (previousItem.blockHeight !== item.blockHeight || previousItem.blockHash !== item.blockHash || previousItem.blockTime !== item.blockTime)) throw new P2pkhProviderError("provider-inconsistent", `Conflicting block metadata for transaction ${item.txid}`);
          if (previousItem) return false;
          seenPageItems.set(item.txid, { blockHeight: item.blockHeight, blockHash: item.blockHash, blockTime: item.blockTime });
          return true;
        });
        if (pageItems.length > 0) providerReturnedTransactions = true;
        if (pageItems.length === 0) {
          if (!page.exhausted) throw new P2pkhProviderError("provider-inconsistent", "Confirmed provider returned an empty non-terminal page");
          // An empty terminal page is valid for a never-seen address. Once a
          // resource has facts, require an independent full-head confirmation
          // before treating it as a real empty history. This preserves data
          // during a transient provider response while still allowing a
          // genuine all-history reorg to converge and clear stale facts.
          const existingFacts = typeof stateRepository.listTransactionFacts === "function" ? await stateRepository.listTransactionFacts({ resourceId: resource.resourceId }) : [];
          // A terminal empty page after one or more non-empty pages is just
          // the end of this provider walk, not an empty address history.
          // Only a run that has not observed any transaction may perform the
          // independent full-head empty-history confirmation.
          const canConfirmEmptyHistory = !providerReturnedTransactions && (!resuming || (previous?.runObservedTxids?.length ?? 0) === 0);
          if (canConfirmEmptyHistory && (previous?.completeHeadTxid || existingFacts.length > 0)) {
            const confirmation = await provider.listAddressConfirmedTransactions({ network, address: resource.address, cursor: undefined, limit: 100, signal });
            const confirmationItems = dedupePage(confirmation.items);
            if (!confirmation.exhausted && confirmationItems.length === 0) throw new P2pkhProviderError("provider-inconsistent", "Confirmed provider returned an empty non-terminal history confirmation");
            if (confirmationItems.length > 0) {
              // The first empty response was transient or inconsistent. Start
              // a fresh head walk so the cursor from the empty response cannot
              // hide the transactions returned by the confirmation.
              cursor = undefined;
              seenPageItems.clear();
              observedTxids.clear();
              runHeadTxid = undefined;
              anchorSeen = false;
              continue;
            }
            emptyHistoryConfirmed = true;
            observedTxids.clear();
            runHeadTxid = undefined;
            anchorSeen = false;
          }
        }
        for (const item of items) observedTxids.add(item.txid.toLowerCase());
        if (!runHeadTxid && items[0]) runHeadTxid = items[0].txid;
        const details = await Promise.all(items.map((item) => provider.getConfirmedTransaction({ network, txid: item.txid, signal }).then((detail) => {
          if (detail.txid.toLowerCase() !== item.txid.toLowerCase()) throw new P2pkhProviderError("provider-inconsistent", `Confirmed detail txid does not match page item ${item.txid}`);
          return { ...detail, blockHeight: detail.blockHeight ?? item.blockHeight, blockHash: detail.blockHash ?? item.blockHash, blockTime: detail.blockTime ?? item.blockTime };
        })));
        if (signal.aborted) return { pages, transactions };
        if (deps.isGenerationCurrent && !deps.isGenerationCurrent(network, selection.generation)) return { pages, transactions };
        pages += 1;
        const anchorItem = previous?.completeHeadTxid ? items.find((item) => item.txid === previous.completeHeadTxid) : undefined;
        const anchorDetail = previous?.completeHeadTxid ? details.find((detail) => detail.txid === previous.completeHeadTxid) : undefined;
        // A provider without block heights cannot prove that reaching the old
        // txid means the history overlap is complete. Continue to exhaustion
        // so a reorged transaction above that anchor is observed as stale.
        anchorSeen = anchorSeen || Boolean(anchorItem && (anchorItem.blockHeight !== undefined || anchorDetail?.blockHeight !== undefined));
        cursor = page.nextCursor;
        const completePage = page.exhausted || anchorSeen;
        transactions += details.length;
        const checkpoint: P2pkhTransactionSyncState = { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: completePage ? runHeadTxid ?? (emptyHistoryConfirmed ? undefined : previous?.completeHeadTxid) : previous?.completeHeadTxid, inProgressProviderId: completePage ? undefined : selection.syncProviderId, inProgressProviderGeneration: completePage ? undefined : selection.generation, inProgressCursor: completePage ? undefined : cursor, runHeadTxid: completePage ? undefined : runHeadTxid, runObservedTxids: completePage ? undefined : [...observedTxids], runId, pagesSynced: pages, transactionsSynced: transactions, lastAttemptAt: now(), lastSuccessAt: completePage ? now() : previous?.lastSuccessAt };
        // A resumed run starts after an already-committed cursor, so its
        // observed set is intentionally incomplete.  It may still finish at
        // provider exhaustion, but must not be treated as a complete-history
        // snapshot or valid facts from the earlier part of the run would look
        // stale and be deleted.
        if (typeof stateRepository.ingestConfirmedTransactionPage === "function") await stateRepository.ingestConfirmedTransactionPage({ resource, transactions: details, syncState: checkpoint, reorgCheck: completePage ? { observedTxids: [...observedTxids], completeHistory: page.exhausted && !anchorSeen && (emptyHistoryConfirmed || !resuming || previous?.runObservedTxids !== undefined), anchorTxid: anchorSeen ? previous?.completeHeadTxid : undefined } : undefined });
        else { for (const detail of details) await stateRepository.ingestConfirmedTransaction({ resource, tx: detail, expectedGeneration: resource.generation }); await stateRepository.putTransactionSyncState(checkpoint); }
        if (completePage) return { pages, transactions };
      }
      return { pages, transactions };
    } catch (error) {
      if (signal.aborted || (typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "AbortError")) return { pages, transactions };
      const current = await stateRepository.getTransactionSyncState(resource.resourceId);
      await stateRepository.putTransactionSyncState({ ...(current ?? { id: resource.resourceId, resourceId: resource.resourceId, pagesSynced: pages, transactionsSynced: transactions }), lastError: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300), lastAttemptAt: now(), completeHeadTxid: previous?.completeHeadTxid, inProgressProviderId: selection.syncProviderId, inProgressProviderGeneration: selection.generation, inProgressCursor: cursor, runId, runHeadTxid, runObservedTxids: [...observedTxids], pagesSynced: pages, transactionsSynced: transactions });
      throw error;
    }
  }
  return {
    async runOnce(signal: AbortSignal): Promise<P2pkhTransactionSyncResult> {
      const resources = await deps.getResources(); let pages = 0; let transactions = 0;
      for (const resource of resources) { if (signal.aborted) break; const result = await syncResource(resource, signal); pages += result.pages; transactions += result.transactions; }
      return { resources: resources.length, pages, transactions, cancelled: signal.aborted };
    }
  };
}
