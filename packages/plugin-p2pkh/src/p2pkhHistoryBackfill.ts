// packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts
// P2PKH 完整历史回填实现。
// 设计缘由：
//   - 从最新确认历史向旧历史分页，直到没有 nextPageToken。
//   - 每一页通过 SyncCoordinator 原子提交（page + cursor + generation）。
//   - 每完成一页让出执行权给 recent-sync。
//   - 尽头判断：WOC 响应中没有 nextPageToken。
//   - 不写余额、UTXO、本地输入占用、本地提交。
//   - 不写 recent watermark。
//   - 不覆盖 recent-sync 已写入的 confirmed 状态。
//   - 关键修复：循环跑到 complete / failed / 取消。
//   - 施工单 001：删除 paused 状态和 pause/resume 语义；只接受 AbortSignal 取消。

import type { MessageBus, PluginLogger, WocService } from "@keymaster/contracts";
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
  /** 硬切换 002：业务插件注入的 logger。 */
  logger?: PluginLogger;
}

const PAGE_LIMIT = 100;

export function createP2pkhHistoryBackfill(deps: P2pkhHistoryBackfillDeps) {
  return {
    /**
     * 执行 history-backfill。逐 resource 串行。
     * 每完成一页让出执行权；recentPending=true 时暂停等 recent。
     * 直到 status=complete 或信号取消。
     * 施工单 001：删除 paused 参数，只接受 AbortSignal 取消。
     * 关键修复：内部 backfillOne 把错误状态写库后必须把错误冒泡出来，
     * 否则通用后台任务会显示 ok 而实际有 resource 是 failed。
     */
    async runOnce(signal: AbortSignal): Promise<{ committed: boolean; cancelled: boolean }> {
      const resources = await deps.getResources();
      deps.logger?.info({
        scope: "p2pkh.backfill",
        event: "backfill.started",
        message: "P2PKH history backfill started",
        data: { resourceCount: resources.length }
      });
      // 硬切换 003：本次 backfill 没有 resource 时必须能在日志上看到，
      // 而不是 silently no-op。这与 recent-sync 的 noResources 分支
      // 语义一致——手工 backfill 触发成功但 0 resource 也是重要诊断信息。
      if (resources.length === 0) {
        deps.logger?.info({
          scope: "p2pkh.backfill",
          event: "backfill.noResources",
          message: "P2PKH history backfill skipped: no resources for active key",
          data: { resourceCount: 0 }
        });
        return { committed: false, cancelled: false };
      }
      const failures: Array<{ resourceId: string; error: string }> = [];
      let anyCommitted = false;
      for (const r of resources) {
        if (signal.aborted) return { committed: anyCommitted, cancelled: true };
        deps.logger?.info({
          scope: "p2pkh.backfill",
          event: "backfill.resource.started",
          message: `P2PKH backfill resource started: ${r.resourceId}`,
          data: { resourceId: r.resourceId, network: r.network, address: r.address }
        });
        try {
          const summary = await backfillOne(r, signal, deps);
          if (summary.committed) anyCommitted = true;
          if (summary.cancelled) return { committed: anyCommitted, cancelled: true };
          deps.logger?.info({
            scope: "p2pkh.backfill",
            event: "backfill.resource.completed",
            message: `P2PKH backfill resource finished: ${r.resourceId}`,
            data: {
              resourceId: r.resourceId,
              network: r.network,
              address: r.address,
              finalStatus: summary.status,
              pagesSynced: summary.pagesSynced,
              recordsSynced: summary.recordsSynced
            }
          });
        } catch (err) {
          // 关键修复：WOC 请求因 abort 抛出 AbortError 时，走取消路径而非失败路径。
          if (signal.aborted) return { committed: anyCommitted, cancelled: true };
          failures.push({ resourceId: r.resourceId, error: errMsg(err) });
          deps.logger?.warn({
            scope: "p2pkh.backfill",
            event: "backfill.page.failed",
            message: `P2PKH backfill page failed: ${r.resourceId}`,
            data: { resourceId: r.resourceId, network: r.network },
            error: { name: err instanceof Error ? err.name : "Error", message: errMsg(err) }
          });
        }
      }
      if (failures.length === resources.length && resources.length > 0) {
        deps.logger?.error({
          scope: "p2pkh.backfill",
          event: "backfill.failed",
          message: `P2PKH history backfill failed for all ${resources.length} resources`,
          data: { failedCount: failures.length, totalCount: resources.length }
        });
        throw new Error(
          `P2PKH history-backfill failed for all ${resources.length} resources: ${failures
            .map((f) => `${f.resourceId}: ${f.error}`)
            .join("; ")}`
        );
      }
      if (failures.length > 0) {
        // 关键修复：部分失败也要让 background 任务感知，状态进入 failed。
        deps.logger?.warn({
          scope: "p2pkh.backfill",
          event: "backfill.partialFailed",
          message: `P2PKH history backfill failed for ${failures.length} resources`,
          data: { failedCount: failures.length, totalCount: resources.length }
        });
        throw new Error(
          `P2PKH history-backfill failed for ${failures.length} resources: ${failures
            .map((f) => `${f.resourceId}: ${f.error}`)
            .join("; ")}`
        );
      }
      deps.logger?.info({
        scope: "p2pkh.backfill",
        event: "backfill.completed",
        message: "P2PKH history backfill completed",
        data: { resourceCount: resources.length }
      });
      return { committed: anyCommitted, cancelled: false };
    }
  };
}

