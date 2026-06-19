// packages/plugin-p2pkh/src/p2pkhRecentSync.ts
// P2PKH 近期同步实现（硬切换 001）。
// 设计缘由：
//   - 按 network 分组，per-resource 走 WOC 限流（批量接口歧义大，逐个最稳）。
//   - 硬切换 001：不再请求 WOC balance endpoint，余额改为 service 现算。
//   - 写 UTXO 快照、近期 history、watermark、本地输入占用对账、本地提交对账。
//   - 不写 backfill cursor；不从头扫描完整历史。
//   - 不写余额。
//   - 单 resource 失败不影响其他 resource，错误被收集后由任务最终抛出。
//   - 失败时保留旧缓存。
//   - 本地提交标 confirmed 必须看到对应 txid 出现在 confirmed history，否则不标。

import type { BsvNetwork, MessageBus, WocService } from "@keymaster/contracts";
import type {
  P2pkhAssetId,
  P2pkhHistoryItem,
  P2pkhKeyResource,
  P2pkhRecentCommit,
  P2pkhRecentSyncState
} from "./p2pkhContracts.js";
import type { P2pkhDbHandle } from "./p2pkhDb.js";
import type { SyncCoordinator } from "./p2pkhSyncCoordinator.js";
import { P2PKH_MSG } from "./p2pkhMessages.js";

export interface P2pkhRecentSyncDeps {
  woc: WocService;
  messageBus: MessageBus;
  coordinator: SyncCoordinator;
  getResources(): Promise<P2pkhKeyResource[]>;
  getDb(): Promise<P2pkhDbHandle>;
}

const HISTORY_PAGE_LIMIT = 50;
const RECENT_HISTORY_PAGES = 3;

interface ResourceError {
  resourceId: string;
  error: string;
}

export function createP2pkhRecentSync(deps: P2pkhRecentSyncDeps) {
  return {
    /**
     * 执行一次 recent-sync。
     * - 按 network 分组逐 resource 同步。
     * - 单 resource 失败：收集错误，不打断其他 resource。
     * - 全部失败：抛错；部分失败：发出资源错误事件，但整体成功。
     */
    async runOnce(signal: AbortSignal): Promise<void> {
      const resources = await deps.getResources();
      if (resources.length === 0) return;

      const errors: ResourceError[] = [];
      for (const r of resources) {
        if (signal.aborted) return;
        try {
          await syncOne(r, signal, deps);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ resourceId: r.resourceId, error: msg });
          deps.messageBus.publish(P2PKH_MSG.RECENT_RESOURCE_ERROR, { resourceId: r.resourceId, error: msg });
        }
      }
      if (errors.length === resources.length && resources.length > 0) {
        // 全部失败：抛错让 background task 标 failed。
        throw new Error(`P2PKH recent-sync failed for all ${resources.length} resources`);
      }
    }
  };
}

