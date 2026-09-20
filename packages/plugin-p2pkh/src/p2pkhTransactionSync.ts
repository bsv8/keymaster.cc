// P2PKH 历史同步：只同步 WoC history 元数据，与 UTXO 完全解耦。
//
// 设计缘由（2026-09-20 解耦）：
//   - 历史同步只分页读取 WoC confirmed history，保存 txid/height/fee；
//   - 不派生 UTXO、不构建 owned outpoints、不回放花费关系、不计算余额；
//   - 不下载 raw transaction（详情页按 txid 懒加载并临时解析）；
//   - 完整分页成功后整文件替换历史；中途失败保留旧历史；
//   - 本地提交只在“相同 txid”出现在历史里时标记 chain-confirmed，
//     不再派生 conflicted、后代失效或本地交易 DAG。

import type { WocHistoryPage, WocService } from "@keymaster/contracts";
import { P2pkhProviderError } from "@keymaster/contracts";
import type { P2pkhKeyResource, P2pkhTransactionSyncState } from "./p2pkhContracts.js";
import type { P2pkhStateRepositoryHandle } from "./storage/p2pkhStateRepository.js";

export const P2PKH_TRANSACTIONS_SYNC_TASK = "p2pkh.transactions-sync";

/** 分页请求上限（WoC 免费档 3 req/s，actor 内部统一限流）。 */
const HISTORY_PAGE_LIMIT = 100;
/** 防御性分页上限：单资源 10 万页视为 provider 不一致。 */
const HISTORY_MAX_PAGES = 100_000;

export interface P2pkhTransactionSyncDeps {
  getStore(): Promise<P2pkhStateRepositoryHandle>;
  getResources(): Promise<P2pkhKeyResource[]>;
  woc: WocService;
  isNetworkEnabled?(network: "main" | "test"): boolean;
  now?(): string;
}

export interface P2pkhTransactionSyncResult { resources: number; pages: number; transactions: number; cancelled: boolean; }

interface HistoryEntry { txid: string; height: number; fee?: number; }

function normalizeHistoryItem(item: WocHistoryPage["items"][number]): HistoryEntry {
  const txid = String(item.txid ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(txid)) throw new P2pkhProviderError("provider-inconsistent", "WoC history returned an invalid txid");
  const height = Number(item.height);
  if (!Number.isSafeInteger(height) || height < 0) throw new P2pkhProviderError("provider-inconsistent", `WoC history returned an invalid height for ${txid}`);
  const fee = (item as { fee?: unknown }).fee;
  if (fee !== undefined && (!Number.isSafeInteger(fee) || (fee as number) < 0)) throw new P2pkhProviderError("provider-inconsistent", `WoC history returned an invalid fee for ${txid}`);
  return { txid, height, ...(fee === undefined ? {} : { fee: fee as number }) };
}

export function createP2pkhTransactionSync(deps: P2pkhTransactionSyncDeps) {
  const now = () => deps.now?.() ?? new Date().toISOString();

  async function syncResource(resource: P2pkhKeyResource, signal: AbortSignal): Promise<{ pages: number; transactions: number }> {
    const network = resource.network;
    if (deps.isNetworkEnabled && !deps.isNetworkEnabled(network)) return { pages: 0, transactions: 0 };
    const stateRepository = await deps.getStore();
    let cursor: string | undefined;
    let pages = 0;
    let transactions = 0;
    const entries = new Map<string, HistoryEntry>();
    try {
      while (true) {
        if (signal.aborted) return { pages, transactions };
        if (deps.isNetworkEnabled && !deps.isNetworkEnabled(network)) return { pages, transactions };
        const page = await deps.woc.listAddressConfirmedHistory(
          network,
          resource.address,
          { limit: HISTORY_PAGE_LIMIT, ...(cursor === undefined ? {} : { nextPageToken: cursor }) },
          { priority: "background", signal }
        );
        for (const rawItem of page.items) {
          const item = normalizeHistoryItem(rawItem);
          const existing = entries.get(item.txid);
          if (existing && (existing.height !== item.height || existing.fee !== item.fee)) {
            throw new P2pkhProviderError("provider-inconsistent", `Conflicting history metadata for transaction ${item.txid}`);
          }
          if (!existing) entries.set(item.txid, item);
        }
        pages += 1;
        transactions += page.items.length;
        cursor = page.nextPageToken;
        if (!cursor) break;
        if (pages >= HISTORY_MAX_PAGES) throw new P2pkhProviderError("provider-inconsistent", "WoC history pagination exceeded the safety bound");
      }
      if (signal.aborted) return { pages, transactions };
      // 完整分页成功后才提交：整文件替换历史元数据。
      await stateRepository.replaceHistory(resource, [...entries.values()]);
      // 相同 txid 的本地提交标记为已确认；不做任何输入关系派生。
      await stateRepository.reconcileHistoryConfirmed(resource.resourceId, new Set(entries.keys()));
      const state: P2pkhTransactionSyncState = {
        id: resource.resourceId,
        resourceId: resource.resourceId,
        pagesSynced: pages,
        transactionsSynced: transactions,
        lastAttemptAt: now(),
        lastSuccessAt: now(),
      };
      await stateRepository.putTransactionSyncState(state);
      return { pages, transactions };
    } catch (error) {
      if (signal.aborted || (typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "AbortError")) {
        return { pages, transactions };
      }
      const previous = await stateRepository.getTransactionSyncState(resource.resourceId);
      await stateRepository.putTransactionSyncState({
        id: resource.resourceId,
        resourceId: resource.resourceId,
        pagesSynced: pages,
        transactionsSynced: transactions,
        lastAttemptAt: now(),
        lastSuccessAt: previous?.lastSuccessAt,
        lastError: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
      throw error;
    }
  }

  return {
    async runOnce(signal: AbortSignal): Promise<P2pkhTransactionSyncResult> {
      const resources = await deps.getResources();
      let pages = 0;
      let transactions = 0;
      for (const resource of resources) {
        if (signal.aborted) break;
        const result = await syncResource(resource, signal);
        pages += result.pages;
        transactions += result.transactions;
      }
      return { resources: resources.length, pages, transactions, cancelled: signal.aborted };
    }
  };
}