async function backfillOne(
  resource: P2pkhKeyResource,
  signal: AbortSignal,
  deps: P2pkhHistoryBackfillDeps
): Promise<{ status: string; pagesSynced: number; recordsSynced: number; committed: boolean; cancelled: boolean }> {
  // 硬切换 003：所有"提前结束"路径都要带回当前 backfill state 摘要，
  // 让 runOnce 能写出"本 resource 已 complete"日志，而不是 silent return。
  const summarize = (s: P2pkhBackfillState | undefined, committed = false, cancelled = false): { status: string; pagesSynced: number; recordsSynced: number; committed: boolean; cancelled: boolean } => ({
    status: s?.status ?? "unknown",
    pagesSynced: s?.pagesSynced ?? 0,
    recordsSynced: s?.recordsSynced ?? 0,
    committed,
    cancelled
  });

  const db = await deps.getDb();
  let state = await db.getBackfillState(resource.resourceId);
  let didCommit = false;
  if (signal.aborted) return summarize(state, false, true);
  if (state?.status === "complete") return summarize(state);

  // 关键修复：failed 状态需要重置为 running 才能继续；
  // 但如果 saved state 的 nextPageToken 缺失（首次请求失败从未翻页），
  // 不能直接当 running 用 —— 必须从首页重新拉取。
  let mustRefetchFirstPage = false;
  if (state && state.status === "failed") {
    mustRefetchFirstPage = !state.nextPageToken;
    await db.putBackfillState({ ...state, status: "running", updatedAt: new Date().toISOString() });
    state = { ...state, status: "running" };
  }

  // 初始化：读最新页作为 anchor。
  // 关键修复：必须明确区分"从未发过请求"与"请求过但失败"。
  // 旧实现：state 存在但 nextPageToken=undefined 时直接走续传循环
  //          （循环跳过）并标记 complete，bug。
  // 新实现：当 mustRefetchFirstPage 或没有 state 时强制请求首页。
  if (mustRefetchFirstPage || !state) {
    if (signal.aborted) return summarize(state, false, true);
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
    if (signal.aborted) return summarize(state, false, true);
    try {
      await deps.coordinator.runBackfillPage(resource.resourceId, 0, resource.generation, async () => ({
        page: firstPage.items.map(toCommitItem),
        nextPageToken: firstPage.nextPageToken,
        resource
      }));
      didCommit = true;
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
        state = { ...state, status: "complete" };
      }
      return summarize(state, didCommit);
    }
  }

  // 续传：循环到尽头。
  let current: P2pkhBackfillState | undefined = state;
  while (current && current.status === "running" && current.nextPageToken) {
    if (signal.aborted) return summarize(current, didCommit, true);
    while (deps.coordinator.hasRecentPending(resource.resourceId)) {
      await new Promise((r) => setTimeout(r, 50));
      if (signal.aborted) return summarize(current, didCommit, true);
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
    if (signal.aborted) return summarize(current, didCommit, true);
    try {
      await deps.coordinator.runBackfillPage(resource.resourceId, expected, resource.generation, async () => ({
        page: nextPage.items.map(toCommitItem),
        nextPageToken: nextPage.nextPageToken,
        resource
      }));
      didCommit = true;
    } catch (err) {
      // revision / generation mismatch：resource 被删除或 cursor 已被其他流程重置。
      const latest = await db.getBackfillState(resource.resourceId);
      if (!latest) return summarize(undefined, didCommit);
      current = latest;
      if (current.status !== "running") return summarize(current, didCommit);
      continue;
    }
    current = await db.getBackfillState(resource.resourceId);
  }

  if (current && current.status === "running" && !current.nextPageToken) {
    await saveState(db, current, "complete");
    current = { ...current, status: "complete" };
  }
  return summarize(current, didCommit);
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
