// packages/plugin-p2pkh/src/p2pkhSyncCoordinator.ts
// P2PKH 同步协调器。
// 设计缘由：
//   - recent-sync 与 history-backfill 是两个独立 task id，可能同时处理同一 resource；
//   - 两者都可能写 history store。
//   - 必须在 P2PKH 内部按 resource 维度协调写入，避免并发覆盖。
//   - backfill 每完成一页必须让出执行权（不能让 backfill 长期持有资源锁）。
//   - revision + generation 双校验：resource 删除或重新开始 backfill 后，迟到的
//     响应必须被丢弃，不能盲写。
//
// 不变量：
//   - 同一 resource 同时最多一个 history commit 路径在执行。
//   - backfill 每页让出后由协调器在 recentPending=true 时先调度 recent。
//   - recent 与 backfill 都通过协调器提交；不能直接写库。

import type { P2pkhDbHandle } from "./p2pkhDb.js";
import type { P2pkhBackfillCommit, P2pkhKeyResource, P2pkhRecentCommit } from "./p2pkhContracts.js";

interface ResourceLane {
  recentPending: boolean;
  recentRunning: boolean;
  backfillRunning: boolean;
  backfillYieldRequested: boolean;
  revision: number;
  generation: number;
  queue: Promise<unknown>;
}

export interface SyncCoordinator {
  runRecent(
    resourceId: string,
    expectedGeneration: number | undefined,
    build: () => Promise<P2pkhRecentCommit>
  ): Promise<void>;
  runBackfillPage(
    resourceId: string,
    expectedRevision: number,
    expectedGeneration: number,
    build: () => Promise<Omit<P2pkhBackfillCommit, "resourceId" | "expectedRevision" | "expectedGeneration">>
  ): Promise<void>;
  requestBackfillYield(resourceId: string): void;
  removeResource(resourceId: string): void;
  hasRecentPending(resourceId: string): boolean;
  /** 读取资源当前 generation，用于迟到响应检查。 */
  getGeneration(resourceId: string): number;
  /** 刷新缓存的 generation（资源被外部重建后）。 */
  refreshGeneration(resourceId: string, resource: P2pkhKeyResource | undefined): void;
}

export interface SyncCoordinatorDeps {
  /** 解析当前 active key 的 db handle。 */
  getDb(): Promise<P2pkhDbHandle>;
}

export function createP2pkhSyncCoordinator(deps: SyncCoordinatorDeps): SyncCoordinator {
  const lanes = new Map<string, ResourceLane>();

  function laneFor(resourceId: string): ResourceLane {
    let lane = lanes.get(resourceId);
    if (!lane) {
      lane = {
        recentPending: false,
        recentRunning: false,
        backfillRunning: false,
        backfillYieldRequested: false,
        revision: 0,
        generation: -1,
        queue: Promise.resolve()
      };
      lanes.set(resourceId, lane);
    }
    return lane;
  }

  function enqueue<T>(lane: ResourceLane, task: () => Promise<T>): Promise<T> {
    const next = lane.queue.then(task, task);
    lane.queue = next.catch(() => undefined);
    return next;
  }

  return {
    async runRecent(resourceId, expectedGeneration, build) {
      const lane = laneFor(resourceId);
      lane.recentPending = true;
      return enqueue(lane, async () => {
        lane.recentPending = false;
        lane.recentRunning = true;
        try {
          const commit = await build();
          const db = await deps.getDb();
          await db.commitRecentSnapshot({ ...commit, resourceId, expectedGeneration });
        } finally {
          lane.recentRunning = false;
        }
      });
    },
    async runBackfillPage(resourceId, expectedRevision, expectedGeneration, build) {
      const lane = laneFor(resourceId);
      while (lane.recentPending || lane.recentRunning) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return enqueue(lane, async () => {
        lane.backfillRunning = true;
        try {
          const partial = await build();
          const db = await deps.getDb();
          await db.commitBackfillPage({
            resourceId,
            expectedRevision,
            expectedGeneration,
            resource: partial.resource,
            page: partial.page,
            nextPageToken: partial.nextPageToken
          });
          lane.revision = expectedRevision + 1;
        } finally {
          lane.backfillRunning = false;
          lane.backfillYieldRequested = false;
        }
      });
    },
    requestBackfillYield(resourceId) {
      const lane = lanes.get(resourceId);
      if (lane) lane.backfillYieldRequested = true;
    },
    removeResource(resourceId) {
      lanes.delete(resourceId);
    },
    hasRecentPending(resourceId) {
      return lanes.get(resourceId)?.recentPending ?? false;
    },
    getGeneration(resourceId) {
      return lanes.get(resourceId)?.generation ?? -1;
    },
    refreshGeneration(resourceId, resource) {
      const lane = laneFor(resourceId);
      if (!resource) {
        lane.generation = -1;
        return;
      }
      lane.generation = resource.generation;
    }
  };
}
