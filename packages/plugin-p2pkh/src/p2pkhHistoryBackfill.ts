// packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts
// P2PKH 完整历史回填实现。
// 设计缘由：
//   - 从最新确认历史向旧历史分页，直到没有 nextPageToken。
//   - 每一页通过 SyncCoordinator 原子提交（page + cursor + generation）。
//   - 每完成一页让出执行权给 recent-sync。
//   - 尽头判断：WOC 响应中没有 nextPageToken。
//   - 不写余额、UTXO、reservation、pending。
//   - 不写 recent watermark。
//   - 不覆盖 recent-sync 已写入的 confirmed 状态。
//   - 关键修复：循环跑到 complete / failed / paused / 取消。
//   - 关键修复：failed / paused 状态在 resume() 后必须能被继续，重置为 running。

import type { MessageBus, WocService } from "@keymaster/contracts";
import type {
  P2pkhBackfillState,
  P2pkhKeyResource
} from "./p2pkhContracts.js";
import type { P2pkhDbHandle } from "./p2pkhDb.js";
import type { SyncCoordinator } from "./p2pkhSyncCoordinator.js";
import { P2PKH_MSG } from "./p2pkhMessages.js";

export interface P2pkhHistoryBackfillDeps {
  woc: WocService;
  messageBus: MessageBus;
  coordinator: SyncCoordinator;
  getResources(): Promise<P2pkhKeyResource[]>;
  getDb(): Promise<P2pkhDbHandle>;
}

const PAGE_LIMIT = 100;

export function createP2pkhHistoryBackfill(deps: P2pkhHistoryBackfillDeps) {
  return {
    /**
     * 执行 history-backfill。逐 resource 串行。
     * 每完成一页让出执行权；recentPending=true 时暂停等 recent。
     * 直到 status=complete 或信号取消或 paused。
     * 关键修复：failed / paused 状态在 resume() 触发本方法时，把 state
     * 重置为 running 再继续；否则会永远停在 failed/paused。
     * 关键修复：内部 backfillOne 把错误状态写库后必须把错误冒泡出来，
     * 否则通用后台任务会显示 ok 而实际有 resource 是 failed。
     */
    async runOnce(signal: AbortSignal, pausedRef: { paused: boolean }): Promise<void> {
      const resources = await deps.getResources();
      const failures: Array<{ resourceId: string; error: string }> = [];
      for (const r of resources) {
        if (signal.aborted) return;
        if (pausedRef.paused) return;
        try {
          await backfillOne(r, signal, pausedRef, deps);
        } catch (err) {
          failures.push({ resourceId: r.resourceId, error: errMsg(err) });
        }
      }
      if (failures.length === resources.length && resources.length > 0) {
        throw new Error(
          `P2PKH history-backfill failed for all ${resources.length} resources: ${failures
            .map((f) => `${f.resourceId}: ${f.error}`)
            .join("; ")}`
        );
      }
      if (failures.length > 0) {
        // 关键修复：部分失败也要让 background 任务感知，状态进入 failed。
        throw new Error(
          `P2PKH history-backfill failed for ${failures.length} resources: ${failures
            .map((f) => `${f.resourceId}: ${f.error}`)
            .join("; ")}`
        );
      }
    }
  };
}