async function syncOne(resource: P2pkhKeyResource, signal: AbortSignal, deps: P2pkhRecentSyncDeps): Promise<void> {
  const network = resource.network;
  const db = await deps.getDb();

  // 关键：使用同一份请求 + 严格优先级；不在批量阶段做无意义预取。
  // 硬切换 001：不再请求 WOC balance endpoint——余额由 service 现算。
  const [utxos, unconfirmedUtxos, recentHistoryPage, unconfirmedHistory] = await Promise.all([
    deps.woc.getAddressConfirmedUtxos(network, resource.address, { priority: "foreground", signal }),
    deps.woc.getAddressUnconfirmedUtxos(network, resource.address, { priority: "background", signal }),
    deps.woc.listAddressConfirmedHistory(network, resource.address, { limit: HISTORY_PAGE_LIMIT }, { priority: "foreground", signal }),
    deps.woc.listAddressUnconfirmedHistory(network, resource.address, { priority: "background", signal })
  ]);

  const now = new Date().toISOString();
  const utxoRows = [
    ...utxos.map((u) => utxoFromWoc(u, resource, "confirmed", now)),
    ...unconfirmedUtxos
      .filter((u) => !utxos.find((c) => c.txid === u.txid && c.vout === u.vout))
      .map((u) => utxoFromWoc(u, resource, "unconfirmed", now))
  ];

  // 读取 recent watermark；扫描新交易时遇到已知 txid 停止。
  const recentState = await db.getRecentSyncState(resource.resourceId);
  const knownTxids = new Set(recentState?.recentConfirmedTxids ?? []);
  const recentItems: Array<{ txid: string; height: number; status: "confirmed"; source: "woc-confirmed" }> = [];
  let pageToken: string | undefined = recentHistoryPage.nextPageToken;
  let pageCount = 0;
  let stopped = false;
  for (const h of recentHistoryPage.items) {
    if (knownTxids.has(h.txid)) {
      stopped = true;
      break;
    }
    recentItems.push({ txid: h.txid, height: h.height, status: "confirmed", source: "woc-confirmed" });
    if (recentItems.length >= HISTORY_PAGE_LIMIT) break;
  }
  if (!stopped && recentItems.length === recentHistoryPage.items.length && pageToken && pageCount < RECENT_HISTORY_PAGES) {
    while (pageToken && pageCount < RECENT_HISTORY_PAGES) {
      if (signal.aborted) return;
      pageCount += 1;
      try {
        const next = await deps.woc.listAddressConfirmedHistory(
          network,
          resource.address,
          { limit: HISTORY_PAGE_LIMIT, nextPageToken: pageToken },
          { priority: "foreground", signal }
        );
        let pageStopped = false;
        for (const h of next.items) {
          if (knownTxids.has(h.txid)) {
            pageStopped = true;
            break;
          }
          recentItems.push({ txid: h.txid, height: h.height, status: "confirmed", source: "woc-confirmed" });
          if (recentItems.length >= HISTORY_PAGE_LIMIT * RECENT_HISTORY_PAGES) break;
        }
        pageToken = next.nextPageToken;
        if (pageStopped || recentItems.length >= HISTORY_PAGE_LIMIT * RECENT_HISTORY_PAGES) break;
      } catch (err) {
        deps.messageBus.publish(P2PKH_MSG.RECENT_HISTORY_ERROR, { resourceId: resource.resourceId, error: errMsg(err) });
        break;
      }
    }
  }

  // 组装 commit：history id = `${resourceId}:${txid}`，保留 resource 元数据。
  const historyRows: P2pkhHistoryItem[] = recentItems.map((h) => ({
    id: `${resource.resourceId}:${h.txid}`,
    resourceId: resource.resourceId,
    keyId: resource.keyId,
    publicKeyHash: resource.publicKeyHash,
    network,
    address: resource.address,
    txid: h.txid,
    height: h.height,
    status: h.status,
    source: h.source,
    syncedAt: now
  }));
  const unconfirmedRows: P2pkhHistoryItem[] = unconfirmedHistory.items.map((h) => ({
    id: `${resource.resourceId}:${h.txid}`,
    resourceId: resource.resourceId,
    keyId: resource.keyId,
    publicKeyHash: resource.publicKeyHash,
    network,
    address: resource.address,
    txid: h.txid,
    height: undefined,
    status: "unconfirmed",
    source: "woc-unconfirmed",
    syncedAt: now
  }));

  // recentConfirmedTxids：把新看到的 txid 放在前面，保留旧的去重。
  const newTxids = recentItems.map((h) => h.txid);
  const recentConfirmedTxids = Array.from(new Set([...newTxids, ...(recentState?.recentConfirmedTxids ?? [])])).slice(0, HISTORY_PAGE_LIMIT * RECENT_HISTORY_PAGES);

  // 本地输入占用对账：必须连续多次 missing 才允许把 claim 标 observed-consumed。
  // 关键修复：单次 missing 不能直接标 observed-consumed；WOC 短暂不一致
  // 时下一次 recent-sync 仍可能看到该输入。分配逻辑只排除 "claimed"，
  // 提前 release 会让该输入重新可花费，造成双花。
  const existingReservations = await db.listLocalInputClaimsByResource(resource.resourceId);
  const wocOutpoints = new Set(utxoRows.map((u) => `${u.txid}:${u.vout}`));
  const MISSING_THRESHOLD = 3;
  const localInputClaims = existingReservations.map((r) => {
    if (r.state !== "claimed") return r;
    if (!wocOutpoints.has(`${r.txid}:${r.vout}`)) {
      const count = (r.missingObservationCount ?? 0) + 1;
      if (count >= MISSING_THRESHOLD) {
        return { ...r, state: "observed-consumed" as const, missingObservationCount: count, updatedAt: now };
      }
      return { ...r, missingObservationCount: count, updatedAt: now };
    }
    // 已观察到：重置计数。
    if (r.missingObservationCount) {
      return { ...r, missingObservationCount: 0, updatedAt: now };
    }
    return r;
  });

  // 本地提交对账：必须看到 submission.txid 出现在 confirmed history 才标 confirmed。
  // 仅"输入已不在 UTXO"不足以确认，可能只是被替换/重组/RBF。
  const localSubmissions = await db.listLocalSubmissionsByResource(resource.resourceId);
  const confirmedTxidSet = new Set(recentItems.map((h) => h.txid));
  // 也合并未确认历史里已知的本地提交 canonicalTxid（broadcast 转 unconfirmed）。
  const unconfirmedTxidSet = new Set(unconfirmedHistory.items.map((h) => h.txid));
  const submissionUpdated = localSubmissions.map((p) => {
    if (p.status === "confirmed" || p.status === "failed") return p;
    if (p.canonicalTxid && confirmedTxidSet.has(p.canonicalTxid)) {
      return { ...p, status: "confirmed" as const, updatedAt: now };
    }
    if (p.canonicalTxid && unconfirmedTxidSet.has(p.canonicalTxid)) {
      return { ...p, status: "broadcast" as const, updatedAt: now };
    }
    // 输入已花费但 txid 还没出现：保持 unknown，等待下次观察。
    return p;
  });

  // 硬切换 001：commit 不再携带 balance——余额由 service 现算。
  const commit: P2pkhRecentCommit = {
    resourceId: resource.resourceId,
    resource,
    utxos: utxoRows,
    recentHistory: historyRows,
    unconfirmedHistory: unconfirmedRows,
    recentConfirmedTxids,
    localInputClaims,
    localSubmissions: submissionUpdated,
    lastSyncedAt: now
  };

  await deps.coordinator.runRecent(resource.resourceId, resource.generation, async () => commit);
  // 关键修复：不再通过 putAddress 重写 resource。
  // 旧实现在 resource 被删除后会用旧 resource 对象 putAddress 把已删除的
  // 资源复活，绕过 onKeyRemoved 清理。lastSyncedAt 由 commitRecentSnapshot
  // 内部维护（在 addresses store 上不写 lastSyncedAt，但 recent 自己的
  // recentConfirmedTxids + lastCheckedAt 已经覆盖"最近成功时间"语义）。
  // recent sync state 记录时间
  const nextRecent: P2pkhRecentSyncState = {
    resourceId: resource.resourceId,
    recentConfirmedTxids,
    lastCheckedAt: now,
    lastSuccessAt: now
  };
  await db.putRecentSyncState(nextRecent);
}

function utxoFromWoc(
  u: { txid: string; vout: number; value: number; height: number; script?: string; isSpentInMempoolTx?: boolean },
  resource: P2pkhKeyResource,
  status: "confirmed" | "unconfirmed",
  now: string
) {
  return {
    id: `${resource.resourceId}:${u.txid}:${u.vout}`,
    resourceId: resource.resourceId,
    keyId: resource.keyId,
    publicKeyHash: resource.publicKeyHash,
    network: resource.network,
    address: resource.address,
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    height: status === "confirmed" ? u.height : 0,
    script: u.script,
    status,
    isSpentInMempoolTx: u.isSpentInMempoolTx ?? false,
    syncedAt: now
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