async function backfillOne(
  resource: P2pkhKeyResource,
  signal: AbortSignal,
  pausedRef: { paused: boolean },
  deps: P2pkhHistoryBackfillDeps
): Promise<void> {
  if (signal.aborted) return;
  if (pausedRef.paused) return;

  const db = await deps.getDb();
  let state = await db.getBackfillState(resource.resourceId);
  if (state?.status === "complete") return;

  // 关键修复：failed 状态需要重置为 running 才能继续；
  // 但如果 saved state 的 nextPageToken 缺失（首次请求失败从未翻页），
  // 不能直接当 running 用 —— 必须从首页重新拉取。
  // 关键修复：paused 状态保留 nextPageToken，可以直接继续。
  let mustRefetchFirstPage = false;
  if (state && state.status === "failed") {
    mustRefetchFirstPage = !state.nextPageToken;
    await db.putBackfillState({ ...state, status: "running", updatedAt: new Date().toISOString() });
    state = { ...state, status: "running" };
  } else if (state && state.status === "paused") {
    await db.putBackfillState({ ...state, status: "running", updatedAt: new Date().toISOString() });
    state = { ...state, status: "running" };
  }

  // 初始化：读最新页作为 anchor。
  // 关键修复：必须明确区分"从未发过请求"与"请求过但失败"。
  // 旧实现：state 存在但 nextPageToken=undefined 时直接走续传循环
  //          （循环跳过）并标记 complete，bug。
  // 新实现：当 mustRefetchFirstPage 或没有 state 时强制请求首页。
  if (mustRefetchFirstPage || !state) {
    if (signal.aborted) return;
    let firstPage;
    try {
      firstPage = await deps.woc.listAddressConfirmedHistory(
        resource.network,
        resource.address,
        { limit: PAGE_LIMIT },
        { priority: "backfill", signal }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 关键修复：失败不直接 return；写入 state=failed 供托盘显示，可被 retry 恢复。
      await saveState(db, {
        resourceId: resource.resourceId,
        status: "failed",
        nextPageToken: undefined,
        anchorTxids: [],
        pagesSynced: 0,
        recordsSynced: 0,
        revision: 0,
        lastError: msg,
        updatedAt: new Date().toISOString()
      }, "failed");
      deps.messageBus.publish(P2PKH_MSG.BACKFILL_ERROR, { resourceId: resource.resourceId, error: msg });
      throw new Error(`backfill first page failed: ${msg}`);
    }
    if (signal.aborted) return;
    try {
      await deps.coordinator.runBackfillPage(resource.resourceId, 0, resource.generation, async () => ({
        page: firstPage.items.map(toCommitItem),
        nextPageToken: firstPage.nextPageToken,
        resource
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await saveState(db, {
        resourceId: resource.resourceId,
        status: "failed",
        nextPageToken: undefined,
        anchorTxids: [],
        pagesSynced: 0,
        recordsSynced: 0,
        revision: 0,
        lastError: msg,
        updatedAt: new Date().toISOString()
      }, "failed");
      deps.messageBus.publish(P2PKH_MSG.BACKFILL_ERROR, { resourceId: resource.resourceId, error: msg });
      throw new Error(`backfill first page commit failed: ${msg}`);
    }
    state = await db.getBackfillState(resource.resourceId);
    if (!state || state.status === "complete" || !state.nextPageToken) {
      if (state && state.status === "running" && !state.nextPageToken) {
        await saveState(db, state, "complete");
      }
      return;
    }
  }

  // 续传：循环到尽头。
  let current: P2pkhBackfillState | undefined = state;
  while (current && current.status === "running" && current.nextPageToken) {
    if (signal.aborted) return;
    if (pausedRef.paused) {
      await saveState(db, current, "paused");
      return;
    }
    while (deps.coordinator.hasRecentPending(resource.resourceId)) {
      await new Promise((r) => setTimeout(r, 50));
      if (signal.aborted) return;
      if (pausedRef.paused) {
        await saveState(db, current, "paused");
        return;
      }
    }
    deps.coordinator.requestBackfillYield(resource.resourceId);
    const expected = current.revision;
    let nextPage;
    try {
      nextPage = await deps.woc.listAddressConfirmedHistory(
        resource.network,
        resource.address,
        { limit: PAGE_LIMIT, nextPageToken: current.nextPageToken },
        { priority: "backfill", signal }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await saveState(db, { ...current, lastError: msg }, "failed");
      deps.messageBus.publish(P2PKH_MSG.BACKFILL_ERROR, { resourceId: resource.resourceId, error: msg });
      throw new Error(`backfill page fetch failed: ${msg}`);
    }
    if (signal.aborted) return;
    try {
      await deps.coordinator.runBackfillPage(resource.resourceId, expected, resource.generation, async () => ({
        page: nextPage.items.map(toCommitItem),
        nextPageToken: nextPage.nextPageToken,
        resource
      }));
    } catch (err) {
      // revision / generation mismatch：resource 被删除或 cursor 已被其他流程重置。
      const latest = await db.getBackfillState(resource.resourceId);
      if (!latest) return;
      current = latest;
      if (current!.status !== "running") return;
      continue;
    }
    current = await db.getBackfillState(resource.resourceId);
  }

  if (current && current.status === "running" && !current.nextPageToken) {
    await saveState(db, current, "complete");
  }
}

function toCommitItem(h: { txid: string; height: number }) {
  return { txid: h.txid, height: h.height, status: "confirmed" as const, source: "woc-confirmed" as const };
}

async function saveState(db: P2pkhDbHandle, state: P2pkhBackfillState, status: P2pkhBackfillState["status"]): Promise<void> {
  await db.putBackfillState({ ...state, status, updatedAt: new Date().toISOString() });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
